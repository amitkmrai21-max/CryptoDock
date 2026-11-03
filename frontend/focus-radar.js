(function focusRadar() {
  const overlay = document.getElementById("cdFocusRadar");
  const results = document.getElementById("cdFocusResults");
  const meta = document.getElementById("cdFocusMeta");
  const closeBtn = document.getElementById("cdFocusClose");
  const refreshBtn = document.getElementById("cdFocusRefresh");
  if (!overlay || !results || !meta) return;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const money = (value) => Number.isFinite(Number(value)) ? "$" + Number(value).toLocaleString("en-US", { maximumFractionDigits: Number(value) >= 100 ? 2 : 6 }) : "--";
  async function loadBreakouts() {
    results.innerHTML = '<p class="cd-focus-loading">Scanning liquid markets… this can take a few seconds.</p>';
    meta.textContent = "Using closed 1-hour candles";
    refreshBtn.disabled = true;
    try {
      const { data } = await window.marketDockSupabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw new Error("Please sign in to access Focus Radar.");
      const response = await fetch("/api/owner/focus-radar", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(body.detail || "Focus Radar is unavailable."); error.status = response.status; throw error; }
      const signals = Array.isArray(body.signals) ? body.signals : [];
      meta.textContent = `Scanned ${body.scanned || 0} liquid markets · Updated ${new Date((body.updated_at || Date.now()/1000) * 1000).toLocaleTimeString()}`;
      results.innerHTML = signals.length ? signals.map((item) => {
        const dir = item.direction === "BULLISH" ? "up" : "down";
        const change = Number(item.change_percent) || 0;
        return `<article class="cd-focus-card is-${dir}">
          <div class="cd-focus-card-head"><div><strong>${esc(item.base)}/USDT</strong><small>${esc(item.timeframe)} · ${esc(item.reason)}</small></div><span class="cd-focus-direction">${esc(item.direction === "BULLISH" ? "BULLISH · LONG WATCH" : "BEARISH · SHORT WATCH")}</span></div>
          <div class="cd-focus-stats"><div><small>Price</small><b>${money(item.price)}</b></div><div><small>24h change</small><b class="${change >= 0 ? "is-green" : "is-red"}">${change > 0 ? "+" : ""}${change.toFixed(2)}%</b></div><div><small>1h volume vs avg</small><b>${Number(item.volume_ratio).toFixed(2)}×</b></div><div><small>Break level</small><b>${money(item.break_level)}</b></div></div>
          <button class="cd-focus-detail" type="button" data-focus-coin="${esc(item.base)}">View coin details</button>
        </article>`;
      }).join("") : '<div class="cd-focus-empty"><strong>No qualifying setups right now</strong><p>Wait for a confirmed 1-hour breakout or breakdown with volume and trend agreement.</p></div>';
    } catch (error) {
      meta.textContent = error.status === 401 || error.status === 403 ? "Owner session required" : "Scan unavailable";
      results.innerHTML = `<p class="cd-focus-error">${esc(error.message || "Could not load Focus Radar.")}</p>`;
    } finally { refreshBtn.disabled = false; }
  }

  // ---------- Swing setups: 1H EMA 20/50 pullback (bullish and bearish) ----------
  let tab = "breakouts";
  const coinOf = (base) => (window.cdMarkets && window.cdMarkets.coinsByBase ? window.cdMarkets.coinsByBase.get(base) : null);
  const SWING_STATE = {
    ready: ["Ready · waiting for the trigger", "is-ready"],
    triggered: ["Triggered", "is-live"],
    target1: ["Target 1 reached", "is-t1"],
    zone: ["In the pullback zone · waiting for a rejection candle", "is-zone"],
  };
  const agoText = (ts) => { const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60)); return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
  // Live price: drop a setup that is already stopped out or past target 2; Ready becomes Triggered once crossed.
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
    const dir = bull ? "up" : "down";
    const change = Number(item.change_percent) || 0;
    const [label, cls] = SWING_STATE[item.state] || SWING_STATE.zone;
    const levels = item.state === "zone" ? "" : `<div class="cd-focus-levels">
        <div><small>${bull ? "Entry (above)" : "Entry (below)"}</small><b>${money(item.entry)}</b></div>
        <div><small>Stop-loss</small><b class="is-red">${money(item.stop)}</b></div>
        <div><small>Target 1 · 1:1.5</small><b class="is-green">${money(item.t1)}</b></div>
        <div><small>Target 2 · 1:2.5</small><b class="is-green">${money(item.t2)}</b></div>
      </div>`;
    return `<article class="cd-focus-card is-${dir}">
      <div class="cd-focus-card-head"><div><strong>${esc(item.base)}/USDT</strong><small>1H · EMA 20/50 pullback swing setup</small></div><span class="cd-focus-direction">${bull ? "BULLISH · LONG WATCH" : "BEARISH · SHORT WATCH"}</span></div>
      <div class="cd-focus-stats"><div><small>Price</small><b>${money(item.price)}</b></div><div><small>24h change</small><b class="${change >= 0 ? "is-green" : "is-red"}">${change > 0 ? "+" : ""}${change.toFixed(2)}%</b></div></div>
      <span class="cd-focus-state ${cls}">${label}</span>
      ${levels}
      <small class="cd-focus-ema">EMA 20 ${money(item.ema20)} · EMA 50 ${money(item.ema50)}${item.rejection_at ? ` · rejection candle ${agoText(item.rejection_at)}` : ""}</small>
      <button class="cd-focus-detail" type="button" data-focus-coin="${esc(item.base)}">View coin details</button>
    </article>`;
  }
  let swingData = null;
  function renderSwing() {
    if (!swingData) return;
    const rows = swingData.setups.map(adjustSwing).filter(Boolean);
    const bull = rows.filter((r) => r.side === "bullish").length;
    meta.textContent = `Swing setups · top ${swingData.scanned} coins · ${bull} bullish, ${rows.length - bull} bearish · updated ${agoText(swingData.at)}`;
    results.innerHTML = rows.length ? rows.map(swingCard).join("")
      : '<div class="cd-focus-empty"><strong>No swing setup right now</strong><p>No top coin is in a 1H EMA 20/50 pullback. That is normal; check again later.</p></div>';
  }
  async function loadSwing() {
    results.innerHTML = '<p class="cd-focus-loading">Scanning the top coins for pullback setups…</p>';
    meta.textContent = "Using closed 1-hour candles";
    refreshBtn.disabled = true;
    try {
      const { data } = await window.marketDockSupabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw new Error("Please sign in to access Focus Radar.");
      const response = await fetch("/api/owner/focus-radar/swing", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(body.detail || "Swing scan is unavailable."); error.status = response.status; throw error; }
      swingData = body;
      renderSwing();
    } catch (error) {
      meta.textContent = error.status === 401 || error.status === 403 ? "Owner session required" : "Scan unavailable";
      results.innerHTML = `<p class="cd-focus-error">${esc(error.message || "Could not load swing setups.")}</p>`;
    } finally { refreshBtn.disabled = false; }
  }
  function load() { return tab === "swing" ? loadSwing() : loadBreakouts(); }
  document.getElementById("cdFocusTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-focus-tab]");
    if (!button || button.dataset.focusTab === tab) return;
    tab = button.dataset.focusTab;
    document.querySelectorAll("#cdFocusTabs button").forEach((b) => b.classList.toggle("is-active", b === button));
    load();
  });
  window.addEventListener("cd-markets-updated", () => { if (tab === "swing" && !overlay.hidden) renderSwing(); });

  function open() { overlay.hidden = false; load(); }
  function close() { if (window.cdHideSheetNow) window.cdHideSheetNow(overlay); else overlay.hidden = true; }
  window.cdOpenFocusRadar = open;
  closeBtn?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  refreshBtn?.addEventListener("click", load);
  results.addEventListener("click", (event) => {
    const button = event.target.closest("[data-focus-coin]");
    if (!button) return;
    close();
    setTimeout(() => window.cdOpenSheet?.(button.dataset.focusCoin), 0);
  });
})();
