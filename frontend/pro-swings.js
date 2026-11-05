// Pro Swings (owner only): 20/50 EMA Pullback swing trading setups on 15m and 1H candles.
// Server: /api/owner/pro-swings (shared 3 minute cache; ?refresh=1 rescans).
(function proSwings() {
  const overlay = document.getElementById("cdProSwings");
  const results = document.getElementById("cdProSwingsResults");
  const meta = document.getElementById("cdProSwingsMeta");
  const refreshBtn = document.getElementById("cdProSwingsRefresh");
  const filterBtn = document.getElementById("cdProSwingsFilter");
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

  let tab = "15m";              // '15m' | '1h'
  let dirFilter = "all";        // 'all' | 'bullish' | 'bearish'
  const FILTER_LABEL = { all: "All", bullish: "Bull", bearish: "Bear" };
  let data = null;
  let scanning = false;
  let loadedAt = 0;
  const STALE_MS = 90 * 1000;

  // ---------- network ----------
  async function token() {
    const until = Date.now() + 6000;
    for (;;) {
      try {
        const { data: session } = await window.marketDockSupabase?.auth?.getSession();
        const t = session?.session?.access_token;
        if (t) return t;
      } catch (e) { /* supabase auth client may not be ready yet */ }
      if (Date.now() >= until) throw new Error("Please sign in to access Pro Swings.");
      await sleep(400);
    }
  }

  async function fetchProSwings(fresh) {
    const bearer = await token();
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 40000);
        let response;
        try {
          response = await fetch("/api/owner/pro-swings" + (fresh ? "?refresh=1" : ""), {
            headers: { Authorization: `Bearer ${bearer}` },
            cache: "no-store",
            signal: controller.signal
          });
        } finally { clearTimeout(timer); }
        const body = await response.json().catch(() => ({}));
        if (response.ok) return body;
        const err = new Error(body.detail || "Pro Swings is unavailable."); err.status = response.status;
        if (response.status < 500) throw err;
        last = err;
      } catch (e) {
        if (e.status && e.status < 500) throw e;
        last = e;
      }
      if (attempt < 1) await sleep(1500);
    }
    throw last && last.name === "AbortError" ? new Error("The scan took too long. Tap the refresh arrow to try again.") : (last || new Error("Pro Swings is unavailable."));
  }

  // ---------- building blocks ----------
  function spark(values, up) {
    if (!Array.isArray(values) || values.length < 2) return "";
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(30 - ((v - lo) / span) * 28 - 1).toFixed(1)}`).join(" ");
    return `<svg class="cd-fr-spark ${up ? "is-up" : "is-down"}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function step(title, sub, state) {
    const mark = state === "ok" ? "✓" : state === "live" ? "⚡" : "⏳";
    return `<div class="cd-fr-step is-${state}"><b>${title}</b><i>${mark}</i><small>${sub}</small></div>`;
  }

  function star(base) {
    const on = typeof window.cdIsWatched === "function" && window.cdIsWatched(base);
    return `<button type="button" class="cd-fr-star${on ? " is-on" : ""}" data-pro-star="${esc(base)}" aria-label="Watchlist">${on ? "★" : "☆"}</button>`;
  }

  function head(item, up) {
    const coin = coinOf(item.base);
    const price = coin && Number.isFinite(coin.price) ? coin.price : Number(item.price);
    const change = coin ? Number(coin.change_percent) : Number(item.change_percent) || 0;
    const rank = window.cdVolumeRank ? window.cdVolumeRank(item.base) : null;
    return `<div class="cd-fr-head">
      <span class="cd-fr-avatar">${F().avatar ? F().avatar(item.base) : ""}</span>
      <div class="cd-fr-id"><strong>${esc(item.base)}<span>/USDT</span></strong><small>${rank ? `#${rank.rank} by volume` : `${tab.toUpperCase()} Swing`}</small></div>
      ${spark(item.spark, up)}
      <div class="cd-fr-px"><b>${money(price)}</b><small class="${change >= 0 ? "cd-up" : "cd-down"}">${pct(change, true)}</small></div>
      ${star(item.base)}
    </div>`;
  }

  function levels(item) {
    const g = (v) => Math.abs(Number(v) - item.entry) / item.entry * 100;
    return `<div class="cd-fr-levels">
      <div><span>Entry</span><b>${money(item.entry)}</b><em></em></div>
      <div><span>SL</span><b class="cd-down">${money(item.stop)}</b><em class="cd-down">(−${g(item.stop).toFixed(1)}%)</em></div>
      <div><span>Target 1</span><b>${money(item.t1)}</b><em class="cd-up">(+${g(item.t1).toFixed(1)}%)</em></div>
      <div><span>Target 2</span><b>${money(item.t2)}</b><em class="cd-up">(+${g(item.t2).toFixed(1)}%)</em></div>
    </div>`;
  }

  function actions(item, bull) {
    return `<div class="cd-fr-actions">
      <button type="button" class="cd-fr-ticket ${bull ? "is-buy" : "is-sell"}" data-pro-ticket="${esc(item.base)}" data-pro-side="${bull ? "BUY" : "SELL"}" data-pro-stop="${esc(item.stop)}" data-pro-target="${esc(item.t1)}">⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button>
      <button type="button" class="cd-fr-analysis" data-pro-coin="${esc(item.base)}">📊 Analysis</button>
    </div>`;
  }

  function renderCard(item) {
    const bull = item.side === "bullish";
    const triggered = item.state === "triggered";
    const steps = [
      step("Trend", bull ? "EMA 20 > 50" : "EMA 20 < 50", "ok"),
      step("Pullback", "20 EMA Rejection", "ok"),
      step("Entry", triggered ? "Triggered ⚡" : "Waiting for break", triggered ? "live" : "wait"),
    ].join("");

    return `<article class="cd-fr-card ${bull ? "is-bull" : "is-bear"}" data-base="${esc(item.base)}">
      ${head(item, bull)}
      <div class="cd-fr-tags">
        <span class="cd-fr-pill">${bull ? "↗ BULLISH PULLBACK · LONG" : "↘ BEARISH PULLBACK · SHORT"}</span>
        <span class="cd-fr-tag">${tab.toUpperCase()} · SCORE ${item.score || 80}/100</span>
      </div>
      <div class="cd-fr-steps cd-fr-steps-wide">${steps}</div>
      ${levels(item)}
      <small class="cd-fr-ema"><i>EMA 20</i> <b>${money(item.ema20)}</b> · <i>EMA 50</i> <b>${money(item.ema50)}</b> · Risk: <b>${item.risk_pct}%</b> · ${triggered ? "Entry live" : `Triggers ${bull ? "above" : "below"} ${money(item.entry)}`}</small>
      ${actions(item, bull)}
    </article>`;
  }

  function render() {
    if (scanning && !data) {
      meta.textContent = "Scanning top liquid coins for pullback setups…";
      results.innerHTML = `<div class="cd-focus-empty"><p>Scanning liquid markets for 15m &amp; 1H pullbacks…</p></div>`;
      return;
    }
    if (!data) return;

    const listKey = tab === "15m" ? "swings_15m" : "swings_1h";
    let list = Array.isArray(data[listKey]) ? data[listKey] : [];
    if (dirFilter !== "all") {
      list = list.filter((x) => x.side === dirFilter);
    }

    const totalScanned = data.scanned || 0;
    const timeAgo = agoText(data.at || Date.now() / 1000);
    meta.textContent = `Scanned ${totalScanned} liquid markets · Updated ${timeAgo} · Showing ${list.length} setups`;

    // Update tab badges
    const count15m = (data.swings_15m || []).length;
    const count1h = (data.swings_1h || []).length;
    const btn15 = document.querySelector("#cdProSwingsTabs [data-pro-tab='15m']");
    const btn1h = document.querySelector("#cdProSwingsTabs [data-pro-tab='1h']");
    if (btn15) btn15.textContent = `15-Min Swings (${count15m})`;
    if (btn1h) btn1h.textContent = `1-Hour Swings (${count1h})`;

    if (list.length === 0) {
      results.innerHTML = `<div class="cd-focus-empty">
        <p>No qualifying ${tab === "15m" ? "15-Minute" : "1-Hour"} pullback setups right now.</p>
        <p style="margin-top:6px;font-size:11px;color:var(--text-muted);">Setups form when trending coins test the 20 EMA and leave a decisive rejection candle wick.</p>
      </div>`;
      return;
    }

    results.innerHTML = list.map(renderCard).join("");
  }

  async function load(fresh = false) {
    if (scanning) return;
    scanning = true;
    refreshBtn?.classList.add("is-spinning");
    if (refreshBtn) refreshBtn.disabled = true;
    if (!data) render();
    try {
      // The arrow spins at least 0.8 s so even an answer from the server cache is seen to refresh.
      [data] = await Promise.all([fetchProSwings(fresh), sleep(800)]);
      loadedAt = Date.now();
    } catch (err) {
      if (!data) {
        results.innerHTML = `<div class="cd-focus-empty"><p class="cd-focus-error">${esc(err.message || "Failed to load Pro Swings.")}</p></div>`;
      }
    } finally {
      scanning = false;
      refreshBtn?.classList.remove("is-spinning");
      if (refreshBtn) refreshBtn.disabled = false;
      render();
    }
  }

  // ---------- event listeners ----------
  document.getElementById("cdProSwingsTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pro-tab]");
    if (!btn || btn.dataset.proTab === tab) return;
    tab = btn.dataset.proTab;
    document.querySelectorAll("#cdProSwingsTabs [data-pro-tab]").forEach((b) => b.classList.toggle("is-active", b === btn));
    render();
  });

  filterBtn?.addEventListener("click", () => {
    dirFilter = dirFilter === "all" ? "bullish" : dirFilter === "bullish" ? "bearish" : "all";
    filterBtn.querySelector("span").textContent = FILTER_LABEL[dirFilter];
    render();
  });

  refreshBtn?.addEventListener("click", () => load(true));

  results.addEventListener("click", (event) => {
    const starBtn = event.target.closest("[data-pro-star]");
    if (starBtn) {
      if (window.cdToggleWatch) window.cdToggleWatch(starBtn.dataset.proStar);
      render();
      return;
    }
    const ticket = event.target.closest("[data-pro-ticket]");
    if (ticket) {
      const stopLoss = Number(ticket.dataset.proStop);
      const target = Number(ticket.dataset.proTarget);
      window.cdOpenTicket?.(ticket.dataset.proTicket, ticket.dataset.proSide, {
        stopLoss: stopLoss > 0 ? stopLoss : null,
        target: target > 0 ? target : null
      });
      return;
    }
    const analysis = event.target.closest("[data-pro-coin]");
    if (analysis) {
      window.cdOpenSheet?.(analysis.dataset.proCoin);
    }
  });

  const pageActive = () => overlay.classList.contains("active");
  window.addEventListener("cd-markets-updated", () => { if (pageActive() && data) render(); });

  let wasActive = false;
  new MutationObserver(() => {
    const now = pageActive();
    if (now && !wasActive) ensureLoaded();
    wasActive = now;
  }).observe(overlay, { attributes: true, attributeFilter: ["class"] });

  function ensureLoaded() {
    if (!pageActive() || scanning) return;
    if (!data || Date.now() - loadedAt > STALE_MS) load();
  }

  function open() {
    if (!pageActive()) document.querySelector('.sidebar .app-tab[data-tab="proswings"]')?.click();
    load();
  }
  window.cdOpenProSwings = open;
  ensureLoaded();

  // Mobile pull down to refresh
  (function pullToRefresh() {
    const THRESHOLD = 70;
    let startY = null, pulled = 0;
    const hint = document.createElement("div");
    hint.className = "cd-fr-ptr";
    hint.hidden = true;
    overlay.prepend(hint);
    const atTop = () => (document.scrollingElement || document.documentElement).scrollTop <= 0;
    const reset = () => { startY = null; pulled = 0; hint.hidden = true; hint.style.height = "0px"; };
    overlay.addEventListener("touchstart", (e) => {
      startY = pageActive() && atTop() && !scanning && e.touches.length === 1 ? e.touches[0].clientY : null;
      pulled = 0;
    }, { passive: true });
    overlay.addEventListener("touchmove", (e) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || !atTop()) { reset(); return; }
      pulled = dy;
      hint.hidden = false;
      hint.style.height = Math.min(44, dy * 0.5) + "px";
      hint.textContent = dy >= THRESHOLD ? "Release to refresh" : "Pull down to refresh";
    }, { passive: true });
    overlay.addEventListener("touchend", () => {
      const go = pulled >= THRESHOLD;
      reset();
      if (go) load(true);
    }, { passive: true });
    overlay.addEventListener("touchcancel", reset, { passive: true });
  })();
})();
