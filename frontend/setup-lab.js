// Setup Lab (owner only): experimental setups next to each other so they can be judged live.
//   Swing+  : the 1H swing rule plus three checks (4H trend agrees, RSI turning, rejection candle colour).
//   Range   : bounce at the edge of a sideways range after a quick dip beyond it, with volume drying up.
// Server: /api/owner/lab (shared 5 minute cache; ?refresh=1 rescans). The same owner check as Focus Radar.
(function setupLab() {
  const overlay = document.getElementById("cdSetupLab");
  const results = document.getElementById("cdLabResults");
  const meta = document.getElementById("cdLabMeta");
  const refreshBtn = document.getElementById("cdLabRefresh");
  if (!overlay || !results || !meta) return;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const F = () => window.cdFormat || {};
  const money = (value) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return "--";
    const digits = v >= 1000 ? 2 : v >= 10 ? 3 : v >= 1 ? 4 : v >= 0.1 ? 5 : 6;
    return "$" + v.toLocaleString("en-US", { maximumFractionDigits: digits });
  };
  const pct = (v, signed) => (Number.isFinite(v) ? (signed && v > 0 ? "+" : "") + v.toFixed(2) + "%" : "--");
  const agoText = (ts) => { const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
  const coinOf = (base) => (window.cdMarkets && window.cdMarkets.coinsByBase ? window.cdMarkets.coinsByBase.get(base) : null);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let tab = "swing";            // 'swing' | 'range'
  let mode = "any";             // swing tab: 'any' (all setups, most checks first) | 'strict' (all 3 checks)
  let tf = "4H";                // range tab: '4H' (multi-day swing) | '1H'
  let dirFilter = "all";        // all | bullish | bearish
  const FILTER_LABEL = { all: "All", bullish: "Bull", bearish: "Bear" };
  let data = null;
  let error = "";
  let scanning = false;
  let loadedAt = 0;
  const STALE_MS = 90 * 1000;

  // ---------- network ----------
  async function token() {
    const until = Date.now() + 6000;
    for (;;) {
      try {
        const { data: session } = await window.marketDockSupabase.auth.getSession();
        const t = session?.session?.access_token;
        if (t) return t;
      } catch (e) { /* the login client may not exist yet */ }
      if (Date.now() >= until) throw new Error("Please sign in to access Setup Lab.");
      await sleep(400);
    }
  }
  async function fetchLab(fresh) {
    const bearer = await token();
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch("/api/owner/lab" + (fresh ? "?refresh=1" : ""), { headers: { Authorization: `Bearer ${bearer}` }, cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (response.ok) return body;
        const err = new Error(body.detail || "Setup Lab is unavailable."); err.status = response.status;
        if (response.status < 500) throw err;
        last = err;
      } catch (e) {
        if (e.status && e.status < 500) throw e;
        last = e;
      }
      if (attempt < 2) await sleep(1500 * (attempt + 1));
    }
    throw last || new Error("Setup Lab is unavailable.");
  }

  // ---------- small building blocks ----------
  function spark(values, up) {
    if (!Array.isArray(values) || values.length < 2) return "";
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(30 - ((v - lo) / span) * 28 - 1).toFixed(1)}`).join(" ");
    return `<svg class="cd-fr-spark ${up ? "is-up" : "is-down"}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  function step(title, sub, state) { // state: ok | live | wait
    const mark = state === "ok" ? "✓" : state === "live" ? "⚡" : "⏳";
    return `<div class="cd-fr-step is-${state}"><b>${title}</b><i>${mark}</i><small>${sub}</small></div>`;
  }
  function star(base) {
    const on = typeof window.cdIsWatched === "function" && window.cdIsWatched(base);
    return `<button type="button" class="cd-fr-star${on ? " is-on" : ""}" data-lab-star="${esc(base)}" aria-label="Watchlist">${on ? "★" : "☆"}</button>`;
  }
  function head(item, up) {
    const coin = coinOf(item.base);
    const price = coin && Number.isFinite(coin.price) ? coin.price : Number(item.price);
    const change = coin ? Number(coin.change_percent) : Number(item.change_percent) || 0;
    const rank = window.cdVolumeRank ? window.cdVolumeRank(item.base) : null;
    return `<div class="cd-fr-head">
      <span class="cd-fr-avatar">${F().avatar ? F().avatar(item.base) : ""}</span>
      <div class="cd-fr-id"><strong>${esc(item.base)}<span>/USDT</span></strong><small>${rank ? `#${rank.rank} by volume` : "1H setup"}</small></div>
      ${spark(item.spark, up)}
      <div class="cd-fr-px"><b>${money(price)}</b><small class="${change >= 0 ? "cd-up" : "cd-down"}">${pct(change, true)}</small></div>
      ${star(item.base)}
    </div>`;
  }
  function levels(item) {
    const g = (v) => Math.abs(Number(v) - item.entry) / item.entry * 100;
    return `<div class="cd-fr-levels">
      <div><span>Entry</span><b>${money(item.entry)}</b><em></em></div>
      <div><span>SL</span><b class="cd-down">${money(item.stop)}</b><em class="cd-down">(−${g(item.stop).toFixed(1)}%)</em></div>
      <div><span>Target 1</span><b>${money(item.t1)}</b><em class="cd-up">(+${g(item.t1).toFixed(1)}%)</em></div>
      <div><span>Target 2</span><b>${money(item.t2)}</b><em class="cd-up">(+${g(item.t2).toFixed(1)}%)</em></div>
    </div>`;
  }
  function actions(item, bull) {
    return `<div class="cd-fr-actions">
      <button type="button" class="cd-fr-ticket ${bull ? "is-buy" : "is-sell"}" data-lab-ticket="${esc(item.base)}" data-lab-side="${bull ? "BUY" : "SELL"}" data-lab-stop="${esc(item.stop)}" data-lab-target="${esc(item.t1)}">⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button>
      <button type="button" class="cd-fr-analysis" data-lab-coin="${esc(item.base)}">📊 Analysis</button>
    </div>`;
  }
  // Does this setup go with BTC's 1H trend?
  function marketLine(item) {
    const trend = data && data.btc ? data.btc.trend : "flat";
    const bull = item.side === "bullish";
    const label = trend === "up" ? "Uptrend" : trend === "down" ? "Downtrend" : "Sideways";
    const verdict = trend === "flat" ? "neutral" : (trend === "up") === bull ? "with the market ✓" : "against the market";
    return `<small class="cd-fr-ema"><i>BTC 1H</i> <b>${label}</b> · ${verdict}</small>`;
  }
  const stateText = (item, bull) => item.state === "triggered" ? `Entry live` : `${bull ? "Above" : "Below"} ${money(item.entry)}`;

  // ---------- cards ----------
  function swingCard(item) {
    const bull = item.side === "bullish";
    const c = item.checks;
    const passes = (c.h4 ? 1 : 0) + (c.rsi ? 1 : 0) + (c.candle ? 1 : 0);
    const steps = [
      step("4H trend", c.h4 ? "Agrees" : "Against", c.h4 ? "ok" : "wait"),
      step("RSI turning", Number.isFinite(c.rsi_now) ? `RSI ${c.rsi_now}` : "--", c.rsi ? "ok" : "wait"),
      step("Candle", c.candle ? (bull ? "Green" : "Red") : (bull ? "Not green" : "Not red"), c.candle ? "ok" : "wait"),
    ].join("");
    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item, bull)}
      <div class="cd-fr-tags"><span class="cd-fr-pill">${bull ? "↗ BULLISH PULLBACK · LONG" : "↘ BEARISH PULLBACK · SHORT"}</span><span class="cd-fr-tag">${passes}/3 CHECKS</span></div>
      <div class="cd-fr-steps cd-fr-steps-wide">${steps}</div>
      ${levels(item)}
      <small class="cd-fr-ema"><i>EMA 20</i> <b>${money(item.ema20)}</b> · <i>EMA 50</i> <b>${money(item.ema50)}</b> · ${stateText(item, bull)}</small>
      <small class="cd-fr-ema"><i>${bull ? "Bullish" : "Bearish"} engulfing</i> <b>${c.engulf ? "yes ✓" : "no"}</b> · ${marketLine(item).replace(/<\/?small[^>]*>/g, "")}</small>
      ${actions(item, bull)}
    </article>`;
  }
  function rangeCard(item) {
    const bull = item.side === "bullish";
    const steps = [
      step("Range", `${Number(item.width_pct).toFixed(1)}% wide`, "ok"),
      step(bull ? "Support bounce" : "Resistance bounce", bull ? "Dip, then back up" : "Spike, then back down", "ok"),
      step("Volume", `${Number(item.volume_ratio).toFixed(2)}× of before${item.vol_dry ? " · dry" : ""}`, item.vol_dry ? "ok" : "wait"),
    ].join("");
    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item, bull)}
      <div class="cd-fr-tags"><span class="cd-fr-pill">${bull ? "↗ BOUNCE FROM SUPPORT · LONG" : "↘ REJECT AT RESISTANCE · SHORT"}</span><span class="cd-fr-tag">${esc(item.timeframe)} RANGE${item.tested_twice ? " · TESTED 2×" : ""}</span></div>
      <div class="cd-fr-steps cd-fr-steps-wide">${steps}</div>
      ${levels(item)}
      <small class="cd-fr-ema"><i>Support</i> <b>${money(item.support)}</b> · <i>Resistance</i> <b>${money(item.resistance)}</b> · ${stateText(item, bull)}</small>
      ${marketLine(item)}
      ${actions(item, bull)}
    </article>`;
  }

  // ---------- page ----------
  function summary() {
    const trend = data.btc ? data.btc.trend : "flat";
    const label = trend === "up" ? "Uptrend" : trend === "down" ? "Downtrend" : "Sideways";
    const dot = trend === "up" ? "is-up" : trend === "down" ? "is-down" : "";
    return `<div class="cd-fr-summary"><svg class="cd-fr-radar" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="27"/><circle cx="30" cy="30" r="18"/><circle cx="30" cy="30" r="9"/><path d="M30 30 L52 14" /></svg>
      <div><b>Scanning ${Number(data.scanned) || 0} coins</b><small>Updated ${agoText(data.at)}</small></div>
      <div class="cd-fr-ticks"><div><span><i class="${dot}"></i>BTC 1H</span> <b>${label}</b></div></div></div>`;
  }
  const EMPTY = {
    swing: ["No Swing+ setup right now", "No 1H swing setup is open right now (ready or triggered). New ones appear when a coin in an uptrend or downtrend pulls back to its EMA zone and a rejection candle forms."],
    range: ["No range bounce right now", "No coin is moving sideways between a clear support and resistance and bouncing back from an edge. Try the other timeframe."],
  };
  function render() {
    document.querySelectorAll("#cdLabTabs button").forEach((b) => b.classList.toggle("is-active", b.dataset.labTab === tab));
    const modeRow = document.getElementById("cdLabMode");
    if (modeRow) {
      modeRow.hidden = tab !== "swing";
      modeRow.querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b.dataset.labMode === mode));
    }
    const swingAll = data ? data.swing || [] : [];
    const swingList = swingAll.filter((r) => mode === "any" || (r.checks.h4 && r.checks.rsi && r.checks.candle));
    const rangeAll = data ? data.range || [] : [];
    const rangeList = rangeAll.filter((r) => r.timeframe === tf);
    const sb = document.querySelector('#cdLabTabs [data-lab-tab="swing"]'), rb = document.querySelector('#cdLabTabs [data-lab-tab="range"]');
    if (sb) sb.textContent = `Swing+${data ? ` (${swingList.length})` : ""}`;
    if (rb) rb.textContent = `Range${data ? ` (${rangeList.length})` : ""}`;
    const tfRow = document.getElementById("cdLabTf");
    if (tfRow) {
      tfRow.hidden = tab !== "range";
      tfRow.querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b.dataset.labTf === tf));
    }
    if (!data) {
      meta.textContent = error ? "Scan unavailable" : "Checking market setup…";
      results.innerHTML = error ? `<p class="cd-focus-error">${esc(error)}</p>` : '<p class="cd-focus-loading">Scanning the top coins… this can take a few seconds.</p>';
      return;
    }
    const list = (tab === "swing" ? swingList : rangeList).filter((r) => dirFilter === "all" || r.side === dirFilter);
    meta.textContent = tab === "swing"
      ? `${swingAll.length} swing setups · ${swingList.length} pass ${mode === "strict" ? "all 3 checks" : "at least one check"}`
      : `${rangeList.length} ${tf} range setups · ${rangeAll.length - rangeList.length} on the other timeframe · never backtested`;
    const note = tab === "swing"
      ? '<p class="cd-fr-note">Swing+ = the normal 1H swing rule plus three checks: the 4H trend agrees, RSI turned back from 45 (long) / 55 (short) and the rejection candle is green (long) / red (short). Setups with the most checks come first. A 90-day backtest found that these checks, alone or together, did not give a consistent improvement, so treat this as an experiment to watch, not a proven edge.</p>'
      : '<p class="cd-fr-note">Range bounce = a coin that stayed between a support and a resistance (4H: last 7 days, 3-15% wide; 1H: last 48 hours, 1.5-10% wide) with flat EMAs, whose recent candle reached an edge and closed back inside. Entry is the bounce candle high/low, SL beyond the edge, Target 1 the middle of the range, Target 2 just before the other edge. “Tested 2×” (both edges touched at least twice) and “dry” volume are quality marks, not requirements. This idea has never been backtested.</p>';
    results.innerHTML = summary() + (list.length ? list.map(tab === "swing" ? swingCard : rangeCard).join("") : `<div class="cd-focus-empty"><strong>${EMPTY[tab][0]}</strong><p>${EMPTY[tab][1]}</p></div>`) + note;
  }

  // A browser reload means "give me new data": the first load right after one is a fresh scan too.
  const pageStart = Date.now();
  let freshAfterReload = false;
  try { freshAfterReload = performance.getEntriesByType("navigation")[0]?.type === "reload"; } catch (e) { /* ignore */ }
  async function load(fresh = false) {
    if (scanning) return;
    if (freshAfterReload && Date.now() - pageStart < 20000) fresh = true;
    freshAfterReload = false;
    scanning = true;
    overlay.classList.add("is-loading");
    refreshBtn.disabled = true;
    data = null; error = ""; render();
    try {
      const [body] = await Promise.all([fetchLab(fresh), sleep(800)]);
      data = body;
      loadedAt = Date.now();
    } catch (e) {
      error = e.status === 401 || e.status === 403 ? "Owner session required." : (e.message || "Could not load Setup Lab.");
    }
    refreshBtn.disabled = false;
    overlay.classList.remove("is-loading");
    scanning = false;
    render();
  }

  // ---------- events ----------
  document.getElementById("cdLabTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-lab-tab]");
    if (!button || button.dataset.labTab === tab) return;
    tab = button.dataset.labTab;
    render();
  });
  document.getElementById("cdLabTf")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-lab-tf]");
    if (!button) return;
    tf = button.dataset.labTf;
    render();
  });
  document.getElementById("cdLabMode")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-lab-mode]");
    if (!button) return;
    mode = button.dataset.labMode;
    render();
  });
  const filterBtn = document.getElementById("cdLabFilter");
  filterBtn?.addEventListener("click", () => {
    dirFilter = dirFilter === "all" ? "bullish" : dirFilter === "bullish" ? "bearish" : "all";
    filterBtn.querySelector("span").textContent = FILTER_LABEL[dirFilter];
    render();
  });
  const pageActive = () => overlay.classList.contains("active");
  function ensureLoaded() {
    if (!pageActive() || scanning) return;
    if (!data || Date.now() - loadedAt > STALE_MS) load();
  }
  new MutationObserver(ensureLoaded).observe(overlay, { attributes: true, attributeFilter: ["class"] });
  window.cdOpenSetupLab = function () {
    if (!pageActive()) document.querySelector('.sidebar .app-tab[data-tab="setuplab"]')?.click();
    load();
  };
  refreshBtn?.addEventListener("click", () => load(true));
  results.addEventListener("click", (event) => {
    const starBtn = event.target.closest("[data-lab-star]");
    if (starBtn) { if (window.cdToggleWatch) window.cdToggleWatch(starBtn.dataset.labStar); render(); return; }
    const ticket = event.target.closest("[data-lab-ticket]");
    if (ticket) {
      const stopLoss = Number(ticket.dataset.labStop), target = Number(ticket.dataset.labTarget);
      window.cdOpenTicket?.(ticket.dataset.labTicket, ticket.dataset.labSide, { stopLoss: stopLoss > 0 ? stopLoss : null, target: target > 0 ? target : null });
      return;
    }
    const analysis = event.target.closest("[data-lab-coin]");
    if (analysis) window.cdOpenSheet?.(analysis.dataset.labCoin);
  });
  ensureLoaded(); // restored on a reload
})();
