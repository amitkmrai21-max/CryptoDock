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
    checkAndSyncDeltaAutoTrade();
    const refreshBtn = document.getElementById("cdOwnerRefreshBtn");
    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.dataset.bound = "true";
      refreshBtn.addEventListener("click", function() {
        checkAndSyncOwnerStats();
        checkAndSyncDeltaAutoTrade();
      });
    }
    // Retry periodically after page load to sync as soon as auth session resolves
    let syncAttempts = 0;
    const syncTimer = setInterval(() => {
      syncAttempts++;
      checkAndSyncOwnerStats();
      checkAndSyncDeltaAutoTrade();
      if (syncAttempts >= 8) clearInterval(syncTimer);
    }, 800);
  });

  document.addEventListener("click", function(e) {
    if (e.target && (e.target.closest("#topSettingsMenuButton") || e.target.closest("[data-more-settings]") || e.target.closest("#cdOwnerRefreshBtn"))) {
      setTimeout(() => { checkAndSyncOwnerStats(); checkAndSyncDeltaAutoTrade(); }, 100);
    }
  });

  window.addEventListener("cd-auth-state", function() {
    setTimeout(() => { checkAndSyncOwnerStats(); checkAndSyncDeltaAutoTrade(); }, 150);
  });
  window.addEventListener("cd-user-changed", function() {
    setTimeout(() => { checkAndSyncOwnerStats(); checkAndSyncDeltaAutoTrade(); }, 150);
  });

  // "Help & Support": opens the user's email app with a ready message to the
  // developer. Nothing is sent through our server.
  function updateSupportLink() {
    const link = document.getElementById("cdSupportLink");
    if (!link) return;
    let mail = "";
    try { mail = window.cdUserEmail || localStorage.getItem("cdUserEmail") || ""; } catch (e) { /* ignore */ }
    const app = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? "Android app" : "website";
    const body = "Describe your problem here:\n\n\n\n---\nAccount: " + (mail || "not signed in") + "\nUsing: " + app;
    link.href = "mailto:amitkmrai21@gmail.com?subject=" + encodeURIComponent("CryptoDock Support") + "&body=" + encodeURIComponent(body);
  }
  document.addEventListener("DOMContentLoaded", updateSupportLink);
  window.addEventListener("cd-user-changed", updateSupportLink);
  window.addEventListener("cd-auth-state", updateSupportLink);


  // Owner Delta India Auto-Trading Sync & Control
  async function checkAndSyncDeltaAutoTrade() {
    const section = document.getElementById("cdOwnerDeltaAutoTradeSection");
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

    section.style.display = "block";

    const enabledToggle = document.getElementById("cdDeltaAutoEnabled");
    const slider = document.getElementById("cdDeltaAutoSlider");
    const maxPosInput = document.getElementById("cdDeltaMaxPos");
    const marginInput = document.getElementById("cdDeltaMargin");
    const takeProfitInput = document.getElementById("cdDeltaTakeProfit");
    const statusEl = document.getElementById("cdDeltaConnStatus");
    const saveBtn = document.getElementById("cdDeltaSaveBtn");
    const saveMsg = document.getElementById("cdDeltaSaveMsg");

    function updateSliderUi(checked) {
      if (!slider) return;
      slider.style.backgroundColor = checked ? "#10b981" : "#334155";
      slider.innerHTML = checked
        ? '<span style="position:absolute; top:3px; right:4px; width:20px; height:20px; background:#fff; border-radius:50%; box-shadow:0 1px 3px rgba(0,0,0,0.3);"></span>'
        : '<span style="position:absolute; top:3px; left:4px; width:20px; height:20px; background:#94a3b8; border-radius:50%; box-shadow:0 1px 3px rgba(0,0,0,0.3);"></span>';
    }

    let token = "";
    if (window.marketDockSupabase) {
      try {
        const { data } = await window.marketDockSupabase.auth.getSession();
        token = data?.session?.access_token || "";
      } catch (e) {}
    }
    const headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;

    try {
      const res = await fetch("/api/owner/delta/config", { headers });
      if (res.ok) {
        const data = await res.json();
        const cfg = data.config || {};
        if (enabledToggle) {
          enabledToggle.checked = !!cfg.enabled;
          updateSliderUi(enabledToggle.checked);
        }
        if (maxPosInput && cfg.max_open_positions != null) {
          maxPosInput.value = cfg.max_open_positions;
        }
        if (marginInput && cfg.margin_per_trade != null) {
          marginInput.value = cfg.margin_per_trade;
        }
        if (takeProfitInput && cfg.take_profit_usd != null) {
          takeProfitInput.value = cfg.take_profit_usd;
        }
        if (statusEl) {
          if (data.status === "connected") {
            statusEl.textContent = `🟢 Connected (${data.delta_open_positions} active)`;
            statusEl.style.color = "#34d399";
          } else if (data.status === "missing_keys") {
            statusEl.textContent = "⚠️ Keys missing on server";
            statusEl.style.color = "#fbbf24";
          } else {
            statusEl.textContent = `⚠️ ${data.status}`;
            statusEl.style.color = "#f87171";
          }
        }
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = "⚠️ Error loading status";
    }

    if (enabledToggle && !enabledToggle.dataset.bound) {
      enabledToggle.dataset.bound = "true";
      enabledToggle.addEventListener("change", function() {
        updateSliderUi(enabledToggle.checked);
      });
    }

    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = "true";
      saveBtn.addEventListener("click", async function() {
        saveBtn.disabled = true;
        saveBtn.style.opacity = "0.6";
        if (saveMsg) saveMsg.textContent = "Saving...";

        const payload = {
          enabled: !!(enabledToggle && enabledToggle.checked),
          max_open_positions: parseInt(maxPosInput?.value || "3", 10),
          margin_per_trade: parseFloat(marginInput?.value || "150"),
          take_profit_usd: parseFloat(takeProfitInput?.value || "40")
        };

        try {
          const postRes = await fetch("/api/owner/delta/config", {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (postRes.ok) {
            if (saveMsg) {
              saveMsg.textContent = "Saved ✅";
              setTimeout(() => { if (saveMsg) saveMsg.textContent = ""; }, 2500);
            }
          } else {
            if (saveMsg) saveMsg.textContent = "Error saving";
          }
        } catch (err) {
          if (saveMsg) saveMsg.textContent = "Network error";
        } finally {
          saveBtn.disabled = false;
          saveBtn.style.opacity = "1";
        }
      });
    }
  }

})();
