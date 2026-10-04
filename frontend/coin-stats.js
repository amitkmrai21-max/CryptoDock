// Coin stats sheet — what a Scanner row opens: live price, momentum, the
// 24h range, full 24h statistics (open, high, low, volume, trades, average
// price, bid / ask and spread) and 7D / 30D performance. No Buy / Sell here;
// Chart, Set Alert and Watchlist stay one tap away.
(function cryptoCoinStats() {
  const POLL_MS = 3000;
  const el = (id) => document.getElementById(id);
  if (!el("cdStats")) return;

  const F = () => window.cdFormat || {};
  const coinOf = (b) => (window.cdMarkets && window.cdMarkets.coinsByBase ? window.cdMarkets.coinsByBase.get(b) : null);
  let base = null;
  let stats = null;
  let timer = null;
  let seq = 0;

  const usd = (v) => (Number.isFinite(v) && F().fmtUsd ? F().fmtUsd(v) : "--");
  const pct = (v) => (Number.isFinite(v) && F().fmtPct ? F().fmtPct(v) : "--");
  const cls = (v) => (Number.isFinite(v) && F().pctClass ? F().pctClass(v) : "");
  const big = (v) => {
    if (!Number.isFinite(v)) return "--";
    const units = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (const [n, u] of units) if (Math.abs(v) >= n) return (v / n).toFixed(2) + u;
    return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  };
  const cell = (label, value, extra = "") => `<div><span>${label}</span><strong class="${extra}">${value}</strong></div>`;

  function render() {
    if (!base) return;
    const f = F();
    const coin = coinOf(base);
    const s = stats && stats.symbol === base + "USDT" ? stats : null;
    const price = coin ? coin.price : s ? s.price : NaN;
    const change = coin ? coin.change_percent : s ? s.change_percent : NaN;
    const high = s ? s.high : coin ? coin.high : NaN;
    const low = s ? s.low : coin ? coin.low : NaN;

    el("cdStatsTitle").textContent = `${base}/USDT`;
    el("cdStatsAvatar").innerHTML = f.avatar ? f.avatar(base) : "";
    el("cdStatsPrice").textContent = usd(price);
    const ch = el("cdStatsChange");
    ch.textContent = pct(change);
    ch.className = cls(change);
    el("cdStatsInr").textContent = coin && f.fmtInr ? f.fmtInr(price) : "";
    el("cdStatsMom").innerHTML = coin && f.momPill ? f.momPill(coin) : "";
    const rank = window.cdVolumeRank ? window.cdVolumeRank(base) : null;
    el("cdStatsRank").textContent = rank ? `#${rank.rank} by volume of ${rank.total}` : "";

    el("cdStatsLow").textContent = usd(low);
    el("cdStatsHigh").textContent = usd(high);
    const span = high - low;
    el("cdStatsMark").style.left = (span > 0 ? Math.min(100, Math.max(0, ((price - low) / span) * 100)) : 50) + "%";
    el("cdStatsRangePct").textContent = low > 0 && Number.isFinite(span) ? `RANGE ${((span / low) * 100).toFixed(2)}%` : "";

    const fromHigh = high > 0 ? ((price - high) / high) * 100 : NaN;
    const spread = s && s.bid > 0 && s.ask > 0 ? ((s.ask - s.bid) / ((s.ask + s.bid) / 2)) * 100 : NaN;
    el("cdStats24").innerHTML = [
      cell("24h High", usd(high)),
      cell("24h Low", usd(low)),
      cell("24h Open", s ? usd(s.open) : "--"),
      cell("Change", s ? (s.change >= 0 ? "+" : "−") + usd(Math.abs(s.change)) : "--", s ? cls(s.change) : ""),
      cell("Avg price", s ? usd(s.avg_price) : "--"),
      cell("Trades", s ? big(s.trades) : "--"),
      cell("Volume $", s ? "$" + big(s.volume_usdt) : coin ? "$" + big(coin.volume_usdt) : "--"),
      cell(`Volume ${base.length > 5 ? "coin" : base}`, s ? big(s.volume_base) : "--"),
      cell("From high", pct(fromHigh), cls(fromHigh)),
      cell("Best bid", s ? usd(s.bid) : "--", "cd-up"),
      cell("Best ask", s ? usd(s.ask) : "--", "cd-down"),
      cell("Spread", !Number.isFinite(spread) ? "--" : spread < 0.001 ? "<0.001%" : spread.toFixed(3) + "%"),
    ].join("");

    const perf = s && s.performance;
    const block = (label, p) => `<div>
        <b>${label}<span class="${p ? cls(p.change_percent) : ""}">${p && p.change_percent != null ? pct(p.change_percent) : "--"}</span></b>
        <em>High</em><i>${p ? usd(p.high) : "--"}</i>
        <em>Low</em><i>${p ? usd(p.low) : "--"}</i>
      </div>`;
    el("cdStatsPerf").innerHTML = block("7 Days", perf && perf.d7) + block("30 Days", perf && perf.d30);

    const starred = typeof window.cdIsWatched === "function" && window.cdIsWatched(base);
    el("cdStatsStar").textContent = starred ? "★ In Watchlist" : "☆ Watchlist";
    el("cdStatsStar").classList.toggle("is-active", starred);
  }

  // Keep the whole card on screen: when it is taller than the window
  // (short phone, large system font) scale it down — never below 72%.
  function fit() {
    const card = el("cdStats").querySelector(".cd-ticket");
    if (!card || el("cdStats").hidden) return;
    card.style.zoom = "";
    card.style.maxHeight = "";
    card.style.overflowY = "";
    const room = window.innerHeight - 24;
    const height = card.getBoundingClientRect().height;
    if (height <= room) return;
    const zoom = Math.max(0.72, room / height);
    card.style.zoom = zoom.toFixed(3);
    // Still too tall at the smallest size: let the card scroll.
    if (height * zoom > room) {
      card.style.maxHeight = Math.floor(room / zoom) + "px";
      card.style.overflowY = "auto";
    }
  }

  async function load() {
    if (!base) return;
    const mine = ++seq;
    try {
      const res = await fetch(`/api/coin/stats?symbol=${encodeURIComponent(base + "USDT")}`, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (mine !== seq || !base) return;
      const first = !stats;
      stats = data;
      render();
      if (first) fit();
    } catch (e) {
      // Keep what's shown; the market feed still updates price and range.
    }
  }

  function poll() {
    clearTimeout(timer);
    if (!base) return;
    timer = setTimeout(async () => {
      if (document.visibilityState === "visible") await load();
      poll();
    }, POLL_MS);
  }

  function open(next) {
    if (!next) return;
    base = next;
    stats = null;
    render();
    el("cdStats").hidden = false;
    fit();
    load();
    poll();
  }

  function close() {
    el("cdStats").hidden = true;
    base = null;
    clearTimeout(timer);
  }

  function then(action) {
    const current = base;
    close();
    if (window.cdHideSheetNow) window.cdHideSheetNow(el("cdStats"));
    action(current);
  }

  el("cdStatsClose").addEventListener("click", close);
  el("cdStats").addEventListener("click", (event) => { if (event.target.id === "cdStats") close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && base) close(); });
  el("cdStatsChart").addEventListener("click", () => then((b) => window.cdOpenCoin && window.cdOpenCoin(b)));
  el("cdStatsAlert").addEventListener("click", () => then((b) => window.cdNewAlert && window.cdNewAlert(b)));
  el("cdStatsStar").addEventListener("click", () => { if (window.cdToggleWatch && base) { window.cdToggleWatch(base); render(); } });

  window.addEventListener("cd-markets-updated", render);
  window.addEventListener("resize", fit);
  window.cdOpenStats = open;
})();
