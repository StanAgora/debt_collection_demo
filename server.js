const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_FILE = path.join(__dirname, "data", "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_AGORA_SIP = "sip:gptest@cn-north-1-sbc.ai.agora.io:5060;transport=tcp";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
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
        name: "默认预测式外呼路由",
        mobileTrunk: "sip:carrier-trunk@example.com:5060;transport=tcp",
        agoraSip: DEFAULT_AGORA_SIP,
        enabled: true,
        description: "先呼叫债务人手机，接通后桥接到 Agora Voice Agent。",
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
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
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
  const db = readDb();

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const body = await readBody(req);
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
    const body = await readBody(req);
    const debtor = db.debtors.find(item => item.id === body.debtorId || item.phone === body.phone);
    const call = {
      id: body.callId || randomId("call"),
      debtorId: debtor?.id || body.debtorId || null,
      debtorName: debtor?.name || body.debtorName || "未知客户",
      debtorPhone: debtor?.phone || body.phone || "",
      attempt: body.attempt || (debtor ? db.calls.filter(item => item.debtorId === debtor.id).length + 1 : 1),
      routeId: body.routeId || "route_default",
      status: body.status || "已完成",
      startedAt: body.startedAt || nowIso(),
      answeredAt: body.answeredAt || null,
      endedAt: body.endedAt || nowIso(),
      durationSec: Number(body.durationSec || 0),
      recordingUrl: body.recordingUrl || "",
      transcript: normalizeTranscript(body.transcript),
      summary: body.summary || "Webhook 已回传，等待质检补充。",
      qaTags: [],
      qaNote: "",
      webhookPayload: body
    };
    db.calls.unshift(call);
    if (debtor) {
      debtor.history.unshift({
        id: randomId("hist"),
        callId: call.id,
        time: call.endedAt,
        result: call.status,
        summary: call.summary,
        nextAction: body.nextAction || "待人工质检"
      });
      debtor.collectionStatus = body.needRecall ? "需复催" : "已催收";
      if (body.promiseAmount || body.promiseDate) {
        debtor.promise = {
          amount: Number(body.promiseAmount || 0),
          date: body.promiseDate || "",
          note: body.promiseNote || ""
        };
      }
      if (body.repaymentStatus) debtor.repaymentStatus = body.repaymentStatus;
    }
    addAudit(db, null, "Agora webhook", `接收通话 ${call.id}`);
    writeDb(db);
    return sendJson(res, 200, { ok: true, call });
  }

  const user = getSessionUser(req, db);
  if (!user) return sendError(res, 401, "请先登录");

  if (req.method === "GET" && pathname === "/api/bootstrap") {
    const plannedCalls = getPlannedCalls(db);
    const activeCalls = db.calls.filter(call => call.status === "拨打中" || call.status === "桥接中").length;
    return sendJson(res, 200, {
      user: publicUser(user),
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

  if (req.method === "POST" && pathname === "/api/debtors") {
    const body = await readBody(req);
    const debtor = {
      id: randomId("debtor"),
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
    const body = await readBody(req);
    const debtor = db.debtors.find(item => item.id === debtorId);
    if (!debtor) return sendError(res, 404, "债务人不存在");
    Object.assign(debtor, {
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
    const body = await readBody(req);
    const debtor = db.debtors.find(item => item.id === debtorId);
    if (!debtor) return sendError(res, 404, "债务人不存在");
    if (debtor.repaymentStatus === "已还款") return sendError(res, 400, "已还款客户无需外呼");
    const route = db.routes.find(item => item.id === (body.routeId || "route_default") && item.enabled);
    if (!route) return sendError(res, 400, "未找到可用通话路由");

    const attempt = db.calls.filter(item => item.debtorId === debtor.id).length + 1;
    const call = {
      id: randomId("call"),
      debtorId: debtor.id,
      debtorName: debtor.name,
      debtorPhone: debtor.phone,
      attempt,
      routeId: route.id,
      status: "桥接中",
      startedAt: nowIso(),
      answeredAt: nowIso(),
      endedAt: null,
      durationSec: 0,
      recordingUrl: "",
      transcript: [
        { speaker: "系统", text: `已通过 ${route.mobileTrunk} 呼叫 ${debtor.phone}` },
        { speaker: "系统", text: `客户接通后桥接至 ${route.agoraSip}` }
      ],
      summary: "预测式外呼任务已创建，等待 Agora Voice Agent 回传通话结果。",
      qaTags: [],
      qaNote: "",
      webhookPayload: {
        mode: "predictive-outbound",
        route,
        agoraTask: {
          sipUri: route.agoraSip,
          debtorId: debtor.id,
          debtorName: debtor.name,
          contractNo: debtor.contractNo,
          amount: debtor.amount,
          attempt
        }
      }
    };
    db.calls.unshift(call);
    debtor.collectionStatus = "外呼中";
    debtor.history.unshift({
      id: randomId("hist"),
      callId: call.id,
      time: call.startedAt,
      result: "任务已发起",
      summary: `第 ${attempt} 次外呼已发起，等待通话结果回传。`,
      nextAction: "等待 webhook"
    });
    addAudit(db, user, "发起外呼", `${debtor.name} 第 ${attempt} 次`);
    writeDb(db);
    return sendJson(res, 201, { call });
  }

  if (req.method === "POST" && pathname.match(/^\/api\/calls\/[^/]+\/complete-mock$/)) {
    const callId = pathname.split("/")[3];
    const body = await readBody(req);
    const call = db.calls.find(item => item.id === callId);
    if (!call) return sendError(res, 404, "通话不存在");
    const debtor = db.debtors.find(item => item.id === call.debtorId);
    call.status = body.status || "已完成";
    call.endedAt = nowIso();
    call.durationSec = Number(body.durationSec || 188);
    call.recordingUrl = body.recordingUrl || `https://example.com/recordings/${call.id}.wav`;
    call.transcript = normalizeTranscript(body.transcript || [
      { speaker: "AI", text: `您好，请问是${call.debtorName}本人吗？` },
      { speaker: "客户", text: "是的，我知道这笔逾期。" },
      { speaker: "AI", text: "请问您是否可以确认一个还款时间？" },
      { speaker: "客户", text: "我会尽快处理，需要再提醒我一次。" }
    ]);
    call.summary = body.summary || "客户确认欠款但未明确还款时间，建议复催。";
    if (debtor) {
      debtor.collectionStatus = body.needRecall === false ? "已催收" : "需复催";
      const hist = debtor.history.find(item => item.callId === call.id);
      if (hist) {
        hist.result = call.status;
        hist.summary = call.summary;
        hist.nextAction = debtor.collectionStatus;
        hist.time = call.endedAt;
      }
    }
    addAudit(db, user, "模拟回传", call.id);
    writeDb(db);
    return sendJson(res, 200, { call });
  }

  if (req.method === "PATCH" && pathname.match(/^\/api\/calls\/[^/]+\/qa$/)) {
    const callId = pathname.split("/")[3];
    const body = await readBody(req);
    const call = db.calls.find(item => item.id === callId);
    if (!call) return sendError(res, 404, "通话不存在");
    call.qaTags = Array.isArray(body.qaTags) ? body.qaTags : [];
    call.qaNote = body.qaNote || "";
    addAudit(db, user, "质检标注", call.id);
    writeDb(db);
    return sendJson(res, 200, { call });
  }

  if (req.method === "POST" && pathname === "/api/routes") {
    const body = await readBody(req);
    const route = {
      id: randomId("route"),
      name: body.name || "未命名路由",
      mobileTrunk: body.mobileTrunk || "",
      agoraSip: body.agoraSip || DEFAULT_AGORA_SIP,
      enabled: body.enabled !== false,
      description: body.description || "",
      createdAt: nowIso()
    };
    db.routes.unshift(route);
    addAudit(db, user, "新增路由", route.name);
    writeDb(db);
    return sendJson(res, 201, { route });
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/routes/")) {
    const routeId = pathname.split("/").pop();
    const body = await readBody(req);
    const route = db.routes.find(item => item.id === routeId);
    if (!route) return sendError(res, 404, "路由不存在");
    Object.assign(route, {
      name: body.name ?? route.name,
      mobileTrunk: body.mobileTrunk ?? route.mobileTrunk,
      agoraSip: body.agoraSip ?? route.agoraSip,
      enabled: body.enabled ?? route.enabled,
      description: body.description ?? route.description
    });
    addAudit(db, user, "更新路由", route.name);
    writeDb(db);
    return sendJson(res, 200, { route });
  }

  if (req.method === "POST" && pathname === "/api/users") {
    const body = await readBody(req);
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
    const body = await readBody(req);
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
    const body = await readBody(req);
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

ensureDataFile();
server.listen(PORT, HOST, () => {
  console.log(`Debt collection demo is running at http://${HOST}:${PORT}`);
  console.log("Default login: admin / admin123");
});
