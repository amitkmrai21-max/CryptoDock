// Accuracy Pattern Recognition & Confluence Scanner
// Strictly adheres to image-based chart patterns & closed candle breakout confirmation.
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
    const digits = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 5 : n >= 0.0001 ? 6 : 8;
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) });
  };
  const pct = (v, signed = false) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${signed && n > 0 ? "+" : ""}${n.toFixed(2)}%` : "--";
  };
  const ago = (ts) => {
    if (!ts) return "";
    const sec = Number(ts) > 1e11 ? Number(ts) / 1000 : Number(ts);
    const now = Date.now() / 1000;
    const diff = Math.max(0, Math.floor(now - sec));
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
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
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Scan timed out. Please tap refresh to retry.");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function filterSetups(all) {
    if (!Array.isArray(all)) return [];
    if (filterTab === "all") return all;
    if (filterTab === "confirmed") return all.filter((s) => s.status === "CONFIRMED");
    if (filterTab === "sweep") return all.filter((s) => s.pattern && s.pattern.includes("Sweep"));
    if (filterTab === "reversal") return all.filter((s) => s.category === "Reversal Pattern");
    if (filterTab === "continuation") return all.filter((s) => s.category === "Continuation Pattern");
    if (filterTab === "box") return all.filter((s) => s.category === "Consolidation Breakout");
    return all;
  }

  function renderCard(s) {
    const bull = s.side === "LONG";
    const dir = bull ? "LONG" : "SHORT";
    const base = s.symbol.replace("USDT", "");
    const avatar = window.cdFormat?.avatar ? window.cdFormat.avatar(base) : "📐";
    const isConfirmed = s.status === "CONFIRMED";
    const timeText = ago(s.candle_close_time || s.scanned_at);
    const vol = s.volume_surge || 1.0;

    return `
      <article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(base)}">
        <div class="cd-fr-head">
          <span class="cd-fr-avatar">${avatar}</span>
          <div class="cd-fr-id">
            <strong>${esc(base)}<span>/USDT</span></strong>
            <small>${esc(s.category || "Pattern Setup")} · ${esc(s.interval || currentTimeframe)}</small>
          </div>
          <div class="cd-fr-px">
            <b>${money(s.current_price || s.entry)}</b>
            <small class="${bull ? "cd-up" : "cd-down"}">${bull ? "▲ BULLISH" : "▼ BEARISH"}</small>
          </div>
        </div>

        <div class="cd-fr-tags">
          <span class="cd-fr-pill">${bull ? "🟢" : "🔴"} ${dir} · ${esc(s.pattern)}</span>
          ${s.btc_trend ? `<span class="cd-fr-tag" style="background:rgba(56,189,248,0.15); color:#38bdf8; font-weight:600;">🌐 BTC: ${esc(s.btc_trend)}</span>` : ""}
          <span class="cd-fr-tag cd-tag-purple">⚡ Closed Candle Breakout</span>
          <span class="cd-fr-tag cd-tag-amber">🔥 ${vol}x Vol</span>
          <span class="cd-fr-tag" style="margin-left:auto;">🕒 ${esc(timeText)}</span>
        </div>

        <div class="cd-fr-levels">
          <div>
            <span>Breakout</span>
            <b>${money(s.breakout_level)}</b>
            <em style="color:#94a3b8">Pattern Level</em>
          </div>
          <div>
            <span>Closed Entry</span>
            <b style="color:#fff">${money(s.entry)}</b>
            <em class="${bull ? "cd-up" : "cd-down"}">Triggered</em>
          </div>
          <div>
            <span>Stop · ${s.risk_pct}%</span>
            <b class="cd-down">${money(s.stop_loss)}</b>
            <em class="cd-down">Invalidation</em>
          </div>
          <div>
            <span>T1 · ${esc(s.rr_1 || "1:1.6")}</span>
            <b class="cd-up">${money(s.target_1)}</b>
            <em class="cd-up">T2: ${money(s.target_2)}</em>
          </div>
        </div>

        <div class="cd-fr-summary">
          <p><strong>Rationale:</strong> ${esc(s.summary || "")} · <em>Target 2 (${esc(s.rr_2 || "1:2.8")}): ${money(s.target_2)}</em></p>
        </div>

        <div class="cd-fr-actions">
          <button type="button" class="cd-fr-ticket ${bull ? "is-buy" : "is-sell"}"
            data-accuracy-ticket="${esc(base)}"
            data-accuracy-side="${bull ? "BUY" : "SELL"}"
            data-accuracy-stop="${esc(s.stop_loss)}"
            data-accuracy-target="${esc(s.target_1)}">
            ⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}
          </button>
          <button type="button" class="cd-fr-analysis" data-accuracy-coin="${esc(base)}">
            📊 Analysis
          </button>
        </div>
      </article>
    `;
  }

  function render() {
    if (scanning && !data) {
      meta.textContent = `Scanning 50 liquid Binance pairs on closed ${currentTimeframe} candles…`;
      results.innerHTML = `
        <div class="cd-focus-empty">
          <div class="cd-smartmtf-spinner" style="margin: 0 auto 12px auto;"></div>
          <strong>Scanning Chart Patterns (${currentTimeframe})</strong>
          <p>Analyzing institutional sweeps, Head & Shoulders, Wedges, Triangles & Box breakouts…</p>
        </div>
      `;
      return;
    }

    if (error) {
      meta.textContent = "Scan unavailable";
      results.innerHTML = `
        <div class="cd-focus-empty" style="border-color: rgba(239, 68, 68, 0.4);">
          <strong style="color: #ef4444;">Accuracy Scanner Notice</strong>
          <p>${esc(error)}</p>
          <button type="button" class="cd-fr-ticket is-buy" id="cdAccuracyRetry" style="margin-top:12px; display:inline-block; padding: 6px 14px;">↻ Retry Scan</button>
        </div>
      `;
      document.getElementById("cdAccuracyRetry")?.addEventListener("click", () => load(true));
      return;
    }

    const allSetups = data?.setups || [];
    const filtered = filterSetups(allSetups);
    const confirmedCount = allSetups.filter((s) => s.status === "CONFIRMED").length;
    const scanned = data?.scanned || 50;

    const btcContext = data?.btc_trend ? ` · 🌐 BTC: ${esc(data.btc_trend)}` : "";
    meta.textContent = `${confirmedCount} Confirmed Breakout${confirmedCount === 1 ? "" : "s"} · ${allSetups.length} Total Setup${allSetups.length === 1 ? "" : "s"} · Scanned ${scanned} liquid coins (${currentTimeframe})${btcContext}`;

    if (!filtered.length) {
      const msg = filterTab === "confirmed"
        ? `No confirmed closed-candle breakouts right now on ${currentTimeframe}.`
        : `No active pattern setups detected right now on ${currentTimeframe}.`;
      results.innerHTML = `
        <div class="cd-focus-empty">
          <strong>${esc(msg)}</strong>
          <p>Scanning 50 liquid pairs continuously every 60s for closed-candle breakout confirmation.</p>
        </div>
      `;
      return;
    }

    results.innerHTML = filtered.map(renderCard).join("") + `
      <p class="cd-fr-note">Accuracy Pattern Scanner · Signals trigger strictly on closed-candle breakout confirmation. Manual execution only.</p>
    `;
  }

  async function load(fresh = false) {
    if (scanning) return;
    scanning = true;
    overlay.classList.add("is-loading");
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add("is-spinning");
    }

    if (!data) {
      render();
    } else {
      meta.innerHTML = '<span style="color:#38bdf8; font-weight:600;">⚡ Scanning 50 pairs for closed-candle breakouts…</span>';
    }

    try {
      const [res] = await Promise.all([
        fetchScan(fresh),
        fresh ? sleep(600) : Promise.resolve(),
      ]);
      data = res;
      error = "";
      loadedAt = Date.now();
    } catch (e) {
      const msg = e.status === 401 || e.status === 403
        ? "Owner session required (amitkmrai21@gmail.com)."
        : (e.message || "Could not load Accuracy setups.");
      if (!data) error = msg;
    } finally {
      scanning = false;
      overlay.classList.remove("is-loading");
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove("is-spinning");
      }
      render();
    }
  }

  // Filter tabs
  document.getElementById("cdAccuracyTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-accuracy-filter]");
    if (!btn) return;
    const f = btn.dataset.accuracyFilter;
    if (f === filterTab) return;
    filterTab = f;
    document.querySelectorAll("#cdAccuracyTabs button[data-accuracy-filter]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.accuracyFilter === filterTab);
    });
    render();
  });

  // Timeframe selector (15m / 1h)
  document.querySelectorAll("#cdAccuracy [data-accuracy-tf]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tf = btn.dataset.accuracyTf;
      if (tf === currentTimeframe) return;
      currentTimeframe = tf;
      document.querySelectorAll("#cdAccuracy [data-accuracy-tf]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.accuracyTf === currentTimeframe);
      });
      data = null;
      load(true);
    });
  });

  refreshBtn?.addEventListener("click", () => load(true));

  tgBtn?.addEventListener("click", async () => {
    try {
      tgBtn.disabled = true;
      tgBtn.textContent = "Sending...";
      const bearer = await getToken();
      const res = await fetch("/api/owner/telegram-accuracy/test", {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        tgBtn.textContent = "✓ Sent!";
        setTimeout(() => { tgBtn.textContent = "📲 Test TG"; tgBtn.disabled = false; }, 3000);
      } else {
        alert("Telegram Error: " + (json.detail || "Failed to send alert. Check credentials in .env"));
        tgBtn.textContent = "📲 Test TG";
        tgBtn.disabled = false;
      }
    } catch (e) {
      alert("Error: " + e.message);
      tgBtn.textContent = "📲 Test TG";
      tgBtn.disabled = false;
    }
  });

  // Card click actions: Open Paper Ticket or Analysis
  results.addEventListener("click", (e) => {
    const ticket = e.target.closest("[data-accuracy-ticket]");
    if (ticket) {
      window.cdOpenTicket?.(
        ticket.dataset.accuracyTicket,
        ticket.dataset.accuracySide === "SELL" ? "SELL" : "BUY",
        {
          stopLoss: Number(ticket.dataset.accuracyStop),
          target: Number(ticket.dataset.accuracyTarget),
        }
      );
      return;
    }
    const analysis = e.target.closest("[data-accuracy-coin]");
    if (analysis) {
      window.cdOpenSheet?.(analysis.dataset.accuracyCoin);
    }
  });

  const active = () => overlay.classList.contains("active") || overlay.classList.contains("is-active");
  function ensureLoaded() {
    if (active() && !scanning && (!data || Date.now() - loadedAt > STALE_MS)) {
      load();
    }
  }

  // Auto-refresh every 60s when tab is visible
  setInterval(() => {
    if (active() && !document.hidden && !scanning && Date.now() - loadedAt >= 60000) {
      load(true);
    }
  }, 5000);

  let wasActive = active();
  new MutationObserver(() => {
    const now = active();
    if (now && !wasActive) ensureLoaded();
    wasActive = now;
  }).observe(overlay, { attributes: true, attributeFilter: ["class"] });

  window.cdOpenAccuracy = function () {
    document.querySelector('.sidebar .app-tab[data-tab="accuracy"]')?.click();
    load();
  };

  ensureLoaded();
})();
