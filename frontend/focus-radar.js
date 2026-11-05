// Focus Radar (owner only): 1H swing setups (EMA 20/50 pullback) and 1H breakouts for the top coins.
// Rules on closed candles; not a prediction. Server: /api/owner/focus-radar and /swing (shared caches).
(function focusRadar() {
  const overlay = document.getElementById("cdFocusRadar");
  const results = document.getElementById("cdFocusResults");
  const meta = document.getElementById("cdFocusMeta");
  const refreshBtn = document.getElementById("cdFocusRefresh");
  if (!overlay || !results || !meta) return;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const F = () => window.cdFormat || {};
  const money = (value) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return "--";
    const digits = v >= 1000 ? 2 : v >= 10 ? 3 : v >= 1 ? 4 : v >= 0.1 ? 5 : 6;
    return "$" + v.toLocaleString("en-US", { maximumFractionDigits: digits });
  };
  const pct = (v, signed) => (Number.isFinite(v) ? (signed && v > 0 ? "+" : "") + v.toFixed(2) + "%" : "--");
  const coinOf = (base) => (window.cdMarkets && window.cdMarkets.coinsByBase ? window.cdMarkets.coinsByBase.get(base) : null);
  const agoText = (ts) => { const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60)); return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };

  let tab = "swing";
  let dirFilter = "all"; // all | bullish | bearish
  const FILTER_LABEL = { all: "All", bullish: "Bull", bearish: "Bear" };
  const data = { swing: null, breakouts: null };
  const errors = { swing: "", breakouts: "" };

  // After a page reload this can run before the login is restored, so wait a few seconds for the session
  // instead of failing on the first empty answer.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function token() {
    const until = Date.now() + 6000;
    for (;;) {
      try {
        const { data: session } = await window.marketDockSupabase.auth.getSession();
        const t = session?.session?.access_token;
        if (t) return t;
      } catch (e) { /* the login client may not exist yet */ }
      if (Date.now() >= until) throw new Error("Please sign in to access Focus Radar.");
      await sleep(400);
    }
  }
  async function fetchJson(path) {
    const bearer = await token();
    // A cold server or a flaky connection right after a reload: try again before showing an error.
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(path, { headers: { Authorization: `Bearer ${bearer}` }, cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (response.ok) return body;
        const error = new Error(body.detail || "Focus Radar is unavailable."); error.status = response.status;
        if (response.status < 500) throw error; // 401 / 403 / 4xx are final
        last = error;
      } catch (error) {
        if (error.status && error.status < 500) throw error;
        last = error;
      }
      if (attempt < 2) await sleep(1500 * (attempt + 1));
    }
    throw last || new Error("Focus Radar is unavailable.");
  }

  // ---------- small building blocks ----------
  function spark(values, up) {
    if (!Array.isArray(values) || values.length < 2) return "";
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(30 - ((v - lo) / span) * 28 - 1).toFixed(1)}`).join(" ");
    return `<svg class="cd-fr-spark ${up ? "is-up" : "is-down"}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  function ring(score, label, soft) {
    const has = Number.isFinite(score);
    return `<div class="cd-fr-ring${soft ? " is-soft" : ""}" style="--s:${has ? score : 0}"><div><b>${has ? score + "%" : "--"}</b><small>${label}</small></div></div>`;
  }
  function step(n, title, sub, state) { // state: ok | live | wait
    const mark = state === "ok" ? "✓" : state === "live" ? "⚡" : "⏳";
    return `<div class="cd-fr-step is-${state}"><b>${title}</b><i>${mark}</i><small>${sub}</small></div>`;
  }
  function star(base) {
    const on = typeof window.cdIsWatched === "function" && window.cdIsWatched(base);
    return `<button type="button" class="cd-fr-star${on ? " is-on" : ""}" data-fr-star="${esc(base)}" aria-label="Watchlist">${on ? "★" : "☆"}</button>`;
  }
  function head(item, price, change, sparkData, up) {
    const rank = window.cdVolumeRank ? window.cdVolumeRank(item.base) : null;
    return `<div class="cd-fr-head">
      <span class="cd-fr-avatar">${F().avatar ? F().avatar(item.base) : ""}</span>
      <div class="cd-fr-id"><strong>${esc(item.base)}<span>/USDT</span></strong><small>${rank ? `#${rank.rank} by volume` : "1H setup"}</small></div>
      ${spark(sparkData, up)}
      <div class="cd-fr-px"><b>${money(price)}</b><small class="${change >= 0 ? "cd-up" : "cd-down"}">${pct(change, true)}</small></div>
      ${star(item.base)}
    </div>`;
  }
  function actions(item, bull) {
    return `<div class="cd-fr-actions">
      <button type="button" class="cd-fr-ticket ${bull ? "is-buy" : "is-sell"}" data-fr-ticket="${esc(item.base)}" data-fr-side="${bull ? "BUY" : "SELL"}"${Number(item.stop) > 0 ? ` data-fr-stop="${esc(item.stop)}"` : ""}${Number(item.t1) > 0 ? ` data-fr-target="${esc(item.t1)}"` : ""}>⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button>
      <button type="button" class="cd-fr-analysis" data-focus-coin="${esc(item.base)}">📊 Analysis</button>
    </div>`;
  }

  // ---------- swing setups ----------
  // The market feed's live price drops setups that are already stopped out or past target 2
  // and moves "Ready" to "Triggered" once the trigger is crossed.
  function adjustSwing(item) {
    const coin = coinOf(item.base);
    const price = coin && Number.isFinite(coin.price) ? coin.price : Number(item.price);
    const out = { ...item, price, change_percent: coin ? coin.change_percent : item.change_percent };
    if (item.state === "zone") return out;
    const long = item.side === "bullish";
    if (long ? price < item.stop || price >= item.t2 : price > item.stop || price <= item.t2) return null;
    if (item.state === "ready" && (long ? price > item.entry : price < item.entry)) out.state = "triggered";
    if (out.state === "triggered" && (long ? price >= item.t1 : price <= item.t1)) out.state = "target1";
    return out;
  }
  function swingCard(item) {
    const bull = item.side === "bullish";
    const zone = item.state === "zone";
    const change = Number(item.change_percent) || 0;
    const s3 = item.state === "triggered" ? ["Trigger", `Active · ${bull ? "long" : "short"} entry live`, "live"]
      : item.state === "target1" ? ["Trigger", "Target 1 hit", "ok"]
      : item.state === "ready" ? ["Trigger", `${bull ? "Above " : "Below "}${money(item.entry)}`, "wait"]
      : ["Trigger", "After the rejection candle", "wait"];
    const steps = [
      step(1, bull ? "Uptrend" : "Downtrend", `EMA 20 ${bull ? "above" : "below"} 50`, "ok"),
      step(2, "EMA Retest", zone ? "In zone · waiting for rejection" : `Rejection ${agoText(item.rejection_at)}`, zone ? "wait" : "ok"),
      step(3, s3[0], s3[1], s3[2]),
    ].join("");
    let levels = "";
    if (!zone) {
      const risk = Math.abs(item.entry - item.stop) / item.entry * 100;
      const g1 = Math.abs(item.t1 - item.entry) / item.entry * 100, g2 = Math.abs(item.t2 - item.entry) / item.entry * 100;
      levels = `<div class="cd-fr-levels">
        <div><span>Entry</span><b>${money(item.entry)}</b><em></em></div>
        <div><span>SL</span><b class="cd-down">${money(item.stop)}</b><em class="cd-down">(−${risk.toFixed(1)}%)</em></div>
        <div><span>Target 1</span><b>${money(item.t1)}</b><em class="cd-up">(+${g1.toFixed(1)}%)</em></div>
        <div><span>Target 2</span><b>${money(item.t2)}</b><em class="cd-up">(+${g2.toFixed(1)}%)</em></div>
      </div>`;
    }
    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item, item.price, change, item.spark, bull ? true : false)}
      <div class="cd-fr-tags"><span class="cd-fr-pill">${bull ? "↗ BULLISH PULLBACK · LONG" : "↘ BEARISH PULLBACK · SHORT"}</span><span class="cd-fr-tag">1H SETUP</span></div>
      <div class="cd-fr-mid">${ring(zone ? Math.round(0.4 * item.trend_score) : item.score, "Score", zone)}<div class="cd-fr-steps">${steps}</div></div>
      ${levels}
      <small class="cd-fr-ema"><i>EMA 20</i> <b>${money(item.ema20)}</b> · <i>EMA 50</i> <b>${money(item.ema50)}</b></small>
      ${actions(item, bull)}
    </article>`;
  }

  // ---------- breakouts ----------
  function breakoutCard(item) {
    const bull = item.direction === "BULLISH";
    const coin = coinOf(item.base);
    const price = coin && Number.isFinite(coin.price) ? coin.price : Number(item.price);
    const change = coin ? Number(coin.change_percent) : Number(item.change_percent) || 0;
    const steps = [
      step(1, bull ? "Uptrend" : "Downtrend", `EMA 20 ${bull ? "above" : "below"} 50`, "ok"),
      step(2, "Breakout", `${bull ? "Above" : "Below"} ${money(item.break_level)}`, "ok"),
      step(3, "Volume", `${Number(item.volume_ratio).toFixed(2)}× avg`, "live"),
    ].join("");
    const risk = Math.abs(item.entry - item.stop) / item.entry * 100;
    const g1 = Math.abs(item.t1 - item.entry) / item.entry * 100, g2 = Math.abs(item.t2 - item.entry) / item.entry * 100;
    const tag = item.state === "triggered" ? "ENTRY LIVE" : item.state === "target1" ? "TARGET 1 HIT" : "WAIT FOR ENTRY";
    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item, price, change, null, bull)}
      <div class="cd-fr-tags"><span class="cd-fr-pill">${bull ? "↗ BULLISH BREAKOUT · LONG" : "↘ BEARISH BREAKDOWN · SHORT"}</span><span class="cd-fr-tag">${tag}</span></div>
      <div class="cd-fr-steps cd-fr-steps-wide">${steps}</div>
      <div class="cd-fr-levels">
        <div><span>Entry</span><b>${money(item.entry)}</b><em></em></div>
        <div><span>SL</span><b class="cd-down">${money(item.stop)}</b><em class="cd-down">(−${risk.toFixed(1)}%)</em></div>
        <div><span>Target 1</span><b>${money(item.t1)}</b><em class="cd-up">(+${g1.toFixed(1)}%)</em></div>
        <div><span>Target 2</span><b>${money(item.t2)}</b><em class="cd-up">(+${g2.toFixed(1)}%)</em></div>
      </div>
      <small class="cd-fr-ema"><i>EMA 20</i> <b>${money(item.ema20)}</b> · <i>RSI</i> <b>${Number(item.rsi).toFixed(0)}</b></small>
      ${actions(item, bull)}
    </article>`;
  }

  // ---------- render ----------
  const EMPTY = {
    swing: ["No swing setup right now", "No top coin is in a 1H EMA 20/50 pullback. That is normal; check again later."],
    breakouts: ["No qualifying setups right now", "Wait for a confirmed 1-hour breakout or breakdown from a tight base, with volume, trend and a healthy RSI. Strict filters mean few signals; that is normal."],
  };
  function summary() {
    const btc = coinOf("BTC"), eth = coinOf("ETH");
    const all = window.cdMarkets && window.cdMarkets.coins ? window.cdMarkets.coins.filter((c) => Number.isFinite(Number(c.change_percent))) : [];
    const avg = all.length ? all.reduce((t, c) => t + Number(c.change_percent), 0) / all.length : null;
    const allRow = avg === null ? "" : `<div><span><i class="${avg >= 0 ? "is-up" : "is-down"}"></i>ALL</span> <b class="${avg >= 0 ? "cd-up" : "cd-down"}">${pct(avg, true)}</b></div>`;
    const row = (name, c) => (c ? `<div><span><i class="${c.change_percent >= 0 ? "is-up" : "is-down"}"></i>${name}</span> <b class="${c.change_percent >= 0 ? "cd-up" : "cd-down"}">${pct(Number(c.change_percent), true)}</b></div>` : "");
    const scanned = (data.swing && data.swing.scanned) || (data.breakouts && data.breakouts.scanned) || 0;
    return `<div class="cd-fr-summary"><svg class="cd-fr-radar" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="27"/><circle cx="30" cy="30" r="18"/><circle cx="30" cy="30" r="9"/><path d="M30 30 L52 14" /></svg>
      <div><b>Scanning ${scanned} markets</b><small>${data[tab] && data[tab].at ? "Updated " + agoText(data[tab].at) : "Live market opportunities"}</small></div><div class="cd-fr-ticks">${row("BTC", btc)}${row("ETH", eth)}${allRow}</div></div>`;
  }
  function counts() {
    const sw = data.swing ? data.swing.setups.map(adjustSwing).filter(Boolean).length : null;
    const br = data.breakouts ? (data.breakouts.signals || []).length : null;
    const sb = document.querySelector('#cdFocusTabs [data-focus-tab="swing"]'), bb = document.querySelector('#cdFocusTabs [data-focus-tab="breakouts"]');
    if (sb) sb.textContent = `1H Swings${sw === null ? "" : ` (${sw})`}`;
    if (bb) bb.textContent = `Breakouts${br === null ? "" : ` (${br})`}`;
  }
  function render() {
    counts();
    document.querySelectorAll("#cdFocusTabs button").forEach((b) => b.classList.toggle("is-active", b.dataset.focusTab === tab));
    const body = data[tab];
    if (!body) {
      meta.textContent = errors[tab] ? "Scan unavailable" : "Using closed 1-hour candles";
      results.innerHTML = errors[tab] ? `<p class="cd-focus-error">${esc(errors[tab])}</p>` : '<p class="cd-focus-loading">Scanning the markets… this can take a few seconds.</p>';
      return;
    }
    let cards;
    if (tab === "swing") {
      const rows = body.setups.map(adjustSwing).filter(Boolean);
      const bull = rows.filter((r) => r.side === "bullish").length;
      meta.textContent = `Top ${body.scanned} coins · ${bull} bullish, ${rows.length - bull} bearish`;
      cards = rows.filter((r) => dirFilter === "all" || r.side === dirFilter).map(swingCard);
    } else {
      const rows = body.signals || [];
      meta.textContent = `Scanned ${body.scanned || 0} liquid markets · updated ${new Date((body.updated_at || Date.now() / 1000) * 1000).toLocaleTimeString()}`;
      cards = rows.filter((r) => dirFilter === "all" || r.direction.toLowerCase() === dirFilter).map(breakoutCard);
    }
    const note = tab === "swing"
      ? '<p class="cd-fr-note">Score = trend strength 40% + rejection candle quality 35% + stop tightness 25%. It rates how complete and clean the setup looks, not the chance of winning. A card still waiting in the zone has earned only the trend part, so its score stays low until a rejection candle forms. Trigger only becomes active after that candle forms and price crosses its high (bullish) or low (bearish).</p>'
      : '<p class="cd-fr-note">Breakout rules: 24-candle break on a closed 1H candle with 1.5× volume, EMA 20 above (below) 50, a tight base before it, price and the broken level within 3% of EMA 20, RSI 55-68 for longs (32-45 for shorts) and a close in the top (bottom) quarter of the breakout candle. Entry is the breakout candle high (low), SL sits beyond the base, targets are 2× and 3× the risk. A rule-based filter, not a prediction.</p>';
    results.innerHTML = summary() + (cards.length ? cards.join("") : `<div class="cd-focus-empty"><strong>${EMPTY[tab][0]}</strong><p>${EMPTY[tab][1]}</p></div>`) + note;
  }

  // fresh = the Refresh button / pull down: the server rescans with new candles instead of using its 5-10 minute cache.
  async function loadOne(kind, fresh) {
    try {
      data[kind] = await fetchJson((kind === "swing" ? "/api/owner/focus-radar/swing" : "/api/owner/focus-radar") + (fresh ? "?refresh=1" : ""));
      errors[kind] = "";
    } catch (error) {
      errors[kind] = error.status === 401 || error.status === 403 ? "Owner session required." : (error.message || "Could not load Focus Radar.");
    }
  }
  // While the scan runs, the target and the refresh arrow spin; they stop when the results show.
  // A scan answered from the server cache takes a blink, so the spin lasts at least 0.8 s to be seen.
  let scanning = false;
  // A browser reload (pull down in the browser, F5, the reload button) means "give me new data": the first load
  // right after such a reload is a fresh scan too. (Some browsers reload the page on pull-down even though
  // the page asks them not to.) Opening the page from the menu keeps using the server's short cache.
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
    data.swing = null; data.breakouts = null; render();
    // Both scans in parallel so both tab counts show.
    await Promise.all([loadOne("swing", fresh), loadOne("breakouts", fresh), new Promise((done) => setTimeout(done, 800))]);
    refreshBtn.disabled = false;
    overlay.classList.remove("is-loading");
    scanning = false;
    loadedAt = Date.now();
    render();
  }

  // ---------- events ----------
  document.getElementById("cdFocusTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-focus-tab]");
    if (!button || button.dataset.focusTab === tab) return;
    tab = button.dataset.focusTab;
    render();
  });
  const filterBtn = document.getElementById("cdFocusFilter");
  filterBtn?.addEventListener("click", () => {
    dirFilter = dirFilter === "all" ? "bullish" : dirFilter === "bullish" ? "bearish" : "all";
    filterBtn.querySelector("span").textContent = FILTER_LABEL[dirFilter];
    render();
  });
  const pageActive = () => overlay.classList.contains("active");
  window.addEventListener("cd-markets-updated", () => { if (pageActive() && data[tab]) render(); });
  // A full page like Scanner or Heatmap: Android back closes a coin sheet or ticket first, then
  // leaves this page for the one before it (the app's step-by-step back controller does that).
  function open() {
    if (!pageActive()) document.querySelector('.sidebar .app-tab[data-tab="focusradar"]')?.click();
    load();
  }
  window.cdOpenFocusRadar = open;
  refreshBtn?.addEventListener("click", () => load(true));

  // Whenever the page opens (menu, back, or restored after a reload) load it if there is no fresh result yet.
  let loadedAt = 0;
  const STALE_MS = 90 * 1000;
  function ensureLoaded() {
    if (!pageActive() || scanning) return;
    if (!data.swing || !data.breakouts || Date.now() - loadedAt > STALE_MS) load();
  }
  // Only react when the page is OPENED: the spinner class toggles on this element too, and reacting to that restarted
  // a failed scan again and again.
  let wasActive = pageActive();
  new MutationObserver(() => {
    const now = pageActive();
    if (now && !wasActive) ensureLoaded();
    wasActive = now;
  }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
  ensureLoaded(); // restored on a reload

  // Pull down at the top of the page to refresh (instead of the browser reloading the whole page).
  (function pullToRefresh() {
    const THRESHOLD = 70;
    let startY = null, pulled = 0;
    const hint = document.createElement("div");
    hint.className = "cd-fr-ptr";
    hint.hidden = true;
    overlay.prepend(hint);
    const atTop = () => (document.scrollingElement || document.documentElement).scrollTop <= 0;
    const reset = () => { startY = null; pulled = 0; hint.hidden = true; hint.style.height = "0px"; };
    overlay.addEventListener("touchstart", (e) => { startY = pageActive() && atTop() && !scanning && e.touches.length === 1 ? e.touches[0].clientY : null; pulled = 0; }, { passive: true });
    overlay.addEventListener("touchmove", (e) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || !atTop()) { reset(); return; }
      pulled = dy;
      hint.hidden = false;
      hint.style.height = Math.min(44, dy * 0.5) + "px";
      hint.textContent = dy >= THRESHOLD ? "Release to refresh" : "Pull down to refresh";
    }, { passive: true });
    overlay.addEventListener("touchend", () => { const go = pulled >= THRESHOLD; reset(); if (go) load(true); }, { passive: true });
    overlay.addEventListener("touchcancel", reset, { passive: true });
  })();
  results.addEventListener("click", (event) => {
    const starBtn = event.target.closest("[data-fr-star]");
    if (starBtn) { if (window.cdToggleWatch) window.cdToggleWatch(starBtn.dataset.frStar); render(); return; }
    const ticket = event.target.closest("[data-fr-ticket]");
    if (ticket) {
      // The card's own stop-loss and Target 1 fill the ticket's boxes (they can be edited there).
      const stopLoss = Number(ticket.dataset.frStop), target = Number(ticket.dataset.frTarget);
      window.cdOpenTicket?.(ticket.dataset.frTicket, ticket.dataset.frSide, { stopLoss: stopLoss > 0 ? stopLoss : null, target: target > 0 ? target : null });
      return;
    }
    const button = event.target.closest("[data-focus-coin]");
    if (!button) return;
    window.cdOpenSheet?.(button.dataset.focusCoin);
  });
})();
