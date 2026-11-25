// Accuracy Pattern Recognition & Confluence Scanner:
// Fresh implementation strictly adhering to image-based chart patterns & closed candle breakout confirmation.
(function accuracyModule() {
  const overlay = document.getElementById("cdAccuracy");
  const results = document.getElementById("cdAccuracyResults");
  const meta = document.getElementById("cdAccuracyMeta");
  const refreshBtn = document.getElementById("cdAccuracyRefresh");
  const tgBtn = document.getElementById("cdAccuracyTgTest");
  if (!overlay || !results || !meta) return;

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "--";
    const digits = n >= 1000 ? 2 : n >= 10 ? 3 : n >= 1 ? 4 : n >= 0.01 ? 5 : 7;
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) });
  };
  const pct = (v, signed = false) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${signed && n > 0 ? "+" : ""}${n.toFixed(2)}%` : "--";
  };
  const ago = (ts) => {
    const m = Math.max(0, Math.round((Date.now() / 1000 - Number(ts)) / 60));
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let filterTab = "all"; // "all" | "confirmed" | "sweep" | "reversal" | "continuation" | "box"
  let currentTimeframe = "15m"; // "15m" | "1h"
  let data = null, error = "", scanning = false, loadedAt = 0;
  const STALE_MS = 60000;

  async function getToken() {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      try {
        const { data: s } = await window.marketDockSupabase.auth.getSession();
        if (s?.session?.access_token) return s.session.access_token;
      } catch (_) {}
      await sleep(400);
    }
    throw new Error("Please sign in with the owner account to access Accuracy.");
  }

  async function fetchScan(fresh) {
    const bearer = await getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const url = `/api/owner/accuracy?interval=${encodeURIComponent(currentTimeframe)}${fresh ? "&refresh=1" : ""}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${bearer}` },
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const e = new Error(body.detail || "Accuracy is currently unavailable.");
        e.status = response.status;
        throw e;
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runScan(fresh = false) {
    if (scanning) return;
    scanning = true;
    error = "";
    refreshBtn?.classList.add("is-scanning");
    render();
    try {
      data = await fetchScan(fresh);
      loadedAt = Date.now();
    } catch (e) {
      error = e.status === 401 || e.status === 403
        ? "Owner access required (amitkmrai21@gmail.com)."
        : (e.message || "Failed to load Accuracy scanner.");
    } finally {
      scanning = false;
      refreshBtn?.classList.remove("is-scanning");
      render();
    }
  }

  function filterSetups(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((s) => {
      if (filterTab === "all") return true;
      if (filterTab === "confirmed") return s.status === "CONFIRMED";
      if (filterTab === "sweep") return s.category === "Smart Money Structure";
      if (filterTab === "reversal") return s.category === "Reversal Pattern";
      if (filterTab === "continuation") return s.category === "Continuation Pattern";
      if (filterTab === "box") return s.category === "Consolidation Breakout";
      return true;
    });
  }

  function renderCard(s) {
    const isLong = s.side === "LONG";
    const sideClass = isLong ? "cd-badge-bull" : "cd-badge-bear";
    const sideEmoji = isLong ? "🟢 LONG" : "🔴 SHORT";
    const statusClass = s.status === "CONFIRMED" ? "cd-badge-confirmed" : "cd-badge-inzone";
    const statusText = s.status === "CONFIRMED" ? "⚡ Breakout Confirmed (Closed Candle)" : "⏳ Testing Level";
    const symbolClean = esc(s.symbol.replace("USDT", ""));
    const vol = s.volume_surge || 1.0;
    const volBadge = vol >= 1.3 ? `<span class="cd-badge-vol">🔥 ${vol}x Vol</span>` : `<span class="cd-badge-subtle">${vol}x Vol</span>`;

    return `
      <article class="cd-fr-card cd-accuracy-card" data-symbol="${esc(s.symbol)}">
        <header class="cd-fr-card-head">
          <div class="cd-fr-coin">
            <span class="cd-fr-coin-symbol">${symbolClean}</span>
            <span class="cd-fr-coin-pair">/USDT</span>
            <span class="cd-badge-timeframe">${esc(s.interval || currentTimeframe)}</span>
          </div>
          <div class="cd-accuracy-badges">
            <span class="cd-fr-badge ${sideClass}">${sideEmoji}</span>
            <span class="cd-fr-badge cd-badge-pattern">${esc(s.pattern)}</span>
            ${volBadge}
          </div>
        </header>

        <div class="cd-accuracy-status-strip">
          <span class="cd-fr-badge ${statusClass}">${statusText}</span>
          <span class="cd-fr-time">${ago(s.candle_close_time ? s.candle_close_time / 1000 : s.scanned_at)}</span>
        </div>

        <div class="cd-fr-grid cd-accuracy-grid">
          <div class="cd-fr-kv">
            <span class="cd-fr-k">Breakout Level</span>
            <span class="cd-fr-v">${money(s.breakout_level)}</span>
          </div>
          <div class="cd-fr-kv">
            <span class="cd-fr-k">Closed Entry</span>
            <span class="cd-fr-v cd-fr-bold">${money(s.entry)}</span>
          </div>
          <div class="cd-fr-kv">
            <span class="cd-fr-k">Stop Loss</span>
            <span class="cd-fr-v cd-fr-loss">${money(s.stop_loss)} <small>(${s.risk_pct}%)</small></span>
          </div>
          <div class="cd-fr-kv">
            <span class="cd-fr-k">Target 1 (${esc(s.rr_1 || "1:1.6")})</span>
            <span class="cd-fr-v cd-fr-win">${money(s.target_1)}</span>
          </div>
          <div class="cd-fr-kv">
            <span class="cd-fr-k">Target 2 (${esc(s.rr_2 || "1:2.8")})</span>
            <span class="cd-fr-v cd-fr-win">${money(s.target_2)}</span>
          </div>
        </div>

        <div class="cd-accuracy-summary">
          <p><strong>Rationale:</strong> ${esc(s.summary || "")}</p>
        </div>

        <footer class="cd-fr-card-foot" style="margin-top: 10px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 8px;">
          <small style="font-size: 10.5px; color: var(--text-muted, #94a3b8);">⚠️ Manual only · Educational pattern</small>
          <a class="cd-pill" href="https://www.tradingview.com/chart/?symbol=BINANCE%3A${esc(s.symbol)}" target="_blank" rel="noopener" style="font-size: 11px; padding: 4px 10px; text-decoration: none;">📈 Open Chart &#8599;</a>
        </footer>
      </article>
    `;
  }

  function render() {
    if (scanning && !data) {
      meta.textContent = `Scanning 50 liquid Binance pairs on closed ${currentTimeframe} candles…`;
      results.innerHTML = `
        <div class="cd-smartmtf-state-card">
          <div class="cd-smartmtf-spinner"></div>
          <strong>Scanning Chart Patterns (${currentTimeframe})</strong>
          <p>Detecting closed candle breakouts, liquidity sweeps, triangles, and reversal patterns…</p>
        </div>
      `;
      return;
    }

    if (error) {
      meta.textContent = "Scan unavailable";
      results.innerHTML = `
        <div class="cd-smartmtf-state-card cd-smartmtf-error">
          <div class="cd-smartmtf-icon">⚠️</div>
          <strong>Accuracy Scanner Notice</strong>
          <p>${esc(error)}</p>
        </div>
      `;
      return;
    }

    const allSetups = data?.setups || [];
    const filtered = filterSetups(allSetups);
    const confirmedCount = allSetups.filter((s) => s.status === "CONFIRMED").length;
    const scanned = data?.scanned || 50;

    meta.textContent = `${confirmedCount} Confirmed Breakout${confirmedCount === 1 ? "" : "s"} · ${allSetups.length} Total Setup${allSetups.length === 1 ? "" : "s"} · Scanned ${scanned} liquid coins (${currentTimeframe})`;

    if (!filtered.length) {
      const msg = filterTab === "confirmed"
        ? `No confirmed closed-candle breakouts right now on ${currentTimeframe}.`
        : `No pattern setups found matching this filter on ${currentTimeframe}.`;
      results.innerHTML = `
        <div class="cd-smartmtf-state-card">
          <div class="cd-smartmtf-icon">📐</div>
          <strong>No Active Patterns</strong>
          <p>${esc(msg)} The scanner looks strictly for closed candle breakouts beyond pattern boundaries.</p>
        </div>
      `;
      return;
    }

    results.innerHTML = filtered.map(renderCard).join("");
  }

  // Refresh Button click
  refreshBtn?.addEventListener("click", () => {
    runScan(true);
  });

  // Filter Tabs
  document.getElementById("cdAccuracyTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-accuracy-filter]");
    if (!btn) return;
    document.querySelectorAll("#cdAccuracyTabs [data-accuracy-filter]").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    filterTab = btn.dataset.accuracyFilter;
    render();
  });

  // Timeframe selector
  document.getElementById("cdAccuracyTfTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-accuracy-tf]");
    if (!btn) return;
    document.querySelectorAll("#cdAccuracyTfTabs [data-accuracy-tf]").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    currentTimeframe = btn.dataset.accuracyTf;
    runScan(true);
  });

  // Telegram Test button
  tgBtn?.addEventListener("click", async () => {
    if (tgBtn.disabled) return;
    tgBtn.disabled = true;
    const originalText = tgBtn.textContent;
    tgBtn.textContent = "⏳ Sending…";
    try {
      const token = await getToken();
      const res = await fetch("/api/owner/telegram-accuracy/test", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        tgBtn.textContent = "✅ Sent!";
      } else {
        alert(body.detail || "Could not send test message. Check bot credentials.");
        tgBtn.textContent = "❌ Failed";
      }
    } catch (err) {
      alert(err.message || "Network error sending test Telegram.");
      tgBtn.textContent = "❌ Error";
    } finally {
      setTimeout(() => {
        tgBtn.disabled = false;
        tgBtn.textContent = originalText;
      }, 3500);
    }
  });

  // Expose global opener for tabbar and menu
  window.cdOpenAccuracy = function () {
    const tab = document.querySelector('.sidebar .app-tab[data-tab="accuracy"]');
    if (tab) tab.click();
    else {
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      overlay.classList.add("active");
    }
    const isStale = !loadedAt || Date.now() - loadedAt > STALE_MS;
    if (!data || isStale) runScan(false);
  };

  // Visibility / Auto-refresh loop
  const observer = new MutationObserver(() => {
    if (overlay.classList.contains("active")) {
      const isStale = !loadedAt || Date.now() - loadedAt > STALE_MS;
      if (!data || isStale) runScan(false);
    }
  });
  observer.observe(overlay, { attributes: true, attributeFilter: ["class"] });

  setInterval(() => {
    if (overlay.classList.contains("active") && !scanning && Date.now() - loadedAt > STALE_MS) {
      runScan(false);
    }
  }, 30000);

})();
