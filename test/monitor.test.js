const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ServiceMonitor, parseRegistrations, probeTcp } = require('../lib/monitor');
const { DEFAULT_AGORA_SIP } = require('../lib/telephony');

function registrations(seconds = 500) {
  return `Registrations:\nCall-ID: test\nUser: 1001@demo.local\nContact: <sip:1001@10.0.0.1:6000;transport=tcp>\nAgent: Test Softphone\nStatus: Registered(TCP)(unknown) EXP(2026-10-16 10:00:00) EXPSECS(${seconds})\nIP: 10.0.0.1\nTotal items returned: 1`;
}
function fixture() {
  const db = { debtors: [], calls: [], routes: [
    { id: 'r1', name: '默认路由', enabled: true, extension: '1001', agoraSip: DEFAULT_AGORA_SIP },
    { id: 'r2', name: '另一分机', enabled: false, extension: '1002', agoraSip: DEFAULT_AGORA_SIP }
  ] };
  let connected = true;
  let probes = 0;
  let reg = registrations();
  const telephony = { status: () => ({ connected, domain: 'demo.local', error: connected ? '' : 'ESL disconnected' }),
    client: { api: async command => {
      if (!connected) throw new Error('offline');
      return { status: 'UP 0 years, 1 days\nFreeSWITCH (Version 1.11.3) is ready', 'sofia status': 'internal profile sip:example RUNNING\nexternal profile sip:example RUNNING', 'sofia status profile internal reg': reg }[command];
    } } };
  const monitor = new ServiceMonitor({ telephony, readDb: () => db, dataFile: __filename, env: { AGORA_WEBHOOK_TOKEN: 'never-expose-this' }, probe: async () => { probes++; return { reachable: true, latencyMs: 12, error: '' }; } });
  return { monitor, db, telephony, disconnect: () => { connected = false; }, invalidRegistrations: () => { reg = '-ERR unavailable'; }, probes: () => probes };
}

test('registration parser distinguishes empty, expired and malformed replies', () => {
  assert.deepEqual(parseRegistrations('Registrations:\nTotal items returned: 0'), []);
  assert.equal(parseRegistrations(registrations())[0].registered, true);
  assert.equal(parseRegistrations(registrations(-1))[0].registered, false);
  assert.throws(() => parseRegistrations('-ERR profile missing'));
  assert.throws(() => parseRegistrations('Total items returned: 1'));
});

test('monitor shows real services, per-extension registration, honest Agora scope and four demo agents', async () => {
  const { monitor } = fixture();
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.services.find(item => item.name === 'FreeSWITCH').status, 'ok');
  assert.equal(snapshot.extensions.find(item => item.extension === '1001').label, '已注册');
  assert.equal(snapshot.extensions.find(item => item.extension === '1002').label, '未注册');
  assert.equal(snapshot.agora[0].label, 'SIP 入口可达');
  assert.match(snapshot.agora[0].botStatus, /待验证/);
  assert.equal(snapshot.agents.length, 4);
  assert.ok(snapshot.agents.every(item => item.status === 'ok' && item.simulated));
  assert.doesNotMatch(JSON.stringify(snapshot), /never-expose-this/);
});

test('cache shares concurrent probes and invalidates immediately on ESL disconnect', async () => {
  const f = fixture();
  await Promise.all([f.monitor.snapshot(), f.monitor.snapshot()]);
  await f.monitor.snapshot();
  assert.equal(f.probes(), 1);
  f.disconnect();
  const snapshot = await f.monitor.snapshot();
  assert.equal(f.probes(), 2);
  assert.equal(snapshot.services.find(item => item.name === 'FreeSWITCH').status, 'error');
  assert.ok(snapshot.extensions.every(item => item.status === 'unknown'));
  assert.match(snapshot.registrationError, /未连接/);
});

test('bad registration responses do not report all extensions as unregistered; bridged sessions are distinct from TCP health', async () => {
  const f = fixture();
  f.invalidRegistrations();
  f.db.calls.push({ provider: 'freeswitch', agoraSip: DEFAULT_AGORA_SIP, status: '通话中', bridgedAt: '2026-10-16T01:00:00Z', endedAt: null });
  const snapshot = await f.monitor.snapshot();
  assert.ok(snapshot.extensions.every(item => item.status === 'unknown'));
  assert.equal(snapshot.agora[0].label, '通话已连接');
  assert.equal(snapshot.agora[0].activeCount, 1);
});

test('TCP probe connects without sending a SIP call and reports refusal', async t => {
  let received = 0;
  const server = net.createServer(socket => socket.on('data', chunk => { received += chunk.length; }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  assert.equal((await probeTcp('127.0.0.1', port)).reachable, true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(received, 0);
  assert.equal((await probeTcp('127.0.0.1', port)).reachable, false);
});

test('monitor UI renders services and demo agents, and labels stale data on a failed refresh', async () => {
  const { monitor } = fixture();
  const snapshot = await monitor.snapshot();
  const dom = { innerHTML: '' };
  const context = vm.createContext({ snapshot, localStorage: { getItem: () => null }, document: { getElementById: () => dom }, window: { setInterval() {}, setTimeout() {} }, Intl, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  vm.runInContext('api.token="test"; state.user={name:"测试"}; state.monitor=snapshot; state.view="monitor"; render();', context);
  for (const label of ['Node.js / Web API', 'SIP Extension', 'Agora VoiceBot', '金标质检Agent', '演示状态', '待验证']) assert.ok(dom.innerHTML.includes(label), label);
  vm.runInContext('state.monitorError="网络断开"; render();', context);
  assert.match(dom.innerHTML, /监控请求失败/);
  assert.match(dom.innerHTML, /状态待确认/);
});
