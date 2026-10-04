// Price alerts for any coin: "tell me when SOL goes above $160". Saved per
// email (guest when signed out) and checked on every live price update from
// markets.js — so they work while CryptoDock is open (any page), not while
// it's closed. A triggered alert shows a toast, plays a short beep and, if
// allowed, a system notification.
(function cryptoPriceAlerts() {
  const KEY_PREFIX = "cdAlertsV1:";
  const el = (id) => document.getElementById(id);
  if (!el("cdAlertAdd")) return;

  const F = () => window.cdFormat || {};
  const fmtUsd = (v) => (F().fmtUsd ? F().fmtUsd(v) : "$" + v);
  const escapeHtml = (t) => (F().escapeHtml ? F().escapeHtml(t) : String(t));
  const priceOf = (base) => {
    const coin = window.cdMarkets && window.cdMarkets.coinsByBase ? window.cdMarkets.coinsByBase.get(base) : null;
    return coin && Number.isFinite(coin.price) ? coin.price : null;
  };

  function readEmail() {
    if (typeof window.cdUserEmail === "string") return window.cdUserEmail;
    try { return localStorage.getItem("cdUserEmail") || ""; } catch (e) { return ""; }
  }
  let account = readEmail();
  const storageKey = () => KEY_PREFIX + (account || "guest");
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey()) || "[]");
      return Array.isArray(saved) ? saved : [];
    } catch (e) { return []; }
  }
  let alerts = load();
  function save() {
    try { localStorage.setItem(storageKey(), JSON.stringify(alerts)); } catch (e) { /* ignore */ }
  }

  function message(text) {
    el("cdAlertMsg").textContent = text || "";
  }

  function addAlert() {
    const base = el("cdAlertCoin").value.trim().toUpperCase().replace(/USDT$/, "");
    const dir = el("cdAlertDir").value === "below" ? "below" : "above";
    const target = parseFloat(el("cdAlertPrice").value);
    const now = priceOf(base);
    if (!base || !now) return message("Pick a coin from the list (e.g. BTC, ETH, SOL).");
    if (!(target > 0)) return message("Enter the price for the alert.");
    if (dir === "above" && target <= now) return message(`${base} is already at ${fmtUsd(now)} — pick a price above it, or choose "Below".`);
    if (dir === "below" && target >= now) return message(`${base} is already at ${fmtUsd(now)} — pick a price below it, or choose "Above".`);
    alerts.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), base, dir, target, createdAt: Date.now(), status: "ACTIVE" });
    save();
    message(`Alert set: ${base} ${dir} ${fmtUsd(target)}.`);
    el("cdAlertPrice").value = "";
    render();
  }

  function beep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => ctx.close();
    } catch (e) { /* ignore */ }
  }

  function notify(text) {
    let node = el("cdToast");
    if (!node) {
      node = document.createElement("div");
      node.id = "cdToast";
      node.className = "cd-toast";
      node.setAttribute("role", "status");
      document.body.appendChild(node);
    }
    node.textContent = "🔔 " + text;
    node.classList.add("is-visible");
    setTimeout(() => node.classList.remove("is-visible"), 6000);
    beep();
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("CryptoDock price alert", { body: text, icon: "/frontend/logo.png" });
      }
    } catch (e) { /* some WebViews don't allow page notifications */ }
  }

  function checkAlerts() {
    let changed = false;
    alerts.forEach((a) => {
      if (a.status !== "ACTIVE") return;
      const price = priceOf(a.base);
      if (!price) return;
      if ((a.dir === "above" && price >= a.target) || (a.dir === "below" && price <= a.target)) {
        a.status = "TRIGGERED";
        a.triggeredAt = Date.now();
        a.triggeredPrice = price;
        changed = true;
        notify(`${a.base} is ${a.dir === "above" ? "above" : "below"} ${fmtUsd(a.target)} — now ${fmtUsd(price)}`);
      }
    });
    if (changed) save();
  }

  function render() {
    const active = alerts.filter((a) => a.status === "ACTIVE");
    const done = alerts.filter((a) => a.status === "TRIGGERED");
    el("cdAlertActive").innerHTML = active.map((a) => {
      const now = priceOf(a.base);
      const away = now ? ((a.target - now) / now) * 100 : null;
      return `<div class="cd-order-row">
        <span class="cd-order-side ${a.dir === "above" ? "cd-up" : "cd-down"}">${a.dir === "above" ? "▲" : "▼"}</span>
        <span class="cd-order-main"><strong>${escapeHtml(a.base)} ${a.dir} ${fmtUsd(a.target)}</strong><small>Now ${now ? fmtUsd(now) : "--"}${away !== null ? ` · ${Math.abs(away).toFixed(2)}% away` : ""}</small></span>
        <span></span>
        <button type="button" class="cd-ghost-btn cd-order-cancel" data-alert-del="${a.id}">Delete</button>
      </div>`;
    }).join("");
    el("cdAlertDone").innerHTML = done.map((a) => `<div class="cd-order-row">
        <span class="cd-order-side cd-flat">🔔</span>
        <span class="cd-order-main"><strong>${escapeHtml(a.base)} ${a.dir} ${fmtUsd(a.target)}</strong><small>Hit at ${fmtUsd(a.triggeredPrice)} · ${new Date(a.triggeredAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small></span>
        <span></span>
        <button type="button" class="cd-ghost-btn cd-order-cancel" data-alert-del="${a.id}">Delete</button>
      </div>`).join("");
    el("cdAlertActiveCount").textContent = active.length ? `(${active.length})` : "";
    el("cdAlertActiveEmpty").hidden = active.length > 0;
    el("cdAlertDoneEmpty").hidden = done.length > 0;
    el("cdAlertClear").hidden = done.length === 0;
    const btn = el("cdAlertNotifyBtn");
    if (btn) btn.hidden = !("Notification" in window) || Notification.permission !== "default";
  }

  // Coin Detail's "Set price alert" lands here with the coin and price filled in.
  function newAlert(base) {
    document.querySelector('.app-tab[data-tab="alerts"]')?.click();
    el("cdAlertCoin").value = base || "";
    const now = priceOf(base);
    el("cdAlertPrice").value = now ? String(now) : "";
    message(now ? `${base} is at ${fmtUsd(now)}. Change the price and tap Add alert.` : "");
    el("cdAlertPrice").focus();
  }

  el("cdAlertAdd").addEventListener("click", addAlert);
  el("cdAlertPrice").addEventListener("keydown", (e) => { if (e.key === "Enter") addAlert(); });
  el("cdAlertCoin").addEventListener("focus", () => window.cdFillCoinList && window.cdFillCoinList());
  el("cdAlertClear").addEventListener("click", () => { alerts = alerts.filter((a) => a.status !== "TRIGGERED"); save(); render(); });
  el("cdAlertNotifyBtn")?.addEventListener("click", async () => {
    try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
    render();
  });
  document.addEventListener("click", (event) => {
    const del = event.target.closest("[data-alert-del]");
    if (del) { alerts = alerts.filter((a) => a.id !== del.dataset.alertDel); save(); render(); }
  });

  window.addEventListener("cd-markets-updated", () => { checkAlerts(); render(); });
  window.addEventListener("cd-user-changed", (event) => {
    const next = (event.detail && event.detail.email) || "";
    if (next === account) return;
    account = next;
    alerts = load();
    render();
  });

  window.cdNewAlert = newAlert;
  render();
})();
