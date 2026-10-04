// Paper trading for every coin: virtual USDT funds per email, Market and
// Limit orders on a spot account (buy coins, sell what you hold), holdings
// with live P&L, and an order book. Nothing here touches a real exchange.
// Live prices come from markets.js ("cd-markets-updated" / window.cdMarkets).
(function cryptoPaperTrading() {
  const STARTING_USDT = 10000;
  const FEE_RATE = 0.001; // 0.1%, like a typical spot exchange fee
  const MIN_ORDER_USDT = 1;
  const QTY_DECIMALS = 8;
  const EPSILON = 1e-9;
  const KEY_PREFIX = "cdPaperV1:";

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
  const freshState = () => ({ cash: STARTING_USDT, holdings: {}, orders: [], realized: 0 });

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey()) || "null");
      if (saved && typeof saved.cash === "number") return { ...freshState(), ...saved };
    } catch (e) { /* ignore */ }
    return freshState();
  }
  let state = load();

  function save() {
    try { localStorage.setItem(storageKey(), JSON.stringify(state)); } catch (e) { /* ignore */ }
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

  // Market order, or a Limit order. A Limit that can already fill at the
  // current price fills straight away at that (better) price.
  function placeOrder({ base, side, type, qty, limitPrice }) {
    const market = priceOf(base);
    if (!market) return { error: "Live price not available yet. Please try again in a moment." };
    qty = roundQty(qty);
    if (!(qty > 0)) return { error: "Enter an amount or quantity." };
    const fillsNow = type === "MARKET" || (side === "BUY" ? market <= limitPrice : market >= limitPrice);
    const refPrice = fillsNow ? market : limitPrice;
    if (!(refPrice > 0)) return { error: "Enter a valid limit price." };
    const value = qty * refPrice;
    if (value < MIN_ORDER_USDT) return { error: `Minimum order is ${MIN_ORDER_USDT} USDT.` };

    if (side === "BUY") {
      const needed = value * (1 + FEE_RATE);
      if (needed > state.cash + 1e-9) return { error: `Not enough funds. Available: ${fmtMoney(state.cash)} USDT.` };
      state.cash -= needed;
      const order = newOrder({ base, side, type, qty, limitPrice: type === "LIMIT" ? limitPrice : null, status: "OPEN", reserved: needed });
      state.orders.unshift(order);
      if (fillsNow) fillOrder(order, market);
      save();
      return { order };
    }

    // Selling (almost) everything sells exactly everything, so rounding
    // never leaves a speck of coin behind.
    const free = freeQty(base);
    if (qty > free + 1e-8) return { error: `You can sell up to ${fmtQty(free)} ${base}.` };
    if (qty >= free - 1e-8) qty = free;
    const order = newOrder({ base, side, type, qty, limitPrice: type === "LIMIT" ? limitPrice : null, status: "OPEN", reserved: 0 });
    state.orders.unshift(order);
    if (fillsNow) fillOrder(order, market);
    else holding(base).locked = (holding(base).locked || 0) + qty;
    save();
    return { order };
  }

  function cancelOrder(id) {
    const order = state.orders.find((o) => o.id === id && o.status === "OPEN");
    if (!order) return;
    if (order.side === "BUY") state.cash += order.reserved;
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

  function checkLimitOrders() {
    let changed = false;
    state.orders.forEach((order) => {
      if (order.status !== "OPEN") return;
      const price = priceOf(order.base);
      if (!price) return;
      if ((order.side === "BUY" && price <= order.limitPrice) || (order.side === "SELL" && price >= order.limitPrice)) {
        fillOrder(order, order.limitPrice);
        changed = true;
        toast(`${order.side === "BUY" ? "Bought" : "Sold"} ${fmtQty(order.qty)} ${order.base} at ${fmtUsd(order.limitPrice)} (limit)`);
      }
    });
    if (changed) save();
  }

  // ---------- Positions page ----------
  function renderPositions() {
    const rows = Object.entries(state.holdings).map(([base, h]) => {
      const price = priceOf(base) ?? (h.qty ? h.cost / h.qty : 0);
      const value = h.qty * price;
      const pnl = value - h.cost;
      return { base, h, price, value, pnl, pct: h.cost ? (pnl / h.cost) * 100 : 0, avg: h.qty ? h.cost / h.qty : 0 };
    }).sort((a, b) => b.value - a.value);

    const invested = rows.reduce((s, r) => s + r.h.cost, 0);
    const current = rows.reduce((s, r) => s + r.value, 0);
    const locked = lockedCash();
    const total = state.cash + locked + current - STARTING_USDT;
    const setText = (id, text, cls) => { const node = el(id); if (!node) return; node.textContent = text; if (cls !== undefined) node.className = cls; };
    setText("cdFundAvailable", fmtMoney(state.cash));
    setText("cdFundAvailableInr", fmtInr(state.cash));
    setText("cdFundInvested", fmtMoney(invested));
    setText("cdFundLocked", locked > 0 ? `${fmtMoney(locked)} in open orders` : fmtInr(invested));
    setText("cdFundCurrent", fmtMoney(current));
    setText("cdFundCurrentInr", fmtInr(current));
    setText("cdFundPnl", signed(fmtMoney(Math.abs(total)), total), pctClass(total));
    setText("cdFundPnlPct", `${signed(Math.abs((total / STARTING_USDT) * 100).toFixed(2) + "%", total)} · ${signed(fmtInr(Math.abs(total)), total)}`);

    const list = el("cdHoldList");
    if (list) {
      list.innerHTML = rows.map((r) => `
        <button type="button" class="cd-hold-row" data-hold="${escapeHtml(r.base)}">
          <span class="cd-coin-cell">${avatar(r.base)}<span><strong>${escapeHtml(r.base)}</strong><small>${fmtQty(r.h.qty)} · Avg ${fmtUsd(r.avg)}${r.h.locked ? ` · ${fmtQty(r.h.locked)} in orders` : ""}</small></span></span>
          <span class="cd-hold-mid"><span>LTP ${fmtUsd(r.price)}</span><small>${fmtMoney(r.value)} · ${fmtInr(r.value)}</small></span>
          <span class="cd-hold-pnl ${pctClass(r.pnl)}">${signed(fmtMoney(Math.abs(r.pnl)), r.pnl)}<small>${signed(Math.abs(r.pct).toFixed(2) + "%", r.pnl)}</small></span>
        </button>`).join("");
    }
    setText("cdHoldCount", rows.length ? `(${rows.length})` : "");
    const empty = el("cdHoldEmpty");
    if (empty) empty.hidden = rows.length > 0;
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
      return `<div class="cd-order-row">
        <span class="cd-order-side ${o.side === "BUY" ? "cd-up" : "cd-down"}">${o.side}</span>
        <span class="cd-order-main"><strong>${escapeHtml(o.base)}</strong><small>${o.type === "LIMIT" ? "Limit" : "Market"} · ${fmtQty(o.qty)} @ ${price ? fmtUsd(price) : "--"} · ${when}</small></span>
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

  // ---------- order ticket ----------
  const ticket = { base: null, side: "BUY", type: "MARKET", lastEdited: "amount" };

  function ticketPrice() {
    if (ticket.type === "LIMIT") {
      const limit = parseFloat(el("cdLimitPrice").value);
      return limit > 0 ? limit : null;
    }
    return priceOf(ticket.base);
  }

  // Keep Amount and Quantity in step with each other at the order price.
  function syncInputs() {
    const price = ticketPrice();
    if (!price) return;
    if (ticket.lastEdited === "amount") {
      const amount = parseFloat(el("cdAmount").value);
      el("cdQty").value = amount > 0 ? String(roundQty(amount / price)) : "";
    } else {
      const qty = parseFloat(el("cdQty").value);
      el("cdAmount").value = qty > 0 ? (qty * price).toFixed(2) : "";
    }
  }

  function renderTicket() {
    const coin = coinOf(ticket.base);
    el("cdTicketTitle").textContent = ticket.base;
    el("cdTicketAvatar").innerHTML = avatar(ticket.base);
    el("cdQtyUnit").textContent = ticket.base;
    el("cdTicketPrice").textContent = coin ? fmtUsd(coin.price) : "$--";
    el("cdTicketInr").textContent = coin && fmt().fmtInr ? fmt().fmtInr(coin.price) : "";
    const change = el("cdTicketChange");
    change.textContent = coin ? `${coin.change_percent > 0 ? "+" : ""}${coin.change_percent.toFixed(2)}%` : "";
    change.className = coin ? pctClass(coin.change_percent) : "";

    document.querySelectorAll("#cdTicket [data-side]").forEach((b) => b.classList.toggle("is-active", b.dataset.side === ticket.side));
    document.querySelectorAll("#cdTicket [data-type]").forEach((b) => b.classList.toggle("is-active", b.dataset.type === ticket.type));
    el("cdLimitField").hidden = ticket.type !== "LIMIT";

    const isBuy = ticket.side === "BUY";
    el("cdTicketAvail").textContent = isBuy ? `${fmtMoney(state.cash)} (${fmtInr(state.cash)})` : `${fmtQty(freeQty(ticket.base))} ${ticket.base}`;
    const amount = parseFloat(el("cdAmount").value) || 0;
    const fee = amount * FEE_RATE;
    el("cdTicketFee").textContent = fmtMoney(fee);
    const total = isBuy ? amount + fee : amount - fee;
    el("cdTicketTotal").textContent = amount > 0 ? `${fmtMoney(total)} · ${fmtInr(total)}${isBuy ? "" : " (you get)"}` : "--";
    const submit = el("cdTicketSubmit");
    submit.textContent = `${isBuy ? "Buy" : "Sell"} ${ticket.base}`;
    submit.className = `cd-submit ${isBuy ? "is-buy" : "is-sell"}`;
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
    ticket.lastEdited = "amount";
    el("cdAmount").value = "";
    el("cdQty").value = "";
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
    const qty = parseFloat(el("cdQty").value);
    const limitPrice = parseFloat(el("cdLimitPrice").value);
    const result = placeOrder({ base: ticket.base, side: ticket.side, type: ticket.type, qty, limitPrice });
    if (result.error) {
      showError(result.error);
      return;
    }
    const o = result.order;
    closeTicket();
    renderAll();
    if (o.status === "FILLED") {
      toast(`${o.side === "BUY" ? "Bought" : "Sold"} ${fmtQty(o.qty)} ${o.base} at ${fmtUsd(o.fillPrice)}`);
      goTo("positions");
    } else {
      toast(`Limit ${o.side.toLowerCase()} order placed: ${fmtQty(o.qty)} ${o.base} at ${fmtUsd(o.limitPrice)}`);
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
    if (base && typeof window.cdOpenCoin === "function") window.cdOpenCoin(base);
  });
  el("cdTicket").addEventListener("click", (event) => { if (event.target.id === "cdTicket") closeTicket(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && ticket.base) closeTicket(); });
  el("cdTicketSubmit").addEventListener("click", submitTicket);

  el("cdTicket").addEventListener("click", (event) => {
    const side = event.target.closest("[data-side]");
    if (side) { ticket.side = side.dataset.side; showError(""); renderTicket(); return; }
    const type = event.target.closest("[data-type]");
    if (type) { ticket.type = type.dataset.type; syncInputs(); renderTicket(); return; }
    const pct = event.target.closest("[data-pct]");
    if (pct) {
      const share = Number(pct.dataset.pct) / 100;
      if (ticket.side === "BUY") {
        ticket.lastEdited = "amount";
        el("cdAmount").value = (Math.floor((state.cash * share) / (1 + FEE_RATE) * 100) / 100).toFixed(2);
      } else {
        ticket.lastEdited = "qty";
        el("cdQty").value = String(roundQty(freeQty(ticket.base) * share));
      }
      syncInputs();
      showError("");
      renderTicket();
    }
  });
  el("cdAmount").addEventListener("input", () => { ticket.lastEdited = "amount"; syncInputs(); showError(""); renderTicket(); });
  el("cdQty").addEventListener("input", () => { ticket.lastEdited = "qty"; syncInputs(); showError(""); renderTicket(); });
  el("cdLimitPrice").addEventListener("input", () => { syncInputs(); renderTicket(); });

  document.addEventListener("click", (event) => {
    const hold = event.target.closest("[data-hold]");
    if (hold) { openTicket(hold.dataset.hold, "SELL"); return; }
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
    if (!window.confirm(`Reset paper trading? All coins, orders and P&L for this account are cleared and funds go back to ${STARTING_USDT.toLocaleString("en-US")} USDT.`)) return;
    state = freshState();
    save();
    renderAll();
    toast(`Funds reset to ${STARTING_USDT.toLocaleString("en-US")} USDT`);
  });

  window.addEventListener("cd-markets-updated", () => {
    checkLimitOrders();
    renderAll();
  });

  window.addEventListener("cd-user-changed", (event) => {
    const next = (event.detail && event.detail.email) || "";
    if (next === account) return;
    account = next;
    state = load();
    closeTicket();
    renderAll();
  });

  window.cdOpenTicket = openTicket;
  // For Coin Detail: this account's holding in one coin, with live P&L.
  window.cdPaperHolding = (base) => {
    const h = state.holdings[base];
    if (!h || h.qty <= EPSILON) return null;
    const price = priceOf(base) ?? h.cost / h.qty;
    const value = h.qty * price;
    return { qty: h.qty, avg: h.cost / h.qty, value, pnl: value - h.cost, pct: h.cost ? ((value - h.cost) / h.cost) * 100 : 0 };
  };
  renderAll();
})();
