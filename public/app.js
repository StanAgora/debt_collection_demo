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
  telephony: {},
  monitor: null,
  monitorLoading: false,
  monitorError: null,
  selectedRouteId: "route_default",
  selectedCallId: null,
  historyDebtorId: null,
  modal: null,
  agoraInputPreview: null,
  toast: null
};

const navItems = [
  ["dashboard", "⌂", "催收工作台"],
  ["planned", "▶", "计划拨打"],
  ["qa", "✓", "质检系统"],
  ["routes", "⇄", "通话路由"],
  ["monitor", "◉", "服务监控"],
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
    monitor: null,
    monitorError: null,
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
        <div class="login-support" aria-label="语音 AI 技术支持：Agora">
          <span>Powered by</span>
          <img src="/assets/agora.png" alt="Agora" width="112" height="53" />
        </div>
      </section>
      <section class="login-art">
        <h1>按合规话术自动完成全账龄的外呼，记得每位客户之前的沟通情况，也能和人工坐席协同处理复杂的案子。<br />策略自动跑，质检全闭环，模型自迭代——每一通，都让催收向前进一步。</h1>
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
        <div class="sidebar-support" aria-label="语音 AI 技术支持：Agora">
          <span>Powered by</span>
          <img src="/assets/agora.png" alt="Agora" width="112" height="53" />
        </div>
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

function activeCall(call) { return call.provider === "freeswitch" && !call.endedAt; }

function selectedRoute() {
  return state.routes.find(route => route.id === state.selectedRouteId && route.enabled) || state.routes.find(route => route.enabled);
}

function renderCallControls() {
  const route = selectedRoute();
  return `<section class="panel call-controls">
    <div class="panel-header"><div><h2 class="panel-title">软电话呼叫</h2>
      <p class="panel-subtitle">先呼叫分机，接听后连接 Agora Voice Agent</p></div>
      <span class="badge ${state.telephony.connected ? "ok" : "high"}">${state.telephony.connected ? "FreeSWITCH 已连接" : "FreeSWITCH 未就绪"}</span></div>
    <div class="detail-box"><label>本次使用的路由 <select onchange="state.selectedRouteId=this.value;render()">
      ${state.routes.filter(item => item.enabled).map(item => `<option value="${escapeHtml(item.id)}" ${route?.id === item.id ? "selected" : ""}>${escapeHtml(item.name)} · 分机 ${escapeHtml(item.extension)}</option>`).join("")}
    </select></label>
    ${state.telephony.connected ? "" : `<p class="muted">${escapeHtml(state.telephony.error || "连接中")}</p>`}</div>
    ${state.calls.filter(activeCall).map(call => `<div class="detail-box"><strong>${escapeHtml(call.debtorName)} · 分机 ${escapeHtml(call.extension)}</strong>
      <span class="badge info">${escapeHtml(call.status)}</span>
      <button class="btn secondary" onclick="hangupCall('${call.id}')">挂断</button></div>`).join("")}
  </section>`;
}

function renderDashboard() {
  return `
    ${pageHeader(
      "催收工作台",
      "维护债务人资料、查看催收状态和通话历史；发起通话请进入计划拨打。",
      `<button class="btn secondary" onclick="openDebtorModal()">＋ 新增债务人</button>`
    )}
    <section class="stats-grid">
      <div class="stat"><span>债务人总数</span><strong>${state.stats.debtorCount || 0}</strong></div>
      <div class="stat"><span>计划外呼</span><strong>${state.stats.plannedCount || 0}</strong></div>
      <div class="stat"><span>未还金额</span><strong>${money(state.stats.unpaidAmount || 0)}</strong></div>
      <div class="stat"><span>进行中通话</span><strong>${state.stats.activeCalls || 0}</strong></div>
    </section>
    <section class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">债务人信息</h2>
            <p class="panel-subtitle">客户资料、欠款来源、当前逾期、承诺与投诉历史</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="debtor-table">
            <thead>
              <tr>
                <th>客户</th>
                <th>欠款 APP / 平台 / 渠道</th>
                <th>当前逾期</th>
                <th>承诺与投诉</th>
                <th>通话历史总结</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${state.debtors.map(renderDebtorRow).join("")}
            </tbody>
          </table>
        </div>
      </section>
  `;
}

function renderPlannedCalls() {
  return `
    ${pageHeader("计划拨打", "新增债务人及需复催客户进入待拨列表，已还款客户自动移除。")}
    ${renderCallControls()}
    <section class="panel">
      <div class="panel-header"><div>
        <h2 class="panel-title">待拨打客户</h2>
        <p class="panel-subtitle">共 ${state.plannedCalls.length} 位客户 · 选择路由后点击呼叫分机</p>
      </div></div>
      ${state.plannedCalls.length
        ? `<div class="planned-list planned-page-list">${state.plannedCalls.map(renderPlannedCard).join("")}</div>`
        : `<div class="empty">暂无待拨打客户</div>`}
    </section>
  `;
}

function factLabel(value) {
  return value === true ? "是" : value === false ? "否" : "未知";
}

function debtorCalls(debtor) {
  const calls = state.calls.filter(call => call.debtorId === debtor.id).map(call => ({ ...call, hasDetail: true }));
  const known = new Set(calls.map(call => call.id));
  // Include imported history without a full call record, but don't duplicate
  // the history entry written alongside each FreeSWITCH call.
  for (const history of debtor.history || []) {
    const id = history.callId || history.id;
    if (known.has(id)) continue;
    known.add(id);
    calls.push({ id, debtorId: debtor.id, startedAt: history.time, status: history.result,
      summary: history.summary, durationSec: null, nextAction: history.nextAction, hasDetail: false });
  }
  return calls.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
}

function debtorSummary(debtor) {
  if (debtor.callHistorySummary) return debtor.callHistorySummary;
  const latest = debtorCalls(debtor).find(call => call.summary);
  return latest ? `最近一次：${latest.summary}` : "暂无通话记录";
}

function renderDebtorRow(debtor) {
  const calls = debtorCalls(debtor);
  return `
    <tr>
      <td><div class="name-cell">
        <strong>${escapeHtml(debtor.name)}</strong>
        <small>${escapeHtml(debtor.phone)}</small>
        <small>性别：${escapeHtml(debtor.gender || "未知")}</small>
      </div></td>
      <td><strong>${escapeHtml(debtor.debtApp || "未填写 APP")}</strong>
        <div class="muted">平台：${escapeHtml(debtor.platform || "未填写")}</div>
        <div class="muted">渠道：${escapeHtml(debtor.acquisitionChannel || "未填写")}</div>
        ${debtor.demoSourceFields?.length ? '<small class="muted">含演示来源资料</small><br>' : ''}
        <small class="muted">${escapeHtml(debtor.product || "")}</small></td>
      <td><span class="money">${money(debtor.amount)}</span>
        <div>${escapeHtml(debtor.overduePeriods)} 期 · ${escapeHtml(debtor.overdueDays)} 天</div>
        <small class="muted">合同：${escapeHtml(debtor.contractNo || "未填写")}</small></td>
      <td><div>有过承诺：<span class="badge ${debtor.hasPromise === true ? "ok" : ""}">${factLabel(debtor.hasPromise)}</span></div>
        ${debtor.promise ? `<small class="muted">${money(debtor.promise.amount)} / ${escapeHtml(debtor.promise.date)}</small>` : ""}
        <div class="debtor-flag">投诉历史：<span class="badge ${debtor.hasComplaintHistory === true ? "high" : ""}">${factLabel(debtor.hasComplaintHistory)}</span></div></td>
      <td class="debtor-summary">${escapeHtml(debtorSummary(debtor))}</td>
      <td><span class="badge ${badgeClass(debtor.repaymentStatus)}">${escapeHtml(debtor.repaymentStatus)}</span>
        <div class="debtor-flag"><span class="badge ${badgeClass(debtor.collectionStatus)}">${escapeHtml(debtor.collectionStatus)}</span></div></td>
      <td><div class="debtor-actions">
        <button class="btn secondary" onclick="openDebtorHistory('${debtor.id}')">通话历史（${calls.length}）</button>
        <button class="btn secondary" onclick="openDebtorModal('${debtor.id}')">编辑</button>
      </div></td>
    </tr>
  `;
}

function historyTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function renderDebtorHistory() {
  const debtor = state.debtors.find(item => item.id === state.historyDebtorId);
  if (!debtor) return `${pageHeader("通话历史", "未找到该债务人", `<button class="btn secondary" onclick="setView('dashboard')">返回工作台</button>`)}`;
  const calls = debtorCalls(debtor);
  return `${pageHeader(`${escapeHtml(debtor.name)}的通话历史`,
    `${escapeHtml(debtor.phone)} · ${escapeHtml(debtor.debtApp || "欠款 APP 未填写")} · 共 ${calls.length} 条记录，按时间倒序`,
    `<button class="btn secondary" onclick="setView('dashboard')">返回工作台</button>`)}
    <section class="panel history-overview"><div class="detail-box"><strong>通话历史总结</strong>
      <p class="preserve-lines">${escapeHtml(debtorSummary(debtor))}</p></div></section>
    <div class="debtor-history-list">${calls.map(call => `
      <article class="panel history-entry">
        <div class="panel-header"><div><h2 class="panel-title">${historyTime(call.startedAt)}</h2>
          <p class="panel-subtitle">${call.attempt ? `第 ${escapeHtml(call.attempt)} 次拨打 · ` : ""}${call.durationSec == null ? "时长未记录" : `${escapeHtml(call.durationSec)} 秒`}${call.extension ? ` · 分机 ${escapeHtml(call.extension)}` : ""}</p></div>
          <span class="badge ${badgeClass(call.status)}">${escapeHtml(call.status || "状态未记录")}</span></div>
        <div class="detail-box"><p class="preserve-lines">${escapeHtml(call.summary || "暂无通话摘要")}</p>
          ${call.endedAt ? `<p class="muted">结束：${historyTime(call.endedAt)}</p>` : ""}
          ${call.hangupCause ? `<p class="muted">结束原因：${escapeHtml(call.hangupCause)}</p>` : ""}
          ${call.nextAction ? `<p class="muted">下一步：${escapeHtml(call.nextAction)}</p>` : ""}
          ${call.hasDetail ? `<button class="btn secondary" onclick="openHistoryCall('${call.id}')">查看录音、转写与质检</button>` : `<p class="muted">历史导入记录，暂无完整通话详情。</p>`}
        </div>
      </article>`).join("") || `<section class="panel"><div class="empty">该债务人暂无通话记录</div></section>`}</div>`;
}

function openDebtorHistory(debtorId) {
  state.historyDebtorId = debtorId;
  setView("debtorHistory");
}

function openHistoryCall(callId) {
  state.selectedCallId = callId;
  setView("qa");
}

function renderPlannedCard(item) {
  const routeOptions = state.routes.filter(route => route.enabled);
  return `
    <article class="call-card planned-customer-card" tabindex="0" aria-label="查看${escapeHtml(item.name)}的 Agora 入参" onclick="openAgoraInput('${item.debtorId}')" onkeydown="plannedCardKeydown(event, '${item.debtorId}')">
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
        <div><dt>外呼路由</dt><dd>${escapeHtml(selectedRoute()?.name || "无可用路由")}</dd></div>
      </dl>
      <div class="actions" onclick="event.stopPropagation()">
        <button class="btn secondary" onclick="openAgoraInput('${item.debtorId}')">查看 Agora 入参</button>
        <button class="btn" onclick="startCall('${item.debtorId}')" ${routeOptions.length && state.telephony.connected && !state.calls.some(call => activeCall(call) && (call.extension === selectedRoute()?.extension || call.debtorId === item.debtorId)) ? "" : "disabled"}>▶ 呼叫分机</button>
      </div>
    </article>
  `;
}

function renderAgoraInputPreview(preview) {
  const variables = preview.payload.agent_properties.llm.template_variables;
  return `<div class="agora-input">
    <div class="modal-header"><div><h2 class="panel-title">${escapeHtml(preview.debtorName)} · Agora 入参</h2>
      <p class="panel-subtitle">生成时间：${historyTime(preview.generatedAt)}</p></div>
      <button class="btn icon secondary" type="button" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="monitor-notice"><strong>入参预览 · 尚未发送给 Agora</strong><br>
        发起呼叫时按最新资料保存快照并生成 16 位 task ID。分机接听后，发往 Agora 的 SIP INVITE 将携带 X-Switch-Id 和完整 JSON 的 UTF-8 Base64（X-Customer-Str）。</div>
      ${preview.sipSize ? `<p class="muted">Base64：${preview.sipSize.customerHeaderBytes} 字节 / 上限 ${preview.sipSize.maxCustomerHeaderBytes} 字节${preview.sipSize.withinLimit ? '' : ' · 已超限，需精简历史总结后才能拨号'}。超限不会截断参数。</p>` : ''}
      <p class="muted">已生成 ${Object.keys(variables).length} 个字段 · 汇总 ${preview.historyCount} 条历史通话。未确认的数据不填入 JSON，四个策略字段待后续接入。</p>
      <pre class="payload-preview" tabindex="0" aria-label="Agora 入参 JSON">${escapeHtml(JSON.stringify(preview.payload, null, 2))}</pre>
      <details class="input-details"><summary>已展示字段及来源</summary>
        <div class="table-wrap"><table class="input-fields-table"><thead><tr><th>参数</th><th>来源</th></tr></thead><tbody>
          ${Object.entries(preview.sources).map(([key, source]) => `<tr><td><code>${escapeHtml(key)}</code></td><td>${escapeHtml(source)}</td></tr>`).join("")}
        </tbody></table></div></details>
      <details class="input-details"><summary>暂未填入的参数（${preview.omitted.length}）</summary>
        <div class="table-wrap"><table class="input-fields-table"><thead><tr><th>参数</th><th>原因</th></tr></thead><tbody>
          ${preview.omitted.map(item => `<tr><td><code>${escapeHtml(item.field)}</code></td><td>${escapeHtml(item.reason)}</td></tr>`).join("")}
        </tbody></table></div></details>
    </div>
    <div class="modal-footer"><button class="btn secondary" onclick="openAgoraInput('${preview.debtorId}')">更新预览</button><button class="btn" onclick="closeModal()">关闭</button></div>
  </div>`;
}

async function openAgoraInput(debtorId) {
  const request = { debtorId };
  state.agoraInputPreview = request;
  state.modal = `<div class="modal-header"><h2 class="panel-title">Agora 入参</h2><button class="btn icon secondary" onclick="closeModal()">×</button></div><div class="empty">正在生成入参预览…</div>`;
  render();
  try {
    const preview = await api.get(`/api/debtors/${debtorId}/agora-input`);
    if (state.agoraInputPreview !== request || !state.modal) return;
    state.modal = renderAgoraInputPreview(preview);
  } catch (error) {
    if (state.agoraInputPreview !== request || !state.modal) return;
    state.modal = `<div class="modal-header"><h2 class="panel-title">Agora 入参</h2><button class="btn icon secondary" onclick="closeModal()">×</button></div><div class="empty">${escapeHtml(error.message)}</div>`;
  }
  render();
}

function plannedCardKeydown(event, debtorId) {
  if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    openAgoraInput(debtorId);
  }
}

