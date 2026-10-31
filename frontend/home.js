// Home page extras. Market mood and Top setups (owner account for now), then Latest news,
// Price alerts and My trading stats (Pro / owner). Everything is read from data the app already
// has: the coin list (markets.js), the paper account (paper.js) and the alerts (alerts.js);
// only the news adds one request to /api/news, cached for 5 minutes.
(function cryptoHomeExtras() {
  const el = (id) => document.getElementById(id);
  if (!el("cdHomeMoodCard")) return;

  const F = () => window.cdFormat || {};
  const esc = (v) => (F().escapeHtml ? F().escapeHtml(v) : String(v ?? ""));
  const isOwner = () => !!(F().isOwner && F().isOwner());
  const isPro = () => { try { return !!(window.cdProAccess && window.cdProAccess().ok); } catch (e) { return false; } };
  const markets = () => window.cdMarkets;
  const fmtMoney = (v) => (v < 0 ? "-" : "") + "$" + Math.abs(Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const BUY_MIN = 55, SELL_MAX = 45;        // BTC score that opens the buy / sell side
  const SETUP_BUY = 70, SETUP_SELL = 30;    // coin score for a setup
  const SETUP_MIN_VOLUME = 20e6;            // $20M a day: thinner coins are mostly noise
  const SETUP_MAX_MOVE = 15;                // a coin already 15% away is usually late

  // ---------- Market mood (BTC decides which side to look at) ----------
  function btcSide() {
    const m = markets();
    const btc = m && m.coinsByBase && m.coinsByBase.get("BTC");
    if (!btc || !Number.isFinite(btc.momentum)) return null;
    const dir = F().momDir ? F().momDir("BTC") : 0; // 1 price rising, -1 falling, 0 not known yet
    const score = btc.momentum;
    let side = "wait", text = "Wait, no new trades", sub = "BTC has not picked a side yet.";
    if (score >= BUY_MIN && dir >= 0) { side = "buy"; text = "Bullish setups"; sub = "BTC is strong and its price is not falling."; }
    else if (score <= SELL_MAX && dir <= 0) { side = "sell"; text = "Bearish setups"; sub = "BTC is weak and its price is not rising."; }
    else if (score >= BUY_MIN) sub = "BTC score is high but its price is falling.";
    else if (score <= SELL_MAX) sub = "BTC score is low but its price is rising.";
    return { side, text, sub, score };
  }

  function renderMood(info) {
    const box = el("cdHomeMood");
    if (!info) { box.innerHTML = '<p class="cd-meta">Loading BTC…</p>'; return; }
    const tone = info.side === "buy" ? "is-up" : info.side === "sell" ? "is-down" : "is-flat";
    box.innerHTML = `<div class="cd-hx-dial ${tone}">${info.score}</div>
      <div><strong class="cd-hx-mood-title ${tone}">${esc(info.text)}</strong><span>${esc(info.sub)}</span></div>`;
  }

  // ---------- Top setups (only coins that fit the side BTC points to) ----------
  function renderSetups(info) {
    const list = el("cdHomeSetups"), note = el("cdHomeSetupsNote");
    const m = markets();
    if (!info || !m) { list.innerHTML = '<li class="cd-meta">--</li>'; note.textContent = ""; return; }
    if (info.side === "wait") {
      note.textContent = "";
      list.innerHTML = '<li class="cd-meta cd-hx-empty">No new trades while BTC has no direction. Check again later.</li>';
      return;
    }
    const buy = info.side === "buy";
    note.textContent = buy ? "score 70+ and rising" : "score 30- and falling";
    const picked = m.coins.filter((c) => {
      if (!Number.isFinite(c.momentum) || c.volume_usdt < SETUP_MIN_VOLUME) return false;
      const dir = F().momDir ? F().momDir(c.base) || (buy ? 1 : -1) : 0;
      return buy ? c.momentum >= SETUP_BUY && dir > 0 && c.change_percent < SETUP_MAX_MOVE
                 : c.momentum <= SETUP_SELL && dir < 0 && c.change_percent > -SETUP_MAX_MOVE;
    }).sort((a, b) => (buy ? b.momentum - a.momentum : a.momentum - b.momentum)).slice(0, 5);
    list.innerHTML = picked.map((c) => {
      const score = Math.round(c.momentum);
      const up = (F().momDir ? F().momDir(c.base) || (buy ? 1 : -1) : (buy ? 1 : -1)) > 0;
      return `<li class="cd-hx-card ${buy ? "is-up" : "is-down"}" data-base="${esc(c.base)}">
        <div class="cd-hx-card-top">${F().avatar(c.base)}<strong>${esc(c.base)}</strong></div>
        <div class="cd-hx-ring" style="--s:${Math.max(0, Math.min(100, score))}"><i>${score}</i></div>
        <div class="cd-hx-card-price"><i class="cd-hx-arrow ${up ? "is-up" : "is-down"}" aria-label="${up ? "Price is moving up" : "Price is moving down"}">${up ? "▲" : "▼"}</i>${F().fmtUsd(c.price)}</div>
        <div class="cd-hx-card-chg ${F().pctClass(c.change_percent)}">${F().fmtPct(c.change_percent)} · 24h</div>
      </li>`;
    }).join("") || `<li class="cd-meta cd-hx-empty">No coin fits right now. That is normal; do not force a trade.</li>`;
  }

  // ---------- Latest news ----------
  const NEWS_EVERY_MS = 5 * 60 * 1000;
  let news = { items: [], at: 0, loading: false, lang: "" };
  const newsLang = () => { try { return localStorage.getItem("cdNewsLang") === "hi" ? "hi" : "en"; } catch (e) { return "en"; } };
  function ago(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  function renderNews() {
    const box = el("cdHomeNews");
    if (!news.items.length) { box.innerHTML = `<p class="cd-meta">${news.loading ? "Loading the latest headlines…" : "News is not available right now."}</p>`; return; }
    box.innerHTML = news.items.slice(0, 3).map((it) => `
      <a class="cd-hx-newsrow" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">
        <span class="cd-hx-newstext"><b>${esc(it.title)}</b><small>${esc(it.source)} · ${esc(ago(it.published))}</small></span>
        <span class="cd-hx-thumb">${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</span>
      </a>`).join("");
  }
  async function loadNews() {
    const lang = newsLang();
    if (news.loading || (news.lang === lang && Date.now() - news.at < NEWS_EVERY_MS)) return;
    news.loading = true;
    renderNews();
    try {
      const res = await fetch(`/api/news?lang=${lang}`, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      news = { items: Array.isArray(data.items) ? data.items.filter((i) => i.image).concat(data.items.filter((i) => !i.image)) : [], at: Date.now(), loading: false, lang };
    } catch (e) {
      news.loading = false;
      news.at = Date.now() - NEWS_EVERY_MS + 60 * 1000; // try again in a minute
    }
    renderNews();
  }

  // ---------- Price alerts ----------
  function renderAlerts() {
    const box = el("cdHomeAlerts");
    const api = window.cdAlertsApi;
    const active = api ? api.active() : [];
    const m = markets();
    if (!active.length) { box.innerHTML = '<p class="cd-meta">No active alerts. Open Alerts to set one.</p>'; return; }
    box.innerHTML = active.slice(0, 3).map((a) => {
      const coin = m && m.coinsByBase && m.coinsByBase.get(a.base);
      const away = coin && coin.price ? Math.abs((a.target - coin.price) / coin.price) * 100 : null;
      return `<div class="cd-hx-alert"><span>${esc(a.base)} ${a.dir === "below" ? "below" : "above"} <b>${F().fmtUsd ? F().fmtUsd(a.target) : a.target}</b></span><span class="cd-meta">${away === null ? "" : away.toFixed(1) + "% away"}</span></div>`;
    }).join("") + (active.length > 3 ? `<p class="cd-meta">+${active.length - 3} more</p>` : "");
  }

  // ---------- My trading stats ----------
  function renderStats() {
    const box = el("cdHomeStats");
    const s = window.cdPaperApi ? window.cdPaperApi.stats(30) : null;
    if (!s) { box.innerHTML = '<p class="cd-meta">No closed trades yet. Your results show here after your first closed trade.</p>'; return; }
    const pct = Math.round((s.wins / s.n) * 100);
    box.innerHTML = `
      <div class="cd-hx-stat"><b>${pct}%</b><span>trades won (${s.wins} of ${s.n})</span></div>
      <div class="cd-hx-stat"><b class="${s.best >= 0 ? "cd-up" : "cd-down"}">${s.best >= 0 ? "+" : ""}${fmtMoney(s.best)}</b><span>best trade</span></div>
      <div class="cd-hx-stat"><b class="${s.worst >= 0 ? "cd-up" : "cd-down"}">${s.worst >= 0 ? "+" : ""}${fmtMoney(s.worst)}</b><span>worst trade</span></div>`;
  }

  // ---------- show / hide and refresh ----------
  function render() {
    const owner = isOwner(), pro = isPro();
    const info = owner ? btcSide() : null;
    el("cdHomeMoodCard").hidden = !owner;
    el("cdHomeSetupsCard").hidden = !owner;
    el("cdHomeNewsCard").hidden = !pro;
    el("cdHomeAlertsCard").hidden = !pro;
    el("cdHomeStatsCard").hidden = !pro;
    if (owner) { renderMood(info); renderSetups(info); }
    if (pro) { renderAlerts(); renderStats(); loadNews(); }
  }


  // ---------- Long / Short mood (futures crowd, funding, open interest) ----------
  // Served by /api/futures/mood: one shared copy per coin, refreshed about once a minute.
  const fx = { coin: "BTC", data: {}, at: {} };
  const fmtBig = (n) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(0)}M`;
  function renderFutures() {
    const card = el("cdHomeFuturesCard");
    const d = fx.data[fx.coin];
    card.hidden = !d && !Object.values(fx.data).some(Boolean);
    document.querySelectorAll("#cdFxCoins button").forEach((b) => b.classList.toggle("is-active", b.dataset.fx === fx.coin));
    const body = el("cdFxBody");
    if (!d) { body.innerHTML = '<p class="cd-meta">Data for this coin is not available right now.</p>'; return; }
    const crowd = d.long_pct >= 55 ? "Long-heavy" : d.long_pct <= 45 ? "Short-heavy" : "Balanced";
    const fundCls = d.funding_pct > 0 ? "cd-up" : d.funding_pct < 0 ? "cd-down" : "";
    body.innerHTML = `
      <div class="cd-fx-bar"><i class="is-long" style="width:${d.long_pct}%"></i><i class="is-short" style="width:${d.short_pct}%"></i></div>
      <div class="cd-fx-split"><span class="cd-up">Long ${d.long_pct}%</span><span class="cd-down">Short ${d.short_pct}%</span></div>
      <div class="cd-fx-stats">
        <div><span>Funding</span><b class="${fundCls}">${d.funding_pct > 0 ? "+" : ""}${d.funding_pct}%</b></div>
        <div><span>Open interest</span><b>${fmtBig(d.oi_usd)}</b></div>
        <div><span>Crowd</span><b>${crowd}</b></div>
      </div>
      <p class="cd-meta cd-fx-note">${esc(fx.coin)} futures accounts, ${esc(d.source)}. Positive funding means longs pay shorts. It shows who is crowded, not where price goes next. Educational, not advice.</p>`;
  }
  async function loadFutures(coin, force) {
    const now = Date.now();
    if (!force && fx.at[coin] && now - fx.at[coin] < 55000) { renderFutures(); return; }
    fx.at[coin] = now;
    try {
      const res = await fetch(`/api/futures/mood?coin=${coin}`, { cache: "no-store" });
      if (res.ok) fx.data[coin] = (await res.json()).data || null;
    } catch (e) { /* keep the last copy */ }
    renderFutures();
  }
  document.addEventListener("click", (event) => {
    const b = event.target.closest("#cdFxCoins button[data-fx]");
    if (b) { fx.coin = b.dataset.fx; renderFutures(); loadFutures(fx.coin); }
  });
  setInterval(() => { if (document.querySelector(".tab-panel.active")?.dataset.panel === "dashboard" && !document.hidden) loadFutures(fx.coin); }, 60000);
  setTimeout(() => loadFutures("BTC"), 2500);

  window.addEventListener("cd-markets-updated", render);
  window.addEventListener("cd-user-changed", () => setTimeout(render, 300));
  window.addEventListener("cd-auth-state", () => setTimeout(render, 300));
  setTimeout(render, 1500);
})();
