const api = {
  token: localStorage.getItem("dc_token"),
  async request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  },
  get(path) {
    return api.request(path);
  },
  post(path, body = {}) {
    return api.request(path, { method: "POST", body: JSON.stringify(body) });
  },
  patch(path, body = {}) {
    return api.request(path, { method: "PATCH", body: JSON.stringify(body) });
  }
};

const state = {
  view: "dashboard",
  user: null,
  debtors: [],
  plannedCalls: [],
  calls: [],
  routes: [],
  users: [],
  auditLog: [],
  stats: {},
  selectedCallId: null,
  modal: null,
  toast: null
};

const navItems = [
  ["dashboard", "⌂", "催收工作台"],
  ["qa", "✓", "质检系统"],
  ["routes", "⇄", "通话路由"],
  ["accounts", "●", "账号管理"]
];

const qaTagOptions = ["合规", "承诺还款", "已还款", "拒绝沟通", "需复催", "投诉风险", "信息不一致"];

function money(value) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 }).format(value || 0);
}

function shortTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function badgeClass(value) {
  if (["高", "投诉风险"].includes(value)) return "high";
  if (["中", "桥接中", "需复催", "外呼中"].includes(value)) return "mid";
  if (["已还款", "已结清", "已完成", "低", "合规"].includes(value)) return "ok";
  return "info";
}

function setToast(message) {
  state.toast = message;
  render();
  window.setTimeout(() => {
    state.toast = null;
    render();
  }, 2600);
}

async function refresh() {
  const data = await api.get("/api/bootstrap");
  Object.assign(state, data);
  if (!state.selectedCallId && state.calls.length) state.selectedCallId = state.calls[0].id;
  render();
}

async function login(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const data = await api.post("/api/auth/login", {
      username: form.get("username"),
      password: form.get("password")
    });
    api.token = data.token;
    localStorage.setItem("dc_token", data.token);
    state.user = data.user;
    await refresh();
  } catch (error) {
    setToast(error.message);
  }
}

async function logout() {
  try {
    await api.post("/api/auth/logout");
  } catch {}
  api.token = null;
  localStorage.removeItem("dc_token");
  Object.assign(state, {
    user: null,
    debtors: [],
    plannedCalls: [],
    calls: [],
    routes: [],
    users: [],
    auditLog: [],
    stats: {}
  });
  render();
}

function renderLogin() {
  return `
    <main class="login-shell">
      <section class="login-panel">
        <div class="brand-mark">AI</div>
        <h1 class="login-title">AI 催收外呼 Demo</h1>
        <p class="login-copy">登录后可管理债务人、发起预测式外呼、接收 Agora Voice Agent 通话记录并进行人工质检。</p>
        <form onsubmit="login(event)">
          <div class="field">
            <label>用户名</label>
            <input name="username" autocomplete="username" value="admin" required />
          </div>
          <div class="field">
            <label>密码</label>
            <input name="password" type="password" autocomplete="current-password" value="admin123" required />
          </div>
          <button class="btn" type="submit">登录系统</button>
        </form>
        <p class="muted" style="margin-top:18px">默认账号：admin / admin123；质检账号：qa / qa123456</p>
      </section>
      <section class="login-art">
        <h1>从预测式外呼到 AI 坐席桥接，再到通话质检闭环。</h1>
      </section>
    </main>
  `;
}

