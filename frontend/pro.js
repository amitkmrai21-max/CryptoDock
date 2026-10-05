// CryptoDock Pro: every email gets one 7-day trial (the server remembers it
// for good), then a plan — ₹99 / 1 month, ₹299 / 6 months, ₹499 / 1 year,
// paid through Razorpay. Pro: paper trading (order ticket, Positions,
// Orders), Heatmap, Price Alerts, RRG and News. Coin Detail, the Scanner
// and Chart Analysis are free for every signed-in user.
// Everything else stays free. The owner's email always has access.
(function cryptoPro() {
  const OWNER_EMAIL = "amitkmrai21@gmail.com";
  const NEW_USER_WINDOW_SEC = 24 * 3600;
  const PRO_TABS = {
    positions: "Paper Trading",
    orders: "Paper Trading",
    heatmap: "Heatmap",
    alerts: "Price Alerts",
    rrg: "RRG",
    news: "News",
  };
  const PLAN_PRICES = { "Monthly Plan": 99, "Half-Yearly Plan": 299, "Annual Plan": 499 };

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
    loginNotice();
  }

  // { ok, reason: owner | paid | trial | signin | expired | plan-expired | checking, isNew }
  function access() {
    if (!email) return { ok: false, reason: "signin" };
    if (email === OWNER_EMAIL) return { ok: true, reason: "owner" };
    if (!status) { sync(); return { ok: false, reason: "checking" }; }
    const now = Date.now() / 1000;
    if (status.is_paid && (!status.valid_until_ts || status.valid_until_ts > now)) return { ok: true, reason: "paid" };
    if (status.trial_end_ts && status.trial_end_ts > now) {
      return {
        ok: true,
        reason: "trial",
        daysLeft: Math.max(1, Math.ceil((status.trial_end_ts - now) / 86400)),
        isNew: Number.isFinite(status.trial_start_ts) && now - status.trial_start_ts < NEW_USER_WINDOW_SEC,
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

  // A brand-new user's first Pro tap waits for the trial card to be accepted.
  const welcomeKey = () => "cdProWelcomeAccepted:" + email;
  function welcomeAccepted() {
    try { return localStorage.getItem(welcomeKey()) === "1"; } catch (e) { return true; }
  }
  let pendingResume = null;
  function showTrialCard(acc, resume) {
    el("cdTrialText").textContent = `You have CryptoDock Pro free for ${acc.daysLeft} more day${acc.daysLeft === 1 ? "" : "s"}: unlimited paper trading, Heatmap, Price Alerts, RRG and News.`;
    pendingResume = resume;
    show("cdTrialCard");
  }
  el("cdTrialAccept").addEventListener("click", () => {
    try { localStorage.setItem(welcomeKey(), "1"); } catch (e) { /* ignore */ }
    hide("cdTrialCard");
    const resume = pendingResume;
    pendingResume = null;
    if (resume) resume();
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
    if (acc.ok && acc.reason === "trial" && acc.isNew && !welcomeAccepted()) {
      showTrialCard(acc, action);
      return false;
    }
    if (acc.ok) { action(); return true; }
    showGate(acc, feature);
    return false;
  }

  // Sidebar tabs (capture phase: runs before the tab switches).
  document.addEventListener("click", (event) => {
    const tab = event.target.closest(".app-tab[data-tab]");
    if (!tab || !PRO_TABS[tab.dataset.tab] || tab.dataset.proPass === "1") return;
    const acc = access();
    if (acc.ok && !(acc.reason === "trial" && acc.isNew && !welcomeAccepted())) return;
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
  }

  // ---------- plans & payment ----------
  function selectedPlan() {
    return document.querySelector('input[name="cdPlan"]:checked')?.value || "Annual Plan";
  }
  function plansError(text) {
    el("cdPlansError").textContent = text || "";
    el("cdPlansError").hidden = !text;
  }
  function renderPlans() {
    el("cdPlansPay").textContent = `Pay ₹${PLAN_PRICES[selectedPlan()]} securely`;
    const acc = access();
    const until = status && status.valid_until_ts ? new Date(status.valid_until_ts * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";
    el("cdPlansStatus").textContent =
      acc.reason === "paid" ? `Your plan is active until ${until}. Buying again adds to it.` :
      acc.reason === "trial" ? `Free trial: ${acc.daysLeft} day${acc.daysLeft === 1 ? "" : "s"} left.` :
      acc.reason === "plan-expired" ? `Your plan ended on ${until}.` :
      acc.reason === "signin" ? "Sign in first — your plan is tied to your email." :
      "Your free trial has ended.";
  }
  function openPlans() {
    plansError("");
    renderPlans();
    show("cdPlans");
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

  async function pay() {
    if (!email) { hide("cdPlans"); showGate({ reason: "signin" }, "CryptoDock Pro"); return; }
    const planName = selectedPlan();
    const btn = el("cdPlansPay");
    btn.disabled = true;
    plansError("");
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

  // ---------- events ----------
  el("cdUpgradeBtn").addEventListener("click", openPlans);
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
