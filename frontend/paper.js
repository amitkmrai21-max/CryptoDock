// Paper trading for every coin: virtual USDT funds per email, perpetual-style
// Long / Short positions with 1x–200x leverage (Market or Limit, size in
// Lot / USD / coin), margin, liquidation price, live P&L and an order book.
// Nothing here touches a real exchange; it is all simulated.
// Live prices come from markets.js ("cd-markets-updated" / window.cdMarkets).
(function cryptoPaperTrading() {
  const STARTING_USDT = 10000;
  const FEE_RATE = 0.001; // 0.1%, like a typical spot exchange fee
  const MIN_ORDER_USDT = 1;
  const QTY_DECIMALS = 8;
  const EPSILON = 1e-9;
  const KEY_PREFIX = "cdPaperV1:";
  const FUT_FEE_RATE = 0.0005; // 0.05% taker fee on open and close
  const DEFAULT_LEVERAGE = 200;
  const LOT_SIZE = { BTC: 0.001, ETH: 0.01, SOL: 0.1 }; // others: 1 coin per lot
  const lotSize = (base) => LOT_SIZE[base] || 1;

  const el = (id) => document.getElementById(id);
  if (!el("cdTicket")) return;

  const fmt = () => window.cdFormat || {};
  const fmtUsd = (v) => (fmt().fmtUsd ? fmt().fmtUsd(v) : "$" + Number(v).toFixed(2));
  // Money (funds, values, P&L) always in 2 decimals; coin prices use
  // markets.js's price formatting with more decimals for small coins.
  const fmtMoney = (v) => "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtInr = (v) => {
    const rate = window.cdMarkets && window.cdMarkets.usdtInr;
    return rate ? "₹" + (Number(v || 0) * rate).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "₹--";
  };
  const escapeHtml = (t) => (fmt().escapeHtml ? fmt().escapeHtml(t) : String(t));
  const avatar = (b) => (fmt().avatar ? fmt().avatar(b) : "");
  const pctClass = (v) => (v > 0 ? "cd-up" : v < 0 ? "cd-down" : "cd-flat");
  const roundQty = (q) => Math.floor(q * 10 ** QTY_DECIMALS) / 10 ** QTY_DECIMALS;
  const signed = (text, v) => (v > 0 ? "+" : v < 0 ? "-" : "") + text;
  const fmtQty = (q) => Number(q).toLocaleString("en-US", { maximumFractionDigits: QTY_DECIMALS });

  // ---------- account & storage (one portfolio per email) ----------
  function readEmail() {
    if (typeof window.cdUserEmail === "string") return window.cdUserEmail;
    try { return localStorage.getItem("cdUserEmail") || ""; } catch (e) { return ""; }
  }
  let account = readEmail();
  const storageKey = () => KEY_PREFIX + (account || "guest");
  const freshState = () => ({ cash: STARTING_USDT, holdings: {}, positions: [], orders: [], realized: 0 });

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey()) || "null");
      if (saved && typeof saved.cash === "number") return { ...freshState(), ...saved };
    } catch (e) { /* ignore */ }
    return freshState();
  }
  let state = load();

  function saveLocal() {
    try { localStorage.setItem(storageKey(), JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  // Every change: keep it on this device and send it to the server, so the
  // same email shows the same portfolio on every phone and browser.
  function save() {
    saveLocal();
    if (!account) return;
    setMeta({ dirty: true });
    scheduleSync(400);
  }

  // ---------- sync with the server (one copy per signed-in email) ----------
  // meta.rev = server version this device last had; meta.dirty = changes on
  // this device the server hasn't got yet.
  const metaKey = () => storageKey() + ":sync";
  function getMeta() {
    try { return { rev: 0, dirty: false, ...JSON.parse(localStorage.getItem(metaKey()) || "{}") }; } catch (e) { return { rev: 0, dirty: false }; }
  }
  function setMeta(patch) {
    try { localStorage.setItem(metaKey(), JSON.stringify({ ...getMeta(), ...patch })); } catch (e) { /* ignore */ }
  }
  const hasActivity = (s) => (s.orders && s.orders.length > 0) || (s.positions && s.positions.length > 0) || Math.abs(s.cash - STARTING_USDT) > EPSILON;

  async function sessionToken() {
    const client = window.marketDockSupabase;
    if (!client) return "";
    try {
      const { data } = await client.auth.getSession();
      const session = data && data.session;
      const email = session && session.user && (session.user.email || "").toLowerCase();
      return session && email === account ? session.access_token : "";
    } catch (e) { return ""; }
  }

  function adopt(forAccount, serverState, rev) {
    if (forAccount !== account) return;
    if (hasActivity(state) && JSON.stringify(state) !== JSON.stringify(serverState)) {
      try { localStorage.setItem(storageKey() + ":backup", JSON.stringify(state)); } catch (e) { /* ignore */ }
    }
    state = { ...freshState(), ...serverState };
    saveLocal();
    setMeta({ rev, dirty: false });
    renderAll();
  }

  async function push(forAccount, token) {
    const res = await fetch("/api/paper/portfolio", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ rev: getMeta().rev, state }),
    });
    const data = await res.json().catch(() => ({}));
    if (forAccount !== account) return;
    if (res.status === 409 && data.state) {
      // Another device saved first: show its portfolio instead.
      adopt(forAccount, data.state, data.rev);
      toast("Portfolio updated from your other device");
    } else if (res.ok) {
      setMeta({ rev: data.rev, dirty: false });
    }
  }

  async function syncNow() {
    const forAccount = account;
    if (!forAccount) return;
    const token = await sessionToken();
    if (!token || forAccount !== account) return;
    const res = await fetch("/api/paper/portfolio", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
    if (!res.ok || forAccount !== account) return;
    const server = await res.json();
    const meta = getMeta();
    if (!server.state) {
      // Nothing on the server yet: the device that has trades uploads them.
      if (meta.dirty || hasActivity(state)) await push(forAccount, token);
    } else if (server.rev > meta.rev) {
      adopt(forAccount, server.state, server.rev);
    } else if (meta.dirty) {
      await push(forAccount, token);
    }
  }

  let syncing = null, syncAgain = false, syncTimer = 0;
  function requestSync() {
    if (syncing) { syncAgain = true; return syncing; }
    syncing = syncNow().catch(() => { /* offline: retried on the next sync */ }).finally(() => {
      syncing = null;
      if (syncAgain) { syncAgain = false; requestSync(); }
    });
    return syncing;
  }
  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(requestSync, delay);
  }

  // ---------- prices ----------
  function coinOf(base) {
    return window.cdMarkets && window.cdMarkets.coinsByBase ? window.cdMarkets.coinsByBase.get(base) : null;
  }
  function priceOf(base) {
    const coin = coinOf(base);
    return coin && Number.isFinite(coin.price) ? coin.price : null;
  }

  // ---------- portfolio maths ----------
  function holding(base) {
    if (!state.holdings[base]) state.holdings[base] = { qty: 0, cost: 0, locked: 0 };
    return state.holdings[base];
  }
  function freeQty(base) {
    const h = state.holdings[base];
    return h ? Math.max(0, h.qty - (h.locked || 0)) : 0;
  }
  function lockedCash() {
    return state.orders.filter((o) => o.status === "OPEN" && o.side === "BUY").reduce((sum, o) => sum + o.reserved, 0);
  }

  function applyBuy(base, qty, price) {
    const value = qty * price;
    const fee = value * FEE_RATE;
    const h = holding(base);
    h.qty += qty;
    h.cost += value + fee;
    return { value, fee };
  }

  function applySell(base, qty, price) {
    const value = qty * price;
    const fee = value * FEE_RATE;
    const h = holding(base);
    const costPart = h.qty > EPSILON ? (h.cost / h.qty) * qty : 0;
    state.cash += value - fee;
    state.realized += value - fee - costPart;
    h.qty -= qty;
    h.cost -= costPart;
    if (h.qty <= EPSILON) delete state.holdings[base];
    return { value, fee };
  }

  function newOrder(fields) {
    return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), createdAt: Date.now(), ...fields };
  }

  function fillOrder(order, price) {
    if (order.side === "BUY") {
      const { fee } = applyBuy(order.base, order.qty, price);
      // The reserve was taken at the limit price; refund anything unused.
      state.cash += order.reserved - order.qty * price * (1 + FEE_RATE);
      order.fee = fee;
    } else {
      const h = state.holdings[order.base];
      if (h) h.locked = Math.max(0, (h.locked || 0) - order.qty);
      order.fee = applySell(order.base, order.qty, price).fee;
    }
    order.reserved = 0;
    order.status = "FILLED";
    order.fillPrice = price;
    order.filledAt = Date.now();
  }

  // ---------- futures (Long / Short with leverage) ----------
  const positions = () => (state.positions = state.positions || []);
  const liqPriceOf = (side, entry, lev) => (side === "LONG" ? entry * (1 - 0.95 / lev) : entry * (1 + 0.95 / lev));
  const pnlOf = (p, mark) => (p.side === "LONG" ? mark - p.entryPrice : p.entryPrice - mark) * p.qty;
  const maxNotional = (lev) => state.cash / (1 / lev + FUT_FEE_RATE);

  function openPosition(base, side, qty, price, leverage, margin, fee) {
    const pos = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      base, side, qty, entryPrice: price, leverage, margin,
      liqPrice: liqPriceOf(side, price, leverage), openedAt: Date.now(),
    };
    positions().unshift(pos);
    state.orders.unshift(newOrder({ base, side: side === "LONG" ? "BUY" : "SELL", action: "OPEN", leverage, type: "MARKET", qty, status: "FILLED", fillPrice: price, fee, filledAt: Date.now() }));
    return pos;
  }

  // Market order, or a Limit order. A Limit that can already fill at the
  // current price fills straight away at the (better) market price.
  // side: "BUY" = Long, "SELL" = Short.
  function placeOrder({ base, side, type, qty, limitPrice, leverage }) {
    const market = priceOf(base);
    if (!market) return { error: "Live price not available yet. Please try again in a moment." };
    qty = roundQty(qty);
    if (!(qty > 0)) return { error: "Enter a size." };
    const lev = Math.min(200, Math.max(1, Number(leverage) || 1));
    const posSide = side === "BUY" ? "LONG" : "SHORT";
    const fillsNow = type === "MARKET" || (posSide === "LONG" ? market <= limitPrice : market >= limitPrice);
    const refPrice = fillsNow ? market : limitPrice;
    if (!(refPrice > 0)) return { error: "Enter a valid limit price." };
    const notional = qty * refPrice;
    if (notional < MIN_ORDER_USDT) return { error: `Minimum order is ${MIN_ORDER_USDT} USDT.` };
    const margin = notional / lev;
    const fee = notional * FUT_FEE_RATE;
    if (margin + fee > state.cash + 1e-9) {
      return { error: `Not enough margin. Available: ${fmtMoney(state.cash)}, required: ${fmtMoney(margin + fee)}.` };
    }
    state.cash -= margin + fee;
    if (fillsNow) {
      const pos = openPosition(base, posSide, qty, market, lev, margin, fee);
      save();
      return { position: pos };
    }
    const order = newOrder({ base, side, action: "OPEN", leverage: lev, type: "LIMIT", qty, limitPrice, status: "OPEN", reserved: margin + fee });
    state.orders.unshift(order);
    save();
    return { order };
  }

  // Close at the market price: margin + P&L − close fee comes back.
  function closePosition(id, { liquidated = false } = {}) {
    const list = positions();
    const idx = list.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const p = list[idx];
    const mark = liquidated ? p.liqPrice : priceOf(p.base) || p.entryPrice;
    const pnl = pnlOf(p, mark);
    const fee = liquidated ? 0 : p.qty * mark * FUT_FEE_RATE;
    const back = liquidated ? 0 : Math.max(0, p.margin + pnl - fee);
    state.cash += back;
    state.realized += back - p.margin;
    list.splice(idx, 1);
    state.orders.unshift(newOrder({ base: p.base, side: p.side === "LONG" ? "SELL" : "BUY", action: liquidated ? "LIQUIDATED" : "CLOSE", leverage: p.leverage, type: "MARKET", qty: p.qty, status: "FILLED", fillPrice: mark, fee, filledAt: Date.now() }));
    save();
    renderAll();
    toast(liquidated
      ? `${p.side} ${p.base} ${p.leverage}x liquidated at ${fmtUsd(mark)}`
      : `Closed ${p.side} ${p.base} ${p.leverage}x · P&L ${signed(fmtMoney(Math.abs(pnl)), pnl)}`);
  }

  // Spot coins bought before futures: sell them all at the market price.
  function closeSpot(base) {
    const h = state.holdings[base];
    const price = priceOf(base);
    if (!h || !price) return;
    const qty = Math.max(0, h.qty - (h.locked || 0));
    if (qty <= EPSILON) return;
    applySell(base, qty, price);
    state.orders.unshift(newOrder({ base, side: "SELL", type: "MARKET", qty, status: "FILLED", fillPrice: price, filledAt: Date.now() }));
    save();
    renderAll();
    toast(`Sold ${fmtQty(qty)} ${base} at ${fmtUsd(price)}`);
  }

  function cancelOrder(id) {
    const order = state.orders.find((o) => o.id === id && o.status === "OPEN");
    if (!order) return;
    if (order.action === "OPEN" || order.side === "BUY") state.cash += order.reserved || 0;
    else {
      const h = state.holdings[order.base];
      if (h) h.locked = Math.max(0, (h.locked || 0) - order.qty);
    }
    order.reserved = 0;
    order.status = "CANCELLED";
    order.cancelledAt = Date.now();
    save();
    renderAll();
  }

  // Limit orders fill when the price reaches them; positions whose mark
  // price crosses the liquidation price are liquidated (margin lost).
  function checkOrdersAndLiquidations() {
    let changed = false;
    state.orders.forEach((order) => {
      if (order.status !== "OPEN") return;
      const price = priceOf(order.base);
      if (!price) return;
      if (order.action === "OPEN") {
        const long = order.side === "BUY";
        if ((long && price <= order.limitPrice) || (!long && price >= order.limitPrice)) {
          const notional = order.qty * order.limitPrice;
          const margin = notional / order.leverage;
          order.status = "FILLED";
          order.fillPrice = order.limitPrice;
          order.filledAt = Date.now();
          order.reserved = 0;
          const pos = { id: order.id, base: order.base, side: long ? "LONG" : "SHORT", qty: order.qty, entryPrice: order.limitPrice, leverage: order.leverage, margin, liqPrice: liqPriceOf(long ? "LONG" : "SHORT", order.limitPrice, order.leverage), openedAt: Date.now() };
          positions().unshift(pos);
          changed = true;
          toast(`${pos.side} ${fmtQty(pos.qty)} ${pos.base} opened at ${fmtUsd(pos.entryPrice)} (limit)`);
        }
      } else if ((order.side === "BUY" && price <= order.limitPrice) || (order.side === "SELL" && price >= order.limitPrice)) {
        fillOrder(order, order.limitPrice); // older spot limit orders
        changed = true;
      }
    });
    if (changed) save();
    positions().slice().forEach((p) => {
      const mark = priceOf(p.base);
      if (!mark) return;
      if ((p.side === "LONG" && mark <= p.liqPrice) || (p.side === "SHORT" && mark >= p.liqPrice)) closePosition(p.id, { liquidated: true });
    });
  }

  // ---------- Positions page ----------
  function accountTotals() {
    const posRows = positions().map((p) => {
      const mark = priceOf(p.base) || p.entryPrice;
      const pnl = pnlOf(p, mark);
      return { p, mark, pnl, roe: p.margin > 0 ? (pnl / p.margin) * 100 : 0, notional: p.qty * mark };
    });
    const spotRows = Object.entries(state.holdings).filter(([, h]) => h.qty > EPSILON).map(([base, h]) => {
      const price = priceOf(base) ?? (h.qty ? h.cost / h.qty : 0);
      const value = h.qty * price;
      return { base, h, price, value, pnl: value - h.cost, pct: h.cost ? ((value - h.cost) / h.cost) * 100 : 0, avg: h.qty ? h.cost / h.qty : 0 };
    });
    const margin = posRows.reduce((s, r) => s + r.p.margin, 0);
    const unrealized = posRows.reduce((s, r) => s + r.pnl, 0) + spotRows.reduce((s, r) => s + r.pnl, 0);
    const spotCost = spotRows.reduce((s, r) => s + r.h.cost, 0);
    const spotValue = spotRows.reduce((s, r) => s + r.value, 0);
    const reserved = state.orders.filter((o) => o.status === "OPEN").reduce((s, o) => s + (o.reserved || 0), 0);
    const invested = margin + spotCost;
    const equity = state.cash + reserved + margin + posRows.reduce((s, r) => s + r.pnl, 0) + spotValue;
    return { posRows, spotRows, invested, reserved, unrealized, equity, total: equity - STARTING_USDT };
  }

  function renderPositions() {
    const t = accountTotals();
    const setText = (id, text, cls) => { const node = el(id); if (!node) return; node.textContent = text; if (cls !== undefined) node.className = cls; };
    const pnlLine = `${signed(Math.abs((t.total / STARTING_USDT) * 100).toFixed(2) + "%", t.total)} · ${signed(fmtInr(Math.abs(t.total)), t.total)}`;
    setText("cdFundAvailable", fmtMoney(state.cash));
    setText("cdFundAvailableInr", fmtInr(state.cash));
    setText("cdFundInvested", fmtMoney(t.invested));
    setText("cdFundLocked", t.reserved > 0 ? `${fmtMoney(t.reserved)} in open orders` : "Margin in use");
    setText("cdFundCurrent", fmtMoney(t.equity));
    setText("cdFundCurrentInr", fmtInr(t.equity));
    setText("cdFundPnl", signed(fmtMoney(Math.abs(t.total)), t.total), pctClass(t.total));
    setText("cdFundPnlPct", pnlLine);

    // Settings → Funds: the same virtual account at a glance.
    setText("settingsPaperFundsAvailable", fmtMoney(state.cash));
    setText("settingsPaperFundsAvailableInr", fmtInr(state.cash));
    setText("settingsPaperFundsUsed", fmtMoney(t.invested + t.reserved));
    setText("settingsPaperFundsUsedNote", t.reserved > 0 ? `${fmtMoney(t.reserved)} in open orders` : "Margin in use");
    setText("settingsPaperFundsPnl", signed(fmtMoney(Math.abs(t.total)), t.total), pctClass(t.total));
    setText("settingsPaperFundsPnlPct", signed(Math.abs((t.total / STARTING_USDT) * 100).toFixed(2) + "%", t.total));
    setText("settingsPaperFundsOpening", fmtMoney(STARTING_USDT));
    setText("settingsPaperFundsOpeningInr", fmtInr(STARTING_USDT));

    const list = el("cdHoldList");
    if (list) {
      const futures = t.posRows.map(({ p, mark, pnl, roe, notional }) => `
        <div class="cd-pos-card">
          <div class="cd-pos-top">
            <span class="cd-coin-cell">${avatar(p.base)}<strong>${escapeHtml(p.base)}/USDT</strong></span>
            <span class="cd-pos-tag is-${p.side.toLowerCase()}">${p.side} ${p.leverage}x</span>
            <button type="button" class="cd-ghost-btn cd-pos-close" data-close-pos="${escapeHtml(p.id)}">Close Market</button>
          </div>
          <div class="cd-pos-grid">
            <div><span>Size</span><b>${fmtQty(p.qty)} ${escapeHtml(p.base)} · ${fmtMoney(notional)}</b></div>
            <div><span>Margin</span><b>${fmtMoney(p.margin)}</b></div>
            <div><span>Entry price</span><b>${fmtUsd(p.entryPrice)}</b></div>
            <div><span>Mark price</span><b>${fmtUsd(mark)}</b></div>
            <div><span>Liq. price</span><b class="cd-pos-liq">${fmtUsd(p.liqPrice)}</b></div>
            <div><span>Unrealized P&amp;L (ROE)</span><b class="${pctClass(pnl)}">${signed(fmtMoney(Math.abs(pnl)), pnl)} (${signed(Math.abs(roe).toFixed(2) + "%", pnl)})</b></div>
          </div>
        </div>`).join("");
      const spot = t.spotRows.map((r) => `
        <div class="cd-hold-row">
          <span class="cd-coin-cell">${avatar(r.base)}<span><strong>${escapeHtml(r.base)} · Spot</strong><small>${fmtQty(r.h.qty)} · Avg ${fmtUsd(r.avg)}</small></span></span>
          <span class="cd-hold-mid"><span>LTP ${fmtUsd(r.price)}</span><small>${fmtMoney(r.value)} · ${fmtInr(r.value)}</small></span>
          <span class="cd-hold-pnl ${pctClass(r.pnl)}">${signed(fmtMoney(Math.abs(r.pnl)), r.pnl)}<small><button type="button" class="cd-ghost-btn cd-pos-close" data-close-spot="${escapeHtml(r.base)}">Sell all</button></small></span>
        </div>`).join("");
      list.innerHTML = futures + spot;
    }
    const count = t.posRows.length + t.spotRows.length;
    setText("cdHoldCount", count ? `(${count})` : "");
    const empty = el("cdHoldEmpty");
    if (empty) empty.hidden = count > 0;
  }

  // ---------- Orders page ----------
  let orderFilter = "all";
  const STATUS_LABEL = { OPEN: "Open", FILLED: "Executed", CANCELLED: "Cancelled" };

  function renderOrders() {
    const list = el("cdOrderList");
    if (!list) return;
    const orders = state.orders.filter((o) => orderFilter === "all" || o.status === orderFilter);
    list.innerHTML = orders.map((o) => {
      const price = o.status === "FILLED" ? o.fillPrice : o.limitPrice;
      const when = new Date(o.filledAt || o.cancelledAt || o.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      const label = o.action === "OPEN" ? (o.side === "BUY" ? "LONG" : "SHORT") : o.action === "CLOSE" ? "CLOSE" : o.action === "LIQUIDATED" ? "LIQ." : o.side;
      const tone = o.action === "CLOSE" ? "" : o.action === "LIQUIDATED" ? "cd-down" : o.side === "BUY" ? "cd-up" : "cd-down";
      return `<div class="cd-order-row">
        <span class="cd-order-side ${tone}">${label}</span>
        <span class="cd-order-main"><strong>${escapeHtml(o.base)}${o.leverage ? ` · ${o.leverage}x` : ""}</strong><small>${o.type === "LIMIT" ? "Limit" : "Market"} · ${fmtQty(o.qty)} @ ${price ? fmtUsd(price) : "--"} · ${when}</small></span>
        <span class="cd-order-status is-${o.status.toLowerCase()}">${STATUS_LABEL[o.status] || o.status}</span>
        ${o.status === "OPEN" ? `<button type="button" class="cd-ghost-btn cd-order-cancel" data-cancel="${o.id}">Cancel</button>` : ""}
      </div>`;
    }).join("");
    const empty = el("cdOrderEmpty");
    if (empty) empty.hidden = orders.length > 0;
  }

  function renderAll() {
    renderPositions();
    renderOrders();
    if (ticket.base) renderTicket();
  }

  // ---------- order ticket (Long / Short) ----------
  // side: "BUY" = Long, "SELL" = Short. unit: size typed in LOT, USD or COIN.
  const ticket = { base: null, side: "BUY", type: "MARKET", leverage: DEFAULT_LEVERAGE, unit: "LOT" };

  function ticketPrice() {
    if (ticket.type === "LIMIT") {
      const limit = parseFloat(el("cdLimitPrice").value);
      return limit > 0 ? limit : null;
    }
    return priceOf(ticket.base);
  }

  // The size box in the chosen unit → quantity in coins.
  function ticketQty() {
    const raw = parseFloat(el("cdAmount").value) || 0;
    const price = ticketPrice();
    if (ticket.unit === "LOT") return raw * lotSize(ticket.base);
    if (ticket.unit === "USD") return price ? raw / price : 0;
    return raw;
  }

  function unitLabel() {
    if (ticket.unit === "LOT") return `Size in lots (1 lot = ${lotSize(ticket.base)} ${ticket.base})`;
    if (ticket.unit === "USD") return "Size in USD (position value)";
    return `Size in ${ticket.base}`;
  }

  function renderTicket() {
    const coin = coinOf(ticket.base);
    el("cdTicketTitle").textContent = ticket.base;
    el("cdTicketAvatar").innerHTML = avatar(ticket.base);
    el("cdTicketPrice").textContent = coin ? fmtUsd(coin.price) : "$--";
    el("cdTicketInr").textContent = coin && fmt().fmtInr ? fmt().fmtInr(coin.price) : "";
    const change = el("cdTicketChange");
    change.textContent = coin ? `${coin.change_percent > 0 ? "+" : ""}${coin.change_percent.toFixed(2)}%` : "";
    change.className = coin ? pctClass(coin.change_percent) : "";

    document.querySelectorAll("#cdTicket [data-side]").forEach((b) => b.classList.toggle("is-active", b.dataset.side === ticket.side));
    document.querySelectorAll("#cdTicket [data-type]").forEach((b) => b.classList.toggle("is-active", b.dataset.type === ticket.type));
    document.querySelectorAll("#cdTicket [data-unit]").forEach((b) => b.classList.toggle("is-active", b.dataset.unit === ticket.unit));
    const coinUnit = document.querySelector('#cdTicket [data-unit="COIN"]');
    if (coinUnit) coinUnit.textContent = ticket.base;
    el("cdLeverageSelect").value = String(ticket.leverage);
    el("cdLimitField").hidden = ticket.type !== "LIMIT";
    el("cdUnitLabel").textContent = unitLabel();

    const price = ticketPrice();
    const qty = ticketQty();
    const notional = price ? qty * price : 0;
    const margin = notional / ticket.leverage;
    const fee = notional * FUT_FEE_RATE;
    const isLong = ticket.side === "BUY";
    el("cdTicketAvail").textContent = `${fmtMoney(state.cash)} (${fmtInr(state.cash)})`;
    el("cdTicketSize").textContent = notional > 0 ? `${fmtQty(roundQty(qty))} ${ticket.base} · ${fmtMoney(notional)}` : "--";
    el("cdTicketMargin").textContent = notional > 0 ? `${fmtMoney(margin)} · ${fmtInr(margin)}` : "--";
    el("cdTicketFee").textContent = notional > 0 ? fmtMoney(fee) : "--";
    el("cdTicketLiq").textContent = notional > 0 && price ? fmtUsd(liqPriceOf(isLong ? "LONG" : "SHORT", price, ticket.leverage)) : "--";
    const submit = el("cdTicketSubmit");
    submit.textContent = isLong ? "Open Long" : "Open Short";
    submit.className = `cd-submit ${isLong ? "is-buy" : "is-sell"}`;
  }

  function showError(message) {
    const box = el("cdTicketError");
    box.textContent = message || "";
    box.hidden = !message;
  }

  function openTicket(base, side = "BUY") {
    if (!base) return;
    ticket.base = base;
    ticket.side = side;
    ticket.type = "MARKET";
    el("cdAmount").value = "";
    const price = priceOf(base);
    el("cdLimitPrice").value = price ? String(price) : "";
    showError("");
    renderTicket();
    el("cdTicket").hidden = false;
  }

  function closeTicket() {
    el("cdTicket").hidden = true;
    ticket.base = null;
  }

  function submitTicket() {
    const limitPrice = parseFloat(el("cdLimitPrice").value);
    const result = placeOrder({ base: ticket.base, side: ticket.side, type: ticket.type, qty: ticketQty(), limitPrice, leverage: ticket.leverage });
    if (result.error) {
      showError(result.error);
      return;
    }
    closeTicket();
    renderAll();
    if (result.position) {
      const p = result.position;
      toast(`${p.side} ${fmtQty(p.qty)} ${p.base} at ${fmtUsd(p.entryPrice)} (${p.leverage}x)`);
      goTo("positions");
    } else {
      const o = result.order;
      toast(`Limit ${o.side === "BUY" ? "long" : "short"} placed: ${fmtQty(o.qty)} ${o.base} at ${fmtUsd(o.limitPrice)}`);
      goTo("orders");
    }
  }

  function goTo(tab) {
    document.querySelector(`.app-tab[data-tab="${tab}"]`)?.click();
  }

  let toastTimer = null;
  function toast(message) {
    let node = el("cdToast");
    if (!node) {
      node = document.createElement("div");
      node.id = "cdToast";
      node.className = "cd-toast";
      node.setAttribute("role", "status");
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("is-visible"), 3200);
  }

  // ---------- events ----------
  el("cdTicketClose").addEventListener("click", closeTicket);
  el("cdTicketChart")?.addEventListener("click", () => {
    const base = ticket.base;
    closeTicket();
    if (base && typeof window.cdOpenTradingView === "function") window.cdOpenTradingView(base);
  });
  el("cdTicket").addEventListener("click", (event) => { if (event.target.id === "cdTicket") closeTicket(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && ticket.base) closeTicket(); });
  el("cdTicketSubmit").addEventListener("click", submitTicket);

  el("cdTicket").addEventListener("click", (event) => {
    const side = event.target.closest("[data-side]");
    if (side) { ticket.side = side.dataset.side; showError(""); renderTicket(); return; }
    const type = event.target.closest("[data-type]");
    if (type) { ticket.type = type.dataset.type; renderTicket(); return; }
    const unit = event.target.closest("[data-unit]");
    if (unit) {
      // Keep the same position size when switching units.
      const qty = ticketQty();
      ticket.unit = unit.dataset.unit;
      const price = ticketPrice();
      const box = el("cdAmount");
      if (qty > 0) {
        if (ticket.unit === "LOT") box.value = String(Math.floor(qty / lotSize(ticket.base)));
        else if (ticket.unit === "USD") box.value = price ? (qty * price).toFixed(2) : "";
        else box.value = String(roundQty(qty));
      }
      renderTicket();
      return;
    }
    const pct = event.target.closest("[data-pct]");
    if (pct) {
      const price = ticketPrice();
      if (!price) return;
      const qty = (maxNotional(ticket.leverage) * Number(pct.dataset.pct)) / 100 / price;
      const box = el("cdAmount");
      if (ticket.unit === "LOT") box.value = String(Math.floor(qty / lotSize(ticket.base)));
      else if (ticket.unit === "USD") box.value = (Math.floor(qty * price * 100) / 100).toFixed(2);
      else box.value = String(roundQty(qty));
      showError("");
      renderTicket();
    }
  });
  el("cdLeverageSelect").addEventListener("change", (event) => { ticket.leverage = Number(event.target.value) || 1; showError(""); renderTicket(); });
  el("cdAmount").addEventListener("input", () => { showError(""); renderTicket(); });
  el("cdLimitPrice").addEventListener("input", () => renderTicket());

  document.addEventListener("click", (event) => {
    const closeBtn = event.target.closest("[data-close-pos]");
    if (closeBtn) { closePosition(closeBtn.dataset.closePos); return; }
    const spotBtn = event.target.closest("[data-close-spot]");
    if (spotBtn) { closeSpot(spotBtn.dataset.closeSpot); return; }
    const cancel = event.target.closest("[data-cancel]");
    if (cancel) { cancelOrder(cancel.dataset.cancel); return; }
    const filter = event.target.closest("#cdOrderFilters [data-filter]");
    if (filter) {
      orderFilter = filter.dataset.filter;
      document.querySelectorAll("#cdOrderFilters [data-filter]").forEach((b) => b.classList.toggle("is-active", b === filter));
      renderOrders();
    }
  });

  el("cdResetFunds")?.addEventListener("click", () => {
    if (!window.confirm(`Reset paper trading? All positions, coins, orders and P&L for this account are cleared and funds go back to ${STARTING_USDT.toLocaleString("en-US")} USDT.`)) return;
    state = freshState();
    save();
    renderAll();
    toast(`Funds reset to ${STARTING_USDT.toLocaleString("en-US")} USDT`);
  });

  window.addEventListener("cd-markets-updated", () => {
    checkOrdersAndLiquidations();
    renderAll();
  });

  window.addEventListener("cd-user-changed", (event) => {
    const next = (event.detail && event.detail.email) || "";
    if (next === account) return;
    account = next;
    state = load();
    closeTicket();
    renderAll();
    scheduleSync(0);
  });

  // Pick up trades made on another device: once the session is ready, when
  // the app comes back to the front, and every 20s while it is open.
  window.addEventListener("cd-auth-state", (event) => { if (event.detail && event.detail.signedIn) scheduleSync(0); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSync(0); });
  setInterval(() => { if (!document.hidden) requestSync(); }, 20000);
  scheduleSync(1500);

  window.cdOpenTicket = openTicket;
  // For Coin Detail / coin sheet: this account's open size in one coin
  // (futures positions, or older spot coins) with live P&L.
  window.cdPaperHolding = (base) => {
    const list = positions().filter((p) => p.base === base);
    if (list.length) {
      const mark = priceOf(base);
      const qty = list.reduce((s, p) => s + p.qty, 0);
      const margin = list.reduce((s, p) => s + p.margin, 0);
      const pnl = list.reduce((s, p) => s + pnlOf(p, mark || p.entryPrice), 0);
      const avg = list.reduce((s, p) => s + p.entryPrice * p.qty, 0) / qty;
      return { qty, avg, value: qty * (mark || avg), pnl, pct: margin ? (pnl / margin) * 100 : 0 };
    }
    const h = state.holdings[base];
    if (!h || h.qty <= EPSILON) return null;
    const price = priceOf(base) ?? h.cost / h.qty;
    const value = h.qty * price;
    return { qty: h.qty, avg: h.cost / h.qty, value, pnl: value - h.cost, pct: h.cost ? ((value - h.cost) / h.cost) * 100 : 0 };
  };
  // For Coin Detail: this coin's latest filled paper trades, newest first.
  window.cdPaperTrades = (base, limit = 3) => state.orders
    .filter((o) => o.base === base && o.status === "FILLED")
    .slice(0, limit)
    .map((o) => ({ side: o.side, qty: o.qty, price: o.fillPrice, at: o.filledAt || o.createdAt }));
  renderAll();
})();