function shell(content) {
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <div class="avatar">AI</div>
          <div>
            <strong>催收外呼 Demo</strong>
            <span>Agora Voice Agent</span>
          </div>
        </div>
        <nav class="nav">
          ${navItems
            .map(([key, icon, label]) => `
              <button class="${state.view === key ? "active" : ""}" onclick="setView('${key}')">
                <span>${icon}</span><span>${label}</span>
              </button>
            `)
            .join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="user-chip">
            <div class="avatar">${escapeHtml((state.user?.name || "用").slice(0, 1))}</div>
            <div>
              <strong>${escapeHtml(state.user?.name || "")}</strong>
              <div>${escapeHtml(state.user?.role || "")}</div>
            </div>
          </div>
          <button class="logout" onclick="logout()">退出登录</button>
        </div>
      </aside>
      <main class="main">${content}</main>
    </div>
  `;
}

function pageHeader(title, subtitle, actions = "") {
  return `
    <div class="topbar">
      <div>
        <h1>${title}</h1>
        <p>${subtitle}</p>
      </div>
      <div class="actions">${actions}</div>
    </div>
  `;
}

function renderDashboard() {
  return `
    ${pageHeader(
      "催收工作台",
      "查看债务人状态，发起计划外呼，已还款客户会自动从计划列表移除。",
      `<button class="btn secondary" onclick="openDebtorModal()">＋ 新增债务人</button>`
    )}
    <section class="stats-grid">
      <div class="stat"><span>债务人总数</span><strong>${state.stats.debtorCount || 0}</strong></div>
      <div class="stat"><span>计划外呼</span><strong>${state.stats.plannedCount || 0}</strong></div>
      <div class="stat"><span>未还金额</span><strong>${money(state.stats.unpaidAmount || 0)}</strong></div>
      <div class="stat"><span>进行中通话</span><strong>${state.stats.activeCalls || 0}</strong></div>
    </section>
    <div class="content-grid">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">债务人信息</h2>
            <p class="panel-subtitle">基本信息、合同、逾期、催收记录、承诺还款与还款状态</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>客户</th>
                <th>欠款</th>
                <th>合同</th>
                <th>逾期</th>
                <th>承诺还款</th>
                <th>状态</th>
                <th>历史催收</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${state.debtors.map(renderDebtorRow).join("")}
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">计划拨打</h2>
            <p class="panel-subtitle">新增债务人和 AI 判断需复催客户</p>
          </div>
        </div>
        <div class="planned-list">
          ${
            state.plannedCalls.length
              ? state.plannedCalls.map(renderPlannedCard).join("")
              : `<div class="empty">暂无待拨打客户</div>`
          }
        </div>
      </section>
    </div>
  `;
}

function renderDebtorRow(debtor) {
  const lastHistory = debtor.history?.[0];
  const promise = debtor.promise ? `${money(debtor.promise.amount)} / ${debtor.promise.date}` : "暂无";
  return `
    <tr>
      <td>
        <div class="name-cell">
          <strong>${escapeHtml(debtor.name)}</strong>
          <small>${escapeHtml(debtor.phone)}</small>
        </div>
      </td>
      <td><span class="money">${money(debtor.amount)}</span><br><small class="muted">${escapeHtml(debtor.product)}</small></td>
      <td>${escapeHtml(debtor.contractNo)}</td>
      <td>${debtor.overduePeriods} 期<br><small class="muted">${debtor.overdueDays} 天</small></td>
      <td>${escapeHtml(promise)}</td>
      <td>
        <span class="badge ${badgeClass(debtor.repaymentStatus)}">${escapeHtml(debtor.repaymentStatus)}</span>
        <span class="badge ${badgeClass(debtor.collectionStatus)}" style="margin-top:6px">${escapeHtml(debtor.collectionStatus)}</span>
      </td>
      <td>${lastHistory ? `${escapeHtml(lastHistory.summary)}<br><small class="muted">${shortTime(lastHistory.time)}</small>` : "无记录"}</td>
      <td>
        <button class="btn secondary" onclick="openDebtorModal('${debtor.id}')">编辑</button>
      </td>
    </tr>
  `;
}

function renderPlannedCard(item) {
  const routeOptions = state.routes.filter(route => route.enabled);
  return `
    <article class="call-card">
      <div class="call-card-head">
        <div>
          <h3>${escapeHtml(item.name)} <span class="badge ${badgeClass(item.riskLevel)}">${escapeHtml(item.riskLevel)}风险</span></h3>
          <div class="muted">${escapeHtml(item.phone)} · ${escapeHtml(item.contractNo)}</div>
        </div>
        <span class="badge info">第 ${item.attempt} 次拨打</span>
      </div>
      <dl>
        <div><dt>待收金额</dt><dd class="money">${money(item.amount)}</dd></div>
        <div><dt>逾期天数</dt><dd>${item.overdueDays} 天</dd></div>
        <div><dt>入列原因</dt><dd>${escapeHtml(item.reason)}</dd></div>
        <div><dt>外呼路由</dt><dd>${escapeHtml(routeOptions[0]?.name || "无可用路由")}</dd></div>
      </dl>
      <div class="actions">
        <button class="btn" onclick="startCall('${item.debtorId}')" ${routeOptions.length ? "" : "disabled"}>▶ 发起外呼</button>
      </div>
    </article>
  `;
}

function renderQa() {
  const selected = state.calls.find(call => call.id === state.selectedCallId) || state.calls[0];
  return `
    ${pageHeader(
      "质检系统",
      "Agora webhook 回传的录音、转写与摘要会沉淀在这里，质检人员可以人工打标签。",
      `<button class="btn secondary" onclick="mockWebhook()">↧ 模拟 webhook 回传</button>`
    )}
    <div class="split">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">通话记录</h2>
            <p class="panel-subtitle">共 ${state.calls.length} 通</p>
          </div>
        </div>
        <div class="record-list">
          ${
            state.calls.length
              ? state.calls.map(call => renderRecordItem(call, selected?.id)).join("")
              : `<div class="empty">暂无通话记录</div>`
          }
        </div>
      </section>
      ${selected ? renderQaDetail(selected) : ""}
    </div>
  `;
}

function renderRecordItem(call, selectedId) {
  return `
    <button class="record-item ${call.id === selectedId ? "active" : ""}" onclick="selectCall('${call.id}')">
      <strong>${escapeHtml(call.debtorName)} · 第 ${call.attempt} 次</strong>
      <div class="muted">${shortTime(call.startedAt)} · ${escapeHtml(call.status)} · ${call.durationSec || 0}s</div>
      <div style="margin-top:8px">${escapeHtml(call.summary || "暂无摘要")}</div>
    </button>
  `;
}

function renderQaDetail(call) {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">${escapeHtml(call.debtorName)} 的通话质检</h2>
          <p class="panel-subtitle">${escapeHtml(call.debtorPhone)} · ${escapeHtml(call.id)}</p>
        </div>
        <span class="badge ${badgeClass(call.status)}">${escapeHtml(call.status)}</span>
      </div>
      <div class="detail-box">
        <strong>录音地址</strong>
        <p class="muted" style="overflow-wrap:anywhere">${escapeHtml(call.recordingUrl || "等待回传")}</p>
        <strong>通话摘要</strong>
        <p>${escapeHtml(call.summary || "暂无摘要")}</p>
      </div>
      <div class="transcript">
        ${(call.transcript || []).map(line => `
          <div class="line">
            <div class="speaker">${escapeHtml(line.speaker)}</div>
            <div>${escapeHtml(line.text)}</div>
          </div>
        `).join("") || `<div class="empty">暂无转写</div>`}
      </div>
      <div class="qa-tags">
        ${qaTagOptions.map(tag => `
          <button class="tag-option ${(call.qaTags || []).includes(tag) ? "active" : ""}" onclick="toggleQaTag('${call.id}', '${tag}')">${tag}</button>
        `).join("")}
      </div>
      <div class="detail-box">
        <form onsubmit="saveQaNote(event, '${call.id}')">
          <div class="field">
            <label>质检备注</label>
            <textarea name="qaNote">${escapeHtml(call.qaNote || "")}</textarea>
          </div>
          <button class="btn" type="submit">保存质检</button>
        </form>
      </div>
    </section>
  `;
}

function renderRoutes() {
  return `
    ${pageHeader(
      "通话路由配置",
      "配置手机外呼 SIP Trunk、Agora SIP 地址，以及预测式外呼的桥接绑定关系。",
      `<button class="btn secondary" onclick="openRouteModal()">＋ 新增路由</button>`
    )}
    <section class="cards-grid">
      ${state.routes.map(route => `
        <article class="route-card">
          <div class="call-card-head">
            <h3>${escapeHtml(route.name)}</h3>
            <span class="badge ${route.enabled ? "ok" : ""}">${route.enabled ? "启用" : "停用"}</span>
          </div>
          <div class="route-flow">
            <div class="route-node"><small>客户手机</small><strong>Debtor</strong></div>
            <span class="muted">→</span>
            <div class="route-node"><small>SIP Trunk</small><strong>${escapeHtml(route.mobileTrunk)}</strong></div>
            <span class="muted">→</span>
            <div class="route-node"><small>Agora SIP</small><strong>${escapeHtml(route.agoraSip)}</strong></div>
          </div>
          <p class="muted">${escapeHtml(route.description || "无备注")}</p>
          <div class="actions">
            <button class="btn secondary" onclick="openRouteModal('${route.id}')">编辑</button>
            <button class="btn secondary" onclick="toggleRoute('${route.id}', ${route.enabled ? "false" : "true"})">${route.enabled ? "停用" : "启用"}</button>
          </div>
        </article>
      `).join("")}
    </section>
  `;
}

function renderAccounts() {
  return `
    ${pageHeader(
      "账号管理",
      "新增账号、停用账号、重置密码，并保留基础操作审计。",
      `<button class="btn secondary" onclick="openUserModal()">＋ 新增账号</button>`
    )}
    <div class="content-grid">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">账号列表</h2>
            <p class="panel-subtitle">管理员、催收员、质检角色</p>
          </div>
        </div>
        <div class="planned-list">
          ${state.users.map(user => `
            <article class="user-card">
              <div class="call-card-head">
                <div>
                  <h3>${escapeHtml(user.name)}</h3>
                  <div class="muted">${escapeHtml(user.username)} · ${escapeHtml(user.role)}</div>
                </div>
                <span class="badge ${user.active ? "ok" : "high"}">${user.active ? "启用" : "停用"}</span>
              </div>
              <div class="muted">创建：${shortTime(user.createdAt)} · 最近登录：${shortTime(user.lastLoginAt)}</div>
              <div class="actions">
                <button class="btn secondary" onclick="openResetPassword('${user.id}')">重置密码</button>
                <button class="btn secondary" onclick="toggleUser('${user.id}', ${user.active ? "false" : "true"})">${user.active ? "停用" : "启用"}</button>
              </div>
            </article>
          `).join("")}
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">操作审计</h2>
            <p class="panel-subtitle">最近 30 条</p>
          </div>
        </div>
        <div class="record-list">
          ${state.auditLog.map(log => `
            <div class="record-item">
              <strong>${escapeHtml(log.action)}</strong>
              <div>${escapeHtml(log.detail)}</div>
              <div class="muted">${escapeHtml(log.username)} · ${shortTime(log.time)}</div>
            </div>
          `).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderModal() {
  if (!state.modal) return "";
  return `
    <div class="modal-backdrop" onclick="closeModal(event)">
      <section class="modal" onclick="event.stopPropagation()">
        ${state.modal}
      </section>
    </div>
  `;
}

function render() {
  const app = document.getElementById("app");
  if (!api.token || !state.user) {
    app.innerHTML = renderLogin() + (state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : "");
    return;
  }
  const views = {
    dashboard: renderDashboard,
    qa: renderQa,
    routes: renderRoutes,
    accounts: renderAccounts
  };
  app.innerHTML = shell(views[state.view]()) + renderModal() + (state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : "");
}

function setView(view) {
  state.view = view;
  render();
}

function selectCall(callId) {
  state.selectedCallId = callId;
  render();
}

async function startCall(debtorId) {
  try {
    const route = state.routes.find(item => item.enabled);
    await api.post(`/api/calls/${debtorId}/start`, { routeId: route?.id });
    await refresh();
    setToast("预测式外呼任务已发起");
  } catch (error) {
    setToast(error.message);
  }
}

async function mockComplete(callId) {
  await api.post(`/api/calls/${callId}/complete-mock`, {});
  await refresh();
}

async function mockWebhook() {
  const debtor = state.debtors.find(item => item.repaymentStatus !== "已还款") || state.debtors[0];
  try {
    await api.post("/api/webhooks/agora/calls", {
      debtorId: debtor?.id,
      phone: debtor?.phone,
      status: "已完成",
      durationSec: 216,
      recordingUrl: `https://example.com/recordings/webhook-${Date.now()}.wav`,
      transcript: [
        { speaker: "AI", text: "您好，这里是还款提醒服务。" },
        { speaker: "客户", text: "我现在还不能一次性还清。" },
        { speaker: "AI", text: "可以先确认一个部分还款日期吗？" },
        { speaker: "客户", text: "三天后我先还一部分。" }
      ],
      summary: "客户表示三天后部分还款，仍需复催确认。",
      promiseAmount: 1000,
      promiseDate: "2026-10-14",
      promiseNote: "客户口头承诺部分还款",
      needRecall: true
    });
    await refresh();
    state.view = "qa";
    setToast("已写入一条模拟 webhook 通话");
  } catch (error) {
    setToast(error.message);
  }
}

