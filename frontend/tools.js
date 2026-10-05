// Tools page: calculators and market gauges for paper traders. Prices come
// from markets.js (window.cdMarkets); SIP / What-if use cached daily or weekly
// candles; Fear & Greed and BTC dominance / Altcoin season come from our
// server, which refreshes them once an hour for everyone. Learning only —
// not financial or tax advice.
(function cryptoTools() {
  const el = (id) => document.getElementById(id);
  const tiles = el("cdToolTiles");
  const card = el("cdToolCard");
  if (!tiles || !card) return;

  const F = () => window.cdFormat || {};
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const markets = () => window.cdMarkets || {};
  const coinOf = (base) => (markets().coinsByBase ? markets().coinsByBase.get(String(base || "").trim().toUpperCase().replace(/\/?USDT$/, "")) : null);
  const inrRate = () => markets().usdtInr || null;
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[,₹$\s]/g, "")); return Number.isFinite(n) ? n : NaN; };
  const usd = (v) => (Number.isFinite(v) ? (F().fmtUsd ? F().fmtUsd(v) : "$" + v.toFixed(2)) : "$--");
  const inr = (v) => (Number.isFinite(v) ? "₹" + Math.round(v).toLocaleString("en-IN") : "₹--");
  const pct = (v, d = 2) => (Number.isFinite(v) ? (v > 0 ? "+" : "") + v.toFixed(d) + "%" : "--");
  const tone = (v) => (v > 0 ? "cd-up" : v < 0 ? "cd-down" : "");
  const activePanel = () => document.querySelector(".tab-panel.active")?.dataset.panel || "";
  const FEE = 0.001; // 0.1% each side, like the paper order ticket
  const STORE = "cdToolsLast";

  // ---------- small UI helpers ----------
  const field = (id, label, value, opts = {}) => `<label class="cd-tool-in${opts.wide ? " is-wide" : ""}"><span>${label}</span>
      <input id="${id}" ${opts.coin ? 'list="cdToolCoins" autocomplete="off" autocapitalize="characters"' : 'inputmode="decimal"'} value="${esc(value)}" placeholder="${esc(opts.ph || "")}" /></label>`;
  const select = (id, label, options, value) => `<label class="cd-tool-in"><span>${label}</span><select id="${id}">${options.map(([v, t]) => `<option value="${v}"${v === value ? " selected" : ""}>${t}</option>`).join("")}</select></label>`;
  const out = (id) => `<div class="cd-tool-out" id="${id}"></div>`;
  const note = (text) => `<p class="cd-tool-note">${text}</p>`;
  const setOut = (id, html, kind = "") => { const n = el(id); if (n) { n.innerHTML = html; n.className = "cd-tool-out" + (kind ? " is-" + kind : ""); } };
  const val = (id) => el(id)?.value ?? "";
  const priceOf = (base) => coinOf(base)?.price;
  const coinLabel = (base) => esc(String(base || "").trim().toUpperCase() || "--");

  async function getJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  const candleMemo = new Map(); // url -> { at, data }
  async function candles(base, interval, limit) {
    const url = `/api/coin/candles?symbol=${encodeURIComponent(base + "USDT")}&interval=${interval}&limit=${limit}`;
    const hit = candleMemo.get(url);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
    const data = (await getJson(url)).candles || [];
    candleMemo.set(url, { at: Date.now(), data });
    return data;
  }

  // ---------- the tools ----------
  const TOOLS = [
    {
      id: "pnl", icon: "🧮", name: "Profit / Loss",
      html: () => `<div class="cd-tool-grid">${field("tPnlCoin", "Coin", "ETH", { coin: true })}${field("tPnlBuy", "Buy price ($)", "2610")}${field("tPnlSell", "Sell price ($)", "", { ph: "live price" })}${field("tPnlQty", "Quantity", "0.5")}</div>${out("tPnlOut")}${note("Includes 0.1% fee on the buy and on the sell. Leave Sell empty to use the live price.")}`,
      calc() {
        const base = val("tPnlCoin"); const buy = num(val("tPnlBuy")); const qty = num(val("tPnlQty"));
        const sell = Number.isFinite(num(val("tPnlSell"))) ? num(val("tPnlSell")) : priceOf(base);
        if (!(buy > 0 && qty > 0 && sell > 0)) return setOut("tPnlOut", "Enter buy price, quantity and a coin (or sell price).");
        const cost = buy * qty * (1 + FEE); const got = sell * qty * (1 - FEE); const pnl = got - cost; const r = (pnl / cost) * 100;
        const sign = pnl >= 0 ? "+" : "-";
        const money = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        setOut("tPnlOut", `<span>${pnl >= 0 ? "Profit" : "Loss"} after fees · sell at ${usd(sell)}</span><b class="${tone(pnl)}">${sign}${money(Math.abs(pnl))} · ${sign}${inr(Math.abs(pnl) * (inrRate() || NaN))} · ${pct(r)}</b>`, pnl >= 0 ? "good" : "bad");
      },
    },
    {
      id: "risk", icon: "🎯", name: "Position Size (Risk)",
      html: () => `<div class="cd-tool-grid">${field("tRiskCap", "Capital ($)", "10000")}${field("tRiskPct", "Risk per trade (%)", "1")}${field("tRiskCoin", "Coin", "BTC", { coin: true })}${field("tRiskEntry", "Entry ($)", "", { ph: "live price" })}${field("tRiskStop", "Stop-loss ($)", "", { ph: "3% below entry" })}</div>${out("tRiskOut")}${note("Buys just enough that hitting the stop-loss loses only your chosen % of capital.")}`,
      calc() {
        const cap = num(val("tRiskCap")); const rp = num(val("tRiskPct")); const base = val("tRiskCoin");
        const entry = Number.isFinite(num(val("tRiskEntry"))) ? num(val("tRiskEntry")) : priceOf(base);
        let stop = num(val("tRiskStop"));
        if (!Number.isFinite(stop) && entry > 0) stop = entry * 0.97;
        if (!(cap > 0 && rp > 0 && entry > 0 && stop > 0) || stop === entry) return setOut("tRiskOut", "Enter capital, risk %, entry and a stop-loss different from the entry.");
        const riskAmt = cap * rp / 100; const qty = riskAmt / Math.abs(entry - stop); const value = qty * entry;
        const capped = value > cap;
        setOut("tRiskOut", `<span>Buy (stop at ${usd(stop)}, ${pct((stop / entry - 1) * 100)})</span><b>${(capped ? cap / entry : qty).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${coinLabel(base)} · ${usd(capped ? cap : value)}</b>${capped ? `<small>Capped at your capital — the stop is very close.</small>` : `<small>Max loss if stopped: ${usd(riskAmt)}</small>`}`, "good");
      },
    },
    {
      id: "conv", icon: "💱", name: "Converter",
      html: () => `<div class="cd-tool-grid">${field("tConvAmt", "Amount", "0.05")}${select("tConvUnit", "In", [["coin", "Coin"], ["usd", "US $"], ["inr", "₹ Rupees"]], "coin")}${field("tConvCoin", "Coin", "BTC", { coin: true })}</div>${out("tConvOut")}${note("At the live price and today's USDT → ₹ rate.")}`,
      calc() {
        const amt = num(val("tConvAmt")); const unit = val("tConvUnit"); const base = val("tConvCoin"); const p = priceOf(base); const r = inrRate();
        if (!(amt >= 0 && p > 0)) return setOut("tConvOut", "Enter an amount and a coin from the list.");
        const usdV = unit === "coin" ? amt * p : unit === "usd" ? amt : r ? amt / r : NaN;
        const coins = usdV / p;
        setOut("tConvOut", `<span>= at ${usd(p)}</span><b>${coins.toLocaleString("en-US", { maximumFractionDigits: 8 })} ${coinLabel(base)} · ${usd(usdV)} · ${inr(usdV * (r || NaN))}</b>`, "good");
      },
    },
    {
      id: "recover", icon: "📉", name: "Loss Recovery & Target",
      html: () => `<div class="cd-tool-grid">${field("tRecDown", "Down by (%)", "30")}${field("tRecCoin", "Coin", "ETH", { coin: true })}${field("tRecTarget", "Target price ($)", "3000")}</div>${out("tRecOut")}${out("tRecOut2")}`,
      calc() {
        const d = num(val("tRecDown"));
        if (d > 0 && d < 100) setOut("tRecOut", `<span>After a ${d}% fall it must rise</span><b class="cd-up">${pct((1 / (1 - d / 100) - 1) * 100, 1)}</b><small>to get back to where it was.</small>`, "warn");
        else setOut("tRecOut", "Enter a fall between 1 and 99%.");
        const base = val("tRecCoin"); const p = priceOf(base); const t = num(val("tRecTarget"));
        if (p > 0 && t > 0) setOut("tRecOut2", `<span>${coinLabel(base)} now ${usd(p)} → target ${usd(t)}</span><b class="${tone(t - p)}">${pct((t / p - 1) * 100, 1)}</b>`, t >= p ? "good" : "bad");
        else setOut("tRecOut2", "Pick a coin and a target price.");
      },
    },
    {
      id: "mood", icon: "🧭", name: "Market Mood", live: true,
      html: () => `${out("tMoodBar")}${out("tMoodOut")}${note("From the momentum score of every coin with over $1M traded in 24h.")}`,
      calc() {
        const list = (markets().coins || []).filter((c) => c.volume_usdt >= 1e6 && c.momentum_label);
        if (!list.length) return setOut("tMoodOut", "Loading prices…");
        const n = (l) => list.filter((c) => c.momentum_label === l).length;
        const b = n("BULLISH") / list.length * 100, s = n("BEARISH") / list.length * 100, m = 100 - b - s;
        el("tMoodBar").innerHTML = `<div class="cd-tool-split"><i style="width:${b}%;background:#22c55e"></i><i style="width:${m}%;background:#64748b"></i><i style="width:${s}%;background:#ef4444"></i></div>
          <div class="cd-tool-legend"><span class="cd-up">Bullish ${b.toFixed(0)}%</span><span>Neutral ${m.toFixed(0)}%</span><span class="cd-down">Bearish ${s.toFixed(0)}%</span></div>`;
        el("tMoodBar").className = "";
        const label = b - s > 15 ? ["Mostly Bullish 📈", "good"] : s - b > 15 ? ["Mostly Bearish 📉", "bad"] : ["Mixed / Neutral ➖", "warn"];
        setOut("tMoodOut", `<span>${list.length} coins checked · live</span><b>${label[0]}</b>`, label[1]);
      },
    },
    {
      id: "compare", icon: "⚖️", name: "Compare Coins",
      html: () => `<div class="cd-tool-grid">${field("tCmp1", "Coin 1", "BTC", { coin: true })}${field("tCmp2", "Coin 2", "ETH", { coin: true })}${field("tCmp3", "Coin 3", "SOL", { coin: true })}</div><div id="tCmpOut" class="cd-tool-table"></div>`,
      perf: new Map(),
      async loadPerf(base) {
        const t = TOOLS.find((x) => x.id === "compare");
        if (t.perf.has(base)) return;
        t.perf.set(base, null);
        try { t.perf.set(base, (await getJson(`/api/coin/stats?symbol=${encodeURIComponent(base + "USDT")}`)).performance || {}); }
        catch (e) { t.perf.delete(base); }
        if (current === "compare") this.calc();
      },
      calc() {
        const bases = ["tCmp1", "tCmp2", "tCmp3"].map((i) => String(val(i)).trim().toUpperCase()).filter((b) => coinOf(b));
        if (!bases.length) return (el("tCmpOut").innerHTML = '<p class="cd-tool-note">Pick coins from the list.</p>');
        bases.forEach((b) => this.loadPerf(b));
        const cell = (v) => `<td class="${tone(v)}">${Number.isFinite(v) ? pct(v, 1) : "…"}</td>`;
        el("tCmpOut").innerHTML = `<table><thead><tr><th>Coin</th><th>Price</th><th>24H</th><th>7D</th><th>30D</th><th>Mom.</th></tr></thead><tbody>${bases.map((b) => {
          const c = coinOf(b); const p = this.perf.get(b) || {};
          return `<tr><td>${esc(b)}</td><td>${usd(c.price)}</td>${cell(c.change_percent)}${cell(p.d7?.change_percent)}${cell(p.d30?.change_percent)}<td>${c.momentum ?? "--"}</td></tr>`;
        }).join("")}</tbody></table>`;
      },
    },
    {
      id: "tax", icon: "🇮🇳", name: "Crypto Tax (India)", tag: "INDIA",
      html: () => `<div class="cd-tool-grid">${field("tTaxBuy", "Bought for (₹)", "100000")}${field("tTaxSell", "Sold for (₹)", "150000")}</div>${out("tTaxOut")}${out("tTaxTds")}${note("India (Sec 115BBH): 30% tax on profit + 4% cess, losses can't be set off; 1% TDS (Sec 194S) is cut from the sale value and counts toward your tax. Learning only — not tax advice.")}`,
      calc() {
        const b = num(val("tTaxBuy")); const s = num(val("tTaxSell"));
        if (!(b >= 0 && s > 0)) return setOut("tTaxOut", "Enter what you bought and sold for in ₹.");
        const profit = s - b; const tax = profit > 0 ? profit * 0.3 : 0; const cess = tax * 0.04; const tds = s * 0.01;
        setOut("tTaxOut", profit > 0
          ? `<span>Profit ${inr(profit)} → tax 30% ${inr(tax)} + cess ${inr(cess)}</span><b class="cd-down">${inr(tax + cess)} to pay</b><small>You keep ${inr(profit - tax - cess)} of the profit.</small>`
          : `<span>Loss ${inr(-profit)}</span><b>₹0 tax</b><small>Crypto losses can't be set off against other income.</small>`, profit > 0 ? "bad" : "warn");
        setOut("tTaxTds", `<span>1% TDS cut when selling</span><b>${inr(tds)}</b><small>${profit > 0 ? `Already paid toward the ${inr(tax + cess)} above.` : "Can be claimed back in your tax return."}</small>`, "warn");
      },
    },
    {
      id: "sip", icon: "📅", name: "SIP / DCA", tag: "TRENDING",
      html: () => `<div class="cd-tool-grid">${field("tSipAmt", "Amount each time (₹)", "1000")}${select("tSipEvery", "Every", [["w", "Week"], ["m", "Month"]], "w")}${field("tSipCoin", "Coin", "BTC", { coin: true })}${select("tSipLen", "For the last", [["26", "6 months"], ["52", "1 year"], ["104", "2 years"], ["156", "3 years"]], "52")}</div>${out("tSipOut")}${note("Buys at each week's closing price (monthly = every 4th week). ₹ at today's rate; for learning, past returns don't repeat.")}`,
      async calc() {
        const amt = num(val("tSipAmt")); const base = String(val("tSipCoin")).trim().toUpperCase(); const weeks = parseInt(val("tSipLen"), 10); const step = val("tSipEvery") === "m" ? 4 : 1;
        if (!(amt > 0) || !coinOf(base)) return setOut("tSipOut", "Enter an amount and a coin from the list.");
        setOut("tSipOut", "Calculating…");
        try {
          const rows = (await candles(base, "1w", 160)).slice(-weeks - 1, -1);
          if (rows.length < 4) return setOut("tSipOut", `${esc(base)} doesn't have enough price history yet.`);
          const r = inrRate() || 1; let units = 0, buys = 0;
          for (let i = 0; i < rows.length; i += step) { units += (amt / r) / rows[i].close; buys++; }
          const invested = amt * buys; const now = units * priceOf(base) * r; const g = (now / invested - 1) * 100;
          setOut("tSipOut", `<span>${buys} buys · invested ${inr(invested)} → now</span><b class="${tone(g)}">${inr(now)} (${pct(g, 1)})</b><small>${units.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${esc(base)} collected</small>`, g >= 0 ? "good" : "bad");
        } catch (e) { setOut("tSipOut", "Couldn't load past prices. Try again in a moment."); }
      },
    },
    {
      id: "avg", icon: "➗", name: "Average Price",
      html: () => `<div class="cd-tool-grid">${field("tAvgCoin", "Coin", "BTC", { coin: true })}</div><div id="tAvgRows" class="cd-tool-rows"></div><button type="button" class="cd-ghost-btn" id="tAvgAdd">＋ Add a buy</button>${out("tAvgOut")}`,
      rows: [[0.01, 90000], [0.02, 84000]],
      drawRows() {
        el("tAvgRows").innerHTML = this.rows.map(([q, p], i) => `<div class="cd-tool-grid is-row">${field(`tAvgQ${i}`, `Buy ${i + 1} · qty`, q)}${field(`tAvgP${i}`, "price ($)", p)}${this.rows.length > 1 ? `<button type="button" class="cd-tool-del" data-avg-del="${i}" aria-label="Remove">×</button>` : ""}</div>`).join("");
      },
      bind() {
        this.drawRows();
        el("tAvgAdd").onclick = () => { this.read(); this.rows.push(["", ""]); this.drawRows(); this.calc(); };
        el("tAvgRows").onclick = (e) => { const d = e.target.closest("[data-avg-del]"); if (!d) return; this.read(); this.rows.splice(+d.dataset.avgDel, 1); this.drawRows(); this.calc(); };
      },
      read() { this.rows = this.rows.map((_, i) => [val(`tAvgQ${i}`), val(`tAvgP${i}`)]); },
      calc() {
        this.read();
        let q = 0, cost = 0;
        this.rows.forEach(([a, b]) => { const qq = num(a), pp = num(b); if (qq > 0 && pp > 0) { q += qq; cost += qq * pp; } });
        if (!(q > 0)) return setOut("tAvgOut", "Enter at least one buy.");
        const avg = cost / q; const base = val("tAvgCoin"); const p = priceOf(base); const g = p ? (p / avg - 1) * 100 : NaN;
        setOut("tAvgOut", `<span>${q.toLocaleString("en-US", { maximumFractionDigits: 8 })} ${coinLabel(base)} for ${usd(cost)}</span><b>Average ${usd(avg)}${Number.isFinite(g) ? ` · now <span class="${tone(g)}">${pct(g)}</span>` : ""}</b><small>Break-even after 0.1% fees: ${usd(avg * (1 + FEE) / (1 - FEE))}</small>`, Number.isFinite(g) && g < 0 ? "bad" : "good");
      },
    },
    {
      id: "fng", icon: "😨", name: "Fear & Greed", tag: "POPULAR",
      html: () => `${out("tFngBar")}${out("tFngOut")}${note("Crypto Fear &amp; Greed Index from alternative.me — refreshed once an hour.")}`,
      async calc() {
        setOut("tFngOut", "Loading…");
        try {
          const d = await getJson("/api/market/fear-greed");
          const v = d.now.value; const y = d.yesterday;
          el("tFngBar").className = "";
          el("tFngBar").innerHTML = `<div class="cd-tool-gauge"><i style="left:${v}%"></i></div><div class="cd-tool-legend"><span>Extreme Fear</span><span>Neutral</span><span>Extreme Greed</span></div>`;
          const kind = v >= 55 ? "good" : v <= 45 ? "bad" : "warn";
          setOut("tFngOut", `<span>Today${y ? ` · yesterday ${y.value} (${esc(y.label)})` : ""}</span><b>${v} · ${esc(d.now.label)}</b>`, kind);
        } catch (e) { setOut("tFngOut", "Fear &amp; Greed isn't available right now. Try again later."); }
      },
    },
    {
      id: "whatif", icon: "🔁", name: "What If",
      html: () => `<div class="cd-tool-grid">${field("tWiAmt", "Amount (₹)", "10000")}${field("tWiCoin", "Coin", "ETH", { coin: true })}${select("tWiAgo", "Bought", [["30", "1 month ago"], ["90", "3 months ago"], ["180", "6 months ago"], ["365", "1 year ago"], ["730", "2 years ago"], ["1095", "3 years ago"]], "365")}</div>${out("tWiOut")}${note("At the closing price that day (weekly for 2–3 years). ₹ at today's rate.")}`,
      async calc() {
        const amt = num(val("tWiAmt")); const base = String(val("tWiCoin")).trim().toUpperCase(); const days = parseInt(val("tWiAgo"), 10);
        if (!(amt > 0) || !coinOf(base)) return setOut("tWiOut", "Enter an amount and a coin from the list.");
        setOut("tWiOut", "Calculating…");
        try {
          const rows = days <= 365 ? await candles(base, "1d", 400) : await candles(base, "1w", 160);
          const want = Date.now() / 1000 - days * 86400;
          const row = rows.find((c) => c.time >= want - (days <= 365 ? 86400 : 7 * 86400));
          if (!row) return setOut("tWiOut", `${esc(base)} wasn't trading back then.`);
          const g = (priceOf(base) / row.close - 1) * 100; const now = amt * (1 + g / 100);
          setOut("tWiOut", `<span>Bought at ${usd(row.close)} on ${new Date(row.time * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span><b class="${tone(g)}">${inr(now)} today (${pct(g, 1)})</b>`, g >= 0 ? "good" : "bad");
        } catch (e) { setOut("tWiOut", "Couldn't load past prices. Try again in a moment."); }
      },
    },
    {
      id: "lev", icon: "⚡", name: "Leverage & Liquidation",
      html: () => `<div class="cd-tool-grid">${field("tLevCoin", "Coin", "BTC", { coin: true })}${field("tLevEntry", "Entry ($)", "", { ph: "live price" })}${field("tLevX", "Leverage (x)", "10")}${select("tLevSide", "Side", [["long", "Long"], ["short", "Short"]], "long")}${field("tLevMargin", "Margin ($)", "500")}</div>${out("tLevOut")}${note("Education only — CryptoDock is spot paper trading, no leverage. Approximate isolated-margin liquidation with 0.5% maintenance margin.")}`,
      calc() {
        const base = val("tLevCoin"); const entry = Number.isFinite(num(val("tLevEntry"))) ? num(val("tLevEntry")) : priceOf(base);
        const x = num(val("tLevX")); const m = num(val("tLevMargin")); const long = val("tLevSide") === "long"; const mm = 0.005;
        if (!(entry > 0 && x >= 1 && x <= 125 && m > 0)) return setOut("tLevOut", "Enter entry, leverage (1–125x) and margin.");
        const liq = long ? entry * (1 - 1 / x + mm) : entry * (1 + 1 / x - mm);
        setOut("tLevOut", `<span>Position ${usd(m * x)} · ${long ? "Long" : "Short"} ${x}x from ${usd(entry)}</span><b class="cd-down">Liquidation ≈ ${usd(liq)} (${pct((liq / entry - 1) * 100, 1)})</b><small>A ${((1 / x) * 100).toFixed(1)}% move against you wipes the ${usd(m)} margin.</small>`, "bad");
      },
    },
    {
      id: "dom", icon: "👑", name: "BTC Dominance & Alt Season",
      html: () => `${out("tDomBar")}${out("tDomOut")}${out("tAltOut")}${note("Dominance from CoinGecko; Altcoin Season = share of the 50 most traded altcoins that beat BTC over 30 days (75+ = altcoin season, 25 or less = Bitcoin season). Refreshed hourly.")}`,
      async calc() {
        setOut("tDomOut", "Loading…");
        try {
          const d = await getJson("/api/market/global");
          if (d.dominance) {
            const b = d.dominance.btc, e = d.dominance.eth, o = Math.max(0, 100 - b - e);
            el("tDomBar").className = "";
            el("tDomBar").innerHTML = `<div class="cd-tool-split"><i style="width:${b}%;background:#f7931a"></i><i style="width:${e}%;background:#627eea"></i><i style="width:${o}%;background:#64748b"></i></div><div class="cd-tool-legend"><span style="color:#f7931a">BTC ${b.toFixed(1)}%</span><span style="color:#8b9dfc">ETH ${e.toFixed(1)}%</span><span>Others ${o.toFixed(1)}%</span></div>`;
            const cap = d.dominance.total_market_cap_usd; const ch = d.dominance.market_cap_change_24h;
            setOut("tDomOut", `<span>Total crypto market cap</span><b>${cap ? "$" + (cap / 1e12).toFixed(2) + "T" : "--"} <span class="${tone(ch)}">${pct(ch, 1)}</span></b>`, "warn");
          } else setOut("tDomOut", "Dominance isn't available right now.");
          if (d.altseason) {
            const a = d.altseason;
            setOut("tAltOut", `<span>Altcoin Season Index · ${a.beat} of ${a.counted} beat BTC (${pct(a.btc_30d, 1)} in 30D)</span><b>${a.index} · ${esc(a.label)}</b>`, a.index >= 75 ? "good" : a.index <= 25 ? "warn" : "");
          } else setOut("tAltOut", "Altcoin Season isn't ready yet — try again in a minute.");
        } catch (e) { setOut("tDomOut", "Market data isn't available right now. Try again later."); setOut("tAltOut", ""); }
      },
    },
    {
      id: "halving", icon: "⏳", name: "BTC Halving Countdown",
      html: () => `${out("tHalvOut")}<div class="cd-tool-grid is-3">
          <div class="cd-tool-stat"><span>Block reward now</span><b>3.125 BTC</b></div>
          <div class="cd-tool-stat"><span>After halving</span><b>1.5625 BTC</b></div>
          <div class="cd-tool-stat"><span>Halving block</span><b>1,050,000</b></div></div>${note("Bitcoin's new-coin reward halves every 210,000 blocks (~4 years). Date is an estimate (blocks ≈ 10 minutes); last halving 20 Apr 2024.")}`,
      calc() {
        const last = Date.UTC(2024, 3, 20) / 1000; const next = last + 210000 * 600; const left = next - Date.now() / 1000;
        const days = Math.max(0, Math.floor(left / 86400)); const done = Math.min(100, Math.max(0, (1 - left / (210000 * 600)) * 100));
        setOut("tHalvOut", `<span>Next halving ≈ ${new Date(next * 1000).toLocaleDateString("en-IN", { month: "short", year: "numeric" })} · ${done.toFixed(0)}% of the way there</span><b>~${days.toLocaleString("en-IN")} days left</b><div class="cd-tool-progress"><i style="width:${done}%"></i></div>`, "warn");
      },
    },
  ];

  // ---------- page ----------
  let current = "pnl";
  try { const s = localStorage.getItem(STORE); if (TOOLS.some((t) => t.id === s)) current = s; } catch (e) { /* ignore */ }

  function renderTiles() {
    tiles.innerHTML = TOOLS.map((t) => `<button type="button" class="cd-tool-tile${t.id === current ? " is-active" : ""}" data-tool="${t.id}">
        <i>${t.icon}</i><span>${esc(t.name)}</span>${t.tag ? `<em>${t.tag}</em>` : ""}</button>`).join("");
  }

  let calcTimer = null;
  function openTool(id, scroll) {
    const tool = TOOLS.find((t) => t.id === id) || TOOLS[0];
    current = tool.id;
    try { localStorage.setItem(STORE, current); } catch (e) { /* ignore */ }
    renderTiles();
    card.innerHTML = `<h3><i>${tool.icon}</i>${esc(tool.name)}${tool.tag ? ` <em>${tool.tag}</em>` : ""}</h3><div class="cd-tool-body">${tool.html()}</div>`;
    if (tool.bind) tool.bind();
    card.oninput = card.onchange = () => { clearTimeout(calcTimer); calcTimer = setTimeout(() => tool.calc(), 250); };
    tool.calc();
    if (scroll) card.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function fillCoins() {
    const list = el("cdToolCoins");
    const coins = markets().coins || [];
    if (list && list.childElementCount !== coins.length) list.innerHTML = coins.map((c) => `<option value="${esc(c.base)}"></option>`).join("");
  }

  tiles.addEventListener("click", (e) => { const t = e.target.closest("[data-tool]"); if (t) openTool(t.dataset.tool, true); });

  // Live tools (Mood) and price-based answers follow the prices while the page is open.
  window.addEventListener("cd-markets-updated", () => {
    if (activePanel() !== "tools") return;
    fillCoins();
    const tool = TOOLS.find((t) => t.id === current);
    if (tool && !["sip", "whatif", "fng", "dom", "avg"].includes(tool.id) && !card.contains(document.activeElement)) tool.calc();
  });

  function onOpen() { fillCoins(); openTool(current, false); }
  const panel = tiles.closest(".tab-panel");
  if (panel) new MutationObserver(() => { if (panel.classList.contains("active")) onOpen(); }).observe(panel, { attributes: true, attributeFilter: ["class"] });
  if (activePanel() === "tools") onOpen();
  else renderTiles();
})();
