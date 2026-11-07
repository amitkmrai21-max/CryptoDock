// Catch Accuracy: owner-only BTC-aligned SFP swing scanner. Keeps existing CryptoDock card theme.
(function catchAccuracy() {
  const overlay = document.getElementById("cdCatchAcc");
  const results = document.getElementById("cdCatchResults");
  const meta = document.getElementById("cdCatchMeta");
  const refreshBtn = document.getElementById("cdCatchRefresh");
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
  let tab = "1h", data = null, error = "", scanning = false, loadedAt = 0;
  const STALE_MS = 120000;

  async function getToken() {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      try { const { data: s } = await window.marketDockSupabase.auth.getSession(); if (s?.session?.access_token) return s.session.access_token; } catch (_) {}
      await sleep(400);
    }
    throw new Error("Please sign in to access Catch Accuracy.");
  }
  async function fetchScan(fresh) {
    const bearer = await getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch("/api/owner/catch-accuracy" + (fresh ? "?refresh=1" : ""), {
        headers: { Authorization: `Bearer ${bearer}` }, cache: "no-store", signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { const e = new Error(body.detail || "Catch Accuracy is unavailable."); e.status = response.status; throw e; }
      return body;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("The scan took too long. Tap refresh to try again.");
      throw e;
    } finally { clearTimeout(timer); }
  }
  function ticketStar(base) {
    const on = typeof window.cdIsWatched === "function" && window.cdIsWatched(base);
    return `<button type="button" class="cd-fr-star${on ? " is-on" : ""}" data-catch-star="${esc(base)}" aria-label="Watchlist">${on ? "★" : "☆"}</button>`;
  }
  function card(item) {
    const bull = item.side === "bullish", dir = bull ? "LONG" : "SHORT";
    const coin = coinOf(item.base);
    const price = Number(coin?.price) > 0 ? Number(coin.price) : Number(item.price);
    const change = Number(coin?.change_percent ?? item.change_percent) || 0;
    const rank = window.cdVolumeRank?.(item.base);
    const move = (v) => ((Number(v) - Number(item.entry)) / Number(item.entry)) * 100;
    const targetLabel = (n) => `${n > 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
    const isFib = item.kind === "fib";

    const badgePill = isFib ? `📐 FIB PULLBACK · ${dir}` : `✅ SFP CONFIRMED · ${dir}`;
    const tagText = isFib ? `GOLDEN POCKET 0.5–0.618 (ADX ${item.adx || 25})` : `${esc(item.key_tf || "KEY LEVEL")} LIQUIDITY SWEEP`;
    const subTitle = isFib ? `1H FIB PULLBACK · ADX ${item.adx || 25}` : `${esc(item.timeframe?.toUpperCase() || "SWING")} SFP · ${rank ? `#${rank.rank} by volume` : "liquid market"}`;

    const step2Title = isFib ? "Trend & ADX" : "Liquidity";
    const step2Desc = isFib ? `ADX ${item.adx || 20}+ · EMA20/50` : `${esc(item.key_tf || "")} level swept`;
    const step3Title = isFib ? "Discount Zone" : "Reclaim";
    const step3Desc = isFib ? "0.50 – 0.618 Golden Pocket" : "Closed candle back inside";
    const step4Title = "Risk";
    const step4Desc = `${pct(item.risk_pct)} · 1:${item.rr1 || 1.5} / 1:${item.rr2 || 2.5}`;

    const infoLine = isFib
      ? `<i>Fib 0.618</i> <b>${money(item.fib_level)}</b> · <i>High</i> <b>${money(item.swing_high)}</b> · <i>Low</i> <b>${money(item.swing_low)}</b> · ${ago(item.candle_at)}`
      : `<i>Key level</i> <b>${money(item.level)}</b> · <i>Trigger close</i> <b>${money(item.trigger_close)}</b> · ${ago(item.candle_at)}`;

    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      <div class="cd-fr-head">
        <span class="cd-fr-avatar">${window.cdFormat?.avatar ? window.cdFormat.avatar(item.base) : ""}</span>
        <div class="cd-fr-id"><strong>${esc(item.base)}<span>/USDT</span></strong><small>${subTitle}</small></div>
        <div class="cd-fr-px"><b>${money(price)}</b><small class="${change >= 0 ? "cd-up" : "cd-down"}">${pct(change, true)}</small></div>${ticketStar(item.base)}
      </div>
      <div class="cd-fr-tags"><span class="cd-fr-pill">${badgePill}</span><span class="cd-fr-tag">${tagText}</span></div>
      <div class="cd-fr-levels">
        <div><span>Entry</span><b>${money(item.entry)}</b><em></em></div>
        <div><span>Stop · ${pct(item.risk_pct)}</span><b class="cd-down">${money(item.stop)}</b><em class="cd-down">${isFib ? "Past 0.786 Fib" : "Risk capped at 1.5%"}</em></div>
        <div><span>Target 1 · 1:${item.rr1 || 1.5}</span><b>${money(item.t1)}</b><em class="${bull ? "cd-up" : "cd-down"}">(${targetLabel(move(item.t1))})</em></div>
        <div><span>Target 2 · 1:${item.rr2 || 2.5}</span><b>${money(item.t2)}</b><em class="${bull ? "cd-up" : "cd-down"}">(${targetLabel(move(item.t2))})</em></div>
      </div>
      <div class="cd-fr-steps cd-fr-steps-wide">
        <div class="cd-fr-step is-ok"><b>BTC 4H</b><i>✓</i><small>${bull ? "Bullish · Longs only" : "Bearish · Shorts only"}</small></div>
        <div class="cd-fr-step is-ok"><b>${step2Title}</b><i>✓</i><small>${step2Desc}</small></div>
        <div class="cd-fr-step is-ok"><b>${step3Title}</b><i>✓</i><small>${step3Desc}</small></div>
        <div class="cd-fr-step is-ok"><b>${step4Title}</b><i>✓</i><small>${step4Desc}</small></div>
      </div>
      <small class="cd-fr-ema">${infoLine}</small>
      <div class="cd-fr-actions">
        <button type="button" class="cd-fr-ticket ${bull ? "is-buy" : "is-sell"}" data-catch-ticket="${esc(item.base)}" data-catch-side="${bull ? "BUY" : "SELL"}" data-catch-stop="${esc(item.stop)}" data-catch-target="${esc(item.t1)}">⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button>
        <button type="button" class="cd-fr-analysis" data-catch-coin="${esc(item.base)}">📊 Analysis</button>
      </div>
    </article>`;
  }
  function render() {
    const all = data?.full || [];
    const count1h = all.filter((x) => x.timeframe === "1h" && x.kind !== "fib").length;
    const count15m = all.filter((x) => x.timeframe === "15m" && x.kind !== "fib").length;
    const countFib = all.filter((x) => x.timeframe === "fib" || x.kind === "fib").length;

    const b1h = document.querySelector('#cdCatchTabs [data-catch-tab="1h"]');
    const b15m = document.querySelector('#cdCatchTabs [data-catch-tab="15m"]');
    const bfib = document.querySelector('#cdCatchTabs [data-catch-tab="fib"]');
    if (b1h) b1h.textContent = data ? `1H Swings (${count1h})` : "1H Swings";
    if (b15m) b15m.textContent = data ? `15m Swings (${count15m})` : "15m Swings";
    if (bfib) bfib.textContent = data ? `📐 Fib + Trend (${countFib})` : "📐 Fib + Trend";

    document.querySelectorAll("#cdCatchTabs button").forEach((b) => b.classList.toggle("is-active", b.dataset.catchTab === tab));
    const btc = data?.btc || {};
    const side = btc.side || "neutral";
    const biasText = side === "bullish" ? "BTC 4H BULLISH · LONGS ONLY" : side === "bearish" ? "BTC 4H BEARISH · SHORTS ONLY" : "BTC 4H NEUTRAL · WAIT";
    const biasClass = side === "bullish" ? "is-bull" : side === "bearish" ? "is-bear" : "";
    const list = (data?.full || []).filter((x) => tab === "fib" ? (x.timeframe === "fib" || x.kind === "fib") : (x.timeframe === tab && x.kind !== "fib"));
        if (!data) {
      meta.textContent = error ? "Scan unavailable" : "Checking BTC bias and swing setups…";
      results.innerHTML = error ? `<p class="cd-focus-error">${esc(error)}</p>` : '<p class="cd-focus-loading">Scanning liquid coins on closed 15m / 1H candles…</p>';
      return;
    }
    const btcPrice = Number(btc.price) > 0 ? ` · BTC ${money(btc.price)}` : "";
    const btcEma = Number(btc.ema50) > 0 ? ` · 4H EMA 50 ${money(btc.ema50)}` : "";
    const banner = `<div class="cd-fr-summary ${biasClass}"><div><b>${esc(biasText)}</b><small>${esc(btc.reason || data.message || "")}${btcPrice}${btcEma}</small></div></div>`;
    meta.textContent = `${list.length} ${tab.toUpperCase()} setups · ${all.length} total · scanned ${Number(data.scanned) || 0} coins`;
    const empty = side === "neutral" ? "BTC trend is mixed" : tab === "fib" ? "No confirmed Fib Golden Pocket setups right now" : `No confirmed ${tab.toUpperCase()} SFP setups right now`;
    const detail = side === "neutral" ? (btc.reason || "Waiting for a clearer BTC 4H direction. No direction is being forced.") : tab === "fib" ? "Waiting for coins in an active trend (ADX > 20, EMA20/50 aligned) currently pulling back into the 0.50–0.618 Golden Pocket." : "The scanner needs a closed-candle sweep and reclaim, BTC trend alignment, and a stop within the 1.5% cap. No setup is not a trade signal.";
    results.innerHTML = banner + (list.length ? list.map(card).join("") : `<div class="cd-focus-empty"><strong>${esc(empty)}</strong><p>${esc(detail)}</p></div>`) + '<p class="cd-fr-note">Closed-candle SFP swing scanner with BTC 4H trend alignment. Levels are estimates from market data, not guaranteed outcomes. Confirm the live chart, slippage, fees, and position size; risk no more than 1% of account equity per trade. This setup has not been independently backtested.</p>';
  }
  async function load(fresh = false) {
    if (scanning) return;
    scanning = true; overlay.classList.add("is-loading"); if (refreshBtn) refreshBtn.disabled = true;
    data = null; error = ""; render();
    try { data = await fetchScan(fresh); loadedAt = Date.now(); }
    catch (e) { error = e.status === 401 || e.status === 403 ? "Owner session required." : (e.message || "Could not load Catch Accuracy."); }
    scanning = false; overlay.classList.remove("is-loading"); if (refreshBtn) refreshBtn.disabled = false; render();
  }
  document.getElementById("cdCatchTabs")?.addEventListener("click", (event) => {
    const b = event.target.closest("button[data-catch-tab]"); if (!b || b.dataset.catchTab === tab) return;
    tab = b.dataset.catchTab; render();
  });
  const active = () => overlay.classList.contains("active");
  function ensureLoaded() { if (active() && !scanning && (!data || Date.now() - loadedAt > STALE_MS)) load(); }
  let wasActive = active();
  new MutationObserver(() => { const now = active(); if (now && !wasActive) ensureLoaded(); wasActive = now; }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
  window.cdOpenCatchAccuracy = function () { if (!active()) document.querySelector('.sidebar .app-tab[data-tab="catchaccuracy"]')?.click(); load(); };
  refreshBtn?.addEventListener("click", () => load(true));
  results.addEventListener("click", (event) => {
    const star = event.target.closest("[data-catch-star]");
    if (star) { window.cdToggleWatch?.(star.dataset.catchStar); render(); return; }
    const ticket = event.target.closest("[data-catch-ticket]");
    if (ticket) { window.cdOpenTicket?.(ticket.dataset.catchTicket, ticket.dataset.catchSide === "SELL" ? "SELL" : "BUY", { stopLoss: Number(ticket.dataset.catchStop), target: Number(ticket.dataset.catchTarget) }); return; }
    const analysis = event.target.closest("[data-catch-coin]"); if (analysis) window.cdOpenSheet?.(analysis.dataset.catchCoin);
  });
  ensureLoaded();
})();