function openDebtorModal(debtorId) {
  const debtor = state.debtors.find(item => item.id === debtorId) || {};
  state.modal = `
    <form onsubmit="saveDebtor(event, '${debtorId || ""}')">
      <div class="modal-header">
        <h2 class="panel-title">${debtorId ? "编辑债务人" : "新增债务人"}</h2>
        <button class="btn icon secondary" type="button" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body form-grid">
        ${field("姓名", "name", debtor.name || "", true)}
        ${field("电话", "phone", debtor.phone || "", true)}
        ${field("欠款金额", "amount", debtor.amount || "", true, "number")}
        ${field("合同编号", "contractNo", debtor.contractNo || "", true)}
        ${field("产品", "product", debtor.product || "消费分期")}
        ${field("逾期期数", "overduePeriods", debtor.overduePeriods || 1, true, "number")}
        ${field("逾期天数", "overdueDays", debtor.overdueDays || 1, true, "number")}
        ${selectField("风险等级", "riskLevel", debtor.riskLevel || "中", ["低", "中", "高"])}
        ${selectField("还款状态", "repaymentStatus", debtor.repaymentStatus || "未还款", ["未还款", "已还款"])}
        ${selectField("催收状态", "collectionStatus", debtor.collectionStatus || "待首催", ["待首催", "外呼中", "已催收", "需复催", "已结清"])}
      </div>
      <div class="modal-footer">
        <button class="btn secondary" type="button" onclick="closeModal()">取消</button>
        <button class="btn" type="submit">保存</button>
      </div>
    </form>
  `;
  render();
}

