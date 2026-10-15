const { randomUUID } = require("node:crypto");
const { EslClient } = require("./esl");
const { prepareSipInput } = require("./agora-sip");

const DEFAULT_AGORA_SIP = "sip:gpcz0@cn-north-1-sbc.ai.agora.io:5060;transport=tcp";
const isActive = call => call.provider === "freeswitch" && !call.endedAt;

function validateRoute(route) {
  if (!/^\d{2,10}$/.test(route.extension || "")) throw new Error("SIP 分机号须为 2–10 位数字");
  // Only a direct SIP address is accepted. Reject FreeSWITCH dial-string
  // separators, variable expansions and newlines before building ESL commands.
  if (!/^sip:[A-Za-z0-9_.+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?;transport=tcp$/.test(route.agoraSip || "")) {
    throw new Error("Agora 地址须为 sip:用户@主机:端口;transport=tcp，不支持其他拨号语法");
  }
  const port = route.agoraSip.match(/:(\d+);transport=/)?.[1];
  if (port && (Number(port) < 1 || Number(port) > 65535)) throw new Error("SIP 端口无效");
  return route;
}

function buildOriginate(call, route, domain) {
  validateRoute(route);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(domain)) throw new Error("SIP_DOMAIN 无效");
  for (const id of [call.switchUuid, call.agentUuid, call.jobUuid]) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid call UUID");
  }
  const vars = [
    `origination_uuid=${call.switchUuid}`, "origination_caller_id_name=AgoraDemo",
    "origination_caller_id_number=9000", "originate_timeout=30", "ignore_early_media=true",
    "hangup_after_bridge=true", "continue_on_fail=false", "call_timeout=45",
    "bridge_answer_timeout=45", "bypass_media=false", "proxy_media=false"
  ].join(",");
  // originate runs its application only AFTER A answers. A 183/early-media
  // response is explicitly ignored, so it cannot start the AI prematurely.
  const { headers } = prepareSipInput(call.taskId, call.agoraInput?.payload);
  // B-leg only. Both values have delimiter-safe alphabets (alphanumeric / Base64).
  const sipHeaders = Object.entries(headers).map(([name, value]) => `sip_h_${name}=${value}`).join(',');
  const bridge = `[origination_uuid=${call.agentUuid},leg_timeout=45,ignore_early_media=true,${sipHeaders}]sofia/external/${route.agoraSip.slice(4)}`;
  return `bgapi originate {${vars}}user/${route.extension}@${domain} &bridge(${bridge})\nJob-UUID: ${call.jobUuid}`;
}

function finish(call, cause, now = new Date().toISOString()) {
  if (call.endedAt) return;
  call.endedAt = now;
  call.hangupCause = cause;
  call.durationSec = call.bridgedAt ? Math.max(0, Math.round((Date.parse(now) - Date.parse(call.bridgedAt)) / 1000)) : 0;
  if (call.timingIncomplete) call.durationSec = null;
  if (call.bridgedAt || call.wasBridged) call.status = "已完成";
  else if (call.cancelRequested || ["ORIGINATOR_CANCEL", "USER_BUSY", "CALL_REJECTED", "NO_ANSWER", "NO_USER_RESPONSE", "ALLOTTED_TIMEOUT"].includes(cause)) call.status = "未接通";
  else call.status = "呼叫失败";
  if (!call.resultReceivedAt) call.summary = (call.bridgedAt || call.wasBridged)
    ? `通话已结束（${cause}），等待 Agora 结果回传。`
    : `通话未建立：${cause}${call.agentHangupCause ? ` / Agora: ${call.agentHangupCause}` : ""}`;
}

function applyEvent(call, event) {
  const name = event["Event-Name"];
  if (!isActive(call)) return false;
  if (name === "BACKGROUND_JOB" && event["Job-UUID"] === call.jobUuid) {
    if ((event._body || "").trim().startsWith("-ERR")) finish(call, event._body.trim().slice(5));
    return true;
  }
  const uuid = event["Unique-ID"];
  if (uuid === call.agentUuid) {
    if (name === "CHANNEL_CREATE" && call.agoraInput?.deliveryStatus === "prepared") call.agoraInput.deliveryStatus = "attempted";
    if (name === "CHANNEL_HANGUP_COMPLETE") call.agentHangupCause = event["Hangup-Cause"];
    return true;
  }
  if (uuid !== call.switchUuid) return false;
  const timestamp = Number(event["Event-Date-Timestamp"]);
  const now = timestamp ? new Date(timestamp / 1000).toISOString() : new Date().toISOString();
  if (["CHANNEL_PROGRESS", "CHANNEL_PROGRESS_MEDIA"].includes(name) && !call.answeredAt) call.status = "分机振铃";
  if (name === "CHANNEL_ANSWER" && !call.bridgedAt) {
    call.answeredAt = now;
    call.status = "正在连接 AI";
    if (!call.resultReceivedAt) call.summary = "分机已接听，正在连接 Agora Voice Agent。";
  }
  if (name === "CHANNEL_BRIDGE") {
    if (call.agoraInput?.sip && call.agoraInput.deliveryStatus !== "callback_received") call.agoraInput.deliveryStatus = "bridged";
    call.bridgedAt ||= now;
    call.answeredAt ||= now;
    call.status = "通话中";
    if (!call.resultReceivedAt) call.summary = "分机与 Agora Voice Agent 正在通话。";
  }
  if (name === "CHANNEL_HANGUP_COMPLETE") finish(call, event["Hangup-Cause"] || "UNKNOWN", now);
  return true;
}

