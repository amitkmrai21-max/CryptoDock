// Coin sheet — what opens when you tap a coin, like the Indian market's
// stock sheet: live price in $ and ₹, Chart / Set Alert / Watchlist, the
// order book's top 5 bids and asks, the 24h range, and Buy / Sell, which
// open the order ticket (paper.js; Pro rules apply there).
(function cryptoCoinSheet() {
  const DEPTH_POLL_MS = 3000;
  const el = (id) => document.getElementById(id);
  if (!el("cdSheet")) return;

  const F = () => window.cdFormat || {};
  const coinOf = (base) => (window.cdMarkets && window.cdMarkets.coinsByBase ? window.cdMarkets.coinsByBase.get(base) : null);
  const fmtQty = (q) => Number(q).toLocaleString("en-US", { maximumFractionDigits: q >= 100 ? 2 : 6 });
  let base = null;
  let depthTimer = null;
  let depthSeq = 0;

  function render() {
    if (!base) return;
    const f = F();
    const coin = coinOf(base);
    el("cdSheetTitle").textContent = base;
    el("cdSheetAvatar").innerHTML = f.avatar ? f.avatar(base) : "";
    el("cdSheetPrice").textContent = coin && f.fmtUsd ? f.fmtUsd(coin.price) : "$--";
    const change = el("cdSheetChange");
    change.textContent = coin && f.fmtPct ? f.fmtPct(coin.change_percent) : "";
    change.className = coin && f.pctClass ? f.pctClass(coin.change_percent) : "";
    const inr = coin && f.fmtInr ? f.fmtInr(coin.price) : "₹--";
    el("cdSheetInr").textContent = inr;
    el("cdSheetInr2").textContent = inr;
    el("cdSheetVolume").textContent = coin && f.fmtVolume ? f.fmtVolume(coin.volume_usdt) : "--";
    el("cdSheetHigh").textContent = coin && f.fmtUsd ? f.fmtUsd(coin.high) : "--";
    el("cdSheetLow").textContent = coin && f.fmtUsd ? f.fmtUsd(coin.low) : "--";
    el("cdRangeHigh").textContent = el("cdSheetHigh").textContent;
    el("cdRangeLow").textContent = el("cdSheetLow").textContent;
    const span = coin ? coin.high - coin.low : 0;
    const pos = coin && span > 0 ? Math.min(100, Math.max(0, ((coin.price - coin.low) / span) * 100)) : 50;
    el("cdRangeMark").style.left = pos + "%";

    const held = typeof window.cdPaperHolding === "function" ? window.cdPaperHolding(base) : null;
    el("cdSheetHolding").textContent = held ? `${fmtQty(held.qty)} ${base}` : "None";
    const starred = typeof window.cdIsWatched === "function" && window.cdIsWatched(base);
    el("cdSheetStar").textContent = starred ? "★ In Watchlist" : "☆ Watchlist";
    el("cdSheetStar").classList.toggle("is-active", starred);
  }

  function depthRows(rows, side, maxQty) {
    const f = F();
    if (!rows.length) return '<p class="cd-meta" style="margin:6px 0">--</p>';
    return rows.map((r) => `<div class="cd-depth-row cd-depth-${side}">
        <i style="width:${maxQty ? Math.max(4, (r.qty / maxQty) * 100) : 0}%"></i>
        <span>${f.fmtUsd ? f.fmtUsd(r.price) : r.price}</span><span>${fmtQty(r.qty)}</span>
      </div>`).join("");
  }

  async function loadDepth() {
    if (!base) return;
    const seq = ++depthSeq;
    try {
      const res = await fetch(`/api/coin/depth?symbol=${encodeURIComponent(base + "USDT")}`, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const book = await res.json();
      if (seq !== depthSeq || !base) return;
      const bids = book.bids || [];
      const asks = book.asks || [];
      const maxQty = Math.max(0, ...bids.map((r) => r.qty), ...asks.map((r) => r.qty));
      el("cdDepthBids").innerHTML = depthRows(bids, "bid", maxQty);
      el("cdDepthAsks").innerHTML = depthRows(asks, "ask", maxQty);
    } catch (e) {
      if (seq === depthSeq && !el("cdDepthBids").childElementCount) {
        el("cdDepthBids").innerHTML = el("cdDepthAsks").innerHTML = '<p class="cd-meta" style="margin:6px 0">Loading…</p>';
      }
    }
  }

  function pollDepth() {
    clearTimeout(depthTimer);
    if (!base) return;
    depthTimer = setTimeout(async () => {
      if (document.visibilityState === "visible") await loadDepth();
      pollDepth();
    }, DEPTH_POLL_MS);
  }

  function open(next) {
    if (!next) return;
    base = next;
    el("cdDepthBids").innerHTML = el("cdDepthAsks").innerHTML = "";
    render();
    el("cdSheet").hidden = false;
    loadDepth();
    pollDepth();
  }

  function close() {
    el("cdSheet").hidden = true;
    base = null;
    clearTimeout(depthTimer);
  }

  // Leave the sheet, then run the next step (ticket, chart, alert). The
  // sheet goes at once rather than sliding down, so the next sheet's slide
  // up is the only animation running (two at once stuttered on phones).
  function then(action) {
    const current = base;
    close();
    if (window.cdHideSheetNow) window.cdHideSheetNow(el("cdSheet"));
    action(current);
  }

  // Charts open on TradingView itself (its app when installed, else
  // tradingview.com), like the Indian market: every indicator and drawing
  // tool, and no chart traffic on our server or Binance however many users.
  // On Android an intent:// link opens the TradingView app and falls back to
  // the website; the CryptoDock app's MainActivity handles that link.
  const TRADINGVIEW_ANDROID_PACKAGE = "com.tradingview.tradingviewapp";
  function openTradingView(coinBase) {
    if (!coinBase) return;
    // BRL / TRY / ARS trade on Binance as USDT/BRL etc. (the rate per dollar).
    const tvPair = ["BRL", "TRY", "ARS"].includes(coinBase) ? `USDT${coinBase}` : `${coinBase}USDT`;
    const path = `www.tradingview.com/chart/?symbol=${encodeURIComponent(`BINANCE:${tvPair}`)}`;
    const webUrl = `https://${path}`;
    if (!/Android/i.test(navigator.userAgent || "")) {
      window.open(webUrl, "_blank", "noopener");
      return;
    }
    const intentUrl = `intent://${path}#Intent;scheme=https;package=${TRADINGVIEW_ANDROID_PACKAGE};` +
      `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
    if (window.Capacitor?.isNativePlatform?.()) window.location.href = intentUrl;
    else window.open(intentUrl, "_blank", "noopener");
  }
  window.cdOpenTradingView = openTradingView;

  el("cdSheetClose").addEventListener("click", close);
  el("cdSheet").addEventListener("click", (event) => { if (event.target.id === "cdSheet") close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && base) close(); });
  el("cdSheetBuy").addEventListener("click", () => then((b) => window.cdOpenTicket && window.cdOpenTicket(b, "BUY")));
  el("cdSheetSell").addEventListener("click", () => then((b) => window.cdOpenTicket && window.cdOpenTicket(b, "SELL")));
  el("cdSheetChart").addEventListener("click", () => then((b) => openTradingView(b)));
  el("cdSheetAlert").addEventListener("click", () => then((b) => window.cdNewAlert && window.cdNewAlert(b)));
  el("cdSheetStar").addEventListener("click", () => { if (window.cdToggleWatch && base) { window.cdToggleWatch(base); render(); } });

  window.addEventListener("cd-markets-updated", render);
  window.cdOpenSheet = open;
})();
