// Catch Accuracy (owner only): "ADX + SMA" simple swing on the DAILY chart (4 rules).
//   Price above the 200 SMA = longs, below = shorts. ADX above 20, price pulls back to the SMA 50 (within 2%), and a
//   green candle (long) / red candle (short) forms there with volume above its 20-candle average.
//   Shown as five ticks (trend, ADX, pullback, volume, candle); all five = full match.
//   SL 4% beyond the trigger candle, Target 1 = 1:2 (about 8%), Target 2 = 1:3, breakeven at +4%. Risk 1% per trade.
// Server: /api/owner/catch-accuracy (shared 10 minute cache; ?refresh=1 rescans). Same owner check as Focus Radar.
(function catchAccuracy() {
  const overlay = document.getElementById("cdCatchAcc");
  const results = document.getElementById("cdCatchResults");
  const meta = document.getElementById("cdCatchMeta");
  const refreshBtn = document.getElementById("cdCatchRefresh");
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
  const CHECKS = ["trend", "adx", "pullback", "volume", "candle"];

  let tab = "full";             // 'full' (all 5 checks) | 'almost' (4 of 5, at the 50 SMA)
  let data = null;
  let error = "";
  let scanning = false;
  let loadedAt = 0;
  const STALE_MS = 120 * 1000;

  // ---------- network ----------
  async function token() {
    const until = Date.now() + 6000;
    for (;;) {
      try {
        const { data: session } = await window.marketDockSupabase.auth.getSession();
        const t = session?.session?.access_token;
        if (t) return t;
      } catch (e) { /* the login client may not exist yet */ }
      if (Date.now() >= until) throw new Error("Please sign in to access Catch Accuracy.");
      await sleep(400);
    }
  }
  async function fetchScan(fresh) {
    const bearer = await token();
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // A scan that never answers must not leave the page stuck: give up after 40 seconds.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 40000);
        let response;
        try {
          response = await fetch("/api/owner/catch-accuracy" + (fresh ? "?refresh=1" : ""), { headers: { Authorization: `Bearer ${bearer}` }, cache: "no-store", signal: controller.signal });
        } finally { clearTimeout(timer); }
        const body = await response.json().catch(() => ({}));
        if (response.ok) return body;
        const err = new Error(body.detail || "Catch Accuracy is unavailable."); err.status = response.status;
        if (response.status < 500) throw err;
        last = err;
      } catch (e) {
        if (e.status && e.status < 500) throw e;
        last = e;
      }
      if (attempt < 1) await sleep(1500);
    }
    throw last && last.name === "AbortError" ? new Error("The scan took too long. Tap the refresh arrow to try again.") : (last || new Error("Catch Accuracy is unavailable."));
  }

  // ---------- building blocks ----------
  function spark(values, up) {
    if (!Array.isArray(values) || values.length < 2) return "";
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(30 - ((v - lo) / span) * 28 - 1).toFixed(1)}`).join(" ");
    return `<svg class="cd-fr-spark ${up ? "is-up" : "is-down"}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  function star(base) {
    const on = typeof window.cdIsWatched === "function" && window.cdIsWatched(base);
    return `<button type="button" class="cd-fr-star${on ? " is-on" : ""}" data-catch-star="${esc(base)}" aria-label="Watchlist">${on ? "★" : "☆"}</button>`;
  }
  function head(item) {
    const coin = coinOf(item.base);
    const price = coin && Number.isFinite(coin.price) ? coin.price : Number(item.price);
    const change = coin ? Number(coin.change_percent) : Number(item.change_percent) || 0;
    const rank = window.cdVolumeRank ? window.cdVolumeRank(item.base) : null;
    return `<div class="cd-fr-head">
      <span class="cd-fr-avatar">${F().avatar ? F().avatar(item.base) : ""}</span>
      <div class="cd-fr-id"><strong>${esc(item.base)}<span>/USDT</span></strong><small>${rank ? `#${rank.rank} by volume` : "4H setup"}</small></div>
      ${spark(item.spark, true)}
      <div class="cd-fr-px"><b>${money(price)}</b><small class="${change >= 0 ? "cd-up" : "cd-down"}">${pct(change, true)}</small></div>
      ${star(item.base)}
    </div>`;
  }
  function checkTile(item, key) {
    const bull = item.side === "bullish";
    const ok = !!item.checks[key];
    const dist = Number(item.dist_sma50_pct);
    const T = {
      trend: ["Trend", `${bull ? "Above" : "Below"} SMA 200`],
      adx: ["Strength", Number.isFinite(item.adx) ? `ADX ${item.adx} ${ok ? "(over 20)" : "(need over 20)"}` : "ADX over 20"],
      pullback: ["Pullback", Number.isFinite(dist) ? `${dist > 0 ? "+" : ""}${dist}% from SMA 50` : "At SMA 50"],
      volume: ["Volume", Number.isFinite(item.volume_x) ? `${item.volume_x}× average` : "Over average"],
      candle: ["Trigger candle", ok ? (bull ? "Green close" : "Red close") : (bull ? "Not green yet" : "Not red yet")],
    }[key];
    return `<div class="cd-fr-step is-${ok ? "ok" : "wait"}"><b>${T[0]}</b><i>${ok ? "✓" : "✗"}</i><small>${T[1]}</small></div>`;
  }
  function levels(item) {
    const g = (v) => Math.abs(Number(v) - item.entry) / item.entry * 100;
    return `<div class="cd-fr-levels">
      <div><span>Entry</span><b>${money(item.entry)}</b><em></em></div>
      <div><span>SL</span><b class="cd-down">${money(item.stop)}</b><em class="cd-down">(−${g(item.stop).toFixed(1)}%)</em></div>
      <div><span>Target 1 · 1:2</span><b>${money(item.t1)}</b><em class="cd-up">(+${g(item.t1).toFixed(1)}%)</em></div>
      <div><span>Target 2 · 1:3</span><b>${money(item.t2)}</b><em class="cd-up">(+${g(item.t2).toFixed(1)}%)</em></div>
    </div>`;
  }
  const MISSING = { trend: "Trend", adx: "ADX over 20", pullback: "Pullback", volume: "Volume", candle: "Trigger candle" };
  function card(item) {
    const bull = item.side === "bullish";
    const full = item.passed >= CHECKS.length;
    const missing = CHECKS.filter((k) => !item.checks[k]).map((k) => MISSING[k]);
    const word = bull ? "LONG" : "SHORT";
    const blocked = !full;
    const why = full ? "" : `Waiting for: ${missing.join(", ")}. Trades open only on a full match.`;
    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item)}
      <div class="cd-fr-tags"><span class="cd-fr-pill">${full ? `✅ FULL MATCH · ${word}` : `⏳ ALMOST · ${word}`}</span><span class="cd-fr-tag">${item.passed}/${CHECKS.length} CHECKS</span></div>
      <div class="cd-fr-steps cd-fr-steps-wide">${CHECKS.map((k) => checkTile(item, k)).join("")}</div>
      ${why ? `<p class="cd-fr-note">${esc(why)}${full ? "" : " The levels below are what the rule would use now."}</p>` : ""}
      ${levels(item)}
      <small class="cd-fr-ema"><i>SMA 50</i> <b>${money(item.sma50)}</b> · <i>SMA 200</i> <b>${money(item.sma200)}</b> · Risk <b>${item.risk_pct}%</b> · Move SL to breakeven at ${money(item.breakeven_at)} (${bull ? "+" : "−"}4%)</small>
      <div class="cd-fr-actions">
        <button type="button" class="cd-fr-ticket ${bull ? "is-buy" : "is-sell"}" ${blocked ? "disabled" : ""} data-catch-ticket="${esc(item.base)}" data-catch-side="${bull ? "BUY" : "SELL"}" data-catch-stop="${esc(item.stop)}" data-catch-target="${esc(item.t1)}">${blocked ? "⏳ Wait for full match" : `⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}`}</button>
        <button type="button" class="cd-fr-analysis" data-catch-coin="${esc(item.base)}">📊 Analysis</button>
      </div>
    </article>`;
  }

  // ---------- page ----------
  function summary() {
    return `<div class="cd-fr-summary"><svg class="cd-fr-radar" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="27"/><circle cx="30" cy="30" r="18"/><circle cx="30" cy="30" r="9"/><path d="M30 30 L52 14" /></svg>
      <div><b>Scanning ${Number(data.scanned) || 0} coins</b><small>Updated ${agoText(data.at)} · daily candles</small></div>
      <div class="cd-fr-ticks"><div><span><i class="is-up"></i>Daily</span> <b>SMA 50 / 200</b></div></div></div>`;
  }
  const EMPTY = {
    full: ["No full match right now", "No coin passes all 5 checks at the moment: a trend (ADX over 20), a pullback to the 50 SMA, and a green / red candle there with above-average volume. Check the “Almost” tab for coins sitting at the 50 SMA."],
    almost: ["Nothing is close right now", "No coin is sitting at its 50 SMA with 4 of 5 checks right now."],
  };
  function render() {
    document.querySelectorAll("#cdCatchTabs button").forEach((b) => b.classList.toggle("is-active", b.dataset.catchTab === tab));
    const fullList = data ? data.full || [] : [], almostList = data ? data.almost || [] : [];
    const fb = document.querySelector('#cdCatchTabs [data-catch-tab="full"]'), ab = document.querySelector('#cdCatchTabs [data-catch-tab="almost"]');
    if (fb) fb.textContent = `Full match${data ? ` (${fullList.length})` : ""}`;
    if (ab) ab.textContent = `Almost${data ? ` (${almostList.length})` : ""}`;
    if (!data) {
      meta.textContent = error ? "Scan unavailable" : "Checking market setup…";
      results.innerHTML = error ? `<p class="cd-focus-error">${esc(error)}</p>` : '<p class="cd-focus-loading">Scanning the top coins… this can take a few seconds.</p>';
      return;
    }
    const list = tab === "full" ? fullList : almostList;
    meta.textContent = tab === "full" ? `${fullList.length} full matches · ${almostList.length} almost` : `${almostList.length} coins at the 50 SMA with 4 of 5 checks`;
    const note = '<p class="cd-fr-note">ADX + SMA simple swing on the daily chart. Long: (1) price above the 200 SMA; (2) ADX (14) above 20, so the market is not sideways; (3) price pulls back to the 50 SMA (last candle within 2%); (4) a green candle forms there and its volume is above the 20-candle average. Short: the same with price below the 200 SMA and a red candle. A full match needs every tick. SL = 4% beyond the trigger candle low (long) / high (short). Target 1 = 1:2 (about 8%), Target 2 = 1:3. At +4% profit you can move the SL to breakeven. Money rule: risk at most 1% of the account per trade (a guide, nothing is blocked). Position size = (account × 1%) ÷ (entry × stop %). This rule has not been backtested here: it is a filter to watch, not a promise.</p>';
    results.innerHTML = summary() + (list.length ? list.map(card).join("") : `<div class="cd-focus-empty"><strong>${EMPTY[tab][0]}</strong><p>${EMPTY[tab][1]}</p></div>`) + note;
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
      const [body] = await Promise.all([fetchScan(fresh), sleep(800)]);
      data = body;
      loadedAt = Date.now();
    } catch (e) {
      error = e.status === 401 || e.status === 403 ? "Owner session required." : (e.message || "Could not load Catch Accuracy.");
    }
    refreshBtn.disabled = false;
    overlay.classList.remove("is-loading");
    scanning = false;
    render();
  }

  // ---------- events ----------
  document.getElementById("cdCatchTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-catch-tab]");
    if (!button || button.dataset.catchTab === tab) return;
    tab = button.dataset.catchTab;
    render();
  });
  const pageActive = () => overlay.classList.contains("active");
  function ensureLoaded() {
    if (!pageActive() || scanning) return;
    if (!data || Date.now() - loadedAt > STALE_MS) load();
  }
  // Only react when the page is OPENED (the spinner class toggles on this element too).
  let wasActive = pageActive();
  new MutationObserver(() => {
    const now = pageActive();
    if (now && !wasActive) ensureLoaded();
    wasActive = now;
  }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
  window.cdOpenCatchAccuracy = function () {
    if (!pageActive()) document.querySelector('.sidebar .app-tab[data-tab="catchaccuracy"]')?.click();
    load();
  };
  refreshBtn?.addEventListener("click", () => load(true));
  results.addEventListener("click", (event) => {
    const starBtn = event.target.closest("[data-catch-star]");
    if (starBtn) { if (window.cdToggleWatch) window.cdToggleWatch(starBtn.dataset.catchStar); render(); return; }
    const ticket = event.target.closest("[data-catch-ticket]");
    if (ticket) {
      if (ticket.disabled) return;
      const stopLoss = Number(ticket.dataset.catchStop), target = Number(ticket.dataset.catchTarget);
      window.cdOpenTicket?.(ticket.dataset.catchTicket, ticket.dataset.catchSide === "SELL" ? "SELL" : "BUY", { stopLoss: stopLoss > 0 ? stopLoss : null, target: target > 0 ? target : null });
      return;
    }
    const analysis = event.target.closest("[data-catch-coin]");
    if (analysis) window.cdOpenSheet?.(analysis.dataset.catchCoin);
  });
  ensureLoaded(); // restored on a reload
})();
