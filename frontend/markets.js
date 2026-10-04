// All-coins Dashboard and Watchlist: every Binance USDT coin with live price
// in $ and ₹, 24h change, top movers and a searchable, sortable table.
// Data comes from /api/markets (cached server-side, so polling every few
// seconds costs Binance one call no matter how many people have it open).
(function cryptoMarkets() {
  const POLL_MS = 3000;
  const PAGE_SIZE = 100;
  const KEY_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE"];
  // Gainers/losers among thinly traded coins are mostly noise.
  const MOVER_MIN_VOLUME_USDT = 1000000;
  const WATCHLIST_KEY = "cdWatchlistV1";
  const DEFAULT_WATCHLIST = ["BTC", "ETH", "SOL"];
  const AVATAR_COLOURS = ["#f7931a", "#627eea", "#f3ba2f", "#14f195", "#23292f", "#c2a633", "#e84142", "#8247e5", "#2a5ada", "#0033ad", "#ff007a", "#16c784"];

  const el = (id) => document.getElementById(id);
  const dashBody = el("cdAllCoinsBody");
  if (!dashBody) return;

  let coins = [];
  let coinsByBase = new Map();
  let usdtInr = null;
  let lastOkAt = 0;
  let sortKey = "volume_usdt";
  let sortDir = -1;
  let shown = PAGE_SIZE;
  let pollTimer = null;

  // ---------- watchlist (this device) ----------
  function loadWatchlist() {
    try {
      const saved = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "null");
      if (Array.isArray(saved)) return saved;
    } catch (e) { /* ignore */ }
    return DEFAULT_WATCHLIST.slice();
  }
  let watchlist = loadWatchlist();
  function saveWatchlist() {
    try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist)); } catch (e) { /* ignore */ }
  }
  function toggleWatch(base) {
    watchlist = watchlist.includes(base) ? watchlist.filter((b) => b !== base) : watchlist.concat(base);
    saveWatchlist();
    render();
  }

  // ---------- formatting ----------
  function decimalsFor(price) {
    if (price >= 1000) return 2;
    if (price >= 1) return 3;
    if (price >= 0.01) return 5;
    return 8;
  }
  function fmtUsd(price) {
    if (!Number.isFinite(price)) return "$--";
    const d = decimalsFor(price);
    return "$" + price.toLocaleString("en-US", { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
  }
  function fmtInr(price) {
    if (!Number.isFinite(price) || !usdtInr) return "₹--";
    const inr = price * usdtInr;
    const d = decimalsFor(inr);
    return "₹" + inr.toLocaleString("en-IN", { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
  }
  function fmtPct(pct) {
    if (!Number.isFinite(pct)) return "--";
    return (pct > 0 ? "+" : "") + pct.toFixed(2) + "%";
  }
  function pctClass(pct) {
    return pct > 0 ? "cd-up" : pct < 0 ? "cd-down" : "cd-flat";
  }
  function fmtVolume(v) {
    if (!Number.isFinite(v)) return "--";
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + v.toFixed(0);
  }
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function avatar(base) {
    let hash = 0;
    for (const ch of base) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const colour = AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
    return `<span class="cd-avatar" style="background:${colour}">${escapeHtml(base.slice(0, 3))}</span>`;
  }

  // ---------- rendering ----------
  function coinRow(coin) {
    const on = watchlist.includes(coin.base);
    return `<tr data-base="${escapeHtml(coin.base)}">
      <td><button class="cd-star${on ? " is-on" : ""}" type="button" data-star="${escapeHtml(coin.base)}" aria-label="${on ? "Remove from" : "Add to"} watchlist">${on ? "★" : "☆"}</button></td>
      <td><div class="cd-coin-cell">${avatar(coin.base)}<div><strong>${escapeHtml(coin.base)}</strong><small>/USDT</small></div></div></td>
      <td class="cd-num">${fmtUsd(coin.price)}<span class="cd-sub">${fmtInr(coin.price)}</span></td>
      <td class="cd-num ${pctClass(coin.change_percent)}">${fmtPct(coin.change_percent)}</td>
      <td class="cd-num cd-col-wide">${fmtUsd(coin.high)}<span class="cd-sub">${fmtUsd(coin.low)}</span></td>
      <td class="cd-num cd-col-wide">${fmtVolume(coin.volume_usdt)}</td>
    </tr>`;
  }

  function matches(coin, query) {
    return !query || coin.base.includes(query) || coin.symbol.includes(query);
  }

  function sortedCoins(list) {
    return list.slice().sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string") return av.localeCompare(bv) * sortDir;
      return ((av || 0) - (bv || 0)) * sortDir;
    });
  }

  function renderKeyCoins() {
    const box = el("cdKeyCoins");
    if (!box) return;
    box.innerHTML = KEY_COINS.map((base) => coinsByBase.get(base)).filter(Boolean).map((coin) => `
      <div class="cd-key-card" data-base="${escapeHtml(coin.base)}">
        <div class="cd-key-card-top">${avatar(coin.base)}<span>${escapeHtml(coin.base)}</span><span class="${pctClass(coin.change_percent)}" style="margin-left:auto;font-size:12.5px">${fmtPct(coin.change_percent)}</span></div>
        <div class="cd-key-price">${fmtUsd(coin.price)}</div>
        <div class="cd-key-inr">${fmtInr(coin.price)}</div>
      </div>`).join("");
  }

  function moverItem(coin, right) {
    return `<li data-base="${escapeHtml(coin.base)}"><span class="cd-mover-name">${avatar(coin.base)}<span>${escapeHtml(coin.base)}</span></span><span class="cd-mover-right">${right}</span></li>`;
  }

  function renderMovers() {
    const liquid = coins.filter((c) => c.volume_usdt >= MOVER_MIN_VOLUME_USDT);
    const byChange = liquid.slice().sort((a, b) => b.change_percent - a.change_percent);
    const gainers = byChange.filter((c) => c.change_percent > 0).slice(0, 5);
    const losers = byChange.filter((c) => c.change_percent < 0).reverse().slice(0, 5);
    const active = coins.slice(0, 5); // server already sorts by volume
    const priceAndPct = (c) => `${fmtUsd(c.price)}<br><span class="${pctClass(c.change_percent)}">${fmtPct(c.change_percent)}</span>`;
    const empty = '<li class="cd-meta">--</li>';
    el("cdTopGainers").innerHTML = gainers.map((c) => moverItem(c, priceAndPct(c))).join("") || empty;
    el("cdTopLosers").innerHTML = losers.map((c) => moverItem(c, priceAndPct(c))).join("") || empty;
    el("cdMostActive").innerHTML = active.map((c) => moverItem(c, `${fmtVolume(c.volume_usdt)}<br><span class="${pctClass(c.change_percent)}">${fmtPct(c.change_percent)}</span>`)).join("") || empty;
  }

  function renderBreadth() {
    const up = coins.filter((c) => c.change_percent > 0).length;
    const down = coins.filter((c) => c.change_percent < 0).length;
    const total = up + down || 1;
    el("cdBreadthUp").style.width = (up / total) * 100 + "%";
    el("cdBreadthDown").style.width = (down / total) * 100 + "%";
    el("cdBreadthText").innerHTML = `<span class="cd-up">${up} up</span> · <span class="cd-down">${down} down</span>`;
  }

  function renderAllCoins() {
    const query = (el("cdSearch")?.value || "").trim().toUpperCase();
    const list = sortedCoins(coins.filter((c) => matches(c, query)));
    dashBody.innerHTML = list.slice(0, shown).map(coinRow).join("") ||
      `<tr><td colspan="6" class="cd-empty">${coins.length ? "No coin matches your search." : "Loading coins…"}</td></tr>`;
    el("cdCoinCount").textContent = coins.length ? `(${list.length})` : "";
    const more = el("cdShowMore");
    if (more) {
      more.hidden = list.length <= shown;
      more.textContent = `Show more (${Math.max(0, list.length - shown)} left)`;
    }
    document.querySelectorAll(".cd-table th[data-sort]").forEach((th) => {
      th.classList.toggle("is-sorted", th.dataset.sort === sortKey);
    });
  }

  function renderWatchlist() {
    const body = el("cdWatchBody");
    if (!body) return;
    const query = (el("cdWatchSearch")?.value || "").trim().toUpperCase();
    // While searching, show matching coins from the whole market so one can
    // be starred straight from here; otherwise just the starred ones.
    const list = query
      ? coins.filter((c) => matches(c, query)).slice(0, 30)
      : watchlist.map((b) => coinsByBase.get(b)).filter(Boolean);
    body.innerHTML = list.map(coinRow).join("");
    el("cdWatchCount").textContent = query ? "" : `(${list.length})`;
    el("cdWatchEmpty").hidden = list.length > 0 || !coins.length;
  }

  function renderMeta() {
    const meta = el("cdMarketMeta");
    if (meta) {
      // The page-wide Live badge already shows the feed state; only say
      // something here when these prices have stopped updating.
      const stale = lastOkAt && Date.now() - lastOkAt > POLL_MS * 4 ? " · Reconnecting…" : "";
      meta.textContent = `${coins.length} coins on Binance · 1 USDT = ${usdtInr ? "₹" + usdtInr.toFixed(2) : "₹--"}${stale}`;
    }
  }

  function render() {
    if (!coins.length) return;
    renderMeta();
    renderKeyCoins();
    renderBreadth();
    renderMovers();
    renderAllCoins();
    renderWatchlist();
  }

  // ---------- data ----------
  async function refresh() {
    try {
      const res = await fetch("/api/markets", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (Array.isArray(data.coins) && data.coins.length) {
        coins = data.coins;
        coinsByBase = new Map(coins.map((c) => [c.base, c]));
        if (Number.isFinite(data.usdt_inr)) usdtInr = data.usdt_inr;
        lastOkAt = Date.now();
        window.cdMarkets = { coins, coinsByBase, usdtInr };
        window.dispatchEvent(new CustomEvent("cd-markets-updated"));
      }
    } catch (e) {
      // Keep showing the last prices; the badge switches to "Reconnecting…".
    }
    render();
    renderMeta();
  }

  function activePanel() {
    return document.querySelector(".tab-panel.active")?.dataset.panel || "";
  }

  // Pages that need live prices (Positions/Orders for P&L and limit fills).
  function onMarketsPage() {
    return ["dashboard", "watchlist", "positions", "orders"].includes(activePanel());
  }

  // Poll only while a markets page is on screen and the tab is visible.
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (document.visibilityState === "visible" && onMarketsPage()) await refresh();
      schedule();
    }, onMarketsPage() ? POLL_MS : 15000);
  }

  // The BTC Refresh / Run Gemini / Run Groq bar belongs to the old BTC
  // chart tools, not to the all-coins Dashboard or Watchlist.
  function syncTopbar() {
    const bar = document.querySelector(".btc-topbar");
    if (bar) bar.hidden = onMarketsPage();
  }

  // ---------- events ----------
  document.addEventListener("click", (event) => {
    const star = event.target.closest("[data-star]");
    if (star) {
      event.preventDefault();
      toggleWatch(star.dataset.star);
      return;
    }
    // Tapping a coin anywhere on the Dashboard/Watchlist opens its order ticket.
    const coinEl = event.target.closest("tr[data-base], .cd-key-card[data-base], .cd-mover-list li[data-base]");
    if (coinEl && typeof window.cdOpenTicket === "function") {
      window.cdOpenTicket(coinEl.dataset.base);
      return;
    }
    const th = event.target.closest(".cd-table th[data-sort]");
    if (th && dashBody.closest("table").contains(th)) {
      const key = th.dataset.sort;
      sortDir = key === sortKey ? -sortDir : key === "base" ? 1 : -1;
      sortKey = key;
      renderAllCoins();
      return;
    }
    if (event.target.closest(".app-tab")) {
      setTimeout(() => { syncTopbar(); if (onMarketsPage()) refresh(); schedule(); }, 0);
    }
  });

  el("cdSearch")?.addEventListener("input", () => { shown = PAGE_SIZE; renderAllCoins(); });
  el("cdWatchSearch")?.addEventListener("input", renderWatchlist);
  el("cdShowMore")?.addEventListener("click", () => { shown += PAGE_SIZE; renderAllCoins(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { refresh(); schedule(); } });

  window.cdFormat = { fmtUsd, fmtInr, fmtPct, pctClass, avatar, escapeHtml };
  window.cdRefreshMarkets = refresh;

  syncTopbar();
  refresh();
  schedule();
})();
