// Trader Setups Confluence Scanner (Owner Only)
// Frameworks: Gautam Jha (Liquidity Traps / False Breakouts) & Booming Bulls (VWAP + Golden Fib Retracement)
(function traderSetupsModule() {
  const overlay = document.getElementById("cdTraderSetups");
  const results = document.getElementById("cdTraderSetupsResults");
  const meta = document.getElementById("cdTraderSetupsMeta");
  const refreshBtn = document.getElementById("cdTraderSetupsRefresh");
  const tgBtn = document.getElementById("cdTraderSetupsTgTest");
  if (!overlay || !results || !meta) return;

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "--";
    const digits = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 5 : n >= 0.0001 ? 6 : 8;
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) });
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

  let filterTab = "all"; // "all" | "gautam" | "booming" | "long" | "short"
  let currentTimeframe = "15m"; // "5m" | "15m" | "1h"
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
    throw new Error("Please sign in with the owner account to access Trader Setups.");
  }

  async function fetchScan(fresh) {
    const bearer = await getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const url = `/api/owner/trader-setups?interval=${encodeURIComponent(currentTimeframe)}${fresh ? "&refresh=1" : ""}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${bearer}` },
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const e = new Error(body.detail || "Trader Setups scanner is currently unavailable.");
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
    if (filterTab === "gautam") return all.filter((s) => s.strategy === "Gautam Jha");
    if (filterTab === "booming") return all.filter((s) => s.strategy === "Booming Bulls");
    if (filterTab === "long") return all.filter((s) => s.side === "LONG");
    if (filterTab === "short") return all.filter((s) => s.side === "SHORT");
    return all;
  }

  function renderCard(s) {
    const bull = s.side === "LONG";
    const dir = bull ? "LONG" : "SHORT";
    const base = s.symbol.replace("USDT", "");
    const avatar = window.cdFormat?.avatar ? window.cdFormat.avatar(base) : "🏆";
    const timeText = ago(s.candle_close_time || s.scanned_at);
    const vol = s.volume_surge || 1.0;
    const isGautam = s.strategy === "Gautam Jha";

    return `
      <article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(base)}">
        <div class="cd-fr-head">
          <span class="cd-fr-avatar">${avatar}</span>
          <div class="cd-fr-id">
            <strong>${esc(base)}<span>/USDT</span></strong>
            <small>${esc(s.strategy)} · ${esc(s.category)} · ${esc(s.interval || currentTimeframe)}</small>
          </div>
          <div class="cd-fr-px">
            <b>${money(s.current_price || s.entry)}</b>
            <small class="${bull ? "cd-up" : "cd-down"}">${bull ? "▲ BULLISH" : "▼ BEARISH"}</small>
          </div>
        </div>

        <div class="cd-fr-tags">
          <span class="cd-fr-pill">${bull ? "🟢" : "🔴"} ${dir} · ${esc(s.setup_name)}</span>
          <span class="cd-fr-tag" style="background:${isGautam ? "rgba(16,185,129,0.18)" : "rgba(245,158,11,0.18)"}; color:${isGautam ? "#34d399" : "#fbbf24"}; font-weight:700;">
            ${isGautam ? "🎯 Gautam Jha Trap" : "⚡ Booming Bulls Trend"}
          </span>
          ${s.level_swept ? `<span class="cd-fr-tag cd-tag-purple">📍 ${esc(s.level_swept)}</span>` : ""}
          <span class="cd-fr-tag cd-tag-amber">🔥 ${vol}x Vol</span>
          <span class="cd-fr-tag" style="margin-left:auto;">🕒 ${esc(timeText)}</span>
        </div>

        <div class="cd-fr-levels">
          <div>
            <span>Entry (Closed)</span>
            <b style="color:#fff">${money(s.entry)}</b>
            <em class="${bull ? "cd-up" : "cd-down"}">Confirmed</em>
          </div>
          <div>
            <span>Stop Loss</span>
            <b class="cd-down">${money(s.stop_loss)}</b>
            <em class="cd-down">Invalidation</em>
          </div>
          <div>
            <span>Target 1 (${esc(s.rr_1 || "1:1.6")})</span>
            <b class="cd-up">${money(s.target_1)}</b>
            <em class="cd-up">Primary</em>
          </div>
          <div>
            <span>Target 2 (${esc(s.rr_2 || "1:2.6")})</span>
            <b class="cd-up">${money(s.target_2)}</b>
            <em class="cd-up">Extension</em>
          </div>
        </div>

        <div class="cd-fr-summary">
          <p><strong>Rationale:</strong> ${esc(s.summary || "")}</p>
        </div>

        <div class="cd-fr-actions">
          <button type="button" class="cd-fr-ticket ${bull ? "is-buy" : "is-sell"}"
            data-trader-ticket="${esc(base)}"
            data-trader-side="${bull ? "BUY" : "SELL"}"
            data-trader-stop="${esc(s.stop_loss)}"
            data-trader-target="${esc(s.target_1)}">
            ⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}
          </button>
          <button type="button" class="cd-fr-analysis" data-trader-coin="${esc(base)}">
            📊 Analysis
          </button>
        </div>
      </article>
    `;
  }

  function render() {
    if (scanning && !data) {
      meta.textContent = `Scanning top pairs for Gautam Jha & Booming Bulls setups on ${currentTimeframe}…`;
      results.innerHTML = `
        <div class="cd-focus-empty">
          <div class="cd-smartmtf-spinner" style="margin: 0 auto 12px auto;"></div>
          <strong>Scanning Trader Setups (${currentTimeframe})</strong>
          <p>Analyzing PDH/PDL liquidity traps and VWAP + Golden Fib retracements…</p>
        </div>
      `;
      return;
    }

    if (error) {
      meta.textContent = "Scan unavailable";
      results.innerHTML = `
        <div class="cd-focus-empty" style="border-color: rgba(239, 68, 68, 0.4);">
          <strong style="color: #ef4444;">Trader Setups Notice</strong>
          <p>${esc(error)}</p>
          <button type="button" class="cd-fr-ticket is-buy" id="cdTraderSetupsRetry" style="margin-top:12px; display:inline-block; padding: 6px 14px;">↻ Retry Scan</button>
        </div>
      `;
      document.getElementById("cdTraderSetupsRetry")?.addEventListener("click", () => load(true));
      return;
    }

    const allSetups = data?.setups || [];
    const filtered = filterSetups(allSetups);
    const scanned = data?.scanned || 35;

    meta.textContent = `${allSetups.length} Setup${allSetups.length === 1 ? "" : "s"} Found · Scanned ${scanned} liquid pairs (${currentTimeframe})`;

    if (!filtered.length) {
      results.innerHTML = `
        <div class="cd-focus-empty">
          <strong>No active setups right now on ${currentTimeframe}</strong>
          <p>Looking for PDH/PDL liquidity traps (Gautam Jha) and VWAP 50%-61.8% Golden Fib pullbacks (Booming Bulls) on closed candles.</p>
        </div>
      `;
      return;
    }

    results.innerHTML = filtered.map(renderCard).join("") + `
      <p class="cd-fr-note">Trader Setups Scanner · Pure execution based on institutional liquidity traps and VWAP Golden Fib confluence. Educational pattern recognition.</p>
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
    render();
    try {
      const res = await fetchScan(fresh);
      data = res;
      error = "";
      loadedAt = Date.now();
    } catch (e) {
      error = e.message || "Failed to load trader setups.";
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

  function ensureLoaded() {
    if (!data || Date.now() - loadedAt > STALE_MS) {
      load();
    }
  }

  // Filter Tabs click
  document.getElementById("cdTraderSetupsTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-trader-filter]");
    if (!btn) return;
    filterTab = btn.dataset.traderFilter;
    document.querySelectorAll("#cdTraderSetupsTabs button[data-trader-filter]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.traderFilter === filterTab);
    });
    render();
  });

  // Timeframe Tabs click
  document.querySelectorAll("#cdTraderSetups [data-trader-tf]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tf = btn.dataset.traderTf;
      if (tf === currentTimeframe) return;
      currentTimeframe = tf;
      document.querySelectorAll("#cdTraderSetups [data-trader-tf]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.traderTf === currentTimeframe);
      });
      data = null;
      load(true);
    });
  });

  // Refresh Button click
  refreshBtn?.addEventListener("click", () => load(true));

  // Telegram Test Button
  tgBtn?.addEventListener("click", async () => {
    const prevText = tgBtn.textContent;
    tgBtn.disabled = true;
    tgBtn.textContent = "Sending…";
    try {
      const bearer = await getToken();
      const res = await fetch("/api/owner/telegram-trader-setups/test", {
        headers: { Authorization: `Bearer ${bearer}` }
      });
      const b = await res.json().catch(() => ({}));
      if (res.ok && b.ok) {
        tgBtn.textContent = "✅ Sent!";
      } else {
        alert("Telegram alert failed: " + (b.detail || "Check bot token / chat ID"));
        tgBtn.textContent = "❌ Failed";
      }
    } catch (err) {
      alert("Error: " + err.message);
      tgBtn.textContent = "❌ Error";
    } finally {
      setTimeout(() => {
        tgBtn.disabled = false;
        tgBtn.textContent = prevText;
      }, 3000);
    }
  });

  // Open Paper Ticket
  results.addEventListener("click", (e) => {
    const ticket = e.target.closest("[data-trader-ticket]");
    if (ticket && typeof window.cdOpenPaperTicket === "function") {
      window.cdOpenPaperTicket(
        ticket.dataset.traderTicket,
        ticket.dataset.traderSide === "SELL" ? "SELL" : "BUY",
        {
          stopLoss: Number(ticket.dataset.traderStop),
          target: Number(ticket.dataset.traderTarget),
        }
      );
      return;
    }
    const analysis = e.target.closest("[data-trader-coin]");
    if (analysis) {
      window.cdOpenSheet?.(analysis.dataset.traderCoin);
    }
  });

  // Tab Activation Observer
  let wasActive = false;
  new MutationObserver(() => {
    const now = overlay.classList.contains("active");
    if (now && !wasActive) ensureLoaded();
    wasActive = now;
  }).observe(overlay, { attributes: true, attributeFilter: ["class"] });

  window.cdOpenTraderSetups = function () {
    document.querySelector('.sidebar .app-tab[data-tab="tradersetups"]')?.click();
    load();
  };

  ensureLoaded();
})();
