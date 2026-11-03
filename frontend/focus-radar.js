(function focusRadar() {
  const overlay = document.getElementById("cdFocusRadar");
  const results = document.getElementById("cdFocusResults");
  const meta = document.getElementById("cdFocusMeta");
  const closeBtn = document.getElementById("cdFocusClose");
  const refreshBtn = document.getElementById("cdFocusRefresh");
  if (!overlay || !results || !meta) return;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const money = (value) => Number.isFinite(Number(value)) ? "$" + Number(value).toLocaleString("en-US", { maximumFractionDigits: Number(value) >= 100 ? 2 : 6 }) : "--";
  async function load() {
    results.innerHTML = '<p class="cd-focus-loading">Scanning liquid markets… this can take a few seconds.</p>';
    meta.textContent = "Using closed 1-hour candles";
    refreshBtn.disabled = true;
    try {
      const { data } = await window.marketDockSupabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw new Error("Please sign in to access Focus Radar.");
      const response = await fetch("/api/owner/focus-radar", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || "Focus Radar is unavailable.");
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
      meta.textContent = "Owner session required";
      results.innerHTML = `<p class="cd-focus-error">${esc(error.message || "Could not load Focus Radar.")}</p>`;
    } finally { refreshBtn.disabled = false; }
  }
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
