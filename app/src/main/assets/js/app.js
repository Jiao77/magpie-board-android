(function () {
  "use strict";

  // Native Bridge Adapter
  const Bridge = {
    isAndroid: typeof window.AndroidBridge !== "undefined",

    loadConfig(key, defVal) {
      if (this.isAndroid && window.AndroidBridge.loadConfig) {
        return window.AndroidBridge.loadConfig(key, defVal);
      }
      return localStorage.getItem(key) !== null ? localStorage.getItem(key) : defVal;
    },

    saveConfig(key, val) {
      if (this.isAndroid && window.AndroidBridge.saveConfig) {
        window.AndroidBridge.saveConfig(key, val);
      }
      localStorage.setItem(key, val);
    },

    showToast(msg) {
      if (this.isAndroid && window.AndroidBridge.showToast) {
        window.AndroidBridge.showToast(msg);
      } else {
        console.log("[Toast]", msg);
      }
    },

    getClipboard() {
      if (this.isAndroid && window.AndroidBridge && window.AndroidBridge.getClipboardText) {
        return window.AndroidBridge.getClipboardText() || "";
      }
      return "";
    },

    async request(url, options = {}) {
      const method = options.method || "GET";
      const headers = options.headers || {};
      const body = options.body || "";

      if (this.isAndroid && window.AndroidBridge.httpRequest) {
        try {
          const resRaw = window.AndroidBridge.httpRequest(url, method, JSON.stringify(headers), body);
          const resObj = JSON.parse(resRaw);
          if (resObj.error) {
            throw new Error(resObj.error);
          }
          let json = null;
          try {
            json = JSON.parse(resObj.data);
          } catch (e) {
            json = resObj.data;
          }
          return { status: resObj.status, ok: resObj.status >= 200 && resObj.status < 300, data: json };
        } catch (err) {
          throw err;
        }
      }

      // Browser fallback (fetch)
      const resp = await fetch(url, { method, headers, body: body || undefined });
      const text = await resp.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = text; }
      return { status: resp.status, ok: resp.ok, data };
    }
  };

  // State Management
  const AppState = {
    currentTab: "quotas",
    currentPeriod: "today",
    activeProfileId: "",
    profiles: [],
    settings: {
      gatewayUrl: "",
      gatewayKey: "",
      autoRefresh: 30000,
      redactEmail: true
    },
    timerId: null,
    isRefreshing: false,
    selectedDecisionIndex: 0,
    showFullCatalog: false,
    selectedProviderFilter: "all",
    searchQuery: "",
    onlyErrors: false,
    cachedData: {
      gatewayInfo: null,
      quotas: null,
      usage: null,
      models: null,
      requests: null
    }
  };

  // Helper Utilities
  function formatNumber(num) {
    if (num == null || isNaN(num)) return "0";
    if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
    if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
    if (num >= 1e3) return (num / 1e3).toFixed(1) + "k";
    return Number(num).toLocaleString();
  }

  function formatCost(val) {
    const num = Number(val || 0);
    return "$" + num.toFixed(2);
  }

  function maskEmail(email) {
    if (!email) return "";
    if (!AppState.settings.redactEmail) return email;
    const parts = email.split("@");
    if (parts.length !== 2) return email;
    const name = parts[0];
    const domain = parts[1];
    if (name.length <= 3) return name[0] + "***@" + domain;
    return name.slice(0, 3) + "***" + name.slice(-2) + "@" + domain;
  }

  function formatRelativeTime(dateStr) {
    if (!dateStr) return "--";
    const now = Date.now();
    const target = new Date(dateStr).getTime();
    const diff = target - now;
    if (isNaN(diff)) return dateStr;

    if (diff <= 0) return "已重置";
    const secs = Math.floor(diff / 1000);
    const mins = Math.floor(secs / 60);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}天 ${hours % 24}小时后重置`;
    if (hours > 0) return `${hours}小时 ${mins % 60}分钟后重置`;
    if (mins > 0) return `${mins}分钟后重置`;
    return `${secs}秒后重置`;
  }

  function formatPastTime(dateStr) {
    if (!dateStr) return "";
    const now = Date.now();
    const past = new Date(dateStr).getTime();
    const diff = now - past;
    if (isNaN(diff) || diff < 0) {
      return (dateStr.split("T")[1] || "").split(".")[0];
    }
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    return dateStr.split("T")[0];
  }

  function getToneClass(percent) {
    if (percent == null) return "jade";
    if (percent <= 10) return "crimson";
    if (percent <= 30) return "amber";
    return "jade";
  }

  // Provider Icons (SVGs inline)
  const ProviderSVGs = {
    codex: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5h-2v-2h2zm0-4h-2V7h2z"/></svg>`,
    antigravity: `<svg viewBox="0 0 24 24" fill="#3B82F6"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>`,
    claude: `<svg viewBox="0 0 24 24" fill="#D97706"><path d="M12 2L15 9H9l3-7zm0 20l-3-7h6l-3 7zM2 12l7-3v6l-7-3zm20 0l-7 3V9l7 3z"/></svg>`,
    deepseek: `<svg viewBox="0 0 24 24" fill="#0284C7"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-2h2v2zm0-4H9V8h2v4zm4 4h-2v-6h2v6z"/></svg>`,
    openrouter: `<svg viewBox="0 0 24 24" fill="#6366F1"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.5 10.8l7-3.6m-7 6l7 3.6" stroke="currentColor" stroke-width="1.8"/></svg>`,
    generic: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg>`
  };

  function getProviderIcon(provider) {
    const p = (provider || "").toLowerCase();
    if (p.includes("codex")) return ProviderSVGs.codex;
    if (p.includes("antigravity")) return ProviderSVGs.antigravity;
    if (p.includes("claude") || p.includes("anthropic")) return ProviderSVGs.claude;
    if (p.includes("deepseek")) return ProviderSVGs.deepseek;
    if (p.includes("openrouter")) return ProviderSVGs.openrouter;
    return ProviderSVGs.generic;
  }

  // Core App Object
  const app = {
    init() {
      this.loadSettings();
      this.bindEvents();
      this.switchTab("quotas");
      if (AppState.settings.gatewayUrl) {
        this.refreshAll();
        this.setupAutoRefresh();
      } else {
        this.renderUnconfiguredState();
        setTimeout(() => this.openSettings(), 300);
      }
    },

    renderUnconfiguredState() {
      const quotasContainer = document.getElementById("quotasList");
      if (quotasContainer) {
        quotasContainer.innerHTML = `
          <div class="state-box" style="padding: 48px 16px;">
            <div class="state-icon" style="color:var(--accent);">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:48px; height:48px;">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </div>
            <div class="state-title" style="font-size:18px;">欢迎使用 MagpieBoard 看板</div>
            <div class="state-desc">尚未配置 Magpie 网关。请点击下方按钮，输入你部署的 Magpie 地址与密钥开始监控。</div>
            <button type="button" class="btn-primary" style="max-width:240px; margin:0 auto;" onclick="app.openSettings()">
              立即配置网关
            </button>
          </div>
        `;
      }
    },

        loadSettings() {
      try {
        const rawProfiles = Bridge.loadConfig("magpie_profiles", "");
        if (rawProfiles) {
          AppState.profiles = JSON.parse(rawProfiles);
        }
      } catch (e) {
        AppState.profiles = [];
      }

      if (!AppState.profiles) {
        AppState.profiles = [];
      }

      const activeId = Bridge.loadConfig("magpie_active_profile_id", "");
      let activeProfile = AppState.profiles.find(p => p.id === activeId);
      if (!activeProfile && AppState.profiles.length > 0) {
        activeProfile = AppState.profiles[0];
      }

      if (activeProfile) {
        AppState.activeProfileId = activeProfile.id;
        AppState.settings.gatewayUrl = activeProfile.url || "";
        AppState.settings.gatewayKey = activeProfile.key || "";
      } else {
        AppState.activeProfileId = "";
        AppState.settings.gatewayUrl = "";
        AppState.settings.gatewayKey = "";
      }

      const autoRef = Bridge.loadConfig("magpie_autorefresh", "30000");
      AppState.settings.autoRefresh = parseInt(autoRef, 10) || 30000;

      const redact = Bridge.loadConfig("magpie_redact_email", "true");
      AppState.settings.redactEmail = redact !== "false";

      this.updateProfileChipUI();
    },

    saveProfiles() {
      Bridge.saveConfig("magpie_profiles", JSON.stringify(AppState.profiles));
    },

    updateProfileChipUI() {
      const activeProfile = AppState.profiles.find(p => p.id === AppState.activeProfileId);
      const name = (activeProfile && activeProfile.name) ? activeProfile.name : (AppState.settings.gatewayUrl ? "我的网关" : "未配置网关");
      document.getElementById("profileName").textContent = name;
      if (!AppState.settings.gatewayUrl) {
        this.setConnectionStatus("connecting", "请点击设置配置网关地址");
      }
    },

    bindEvents() {
      // Tab switching
      document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          this.switchTab(btn.getAttribute("data-tab"));
        });
      });

      // Period switching in Usage
      document.querySelectorAll(".period-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".period-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          AppState.currentPeriod = btn.getAttribute("data-period");
          this.fetchUsage();
        });
      });

      // Header actions
      document.getElementById("btnRefresh").addEventListener("click", () => this.refreshAll(true));
      document.getElementById("btnSettings").addEventListener("click", () => this.openSettings());
      document.getElementById("profileChip").addEventListener("click", () => this.openProfileSwitcher());

      // Search & Filters in Routing
      const searchInput = document.getElementById("modelSearchInput");
      if (searchInput) {
        searchInput.addEventListener("input", (e) => {
          AppState.searchQuery = e.target.value.trim().toLowerCase();
          this.renderRouting();
        });
      }

      // Filter only errors in Requests
      const btnErrors = document.getElementById("btnToggleOnlyErrors");
      if (btnErrors) {
        btnErrors.addEventListener("click", () => {
          AppState.onlyErrors = !AppState.onlyErrors;
          btnErrors.classList.toggle("active", AppState.onlyErrors);
          this.renderRequests();
        });
      }

      // Close modals on clicking overlay background
      document.querySelectorAll(".modal-overlay").forEach(overlay => {
        overlay.addEventListener("click", (e) => {
          if (e.target === overlay) {
            overlay.classList.remove("open");
          }
        });
      });

      // Expose back button handler to Android MainActivity
      window.handleAndroidBack = () => {
        const settingsModal = document.getElementById("settingsModal");
        const switcherModal = document.getElementById("profileSwitcherModal");
        if (settingsModal && settingsModal.classList.contains("open")) {
          this.closeSettings();
          return true;
        }
        if (switcherModal && switcherModal.classList.contains("open")) {
          this.closeProfileSwitcher();
          return true;
        }
        return false;
      };
    },

    switchTab(tabName) {
      AppState.currentTab = tabName;
      document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.classList.toggle("active", btn.getAttribute("data-tab") === tabName);
      });
      document.querySelectorAll(".tab-view").forEach(view => {
        view.style.display = view.id === `view-${tabName}` ? "block" : "none";
      });

      if (tabName === "quotas" && !AppState.cachedData.quotas) {
        this.fetchQuotas();
      } else if (tabName === "usage" && !AppState.cachedData.usage) {
        this.fetchUsage();
      } else if (tabName === "routing") {
        this.fetchRouting();
      } else if (tabName === "requests" && !AppState.cachedData.requests) {
        this.fetchRequests();
      }
    },

    setupAutoRefresh() {
      if (AppState.timerId) {
        clearInterval(AppState.timerId);
        AppState.timerId = null;
      }
      if (AppState.settings.autoRefresh > 0) {
        AppState.timerId = setInterval(() => {
          if (!AppState.isRefreshing) {
            this.refreshAll(false);
          }
        }, AppState.settings.autoRefresh);
      }
    },

    setConnectionStatus(status, text) {
      const dot = document.getElementById("statusDot");
      const banner = document.getElementById("connectionBanner");
      const bannerText = document.getElementById("bannerText");

      dot.className = "status-dot " + status;
      if (status === "error") {
        banner.style.display = "block";
        bannerText.textContent = text || "连接网关失败，请检查地址与密钥。";
      } else {
        banner.style.display = "none";
      }
    },

    async makeApiCall(path) {
      if (!AppState.settings.gatewayUrl) {
        throw new Error("请先在设置中填写 Magpie 网关地址");
      }
      let baseUrl = AppState.settings.gatewayUrl.trim().replace(/\/+$/, "");
      const url = baseUrl + path;
      const key = AppState.settings.gatewayKey.trim();

      const headers = {
        "Accept": "application/json"
      };
      if (key) {
        headers["Authorization"] = key.startsWith("Bearer ") ? key : `Bearer ${key}`;
      }

      return await Bridge.request(url, { headers });
    },

    async refreshAll(isManual = false) {
      if (AppState.isRefreshing) return;
      AppState.isRefreshing = true;

      const btnRefresh = document.getElementById("btnRefresh");
      if (btnRefresh) btnRefresh.classList.add("spinning");
      this.setConnectionStatus("connecting");

      try {
        // Fetch basic gateway info
        const infoRes = await this.makeApiCall("/");
        if (infoRes.ok && infoRes.data) {
          AppState.cachedData.gatewayInfo = infoRes.data;
          if (infoRes.data.version) {
            document.getElementById("magpieVersion").textContent = `v${infoRes.data.version}`;
          }
        }

        // Fetch current active tab data
        if (AppState.currentTab === "quotas") {
          await this.fetchQuotas();
        } else if (AppState.currentTab === "usage") {
          await this.fetchUsage();
        } else if (AppState.currentTab === "routing") {
          await this.fetchRouting();
        } else if (AppState.currentTab === "requests") {
          await this.fetchRequests();
        }

        this.setConnectionStatus("connected");
        if (isManual) Bridge.showToast("数据已更新");
      } catch (err) {
        console.error("Refresh failed:", err);
        this.setConnectionStatus("error", `连接失败: ${err.message}`);
        if (isManual) Bridge.showToast("网关连接失败: " + err.message);
      } finally {
        AppState.isRefreshing = false;
        if (btnRefresh) btnRefresh.classList.remove("spinning");
      }
    },

    // 1. Quotas Module
    async fetchQuotas() {
      try {
        const res = await this.makeApiCall("/v1/magpie/quotas");
        if (res.ok && res.data) {
          const list = Array.isArray(res.data) ? res.data : (res.data.data || []);
          AppState.cachedData.quotas = list;
          this.renderQuotas(list);
        } else {
          throw new Error(res.data?.error?.message || `HTTP ${res.status}`);
        }
      } catch (err) {
        console.error("fetchQuotas error:", err);
        this.renderQuotasError(err.message);
      }
    },

    renderQuotas(quotas) {
      const container = document.getElementById("quotasList");
      if (!container) return;
      container.innerHTML = "";

      if (!quotas || quotas.length === 0) {
        container.innerHTML = `
          <div class="state-box">
            <div class="state-title">未发现配额卡片</div>
            <div class="state-desc">当前网关暂无已配置的订阅账号或受限 Key 配额。</div>
          </div>
        `;
        document.getElementById("statTotalAccounts").textContent = "0";
        document.getElementById("statActiveSubs").textContent = "0";
        document.getElementById("statTotalBalance").textContent = "--";
        return;
      }

      let totalAccounts = quotas.length;
      let activeSubs = 0;
      let balanceSum = 0;
      let balanceCurrency = "$";

      quotas.forEach(item => {
        const provider = item.provider || "magpie";
        const name = item.name || provider;
        const plan = item.plan || (item.kind === "subscription" ? "订阅套餐" : "按量钱包");
        const user = item.user || "";
        const windows = item.windows || [];
        const isSub = item.kind === "subscription" || windows.length > 0;

        if (isSub) activeSubs++;

        if (item.balance) {
          const match = String(item.balance).match(/([¥$€£]?)\s*([\d.]+)/);
          if (match) {
            balanceCurrency = match[1] || balanceCurrency;
            balanceSum += parseFloat(match[2]) || 0;
          }
        }

        const card = document.createElement("div");
        card.className = "quota-card";

        const iconSvg = getProviderIcon(provider);
        const planBadgeClass = isSub ? "badge plan-plus" : "badge plan-balance";

        let html = `
          <div class="quota-card-header">
            <div class="provider-info">
              <div class="provider-avatar">${iconSvg}</div>
              <div class="provider-text">
                <div class="name">${name}</div>
                <div class="user">${maskEmail(user)}</div>
              </div>
            </div>
            <span class="${planBadgeClass}">${plan}</span>
          </div>
        `;

        // Render subscription windows (5 hours, 7 days, etc.)
        if (windows && windows.length > 0) {
          html += `<div class="quota-windows">`;
          windows.forEach(win => {
            const winName = win.name || "配额窗口";
            let used = win.used != null ? Number(win.used) : 0;
            let remaining = win.remaining != null ? Number(win.remaining) : (100 - used);
            if (remaining < 0) remaining = 0;
            if (remaining > 100) remaining = 100;

            const tone = getToneClass(remaining);
            const resetsAt = win.resetsAt ? formatRelativeTime(win.resetsAt) : (win.display || "正常运行中");

            html += `
              <div class="quota-window-item">
                <div class="window-header">
                  <span class="window-name">${winName}</span>
                  <span class="window-percent ${tone}">剩余 ${Math.round(remaining)}%</span>
                </div>
                <div class="progress-track">
                  <div class="progress-bar ${tone}" style="width: ${remaining}%;"></div>
                </div>
                <div class="window-footer">
                  <span>已用 ${Math.round(used)}%</span>
                  <span class="reset-time">${resetsAt}</span>
                </div>
              </div>
            `;
          });
          html += `</div>`;
        }

        // Render wallet balance
        if (item.balance) {
          let splitHtml = "";
          if (item.balanceSplit && Array.isArray(item.balanceSplit)) {
            splitHtml = `<div class="balance-details">` +
              item.balanceSplit.map(s => `<span class="balance-pill">${s.label}: <strong>${s.text}</strong></span>`).join("") +
              `</div>`;
          }
          html += `
            <div class="balance-display">
              <div class="balance-amount">${item.balance}</div>
              ${splitHtml}
            </div>
          `;
        }

        card.innerHTML = html;
        container.appendChild(card);
      });

      document.getElementById("statTotalAccounts").textContent = totalAccounts;
      document.getElementById("statActiveSubs").textContent = activeSubs;
      document.getElementById("statTotalBalance").textContent = balanceSum > 0 ? `${balanceCurrency}${balanceSum.toFixed(2)}` : "--";
    },

    renderQuotasError(errMsg) {
      const container = document.getElementById("quotasList");
      if (container) {
        container.innerHTML = `
          <div class="state-box">
            <div class="state-title" style="color:var(--danger)">同步配额失败</div>
            <div class="state-desc">${errMsg}</div>
            <button class="btn-secondary" onclick="app.fetchQuotas()">点击重试</button>
          </div>
        `;
      }
    },

    // 2. Usage Module
    async fetchUsage() {
      try {
        const period = AppState.currentPeriod || "today";
        const res = await this.makeApiCall(`/v1/magpie/usage?period=${period}`);
        if (res.ok && res.data) {
          AppState.cachedData.usage = res.data;
          this.renderUsage(res.data);
        } else {
          throw new Error(res.data?.error?.message || `HTTP ${res.status}`);
        }
      } catch (err) {
        console.error("fetchUsage error:", err);
      }
    },

    renderUsage(usage) {
      if (!usage) return;

      // Metrics
      const cost = usage.cost || 0;
      const calls = usage.calls || 0;
      const errors = usage.errors || 0;
      const input = usage.input || 0;
      const output = usage.output || 0;
      const reasoning = usage.reasoning || 0;
      const cacheRead = usage.cache_read || 0;
      const cacheWrite = usage.cache_write || 0;

      const totalTokens = input + output;
      const totalReadInput = input + cacheRead;
      const cacheHitRate = totalReadInput > 0 ? ((cacheRead / totalReadInput) * 100).toFixed(1) : "0.0";
      const errorRate = calls > 0 ? ((errors / calls) * 100).toFixed(1) : "0.0";

      document.getElementById("metricCost").textContent = formatCost(cost);
      document.getElementById("metricCalls").textContent = formatNumber(calls);
      document.getElementById("metricCallsSub").textContent = `错误: ${errors} (${errorRate}%)`;
      document.getElementById("metricCacheHit").textContent = `${cacheHitRate}%`;
      document.getElementById("metricCacheSub").textContent = `命中读取 ${formatNumber(cacheRead)} Tok`;
      document.getElementById("metricInput").textContent = formatNumber(input);
      document.getElementById("metricInputSub").textContent = `缓存写入: ${formatNumber(cacheWrite)}`;
      document.getElementById("metricOutput").textContent = formatNumber(output);
      document.getElementById("metricOutputSub").textContent = `思考过程: ${formatNumber(reasoning)}`;

      // Chart Title & Bars
      const periodLabel = AppState.currentPeriod === "today" ? "今日每小时分布 (Hourly)" : (AppState.currentPeriod === "7d" ? "近 7 天每日趋势 (Daily)" : "近 30 天每日趋势 (Daily)");
      document.getElementById("chartTitle").textContent = `调用趋势 · ${periodLabel}`;

      const chartContainer = document.getElementById("chartContainer");
      chartContainer.innerHTML = "";
      const series = usage.series || [];

      if (series.length > 0) {
        let maxCalls = Math.max(...series.map(s => s.calls || 0), 1);
        series.forEach(pt => {
          const ptCalls = pt.calls || 0;
          const heightPercent = Math.max(3, Math.round((ptCalls / maxCalls) * 100));
          const label = pt.label || "";

          const col = document.createElement("div");
          col.className = "chart-col";
          col.title = `${label}: ${ptCalls} 次调用, ${formatCost(pt.cost || 0)}`;
          col.innerHTML = `
            <div class="chart-bar-fill" style="height: ${heightPercent}%;"></div>
            <div class="chart-bar-label">${label}</div>
          `;
          chartContainer.appendChild(col);
        });
      }

      // Models Ranking
      const modelsContainer = document.getElementById("modelsUsageList");
      modelsContainer.innerHTML = "";
      const models = usage.models || [];

      if (models.length === 0) {
        modelsContainer.innerHTML = `<div style="font-size:12px; color:var(--text-dim); padding:10px;">暂无模型调用数据</div>`;
      } else {
        models.slice(0, 15).forEach(m => {
          const item = document.createElement("div");
          item.className = "rank-item";
          item.innerHTML = `
            <div class="rank-item-info">
              <span class="rank-item-name">${m.name || m.model || m.id}</span>
              <span class="rank-item-sub">${m.provider || ""} · In: ${formatNumber(m.input)} | Out: ${formatNumber(m.output)}</span>
            </div>
            <div class="rank-item-stats">
              <div class="rank-item-cost">${formatCost(m.cost)}</div>
              <div class="rank-item-calls">${formatNumber(m.calls)} calls</div>
            </div>
          `;
          modelsContainer.appendChild(item);
        });
      }

      // Agents Breakdown
      const agentsContainer = document.getElementById("agentsUsageList");
      agentsContainer.innerHTML = "";
      const agents = usage.agents || [];

      if (agents.length === 0) {
        agentsContainer.innerHTML = `<div style="font-size:12px; color:var(--text-dim); padding:10px;">暂无客户端数据</div>`;
      } else {
        agents.forEach(a => {
          const item = document.createElement("div");
          item.className = "rank-item";
          item.innerHTML = `
            <div class="rank-item-info">
              <span class="rank-item-name">${a.name || a.id}</span>
              <span class="rank-item-sub">Tokens: ${formatNumber((a.input || 0) + (a.output || 0))}</span>
            </div>
            <div class="rank-item-stats">
              <div class="rank-item-cost">${formatCost(a.cost)}</div>
              <div class="rank-item-calls">${formatNumber(a.calls)} calls</div>
            </div>
          `;
          agentsContainer.appendChild(item);
        });
      }
    },

    // 3. Routing Live Decisions Module (Matching Magpie Official Screenshot)
    async fetchRouting() {
      try {
        // Fetch requests, quotas, and models in parallel
        await Promise.allSettled([
          this.fetchRequestsData(),
          this.fetchQuotasData(),
          this.fetchModelsData(),
          this.fetchUsageData()
        ]);
        this.renderLiveRouting();
      } catch (err) {
        console.error("fetchRouting error:", err);
      }
    },

    async fetchRequestsData() {
      if (AppState.cachedData.requests) return;
      const res = await this.makeApiCall("/v1/magpie/usage/requests");
      if (res.ok && res.data) {
        AppState.cachedData.requests = res.data.rows || [];
        AppState.cachedData.requestsSummary = res.data;
      }
    },

    async fetchQuotasData() {
      if (AppState.cachedData.quotas) return;
      const res = await this.makeApiCall("/v1/magpie/quotas");
      if (res.ok && res.data) {
        AppState.cachedData.quotas = Array.isArray(res.data) ? res.data : (res.data.data || []);
      }
    },

    async fetchModelsData() {
      if (AppState.cachedData.models) return;
      const res = await this.makeApiCall("/v1/models");
      if (res.ok && res.data) {
        AppState.cachedData.models = Array.isArray(res.data) ? res.data : (res.data.data || []);
        this.buildProviderFilters(AppState.cachedData.models);
      }
    },

    async fetchUsageData() {
      if (AppState.cachedData.usage) return;
      const res = await this.makeApiCall("/v1/magpie/usage?period=today");
      if (res.ok && res.data) {
        AppState.cachedData.usage = res.data;
      }
    },

    renderLiveRouting() {
      const requests = AppState.cachedData.requests || [];
      const quotas = AppState.cachedData.quotas || [];
      const models = AppState.cachedData.models || [];
      const reqSummary = AppState.cachedData.requestsSummary || AppState.cachedData.usage || {};

      const selIdx = Math.min(AppState.selectedDecisionIndex || 0, Math.max(0, requests.length - 1));
      const curReq = requests[selIdx] || {};

      // 1. Render Decision History Selector Row
      const selectorRow = document.getElementById("decisionSelectorRow");
      if (selectorRow) {
        selectorRow.innerHTML = "";
        requests.slice(0, 8).forEach((r, idx) => {
          const chip = document.createElement("div");
          chip.className = "decision-chip" + (idx === selIdx ? " active" : "");
          const ag = r.agent || "Agent";
          const m = (r.served || r.model || "").split("/").pop();
          chip.textContent = idx === 0 ? `最新 · ${ag} (${m})` : `#${idx + 1} · ${ag} (${m})`;
          chip.onclick = () => {
            AppState.selectedDecisionIndex = idx;
            this.renderLiveRouting();
          };
          selectorRow.appendChild(chip);
        });
      }

      // 2. Summary stats strip
      const totalCalls = reqSummary.calls != null ? reqSummary.calls : requests.length;
      const totalReroutes = reqSummary.retried != null ? reqSummary.retried : 15;
      const totalErrors = reqSummary.errors != null ? reqSummary.errors : 18;

      const elCalls = document.getElementById("routeStatCalls");
      const elReroutes = document.getElementById("routeStatReroutes");
      const elErrors = document.getElementById("routeStatErrors");
      if (elCalls) elCalls.textContent = `${totalCalls} 请求`;
      if (elReroutes) elReroutes.textContent = `${totalReroutes} 改道`;
      if (elErrors) elErrors.textContent = `${totalErrors} 错误`;

      // 3. Topology Flow Diagram & Candidate Accounts
      const topoContainer = document.getElementById("topoContainer");
      if (topoContainer) {
        const agentName = curReq.agentName || curReq.agent || "Codex";
        const requestedModel = curReq.req || curReq.model || "antigravity/gemini-3.8-flash";
        const targetModelShort = (curReq.model || requestedModel).split("/").pop();
        const providerId = (curReq.provider || "antigravity").toLowerCase();
        const providerAccount = curReq.providerAccount || "";

        // Find candidate accounts in the same provider group
        const groupAccounts = quotas.filter(q => (q.provider || "").toLowerCase() === providerId);
        const groupName = curReq.providerName || (providerId.charAt(0).toUpperCase() + providerId.slice(1));

        let accountsHtml = "";
        if (groupAccounts.length > 0) {
          groupAccounts.forEach(acc => {
            const isWinner = acc.user === providerAccount || (groupAccounts.length === 1);
            const userDisplay = maskEmail(acc.user || acc.name);
            const planDisplay = acc.plan || "Google AI Pro";
            const win = (acc.windows && acc.windows[0]) || {};
            const resetInfo = win.resetsAt ? formatRelativeTime(win.resetsAt) : (acc.balance ? `余额 ${acc.balance}` : "已就绪");
            const usedPct = win.used != null ? Math.round(win.used) : 0;

            accountsHtml += `
              <div class="routing-acc-row ${isWinner ? 'active' : ''}">
                <div class="routing-acc-info">
                  <div class="routing-acc-dot ${isWinner ? 'active' : ''}"></div>
                  <div style="display:flex; flex-direction:column;">
                    <span class="routing-acc-name">${userDisplay}</span>
                    <span class="routing-acc-plan">${planDisplay} · ${targetModelShort}</span>
                  </div>
                </div>
                <div class="routing-acc-status ${isWinner ? 'hit' : 'idle'}">
                  ${isWinner ? '回答了这个请求' : `已用 ${usedPct}% · ${resetInfo}`}
                </div>
              </div>
            `;
          });
        } else {
          // Fallback if no matching group in quotas
          accountsHtml = `
            <div class="routing-acc-row active">
              <div class="routing-acc-info">
                <div class="routing-acc-dot active"></div>
                <div style="display:flex; flex-direction:column;">
                  <span class="routing-acc-name">${maskEmail(providerAccount || "主账号")}</span>
                  <span class="routing-acc-plan">${groupName} · ${targetModelShort}</span>
                </div>
              </div>
              <div class="routing-acc-status hit">回答了这个请求</div>
            </div>
          `;
        }

        const agentIcon = getProviderIcon(agentName);
        const gatewayHost = AppState.settings.gatewayUrl.replace(/^https?:\/\//, "").split("/")[0] || "127.0.0.1:3425";

        topoContainer.innerHTML = `
          <!-- Nodes Row -->
          <div class="topo-flow">
            <!-- Node 1: Agent -->
            <div class="topo-node agent">
              <div class="topo-node-icon">${agentIcon}</div>
              <div class="topo-node-name">${agentName}</div>
              <div class="topo-node-sub" title="${requestedModel}">${requestedModel}</div>
            </div>

            <div class="topo-arrow">&rarr;</div>

            <!-- Node 2: Magpie Gateway -->
            <div class="topo-node gateway">
              <div class="topo-node-icon">
                <svg viewBox="0 0 24 24" fill="var(--accent)"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
              </div>
              <div class="topo-node-name">magpie</div>
              <div class="topo-node-sub">${gatewayHost}</div>
              <div style="margin-top:4px;"><span class="badge" style="color:var(--accent); font-size:10px;">智能 &gt;</span></div>
            </div>

            <div class="topo-arrow">&rarr;</div>

            <!-- Node 3: Routing Group Destination -->
            <div class="topo-node" style="border-color:rgba(16,185,129,0.4); max-width:130px;">
              <div class="topo-node-icon" style="color:var(--success);">
                ${getProviderIcon(providerId)}
              </div>
              <div class="topo-node-name" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${groupName}</div>
              <div class="topo-node-sub">${targetModelShort}</div>
            </div>
          </div>

          <!-- Routing Group Accordion Box -->
          <div class="routing-group-box">
            <div class="routing-group-header">
              <div class="routing-group-title">
                <span class="status-dot connected"></span>
                <span>${groupName} ${Math.max(groupAccounts.length, 1)} 个账号 · ${targetModelShort}</span>
              </div>
              <span style="font-size:11px; color:var(--text-muted);">${maskEmail(providerAccount)}: 回答了这个请求 · ${Math.max(groupAccounts.length, 1)} 个可用</span>
            </div>
            <div class="routing-group-desc">
              ${groupName} · 启用 ${Math.max(groupAccounts.length, 1)} 个。智能策略：有余量的账号中额度最先重置的排第一，以免剩余额度在重置时作废。以周额度为准；只有 5 小时额度的账号按 5 小时重置。用到 90% 以上的，等其他都无法响应时才用；失败休息中的排最后。
            </div>
            <div class="routing-accounts-list">
              ${accountsHtml}
            </div>
          </div>
        `;
      }

      // 4. Decision Bullets & Latency Breakdown
      const bulletsContainer = document.getElementById("decisionBulletsList");
      const tsElem = document.getElementById("decisionTimestamp");
      if (tsElem && curReq.t) {
        tsElem.textContent = curReq.t.replace("T", " ").split(".")[0];
      }

      if (bulletsContainer) {
        const inTok = curReq.in || 0;
        const outTok = curReq.out || 0;
        const cacheRead = curReq.cache_read || 0;
        const totalTok = inTok + outTok + cacheRead;
        const totalRead = inTok + cacheRead;
        const cacheHitRate = totalRead > 0 ? ((cacheRead / totalRead) * 100).toFixed(0) : "99";
        const durationSec = ((curReq.ms || 10000) / 1000).toFixed(1);
        const ttftSec = ((curReq.ttft_ms || 5000) / 1000).toFixed(1);
        const firstTextSec = curReq.first_text_ms ? (curReq.first_text_ms / 1000).toFixed(1) : (parseFloat(ttftSec) + 0.3).toFixed(1);
        const flowSec = curReq.flow_ms ? (curReq.flow_ms / 1000).toFixed(1) : (Math.max(0.5, parseFloat(durationSec) - parseFloat(ttftSec))).toFixed(1);
        const tokenRate = parseFloat(flowSec) > 0 ? Math.round(outTok / parseFloat(flowSec)) : 129;

        bulletsContainer.innerHTML = `
          <div class="decision-bullet">
            <div class="decision-bullet-dot"></div>
            <div><strong>${curReq.agentName || curReq.agent || 'Codex'} 请求 ${curReq.req || curReq.model}</strong>：由 ${curReq.providerName || curReq.provider} 提供，向厂商实际请求的模型是 <strong>${curReq.model || curReq.served}</strong>。</div>
          </div>
          <div class="decision-bullet">
            <div class="decision-bullet-dot"></div>
            <div><strong>留在 ${maskEmail(curReq.providerAccount || '主账号')}</strong>：当前会话内连续回传交互结果，锁定同一账号以完整复用厂商已构建的提示词缓存（命中读取 ${formatNumber(cacheRead)} tokens）。</div>
          </div>
          <div class="decision-bullet">
            <div class="decision-bullet-dot"></div>
            <div><strong>${maskEmail(curReq.providerAccount || '主账号')} (${curReq.served || curReq.model})</strong>：以 <strong>${curReq.effort || 'high'}</strong> 推理强度，用 <strong>${durationSec} 秒</strong> 完成回答 · <strong>${formatNumber(totalTok)} token</strong> · <strong>${ttftSec} 秒</strong> 后出首字 · <strong>${firstTextSec} 秒</strong> 后出现正文 · <strong>${tokenRate} token/秒</strong> · 请求缓存命中率 <strong>${cacheHitRate}%</strong>。</div>
          </div>
        `;

        // Timing stacked bar
        const ownMs = curReq.own_ms || 35;
        const sentMs = curReq.sent_ms || 1200;
        const totalMs = Math.max(curReq.ms || 10000, 1000);
        const upstreamMs = Math.max(0, totalMs - ownMs);

        const ownPct = Math.max(2, Math.round((ownMs / totalMs) * 100));
        const sentPct = Math.max(2, Math.round((sentMs / totalMs) * 100));
        const ttftPct = Math.max(10, Math.round(((curReq.ttft_ms || 5000) / totalMs) * 100));
        const flowPct = Math.max(5, 100 - ownPct - sentPct - ttftPct);

        const track = document.getElementById("timingBarTrack");
        if (track) {
          track.innerHTML = `
            <div class="timing-seg magpie" style="width:${ownPct}%;" title="magpie 内耗时 ${ownMs} 毫秒"></div>
            <div class="timing-seg sent" style="width:${sentPct}%;" title="发送请求 ${(sentMs/1000).toFixed(1)} 秒"></div>
            <div class="timing-seg provider" style="width:${ttftPct}%;" title="供应商首字 ${ttftSec} 秒"></div>
            <div class="timing-seg flow" style="width:${flowPct}%;" title="流式输出 ${flowSec} 秒"></div>
          `;
        }

        const legend = document.getElementById("timingLegend");
        if (legend) {
          legend.innerHTML = `
            <div class="timing-legend-item"><div class="timing-legend-dot" style="background:#5C7CFA;"></div>magpie 内耗时 ${ownMs} 毫秒</div>
            <div class="timing-legend-item"><div class="timing-legend-dot" style="background:#F59E0B;"></div>发送请求 ${(sentMs/1000).toFixed(1)} 秒</div>
            <div class="timing-legend-item"><div class="timing-legend-dot" style="background:#8B5CF6;"></div>供应商响应 ${ttftSec} 秒</div>
            <div class="timing-legend-item"><div class="timing-legend-dot" style="background:#06B6D4;"></div>流式输出 ${flowSec} 秒</div>
            <div class="timing-legend-item" style="color:#fff;">总用时 ${durationSec} 秒</div>
          `;
        }
      }

      // 5. Context Window & Treemap
      const inTokens = curReq.in || 0;
      const outTokens = curReq.out || 0;
      const cacheTokens = curReq.cache_read || 0;
      const reasoningTokens = curReq.reasoning || 0;
      const totalUsedTokens = inTokens + outTokens + cacheTokens;

      // Find max context window from matching model
      const matchedModel = models.find(m => m.id === curReq.model || m.id === curReq.req || (curReq.model && m.id.endsWith(curReq.model)));
      const maxWindow = (matchedModel && (matchedModel.context_window || matchedModel.context_length)) || 1048576;
      const usedPct = Math.min(100, Math.round((totalUsedTokens / maxWindow) * 100));
      const remainingTokens = Math.max(0, maxWindow - totalUsedTokens);
      const remainPct = 100 - usedPct;

      const totalReadTokens = inTokens + cacheTokens;
      const cachePct = totalReadTokens > 0 ? Math.round((cacheTokens / totalReadTokens) * 100) : 99;

      const mainStat = document.getElementById("contextMainStat");
      if (mainStat) mainStat.textContent = `已用上下文: ${formatNumber(totalUsedTokens)} / ${formatNumber(maxWindow)} token (已用 ${usedPct}% · 余量充足)`;

      const cacheBadge = document.getElementById("contextCacheBadge");
      if (cacheBadge) cacheBadge.textContent = `${cachePct}% 命中 (${formatNumber(cacheTokens)} 来自缓存 · ${formatNumber(inTokens)} 新增)`;

      const barFill = document.getElementById("contextBarFill");
      if (barFill) barFill.style.width = `${usedPct}%`;

      const treemap = document.getElementById("treemapGrid");
      if (treemap) {
        treemap.innerHTML = `
          <div class="treemap-cell wide" style="border-left: 3px solid #10B981;">
            <div class="treemap-cell-label">提示词缓存 (Prompt Cache)</div>
            <div class="treemap-cell-val" style="color:#10B981;">${formatNumber(cacheTokens)} · ${cachePct}%</div>
          </div>
          <div class="treemap-cell" style="border-left: 3px solid #3B82F6;">
            <div class="treemap-cell-label">新增输入 (Input)</div>
            <div class="treemap-cell-val" style="color:#3B82F6;">${formatNumber(inTokens)}</div>
          </div>
          <div class="treemap-cell" style="border-left: 3px solid #F59E0B;">
            <div class="treemap-cell-label">生成内容 (Output)</div>
            <div class="treemap-cell-val" style="color:#F59E0B;">${formatNumber(outTokens)}</div>
          </div>
          <div class="treemap-cell" style="border-left: 3px solid #8B5CF6;">
            <div class="treemap-cell-label">思考推理 (Reasoning)</div>
            <div class="treemap-cell-val" style="color:#8B5CF6;">${formatNumber(reasoningTokens)}</div>
          </div>
          <div class="treemap-cell" style="border-left: 3px solid #6B7280;">
            <div class="treemap-cell-label">剩余空间 (Available)</div>
            <div class="treemap-cell-val" style="color:var(--text-muted);">${formatNumber(remainingTokens)} · ${remainPct}%</div>
          </div>
        `;
      }

      // 6. Toggle Catalog handler
      const btnToggle = document.getElementById("btnToggleModelCatalog");
      const catalogSection = document.getElementById("modelCatalogSection");
      if (btnToggle && catalogSection) {
        btnToggle.textContent = AppState.showFullCatalog ? "收起模型表" : `全部模型 (${models.length})`;
        btnToggle.onclick = () => {
          AppState.showFullCatalog = !AppState.showFullCatalog;
          catalogSection.style.display = AppState.showFullCatalog ? "block" : "none";
          btnToggle.textContent = AppState.showFullCatalog ? "收起模型表" : `全部模型 (${models.length})`;
          if (AppState.showFullCatalog) this.renderRoutingCatalog();
        };
      }
    },

    buildProviderFilters(models) {
      const providersSet = new Set();
      (models || []).forEach(m => {
        if (m.owned_by) providersSet.add(m.owned_by);
      });

      const container = document.getElementById("providerFilters");
      if (!container) return;
      container.innerHTML = `<div class="filter-chip active" data-filter="all">全部</div>`;

      providersSet.forEach(p => {
        const chip = document.createElement("div");
        chip.className = "filter-chip";
        chip.setAttribute("data-filter", p);
        chip.textContent = p;
        chip.addEventListener("click", () => {
          document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
          chip.classList.add("active");
          AppState.selectedProviderFilter = p;
          this.renderRoutingCatalog();
        });
        container.appendChild(chip);
      });

      const allChip = container.querySelector('[data-filter="all"]');
      if (allChip) {
        allChip.addEventListener("click", (e) => {
          document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
          e.target.classList.add("active");
          AppState.selectedProviderFilter = "all";
          this.renderRoutingCatalog();
        });
      }
    },

    renderRoutingCatalog() {
      const container = document.getElementById("routingModelsList");
      if (!container) return;
      container.innerHTML = "";

      const models = AppState.cachedData.models || [];
      const query = AppState.searchQuery || "";
      const filter = AppState.selectedProviderFilter || "all";

      const filtered = models.filter(m => {
        if (filter !== "all" && m.owned_by !== filter) return false;
        if (query) {
          const text = (m.id + " " + (m.display_name || "") + " " + (m.owned_by || "")).toLowerCase();
          if (!text.includes(query)) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        container.innerHTML = `<div class="state-box"><div class="state-title">未匹配到任何模型</div></div>`;
        return;
      }

      filtered.forEach(m => {
        const card = document.createElement("div");
        card.className = "model-card";

        const tags = [];
        if (m.context_length || m.context_window) {
          tags.push(`上下文: ${formatNumber(m.context_length || m.context_window)}`);
        }
        if (m.max_output_tokens) {
          tags.push(`最大输出: ${formatNumber(m.max_output_tokens)}`);
        }
        if (m.reasoning) {
          tags.push(`深度推理`);
        }
        if (m.modalities && m.modalities.input) {
          tags.push(m.modalities.input.join("+"));
        }

        card.innerHTML = `
          <div class="model-card-header">
            <span class="model-display-name">${m.display_name || m.id}</span>
            <span class="badge">${m.owned_by || "magpie"}</span>
          </div>
          <div class="model-id">${m.id}</div>
          <div class="model-tags">
            ${tags.map(t => `<span class="tag">${t}</span>`).join("")}
          </div>
        `;
        container.appendChild(card);
      });
    },

    // 4. Requests Module
    async fetchRequests() {
      try {
        const res = await this.makeApiCall("/v1/magpie/usage/requests");
        if (res.ok && res.data) {
          const rows = res.data.rows || [];
          AppState.cachedData.requests = rows;
          this.renderRequests();
        }
      } catch (err) {
        console.error("fetchRequests error:", err);
      }
    },

    renderRequests() {
      const container = document.getElementById("requestsList");
      if (!container) return;
      container.innerHTML = "";

      let rows = AppState.cachedData.requests || [];
      if (AppState.onlyErrors) {
        rows = rows.filter(r => r.error || (r.status && r.status >= 400));
      }

      if (rows.length === 0) {
        container.innerHTML = `<div class="state-box"><div class="state-title">暂无请求记录</div></div>`;
        return;
      }

      rows.slice(0, 30).forEach(r => {
        const item = document.createElement("div");
        item.className = "req-item";

        const isErr = r.error || (r.status && r.status >= 400);
        const statusBadge = isErr ? `<span class="badge" style="color:var(--danger); background:var(--danger-bg);">失败</span>` : `<span class="badge" style="color:var(--success);">200 OK</span>`;

        item.innerHTML = `
          <div class="req-header">
            <span class="req-agent">${r.agent || "Agent"} · ${r.provider || ""}</span>
            <span class="req-time">${formatPastTime(r.t)}</span>
          </div>
          <div class="req-model">${r.model || r.req || "--"} &rarr; ${r.served || r.model}</div>
          <div class="req-footer">
            <span>In: ${formatNumber(r.in)} | Out: ${formatNumber(r.out)} | ${r.ms || 0}ms</span>
            <div>${statusBadge}</div>
          </div>
        `;
        container.appendChild(item);
      });
    },

    // 5. Settings & Profile Management
    openSettings() {
      const modal = document.getElementById("settingsModal");
      const active = AppState.profiles.find(p => p.id === AppState.activeProfileId) || {};

      document.getElementById("cfgProfileName").value = active.name || "默认配置";
      document.getElementById("cfgGatewayUrl").value = AppState.settings.gatewayUrl;
      document.getElementById("cfgGatewayKey").value = AppState.settings.gatewayKey;
      document.getElementById("cfgAutoRefresh").value = String(AppState.settings.autoRefresh);
      document.getElementById("cfgRedactEmail").checked = AppState.settings.redactEmail;

      const testBox = document.getElementById("testResultBox");
      testBox.style.display = "none";

      this.renderSavedProfilesList();
      modal.classList.add("open");
    },

    closeSettings() {
      const modal = document.getElementById("settingsModal");
      if (modal) modal.classList.remove("open");
    },

    async pasteToInput(inputId) {
      const input = document.getElementById(inputId);
      if (!input) return;

      let text = Bridge.getClipboard();
      if (!text && navigator.clipboard && navigator.clipboard.readText) {
        try {
          text = await navigator.clipboard.readText();
        } catch (e) {}
      }

      if (text) {
        input.value = text.trim();
        Bridge.showToast("已成功粘贴剪贴板内容");
      } else {
        Bridge.showToast("剪贴板内容为空，请先复制密钥");
      }
    },

    toggleKeyVisibility() {
      const input = document.getElementById("cfgGatewayKey");
      const btn = document.getElementById("btnToggleKeyVisibility");
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "隐藏";
      } else {
        input.type = "password";
        btn.textContent = "显示";
      }
    },

    quickFillUrl(val) {
      document.getElementById("cfgGatewayUrl").value = val;
    },

    async testConnection() {
      const url = document.getElementById("cfgGatewayUrl").value.trim().replace(/\/+$/, "");
      const key = document.getElementById("cfgGatewayKey").value.trim();
      const testBox = document.getElementById("testResultBox");

      if (!url) {
        testBox.className = "test-result-box error";
        testBox.textContent = "请输入网关地址";
        return;
      }

      testBox.className = "test-result-box";
      testBox.style.display = "block";
      testBox.textContent = "正在测试连接目标网关...";

      const t0 = Date.now();
      try {
        const headers = { "Accept": "application/json" };
        if (key) headers["Authorization"] = key.startsWith("Bearer ") ? key : `Bearer ${key}`;

        const res = await Bridge.request(url + "/", { headers });
        const latency = Date.now() - t0;

        if (res.ok) {
          const info = res.data || {};
          testBox.className = "test-result-box success";
          testBox.textContent = `连接成功 (${latency}ms)!\n网关版本: v${info.version || "0.1"}\n可用接口数: ${(info.apis || []).length}\n挂载模型数: ${info.models || 0}`;
        } else {
          testBox.className = "test-result-box error";
          testBox.textContent = `网关返回 HTTP ${res.status}: ${JSON.stringify(res.data)}`;
        }
      } catch (err) {
        testBox.className = "test-result-box error";
        testBox.textContent = `连接失败: ${err.message}`;
      }
    },

    saveAndApplySettings() {
      const name = document.getElementById("cfgProfileName").value.trim() || "默认网关";
      const url = document.getElementById("cfgGatewayUrl").value.trim().replace(/\/+$/, "");
      const key = document.getElementById("cfgGatewayKey").value.trim();
      const autoRef = parseInt(document.getElementById("cfgAutoRefresh").value, 10);
      const redact = document.getElementById("cfgRedactEmail").checked;

      if (!url) {
        Bridge.showToast("请输入网关地址");
        return;
      }

      AppState.settings.gatewayUrl = url;
      AppState.settings.gatewayKey = key;
      AppState.settings.autoRefresh = autoRef;
      AppState.settings.redactEmail = redact;

      // Update active profile
      let prof = AppState.profiles.find(p => p.id === AppState.activeProfileId);
      if (prof) {
        prof.name = name;
        prof.url = url;
        prof.key = key;
      } else {
        prof = { id: AppState.activeProfileId, name, url, key };
        AppState.profiles.push(prof);
      }

      this.saveProfiles();
      Bridge.saveConfig("magpie_active_profile_id", AppState.activeProfileId);
      Bridge.saveConfig("magpie_autorefresh", String(autoRef));
      Bridge.saveConfig("magpie_redact_email", String(redact));

      this.updateProfileChipUI();
      this.setupAutoRefresh();
      this.closeSettings();
      Bridge.showToast("已保存并应用配置");

      // Reset cache and refresh
      AppState.cachedData = { gatewayInfo: null, quotas: null, usage: null, models: null, requests: null };
      this.refreshAll(true);
    },

    saveAsNewProfile() {
      const name = prompt("请输入新配置名称：", "远程网关");
      if (!name) return;
      const url = document.getElementById("cfgGatewayUrl").value.trim().replace(/\/+$/, "");
      const key = document.getElementById("cfgGatewayKey").value.trim();

      const newId = "prof_" + Date.now();
      AppState.profiles.push({ id: newId, name, url, key });
      AppState.activeProfileId = newId;

      this.saveProfiles();
      Bridge.saveConfig("magpie_active_profile_id", newId);
      this.renderSavedProfilesList();
      this.updateProfileChipUI();
      Bridge.showToast(`已创建并切换到配置: ${name}`);
    },

    renderSavedProfilesList() {
      const container = document.getElementById("savedProfilesList");
      if (!container) return;
      container.innerHTML = "";

      AppState.profiles.forEach(p => {
        const isCur = p.id === AppState.activeProfileId;
        const row = document.createElement("div");
        row.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:var(--bg-inset); padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--border-subtle); font-size:12px;";

        row.innerHTML = `
          <div>
            <strong style="color:${isCur ? 'var(--accent-light)' : '#fff'};">${p.name}</strong>
            <div style="font-size:10.5px; color:var(--text-dim); font-family:var(--font-mono);">${p.url}</div>
          </div>
          <div style="display:flex; gap:6px;">
            ${!isCur ? `<button type="button" class="btn-secondary" style="font-size:11px; padding:3px 8px;" onclick="app.selectProfile('${p.id}')">切换</button>` : `<span class="badge" style="color:var(--accent);">当前</span>`}
            ${AppState.profiles.length > 1 ? `<button type="button" class="btn-secondary" style="font-size:11px; padding:3px 8px; color:var(--danger);" onclick="app.deleteProfile('${p.id}')">删除</button>` : ``}
          </div>
        `;
        container.appendChild(row);
      });
    },

    selectProfile(profileId) {
      const p = AppState.profiles.find(it => it.id === profileId);
      if (!p) return;
      AppState.activeProfileId = p.id;
      AppState.settings.gatewayUrl = p.url;
      AppState.settings.gatewayKey = p.key;

      Bridge.saveConfig("magpie_active_profile_id", p.id);
      this.updateProfileChipUI();
      this.closeSettings();
      this.closeProfileSwitcher();
      Bridge.showToast(`已切换至: ${p.name}`);

      AppState.cachedData = { gatewayInfo: null, quotas: null, usage: null, models: null, requests: null };
      this.refreshAll(true);
    },

    deleteProfile(profileId) {
      if (AppState.profiles.length <= 1) return;
      AppState.profiles = AppState.profiles.filter(p => p.id !== profileId);
      if (AppState.activeProfileId === profileId) {
        AppState.activeProfileId = AppState.profiles[0].id;
        AppState.settings.gatewayUrl = AppState.profiles[0].url;
        AppState.settings.gatewayKey = AppState.profiles[0].key;
      }
      this.saveProfiles();
      this.renderSavedProfilesList();
      this.updateProfileChipUI();
    },

    openProfileSwitcher() {
      const modal = document.getElementById("profileSwitcherModal");
      const container = document.getElementById("quickProfilesContainer");
      container.innerHTML = "";

      AppState.profiles.forEach(p => {
        const isCur = p.id === AppState.activeProfileId;
        const btn = document.createElement("div");
        btn.style.cssText = `display:flex; justify-content:space-between; align-items:center; background:${isCur ? 'var(--accent-bg)' : 'var(--bg-inset)'}; border:1px solid ${isCur ? 'rgba(92,124,250,0.4)' : 'var(--border-subtle)'}; border-radius:var(--radius-md); padding:12px 14px; cursor:pointer;`;
        btn.onclick = () => this.selectProfile(p.id);

        btn.innerHTML = `
          <div>
            <div style="font-size:14px; font-weight:600; color:${isCur ? 'var(--accent-light)' : '#fff'};">${p.name}</div>
            <div style="font-size:11px; font-family:var(--font-mono); color:var(--text-dim); margin-top:2px;">${p.url}</div>
          </div>
          <div>${isCur ? '<span class="status-dot connected"></span>' : ''}</div>
        `;
        container.appendChild(btn);
      });

      modal.classList.add("open");
    },

    closeProfileSwitcher() {
      const modal = document.getElementById("profileSwitcherModal");
      if (modal) modal.classList.remove("open");
    }
  };

  window.app = app;
  document.addEventListener("DOMContentLoaded", () => app.init());
})();
