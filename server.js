const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { debtorDetails, backfillDemoSources, requireDebtorSources } = require("./lib/debtors");
const { ServiceMonitor } = require("./lib/monitor");
const { buildAgoraInput } = require("./lib/agora-input");
const { newTaskId, prepareSipInput, matchWebhookCall } = require("./lib/agora-sip");
const { Telephony, DEFAULT_AGORA_SIP, isActive, validateRoute, finish } = require("./lib/telephony");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");


const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), candidate);
}

function ensureDataFile() {
  if (fs.existsSync(DATA_FILE)) return;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

  const adminPassword = hashPassword("admin123");
  const demo = {
    users: [
      {
        id: "user_admin",
        name: "系统管理员",
        username: "admin",
        role: "管理员",
        active: true,
        passwordHash: adminPassword,
        createdAt: nowIso(),
        lastLoginAt: null
      },
      {
        id: "user_qc",
        name: "质检专员",
        username: "qa",
        role: "质检",
        active: true,
        passwordHash: hashPassword("qa123456"),
        createdAt: nowIso(),
        lastLoginAt: null
      }
    ],
    debtors: [
      {
        id: "debtor_chen",
        name: "陈伟",
        phone: "+8613810010001",
        amount: 12850,
        contractNo: "HT-2026-0821",
        product: "消费分期",
        overduePeriods: 3,
        overdueDays: 74,
        promise: null,
        repaymentStatus: "未还款",
        collectionStatus: "待首催",
        riskLevel: "高",
        history: []
      },
      {
        id: "debtor_li",
        name: "李娜",
        phone: "+8613810010002",
        amount: 5320,
        contractNo: "HT-2026-0719",
        product: "信用贷",
        overduePeriods: 1,
        overdueDays: 18,
        promise: null,
        repaymentStatus: "未还款",
        collectionStatus: "待首催",
        riskLevel: "中",
        history: []
      },
      {
        id: "debtor_wang",
        name: "王磊",
        phone: "+8613810010003",
        amount: 22400,
        contractNo: "HT-2026-0611",
        product: "车主贷",
        overduePeriods: 4,
        overdueDays: 96,
        promise: {
          amount: 5000,
          date: "2026-10-15",
          note: "承诺先偿还部分欠款"
        },
        repaymentStatus: "未还款",
        collectionStatus: "需复催",
        riskLevel: "高",
        history: [
          {
            id: "hist_wang_1",
            callId: "call_wang_1",
            time: "2026-10-08T03:20:00.000Z",
            result: "已接通",
            summary: "客户表示资金周转困难，承诺 10 月 15 日先还 5000 元。",
            nextAction: "到期前复催提醒"
          }
        ]
      },
      {
        id: "debtor_zhao",
        name: "赵敏",
        phone: "+8613810010004",
        amount: 3980,
        contractNo: "HT-2026-0522",
        product: "消费分期",
        overduePeriods: 2,
        overdueDays: 43,
        promise: {
          amount: 3980,
          date: "2026-10-09",
          note: "已完成还款"
        },
        repaymentStatus: "已还款",
        collectionStatus: "已结清",
        riskLevel: "低",
        history: [
          {
            id: "hist_zhao_1",
            callId: "call_zhao_1",
            time: "2026-10-06T07:35:00.000Z",
            result: "已接通",
            summary: "客户确认 10 月 9 日完成还款。",
            nextAction: "无需复催"
          }
        ]
      }
    ],
    routes: [
      {
        id: "route_default",
        name: "软电话 → Agora Voice Agent",
        extension: "1001",
        agoraSip: DEFAULT_AGORA_SIP,
        enabled: true,
        description: "先呼叫软电话分机，接听后连接 Agora Voice Agent。",
        createdAt: nowIso()
      }
    ],
    calls: [
      {
        id: "call_wang_1",
        debtorId: "debtor_wang",
        debtorName: "王磊",
        debtorPhone: "+8613810010003",
        attempt: 1,
        routeId: "route_default",
        status: "已完成",
        startedAt: "2026-10-08T03:20:00.000Z",
        answeredAt: "2026-10-08T03:20:11.000Z",
        endedAt: "2026-10-08T03:24:08.000Z",
        durationSec: 237,
        recordingUrl: "https://example.com/recordings/call_wang_1.wav",
        transcript: [
          { speaker: "AI", text: "您好，这里是还款提醒服务，请问是王磊先生吗？" },
          { speaker: "客户", text: "我是，现在不太方便。" },
          { speaker: "AI", text: "了解。您当前合同 HT-2026-0611 已逾期 4 期，欠款 22400 元。" },
          { speaker: "客户", text: "我 15 号能先还 5000。" }
        ],
        summary: "客户承诺 10 月 15 日先还 5000 元，需要到期前复催。",
        qaTags: ["承诺还款", "需复催"],
        qaNote: "AI 说明金额和合同号准确，语气合规。",
        webhookPayload: null
      },
      {
        id: "call_zhao_1",
        debtorId: "debtor_zhao",
        debtorName: "赵敏",
        debtorPhone: "+8613810010004",
        attempt: 1,
        routeId: "route_default",
        status: "已完成",
        startedAt: "2026-10-06T07:35:00.000Z",
        answeredAt: "2026-10-06T07:35:09.000Z",
        endedAt: "2026-10-06T07:37:44.000Z",
        durationSec: 155,
        recordingUrl: "https://example.com/recordings/call_zhao_1.wav",
        transcript: [
          { speaker: "AI", text: "您好，请问是赵敏女士吗？" },
          { speaker: "客户", text: "是的，钱我这两天会处理。" }
        ],
        summary: "客户确认近期还款，后续已结清。",
        qaTags: ["已还款"],
        qaNote: "",
        webhookPayload: null
      }
    ],
    auditLog: []
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(demo, null, 2));
}