function openRouteModal(routeId) {
  const route = state.routes.find(item => item.id === routeId) || {
    agoraSip: "sip:gptest@cn-north-1-sbc.ai.agora.io:5060;transport=tcp",
    enabled: true
  };
  state.modal = `
    <form onsubmit="saveRoute(event, '${routeId || ""}')">
      <div class="modal-header">
        <h2 class="panel-title">${routeId ? "编辑通话路由" : "新增通话路由"}</h2>
        <button class="btn icon secondary" type="button" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body">
        ${field("路由名称", "name", route.name || "", true)}
        ${field("手机外呼 SIP Trunk", "mobileTrunk", route.mobileTrunk || "", true)}
        ${field("Agora SIP 地址", "agoraSip", route.agoraSip || "", true)}
        <div class="field">
          <label>备注</label>
          <textarea name="description">${escapeHtml(route.description || "")}</textarea>
        </div>
        ${selectField("状态", "enabled", String(route.enabled !== false), [["true", "启用"], ["false", "停用"]])}
      </div>
      <div class="modal-footer">
        <button class="btn secondary" type="button" onclick="closeModal()">取消</button>
        <button class="btn" type="submit">保存</button>
      </div>
    </form>
  `;
  render();
}

function openUserModal() {
  state.modal = `
    <form onsubmit="saveUser(event)">
      <div class="modal-header">
        <h2 class="panel-title">新增账号</h2>
        <button class="btn icon secondary" type="button" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body form-grid">
        ${field("姓名", "name", "", true)}
        ${field("用户名", "username", "", true)}
        ${selectField("角色", "role", "催收员", ["管理员", "催收员", "质检"])}
        ${field("初始密码", "password", "", true, "password")}
      </div>
      <div class="modal-footer">
        <button class="btn secondary" type="button" onclick="closeModal()">取消</button>
        <button class="btn" type="submit">创建账号</button>
      </div>
    </form>
  `;
  render();
}

