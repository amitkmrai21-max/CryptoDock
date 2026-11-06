// Setup Lab (owner only): three smart-money style setups, each for longs and shorts, shown live so they can be judged.
//   MSS : market structure shift on 1H, then a pullback into the discount (long) / premium (short) zone.
//   SFP : swing failure pattern: a wick beyond a 4H / daily key level, then a candle closes back inside.
//   FVG : fair value gap retest: a big, high-volume impulse leaves a gap and price comes back and rejects it.
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

  let tab = "mss";              // 'mss' | 'sfp' | 'fvg'
  let dirFilter = "all";        // all | bullish | bearish
  const FILTER_LABEL = { all: "All", bullish: "Bull", bearish: "Bear" };
  const KIND_NAME = { mss: "MSS", sfp: "SFP", fvg: "FVG" };
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
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // A scan that never answers must not leave the page stuck: give up after 40 seconds and try again / show an error.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 40000);
        let response;
        try {
          response = await fetch("/api/owner/lab" + (fresh ? "?refresh=1" : ""), { headers: { Authorization: `Bearer ${bearer}` }, cache: "no-store", signal: controller.signal });
        } finally { clearTimeout(timer); }
        const body = await response.json().catch(() => ({}));
        if (response.ok) return body;
        const err = new Error(body.detail || "Setup Lab is unavailable."); err.status = response.status;
        if (response.status < 500) throw err;
        last = err;
      } catch (e) {
        if (e.status && e.status < 500) throw e;
        last = e;
      }
      if (attempt < 1) await sleep(1500);
    }
    throw last && last.name === "AbortError" ? new Error("The scan took too long. Tap the refresh arrow to try again.") : (last || new Error("Setup Lab is unavailable."));
  }

  // ---------- small building blocks ----------
  function spark(values, up) {
    if (!Array.isArray(values) || values.length < 2) return "";
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(30 - ((v - lo) / span) * 28 - 1).toFixed(1)}`).join(" ");
    return `<svg class="cd-fr-spark ${up ? "is-up" : "is-down"}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  function step(title, sub, state) { // state: ok | wait
    return `<div class="cd-fr-step is-${state}"><b>${title}</b><i>${state === "ok" ? "✓" : "⏳"}</i><small>${sub}</small></div>`;
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
    const t1 = item.kind === "mss" ? (item.side === "bullish" ? "Target 1 · high" : "Target 1 · low") : "Target 1 · 3R";
    const t2 = item.kind === "mss" ? "Target 2 · 1.272" : "Target 2 · 4R";
    return `<div class="cd-fr-levels">
      <div><span>${item.state === "watch" ? "Plan entry" : "Entry"}</span><b>${money(item.entry)}</b><em></em></div>
      <div><span>SL</span><b class="cd-down">${money(item.stop)}</b><em class="cd-down">(−${g(item.stop).toFixed(1)}%)</em></div>
      <div><span>${t1}</span><b>${money(item.t1)}</b><em class="cd-up">(+${g(item.t1).toFixed(1)}%)</em></div>
      <div><span>${t2}</span><b>${money(item.t2)}</b><em class="cd-up">(+${g(item.t2).toFixed(1)}%)</em></div>
    </div>`;
  }
  function actions(item, bull) {
    const ready = item.state === "ready";
    return `<div class="cd-fr-actions">
      <button type="button" class="cd-fr-ticket ${bull ? "is-buy" : "is-sell"}" ${ready ? "" : "disabled"} data-lab-ticket="${esc(item.base)}" data-lab-side="${bull ? "BUY" : "SELL"}" data-lab-stop="${esc(item.stop)}" data-lab-target="${esc(item.t1)}">${ready ? `⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}` : "⏳ Wait for the zone"}</button>
      <button type="button" class="cd-fr-analysis" data-lab-coin="${esc(item.base)}">📊 Analysis</button>
    </div>`;
  }
  const rrText = (item) => `1:${Number(item.rr1).toFixed(1)}`;

  // ---------- cards ----------
  function mssCard(item) {
    const bull = item.side === "bullish";
    const c = item.checks;
    const steps = [
      step("Structure shift", bull ? "Broke the lower high" : "Broke the higher low", "ok"),
      step(bull ? "Discount zone" : "Premium zone", `${item.retrace}% retrace${c.retest ? " · retest" : ""}`, c.discount || c.retest ? "ok" : "wait"),
      step("Golden pocket", "0.618 – 0.786", c.golden ? "ok" : "wait"),
    ].join("");
    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item, bull)}
      <div class="cd-fr-tags"><span class="cd-fr-pill">${bull ? "↗ MSS · LONG" : "↘ MSS · SHORT"}</span><span class="cd-fr-tag">${item.state === "ready" ? "IN ZONE" : "WATCH"} · ${rrText(item)}</span></div>
      <div class="cd-fr-steps cd-fr-steps-wide">${steps}</div>
      ${levels(item)}
      <small class="cd-fr-ema"><i>${bull ? "Discount" : "Premium"} zone</i> <b>${money(item.zone[0])} – ${money(item.zone[1])}</b> · <i>Broken level</i> <b>${money(item.level)}</b> · Swing ${money(item.swing_start)} → ${money(item.swing_end)} · Risk <b>${item.risk_pct}%</b></small>
      ${actions(item, bull)}
    </article>`;
  }
  function sfpCard(item) {
    const bull = item.side === "bullish";
    const steps = [
      step("Key level", `${item.key_tf} ${bull ? "low" : "high"} ${money(item.level)}`, "ok"),
      step("Sweep", `Wick ${bull ? "below" : "above"} to ${money(item.wick_low)}`, "ok"),
      step("Close back", `${item.candle_tf} candle ${item.age === 1 ? "just closed" : `${item.age} candles ago`}`, "ok"),
    ].join("");
    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item, bull)}
      <div class="cd-fr-tags"><span class="cd-fr-pill">${bull ? "↗ SFP · LONG" : "↘ SFP · SHORT"}</span><span class="cd-fr-tag">${item.age === 1 ? "FRESH" : "RECENT"} · ${rrText(item)}</span></div>
      <div class="cd-fr-steps cd-fr-steps-wide">${steps}</div>
      ${levels(item)}
      <small class="cd-fr-ema">SL just ${bull ? "under" : "over"} the wick · Risk <b>${item.risk_pct}%</b> · the ${bull ? "low" : "high"} was taken and price closed back inside</small>
      ${actions(item, bull)}
    </article>`;
  }
  function fvgCard(item) {
    const bull = item.side === "bullish";
    const ready = item.state === "ready";
    const steps = [
      step("Impulse", `${item.vol_x}× volume`, "ok"),
      step("FVG box", `${money(item.zone[0])} – ${money(item.zone[1])}`, "ok"),
      step("Rejection", ready ? "Rejected the box" : "Waiting for the retest", ready ? "ok" : "wait"),
    ].join("");
    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item, bull)}
      <div class="cd-fr-tags"><span class="cd-fr-pill">${bull ? "↗ FVG · LONG" : "↘ FVG · SHORT"}</span><span class="cd-fr-tag">${ready ? "RETEST" : "WATCH"} · ${rrText(item)}</span></div>
      <div class="cd-fr-steps cd-fr-steps-wide">${steps}</div>
      ${levels(item)}
      <small class="cd-fr-ema">SL just outside the box · Risk <b>${item.risk_pct}%</b>${ready ? "" : " · price is close above the box, no retest yet"}</small>
      ${actions(item, bull)}
    </article>`;
  }
  const CARD = { mss: mssCard, sfp: sfpCard, fvg: fvgCard };

  // ---------- page ----------
  function summary() {
    const n = (k) => (data[k] || []).length;
    return `<div class="cd-fr-summary"><svg class="cd-fr-radar" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="27"/><circle cx="30" cy="30" r="18"/><circle cx="30" cy="30" r="9"/><path d="M30 30 L52 14" /></svg>
      <div><b>Scanning ${Number(data.scanned) || 0} coins</b><small>Updated ${agoText(data.at)}</small></div>
      <div class="cd-fr-ticks"><div><span><i class="${n("mss") + n("sfp") + n("fvg") ? "is-up" : ""}"></i>Setups</span> <b>${n("mss") + n("sfp") + n("fvg")}</b></div></div></div>`;
  }
  const EMPTY = {
    mss: ["No market structure shift right now", "No coin has just broken its down-trend (or up-trend) structure with a big candle and is pulling back into the zone. Check again later."],
    sfp: ["No swing failure right now", "No coin has just wicked beyond a 4H / daily key level and closed back inside with a tight stop. These are rare and quick; check again later."],
    fvg: ["No fair value gap retest right now", "No coin has a fresh 1H gap from a big, high-volume candle that price is coming back to. Check again later."],
  };
  const NOTE = {
    mss: "MSS (1H). Long: the coin was making lower highs and lower lows, then one big candle closed above its last lower high. The whole move is measured from the swing low to the new high; the buy zone is the discount below its 50% (best at 0.618 - 0.786, or a retest of the broken level). SL just under the new swing low, Target 1 the previous high, Target 2 the 1.272 extension. Short: the exact mirror (premium zone above 50%, SL above the new swing high). “Watch” cards have not reached the zone yet; their levels are the plan.",
    sfp: "SFP (1H / 4H). Long: a clear 4H or daily low is taken by a wick, but the candle body closes back above it (the wick only). Enter after the close, SL just under the wick, Target 1 = 3R, Target 2 = 4R. Short: the same above a key high. Only shown while the stop is within 2% of the price, so a late chase is filtered out.",
    fvg: "FVG (1H). A big, high-volume (1.5× or more) impulse candle leaves a gap between candle 1's high and candle 3's low. When price returns into that box and rejects it, trade in the impulse direction. SL just outside the box (within 2% of the price), Target 1 = 3R, Target 2 = 4R. “Watch” = price is close above the box but has not touched it yet.",
  };
  function render() {
    document.querySelectorAll("#cdLabTabs button").forEach((b) => b.classList.toggle("is-active", b.dataset.labTab === tab));
    const count = (k) => (data ? (data[k] || []).filter((r) => dirFilter === "all" || r.side === dirFilter).length : null);
    Object.keys(KIND_NAME).forEach((k) => {
      const b = document.querySelector(`#cdLabTabs [data-lab-tab="${k}"]`);
      if (b) b.textContent = `${KIND_NAME[k]}${data ? ` (${count(k)})` : ""}`;
    });
    if (!data) {
      meta.textContent = error ? "Scan unavailable" : "Checking market setup…";
      results.innerHTML = error ? `<p class="cd-focus-error">${esc(error)}</p>` : '<p class="cd-focus-loading">Scanning the top coins… this can take a few seconds.</p>';
      return;
    }
    const list = (data[tab] || []).filter((r) => dirFilter === "all" || r.side === dirFilter);
    const ready = list.filter((r) => r.state === "ready").length;
    meta.textContent = `${list.length} ${KIND_NAME[tab]} setups · ${ready} ready, ${list.length - ready} watching · never backtested`;
    results.innerHTML = summary() + (list.length ? list.map(CARD[tab]).join("") : `<div class="cd-focus-empty"><strong>${EMPTY[tab][0]}</strong><p>${EMPTY[tab][1]}</p></div>`) + `<p class="cd-fr-note">${NOTE[tab]} These ideas are experimental and not backtested: verify the chart and manage risk yourself.</p>`;
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
  // Only react when the page is OPENED (the spinner class toggles on this element too).
  let wasActive = pageActive();
  new MutationObserver(() => {
    const now = pageActive();
    if (now && !wasActive) ensureLoaded();
    wasActive = now;
  }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
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
      if (ticket.disabled) return;
      const stopLoss = Number(ticket.dataset.labStop), target = Number(ticket.dataset.labTarget);
      window.cdOpenTicket?.(ticket.dataset.labTicket, ticket.dataset.labSide === "SELL" ? "SELL" : "BUY", { stopLoss: stopLoss > 0 ? stopLoss : null, target: target > 0 ? target : null });
      return;
    }
    const analysis = event.target.closest("[data-lab-coin]");
    if (analysis) window.cdOpenSheet?.(analysis.dataset.labCoin);
  });
  ensureLoaded(); // restored on a reload
})();
