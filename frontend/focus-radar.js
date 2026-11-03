// Focus Radar (owner only): 1H swing setups (EMA 20/50 pullback) and 1H breakouts for the top coins.
// Rules on closed candles; not a prediction. Server: /api/owner/focus-radar and /swing (shared caches).
(function focusRadar() {
  const overlay = document.getElementById("cdFocusRadar");
  const results = document.getElementById("cdFocusResults");
  const meta = document.getElementById("cdFocusMeta");
  const closeBtn = document.getElementById("cdFocusClose");
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

  async function token() {
    const { data: session } = await window.marketDockSupabase.auth.getSession();
    const t = session?.session?.access_token;
    if (!t) throw new Error("Please sign in to access Focus Radar.");
    return t;
  }
  async function fetchJson(path) {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body.detail || "Focus Radar is unavailable."); error.status = response.status; throw error; }
    return body;
  }

  // ---------- small building blocks ----------
  function spark(values, up) {
    if (!Array.isArray(values) || values.length < 2) return "";
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(30 - ((v - lo) / span) * 28 - 1).toFixed(1)}`).join(" ");
    return `<svg class="cd-fr-spark ${up ? "is-up" : "is-down"}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  function ring(score, label) {
    const has = Number.isFinite(score);
    return `<div class="cd-fr-ring" style="--s:${has ? score : 0}"><div><b>${has ? score + "%" : "--"}</b><small>${label}</small></div></div>`;
  }
  function step(n, title, sub, state) { // state: ok | live | wait
    const mark = state === "ok" ? "✓" : state === "live" ? "⚡" : "…";
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
      <button type="button" class="cd-fr-ticket ${bull ? "is-buy" : "is-sell"}" data-fr-ticket="${esc(item.base)}" data-fr-side="${bull ? "BUY" : "SELL"}">⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button>
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
      : ["Trigger", "Not yet", "wait"];
    const steps = [
      step(1, bull ? "Uptrend" : "Downtrend", `EMA 20 ${bull ? "above" : "below"} 50`, "ok"),
      step(2, "EMA Retest", zone ? "In zone, no rejection" : `Rejection ${agoText(item.rejection_at)}`, zone ? "wait" : "ok"),
      step(3, s3[0], s3[1], s3[2]),
    ].join("");
    let levels = "";
    if (!zone) {
      const risk = Math.abs(item.entry - item.stop) / item.entry * 100;
      const g1 = Math.abs(item.t1 - item.entry) / item.entry * 100, g2 = Math.abs(item.t2 - item.entry) / item.entry * 100;
      levels = `<div class="cd-fr-levels">
        <div><span>Entry</span><b>${money(item.entry)}</b><em></em></div>
        <div><span>SL</span><b class="cd-down">${money(item.stop)}</b><em class="cd-down">(−${risk.toFixed(1)}%)</em></div>
        <div><span>Target 1 · 1:1.5</span><b>${money(item.t1)}</b><em class="cd-up">(+${g1.toFixed(1)}%)</em></div>
        <div><span>Target 2 · 1:2.5</span><b>${money(item.t2)}</b><em class="cd-up">(+${g2.toFixed(1)}%)</em></div>
      </div>`;
    }
    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item, item.price, change, item.spark, bull ? true : false)}
      <div class="cd-fr-tags"><span class="cd-fr-pill">${bull ? "↗ BULLISH PULLBACK · LONG" : "↘ BEARISH PULLBACK · SHORT"}</span><span class="cd-fr-tag">1H SETUP</span></div>
      <div class="cd-fr-mid">${ring(item.score, "Score")}<div class="cd-fr-steps">${steps}</div></div>
      ${levels}
      <small class="cd-fr-ema">EMA 20 ${money(item.ema20)} · EMA 50 ${money(item.ema50)}</small>
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
    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item, price, change, null, bull)}
      <div class="cd-fr-tags"><span class="cd-fr-pill">${bull ? "↗ BULLISH BREAKOUT · LONG WATCH" : "↘ BEARISH BREAKDOWN · SHORT WATCH"}</span><span class="cd-fr-tag">1H SETUP</span></div>
      <div class="cd-fr-steps cd-fr-steps-wide">${steps}</div>
      <div class="cd-fr-levels">
        <div><span>Break level</span><b>${money(item.break_level)}</b><em></em></div>
        <div><span>Price</span><b>${money(price)}</b><em></em></div>
        <div><span>Volume</span><b>${Number(item.volume_ratio).toFixed(2)}×</b><em></em></div>
        <div><span>24h</span><b class="${change >= 0 ? "cd-up" : "cd-down"}">${pct(change, true)}</b><em></em></div>
      </div>
      ${actions(item, bull)}
    </article>`;
  }

  // ---------- render ----------
  const EMPTY = {
    swing: ["No swing setup right now", "No top coin is in a 1H EMA 20/50 pullback. That is normal; check again later."],
    breakouts: ["No qualifying setups right now", "Wait for a confirmed 1-hour breakout or breakdown with volume and trend agreement."],
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
      ? '<p class="cd-fr-note">Setup score = trend strength 40% + rejection candle quality 35% + stop tightness 25%. It rates how clean the setup looks, not the chance of winning.</p>' : "";
    results.innerHTML = summary() + (cards.length ? cards.join("") : `<div class="cd-focus-empty"><strong>${EMPTY[tab][0]}</strong><p>${EMPTY[tab][1]}</p></div>`) + note;
  }

  async function loadOne(kind) {
    try {
      data[kind] = await fetchJson(kind === "swing" ? "/api/owner/focus-radar/swing" : "/api/owner/focus-radar");
      errors[kind] = "";
    } catch (error) {
      errors[kind] = error.status === 401 || error.status === 403 ? "Owner session required." : (error.message || "Could not load Focus Radar.");
    }
  }
  async function load() {
    refreshBtn.disabled = true;
    data.swing = null; data.breakouts = null; render();
    // Both scans in parallel so both tab counts show.
    await Promise.all([loadOne("swing"), loadOne("breakouts")]);
    refreshBtn.disabled = false;
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
  function back() {
    const before = window.history.length;
    window.history.back();
    // No history to go back to (plain browser tab): fall back to Home.
    setTimeout(() => { if (pageActive()) document.querySelector('.sidebar .app-tab[data-tab="dashboard"]')?.click(); }, 250);
  }
  window.cdOpenFocusRadar = open;
  closeBtn?.addEventListener("click", back);
  refreshBtn?.addEventListener("click", load);
  results.addEventListener("click", (event) => {
    const starBtn = event.target.closest("[data-fr-star]");
    if (starBtn) { if (window.cdToggleWatch) window.cdToggleWatch(starBtn.dataset.frStar); render(); return; }
    const ticket = event.target.closest("[data-fr-ticket]");
    if (ticket) {
      window.cdOpenTicket?.(ticket.dataset.frTicket, ticket.dataset.frSide);
      return;
    }
    const button = event.target.closest("[data-focus-coin]");
    if (!button) return;
    window.cdOpenSheet?.(button.dataset.focusCoin);
  });
})();
