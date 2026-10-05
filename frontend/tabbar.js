// Phone navigation like a native app: Home, Watchlist, Position, Scanner and More — More opens a sheet
// with every other page and Settings. It drives the same sidebar buttons, so page switching and
// Pro rules stay in one place. Shown only on narrow screens (markets.css).
(function cryptoTabBar() {
  const bar = document.getElementById("cdTabBar");
  const sheet = document.getElementById("cdMoreSheet");
  const grid = document.getElementById("cdMoreGrid");
  if (!bar || !sheet || !grid) return;

  const MAIN_PAGES = ["dashboard", "watchlist", "positions", "scanner"];
  const sidebarTab = (page) => document.querySelector(`.sidebar .app-tab[data-tab="${page}"]`);
  const activePanel = () => document.querySelector(".tab-panel.active")?.dataset.panel || "dashboard";

  function go(page, after) {
    sidebarTab(page)?.click();
    if (after) setTimeout(after, 0);
    setTimeout(sync, 0);
  }

  function sync() {
    const panel = activePanel();
    const current =
      panel === "dashboard" ? "home" :
      panel === "watchlist" ? "watch" :
      panel === "scanner" ? "scanner" :
      panel === "positions" || panel === "orders" ? "portfolio" : "more";
    bar.querySelectorAll("[data-tabbar]").forEach((b) => b.classList.toggle("is-active", b.dataset.tabbar === current));
  }

  // A sidebar button's name without its icon text (Technical's icon is a "T").
  function label(button) {
    const copy = button.cloneNode(true);
    copy.querySelector(".nav-icon")?.remove();
    return copy.textContent.trim();
  }

  // Every other sidebar page (and Settings) as a tile in the More sheet.
  function buildMore() {
    const tiles = [...document.querySelectorAll(".sidebar .app-tab[data-tab]")]
      .filter((b) => !b.hidden && !MAIN_PAGES.includes(b.dataset.tab))
      .map((b) => `<button type="button" class="cd-more-tile" data-more="${b.dataset.tab}">
          <span class="cd-more-icon">${b.querySelector(".nav-icon")?.innerHTML || ""}</span>
          <span>${label(b)}</span>
        </button>`);
    // Upgrade: opens the CryptoDock Pro card (trial / plan days and prices).
    tiles.unshift(`<button type="button" class="cd-more-tile cd-more-upgrade" data-more-upgrade="1">
        <span class="cd-more-icon">👑</span>
        <span>Upgrade</span>
      </button>`);
    tiles.push(`<button type="button" class="cd-more-tile" data-more-settings="1">
        <span class="cd-more-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
        <span>Settings</span>
      </button>`);
    grid.innerHTML = tiles.join("");
  }

  const openMore = () => { buildMore(); sheet.hidden = false; };
  const closeMore = () => { sheet.hidden = true; };

  bar.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tabbar]");
    if (!btn) return;
    const which = btn.dataset.tabbar;
    if (which === "home") go("dashboard");
    else if (which === "watch") go("watchlist");
    else if (which === "scanner") go("scanner");
    else if (which === "portfolio" || which === "position") go("positions");
    else openMore();
  });

  grid.addEventListener("click", (event) => {
    const tile = event.target.closest(".cd-more-tile");
    if (!tile) return;
    closeMore();
    if (tile.dataset.moreUpgrade) { if (typeof window.cdOpenProStatus === "function") window.cdOpenProStatus(); }
    else if (tile.dataset.moreSettings) document.getElementById("topSettingsMenuButton")?.click();
    else go(tile.dataset.more);
  });
  document.getElementById("cdMoreClose").addEventListener("click", closeMore);
  sheet.addEventListener("click", (event) => { if (event.target === sheet) closeMore(); });

  // Pages also change from inside the app (View All, Chart, toasts…).
  document.addEventListener("click", (event) => {
    if (event.target.closest(".app-tab, #cdWatchTabs, [data-go]")) setTimeout(sync, 0);
  });
  sync();
})();
