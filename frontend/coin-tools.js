// Coin Detail (candle chart for any coin + Buy/Sell), Scanner (live filters
// across every coin) and Heatmap (24h change of the most traded coins).
// Prices come from markets.js; candles from /api/coin/candles.
(function cryptoCoinTools() {
  const el = (id) => document.getElementById(id);
  if (!el("cdCoinChart")) return;

  const F = () => window.cdFormat || {};
  const coins = () => (window.cdMarkets && window.cdMarkets.coins) || [];
  const coinOf = (base) => (window.cdMarkets && window.cdMarkets.coinsByBase ? window.cdMarkets.coinsByBase.get(base) : null);
  const activePanel = () => document.querySelector(".tab-panel.active")?.dataset.panel || "";
  const goTo = (tab) => document.querySelector(`.app-tab[data-tab="${tab}"]`)?.click();
  const money = (v) => "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MIN_VOLUME = 1000000;
  const CANDLE_REFRESH_MS = 30000;

  // ---------- Coin Detail ----------
  let coinBase = "BTC";
  try { coinBase = sessionStorage.getItem("cdCoinBase") || "BTC"; } catch (e) { /* ignore */ }
  let interval = "1h";
  let chart = null;
  let series = null;
  let lastCandle = null;
  let loadedKey = "";
  let lastCandleFetch = 0;
  let loadSeq = 0;

  function pricePrecision(price) {
    if (price >= 1000) return 2;
    if (price >= 1) return 4;
    if (price >= 0.01) return 6;
    return 8;
  }

  function ensureChart() {
    if (chart || typeof LightweightCharts === "undefined") return;
    const colours = typeof getChartThemeColors === "function" ? getChartThemeColors() : { bg: "#0c0a14", text: "#c4b5fd", grid: "rgba(38,33,56,0.72)", border: "rgba(139,92,246,0.34)" };
    chart = LightweightCharts.createChart(el("cdCoinChart"), {
      autoSize: true,
      layout: { background: { color: colours.bg }, textColor: colours.text },
      grid: { vertLines: { color: colours.grid }, horzLines: { color: colours.grid } },
      rightPriceScale: { borderColor: colours.border },
      timeScale: { borderColor: colours.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    if (typeof registerThemedChart === "function") registerThemedChart(chart);
    series = chart.addCandlestickSeries({ upColor: "#34d399", downColor: "#f87171", borderVisible: false, wickUpColor: "#34d399", wickDownColor: "#f87171" });
  }

  function setChartStatus(text) {
    const node = el("cdCoinChartStatus");
    node.textContent = text || "";
    node.hidden = !text;
  }

  let inflightKey = "";

  async function loadCandles(force = false) {
    const key = `${coinBase}:${interval}`;
    if (key === inflightKey) return; // already on its way
    if (!force && key === loadedKey && Date.now() - lastCandleFetch < CANDLE_REFRESH_MS) return;
    ensureChart();
    if (!series) { setChartStatus("Chart library didn't load. Please refresh."); return; }
    const seq = ++loadSeq;
    inflightKey = key;
    if (key !== loadedKey) setChartStatus("Loading chart…");
    try {
      const res = await fetch(`/api/coin/candles?symbol=${encodeURIComponent(coinBase + "USDT")}&interval=${interval}&limit=300`, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (seq !== loadSeq) return; // a newer coin/interval was picked meanwhile
      const candles = Array.isArray(data.candles) ? data.candles : [];
      const precision = pricePrecision(candles.length ? candles[candles.length - 1].close : 1);
      series.applyOptions({ priceFormat: { type: "price", precision, minMove: 1 / 10 ** precision } });
      series.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      lastCandle = candles.length ? { ...candles[candles.length - 1] } : null;
      if (key !== loadedKey) chart.timeScale().fitContent();
      loadedKey = key;
      lastCandleFetch = Date.now();
      setChartStatus(candles.length ? "" : "No chart data for this coin yet.");
    } catch (e) {
      if (seq === loadSeq && key !== loadedKey) setChartStatus("Couldn't load the chart. It will retry in a moment.");
    } finally {
      if (seq === loadSeq) inflightKey = "";
    }
  }

  // Move the latest candle with the live price between candle refreshes.
  function tickLastCandle(price) {
    if (!series || !lastCandle || !Number.isFinite(price)) return;
    lastCandle.close = price;
    lastCandle.high = Math.max(lastCandle.high, price);
    lastCandle.low = Math.min(lastCandle.low, price);
    try { series.update({ time: lastCandle.time, open: lastCandle.open, high: lastCandle.high, low: lastCandle.low, close: lastCandle.close }); } catch (e) { /* ignore */ }
  }

  function renderCoinHeader() {
    const f = F();
    const coin = coinOf(coinBase);
    el("cdCoinTitle").textContent = coinBase;
    el("cdCoinAvatar").innerHTML = f.avatar ? f.avatar(coinBase) : "";
    el("cdCoinPrice").textContent = coin && f.fmtUsd ? f.fmtUsd(coin.price) : "$--";
    el("cdCoinInr").textContent = coin && f.fmtInr ? f.fmtInr(coin.price) : "";
    const change = el("cdCoinChange");
    change.textContent = coin && f.fmtPct ? f.fmtPct(coin.change_percent) : "";
    change.className = coin && f.pctClass ? f.pctClass(coin.change_percent) : "";
    el("cdCoinHigh").textContent = coin && f.fmtUsd ? f.fmtUsd(coin.high) : "--";
    el("cdCoinLow").textContent = coin && f.fmtUsd ? f.fmtUsd(coin.low) : "--";
    el("cdCoinVolume").textContent = coin && f.fmtVolume ? f.fmtVolume(coin.volume_usdt) : "--";
    const held = typeof window.cdPaperHolding === "function" ? window.cdPaperHolding(coinBase) : null;
    el("cdCoinHolding").textContent = held ? `${Number(held.qty).toLocaleString("en-US", { maximumFractionDigits: 8 })} ${coinBase}` : "None";
    const pnl = el("cdCoinHoldingPnl");
    pnl.textContent = held ? `${held.pnl >= 0 ? "+" : "-"}${money(Math.abs(held.pnl))} (${held.pct >= 0 ? "+" : ""}${held.pct.toFixed(2)}%)` : "";
    pnl.className = held && f.pctClass ? f.pctClass(held.pnl) : "";
    el("cdCoinSell").disabled = !held;
    el("cdCoinSell").style.opacity = held ? "" : "0.5";
  }

  function openCoin(base) {
    if (!base) return;
    coinBase = base.toUpperCase();
    try { sessionStorage.setItem("cdCoinBase", coinBase); } catch (e) { /* ignore */ }
    if (activePanel() !== "coin") goTo("coin");
    renderCoinHeader();
    // The chart sizes itself from its container, so draw once the page shows.
    requestAnimationFrame(() => loadCandles(true));
  }

  // Shared with the Alerts page's coin field.
  function fillCoinList() {
    const list = el("cdCoinList");
    if (!list || list.childElementCount === coins().length) return;
    list.innerHTML = coins().map((c) => `<option value="${c.base}"></option>`).join("");
  }

  function pickSearchedCoin() {
    const query = el("cdCoinSearch").value.trim().toUpperCase().replace(/USDT$/, "");
    if (!query) return;
    if (coinOf(query)) {
      el("cdCoinSearch").value = "";
      openCoin(query);
    }
  }

  // ---------- Scanner ----------
  let scan = "gainers";
  const SCANS = {
    gainers: { hint: "Biggest 24h gainers.", run: (l) => l.filter((c) => c.change_percent > 0).sort((a, b) => b.change_percent - a.change_percent) },
    losers: { hint: "Biggest 24h losers.", run: (l) => l.filter((c) => c.change_percent < 0).sort((a, b) => a.change_percent - b.change_percent) },
    volume: { hint: "Most traded coins in the last 24h.", run: (l) => l.slice().sort((a, b) => b.volume_usdt - a.volume_usdt) },
    nearHigh: { hint: "Trading within 2% of their 24h high.", run: (l) => l.filter((c) => c.high > 0 && c.price >= c.high * 0.98).sort((a, b) => b.price / b.high - a.price / a.high) },
    nearLow: { hint: "Trading within 2% of their 24h low.", run: (l) => l.filter((c) => c.low > 0 && c.price <= c.low * 1.02).sort((a, b) => a.price / a.low - b.price / b.low) },
    volatile: { hint: "Widest gap between 24h high and low.", run: (l) => l.filter((c) => c.low > 0).sort((a, b) => (b.high - b.low) / b.low - (a.high - a.low) / a.low) },
  };

  // Every matching coin (not just a top few), re-drawn on each live price
  // update while the Scanner is open.
  function renderScanner() {
    const body = el("cdScanBody");
    if (!body || !F().coinRow) return;
    const liquidOnly = el("cdScanLiquid")?.checked;
    const pool = liquidOnly ? coins().filter((c) => c.volume_usdt >= MIN_VOLUME) : coins();
    const rows = SCANS[scan].run(pool);
    document.querySelectorAll("[data-scan-count]").forEach((node) => {
      const n = SCANS[node.dataset.scanCount].run(pool).length;
      node.textContent = coins().length ? `(${n})` : "";
    });
    const time = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    el("cdScanHint").textContent = coins().length
      ? `${SCANS[scan].hint} ${rows.length} coin${rows.length === 1 ? "" : "s"} · live · updated ${time}`
      : "Loading coins…";
    body.innerHTML = rows.map(F().coinRow).join("") ||
      `<tr><td colspan="7" class="cd-empty">${coins().length ? "Nothing matches right now." : "Loading coins…"}</td></tr>`;
  }

  // ---------- Heatmap ----------
  let heatSize = 100;

  function heatColour(pct) {
    const strength = Math.min(Math.abs(pct) / 8, 1); // full colour at ±8%
    if (Math.abs(pct) < 0.05) return "rgb(71, 85, 105)";
    const [r, g, b] = pct > 0 ? [22, 163, 74] : [220, 38, 38];
    const base = [51, 65, 85];
    const mix = (from, to) => Math.round(from + (to - from) * (0.35 + 0.65 * strength));
    return `rgb(${mix(base[0], r)}, ${mix(base[1], g)}, ${mix(base[2], b)})`;
  }

  function renderHeatmap() {
    const grid = el("cdHeatGrid");
    if (!grid) return;
    const f = F();
    const list = coins().slice(0, heatSize); // already sorted by volume
    grid.innerHTML = list.map((c, i) => `<button type="button" class="cd-heat-tile${i < 6 ? " is-big" : ""}" data-coin="${f.escapeHtml ? f.escapeHtml(c.base) : c.base}" style="background:${heatColour(c.change_percent)}">
        <strong>${f.escapeHtml ? f.escapeHtml(c.base) : c.base}</strong><span>${f.fmtPct ? f.fmtPct(c.change_percent) : ""}</span>
      </button>`).join("") || '<p class="cd-empty">Loading coins…</p>';
  }

  // ---------- events ----------
  function renderActive() {
    const panel = activePanel();
    if (panel === "coin") {
      fillCoinList();
      renderCoinHeader();
      const coin = coinOf(coinBase);
      if (coin) tickLastCandle(coin.price);
      loadCandles(false); // refetches every 30s for new candles
    } else if (panel === "scanner") renderScanner();
    else if (panel === "heatmap") renderHeatmap();
  }

  window.addEventListener("cd-markets-updated", renderActive);

  document.addEventListener("click", (event) => {
    const tile = event.target.closest("[data-coin]");
    if (tile) { openCoin(tile.dataset.coin); return; }
    const iv = event.target.closest("#cdCoinIntervals [data-interval]");
    if (iv) {
      interval = iv.dataset.interval;
      document.querySelectorAll("#cdCoinIntervals [data-interval]").forEach((b) => b.classList.toggle("is-active", b === iv));
      loadCandles(true);
      return;
    }
    const sc = event.target.closest("#cdScanFilters [data-scan]");
    if (sc) {
      scan = sc.dataset.scan;
      document.querySelectorAll("#cdScanFilters [data-scan]").forEach((b) => b.classList.toggle("is-active", b === sc));
      renderScanner();
      return;
    }
    const hs = event.target.closest("#cdHeatSize [data-heat]");
    if (hs) {
      heatSize = Number(hs.dataset.heat);
      document.querySelectorAll("#cdHeatSize [data-heat]").forEach((b) => b.classList.toggle("is-active", b === hs));
      renderHeatmap();
      return;
    }
    if (event.target.closest(".app-tab")) setTimeout(renderActive, 0);
  });

  el("cdScanLiquid")?.addEventListener("change", renderScanner);
  el("cdCoinSearch").addEventListener("change", pickSearchedCoin);
  el("cdCoinSearch").addEventListener("keydown", (event) => { if (event.key === "Enter") pickSearchedCoin(); });
  el("cdCoinBuy").addEventListener("click", () => window.cdOpenTicket && window.cdOpenTicket(coinBase, "BUY"));
  el("cdCoinSell").addEventListener("click", () => window.cdOpenTicket && window.cdOpenTicket(coinBase, "SELL"));
  el("cdCoinAlert")?.addEventListener("click", () => window.cdNewAlert && window.cdNewAlert(coinBase));

  window.cdOpenCoin = openCoin;
  window.cdFillCoinList = fillCoinList;
  if (activePanel() === "coin") requestAnimationFrame(() => { renderCoinHeader(); loadCandles(true); });
})();