function openResetPassword(userId) {
  const user = state.users.find(item => item.id === userId);
  state.modal = `
    <form onsubmit="resetPassword(event, '${userId}')">
      <div class="modal-header">
        <h2 class="panel-title">重置密码：${escapeHtml(user?.username || "")}</h2>
        <button class="btn icon secondary" type="button" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body">
        ${field("新密码", "password", "", true, "password")}
      </div>
      <div class="modal-footer">
        <button class="btn secondary" type="button" onclick="closeModal()">取消</button>
        <button class="btn" type="submit">重置</button>
      </div>
    </form>
  `;
  render();
}

function field(label, name, value, required = false, type = "text") {
  return `
    <div class="field">
      <label>${label}</label>
      <input name="${name}" type="${type}" value="${escapeHtml(value)}" ${required ? "required" : ""} />
    </div>
  `;
}

function selectField(label, name, value, options) {
  const normalized = options.map(option => Array.isArray(option) ? option : [option, option]);
  return `
    <div class="field">
      <label>${label}</label>
      <select name="${name}">
        ${normalized.map(([optionValue, optionLabel]) => `
          <option value="${escapeHtml(optionValue)}" ${String(value) === String(optionValue) ? "selected" : ""}>${escapeHtml(optionLabel)}</option>
        `).join("")}
      </select>
    </div>
  `;
}

