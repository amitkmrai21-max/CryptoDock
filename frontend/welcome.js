// Welcome screen: on opening CryptoDock, people who are not signed in see
// "Welcome to CryptoDock" with Google and email sign-in / sign-up (like
// MarketDock). It reuses the Settings → Account sign-in in app.js — the same
// Supabase calls and messages — and closes as soon as a session exists.
(function cryptoWelcome() {
  const el = (id) => document.getElementById(id);
  const screen = el("cdWelcome");
  if (!screen) return;
  const status = el("cdWelcomeStatus");

  function show() {
    screen.hidden = false;
    document.documentElement.classList.add("cd-welcome-open");
  }
  function hide() {
    screen.hidden = true;
    document.documentElement.classList.remove("cd-welcome-open");
    if (status) status.textContent = "";
  }

  // app.js reports the session once Supabase has restored it (and on every
  // sign-in / sign-out). Until then nothing is shown, so a signed-in user
  // never sees the screen flash.
  window.addEventListener("cd-auth-state", (event) => {
    if (event.detail && event.detail.signedIn) hide();
    else show();
  });

  // Mirror the account form's messages ("Logging in…", errors, "check your
  // email to confirm") onto this screen.
  const accountStatus = el("accountAuthStatus");
  if (accountStatus && status) {
    new MutationObserver(() => {
      status.textContent = accountStatus.textContent;
      status.classList.toggle("is-error", accountStatus.style.color === "rgb(239, 68, 68)" || accountStatus.style.color === "#ef4444");
    }).observe(accountStatus, { childList: true, characterData: true, subtree: true, attributes: true });
  }

  function viaAccount(buttonId) {
    const email = el("cdWelcomeEmail").value.trim();
    const password = el("cdWelcomePassword").value;
    const accountEmail = el("accountEmailInput");
    const accountPassword = el("accountPasswordInput");
    const button = el(buttonId);
    if (!accountEmail || !accountPassword || !button) {
      status.textContent = "Sign-in is loading — please try again in a moment.";
      return;
    }
    accountEmail.value = email;
    accountPassword.value = password;
    button.click();
  }

  el("cdWelcomeGoogle").addEventListener("click", () => {
    const google = el("accountGoogleBtn");
    if (google) google.click();
    else status.textContent = "Sign-in is loading — please try again in a moment.";
  });
  el("cdWelcomeEmailToggle").addEventListener("click", () => {
    el("cdWelcomeEmailForm").hidden = false;
    el("cdWelcomeEmailToggle").hidden = true;
    el("cdWelcomeEmail").focus();
  });
  el("cdWelcomeLogin").addEventListener("click", () => viaAccount("accountLoginBtn"));
  el("cdWelcomeSignup").addEventListener("click", () => viaAccount("accountSignupBtn"));
  el("cdWelcomePassword").addEventListener("keydown", (event) => { if (event.key === "Enter") viaAccount("accountLoginBtn"); });
  el("cdWelcomePassToggle").addEventListener("click", () => {
    const input = el("cdWelcomePassword");
    input.type = input.type === "password" ? "text" : "password";
  });

  window.cdShowWelcome = show;
})();