function readDb() {
  ensureDataFile();
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if ((db.schemaVersion || 0) < 2) {
    for (const route of db.routes) {
      if (route.extension) continue;
      route.extension = "1001";
      if (route.id === "route_default") {
        route.name = "软电话 → Agora Voice Agent";
        route.description = "先呼叫软电话分机，接听后连接 Agora Voice Agent。";
        if (route.agoraSip === "sip:gptest@cn-north-1-sbc.ai.agora.io:5060;transport=tcp") route.agoraSip = DEFAULT_AGORA_SIP;
      } else {
        route.enabled = false;
        route.description = `${route.description || ""}（旧路由已停用，请确认分机配置后启用）`;
      }
      // Preserve the old trunk for reference; it is never used for dialing.
    }
    db.schemaVersion = 2;
    writeDb(db);
  }
  if ((db.schemaVersion || 0) < 3) {
    for (const debtor of db.debtors) Object.assign(debtor, debtorDetails({}, debtor));
    db.schemaVersion = 3;
    writeDb(db);
  }
  if ((db.schemaVersion || 0) < 4) {
    for (const debtor of db.debtors) backfillDemoSources(debtor);
    db.schemaVersion = 4;
    writeDb(db);
  }
  return db;
}

function writeDb(db) {
  fs.writeFileSync(`${DATA_FILE}.tmp`, JSON.stringify(db, null, 2));
  fs.renameSync(`${DATA_FILE}.tmp`, DATA_FILE);
}

function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function sendJson(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json)
  });
  res.end(json);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function getSessionUser(req, db) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  const user = db.users.find(item => item.id === session.userId && item.active);
  return user || null;
}

function getPlannedCalls(db) {
  return db.debtors
    .filter(debtor => debtor.repaymentStatus !== "已还款")
    .filter(debtor => debtor.history.length === 0 || debtor.collectionStatus === "需复催")
    .map(debtor => {
      const attempts = db.calls.filter(call => call.debtorId === debtor.id).length;
      return {
        debtorId: debtor.id,
        name: debtor.name,
        phone: debtor.phone,
        amount: debtor.amount,
        contractNo: debtor.contractNo,
        overdueDays: debtor.overdueDays,
        riskLevel: debtor.riskLevel,
        reason: attempts === 0 ? "新增债务人" : "AI 判断需复催",
        attempt: attempts + 1
      };
    });
}

function normalizeTranscript(transcript) {
  if (!transcript) return [];
  if (Array.isArray(transcript)) {
    return transcript.map(item => ({
      speaker: item.speaker || item.role || "未知",
      text: item.text || item.content || ""
    }));
  }
  if (typeof transcript === "string") {
    return transcript
      .split("\n")
      .filter(Boolean)
      .map(line => ({ speaker: "记录", text: line }));
  }
  return [];
}

function addAudit(db, user, action, detail) {
  db.auditLog.unshift({
    id: randomId("audit"),
    userId: user?.id || "system",
    username: user?.username || "system",
    action,
    detail,
    time: nowIso()
  });
}

