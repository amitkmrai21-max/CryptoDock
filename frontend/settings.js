(function() {
  function syncAttributes() {
    var theme = document.body.dataset.theme || "dark";
    var textSize = document.body.dataset.textSize || "normal";
    var accent = document.body.dataset.accent || "blue";
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.textSize = textSize;
    document.documentElement.dataset.accent = accent;
  }

  var observer = new MutationObserver(syncAttributes);
  if (document.body) {
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-theme", "data-text-size", "data-accent"] });
    syncAttributes();
  }

  document.addEventListener("DOMContentLoaded", function() {
    syncAttributes();

    var startupButtons = document.querySelectorAll("[data-startup-mode-choice]");
    var hintEl = document.querySelector("#cdStartupHint");

    function renderStartupHint(choice) {
      if (!hintEl) return;
      if (choice === "indian") {
        hintEl.innerHTML = '<span>Indian Market mode active.</span> <a href="https://marketdock.in" target="_blank" style="color:var(--cd-accent);text-decoration:underline;font-weight:600;margin-left:4px;">Open marketdock.in &rarr;</a>';
        hintEl.style.display = "flex";
      } else {
        hintEl.innerHTML = '<span>CryptoDock opens by default.</span>';
        hintEl.style.display = "flex";
      }
    }

    startupButtons.forEach(function(btn) {
      btn.addEventListener("click", function() {
        var choice = btn.dataset.startupModeChoice;
        renderStartupHint(choice);
      });
    });

    var pref = "btc";
    try { pref = localStorage.getItem("marketDockStartupModePref") || "btc"; } catch(e){}
    renderStartupHint(pref);
  });
})();

// Owner Analytics Dashboard (Only for amitkmrai21@gmail.com)
(function initOwnerAnalytics() {
  const OWNER_EMAIL = "amitkmrai21@gmail.com";

  function getActiveEmail() {
    if (typeof window.cdUserEmail === "string" && window.cdUserEmail) return window.cdUserEmail.trim().toLowerCase();
    try {
      const e = localStorage.getItem("cdUserEmail");
      if (e) return e.trim().toLowerCase();
    } catch (e) {}
    const emailEl = document.getElementById("accountEmailDisplay");
    if (emailEl && emailEl.textContent && emailEl.textContent.includes("@")) {
      return emailEl.textContent.trim().toLowerCase();
    }
    return "";
  }

  async function checkAndSyncOwnerStats() {
    const section = document.getElementById("cdOwnerAnalyticsSection");
    if (!section) return;

    let email = getActiveEmail();
    if (!email && window.marketDockSupabase) {
      try {
        const { data } = await window.marketDockSupabase.auth.getSession();
        if (data && data.session && data.session.user && data.session.user.email) {
          email = data.session.user.email.trim().toLowerCase();
        }
      } catch (e) {}
    }

    if (email !== OWNER_EMAIL) {
      section.style.display = "none";
      return;
    }

    // Owner verified -> reveal dashboard
    section.style.display = "block";

    const usersEl = document.getElementById("cdOwnerTotalUsers");
    const subsEl = document.getElementById("cdOwnerTotalSubscribers");
    const detailEl = document.getElementById("cdOwnerSubDetail");
    const timeEl = document.getElementById("cdOwnerStatsTime");

    try {
      let token = "";
      if (window.marketDockSupabase) {
        try {
          const { data } = await window.marketDockSupabase.auth.getSession();
          token = data?.session?.access_token || "";
        } catch (e) {}
      }

      const headers = {};
      if (token) headers["Authorization"] = "Bearer " + token;

      const res = await fetch("/api/owner/analytics?email=" + encodeURIComponent(email), { headers });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      if (usersEl) usersEl.textContent = (data.total_registered != null) ? data.total_registered : "--";
      if (subsEl) subsEl.textContent = (data.active_subscribers != null) ? data.active_subscribers : (data.total_subscribers || "0");
      if (detailEl) {
        detailEl.textContent = (data.active_subscribers || 0) + " Active / " + (data.total_subscribers || 0) + " Total";
      }
      if (timeEl) {
        const now = new Date();
        timeEl.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
    } catch (err) {
      if (usersEl && usersEl.textContent === "--") usersEl.textContent = "Err";
      if (subsEl && subsEl.textContent === "--") subsEl.textContent = "Err";
    }
  }

  document.addEventListener("DOMContentLoaded", function() {
    checkAndSyncOwnerStats();
    const refreshBtn = document.getElementById("cdOwnerRefreshBtn");
    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.dataset.bound = "true";
      refreshBtn.addEventListener("click", checkAndSyncOwnerStats);
    }
    const settingsBtn = document.getElementById("cdMoreSettings");
    if (settingsBtn) {
      settingsBtn.addEventListener("click", function() {
        setTimeout(checkAndSyncOwnerStats, 200);
      });
    }
  });

  window.addEventListener("cd-auth-state", function() {
    setTimeout(checkAndSyncOwnerStats, 150);
  });
})();
