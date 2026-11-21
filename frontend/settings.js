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
  let _deltaLastUserEditTime = 0;
  let _deltaIsSaving = false;
  let _deltaCurrentTpMode = "fixed";

  async function getFreshOwnerToken() {
    if (window.marketDockSupabase) {
      try {
        const { data } = await window.marketDockSupabase.auth.getSession();
        return data?.session?.access_token || "";
      } catch (e) {}
    }
    return "";
  }

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
    const tpInputBox = document.getElementById("cdDeltaTpInputBox");
    const tpInputLabel = document.getElementById("cdDeltaTpInputLabel");
    const tpSubtext = document.getElementById("cdDeltaTpSubtext");
    const tpModeFixedBtn = document.getElementById("cdDeltaTpModeFixedBtn");
    const tpModeTrendBtn = document.getElementById("cdDeltaTpModeTrendBtn");
    const tpModeBadge = document.getElementById("cdDeltaTpModeBadge");
    const tpModeDesc = document.getElementById("cdDeltaTpModeDesc");
    const statusEl = document.getElementById("cdDeltaConnStatus");
    const saveBtn = document.getElementById("cdDeltaSaveBtn");
    const saveMsg = document.getElementById("cdDeltaSaveMsg");

    function updateTpModeUi(mode) {
      _deltaCurrentTpMode = (mode === "trend" || mode === "off") ? "trend" : "fixed";
      const isTrend = _deltaCurrentTpMode === "trend";

      if (tpModeFixedBtn) {
        tpModeFixedBtn.style.background = isTrend ? "transparent" : "#10b981";
        tpModeFixedBtn.style.color = isTrend ? "#94a3b8" : "#064e3b";
      }
      if (tpModeTrendBtn) {
        tpModeTrendBtn.style.background = isTrend ? "#38bdf8" : "transparent";
        tpModeTrendBtn.style.color = isTrend ? "#082f49" : "#94a3b8";
      }
      if (tpModeBadge) {
        tpModeBadge.textContent = isTrend ? "TREND RIDE (NO CAP)" : "$40 TARGET ACTIVE";
        tpModeBadge.style.background = isTrend ? "rgba(56,189,248,0.2)" : "rgba(16,185,129,0.2)";
        tpModeBadge.style.color = isTrend ? "#38bdf8" : "#34d399";
      }
      if (tpModeDesc) {
        tpModeDesc.textContent = isTrend
          ? "🔥 $40 Target band hai: Bullish/Bearish trend me position open rahegi taki aur jyada profit mile."
          : "🎯 $40 Target active: Target hit hote hi market order par auto-close ho jayega.";
      }
      if (tpInputBox) {
        tpInputBox.style.background = isTrend ? "rgba(255,255,255,0.03)" : "rgba(16,185,129,0.06)";
        tpInputBox.style.borderColor = isTrend ? "rgba(255,255,255,0.12)" : "rgba(16,185,129,0.25)";
      }
      if (tpInputLabel) {
        tpInputLabel.textContent = isTrend ? "Target (OFF)" : "Auto Profit ($)";
        tpInputLabel.style.color = isTrend ? "#94a3b8" : "#34d399";
      }
      if (takeProfitInput) {
        takeProfitInput.style.borderColor = isTrend ? "rgba(255,255,255,0.15)" : "rgba(16,185,129,0.4)";
        takeProfitInput.style.color = isTrend ? "#64748b" : "#34d399";
        takeProfitInput.disabled = isTrend;
      }
      if (tpSubtext) {
        tpSubtext.textContent = isTrend ? "Target OFF — Riding trend" : ("Auto-close at +$" + (takeProfitInput?.value || "40"));
        tpSubtext.style.color = isTrend ? "#38bdf8" : "#10b981";
      }
    }

    function updateSliderUi(checked) {
      if (!slider) return;
      slider.style.backgroundColor = checked ? "#10b981" : "#334155";
      slider.innerHTML = checked
        ? '<span style="position:absolute; top:3px; right:4px; width:20px; height:20px; background:#fff; border-radius:50%; box-shadow:0 1px 3px rgba(0,0,0,0.3);"></span>'
        : '<span style="position:absolute; top:3px; left:4px; width:20px; height:20px; background:#94a3b8; border-radius:50%; box-shadow:0 1px 3px rgba(0,0,0,0.3);"></span>';
    }

    // Helper to send config to server immediately
    async function persistDeltaConfig(source) {
      if (_deltaIsSaving) return;
      _deltaIsSaving = true;
      _deltaLastUserEditTime = Date.now();

      if (source === "button" && saveBtn) {
        saveBtn.disabled = true;
        saveBtn.style.opacity = "0.6";
      }
      if (saveMsg) {
        saveMsg.textContent = source === "toggle" ? "Saving..." : "Saving...";
        saveMsg.style.color = "#94a3b8";
      }

      const token = await getFreshOwnerToken();
      const headers = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = "Bearer " + token;

      const payload = {
        enabled: !!(enabledToggle && enabledToggle.checked),
        max_open_positions: parseInt(maxPosInput?.value || "3", 10),
        margin_per_trade: parseFloat(marginInput?.value || "150"),
        take_profit_mode: _deltaCurrentTpMode,
        take_profit_usd: parseFloat(takeProfitInput?.value || "40")
      };

      try {
        const postRes = await fetch("/api/owner/delta/config", {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        });
        if (postRes.ok) {
          const resData = await postRes.json();
          const isEnabled = !!(resData.config && resData.config.enabled);
          if (enabledToggle) {
            enabledToggle.checked = isEnabled;
            updateSliderUi(isEnabled);
          }
          if (saveMsg) {
            const isTrend = _deltaCurrentTpMode === "trend";
            const modeText = isTrend ? "Trend Ride (Target OFF)" : ("$" + (payload.take_profit_usd) + " Target");
            saveMsg.textContent = isEnabled ? `Auto-Trading Active 🟢 (${modeText})` : `Saved (Auto-Trading OFF) ⚪`;
            saveMsg.style.color = isEnabled ? "#34d399" : "#94a3b8";
            setTimeout(() => { if (saveMsg && !_deltaIsSaving) saveMsg.textContent = ""; }, 3500);
          }
        } else {
          if (saveMsg) {
            saveMsg.textContent = "Error saving (HTTP " + postRes.status + ")";
            saveMsg.style.color = "#f87171";
          }
        }
      } catch (err) {
        if (saveMsg) {
          saveMsg.textContent = "Network error saving";
          saveMsg.style.color = "#f87171";
        }
      } finally {
        _deltaIsSaving = false;
        _deltaLastUserEditTime = Date.now();
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.style.opacity = "1";
        }
      }
    }

    // Only load from server if user isn't actively interacting
    const timeSinceLastEdit = Date.now() - _deltaLastUserEditTime;
    if (timeSinceLastEdit > 3500 && !_deltaIsSaving) {
      const token = await getFreshOwnerToken();
      const headers = {};
      if (token) headers["Authorization"] = "Bearer " + token;

      try {
        const res = await fetch("/api/owner/delta/config", { headers });
        if (res.ok) {
          const data = await res.json();
          const cfg = data.config || {};
          if (Date.now() - _deltaLastUserEditTime > 3500 && !_deltaIsSaving) {
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
            if (cfg.take_profit_mode != null) {
              _deltaCurrentTpMode = cfg.take_profit_mode;
            }
            updateTpModeUi(_deltaCurrentTpMode);
          }
          if (statusEl) {
            if (data.status === "connected") {
              statusEl.textContent = "🟢 Connected (" + (data.delta_open_positions || 0) + " active)";
              statusEl.style.color = "#34d399";
            } else if (data.status === "missing_keys") {
              statusEl.textContent = "⚠️ Keys missing on server";
              statusEl.style.color = "#fbbf24";
            } else {
              statusEl.textContent = "⚠️ " + data.status;
              statusEl.style.color = "#f87171";
            }
          }
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = "⚠️ Error loading status";
      }
    }

    // Bind Toggle Change to AUTO-SAVE immediately!
    if (enabledToggle && !enabledToggle.dataset.bound) {
      enabledToggle.dataset.bound = "true";
      enabledToggle.addEventListener("change", function() {
        _deltaLastUserEditTime = Date.now();
        updateSliderUi(enabledToggle.checked);
        persistDeltaConfig("toggle");
      });
    }

    // Bind Mode Selection Buttons
    if (tpModeFixedBtn && !tpModeFixedBtn.dataset.bound) {
      tpModeFixedBtn.dataset.bound = "true";
      tpModeFixedBtn.addEventListener("click", function() {
        _deltaLastUserEditTime = Date.now();
        updateTpModeUi("fixed");
        persistDeltaConfig("tp_fixed");
      });
    }

    if (tpModeTrendBtn && !tpModeTrendBtn.dataset.bound) {
      tpModeTrendBtn.dataset.bound = "true";
      tpModeTrendBtn.addEventListener("click", function() {
        _deltaLastUserEditTime = Date.now();
        updateTpModeUi("trend");
        persistDeltaConfig("tp_trend");
      });
    }

    // Also track input changes so polling doesn't overwrite while user is typing
    [maxPosInput, marginInput, takeProfitInput].forEach(inp => {
      if (inp && !inp.dataset.bound) {
        inp.dataset.bound = "true";
        inp.addEventListener("input", function() {
          _deltaLastUserEditTime = Date.now();
          if (inp === takeProfitInput && _deltaCurrentTpMode === "fixed" && tpSubtext) {
            tpSubtext.textContent = "Auto-close at +$" + (takeProfitInput.value || "40");
          }
        });
      }
    });

    // Bind Save Settings button
    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = "true";
      saveBtn.addEventListener("click", function() {
        persistDeltaConfig("button");
      });
    }
  }

})();