async function handleApi(req, res, pathname) {
  const body = ["POST", "PATCH"].includes(req.method) ? await readBody(req) : {};
  const db = readDb();

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const user = db.users.find(item => item.username === body.username && item.active);
    if (!user || !verifyPassword(body.password || "", user.passwordHash)) {
      return sendError(res, 401, "用户名或密码不正确");
    }
    const token = randomId("token");
    sessions.set(token, { userId: user.id, createdAt: Date.now() });
    user.lastLoginAt = nowIso();
    addAudit(db, user, "登录", "用户登录系统");
    writeDb(db);
    return sendJson(res, 200, { token, user: publicUser(user) });
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (token) sessions.delete(token);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/webhooks/agora/calls") {
    const webhookToken = process.env.AGORA_WEBHOOK_TOKEN;
    if (!getSessionUser(req, db) && (!webhookToken || req.headers.authorization !== `Bearer ${webhookToken}`)) {
      return sendError(res, 401, "Webhook 认证失败");
    }
    const match = matchWebhookCall(db.calls, body);
    if (match.error) return sendError(res, match.status, match.error);
    const { call } = match;
    if (match.matchedTaskId && call.agoraInput?.sip) call.agoraInput.deliveryStatus = "callback_received";
    const debtor = db.debtors.find(item => item.id === call.debtorId);
    Object.assign(call, {
      recordingUrl: body.recordingUrl ?? call.recordingUrl,
      transcript: body.transcript === undefined ? call.transcript : normalizeTranscript(body.transcript),
      summary: body.summary ?? call.summary,
      resultReceivedAt: nowIso(),
      webhookPayload: body
    });
    // Call lifecycle is owned by FreeSWITCH, quality results by the webhook.
    if (debtor) {
      debtor.collectionStatus = body.needRecall ? "需复催" : "已催收";
      const hist = debtor.history.find(item => item.callId === call.id);
      if (hist) Object.assign(hist, { summary: call.summary, nextAction: body.nextAction || "待人工质检" });
      if (body.promiseAmount || body.promiseDate) debtor.promise = {
        amount: Number(body.promiseAmount || 0), date: body.promiseDate || "", note: body.promiseNote || ""
      };
      if (debtor.promise) debtor.hasPromise = true;
      if (body.repaymentStatus) debtor.repaymentStatus = body.repaymentStatus;
    }
    addAudit(db, null, "Agora webhook", `接收通话 ${call.id}`);
    writeDb(db);
    return sendJson(res, 200, { ok: true, call });
  }

  const user = getSessionUser(req, db);
  if (!user) return sendError(res, 401, "请先登录");

  if (req.method === "GET" && pathname === "/api/monitor") {
    return sendJson(res, 200, await monitor.snapshot());
  }

  if (req.method === "GET" && pathname === "/api/bootstrap") {
    const plannedCalls = getPlannedCalls(db);
    const activeCalls = db.calls.filter(isActive).length;
    return sendJson(res, 200, {
      user: publicUser(user),
      telephony: telephony.status(),
      debtors: db.debtors,
      plannedCalls,
      calls: db.calls,
      routes: db.routes,
      users: db.users.map(publicUser),
      auditLog: db.auditLog.slice(0, 30),
      stats: {
        debtorCount: db.debtors.length,
        plannedCount: plannedCalls.length,
        unpaidAmount: db.debtors
          .filter(debtor => debtor.repaymentStatus !== "已还款")
          .reduce((sum, debtor) => sum + debtor.amount, 0),
        activeCalls
      }
    });
  }

  if (req.method === "GET" && pathname.match(/^\/api\/debtors\/[^/]+\/agora-input$/)) {
    const debtor = db.debtors.find(item => item.id === pathname.split("/")[3]);
    if (!debtor) return sendError(res, 404, "债务人不存在");
    return sendJson(res, 200, buildAgoraInput(debtor, db.calls));
  }

  if (req.method === "POST" && pathname === "/api/debtors") {
    let details;
    try { details = debtorDetails(body); requireDebtorSources(details); } catch (error) { return sendError(res, 400, error.message); }
    const debtor = {
      id: randomId("debtor"),
      ...details,
      name: body.name || "未命名客户",
      phone: body.phone || "",
      amount: Number(body.amount || 0),
      contractNo: body.contractNo || "",
      product: body.product || "未知产品",
      overduePeriods: Number(body.overduePeriods || 0),
      overdueDays: Number(body.overdueDays || 0),
      promise: null,
      repaymentStatus: body.repaymentStatus || "未还款",
      collectionStatus: "待首催",
      riskLevel: body.riskLevel || "中",
      history: []
    };
    db.debtors.unshift(debtor);
    addAudit(db, user, "新增债务人", `${debtor.name} ${debtor.contractNo}`);
    writeDb(db);
    return sendJson(res, 201, { debtor });
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/debtors/")) {
    const debtorId = pathname.split("/").pop();
    const debtor = db.debtors.find(item => item.id === debtorId);
    if (!debtor) return sendError(res, 404, "债务人不存在");
    let details;
    try { details = debtorDetails(body, debtor); requireDebtorSources(details); } catch (error) { return sendError(res, 400, error.message); }
    Object.assign(debtor, {
      ...details,
      name: body.name ?? debtor.name,
      phone: body.phone ?? debtor.phone,
      amount: body.amount === undefined ? debtor.amount : Number(body.amount),
      contractNo: body.contractNo ?? debtor.contractNo,
      product: body.product ?? debtor.product,
      overduePeriods: body.overduePeriods === undefined ? debtor.overduePeriods : Number(body.overduePeriods),
      overdueDays: body.overdueDays === undefined ? debtor.overdueDays : Number(body.overdueDays),
      repaymentStatus: body.repaymentStatus ?? debtor.repaymentStatus,
      collectionStatus: body.collectionStatus ?? debtor.collectionStatus,
      riskLevel: body.riskLevel ?? debtor.riskLevel
    });
    if (body.promise === null) debtor.promise = null;
    if (body.promise) debtor.promise = body.promise;
    addAudit(db, user, "更新债务人", debtor.name);
    writeDb(db);
    return sendJson(res, 200, { debtor });
  }

  if (req.method === "POST" && pathname.match(/^\/api\/calls\/[^/]+\/start$/)) {
    const debtorId = pathname.split("/")[3];
    const debtor = db.debtors.find(item => item.id === debtorId);
    if (!debtor) return sendError(res, 404, "债务人不存在");
    if (debtor.repaymentStatus === "已还款") return sendError(res, 400, "已还款客户无需外呼");
    try { requireDebtorSources(debtor); } catch (error) { return sendError(res, 400, error.message); }
    const route = db.routes.find(item => item.id === (body.routeId || "route_default") && item.enabled);
    if (!route) return sendError(res, 400, "未找到可用通话路由");

    try { validateRoute(route); } catch (error) { return sendError(res, 400, error.message); }
    if (!telephony.status().connected) return sendError(res, 503, "FreeSWITCH 未就绪，请查看通话路由页的连接状态");
    if (db.calls.some(call => isActive(call) && (call.extension === route.extension || call.debtorId === debtor.id))) {
      return sendError(res, 409, "该分机或客户已有进行中的通话");
    }
    const attempt = db.calls.filter(item => item.debtorId === debtor.id).length + 1;
    const taskId = newTaskId(db.calls);
    const agoraInput = buildAgoraInput(debtor, db.calls);
    try { agoraInput.sip = prepareSipInput(taskId, agoraInput.payload); }
    catch (error) { return sendError(res, 413, error.message); }
    agoraInput.deliveryStatus = "prepared";
    const call = {
      id: randomId("call"), taskId, ...telephony.ids(), provider: "freeswitch",
      debtorId: debtor.id, debtorName: debtor.name, debtorPhone: debtor.phone,
      attempt, routeId: route.id, extension: route.extension, agoraSip: route.agoraSip,
      status: "分机呼叫中", startedAt: nowIso(), answeredAt: null, bridgedAt: null,
      endedAt: null, durationSec: 0, recordingUrl: "", transcript: [],
      summary: `正在呼叫分机 ${route.extension}，接听后连接 Agora Voice Agent。`,
      qaTags: [], qaNote: "", webhookPayload: null,
      agoraInput
    };
    db.calls.unshift(call);
    debtor.collectionStatus = "外呼中";
    debtor.history.unshift({
      id: randomId("hist"), callId: call.id, time: call.startedAt, result: call.status,
      summary: call.summary, nextAction: "等待通话结束"
    });
    addAudit(db, user, "发起分机呼叫", `${debtor.name} → 分机 ${route.extension} → Agora`);
    writeDb(db);
    try {
      await telephony.originate(call, route);
    } catch (error) {
      // A transport error can occur after FreeSWITCH accepted the command.
      // Keep the UUID reserved until reconnect reconciliation confirms its state.
      telephony.update(current => {
        const saved = current.calls.find(item => item.id === call.id);
        if (!saved || !isActive(saved)) return;
        if (telephony.client.ready) finish(saved, error.message);
        else { saved.status = "状态待确认"; saved.summary = "控制连接中断，重连后自动核对呼叫结果。"; }
        telephony.updateHistory(current, saved);
      });
      return sendError(res, 502, `呼叫提交未确认：${error.message}。请查看通话记录。`);
    }
    return sendJson(res, 201, { call: readDb().calls.find(item => item.id === call.id) });
  }

  if (req.method === "POST" && pathname.match(/^\/api\/calls\/[^/]+\/hangup$/)) {
    const call = db.calls.find(item => item.id === pathname.split("/")[3]);
    if (!call) return sendError(res, 404, "通话不存在");
    if (!isActive(call)) return sendError(res, 409, "通话已结束");
    call.cancelRequested = true;
    writeDb(db);
    try { await telephony.hangup(call); }
    catch (error) { return sendError(res, 502, `挂断未确认：${error.message}`); }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "PATCH" && pathname.match(/^\/api\/calls\/[^/]+\/qa$/)) {
    const callId = pathname.split("/")[3];
    const call = db.calls.find(item => item.id === callId);
    if (!call) return sendError(res, 404, "通话不存在");
    call.qaTags = Array.isArray(body.qaTags) ? body.qaTags : [];
    call.qaNote = body.qaNote || "";
    addAudit(db, user, "质检标注", call.id);
    writeDb(db);
    return sendJson(res, 200, { call });
  }

  if (req.method === "POST" && pathname === "/api/routes") {
    const route = {
      id: randomId("route"),
      name: body.name || "未命名路由",
      extension: body.extension || "1001",
      agoraSip: body.agoraSip || DEFAULT_AGORA_SIP,
      enabled: body.enabled !== false,
      description: body.description || "",
      createdAt: nowIso()
    };
    try { validateRoute(route); } catch (error) { return sendError(res, 400, error.message); }
    db.routes.unshift(route);
    addAudit(db, user, "新增路由", route.name);
    writeDb(db);
    return sendJson(res, 201, { route });
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/routes/")) {
    const routeId = pathname.split("/").pop();
    const route = db.routes.find(item => item.id === routeId);
    if (!route) return sendError(res, 404, "路由不存在");
    const updated = { ...route,
      name: body.name ?? route.name,
      extension: body.extension ?? route.extension,
      agoraSip: body.agoraSip ?? route.agoraSip,
      enabled: body.enabled ?? route.enabled,
      description: body.description ?? route.description
    };
    try { validateRoute(updated); } catch (error) { return sendError(res, 400, error.message); }
    Object.assign(route, updated);
    addAudit(db, user, "更新路由", route.name);
    writeDb(db);
    return sendJson(res, 200, { route });
  }

  if (req.method === "POST" && pathname === "/api/users") {
    if (!body.username || !body.password) return sendError(res, 400, "用户名和初始密码必填");
    if (db.users.some(item => item.username === body.username)) return sendError(res, 409, "用户名已存在");
    const created = {
      id: randomId("user"),
      name: body.name || body.username,
      username: body.username,
      role: body.role || "催收员",
      active: true,
      passwordHash: hashPassword(body.password),
      createdAt: nowIso(),
      lastLoginAt: null
    };
    db.users.unshift(created);
    addAudit(db, user, "新增账号", created.username);
    writeDb(db);
    return sendJson(res, 201, { user: publicUser(created) });
  }

  if (req.method === "PATCH" && pathname.match(/^\/api\/users\/[^/]+\/password$/)) {
    const userId = pathname.split("/")[3];
    const target = db.users.find(item => item.id === userId);
    if (!target) return sendError(res, 404, "账号不存在");
    if (!body.password || body.password.length < 6) return sendError(res, 400, "密码至少 6 位");
    target.passwordHash = hashPassword(body.password);
    addAudit(db, user, "重置密码", target.username);
    writeDb(db);
    return sendJson(res, 200, { user: publicUser(target) });
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/users/")) {
    const userId = pathname.split("/").pop();
    const target = db.users.find(item => item.id === userId);
    if (!target) return sendError(res, 404, "账号不存在");
    target.name = body.name ?? target.name;
    target.role = body.role ?? target.role;
    target.active = body.active ?? target.active;
    addAudit(db, user, "更新账号", target.username);
    writeDb(db);
    return sendJson(res, 200, { user: publicUser(target) });
  }

  return sendError(res, 404, "接口不存在");
}

function serveStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          res.writeHead(404);
          return res.end("Not found");
        }
        res.writeHead(200, { "Content-Type": mimeTypes[".html"] });
        res.end(fallback);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendError(res, 500, error.message || "Server error");
  }
});

readDb();
const telephony = new Telephony({ readDb, writeDb });
telephony.start();
const monitor = new ServiceMonitor({ telephony, readDb, dataFile: DATA_FILE });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  telephony.stop();
  server.close(() => process.exit(0));
});
server.listen(PORT, HOST, () => {
  console.log(`Debt collection demo is running at http://${HOST}:${server.address().port}`);
  console.log("Default login: admin / admin123");
});
