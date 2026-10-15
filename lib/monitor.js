const net = require('node:net');
const fs = require('node:fs');
const { isActive, validateRoute } = require('./telephony');

const AGENTS = ['通话计划生成Agent', '债务人全生命周期策略编排Agent', '金标质检Agent', '分案管理员Agent'];

function parseRegistrations(output) {
  const count = output.match(/Total items returned:\s*(\d+)/);
  if (!count) throw new Error('无法读取 SIP 注册列表');
  const rows = [];
  for (const block of output.split(/(?=Call-ID:\s*)/).slice(1)) {
    const fields = {};
    for (const line of block.split('\n')) {
      const match = line.match(/^([\w-]+):\s*(.*)$/);
      if (match) fields[match[1]] = match[2].trim();
    }
    const user = fields.User?.match(/^(.+)@(.+)$/);
    if (!user) continue;
    const expiresSec = Number(fields.Status?.match(/EXPSECS\((-?\d+)\)/)?.[1]);
    rows.push({ extension: user[1], domain: user[2], contact: fields.Contact || '',
      agent: fields.Agent || '', ip: fields.IP || '', transport: fields.Status?.match(/Registered\(([^)]+)\)/)?.[1] || '',
      expiresSec: Number.isFinite(expiresSec) ? expiresSec : null,
      registered: /^Registered\(/.test(fields.Status || '') && (!Number.isFinite(expiresSec) || expiresSec > 0) });
  }
  if (rows.length !== Number(count[1])) throw new Error('SIP 注册列表格式不完整');
  return rows;
}

function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let finished = false;
    const finish = (reachable, error = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ reachable, latencyMs: Date.now() - started, error });
    };
    // Covers DNS lookup as well as the TCP handshake. No INVITE is sent.
    const timer = setTimeout(() => finish(false, '连接超时'), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(false, error.code || error.message));
  });
}

