// CryptoDock Pro: every email gets one 7-day trial, started by the user
// from the trial card or the Pro status card (the server remembers it for
// good), then a plan — ₹99 / 1 month, ₹299 / 6 months, ₹499 / 1 year, paid
// through Razorpay on the website and Google Play Billing inside the Android
// app (Play's rules). Pro: paper trading (order ticket, Positions, Orders),
// Heatmap, Price Alerts, RRG and News (the cards list these), plus Coin
// Detail. The Scanner stays free for every signed-in user. Upgrade shows
// until the trial is started, hides during the trial and a paid plan, and
// comes back when either ends. The owner's email always has access.
(function cryptoPro() {
  const OWNER_EMAIL = "amitkmrai21@gmail.com";
  // Test account given to Google Play's app reviewers: full access, no trial
  // or payment needed (they can't start trials or buy plans).
  const REVIEW_EMAILS = ["amitkmrai47@gmail.com"];
  const hasFullAccess = (mail) => mail === OWNER_EMAIL || REVIEW_EMAILS.includes(mail);
  const PRO_TABS = {
    positions: "Paper Trading",
    orders: "Paper Trading",
    heatmap: "Heatmap",
    alerts: "Price Alerts",
    rrg: "RRG",
    news: "News",
    coin: "Coin Detail",
  };
  const PLAN_PRICES = { "Monthly Plan": 99, "Half-Yearly Plan": 299, "Annual Plan": 499 };
  // Inside the Android app plans are Google Play subscriptions (they renew
  // until cancelled); on the website they are one-time Razorpay payments.
  const PLAY_PRODUCTS = { "Monthly Plan": "cryptodock_pro_1m", "Half-Yearly Plan": "cryptodock_pro_6m", "Annual Plan": "cryptodock_pro_1y" };
  const PLAN_PERIOD = { "Monthly Plan": "month", "Half-Yearly Plan": "6 months", "Annual Plan": "year" };
  const NATIVE = !!(window.Capacitor?.isNativePlatform?.() && window.Capacitor?.getPlatform?.() === "android");
  const iap = () => window.Capacitor?.Plugins?.NativePurchases;

  const el = (id) => document.getElementById(id);
  if (!el("cdProGate")) return;

  // ---------- who & what plan ----------
  function readEmail() {
    if (typeof window.cdUserEmail === "string") return window.cdUserEmail;
    try { return localStorage.getItem("cdUserEmail") || ""; } catch (e) { return ""; }
  }
  let email = readEmail();
  const cacheKey = () => "cdProStatus:" + email;
  function readCached() {
    try { return JSON.parse(localStorage.getItem(cacheKey()) || "null"); } catch (e) { return null; }
  }
  let status = email ? readCached() : null;

  let syncing = null;
  function sync() {
    if (!syncing) syncing = doSync().finally(() => { syncing = null; });
    return syncing;
  }

  async function doSync() {
    if (!email) { status = null; renderUpgrade(); return; }
    const forEmail = email;
    try {
      const res = await fetch("/api/user/sync-trial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forEmail }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (forEmail !== email) return; // signed into another account meanwhile
      status = data;
      try { localStorage.setItem(cacheKey(), JSON.stringify(data)); } catch (e) { /* ignore */ }
    } catch (e) {
      // Keep the cached status; access() says "checking" if there's none.
    }
    renderUpgrade();
    renderStatusCard();
    loginNotice();
    restorePlay();
  }

  // { ok, reason: owner | paid | trial | fresh | signin | expired | plan-expired | checking }
  function access() {
    if (!email) return { ok: false, reason: "signin" };
    if (hasFullAccess(email)) return { ok: true, reason: "owner" };
    if (!status) { sync(); return { ok: false, reason: "checking" }; }
    const now = Date.now() / 1000;
    if (status.is_paid && (!status.valid_until_ts || status.valid_until_ts > now)) return { ok: true, reason: "paid" };
    // Signed up but the 7-day trial hasn't been started yet (it starts on the
    // "Start 7-day free trial" button, not at sign-up).
    if (status.trial_started === false) return { ok: false, reason: "fresh" };
    if (status.trial_end_ts && status.trial_end_ts > now) {
      return {
        ok: true,
        reason: "trial",
        daysLeft: Math.max(1, Math.ceil((status.trial_end_ts - now) / 86400)),
      };
    }
    return { ok: false, reason: status.plan_expired ? "plan-expired" : "expired" };
  }
  window.cdProAccess = access;

  // ---------- gate ----------
  const show = (id) => { el(id).hidden = false; };
  const hide = (id) => { el(id).hidden = true; };

  function openSignIn() {
    el("topSettingsMenuButton")?.click();
    setTimeout(() => el("accountLoggedOutGroup")?.scrollIntoView({ behavior: "smooth", block: "center" }), 250);
  }

  function showGate(acc, feature) {
    // Features and prices only where a plan is the next step.
    el("cdProGateExtra").hidden = acc.reason === "checking";
    const title = el("cdProGateTitle");
    const text = el("cdProGateText");
    const primary = el("cdProGatePrimary");
    if (acc.reason === "signin") {
      title.textContent = `Sign in to use ${feature}`;
      text.textContent = `${feature} is part of CryptoDock Pro. Sign in to start your 7-day free trial — no payment needed.`;
      primary.textContent = "Sign in / Sign up";
      primary.onclick = () => { hide("cdProGate"); openSignIn(); };
    } else if (acc.reason === "checking") {
      title.textContent = "Checking your plan…";
      text.textContent = "We're confirming your CryptoDock Pro access. Please tap again in a moment.";
      primary.textContent = "OK";
      primary.onclick = () => hide("cdProGate");
    } else if (acc.reason === "plan-expired") {
      title.textContent = "Your CryptoDock Pro plan has expired";
      text.textContent = `${feature} needs an active plan. Renew to unlock paper trading, Heatmap, Alerts, RRG and News again.`;
      primary.textContent = "Renew plan";
      primary.onclick = () => { hide("cdProGate"); openPlans(); };
    } else {
      title.textContent = "Your 7-day free trial has ended";
      text.textContent = `${feature} needs a CryptoDock Pro plan — from ₹99/month. Choose a plan to unlock paper trading, Heatmap, Alerts, RRG and News.`;
      primary.textContent = "View plans";
      primary.onclick = () => { hide("cdProGate"); openPlans(); };
    }
    show("cdProGate");
  }

  // ---------- starting the 7-day trial ----------
  // The first time a signed-up user opens a Pro feature, the trial card
  // offers the free week; the trial (and its 7 days) starts on that tap.
  const welcomeKey = () => "cdProWelcomeAccepted:" + email;
  let pendingResume = null;
  function showTrialCard(resume) {
    el("cdTrialError").hidden = true;
    pendingResume = resume || null;
    show("cdTrialCard");
  }

  async function startTrial() {
    const res = await fetch("/api/user/start-trial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Could not start the trial. Please try again.");
    status = data;
    try { localStorage.setItem(cacheKey(), JSON.stringify(data)); localStorage.setItem(welcomeKey(), "1"); } catch (e) { /* ignore */ }
    renderUpgrade();
    renderStatusCard();
    return data;
  }

  el("cdTrialAccept").addEventListener("click", async () => {
    const btn = el("cdTrialAccept");
    btn.disabled = true;
    el("cdTrialError").hidden = true;
    try {
      await startTrial();
      hide("cdTrialCard");
      const resume = pendingResume;
      pendingResume = null;
      if (resume) resume();
    } catch (error) {
      el("cdTrialError").textContent = error.message;
      el("cdTrialError").hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // Plan tiles on the trial card and the Pro card: tap to choose a plan.
  // The choice carries over to the Choose-your-plan sheet (its radios).
  const PLAN_LABEL = { "Monthly Plan": "Monthly", "Half-Yearly Plan": "Half-Yearly", "Annual Plan": "Annual" };
  function choosePlan(name) {
    if (!PLAN_PRICES[name]) return;
    document.querySelectorAll(".cdp-prices [data-plan]").forEach((b) => b.classList.toggle("is-sel", b.dataset.plan === name));
    const radio = document.querySelector(`input[name="cdPlan"][value="${name}"]`);
    if (radio) radio.checked = true;
    el("cdTrialBuy").textContent = `Buy ${PLAN_LABEL[name]} plan now · ₹${PLAN_PRICES[name]}`;
    renderPlans();
  }
  document.addEventListener("click", (e) => {
    const tile = e.target.closest(".cdp-prices [data-plan]");
    if (tile) choosePlan(tile.dataset.plan);
  });
  el("cdTrialBuy").addEventListener("click", () => {
    try { localStorage.setItem(welcomeKey(), "1"); } catch (e) { /* ignore */ }
    pendingResume = null;
    hide("cdTrialCard");
    openPlans();
  });

  // Runs `action` if Pro is open for this user; otherwise shows why not.
  function guard(feature, action) {
    const acc = access();
    if (acc.reason === "fresh") { showTrialCard(action); return false; }
    if (acc.ok) { action(); return true; }
    showGate(acc, feature);
    return false;
  }

  // Sidebar tabs (capture phase: runs before the tab switches).
  document.addEventListener("click", (event) => {
    const tab = event.target.closest(".app-tab[data-tab]");
    if (!tab || !PRO_TABS[tab.dataset.tab] || tab.dataset.proPass === "1") return;
    const acc = access();
    if (acc.ok) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    guard(PRO_TABS[tab.dataset.tab], () => {
      tab.dataset.proPass = "1";
      tab.click();
      delete tab.dataset.proPass;
    });
  }, true);

  // The order ticket (Buy/Sell from any coin) is paper trading too.
  const openTicket = window.cdOpenTicket;
  if (typeof openTicket === "function") {
    window.cdOpenTicket = (base, side) => guard("Paper Trading", () => openTicket(base, side));
  }

  // A page restored from the last session that's now locked goes back to the Dashboard.
  function leaveLockedPage() {
    const panel = document.querySelector(".tab-panel.active")?.dataset.panel;
    if (panel && PRO_TABS[panel] && !access().ok && access().reason !== "checking") {
      document.querySelector('.app-tab[data-tab="dashboard"]')?.click();
    }
  }

  // ---------- notice on sign-in when the trial / plan has ended ----------
  function loginNotice() {
    const acc = access();
    if (acc.ok || (acc.reason !== "expired" && acc.reason !== "plan-expired")) return;
    leaveLockedPage();
    const key = "cdProNoticeShown:" + email;
    try { if (sessionStorage.getItem(key) === "1") return; sessionStorage.setItem(key, "1"); } catch (e) { /* ignore */ }
    showGate(acc, "CryptoDock Pro");
  }

  // ---------- Upgrade button: only when there's something to buy ----------
  function renderUpgrade() {
    const acc = access();
    el("cdUpgradeBtn").hidden = acc.reason === "owner" || acc.reason === "paid" || acc.reason === "trial";
    const mine = el("cdMyPlanState");
    if (mine) {
      mine.textContent = { owner: email === OWNER_EMAIL ? "Owner · active" : "Full access · active", paid: "Active", trial: `Trial · ${acc.daysLeft} day${acc.daysLeft === 1 ? "" : "s"} left`, fresh: "Free trial available", expired: "Trial ended", "plan-expired": "Plan expired", checking: "Checking…" }[acc.reason] || "--";
      mine.className = acc.ok ? "is-on" : acc.reason === "fresh" ? "is-new" : "is-off";
    }
  }

  // ---------- Pro status card (Upgrade / Settings → My plan) ----------
  const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  function renderStatusCard() {
    if (!el("cdProStatus")) return;
    const acc = access();
    const now = Date.now() / 1000;
    const banner = el("cdProStatusBanner");
    const primary = el("cdProStatusPrimary");
    const secondary = el("cdProStatusSecondary");
    const barWrap = el("cdProStatusBarWrap");
    let tone = "info", icon = "🗓️", title = "", sub = "", dates = "", note = "", bar = null;
    // Days box (total / used / left) and the next price to pay.
    let days = null, nextHead = "NEXT PRICE", nextNote = "", nextPick = null;
    const DAY = 86400, TRIAL_DAYS = 7;
    secondary.hidden = true;
    primary.className = "cdp-primary";
    if (acc.reason === "owner") {
      const isOwner = email === OWNER_EMAIL;
      tone = "ok"; icon = "👑"; title = isOwner ? "Owner access · ACTIVE ✓" : "Full access · ACTIVE ✓"; sub = "Every Pro feature, always on."; dates = "No plan needed for this account.";
      note = "You have full access to CryptoDock Pro."; primary.textContent = "Close"; primary.onclick = () => hide("cdProStatus");
      nextHead = "PLANS USERS SEE"; nextNote = isOwner ? "Owner: nothing to pay." : "This account needs no plan.";
    } else if (acc.reason === "paid") {
      const left = Math.max(0, Math.ceil((status.valid_until_ts - now) / 86400));
      const plan = status.plan || "Plan";
      tone = "ok"; icon = "👑"; title = "Plan status: ACTIVE ✓"; sub = `CryptoDock Pro · ${plan}${PLAN_PRICES[plan] ? ` (₹${PLAN_PRICES[plan]})` : ""}`;
      dates = `Valid until <b>${fmtDate(status.valid_until_ts)}</b> · ${left} day${left === 1 ? "" : "s"} remaining`;
      note = NATIVE ? "Your plan is active and renews automatically until you cancel it in Google Play." : "Your plan is active. Buying again adds to the time you have left.";
      const total = status.paid_at ? Math.max(left, Math.round((status.valid_until_ts - status.paid_at) / DAY)) : left;
      days = { total, used: Math.max(0, total - left), left };
      nextHead = "NEXT PRICE · RENEW OR SWITCH"; nextPick = PLAN_PRICES[plan] ? plan : null;
      nextNote = NATIVE ? "Manage or cancel the subscription in Google Play → Subscriptions." : `Renewing now adds the new plan's days after ${fmtDate(status.valid_until_ts)}. No auto-renewal.`;
      primary.textContent = NATIVE ? "Manage in Google Play" : "Extend plan →";
      primary.onclick = NATIVE ? () => { iap()?.manageSubscriptions?.().catch(() => {}); } : () => { hide("cdProStatus"); openPlans(); };
    } else if (acc.reason === "trial") {
      const total = 7 * 86400, start = status.trial_start_ts || now;
      bar = Math.min(1, Math.max(0, (now - start) / total));
      const day = Math.min(7, Math.max(1, Math.ceil((now - start) / 86400)));
      tone = "ok"; icon = "⏳"; title = "7-day free trial ACTIVE ✓"; sub = `Day ${day} of 7 · ${acc.daysLeft} day${acc.daysLeft === 1 ? "" : "s"} left`;
      dates = `Trial ends on <b>${fmtDate(status.trial_end_ts)}</b>`;
      note = "Every Pro feature is open during the trial. Pick a plan any time to keep it after the trial.";
      days = { total: TRIAL_DAYS, used: Math.max(0, TRIAL_DAYS - acc.daysLeft), left: acc.daysLeft };
      nextHead = "NEXT PRICE · AFTER THE TRIAL"; nextNote = "Nothing is charged when the trial ends; choose a plan only if you want to continue.";
      primary.className = "cdp-primary cdp-primary--green"; primary.textContent = "Choose a plan →"; primary.onclick = () => { hide("cdProStatus"); openPlans(); };
    } else if (acc.reason === "fresh") {
      tone = "new"; icon = "🎁"; title = "7-day free trial available"; sub = "Not started yet · no payment needed";
      dates = "Your 7 days start only when you tap Start.";
      note = "Try every Pro feature free for 7 days, then choose a plan if you like it.";
      days = { total: TRIAL_DAYS, used: 0, left: TRIAL_DAYS };
      nextHead = "NEXT PRICE · AFTER THE FREE TRIAL"; nextNote = "The 7 free days start only when you tap Start.";
      primary.className = "cdp-primary cdp-primary--green"; primary.textContent = "Start 7-day free trial →";
      primary.onclick = async () => {
        primary.disabled = true; el("cdProStatusError").hidden = true;
        try { await startTrial(); } catch (error) { el("cdProStatusError").textContent = error.message; el("cdProStatusError").hidden = false; }
        finally { primary.disabled = false; }
      };
      secondary.hidden = false; secondary.textContent = "Or buy a plan now"; secondary.onclick = () => { hide("cdProStatus"); openPlans(); };
    } else if (acc.reason === "signin") {
      tone = "info"; icon = "🔑"; title = "Sign in to start"; sub = "Your plan is tied to your email.";
      dates = "Sign up free, then start your 7-day trial.";
      primary.textContent = "Sign in / Sign up"; primary.onclick = () => { hide("cdProStatus"); openSignIn(); };
    } else if (acc.reason === "checking") {
      tone = "info"; icon = "⏱️"; title = "Checking your plan…"; sub = "One moment."; primary.textContent = "Close"; primary.onclick = () => hide("cdProStatus");
    } else {
      const ended = acc.reason === "plan-expired" ? status.valid_until_ts : status.trial_end_ts;
      tone = "off"; icon = "⛔"; title = acc.reason === "plan-expired" ? "Plan expired" : "Free trial ended";
      sub = "Pro features are locked."; dates = ended ? `Ended on <b>${fmtDate(ended)}</b>` : "";
      note = "Choose a plan — from ₹99/month — to unlock paper trading, Heatmap, Alerts, RRG and News again.";
      if (acc.reason === "plan-expired") {
        const total = status.paid_at && status.valid_until_ts ? Math.round((status.valid_until_ts - status.paid_at) / DAY) : null;
        days = total ? { total, used: total, left: 0 } : null;
        nextPick = PLAN_PRICES[status.plan] ? status.plan : null; nextHead = "NEXT PRICE · RENEW";
      } else {
        days = { total: TRIAL_DAYS, used: TRIAL_DAYS, left: 0 }; nextHead = "NEXT PRICE";
      }
      nextNote = NATIVE ? "Subscription · renews until cancelled in Google Play." : "One-time payment · no auto-renewal.";
      primary.textContent = acc.reason === "plan-expired" ? "Renew plan →" : "Choose a plan →"; primary.onclick = () => { hide("cdProStatus"); openPlans(); };
    }
    banner.className = "cdp-state is-" + tone;
    el("cdProStatusIcon").textContent = icon;
    el("cdProStatusTitle").textContent = title;
    el("cdProStatusSub").textContent = sub;
    el("cdProStatusDates").innerHTML = dates;
    el("cdProStatusDates").hidden = !dates;
    el("cdProStatusNote").textContent = note;
    el("cdProStatusNote").hidden = !note;
    barWrap.hidden = bar === null;
    el("cdProDays").hidden = !days;
    if (days) {
      el("cdProDaysTotal").textContent = days.total;
      el("cdProDaysUsed").textContent = days.used;
      el("cdProDaysLeft").textContent = days.left;
      el("cdProDays").classList.toggle("is-none-left", days.left === 0);
    }
    el("cdProNext").hidden = acc.reason === "checking";
    el("cdProNextHead").textContent = nextHead;
    el("cdProNextNote").textContent = nextNote;
    el("cdProNextNote").hidden = !nextNote;
    document.querySelectorAll("#cdProNext [data-next-plan]").forEach((b) => b.classList.toggle("is-current", b.dataset.nextPlan === nextPick));
    if (bar !== null) el("cdProStatusBar").style.width = Math.round(bar * 100) + "%";
  }
  function openStatusCard() {
    el("cdProStatusError").hidden = true;
    renderStatusCard();
    show("cdProStatus");
    sync().then(renderStatusCard);
  }
  window.cdOpenProStatus = openStatusCard;

  // ---------- plans & payment ----------
  function selectedPlan() {
    return document.querySelector('input[name="cdPlan"]:checked')?.value || "Annual Plan";
  }
  function plansError(text) {
    el("cdPlansError").textContent = text || "";
    el("cdPlansError").hidden = !text;
  }
  function renderPlans() {
    const picked = selectedPlan();
    el("cdPlansPay").textContent = NATIVE
      ? `Subscribe · ${playPrice(picked)} / ${PLAN_PERIOD[picked]}`
      : `Pay ₹${PLAN_PRICES[picked]} securely`;
    const acc = access();
    const until = status && status.valid_until_ts ? new Date(status.valid_until_ts * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";
    el("cdPlansStatus").textContent =
      acc.reason === "paid" ? (NATIVE ? `Your plan is active until ${until}.` : `Your plan is active until ${until}. Buying again adds to it.`) :
      acc.reason === "trial" ? `Free trial: ${acc.daysLeft} day${acc.daysLeft === 1 ? "" : "s"} left.` :
      acc.reason === "plan-expired" ? `Your plan ended on ${until}.` :
      acc.reason === "signin" ? "Sign in first — your plan is tied to your email." :
      "Your free trial has ended.";
  }
  function openPlans() {
    plansError("");
    renderPlans();
    show("cdPlans");
    if (NATIVE && iap() && !playOffers) loadPlayOffers().then(showPlayPrices).catch(() => {});
  }
  // Show the prices Google Play will charge (local currency, taxes included).
  function showPlayPrices() {
    document.querySelectorAll('input[name="cdPlan"]').forEach((r) => {
      const b = r.closest(".cdp-plan")?.querySelector(".cdp-plan-price b");
      if (b) b.textContent = playPrice(r.value);
    });
    renderPlans();
  }

  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load Razorpay. Check your internet and try again."));
      document.head.appendChild(script);
    });
  }

  // ---------- Google Play Billing (Android app only) ----------
  let playOffers = null; // product id -> { plan, token, price }
  const playPrice = (planName) => playOffers?.[PLAY_PRODUCTS[planName]]?.price || `₹${PLAN_PRICES[planName]}`;
  async function loadPlayOffers() {
    if (playOffers) return playOffers;
    const { products } = await iap().getProducts({ productIdentifiers: Object.values(PLAY_PRODUCTS), productType: "subs" });
    const found = {};
    (products || []).forEach((p) => {
      const id = p.planIdentifier;
      // The plain base plan (no promo offer) of each subscription.
      if (id && !found[id] && !p.offerId) found[id] = { plan: p.identifier, token: p.offerToken, price: p.priceString };
    });
    playOffers = found;
    return found;
  }
  async function getAccessToken() {
    try {
      const { data } = await window.marketDockSupabase.auth.getSession();
      return data?.session?.access_token || "";
    } catch (e) { return ""; }
  }
  // Google confirms the purchase to our server; only then is Pro unlocked.
  async function verifyPlay(productId, purchaseToken, orderId) {
    const token = await getAccessToken();
    if (!token) throw new Error("Please sign in again, then reopen this screen.");
    const res = await fetch("/api/billing/verify-play-purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ product_id: productId, purchase_token: purchaseToken, order_id: orderId || "" }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.detail || "Could not confirm the purchase.");
    return result;
  }
  async function payNative(planName) {
    const productId = PLAY_PRODUCTS[planName];
    const offers = await loadPlayOffers();
    const offer = offers[productId];
    if (!offer) throw new Error("This plan is not available in Google Play yet. Please try again later.");
    let tx;
    try {
      // The server acknowledges the purchase after Google confirms it.
      tx = await iap().purchaseProduct({ productIdentifier: productId, planIdentifier: offer.plan, offerToken: offer.token, productType: "subs", autoAcknowledgePurchases: false });
    } catch (error) {
      const msg = String(error?.message || error || "");
      if (/cancel/i.test(msg)) return; // closed the Google Play sheet
      if (/pending/i.test(msg)) throw new Error("Your payment is pending. Pro unlocks as soon as Google Play confirms it.");
      if (/already.*(own|subscri)/i.test(msg)) throw new Error("You already have this subscription. Reopen the app to refresh it.");
      throw new Error(msg || "Google Play could not complete the purchase.");
    }
    try {
      const result = await verifyPlay(productId, tx.purchaseToken, tx.orderId);
      await sync();
      hide("cdPlans");
      showDone(`Subscription started 🎉 CryptoDock Pro is active until ${fmtDate(result.valid_until_ts)}.`);
    } catch (error) {
      throw new Error(`${error.message} Your purchase is safe — it is retried when you reopen the app.`);
    }
  }
  // On launch (and sign-in) re-check Google Play purchases: this renews the
  // plan after each automatic renewal and restores it on a new phone.
  let restoredFor = "";
  async function restorePlay() {
    if (!NATIVE || !iap() || !email || hasFullAccess(email) || restoredFor === email) return;
    restoredFor = email;
    try {
      const { purchases } = await iap().getPurchases({ productType: "subs" });
      const ids = Object.values(PLAY_PRODUCTS);
      let changed = false;
      for (const p of purchases || []) {
        if (!ids.includes(p.productIdentifier) || String(p.purchaseState) !== "1" || !p.purchaseToken) continue;
        try { await verifyPlay(p.productIdentifier, p.purchaseToken, p.orderId); changed = true; } catch (e) { /* not ours / expired */ }
      }
      if (changed) await sync();
    } catch (e) { restoredFor = ""; }
  }

  async function pay() {
    if (!email) { hide("cdPlans"); showGate({ reason: "signin" }, "CryptoDock Pro"); return; }
    const planName = selectedPlan();
    const btn = el("cdPlansPay");
    btn.disabled = true;
    plansError("");
    if (NATIVE) {
      try { await payNative(planName); } catch (error) { plansError(error.message || "Could not start the purchase."); } finally { btn.disabled = false; renderPlans(); }
      return;
    }
    try {
      const res = await fetch("/api/payment/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_name: planName, email }),
      });
      const order = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(order.detail || "Could not start the payment.");
      await loadRazorpay();
      const checkout = new window.Razorpay({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        name: "CryptoDock Pro",
        description: planName,
        prefill: { email },
        theme: { color: "#8b5cf6" },
        handler: async (response) => {
          try {
            const verify = await fetch("/api/payment/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...response, email }),
            });
            const result = await verify.json().catch(() => ({}));
            if (!verify.ok) throw new Error(result.detail || "Payment could not be confirmed.");
            await sync();
            hide("cdPlans");
            const until = new Date(result.valid_until_ts * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
            showDone(`Payment successful 🎉 CryptoDock Pro is active until ${until}.`);
          } catch (error) {
            plansError(`${error.message} If money was debited, write to us with your payment ID ${response.razorpay_payment_id}.`);
          }
        },
        modal: { ondismiss: () => { btn.disabled = false; } },
      });
      checkout.on("payment.failed", (resp) => plansError(resp?.error?.description || "Payment failed. Please try again."));
      checkout.open();
    } catch (error) {
      plansError(error.message || "Could not start the payment.");
    } finally {
      btn.disabled = false;
    }
  }

  function showDone(text) {
    el("cdProGateExtra").hidden = true;
    el("cdProGateTitle").textContent = "Welcome to CryptoDock Pro";
    el("cdProGateText").textContent = text;
    el("cdProGatePrimary").textContent = "Start paper trading";
    el("cdProGatePrimary").onclick = () => hide("cdProGate");
    show("cdProGate");
  }

  // ---------- Android app: wording for Google Play subscriptions ----------
  if (NATIVE) {
    document.querySelectorAll(".cdp-pay-row").forEach((n) => { n.innerHTML = "<span>🔒 Secured by Google Play</span>"; });
    document.querySelectorAll(".cdp-trust").forEach((n) => {
      n.textContent = "🔒 Billed by Google Play · Renews automatically · Cancel any time in Google Play → Subscriptions";
    });
    document.querySelectorAll(".cdp-note").forEach((n) => {
      if (/auto-renewal/i.test(n.textContent)) n.innerHTML = "<span>✓</span>No payment during the trial. Subscribe now or any time later from Upgrade.";
    });
  }

  // ---------- events ----------
  el("cdUpgradeBtn").addEventListener("click", openStatusCard);
  el("cdMyPlanBtn")?.addEventListener("click", openStatusCard);
  el("cdNavUpgrade")?.addEventListener("click", openStatusCard);
  // A price in "Next price" opens Choose your plan with that plan picked.
  el("cdProNext").addEventListener("click", (e) => {
    const b = e.target.closest("[data-next-plan]");
    if (!b) return;
    choosePlan(b.dataset.nextPlan);
    hide("cdProStatus");
    openPlans();
  });
  el("cdProStatusClose").addEventListener("click", () => hide("cdProStatus"));
  el("cdProStatus").addEventListener("click", (e) => { if (e.target.id === "cdProStatus") hide("cdProStatus"); });
  el("cdPlansClose").addEventListener("click", () => hide("cdPlans"));
  el("cdPlansPay").addEventListener("click", pay);
  document.querySelectorAll('input[name="cdPlan"]').forEach((r) => r.addEventListener("change", () => choosePlan(r.value)));
  el("cdProGateClose").addEventListener("click", () => hide("cdProGate"));
  ["cdProGate", "cdPlans"].forEach((id) => el(id).addEventListener("click", (e) => { if (e.target.id === id) hide(id); }));
  // The trial card closes the same way (tap outside, Back); the Pro page
  // simply isn't opened until it is accepted.
  el("cdTrialCard").addEventListener("click", (e) => { if (e.target.id === "cdTrialCard") { pendingResume = null; hide("cdTrialCard"); } });

  window.addEventListener("cd-user-changed", (event) => {
    const next = (event.detail && event.detail.email) || "";
    if (next === email) return;
    email = next;
    status = email ? readCached() : null;
    renderUpgrade();
    leaveLockedPage();
    sync();
  });

  window.cdOpenPlans = openPlans;
  setInterval(renderUpgrade, 60000); // trial / plan end shows Upgrade on time
  renderUpgrade();
  leaveLockedPage();
  sync();
})();
