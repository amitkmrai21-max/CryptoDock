// All-coins Dashboard and Watchlist: every Binance USDT coin with live price
// in $ and ₹, 24h change, top movers and a searchable, sortable table.
// Data comes from /api/markets (cached server-side, so polling every few
// seconds costs Binance one call no matter how many people have it open).
(function cryptoMarkets() {
  const POLL_MS = 3000;
  const POSITIONS_POLL_MS = 2000;
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

  // Watchlist 1–10: coins ranked by 24h volume when the page first gets
  // prices (kept for the visit so coins don't hop between lists), 50 per
  // list; the last list also takes any coins beyond 500.
  const WL_COUNT = 10;
  const WL_SIZE = 50;
  const wlTrack = el("cdWlTrack");
  const rankOf = new Map();
  let wlIndex = 0;
  let wlBuilt = false;
  let wlAllRendered = false;
  let wlScrollingUntil = 0;

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

  // ---------- momentum ----------
  // A 0–100 score like the Indian market's MOMENTUM pill: the 24h change
  // (full weight at ±6%) plus where the price sits in its 24h high–low
  // range. It describes the move so far; it is not a buy/sell signal.
  function momentumOf(coin) {
    const change = Math.max(-6, Math.min(6, Number(coin.change_percent) || 0));
    const span = coin.high - coin.low;
    const rangePos = span > 0 ? Math.max(0, Math.min(1, (coin.price - coin.low) / span)) : 0.5;
    return Math.max(1, Math.min(99, Math.round(50 + (change / 6) * 35 + (rangePos - 0.5) * 30)));
  }

  function momentumLabel(score) {
    return score >= 60 ? "BULLISH" : score <= 40 ? "BEARISH" : "NEUTRAL";
  }

  function addMomentum(list) {
    list.forEach((coin) => {
      coin.momentum = momentumOf(coin);
      coin.momentum_label = momentumLabel(coin.momentum);
    });
  }

  function momPill(coin) {
    const label = coin.momentum_label || "NEUTRAL";
    const tone = label === "BULLISH" ? "is-bull" : label === "BEARISH" ? "is-bear" : "is-neutral";
    return `<span class="cd-mom-pill ${tone}"><span class="cd-mom-txt">${label}</span><b class="cd-mom-bubble">${coin.momentum ?? "--"}</b></span>`;
  }

  // ---------- rendering ----------
  function coinRow(coin) {
    const on = watchlist.includes(coin.base);
    const tone = coin.momentum_label === "BULLISH" ? "cd-row-bull" : coin.momentum_label === "BEARISH" ? "cd-row-bear" : "cd-row-neutral";
    return `<tr class="${tone}" data-base="${escapeHtml(coin.base)}">
      <td><button class="cd-star${on ? " is-on" : ""}" type="button" data-star="${escapeHtml(coin.base)}" aria-label="${on ? "Remove from" : "Add to"} watchlist">${on ? "★" : "☆"}</button></td>
      <td><div class="cd-coin-cell">${avatar(coin.base)}<div><strong>${escapeHtml(coin.base)}</strong><small>/USDT</small></div></div></td>
      <td class="cd-num">${fmtUsd(coin.price)}<span class="cd-sub cd-inr">${fmtInr(coin.price)}</span><span class="cd-sub cd-price-chg ${pctClass(coin.change_percent)}">${coin.change_percent > 0 ? "▲ " : coin.change_percent < 0 ? "▼ " : ""}${fmtPct(coin.change_percent)}</span></td>
      <td class="cd-num cd-col-chg ${pctClass(coin.change_percent)}">${fmtPct(coin.change_percent)}</td>
      <td class="cd-num cd-col-mom">${momPill(coin)}<span class="cd-mom-chg ${pctClass(coin.change_percent)}">${fmtPct(coin.change_percent)}</span></td>
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

  // Ticker strip: the most traded coins, sliding slowly on a loop like the
  // Indian market ticker. The list is drawn twice and the track moves by
  // half its width, so the loop is seamless. The track element stays put
  // between price updates, so the slide never jumps back to the start.
  const TICKER_PX_PER_SEC = 32;
  function renderTicker() {
    const box = el("cdTicker");
    if (!box) return;
    let track = box.querySelector(".cd-ticker-track");
    if (!track) {
      box.innerHTML = '<div class="cd-ticker-track"></div>';
      track = box.firstElementChild;
    }
    const items = coins.slice(0, TICKER_SIZE).map((coin) => `
      <button type="button" class="cd-tick" data-base="${escapeHtml(coin.base)}">
        ${avatar(coin.base)}
        <span class="cd-tick-text"><strong>${escapeHtml(coin.base)}</strong><span>${fmtUsd(coin.price)} <em class="${pctClass(coin.change_percent)}">${fmtPct(coin.change_percent)}</em></span></span>
      </button>`).join("");
    track.innerHTML = items + items.replace(/<button /g, '<button tabindex="-1" aria-hidden="true" ');
    const half = track.scrollWidth / 2;
    if (half > 0) track.style.animationDuration = `${Math.max(12, Math.round(half / TICKER_PX_PER_SEC))}s`;
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
        <div class="cd-feature-top">${avatar(base)}<strong>${base}</strong></div>
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

  function renderMomentumSummary() {
    const box = el("cdMomSummary");
    if (!box || !coins.length) return;
    // Counts for the list on screen (all coins while searching).
    const searching = !!(el("cdSearch")?.value || "").trim();
    const scope = searching ? coins : wlLists()[wlIndex];
    const count = (label) => scope.filter((c) => c.momentum_label === label).length;
    box.innerHTML = `<span class="cd-mom-pill is-bull">Bullish <b>${count("BULLISH")}</b></span>` +
      `<span class="cd-mom-pill is-neutral">Neutral <b>${count("NEUTRAL")}</b></span>` +
      `<span class="cd-mom-pill is-bear">Bearish <b>${count("BEARISH")}</b></span>`;
  }

  // ---------- Watchlist 1–10 (swipe between lists) ----------
  function rankCoins() {
    if (!rankOf.size) {
      coins.slice().sort((a, b) => (b.volume_usdt || 0) - (a.volume_usdt || 0)).forEach((c, i) => rankOf.set(c.base, i));
    }
    coins.forEach((c) => { if (!rankOf.has(c.base)) rankOf.set(c.base, rankOf.size); });
  }

  function wlLists() {
    const ordered = coins.slice().sort((a, b) => rankOf.get(a.base) - rankOf.get(b.base));
    return Array.from({ length: WL_COUNT }, (_, i) =>
      ordered.slice(i * WL_SIZE, i === WL_COUNT - 1 ? ordered.length : (i + 1) * WL_SIZE));
  }

  function buildTrack() {
    if (wlBuilt || !wlTrack) return;
    const head = dashBody.closest("table").querySelector("thead").outerHTML;
    wlTrack.innerHTML = Array.from({ length: WL_COUNT }, (_, i) => `
      <div class="cd-wl-slide" data-wl-slide="${i}">
        <div class="cd-table-wrap"><table class="cd-table cd-watch-table">${head}<tbody data-wl-body="${i}">
          <tr><td colspan="7" class="cd-empty">Loading coins…</td></tr></tbody></table></div>
      </div>`).join("");
    wlBuilt = true;
    let ticking = false;
    wlTrack.addEventListener("scroll", () => {
      wlScrollingUntil = Date.now() + 250;
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const width = wlTrack.clientWidth;
        if (!width) return;
        const next = Math.max(0, Math.min(WL_COUNT - 1, Math.round(wlTrack.scrollLeft / width)));
        if (next !== wlIndex) {
          wlIndex = next;
          syncWlHeader();
          renderWlSlides();
        }
      });
    }, { passive: true });
  }

  function renderWlSlides(all) {
    if (!wlTrack || !coins.length) return;
    const lists = wlLists();
    const from = all || !wlAllRendered ? 0 : Math.max(0, wlIndex - 1);
    const to = all || !wlAllRendered ? WL_COUNT - 1 : Math.min(WL_COUNT - 1, wlIndex + 1);
    for (let i = from; i <= to; i++) {
      const body = wlTrack.querySelector(`[data-wl-body="${i}"]`);
      if (body) body.innerHTML = sortedCoins(lists[i]).map(coinRow).join("") ||
        '<tr><td colspan="7" class="cd-empty">No coins in this list yet.</td></tr>';
    }
    wlAllRendered = true;
    syncWlHeader(lists);
  }

  function syncWlHeader(lists) {
    const searching = !!(el("cdSearch")?.value || "").trim();
    if (!searching) {
      el("cdWlTitle").textContent = `Watchlist ${wlIndex + 1}`;
      el("cdCoinCount").textContent = coins.length ? `(${(lists || wlLists())[wlIndex].length})` : "";
    }
    renderMomentumSummary();
    const tabs = el("cdWatchTabs");
    if (!tabs || !el("cdStarredCard").hidden) return;
    let active = null;
    tabs.querySelectorAll("[data-watch-tab]").forEach((b) => {
      const on = b.dataset.wl !== undefined && Number(b.dataset.wl) === wlIndex;
      b.classList.toggle("is-active", on);
      if (on) active = b;
    });
    if (active && tabs.scrollWidth > tabs.clientWidth) {
      tabs.scrollTo({ left: active.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2, behavior: "smooth" });
    }
  }

  function goToList(index, smooth) {
    if (!wlTrack) return;
    wlIndex = Math.max(0, Math.min(WL_COUNT - 1, index));
    const left = wlIndex * wlTrack.clientWidth;
    if (smooth) wlTrack.scrollTo({ left, behavior: "smooth" });
    else wlTrack.scrollLeft = left;
    renderWlSlides();
  }

  function renderAllCoins() {
    const query = (el("cdSearch")?.value || "").trim().toUpperCase();
    // Searching looks through every coin in one list; otherwise the
    // swipeable Watchlist 1–10.
    el("cdSearchWrap").hidden = !query;
    if (wlTrack) wlTrack.hidden = !!query;
    const more = el("cdShowMore");
    if (!query) {
      if (more) more.hidden = true;
      buildTrack();
      // Don't redraw rows under a finger mid-swipe; the next poll will.
      if (Date.now() > wlScrollingUntil || !wlAllRendered) renderWlSlides();
    } else {
      const list = sortedCoins(coins.filter((c) => matches(c, query)));
      dashBody.innerHTML = list.slice(0, shown).map(coinRow).join("") ||
        `<tr><td colspan="7" class="cd-empty">${coins.length ? "No coin matches your search." : "Loading coins…"}</td></tr>`;
      el("cdWlTitle").textContent = "Search";
      el("cdCoinCount").textContent = coins.length ? `(${list.length})` : "";
      renderMomentumSummary();
      if (more) {
        more.hidden = list.length <= shown;
        more.textContent = `Show more (${Math.max(0, list.length - shown)} left)`;
      }
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
      // The Live marker on the header line already shows the feed state; only say
      // something here when these prices have stopped updating.
      const stale = lastOkAt && Date.now() - lastOkAt > POLL_MS * 4 ? " · Reconnecting…" : "";
      meta.textContent = `${coins.length} coins · 1 USDT = ${usdtInr ? "₹" + usdtInr.toFixed(2) : "₹--"}${stale}`;
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
        addMomentum(coins);
        rankCoins();
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

  // Every 2s on Positions (live P&L), 3s on the other coin pages, 15s
  // elsewhere (price alerts and limit orders still need prices there).
  // Paused while the tab is hidden. The server refreshes prices every 2s
  // for everyone at once, so this never adds Binance calls.
  function schedule() {
    clearTimeout(pollTimer);
    const delay = activePanel() === "positions" ? POSITIONS_POLL_MS : onMarketsPage() ? POLL_MS : 15000;
    pollTimer = setTimeout(async () => {
      if (document.visibilityState === "visible") await refresh();
      schedule();
    }, delay);
  }

  // On a phone the sidebar is a sideways-scrolling bottom bar; keep the
  // current page's button visible in it.
  function keepActiveTabInView() {
    const active = document.querySelector("#btcModeRoot .sidebar .app-tab.active");
    const nav = active && active.closest(".nav");
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({ left: active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2, behavior: "smooth" });
  }

  // The old "Refresh Technical" bar stays hidden: the Technical page refreshes
  // itself in the background, like every other page.
  function syncTopbar() {
    const bar = document.querySelector(".btc-topbar");
    if (bar) bar.hidden = true;
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
      // Scanner rows show the coin's market stats rather than Buy / Sell.
      if (coinEl.closest("#cdScanBody") && typeof window.cdOpenStats === "function") window.cdOpenStats(coinEl.dataset.base);
      else if (typeof window.cdOpenSheet === "function") window.cdOpenSheet(coinEl.dataset.base);
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
      const wasHidden = el("cdAllCoinsCard").hidden;
      document.querySelectorAll("#cdWatchTabs [data-watch-tab]").forEach((b) => b.classList.toggle("is-active", b === watchTab));
      el("cdAllCoinsCard").hidden = starred;
      el("cdStarredCard").hidden = !starred;
      if (!starred) {
        // Picking a list ends a search; slide to it (or jump straight
        // there when the lists weren't on screen).
        const search = el("cdSearch");
        const wasSearching = !!(search && search.value.trim());
        if (wasSearching) { search.value = ""; renderAllCoins(); }
        goToList(Number(watchTab.dataset.wl || 0), !wasHidden && !wasSearching);
      }
      return;
    }
    const th = event.target.closest(".cd-table th[data-sort]");
    if (th && el("cdAllCoinsCard").contains(th)) {
      const key = th.dataset.sort;
      sortDir = key === sortKey ? -sortDir : key === "base" ? 1 : -1;
      sortKey = key;
      wlAllRendered = false;
      renderAllCoins();
      return;
    }
    if (event.target.closest(".app-tab")) {
      setTimeout(() => {
        syncTopbar();
        keepActiveTabInView();
        // Back on Watchlist: the track forgets its scroll while hidden.
        if (activePanel() === "watchlist" && wlTrack && wlTrack.clientWidth) wlTrack.scrollLeft = wlIndex * wlTrack.clientWidth;
        if (onMarketsPage()) refresh();
        schedule();
      }, 0);
    }
  });

  el("cdSearch")?.addEventListener("input", () => {
    shown = PAGE_SIZE;
    renderAllCoins();
    if (!el("cdSearch").value.trim()) goToList(wlIndex, false);
  });
  window.addEventListener("resize", () => { if (wlTrack && wlTrack.clientWidth) wlTrack.scrollLeft = wlIndex * wlTrack.clientWidth; });
  el("cdWatchSearch")?.addEventListener("input", renderWatchlist);
  el("cdShowMore")?.addEventListener("click", () => { shown += PAGE_SIZE; renderAllCoins(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { refresh(); schedule(); } });

  window.cdFormat = { fmtUsd, fmtInr, fmtPct, pctClass, avatar, escapeHtml, fmtVolume, coinRow, momPill };
  window.cdToggleWatch = toggleWatch;
  window.cdVolumeRank = (base) => {
    const sorted = coins.slice().sort((a, b) => (b.volume_usdt || 0) - (a.volume_usdt || 0));
    const i = sorted.findIndex((c) => c.base === base);
    return i < 0 ? null : { rank: i + 1, total: sorted.length };
  };
  window.cdIsWatched = (base) => watchlist.includes(base);
  window.cdRefreshMarkets = refresh;

  syncTopbar();
  keepActiveTabInView();
  refresh();
  schedule();
})();
