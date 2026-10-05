// Bottom sheets that feel native: every CryptoDock sheet/popup
// (.cd-ticket-overlay — coin sheet, order ticket, More, plans, Pro cards)
// slides up from the bottom when it opens and slides back down when it
// closes; on a phone it can also be dragged down with a finger to close.
// Opening/closing is still just the `hidden` attribute everywhere else —
// this watches it, so no other code needs to know about the animation.
(function cryptoSheetMotion() {
  const OVERLAY = ".cd-ticket-overlay";
  const OUT_MS = 230;
  const closingNow = new WeakSet();
  const ourHide = new WeakSet();

  const panelOf = (overlay) => overlay.querySelector(".cd-ticket");

  // Paint one frame at the off-screen position, then let it slide in. Two
  // animation frames instead of reading offsetHeight: forcing a layout of
  // this big page right on the tap cost a visible stutter on phones.
  function animateIn(overlay) {
    overlay.classList.add("cd-off");
    overlay.classList.remove("cd-closing");
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.remove("cd-off")));
  }

  // Code set hidden=true: keep it on screen just long enough to slide out.
  function animateOut(overlay) {
    if (closingNow.has(overlay)) return;
    closingNow.add(overlay);
    overlay.hidden = false;
    overlay.classList.add("cd-closing", "cd-off");
    const panel = panelOf(overlay);
    if (panel) panel.style.transform = "";
    setTimeout(() => {
      closingNow.delete(overlay);
      overlay.classList.remove("cd-closing");
      ourHide.add(overlay);
      overlay.hidden = true;
    }, OUT_MS);
  }

  function watch(overlay) {
    let wasHidden = overlay.hidden;
    new MutationObserver(() => {
      const hidden = overlay.hidden;
      if (hidden === wasHidden) return;
      wasHidden = hidden;
      if (ourHide.has(overlay)) { ourHide.delete(overlay); notifyOverlayClosed(); return; }
      if (!hidden && closingNow.has(overlay)) return; // our own re-show while sliding out
      if (hidden) { wasHidden = false; animateOut(overlay); notifyOverlayClosed(); }
      else { animateIn(overlay); notifyOverlayOpened(); }
    }).observe(overlay, { attributes: true, attributeFilter: ["hidden"] });
    enableSwipe(overlay);
  }

  // The same way the sheet's own ×/Not now/backdrop closes it, so its own
  // clean-up (stop polling, clear state) still runs.
  function closeOverlay(overlay) {
    const button = overlay.querySelector(".cd-ticket-close, #cdProGateClose, .close-btn");
    if (button) button.click();
    else overlay.hidden = true;
  }

  // ---------- drag down to close ----------
  function enableSwipe(overlay) {
    const panel = panelOf(overlay);
    if (!panel) return;
    let startY = 0, dy = 0, startT = 0, dragging = false, armed = false;

    panel.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) return;
      if (panel.scrollTop > 0 || event.target.closest("input, select, textarea")) return;
      armed = true;
      dragging = false;
      startY = event.touches[0].clientY;
      startT = Date.now();
      dy = 0;
    }, { passive: true });

    panel.addEventListener("touchmove", (event) => {
      if (!armed) return;
      dy = event.touches[0].clientY - startY;
      if (!dragging) {
        if (dy < 6) { if (dy < -6) armed = false; return; }
        dragging = true;
        panel.style.transition = "none";
      }
      event.preventDefault();
      panel.style.transform = `translateY(${Math.max(0, dy)}px)`;
      overlay.style.setProperty("--cd-sheet-dim", String(Math.max(0, 1 - dy / (panel.offsetHeight || 1))));
    }, { passive: false });

    const end = () => {
      if (!armed) return;
      armed = false;
      if (!dragging) return;
      dragging = false;
      panel.style.transition = "";
      overlay.style.removeProperty("--cd-sheet-dim");
      const speed = dy / Math.max(1, Date.now() - startT);
      if (dy > Math.min(140, panel.offsetHeight * 0.25) || (dy > 40 && speed > 0.5)) {
        panel.style.transform = `translateY(${dy}px)`;
        closeOverlay(overlay);
      } else {
        panel.style.transform = "";
      }
    };
    panel.addEventListener("touchend", end);
    panel.addEventListener("touchcancel", end);
  }

  // Hide without the slide-down, for handing over straight to another sheet
  window.cdHideSheetNow = (overlay) => {
    if (!overlay || overlay.hidden) return;
    closingNow.delete(overlay);
    overlay.classList.remove("cd-closing", "cd-off");
    const panel = panelOf(overlay);
    if (panel) panel.style.transform = "";
    ourHide.add(overlay);
    overlay.hidden = true;
  };

  // =========================================================================
  // STEP-BY-STEP MOBILE BACK BUTTON & NAVIGATION CONTROLLER
  // =========================================================================
  // When mobile users click sidebar/bottom tabs or open sheets/drawers,
  // pressing Android Back or Browser Back steps back layer by layer:
  // Step 1: Closes any open sheet, dialog, or Settings drawer first.
  // Step 2: Returns from any non-dashboard tab back to the previous tab / Home.
  // Step 3: Only when already on Dashboard (Home) with no sheets open,
  //         requires double-tap within 2s to exit in native app (preventing accidental exits).
  // =========================================================================
  const drawer = document.getElementById("settingsDrawer");

  const openOverlays = () => [...document.querySelectorAll(OVERLAY)].filter((o) => !o.hidden && !closingNow.has(o));
  const settingsOpen = () => !!(drawer && drawer.classList.contains("open"));
  const anyOverlayOpen = () => openOverlays().length > 0 || settingsOpen();

  const getActiveTab = () => document.querySelector(".tab-panel.active")?.dataset.panel || "dashboard";
  const goToTab = (tab) => {
    const el = document.querySelector(`.sidebar .app-tab[data-tab="${tab}"]`);
    if (el) el.click();
  };

  const tabHistory = ["dashboard"];
  let isBackNavigating = false;
  let overlayHistoryDepth = 0;
  let exitArmedUntil = 0;
  let exitToastEl = null;

  function showExitToast() {
    if (!exitToastEl) {
      exitToastEl = document.createElement("div");
      exitToastEl.id = "cdExitToast";
      exitToastEl.style.cssText = "position:fixed;bottom:76px;left:50%;transform:translateX(-50%);background:rgba(18,22,34,0.95);color:#f3f4f6;padding:9px 18px;border-radius:22px;font-size:12.5px;font-weight:500;box-shadow:0 6px 20px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.18);z-index:999999;pointer-events:none;transition:opacity 0.25s ease;letter-spacing:0.2px;";
      document.body.appendChild(exitToastEl);
    }
    exitToastEl.textContent = "Press back again to exit";
    exitToastEl.style.opacity = "1";
    setTimeout(() => {
      if (exitToastEl) exitToastEl.style.opacity = "0";
    }, 1800);
  }

  function notifyOverlayOpened() {
    overlayHistoryDepth += 1;
    try {
      history.pushState({ cdType: "overlay", depth: overlayHistoryDepth, ts: Date.now() }, "");
    } catch (e) {}
  }

  function notifyOverlayClosed() {
    if (overlayHistoryDepth > 0) {
      overlayHistoryDepth = Math.max(0, overlayHistoryDepth - 1);
    }
  }

  // Track tab changes triggered by user taps (sidebar, bottom bar, buttons)
  function recordTabSwitch(newTab) {
    if (!newTab || isBackNavigating) return;
    const currentRecorded = tabHistory[tabHistory.length - 1];
    if (newTab === currentRecorded) return;

    tabHistory.push(newTab);
    try {
      history.pushState({ cdType: "tab", tab: newTab, depth: tabHistory.length, ts: Date.now() }, "");
    } catch (e) {}
  }

  // Core step-back decision logic
  function performStepBack() {
    // 1. Close any open sheet, modal, or drawer
    if (anyOverlayOpen()) {
      const open = openOverlays();
      if (open.length) {
        closeOverlay(open[open.length - 1]);
      } else if (settingsOpen()) {
        document.getElementById("settingsCloseButton")?.click();
      }
      return true; // Handled, do not navigate or exit
    }

    // 2. If on a sub-page/tab, step back towards Home/Dashboard
    const currentTab = getActiveTab();
    if (currentTab !== "dashboard") {
      isBackNavigating = true;
      if (tabHistory.length > 1 && tabHistory[tabHistory.length - 1] === currentTab) {
        tabHistory.pop();
      }
      const prevTab = tabHistory.length ? tabHistory[tabHistory.length - 1] : "dashboard";
      goToTab(prevTab);
      setTimeout(() => { isBackNavigating = false; }, 100);
      return true; // Handled, returned to previous tab
    }

    // 3. User is on Dashboard and no sheets are open
    const now = Date.now();
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      if (now < exitArmedUntil) {
        window.Capacitor.Plugins.App.exitApp();
        return false;
      } else {
        exitArmedUntil = now + 2000;
        showExitToast();
        return true; // Prevent immediate exit
      }
    }

    return false; // In standard browser, allow default browser back
  }

  // Listen to browser popstate (Android browser back gesture or hardware back)
  window.addEventListener("popstate", (e) => {
    if (isBackNavigating) return;
    const handled = performStepBack();
    // If we stepped back to a tab or closed an overlay and there are still history entries needed
    if (handled && e.state && e.state.cdType) {
      // Handled step-by-step
    }
  });

  // Listen to Capacitor native Android back button
  function setupCapacitorBack() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      window.Capacitor.Plugins.App.addListener("backButton", ({ canGoBack }) => {
        const handled = performStepBack();
        if (!handled && !exitArmedUntil) {
          window.Capacitor.Plugins.App.exitApp();
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupCapacitorBack);
  } else {
    setupCapacitorBack();
  }

  // Observe active panel changes so every sidebar/bottom-bar click is recorded in history
  document.addEventListener("click", (event) => {
    const tabEl = event.target.closest(".app-tab[data-tab], [data-tabbar], .cd-more-tile[data-more], [data-go]");
    if (tabEl) {
      setTimeout(() => {
        const panel = getActiveTab();
        recordTabSwitch(panel);
      }, 50);
    }
  });

  if (drawer) {
    let wasOpen = settingsOpen();
    new MutationObserver(() => {
      const open = settingsOpen();
      if (open === wasOpen) return;
      wasOpen = open;
      if (open) notifyOverlayOpened();
      else notifyOverlayClosed();
    }).observe(drawer, { attributes: true, attributeFilter: ["class"] });
  }

  document.querySelectorAll(OVERLAY).forEach(watch);
})();