function closeModal(event) {
  if (event && event.target !== event.currentTarget) return;
  state.modal = null;
  render();
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function saveDebtor(event, debtorId) {
  event.preventDefault();
  const body = formObject(event.currentTarget);
  try {
    if (debtorId) await api.patch(`/api/debtors/${debtorId}`, body);
    else await api.post("/api/debtors", body);
    state.modal = null;
    await refresh();
    setToast("债务人信息已保存");
  } catch (error) {
    setToast(error.message);
  }
}

async function saveRoute(event, routeId) {
  event.preventDefault();
  const body = formObject(event.currentTarget);
  body.enabled = body.enabled === "true";
  try {
    if (routeId) await api.patch(`/api/routes/${routeId}`, body);
    else await api.post("/api/routes", body);
    state.modal = null;
    await refresh();
    setToast("通话路由已保存");
  } catch (error) {
    setToast(error.message);
  }
}

async function toggleRoute(routeId, enabled) {
  await api.patch(`/api/routes/${routeId}`, { enabled });
  await refresh();
}

async function saveUser(event) {
  event.preventDefault();
  try {
    await api.post("/api/users", formObject(event.currentTarget));
    state.modal = null;
    await refresh();
    setToast("账号已创建");
  } catch (error) {
    setToast(error.message);
  }
}

async function toggleUser(userId, active) {
  try {
    await api.patch(`/api/users/${userId}`, { active });
    await refresh();
  } catch (error) {
    setToast(error.message);
  }
}

async function resetPassword(event, userId) {
  event.preventDefault();
  try {
    await api.patch(`/api/users/${userId}/password`, formObject(event.currentTarget));
    state.modal = null;
    await refresh();
    setToast("密码已重置");
  } catch (error) {
    setToast(error.message);
  }
}

async function toggleQaTag(callId, tag) {
  const call = state.calls.find(item => item.id === callId);
  const set = new Set(call.qaTags || []);
  if (set.has(tag)) set.delete(tag);
  else set.add(tag);
  call.qaTags = [...set];
  render();
  try {
    await api.patch(`/api/calls/${callId}/qa`, { qaTags: call.qaTags, qaNote: call.qaNote || "" });
    await refresh();
  } catch (error) {
    setToast(error.message);
  }
}

async function saveQaNote(event, callId) {
  event.preventDefault();
  const call = state.calls.find(item => item.id === callId);
  const body = formObject(event.currentTarget);
  try {
    await api.patch(`/api/calls/${callId}/qa`, { qaTags: call.qaTags || [], qaNote: body.qaNote || "" });
    await refresh();
    setToast("质检结果已保存");
  } catch (error) {
    setToast(error.message);
  }
}

window.login = login;
window.logout = logout;
window.setView = setView;
window.openDebtorModal = openDebtorModal;
window.openRouteModal = openRouteModal;
window.openUserModal = openUserModal;
window.openResetPassword = openResetPassword;
window.closeModal = closeModal;
window.saveDebtor = saveDebtor;
window.saveRoute = saveRoute;
window.saveUser = saveUser;
window.resetPassword = resetPassword;
window.toggleUser = toggleUser;
window.toggleRoute = toggleRoute;
window.startCall = startCall;
window.selectCall = selectCall;
window.toggleQaTag = toggleQaTag;
window.saveQaNote = saveQaNote;
window.mockWebhook = mockWebhook;
window.mockComplete = mockComplete;

if (api.token) {
  refresh().catch(() => {
    api.token = null;
    localStorage.removeItem("dc_token");
    render();
  });
} else {
  render();
}