class Telephony {
  constructor({ readDb, writeDb, env = process.env }) {
    this.readDb = readDb;
    this.writeDb = writeDb;
    this.domain = env.SIP_DOMAIN || "demo.local";
    this.client = new EslClient({ host: env.FREESWITCH_HOST || "127.0.0.1", port: Number(env.FREESWITCH_ESL_PORT || 8021), password: env.FREESWITCH_ESL_PASSWORD });
    this.lastError = "尚未连接 FreeSWITCH";
    this.synchronized = false;
    this.client.on("event", event => this.update(db => {
      for (const call of db.calls) if (applyEvent(call, event)) this.updateHistory(db, call);
    }));
    this.client.on("disconnected", error => {
      this.synchronized = false;
      this.lastError = error.message;
      this.update(db => {
        for (const call of db.calls.filter(isActive)) call.status = "状态待确认";
      });
    });
    this.client.on("ready", () => this.reconcile().then(() => {
      if (this.client.ready) { this.synchronized = true; this.lastError = ""; }
    }).catch(error => { this.lastError = error.message; this.client.close(); }));
  }
  update(fn) { const db = this.readDb(); fn(db); this.writeDb(db); }
  updateHistory(db, call) {
    const debtor = db.debtors.find(item => item.id === call.debtorId);
    const history = debtor?.history.find(item => item.callId === call.id);
    if (history) Object.assign(history, { result: call.status, summary: call.summary, nextAction: call.endedAt ? "待质检 / 复催" : "等待通话结束" });
    if (debtor && call.endedAt && !call.resultReceivedAt && debtor.repaymentStatus !== "已还款") debtor.collectionStatus = "需复催";
  }
  start() {
    const connect = () => this.client.connect().catch(error => { this.lastError = error.message; });
    connect();
    this.timer = setInterval(connect, 3000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.client.close(); }
  status() { return { connected: this.client.ready && this.synchronized, domain: this.domain, error: this.lastError }; }
  ids() { return { switchUuid: randomUUID(), agentUuid: randomUUID(), jobUuid: randomUUID() }; }
  async originate(call, route) {
    if (!this.status().connected) throw new Error("FreeSWITCH 未就绪，请检查通话路由页中的连接状态");
    const reply = await this.client.command(buildOriginate(call, route, this.domain));
    if (!reply.startsWith("+OK")) throw new Error(reply);
  }
  async hangup(call) {
    const reply = await this.client.api(`uuid_kill ${call.switchUuid} ORIGINATOR_CANCEL`);
    if (!reply.startsWith("+OK")) throw new Error(reply);
  }
  async reconcile() {
    // Reconnects/restarts can miss events. Do not guess that a live call ended.
    for (const saved of this.readDb().calls.filter(isActive)) {
      const exists = await this.client.api(`uuid_exists ${saved.switchUuid}`);
      if (!["true", "false"].includes(exists)) throw new Error("无法核对 FreeSWITCH 通话状态");
      let bridged, answered, bridgeEpoch;
      if (exists === "true") {
        bridged = await this.client.api(`uuid_getvar ${saved.switchUuid} bridge_uuid`);
        answered = await this.client.api(`uuid_getvar ${saved.switchUuid} answer_epoch`);
        bridgeEpoch = await this.client.api(`uuid_getvar ${saved.switchUuid} bridge_epoch`);
      }
      this.update(db => {
        const call = db.calls.find(item => item.id === saved.id);
        if (!call || !isActive(call)) return;
        if (exists === "false") {
          finish(call, "EVENTS_LOST");
          call.status = "已结束（状态未完整同步）";
          call.durationSec = null;
          if (!call.resultReceivedAt) call.summary = "连接中断期间通话已结束，时长及结束原因需核对 FreeSWITCH 日志或 Agora 回传。";
        } else if (bridged === call.agentUuid) {
          call.status = "通话中";
          call.wasBridged = true;
          if (!call.bridgedAt && Number(bridgeEpoch) > 0) call.bridgedAt = new Date(Number(bridgeEpoch) * 1000).toISOString();
          if (!call.bridgedAt) call.timingIncomplete = true;
        } else if (Number(answered) > 0) {
          call.answeredAt ||= new Date(Number(answered) * 1000).toISOString();
          call.status = "正在连接 AI";
        } else call.status = "分机呼叫中";
        this.updateHistory(db, call);
      });
    }
  }
}

module.exports = { Telephony, DEFAULT_AGORA_SIP, isActive, validateRoute, buildOriginate, applyEvent, finish };
