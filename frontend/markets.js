// All-coins Dashboard and Watchlist: every Binance USDT coin with live price
// in $ and ₹, 24h change, top movers and a searchable, sortable table.
// Data comes from /api/markets (cached server-side, so polling every few
// seconds costs Binance one call no matter how many people have it open).
(function cryptoMarkets() {
  const POLL_MS = 3000;
  const PAGE_SIZE = 100;
  const KEY_COINS = ["BNB", "SOL", "XRP", "DOGE"]; // the Crypto Market row
  const FEATURED = ["BTC", "ETH"]; // big cards with a 24h sparkline
  const TICKER_SIZE = 12;
  const SPARK_REFRESH_MS = 5 * 60 * 1000;
  // Coin logos (open-source icon set); coins without one keep the letter badge.
  const LOGO_URL = (base) => `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${base.toLowerCase()}.png`;
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
    return `<span class="cd-avatar" style="background:${colour}">${escapeHtml(base.slice(0, 3))}<img src="${LOGO_URL(base)}" alt="" loading="lazy" onload="this.parentNode.classList.add('has-logo')" onerror="this.remove()"></span>`;
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

  // Crypto Market row: small cards for a few big coins.
  function renderKeyCoins() {
    const box = el("cdKeyCoins");
    if (!box) return;
    box.innerHTML = KEY_COINS.map((base) => coinsByBase.get(base)).filter(Boolean).map((coin) => `
      <div class="cd-mini-coin" data-base="${escapeHtml(coin.base)}">
        <div class="cd-mini-top">${avatar(coin.base)}<strong>${escapeHtml(coin.base)}</strong></div>
        <div class="cd-mini-price">${fmtUsd(coin.price)}</div>
        <div class="cd-mini-pct ${pctClass(coin.change_percent)}">${fmtPct(coin.change_percent)}</div>
      </div>`).join("");
  }

  // Ticker strip: the most traded coins.
  function renderTicker() {
    const box = el("cdTicker");
    if (!box) return;
    box.innerHTML = coins.slice(0, TICKER_SIZE).map((coin) => `
      <button type="button" class="cd-tick" data-base="${escapeHtml(coin.base)}">
        ${avatar(coin.base)}
        <span class="cd-tick-text"><strong>${escapeHtml(coin.base)}</strong><span>${fmtUsd(coin.price)} <em class="${pctClass(coin.change_percent)}">${fmtPct(coin.change_percent)}</em></span></span>
      </button>`).join("");
  }

  // BTC / ETH cards with a 24h sparkline (hourly closes, refreshed every
  // few minutes; the live price is drawn as the last point).
  const sparks = {};
  let sparksFetchedAt = 0;
  async function loadSparks() {
    if (Date.now() - sparksFetchedAt < SPARK_REFRESH_MS) return;
    sparksFetchedAt = Date.now();
    await Promise.all(FEATURED.map(async (base) => {
      try {
        const res = await fetch(`/api/coin/candles?symbol=${base}USDT&interval=1h&limit=24`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        sparks[base] = (data.candles || []).map((c) => c.close);
      } catch (e) { /* keep the old line */ }
    }));
    renderFeatured();
  }

  function sparkSvg(points, up) {
    if (!points || points.length < 2) return "";
    const w = 160, h = 44;
    const min = Math.min(...points), max = Math.max(...points), span = max - min || 1;
    const xy = points.map((v, i) => [(i / (points.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 6)]);
    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const colour = up ? "#34d399" : "#f87171";
    const id = "cdSpark" + Math.random().toString(36).slice(2, 7);
    return `<svg class="cd-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colour}" stop-opacity="0.35"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></linearGradient></defs>
      <path d="${line} L${w} ${h} L0 ${h} Z" fill="url(#${id})"/>
      <path d="${line}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  function renderFeatured() {
    FEATURED.forEach((base) => {
      const box = el("cdFeature" + base);
      const coin = coinsByBase.get(base);
      if (!box || !coin) return;
      const prev = coin.price / (1 + coin.change_percent / 100);
      const diff = coin.price - prev;
      const points = sparks[base] ? sparks[base].concat(coin.price) : null;
      box.innerHTML = `
        <div class="cd-feature-top">${avatar(base)}<strong>${base}</strong><span class="cd-feature-live">● Live</span></div>
        <div class="cd-feature-price-row"><span class="cd-feature-price">${fmtUsd(coin.price)}</span><span class="cd-feature-pct ${pctClass(coin.change_percent)}">${fmtPct(coin.change_percent)}</span></div>
        <div class="cd-feature-sub"><span>${fmtInr(coin.price)}</span><span class="${pctClass(diff)}">${diff >= 0 ? "+" : "-"}$${Math.abs(diff).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(diff) < 1 ? 6 : 2 })}</span></div>
        ${sparkSvg(points, coin.change_percent >= 0)}`;
    });
  }

  function moverItem(coin, right) {
    return `<li data-base="${escapeHtml(coin.base)}"><span class="cd-mover-name">${avatar(coin.base)}<span>${escapeHtml(coin.base)}</span></span><span class="cd-mover-right">${right}</span></li>`;
  }

  function renderMovers() {
    const liquid = coins.filter((c) => c.volume_usdt >= MOVER_MIN_VOLUME_USDT);
    const byChange = liquid.slice().sort((a, b) => b.change_percent - a.change_percent);
    const gainers = byChange.filter((c) => c.change_percent > 0).slice(0, 5);
    const losers = byChange.filter((c) => c.change_percent < 0).reverse().slice(0, 5);
    const priceAndPct = (c) => `${fmtUsd(c.price)}<br><span class="${pctClass(c.change_percent)}">${fmtPct(c.change_percent)}</span>`;
    const empty = '<li class="cd-meta">--</li>';
    el("cdTopGainers").innerHTML = gainers.map((c) => moverItem(c, priceAndPct(c))).join("") || empty;
    el("cdTopLosers").innerHTML = losers.map((c) => moverItem(c, priceAndPct(c))).join("") || empty;
  }

  function renderBreadth() {
    const up = coins.filter((c) => c.change_percent > 0).length;
    const down = coins.filter((c) => c.change_percent < 0).length;
    const total = up + down || 1;
    el("cdBreadthUp").style.width = (up / total) * 100 + "%";
    el("cdBreadthDown").style.width = (down / total) * 100 + "%";
    el("cdBreadthText").innerHTML = `<span class="cd-up">${up} Up</span> · <span class="cd-down">${down} Down</span>`;
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
    renderTicker();
    renderFeatured();
    loadSparks();
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
    return ["dashboard", "watchlist", "positions", "orders", "coin", "scanner", "heatmap", "alerts"].includes(activePanel());
  }

  // Every 3s on the coin pages; every 15s elsewhere (price alerts and limit
  // orders still need prices there). Paused while the tab is hidden.
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (document.visibilityState === "visible") await refresh();
      schedule();
    }, onMarketsPage() ? POLL_MS : 15000);
  }

  // On a phone the sidebar is a sideways-scrolling bottom bar; keep the
  // current page's button visible in it.
  function keepActiveTabInView() {
    const active = document.querySelector("#btcModeRoot .sidebar .app-tab.active");
    const nav = active && active.closest(".nav");
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({ left: active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2, behavior: "smooth" });
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
    // Tapping a coin anywhere (Dashboard, Watchlist, Scanner) opens its coin
    // sheet — price, market depth, range — with Buy / Sell at the bottom.
    const coinEl = event.target.closest("tr[data-base], .cd-key-card[data-base], .cd-mover-list li[data-base], .cd-mini-coin[data-base], .cd-tick[data-base], .cd-feature[data-base]");
    if (coinEl) {
      if (typeof window.cdOpenSheet === "function") window.cdOpenSheet(coinEl.dataset.base);
      else if (typeof window.cdOpenTicket === "function") window.cdOpenTicket(coinEl.dataset.base);
      return;
    }
    // "Start Trading", "View All" and the ticker arrow jump to a page (and
    // the right Scanner filter / Watchlist tab).
    const go = event.target.closest("[data-go]");
    if (go) {
      document.querySelector(`.app-tab[data-tab="${go.dataset.go}"]`)?.click();
      if (go.dataset.scanGo) setTimeout(() => document.querySelector(`#cdScanFilters [data-scan="${go.dataset.scanGo}"]`)?.click(), 0);
      if (go.dataset.go === "watchlist") setTimeout(() => document.querySelector('#cdWatchTabs [data-watch-tab="all"]')?.click(), 0);
      return;
    }
    const watchTab = event.target.closest("#cdWatchTabs [data-watch-tab]");
    if (watchTab) {
      const starred = watchTab.dataset.watchTab === "starred";
      document.querySelectorAll("#cdWatchTabs [data-watch-tab]").forEach((b) => b.classList.toggle("is-active", b === watchTab));
      el("cdAllCoinsCard").hidden = starred;
      el("cdStarredCard").hidden = !starred;
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
      setTimeout(() => {
        syncTopbar();
        keepActiveTabInView();
        if (onMarketsPage()) refresh();
        schedule();
      }, 0);
    }
  });

  el("cdSearch")?.addEventListener("input", () => { shown = PAGE_SIZE; renderAllCoins(); });
  el("cdWatchSearch")?.addEventListener("input", renderWatchlist);
  el("cdShowMore")?.addEventListener("click", () => { shown += PAGE_SIZE; renderAllCoins(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { refresh(); schedule(); } });

  window.cdFormat = { fmtUsd, fmtInr, fmtPct, pctClass, avatar, escapeHtml, fmtVolume, coinRow };
  window.cdToggleWatch = toggleWatch;
  window.cdIsWatched = (base) => watchlist.includes(base);
  window.cdRefreshMarkets = refresh;

  syncTopbar();
  keepActiveTabInView();
  refresh();
  schedule();
})();
