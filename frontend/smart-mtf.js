// Smart MTF: Dedicated owner-only 1W->1D->1H->15m Multi-Timeframe Confluence Scanner.
(function smartMtfModule() {
  const overlay = document.getElementById("cdSmartMtf");
  const results = document.getElementById("cdSmartMtfResults");
  const meta = document.getElementById("cdSmartMtfMeta");
  const refreshBtn = document.getElementById("cdSmartMtfRefresh");
  if (!overlay || !results || !meta) return;

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v) => {
    const n = Number(v); if (!Number.isFinite(n)) return "--";
    const digits = n >= 1000 ? 2 : n >= 10 ? 3 : n >= 1 ? 4 : n >= .1 ? 5 : 6;
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: digits });
  };
  const pct = (v, signed = false) => Number.isFinite(Number(v)) ? `${signed && Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)}%` : "--";
  const ago = (ts) => { const m = Math.max(0, Math.round((Date.now() / 1000 - Number(ts)) / 60)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
  const coinOf = (base) => window.cdMarkets?.coinsByBase?.get?.(base) || null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let filterTab = "all"; // "all" | "confirmed" | "inzone"
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
    throw new Error("Please sign in to access Smart MTF.");
  }

  async function fetchScan(fresh) {
    const bearer = await getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch("/api/owner/smart-mtf" + (fresh ? "?refresh=1" : ""), {
        headers: { Authorization: `Bearer ${bearer}` },
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const e = new Error(body.detail || "Smart MTF is unavailable.");
        e.status = response.status;
        throw e;
      }
      return body;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("The scan took too long. Tap refresh to try again.");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function ticketStar(base) {
    const on = typeof window.cdIsWatched === "function" && window.cdIsWatched(base);
    return `<button type="button" class="cd-fr-star ${on ? "is-active" : ""}" data-smart-star="${esc(base)}" aria-label="Toggle watchlist">${on ? "★" : "☆"}</button>`;
  }

  function card(item) {
    const bull = item.side === "bullish", dir = bull ? "LONG" : "SHORT";
    const coin = coinOf(item.base);
    const price = Number(coin?.price) > 0 ? Number(coin.price) : Number(item.price);
    const change = Number(coin?.change_percent ?? item.change_percent) || 0;
    const move = (v) => ((Number(v) - Number(item.entry)) / Number(item.entry)) * 100;
    const targetLabel = (n) => `${n > 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
    const isConfirmed = item.trigger_state === "CONFIRMED";

    const badgePill = isConfirmed ? `🎯 SMART MTF · ${dir}` : `⏳ MTF IN ZONE · ${dir}`;
    const tagText = `1W/1D PIVOT + FIB 0.618 + 15m REJECT`;
    const subTitle = `1W·1D·1H·15m SMART CONFLUENCE · ${isConfirmed ? "TRIGGER CONFIRMED" : "IN ZONE"}`;

    const step1Title = "1W/1D Levels";
    const step1Desc = `1W ${money(item.w_level)} · 1D ${money(item.d_level)}`;
    const step2Title = "1H Trend & ADX";
    const step2Desc = `ADX ${item.adx || 20}+ · EMA20/50`;
    const step3Title = "Fib OTE Zone";
    const step3Desc = item.fib_zone || "0.50 – 0.618 OTE";
    const step4Title = "15m Trigger";
    const step4Desc = isConfirmed ? "Rejection Wick Confirmed" : "In Confluence Zone";

    const infoLine = `<i>1W Pivot</i> <b>${money(item.w_level)}</b> · <i>1D Level</i> <b>${money(item.d_level)}</b> · <i>Fib 0.618</i> <b>${money(item.fib_level)}</b> · ${ago(item.candle_at)}`;

    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      <div class="cd-fr-head">
        <span class="cd-fr-avatar">${window.cdFormat?.avatar ? window.cdFormat.avatar(item.base) : ""}</span>
        <div class="cd-fr-id"><strong>${esc(item.base)}<span>/USDT</span></strong><small>${subTitle}</small></div>
        <div class="cd-fr-px"><b>${money(price)}</b><small class="${change >= 0 ? "cd-up" : "cd-down"}">${pct(change, true)}</small></div>${ticketStar(item.base)}
      </div>
      <div class="cd-fr-tags"><span class="cd-fr-pill">${badgePill}</span><span class="cd-fr-tag">${tagText}</span></div>
      <div class="cd-fr-levels">
        <div><span>Entry</span><b>${money(item.entry)}</b><em></em></div>
        <div><span>Stop · ${pct(item.risk_pct)}</span><b class="cd-down">${money(item.stop)}</b><em class="cd-down">Past 0.786</em></div>
        <div><span>T1 · 1:${item.rr1 || 1.5}</span><b>${money(item.t1)}</b><em class="${bull ? "cd-up" : "cd-down"}">(${targetLabel(move(item.t1))})</em></div>
        <div><span>T2 · 1:${item.rr2 || 2.5}</span><b>${money(item.t2)}</b><em class="${bull ? "cd-up" : "cd-down"}">(${targetLabel(move(item.t2))})</em></div>
      </div>
      <div class="cd-fr-steps cd-fr-steps-wide">
        <div class="cd-fr-step is-ok"><b>${step1Title}</b><i>✓</i><small>${step1Desc}</small></div>
        <div class="cd-fr-step is-ok"><b>${step2Title}</b><i>✓</i><small>${step2Desc}</small></div>
        <div class="cd-fr-step is-ok"><b>${step3Title}</b><i>✓</i><small>${step3Desc}</small></div>
        <div class="cd-fr-step ${isConfirmed ? "is-ok" : ""}"><b>${step4Title}</b><i>${isConfirmed ? "✓" : "⏳"}</i><small>${step4Desc}</small></div>
      </div>
      <small class="cd-fr-ema">${infoLine}</small>
      <div class="cd-fr-actions">
        <button type="button" class="cd-fr-ticket ${bull ? "is-buy" : "is-sell"}" data-smart-ticket="${esc(item.base)}" data-smart-side="${bull ? "BUY" : "SELL"}" data-smart-stop="${esc(item.stop)}" data-smart-target="${esc(item.t1)}">⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button>
        <button type="button" class="cd-fr-analysis" data-smart-coin="${esc(item.base)}">📊 Analysis</button>
      </div>
    </article>`;
  }

  function render() {
    const all = Array.isArray(data?.full) ? data.full : [];
    let list = all;
    if (filterTab === "confirmed") {
      list = all.filter((x) => x.trigger_state === "CONFIRMED");
    } else if (filterTab === "inzone") {
      list = all.filter((x) => x.trigger_state !== "CONFIRMED");
    }

    const btc = data?.btc || {};
    const side = btc.side || "neutral";
    const biasClass = side === "bullish" ? "is-bullish" : side === "bearish" ? "is-bearish" : "is-neutral";
    const biasText = side === "bullish" ? "BTC 4H Bullish (Longs only)" : side === "bearish" ? "BTC 4H Bearish (Shorts only)" : "BTC 4H Trend Mixed";

    // Update active tab button style
    document.querySelectorAll("#cdSmartMtfTabs button").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.smartFilter === filterTab);
    });

    if (error || !data) {
      meta.textContent = error ? "Scan unavailable" : "Checking BTC bias and Smart MTF setups…";
      results.innerHTML = error
        ? `<p class="cd-focus-error">${esc(error)}</p>`
        : '<p class="cd-focus-loading">Scanning liquid Binance markets on closed 1W, 1D, 1H and 15m candles…</p>';
      return;
    }

    const btcPrice = Number(btc.price) > 0 ? ` · BTC ${money(btc.price)}` : "";
    const btcEma = Number(btc.ema50) > 0 ? ` · 4H EMA 50 ${money(btc.ema50)}` : "";
    const banner = `<div class="cd-fr-summary ${biasClass}"><div><b>${esc(biasText)}</b><small>${esc(btc.reason || data.message || "")}${btcPrice}${btcEma}</small></div></div>`;

    const confirmedCount = all.filter((x) => x.trigger_state === "CONFIRMED").length;
    const inZoneCount = all.length - confirmedCount;
    meta.textContent = `${confirmedCount} Confirmed Trigger · ${inZoneCount} In Zone · Scanned ${Number(data.scanned) || 0} liquid coins`;

    const empty = side === "neutral"
      ? "BTC trend is mixed"
      : filterTab === "confirmed"
      ? "No 15m Trigger Confirmed setups right now"
      : filterTab === "inzone"
      ? "No setups currently inside the Golden Pocket zone"
      : "No Smart MTF Confluence setups found";

    const detail = side === "neutral"
      ? (btc.reason || "Waiting for clearer BTC 4H direction. No trades forced.")
      : "Pure Smart MTF scans 1W turning points, 1D S/R structure, 1H Fib Golden Pocket (0.50–0.618 OTE), and 15m rejection wicks. Confirmed setups appear automatically.";

    results.innerHTML = banner + (list.length ? list.map(card).join("") : `<div class="cd-focus-empty"><strong>${esc(empty)}</strong><p>${esc(detail)}</p></div>`) +
      '<p class="cd-fr-note">Original Smart MTF Confluence engine. All levels are derived from closed 1W, 1D, 1H and 15m candles. Always confirm live chart, spread, and risk before trading.</p>';
  }

  async function load(fresh = false) {
    if (scanning) return;
    scanning = true;
    overlay.classList.add("is-loading");
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.classList.add("is-spinning"); }
    data = null;
    error = "";
    render();
    try {
      data = await fetchScan(fresh);
      loadedAt = Date.now();
    } catch (e) {
      error = e.status === 401 || e.status === 403 ? "Owner session required." : (e.message || "Could not load Smart MTF.");
    }
    scanning = false;
    overlay.classList.remove("is-loading");
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.classList.remove("is-spinning"); }
    render();
  }

  document.getElementById("cdSmartMtfTabs")?.addEventListener("click", (event) => {
    const b = event.target.closest("button[data-smart-filter]");
    if (!b || b.dataset.smartFilter === filterTab) return;
    filterTab = b.dataset.smartFilter;
    render();
  });

  const active = () => overlay.classList.contains("active");
  function ensureLoaded() {
    if (active() && !scanning && (!data || Date.now() - loadedAt > STALE_MS)) load();
  }

  // Auto-refresh every minute while Smart MTF is open and the page is visible.
  const AUTO_REFRESH_MS = 60000;
  setInterval(() => {
    if (active() && !document.hidden && !scanning && Date.now() - loadedAt >= AUTO_REFRESH_MS) load(true);
  }, 5000);

  let wasActive = active();
  new MutationObserver(() => {
    const now = active();
    if (now && !wasActive) ensureLoaded();
    wasActive = now;
  }).observe(overlay, { attributes: true, attributeFilter: ["class"] });

  window.cdOpenSmartMtf = function () {
    if (!active()) {
      document.querySelector('.sidebar .app-tab[data-tab="smartmtf"]')?.click();
    }
    load();
  };

  const tgBtn = document.getElementById("cdSmartMtfTgTest");
  tgBtn?.addEventListener("click", async () => {
    try {
      tgBtn.disabled = true;
      tgBtn.textContent = "Sending...";
      const bearer = await getToken();
      const res = await fetch("/api/owner/telegram-smart-mtf/test", {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        tgBtn.textContent = "✓ Sent!";
        setTimeout(() => { tgBtn.textContent = "📲 Test TG"; tgBtn.disabled = false; }, 3000);
      } else {
        alert("Telegram Error: " + (json.detail || "Failed to send alert"));
        tgBtn.textContent = "📲 Test TG";
        tgBtn.disabled = false;
      }
    } catch (e) {
      alert("Error: " + e.message);
      tgBtn.textContent = "📲 Test TG";
      tgBtn.disabled = false;
    }
  });

  refreshBtn?.addEventListener("click", () => load(true));

  results.addEventListener("click", (event) => {
    const star = event.target.closest("[data-smart-star]");
    if (star) { window.cdToggleWatch?.(star.dataset.smartStar); render(); return; }
    const ticket = event.target.closest("[data-smart-ticket]");
    if (ticket) {
      window.cdOpenTicket?.(ticket.dataset.smartTicket, ticket.dataset.smartSide === "SELL" ? "SELL" : "BUY", {
        stopLoss: Number(ticket.dataset.smartStop),
        target: Number(ticket.dataset.smartTarget),
      });
      return;
    }
    const analysis = event.target.closest("[data-smart-coin]");
    if (analysis) window.cdOpenSheet?.(analysis.dataset.smartCoin);
  });

  ensureLoaded();
})();