class ServiceMonitor {
  constructor({ telephony, readDb, dataFile, env = process.env, probe = probeTcp, cacheMs = 10000 }) {
    Object.assign(this, { telephony, readDb, dataFile, env, probe, cacheMs });
    this.cached = null;
    this.pending = null;
  }
  async snapshot() {
    const db = this.readDb();
    const connection = this.telephony.status();
    const key = JSON.stringify([connection.connected, db.routes]);
    if (this.cached && this.key === key && Date.now() - Date.parse(this.cached.checkedAt) < this.cacheMs) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.collect(db, connection).then(result => {
      this.key = key;
      this.cached = result;
      return result;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect(db, connection) {
    const [switchResult, agora] = await Promise.all([
      this.checkSwitch(connection), this.checkAgora(db, connection)
    ]);
    let storage;
    try {
      fs.accessSync(this.dataFile, fs.constants.R_OK | fs.constants.W_OK);
      storage = { name: '业务数据存储', status: 'ok', label: '运行正常', detail: `JSON 数据已读取，文件读写权限正常；${db.debtors.length} 位债务人，${db.calls.length} 条通话记录。` };
    } catch (error) {
      storage = { name: '业务数据存储', status: 'error', label: '访问异常', detail: error.code || error.message };
    }
    const extensions = new Map();
    for (const route of db.routes) {
      if (!/^\d{2,10}$/.test(route.extension || '')) continue;
      const id = `${route.extension}@${connection.domain}`;
      if (!extensions.has(id)) extensions.set(id, { extension: route.extension, domain: connection.domain, routeNames: [], registrations: [] });
      extensions.get(id).routeNames.push(`${route.name}${route.enabled ? '' : '（停用）'}`);
    }
    for (const row of switchResult.registrations || []) {
      const id = `${row.extension}@${row.domain}`;
      if (!extensions.has(id)) extensions.set(id, { extension: row.extension, domain: row.domain, routeNames: [], registrations: [] });
      extensions.get(id).registrations.push(row);
    }
    for (const extension of extensions.values()) {
      const registered = extension.registrations.some(row => row.registered);
      Object.assign(extension, switchResult.registrations === null
        ? { status: 'unknown', label: '状态未知' }
        : registered ? { status: 'ok', label: '已注册' } : { status: 'warning', label: '未注册' });
    }
    const lastWebhook = db.calls.map(call => call.resultReceivedAt).filter(Boolean).sort().pop() || null;
    return {
      checkedAt: new Date().toISOString(), refreshIntervalSec: this.cacheMs / 1000,
      services: [
        { name: 'Node.js / Web API', status: 'ok', label: '运行正常', detail: `${process.version} · 当前监控请求已成功处理`, uptimeSec: Math.floor(process.uptime()), memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024) },
        { name: 'FreeSWITCH', ...switchResult.service },
        { name: '呼叫控制 / ESL 事件同步', status: connection.connected ? 'ok' : 'error', label: connection.connected ? '运行正常' : '未就绪', detail: connection.connected ? '控制连接已认证，通话事件已订阅且状态同步完成。' : connection.error || 'FreeSWITCH 未连接' },
        storage,
        { name: 'Agora 结果回传接口', status: this.env.AGORA_WEBHOOK_TOKEN ? 'ok' : 'warning', label: this.env.AGORA_WEBHOOK_TOKEN ? '已启用' : '待配置', detail: '由 Node.js 提供接收接口；已启用不代表 Agora 已配置回调。', lastWebhook }
      ],
      extensions: [...extensions.values()],
      registrationError: switchResult.registrationError,
      agora,
      agents: AGENTS.map(name => ({ name, status: 'ok', label: '运行正常', simulated: true, detail: '演示状态 · 待接入真实 Agent' }))
    };
  }
  async checkSwitch(connection) {
    if (!connection.connected) return { service: { status: 'error', label: '连接异常', detail: connection.error || 'ESL 未就绪，无法确认进程状态。' }, registrations: null, registrationError: 'FreeSWITCH 未连接，无法读取注册状态。' };
    const results = await Promise.allSettled(['status', 'sofia status', 'sofia status profile internal reg'].map(command => this.telephony.client.api(command)));
    const value = index => results[index].status === 'fulfilled' ? results[index].value : '';
    const coreUp = /^UP\s/.test(value(0));
    const internal = /internal[^\n]*RUNNING/.test(value(1));
    const external = /external[^\n]*RUNNING/.test(value(1));
    let registrations = null;
    let registrationError = '';
    try {
      if (!internal) throw new Error('internal SIP profile 未就绪，无法确认分机注册状态。');
      registrations = parseRegistrations(value(2));
    } catch (error) { registrationError = error.message; }
    const healthy = coreUp && internal && external;
    return { service: { status: healthy ? 'ok' : 'error', label: healthy ? '运行正常' : '检查异常',
      detail: `核心进程：${coreUp ? '响应正常' : '未确认'}；分机 SIP：${internal ? '运行中' : '未就绪'}；外呼 SIP：${external ? '运行中' : '未就绪'}`,
      version: value(0).match(/FreeSWITCH \(Version ([^)]+)\)/)?.[1] || '',
      uptime: coreUp ? value(0).split('\n')[0].trim() : '',
      error: results.filter(result => result.status === 'rejected').map(result => result.reason.message).join('；') }, registrations, registrationError };
  }
  async checkAgora(db, connection) {
    const routes = db.routes.filter(route => route.enabled);
    const targets = [...new Set(routes.map(route => route.agoraSip))];
    return Promise.all(targets.map(async uri => {
      let result;
      try {
        validateRoute({ extension: '1001', agoraSip: uri });
        const [, host, port] = uri.match(/@([^:;]+)(?::(\d+))?;transport=tcp$/);
        result = await this.probe(host, Number(port || 5060));
      } catch (error) { result = { reachable: false, latencyMs: null, error: error.message }; }
      const matching = db.calls.filter(call => call.provider === 'freeswitch' && call.agoraSip === uri);
      const activeCount = connection.connected ? matching.filter(call => isActive(call) && call.status === '通话中').length : 0;
      const latest = matching.filter(call => call.bridgedAt).sort((a, b) => Date.parse(b.bridgedAt) - Date.parse(a.bridgedAt))[0];
      return { uri, ...result, activeCount, lastConnectedAt: latest?.bridgedAt || null,
        status: activeCount ? 'ok' : result.reachable ? 'info' : 'warning',
        label: activeCount ? '通话已连接' : result.reachable ? 'SIP 入口可达' : 'SIP 入口不可达',
        botStatus: activeCount ? '存在已桥接会话，AI 对话质量仍需通话验证。' : '待验证：尚未接入 Agora VoiceBot 的运行状态 API。',
        detail: 'TCP 检查由 Web 服务发起，不拨打电话；入口可达不代表 VoiceBot 已启动或音频正常。' };
    }));
  }
}

module.exports = { ServiceMonitor, parseRegistrations, probeTcp };
