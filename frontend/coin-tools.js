// Coin Detail (performance, momentum, range, RRG and paper trades for any
// coin + Buy/Sell; the chart opens on TradingView), Scanner (live filters
// across every coin) and Heatmap (24h change of the most traded coins).
// Prices come from markets.js.
(function cryptoCoinTools() {
  const el = (id) => document.getElementById(id);
  if (!el("cdCoinTitle")) return;

  const F = () => window.cdFormat || {};
  const coins = () => (window.cdMarkets && window.cdMarkets.coins) || [];
  const coinOf = (base) => (window.cdMarkets && window.cdMarkets.coinsByBase ? window.cdMarkets.coinsByBase.get(base) : null);
  const activePanel = () => document.querySelector(".tab-panel.active")?.dataset.panel || "";
  const goTo = (tab) => document.querySelector(`.app-tab[data-tab="${tab}"]`)?.click();
  const money = (v) => "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MIN_VOLUME = 1000000;

  // ---------- Coin Detail ----------
  // No chart here (the chart opens on TradingView): performance, momentum,
  // 24h range, RRG position and this account's paper trades, all from data
  // the app already has or the server already caches.
  const QUICK_COINS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE"];
  const STATS_TTL_MS = 60 * 1000;
  const RRG_TTL_MS = 60 * 1000;
  let coinBase = "BTC";
  try { coinBase = sessionStorage.getItem("cdCoinBase") || "BTC"; } catch (e) { /* ignore */ }
  const statsCache = new Map(); // base -> { at, data }
  let rrg = { at: 0, coins: null, loading: false };
  const esc = (v) => (F().escapeHtml ? F().escapeHtml(String(v ?? "")) : String(v ?? ""));
  const usd = (v) => (F().fmtUsd ? F().fmtUsd(v) : money(v));
  const pct = (v) => (F().fmtPct ? F().fmtPct(v) : (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%");
  const tone = (v) => (v > 0 ? "cd-up" : v < 0 ? "cd-down" : "cd-flat");

  async function loadStats(base) {
    const hit = statsCache.get(base);
    if (hit && (hit.loading || Date.now() - hit.at < STATS_TTL_MS)) return;
    statsCache.set(base, { ...(hit || {}), loading: true });
    try {
      const res = await fetch(`/api/coin/stats?symbol=${encodeURIComponent(base + "USDT")}`, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      statsCache.set(base, { at: Date.now(), data: await res.json() });
    } catch (e) {
      // Keep any older numbers; try again in 15s.
      statsCache.set(base, { ...(hit || {}), at: Date.now() - STATS_TTL_MS + 15000, loading: false });
    }
    if (base === coinBase && activePanel() === "coin") { const coin = coinOf(coinBase); renderPerf(); renderRange(coin); renderStats(coin); }
  }

  async function loadRrg() {
    if (rrg.loading || Date.now() - rrg.at < RRG_TTL_MS) return;
    rrg.loading = true;
    try {
      const res = await fetch("/api/rrg/rotation?tf=1h", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = await res.json();
      rrg = { at: Date.now(), coins: body.coins || [], loading: false };
    } catch (e) {
      rrg = { ...rrg, at: Date.now() - RRG_TTL_MS + 15000, loading: false };
    }
    if (activePanel() === "coin") renderRrg();
  }

  function renderQuick() {
    el("cdCoinQuick").innerHTML = QUICK_COINS.map((b) =>
      `<button type="button" class="cd-pill${b === coinBase ? " is-active" : ""}" data-coin-quick="${b}">${F().avatar ? F().avatar(b) : ""}${b}</button>`).join("");
  }

  function renderHead(coin) {
    const f = F();
    el("cdCoinTitle").textContent = coinBase;
    el("cdCoinAvatar").innerHTML = f.avatar ? f.avatar(coinBase) : "";
    el("cdCoinPrice").textContent = coin ? usd(coin.price) : "$--";
    el("cdCoinInr").textContent = coin && f.fmtInr ? f.fmtInr(coin.price) : "";
    const change = el("cdCoinChange");
    change.textContent = coin ? `${coin.change_percent > 0 ? "▲" : coin.change_percent < 0 ? "▼" : ""} ${pct(coin.change_percent)}` : "";
    change.className = coin ? tone(coin.change_percent) : "";
  }

  function renderPerf() {
    const coin = coinOf(coinBase);
    const perf = statsCache.get(coinBase)?.data?.performance || {};
    const box = (label, v) => {
      const ok = Number.isFinite(v);
      return `<div class="${ok ? (v >= 0 ? "is-up" : "is-down") : ""}"><span>${label}</span><b class="${ok ? tone(v) : ""}">${ok ? pct(v) : "--"}</b></div>`;
    };
    el("cdCoinPerf").innerHTML = box("24 Hours", coin ? coin.change_percent : NaN) +
      box("7 Days", perf.d7 ? perf.d7.change_percent ?? NaN : NaN) +
      box("30 Days", perf.d30 ? perf.d30.change_percent ?? NaN : NaN);
  }

  function rangePos(coin) {
    const span = coin.high - coin.low;
    return span > 0 ? Math.max(0, Math.min(1, (coin.price - coin.low) / span)) : 0.5;
  }

  function renderMomentum(coin) {
    if (!coin || !Number.isFinite(coin.momentum)) { el("cdCoinMom").innerHTML = '<p class="cd-meta">Loading…</p>'; return; }
    const score = coin.momentum;
    const a = Math.PI * (1 - score / 100); // 0 → left, 100 → right
    const nx = 85 + 58 * Math.cos(a), ny = 88 - 58 * Math.sin(a);
    const where = Math.round(rangePos(coin) * 100);
    el("cdCoinMom").innerHTML = `
      <svg class="cd-cdet-gauge" viewBox="0 0 170 100" aria-hidden="true">
        <defs><linearGradient id="cdGaugeGrad" x1="0" x2="1"><stop offset="0" stop-color="#f87171"/><stop offset=".5" stop-color="#fbbf24"/><stop offset="1" stop-color="#34d399"/></linearGradient></defs>
        <path d="M15 88 A70 70 0 0 1 155 88" fill="none" stroke="url(#cdGaugeGrad)" stroke-width="14" stroke-linecap="round"/>
        <line x1="85" y1="88" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>
        <circle cx="85" cy="88" r="6" fill="#fff"/>
      </svg>
      <div>${F().momPill ? F().momPill(coin) : ""}
        <ul><li>24h move: <b class="${tone(coin.change_percent)}">${pct(coin.change_percent)}</b></li><li>Price at ${where}% of today's range</li></ul>
      </div>`;
  }

  // 24H, 7D and 30D: where the price sits between each period's low and high.
  function renderRange(coin) {
    if (!coin) { el("cdCoinRange").innerHTML = ""; el("cdCoinRangeNote").textContent = ""; return; }
    const perf = statsCache.get(coinBase)?.data?.performance || {};
    const row = (label, low, high) => {
      const ok = Number.isFinite(low) && Number.isFinite(high) && high > 0;
      const lo = ok ? Math.min(low, coin.price) : NaN, hi = ok ? Math.max(high, coin.price) : NaN;
      const pos = ok && hi > lo ? (coin.price - lo) / (hi - lo) : 0.5;
      return `<div class="cd-cdet-bar-row"><em>${label}</em><span>${ok ? usd(lo) : "--"}</span><div class="cd-cdet-bar${ok ? "" : " is-empty"}">${ok ? `<i style="left:${(pos * 100).toFixed(1)}%"></i>` : ""}</div><span>${ok ? usd(hi) : "--"}</span></div>`;
    };
    el("cdCoinRangeNote").textContent = `now at ${Math.round(rangePos(coin) * 100)}% of today's range`;
    el("cdCoinRange").innerHTML = row("24H", coin.low, coin.high) +
      row("7D", perf.d7?.low, perf.d7?.high) +
      row("30D", perf.d30?.low, perf.d30?.high);
  }

  // Open, average price, bid / ask (with spread), trades, volume and volume rank.
  function renderStats(coin) {
    const d = statsCache.get(coinBase)?.data;
    const num = (v, digits = 2) => (Number.isFinite(v) ? Number(v).toLocaleString("en-US", { maximumFractionDigits: digits }) : "--");
    const spread = d && d.ask > 0 && d.bid > 0 ? ((d.ask - d.bid) / d.ask) * 100 : NaN;
    const rank = window.cdVolumeRank ? window.cdVolumeRank(coinBase) : null;
    const cell = (label, value, sub = "") => `<div><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    el("cdCoinStats").innerHTML =
      cell("24h Open", d ? usd(d.open) : "--") +
      cell("Avg. price", d ? usd(d.avg_price) : "--", "volume-weighted") +
      cell("Bid / Ask", d ? `${usd(d.bid)}` : "--", d ? `ask ${usd(d.ask)}${Number.isFinite(spread) ? ` · spread ${spread.toFixed(3)}%` : ""}` : "") +
      cell("Trades", d ? num(d.trades, 0) : "--", "in 24h") +
      cell("Volume", coin && F().fmtVolume ? F().fmtVolume(coin.volume_usdt) : "--", d ? `${num(d.volume_base, 2)} ${esc(coinBase)}` : "") +
      cell("Volume rank", rank ? `#${rank.rank}` : "--", rank ? `of ${rank.total} coins` : "");
  }

  function renderStar() {
    const on = window.cdIsWatched ? window.cdIsWatched(coinBase) : false;
    el("cdCoinStar").textContent = on ? "★ In Watchlist" : "☆ Add to Watchlist";
    el("cdCoinStar").classList.toggle("is-active", on);
  }

  const RRG_TEXT = {
    leading: ["Leading", "↗", "Stronger than the market and still gaining strength."],
    weakening: ["Weakening", "↘", "Still stronger than the market, but its momentum is fading."],
    lagging: ["Lagging", "↙", "Weaker than the market and still losing momentum."],
    improving: ["Improving", "↖", "Weaker than the market, but its momentum is picking up."],
  };

  function renderRrg() {
    const box = el("cdCoinRrg");
    if (!rrg.coins) { box.innerHTML = '<p class="cd-meta">Loading…</p>'; return; }
    const c = rrg.coins.find((x) => x.base === coinBase);
    const quad = (q) => `<div class="is-${q}${c && c.quadrant === q ? " is-on" : ""}"></div>`;
    const grid = `<div class="cd-cdet-quad">${quad("improving")}${quad("leading")}${quad("lagging")}${quad("weakening")}</div>`;
    if (!c) {
      box.innerHTML = `${grid}<p class="cd-meta">${esc(coinBase)} is not in the top 20 coins. Add it on the RRG page to see where it stands.<br><button type="button" class="cd-cdet-link" data-coin-go="rrg">Open RRG →</button></p>`;
      return;
    }
    const [name, arrow, text] = RRG_TEXT[c.quadrant] || ["--", "", ""];
    box.innerHTML = `${grid}<p><strong class="is-${c.quadrant}">${name} ${arrow}</strong>${text}<br><span class="cd-meta">RS-Ratio ${Number(c.ratio).toFixed(2)} · RS-Momentum ${Number(c.momentum).toFixed(2)}</span></p>`;
  }

  function renderPaper() {
    const held = typeof window.cdPaperHolding === "function" ? window.cdPaperHolding(coinBase) : null;
    const trades = typeof window.cdPaperTrades === "function" ? window.cdPaperTrades(coinBase, 3) : [];
    const qty = (q) => Number(q).toLocaleString("en-US", { maximumFractionDigits: 6 });
    const when = (ts) => new Date(ts).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    const top = held
      ? `<div class="cd-cdet-hold">
          <div><span>Holding</span><b>${qty(held.qty)} ${esc(coinBase)}</b></div>
          <div><span>Avg. buy price</span><b>${usd(held.avg)}</b></div>
          <div><span>Value now</span><b>${money(held.value)}</b></div>
          <div><span>Profit / Loss</span><b class="${tone(held.pnl)}">${held.pnl >= 0 ? "+" : "-"}${money(Math.abs(held.pnl))} (${held.pct >= 0 ? "+" : ""}${held.pct.toFixed(2)}%)</b></div>
        </div>`
      : "";
    const table = trades.length
      ? `<table class="cd-cdet-trades"><thead><tr><th>Last trades</th><th></th><th class="cd-num">Qty</th><th class="cd-num">Price</th></tr></thead><tbody>${trades.map((t) =>
          `<tr><td>${esc(when(t.at))}</td><td><span class="cd-cdet-side is-${t.side === "BUY" ? "buy" : "sell"}">${t.side}</span></td><td class="cd-num">${qty(t.qty)}</td><td class="cd-num">${usd(t.price)}</td></tr>`).join("")}</tbody></table>`
      : "";
    el("cdCoinPaper").innerHTML = top + table;
    el("cdCoinPaperCard").hidden = !held && !trades.length;
  }

  function renderCoin() {
    const coin = coinOf(coinBase);
    renderQuick();
    renderHead(coin);
    renderPerf();
    renderMomentum(coin);
    renderRange(coin);
    renderStats(coin);
    renderRrg();
    renderPaper();
    renderStar();
    loadStats(coinBase);
    loadRrg();
  }

  function openCoin(base) {
    if (!base) return;
    coinBase = base.toUpperCase();
    try { sessionStorage.setItem("cdCoinBase", coinBase); } catch (e) { /* ignore */ }
    if (activePanel() !== "coin") goTo("coin");
    renderCoin();
  }

  // Shared with the Alerts page's coin field.
  function fillCoinList() {
    const list = el("cdCoinList");
    if (!list || list.childElementCount === coins().length) return;
    list.innerHTML = coins().map((c) => `<option value="${c.base}"></option>`).join("");
  }

  // Search: matches as you type; tap one to open it.
  function suggestions(q) {
    const query = q.trim().toUpperCase().replace(/\/?USDT$/, "");
    if (!query) return [];
    const starts = [], has = [];
    coins().forEach((c) => {
      if (c.base.startsWith(query)) starts.push(c);
      else if (c.base.includes(query)) has.push(c);
    });
    return starts.concat(has).slice(0, 8);
  }

  function renderSuggest() {
    const box = el("cdCoinSuggest");
    const list = suggestions(el("cdCoinSearch").value);
    if (!el("cdCoinSearch").value.trim()) { box.hidden = true; return; }
    box.innerHTML = list.length
      ? list.map((c) => `<button type="button" data-coin-pick="${esc(c.base)}">${F().avatar ? F().avatar(c.base) : ""}<span>${esc(c.base)}<small>/USDT</small></span><em class="${tone(c.change_percent)}">${usd(c.price)} · ${pct(c.change_percent)}</em></button>`).join("")
      : '<p class="cd-meta" style="margin:6px 8px">No coin found.</p>';
    box.hidden = false;
  }

  function pickCoin(base) {
    el("cdCoinSearch").value = "";
    el("cdCoinSuggest").hidden = true;
    el("cdCoinSearch").blur();
    openCoin(base);
    el("cdCoinTitle").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---------- Scanner ----------
  let scan = "gainers";
  const SCANS = {
    gainers: { hint: "Biggest 24h gainers.", run: (l) => l.filter((c) => c.change_percent > 0).sort((a, b) => b.change_percent - a.change_percent) },
    losers: { hint: "Biggest 24h losers.", run: (l) => l.filter((c) => c.change_percent < 0).sort((a, b) => a.change_percent - b.change_percent) },
    volume: { hint: "Most traded coins in the last 24h.", run: (l) => l.slice().sort((a, b) => b.volume_usdt - a.volume_usdt) },
    nearHigh: { hint: "Trading within 2% of their 24h high.", run: (l) => l.filter((c) => c.high > 0 && c.price >= c.high * 0.98).sort((a, b) => b.price / b.high - a.price / a.high) },
    nearLow: { hint: "Trading within 2% of their 24h low.", run: (l) => l.filter((c) => c.low > 0 && c.price <= c.low * 1.02).sort((a, b) => a.price / a.low - b.price / b.low) },
    volatile: { hint: "Widest gap between 24h high and low.", run: (l) => l.filter((c) => c.low > 0).sort((a, b) => (b.high - b.low) / b.low - (a.high - a.low) / a.low) },
  };

  // Every matching coin (not just a top few), re-drawn on each live price
  // update while the Scanner is open.
  function renderScanner() {
    const body = el("cdScanBody");
    if (!body || !F().coinRow) return;
    const liquidOnly = el("cdScanLiquid")?.checked;
    const pool = liquidOnly ? coins().filter((c) => c.volume_usdt >= MIN_VOLUME) : coins();
    const rows = SCANS[scan].run(pool);
    document.querySelectorAll("[data-scan-count]").forEach((node) => {
      const n = SCANS[node.dataset.scanCount].run(pool).length;
      node.textContent = coins().length ? `(${n})` : "";
    });
    const time = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    el("cdScanHint").textContent = coins().length
      ? `${SCANS[scan].hint} ${rows.length} coin${rows.length === 1 ? "" : "s"} · live · updated ${time}`
      : "Loading coins…";
    body.innerHTML = rows.map(F().coinRow).join("") ||
      `<tr><td colspan="7" class="cd-empty">${coins().length ? "Nothing matches right now." : "Loading coins…"}</td></tr>`;
  }

  // ---------- Heatmap ----------
  let heatSize = 100;

  function heatColour(pct) {
    const strength = Math.min(Math.abs(pct) / 8, 1); // full colour at ±8%
    if (Math.abs(pct) < 0.05) return "rgb(71, 85, 105)";
    const [r, g, b] = pct > 0 ? [22, 163, 74] : [220, 38, 38];
    const base = [51, 65, 85];
    const mix = (from, to) => Math.round(from + (to - from) * (0.35 + 0.65 * strength));
    return `rgb(${mix(base[0], r)}, ${mix(base[1], g)}, ${mix(base[2], b)})`;
  }

  function renderHeatmap() {
    const grid = el("cdHeatGrid");
    if (!grid) return;
    const f = F();
    const list = coins().slice(0, heatSize); // already sorted by volume
    grid.innerHTML = list.map((c, i) => `<button type="button" class="cd-heat-tile${i < 6 ? " is-big" : ""}" data-coin="${f.escapeHtml ? f.escapeHtml(c.base) : c.base}" style="background:${heatColour(c.change_percent)}">
        <strong>${f.escapeHtml ? f.escapeHtml(c.base) : c.base}</strong><span>${f.fmtPct ? f.fmtPct(c.change_percent) : ""}</span>
      </button>`).join("") || '<p class="cd-empty">Loading coins…</p>';
  }

  // ---------- events ----------
  function renderActive() {
    const panel = activePanel();
    if (panel === "coin") {
      fillCoinList();
      renderCoin();
    } else if (panel === "scanner") renderScanner();
    else if (panel === "heatmap") renderHeatmap();
  }

  window.addEventListener("cd-markets-updated", renderActive);

  document.addEventListener("click", (event) => {
    const tile = event.target.closest("[data-coin]");
    if (tile) { openCoin(tile.dataset.coin); return; }
    const quick = event.target.closest("[data-coin-quick]");
    if (quick) { openCoin(quick.dataset.coinQuick); return; }
    const pick = event.target.closest("[data-coin-pick]");
    if (pick) { pickCoin(pick.dataset.coinPick); return; }
    const go = event.target.closest("[data-coin-go]");
    if (go) { goTo(go.dataset.coinGo); return; }
    if (!event.target.closest(".cd-cdet-search") && el("cdCoinSuggest")) el("cdCoinSuggest").hidden = true;
    const sc = event.target.closest("#cdScanFilters [data-scan]");
    if (sc) {
      scan = sc.dataset.scan;
      document.querySelectorAll("#cdScanFilters [data-scan]").forEach((b) => b.classList.toggle("is-active", b === sc));
      renderScanner();
      return;
    }
    const hs = event.target.closest("#cdHeatSize [data-heat]");
    if (hs) {
      heatSize = Number(hs.dataset.heat);
      document.querySelectorAll("#cdHeatSize [data-heat]").forEach((b) => b.classList.toggle("is-active", b === hs));
      renderHeatmap();
      return;
    }
    if (event.target.closest(".app-tab")) setTimeout(renderActive, 0);
  });

  el("cdScanLiquid")?.addEventListener("change", renderScanner);
  el("cdCoinSearch").addEventListener("input", renderSuggest);
  el("cdCoinSearch").addEventListener("focus", renderSuggest);
  el("cdCoinSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { const first = suggestions(el("cdCoinSearch").value)[0]; if (first) pickCoin(first.base); }
    else if (event.key === "Escape") el("cdCoinSuggest").hidden = true;
  });
  el("cdCoinStar").addEventListener("click", () => { if (window.cdToggleWatch) { window.cdToggleWatch(coinBase); renderStar(); } });
  el("cdCoinTv").addEventListener("click", () => window.cdOpenTradingView && window.cdOpenTradingView(coinBase));
  el("cdCoinBuy").addEventListener("click", () => window.cdOpenTicket && window.cdOpenTicket(coinBase, "BUY"));
  el("cdCoinSell").addEventListener("click", () => window.cdOpenTicket && window.cdOpenTicket(coinBase, "SELL"));
  el("cdCoinAlert")?.addEventListener("click", () => window.cdNewAlert && window.cdNewAlert(coinBase));

  window.cdOpenCoin = openCoin;
  window.cdFillCoinList = fillCoinList;
  if (activePanel() === "coin") renderCoin();
  // Also when the app reopens straight onto Coin Detail (no click).
  const panel = el("cdCoinTitle").closest(".tab-panel");
  if (panel) new MutationObserver(() => { if (panel.classList.contains("active")) { fillCoinList(); renderCoin(); } })
    .observe(panel, { attributes: true, attributeFilter: ["class"] });
})();