function renderQa() {
  const selected = state.calls.find(call => call.id === state.selectedCallId) || state.calls[0];
  return `
    ${pageHeader(
      "质检系统",
      "Agora webhook 回传的录音、转写与摘要会沉淀在这里，质检人员可以人工打标签。",
      state.historyDebtorId ? `<button class="btn secondary" onclick="setView('debtorHistory')">返回债务人通话历史</button>` : ""
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
      <div class="muted">${shortTime(call.startedAt)} · ${escapeHtml(call.status)} · ${call.durationSec == null ? "时长待确认" : `${call.durationSec}s`}</div>
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
      ${call.agoraInput ? `<div class="detail-box"><details><summary>发起时 Agora 入参快照</summary>
        <p class="muted">${historyTime(call.agoraInput.generatedAt)} · ${escapeHtml(({ not_sent: '旧记录：未通过 SIP 发送参数', prepared: 'Header 已准备，尚未观察到 Agora 通道创建', attempted: '已创建 Agora 通道，正在尝试呼叫', bridged: '已与 Agora 桥接', callback_received: '已按 task ID 匹配回调' })[call.agoraInput.deliveryStatus] || '传递状态未确认')}。桥接或回调不代表已确认所有参数均被 Agent 采用。</p>
        ${call.taskId ? `<p>Task ID（X-Switch-Id）：<code>${escapeHtml(call.taskId)}</code></p>` : ''}
        ${call.agoraInput.sip ? `<p class="muted">X-Customer-Str：${call.agoraInput.sip.customerHeaderBytes} 字节（UTF-8 JSON：${call.agoraInput.sip.jsonBytes} 字节）</p>
          <details><summary>实际配置的 SIP Header</summary><pre class="payload-preview">${escapeHtml(JSON.stringify(call.agoraInput.sip.headers, null, 2))}</pre></details>` : ''}
        <pre class="payload-preview">${escapeHtml(JSON.stringify(call.agoraInput.payload, null, 2))}</pre></details></div>` : ""}
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
      "配置软电话分机和 Agora SIP 地址；分机接听后才连接 AI。",
      `<button class="btn secondary" onclick="openRouteModal()">＋ 新增路由</button>`
    )}
    <p class="detail-box">FreeSWITCH：${state.telephony.connected ? "已连接" : "未就绪"} · SIP 域：${escapeHtml(state.telephony.domain || "demo.local")}<br>${escapeHtml(state.telephony.error || "请将软电话注册到 FreeSWITCH 后发起通话。")}</p>
    <section class="cards-grid">
      ${state.routes.map(route => `
        <article class="route-card">
          <div class="call-card-head">
            <h3>${escapeHtml(route.name)}</h3>
            <span class="badge ${route.enabled ? "ok" : ""}">${route.enabled ? "启用" : "停用"}</span>
          </div>
          <div class="route-flow">
            <div class="route-node"><small>软电话分机</small><strong>${escapeHtml(route.extension)}</strong></div>
            <span class="muted">→</span>
            <div class="route-node"><small>接听后桥接</small><strong>FreeSWITCH</strong></div>
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

function monitorBadge(item, stale = false) {
  const classes = { ok: "ok", error: "high", warning: "mid", info: "info", unknown: "" };
  return `<span class="badge ${stale ? "" : classes[item.status] || ""}">${stale ? "状态待确认" : escapeHtml(item.label)}</span>`;
}

function uptimeLabel(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${days ? `${days} 天 ` : ""}${hours} 小时 ${minutes} 分钟`;
}

function renderMonitor() {
  const data = state.monitor;
  const stale = Boolean(state.monitorError || (data && Date.now() - Date.parse(data.checkedAt) > 25000));
  const header = pageHeader("服务监控", "查看后台服务、SIP 分机与 Agora 接入状态，每 10 秒更新一次。",
    `<button class="btn secondary" onclick="refreshMonitor()" ${state.monitorLoading ? "disabled" : ""}>${state.monitorLoading ? "检测中…" : "刷新状态"}</button>`);
  const error = state.monitorError ? `<div class="monitor-notice" role="alert">监控请求失败：${escapeHtml(state.monitorError)}。${data ? "以下为上次检测数据，当前状态待确认。" : "请检查 Node.js 服务和网络连接。"}</div>` : "";
  if (!data) return `${header}${error}<section class="panel"><div class="empty">${state.monitorLoading ? "正在检查服务和分机注册状态…" : "暂无监控数据，请刷新状态。"}</div></section>`;
  return `${header}${error}
    <p class="muted">检测时间：${historyTime(data.checkedAt)}${stale ? " · 数据已失效，请重新检测" : ""}</p>
    <section class="stats-grid">
      <div class="stat"><span>后台服务正常 / 总数</span><strong>${stale ? "—" : data.services.filter(item => item.status === "ok").length} / ${data.services.length}</strong></div>
      <div class="stat"><span>SIP 已注册 / 分机数</span><strong>${stale ? "—" : data.extensions.filter(item => item.status === "ok").length} / ${data.extensions.length}</strong></div>
      <div class="stat"><span>Agora 已桥接会话</span><strong>${stale ? "—" : data.agora.reduce((sum, item) => sum + item.activeCount, 0)}</strong></div>
      <div class="stat"><span>Agent（演示状态）</span><strong>${data.agents.length}</strong></div>
    </section>
    <h2 class="monitor-heading">后台服务</h2>
    <div class="monitor-grid">${data.services.map(service => `
      <section class="panel monitor-card"><div class="monitor-card-head"><h3>${escapeHtml(service.name)}</h3>${monitorBadge(service, stale)}</div>
        <p>${escapeHtml(service.detail)}</p>
        ${service.uptimeSec !== undefined ? `<p class="muted">运行时长：${uptimeLabel(service.uptimeSec)} · 内存：${service.memoryMB} MB</p>` : ""}
        ${service.version ? `<p class="muted">版本：${escapeHtml(service.version)}</p>` : ""}
        ${service.uptime ? `<p class="muted">${escapeHtml(service.uptime)}</p>` : ""}
        ${service.error ? `<p class="muted">${escapeHtml(service.error)}</p>` : ""}
        ${Object.hasOwn(service, "lastWebhook") ? `<p class="muted">最近回传：${service.lastWebhook ? historyTime(service.lastWebhook) : "暂无"}</p>` : ""}
      </section>`).join("")}</div>
    <h2 class="monitor-heading">SIP Extension 注册状态</h2>
    <section class="panel">
      ${data.registrationError ? `<p class="monitor-notice">${escapeHtml(data.registrationError)}</p>` : ""}
      <div class="table-wrap"><table><thead><tr><th>分机 / SIP 域</th><th>注册状态</th><th>软电话 / 连接信息</th><th>绑定路由</th></tr></thead><tbody>
      ${data.extensions.map(extension => `<tr><td><strong>${escapeHtml(extension.extension)}</strong><div class="muted">${escapeHtml(extension.domain)}</div></td>
        <td>${monitorBadge(extension, stale)}</td>
        <td>${extension.registrations.map(reg => `<div class="monitor-registration"><div>${escapeHtml(reg.agent || "未知软电话")}</div><small class="muted">${escapeHtml(reg.ip)} · ${escapeHtml(reg.transport)}${reg.expiresSec == null ? "" : ` · 检测时剩余 ${reg.expiresSec} 秒`}</small></div>`).join("") || "暂无注册信息"}</td>
        <td>${extension.routeNames.map(escapeHtml).join("<br>") || "未绑定路由"}</td></tr>`).join("") || `<tr><td colspan="4">暂无已配置或已注册的分机</td></tr>`}
      </tbody></table></div>
    </section>
    <h2 class="monitor-heading">Agora VoiceBot</h2>
    <div class="monitor-grid">${data.agora.map(target => `<section class="panel monitor-card">
      <div class="monitor-card-head"><h3>Agora VoiceBot / SIP 接入</h3>${monitorBadge(target, stale)}</div>
      <p class="monitor-address">${escapeHtml(target.uri)}</p>
      <p><strong>VoiceBot 状态：</strong>${escapeHtml(target.botStatus)}</p>
      <p class="muted">TCP 入口：${target.reachable ? `可达 · ${target.latencyMs} ms` : `不可达 · ${escapeHtml(target.error)}`}</p>
      <p class="muted">最近成功桥接：${target.lastConnectedAt ? historyTime(target.lastConnectedAt) : "暂无记录"}</p>
      <p class="muted">${escapeHtml(target.detail)}</p>
    </section>`).join("") || `<section class="panel"><div class="empty">暂无启用的 Agora 通话路由</div></section>`}</div>
    <h2 class="monitor-heading">Agent 运行状态</h2>
    <p class="muted">以下 Agent 暂按演示需求统一显示运行正常，尚未接入实际进程或健康检查。</p>
    <div class="monitor-grid">${data.agents.map(agent => `<section class="panel monitor-card">
      <div class="monitor-card-head"><h3>${escapeHtml(agent.name)}</h3>${monitorBadge(agent)}</div>
      <p class="muted">${escapeHtml(agent.detail)}</p></section>`).join("")}</div>`;
}

let lastMonitorRequestAt = 0;
async function refreshMonitor() {
  if (state.monitorLoading) return;
  state.monitorLoading = true;
  lastMonitorRequestAt = Date.now();
  if (state.view === "monitor") render();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    state.monitor = await api.request("/api/monitor", { signal: controller.signal });
    state.monitorError = null;
  } catch (error) {
    state.monitorError = error.name === "AbortError" ? "服务响应超时" : error.message;
  } finally {
    clearTimeout(timer);
    state.monitorLoading = false;
    if (state.view === "monitor") render();
  }
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
      <section class="modal ${state.agoraInputPreview ? "modal-wide" : ""}" onclick="event.stopPropagation()">
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
    planned: renderPlannedCalls,
    debtorHistory: renderDebtorHistory,
    qa: renderQa,
    routes: renderRoutes,
    monitor: renderMonitor,
    accounts: renderAccounts
  };
  app.innerHTML = shell(views[state.view]()) + renderModal() + (state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : "");
}

function setView(view) {
  state.view = view;
  render();
  if (view === "monitor") refreshMonitor();
}

function selectCall(callId) {
  state.selectedCallId = callId;
  render();
}

async function startCall(debtorId) {
  try {
    const route = selectedRoute();
    await api.post(`/api/calls/${debtorId}/start`, { routeId: route?.id });
    await refresh();
    setToast(`正在呼叫分机 ${route.extension}，请在软电话接听`);
  } catch (error) {
    setToast(error.message);
  }
}

async function hangupCall(callId) {
  try {
    await api.post(`/api/calls/${callId}/hangup`, {});
    await refresh();
    setToast("已请求挂断");
  } catch (error) { setToast(error.message); }
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
        ${field("电话号码", "phone", debtor.phone || "", true)}
        ${selectField("性别", "gender", debtor.gender || "未知", ["未知", "男", "女", "其他"])}
        ${field("欠款 APP（必填）", "debtApp", debtor.debtApp || "", true)}
        ${field("欠款平台（必填）", "platform", debtor.platform || "", true)}
        ${field("欠款引流渠道（必填）", "acquisitionChannel", debtor.acquisitionChannel || "", true)}
        ${debtor.demoSourceFields?.length ? '<p class="muted full-width">当前来源资料含系统补充的演示值，请按实际情况修改。APP、平台和渠道为独立必填项。</p>' : ''}
        ${selectField("是否有过承诺", "hasPromise", debtor.hasPromise == null ? "unknown" : String(debtor.hasPromise), [["unknown", "未知"], ["true", "是"], ["false", "否"]])}
        ${selectField("是否有投诉历史", "hasComplaintHistory", debtor.hasComplaintHistory == null ? "unknown" : String(debtor.hasComplaintHistory), [["unknown", "未知"], ["true", "是"], ["false", "否"]])}
        ${field("当前逾期金额", "amount", debtor.amount ?? "", true, "number")}
        ${field("合同编号", "contractNo", debtor.contractNo || "", true)}
        ${field("产品", "product", debtor.product || "消费分期")}
        ${field("当前逾期期数", "overduePeriods", debtor.overduePeriods ?? 1, true, "number")}
        ${field("逾期天数", "overdueDays", debtor.overdueDays ?? 1, true, "number")}
        ${selectField("风险等级", "riskLevel", debtor.riskLevel || "中", ["低", "中", "高"])}
        ${selectField("还款状态", "repaymentStatus", debtor.repaymentStatus || "未还款", ["未还款", "已还款"])}
        ${selectField("催收状态", "collectionStatus", debtor.collectionStatus || "待首催", ["待首催", "外呼中", "已催收", "需复催", "已结清"])}
        <div class="field full-width"><label>通话历史总结</label>
          <textarea name="callHistorySummary" placeholder="填写多次通话的整体总结；留空时列表展示最近一次通话摘要">${escapeHtml(debtor.callHistorySummary || "")}</textarea>
          <small class="muted">已有承诺还款记录时，“有过承诺”保持为是。</small></div>
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
    extension: "1001",
    agoraSip: "sip:gpcz0@cn-north-1-sbc.ai.agora.io:5060;transport=tcp",
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
        ${field("软电话 SIP 分机号", "extension", route.extension || "1001", true)}
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
  state.agoraInputPreview = null;
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
window.openDebtorHistory = openDebtorHistory;
window.openHistoryCall = openHistoryCall;
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
window.openAgoraInput = openAgoraInput;
window.plannedCardKeydown = plannedCardKeydown;
window.selectCall = selectCall;
window.toggleQaTag = toggleQaTag;
window.saveQaNote = saveQaNote;
window.hangupCall = hangupCall;
window.refreshMonitor = refreshMonitor;

if (api.token) {
  refresh().catch(() => {
    api.token = null;
    localStorage.removeItem("dc_token");
    render();
  });
} else {
  render();
}

// Poll without replacing an in-progress form or a QA note being edited.
let polling = false;
window.setInterval(async () => {
  if (!api.token || !state.user || state.modal || polling || document.hidden ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (state.view === "monitor") {
    if (Date.now() - lastMonitorRequestAt >= 10000) await refreshMonitor();
    return;
  }
  polling = true;
  try { await refresh(); } catch {} finally { polling = false; }
}, 2000);
