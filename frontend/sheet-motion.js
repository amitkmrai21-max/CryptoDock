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
      if (ourHide.has(overlay)) { ourHide.delete(overlay); return; }
      if (!hidden && closingNow.has(overlay)) return; // our own re-show while sliding out
      if (hidden) { wasHidden = false; animateOut(overlay); }
      else animateIn(overlay);
    }).observe(overlay, { attributes: true, attributeFilter: ["hidden"] });
    enableSwipe(overlay);
  }

  // The same way the sheet's own ×/Not now/backdrop closes it, so its own
  // clean-up (stop polling, clear state) still runs.
  function closeOverlay(overlay) {
    const button = overlay.querySelector(".cd-ticket-close, #cdProGateClose");
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
      // Only when the sheet is scrolled to its top (otherwise the swipe
      // scrolls its content), and not on inputs/sliders.
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
        if (dy < 6) { if (dy < -6) armed = false; return; } // upward = normal scroll
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
      const speed = dy / Math.max(1, Date.now() - startT); // px per ms
      if (dy > Math.min(140, panel.offsetHeight * 0.25) || (dy > 40 && speed > 0.5)) {
        panel.style.transform = `translateY(${dy}px)`;
        closeOverlay(overlay);
      } else {
        panel.style.transform = ""; // snap back
      }
    };
    panel.addEventListener("touchend", end);
    panel.addEventListener("touchcancel", end);
  }

  // Hide without the slide-down, for handing over straight to another sheet
  // (coin sheet → order ticket) so only one sheet animates at a time.
  window.cdHideSheetNow = (overlay) => {
    if (!overlay || overlay.hidden) return;
    closingNow.delete(overlay);
    overlay.classList.remove("cd-closing", "cd-off");
    const panel = panelOf(overlay);
    if (panel) panel.style.transform = "";
    ourHide.add(overlay);
    overlay.hidden = true;
  };

  document.querySelectorAll(OVERLAY).forEach(watch);
})();
