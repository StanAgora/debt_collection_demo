const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DEFAULT_AGORA_SIP } = require('../lib/telephony');

function eventFrame(event) {
  const body = JSON.stringify(event);
  return `Content-Type: text/event-json\nContent-Length: ${Buffer.byteLength(body)}\n\n${body}`;
}
async function waitFor(check) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timed out waiting for test condition');
}

test('HTTP + ESL integration: real task, duplicate guard, state events, webhook upsert, hangup, reconnect', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-sip-test-'));
  let socket;
  const commands = [];
  const live = new Map();
  const esl = net.createServer(connection => {
    socket = connection;
    connection.write('Content-Type: auth/request\n\n');
    let buffer = '';
    connection.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const command = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        commands.push(command);
        if (command.startsWith('auth ') || command.startsWith('event ')) connection.write('Content-Type: command/reply\nReply-Text: +OK\n\n');
        else if (command.startsWith('bgapi originate ')) {
          live.set(command.match(/origination_uuid=([^,]+)/)[1], true);
          connection.write('Content-Type: command/reply\nReply-Text: +OK Job-UUID: accepted\n\n');
        } else if (command.startsWith('api ')) {
          const parts = command.split(' ');
          let result = '+OK';
          if (parts[1] === 'uuid_exists') result = String(live.has(parts[2]));
          if (parts[1] === 'uuid_getvar') result = '_undef_';
          if (parts[1] === 'uuid_kill') {
            live.delete(parts[2]);
            connection.write(eventFrame({ 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': parts[2], 'Hangup-Cause': 'ORIGINATOR_CANCEL' }));
          }
          connection.write(`Content-Type: api/response\nContent-Length: ${Buffer.byteLength(result)}\n\n${result}`);
        }
      }
    });
  });
  esl.listen(0, '127.0.0.1'); await once(esl, 'listening');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', DATA_FILE: path.join(dir, 'db.json'), FREESWITCH_ESL_PORT: String(esl.address().port), FREESWITCH_ESL_PASSWORD: 'test-secret', AGORA_WEBHOOK_TOKEN: 'webhook-test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    child.kill(); await once(child, 'exit'); socket?.destroy(); esl.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  const port = await waitFor(() => output.match(/http:\/\/127.0.0.1:(\d+)/)?.[1]);
  let token;
  async function request(url, body, auth = token, method = 'POST') {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: body === undefined ? 'GET' : method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/api/monitor')).status, 401);
  assert.equal((await request('/api/debtors/debtor_chen/agora-input')).status, 401);
  token = (await request('/api/auth/login', { username: 'admin', password: 'admin123' })).body.token;
  const boot = async () => (await request('/api/bootstrap')).body;
  await waitFor(async () => (await boot()).telephony.connected);
  assert.equal((await boot()).routes[0].agoraSip, DEFAULT_AGORA_SIP);
  const migrated = (await boot()).debtors;
  for (const debtor of migrated) {
    assert.equal(debtor.debtApp, '钱小乐');
    assert.equal(debtor.platform, '召集令');
    assert.equal(debtor.acquisitionChannel, '榕树贷');
    assert.deepEqual(debtor.demoSourceFields, ['debtApp', 'platform', 'acquisitionChannel']);
  }
  assert.equal(migrated.find(item => item.id === 'debtor_wang').hasPromise, true);
  assert.equal(migrated.find(item => item.id === 'debtor_chen').hasComplaintHistory, null);
  const details = { name: '字段测试', phone: '10086', debtApp: '测试 APP', platform: '测试平台', acquisitionChannel: '官网',
    callHistorySummary: '第一次未接，第二次约定下周回访。', gender: '女', hasPromise: 'false', hasComplaintHistory: 'true', amount: 0, overduePeriods: 0 };
  const created = await request('/api/debtors', details);
  assert.equal(created.status, 201);
  const debtorId = created.body.debtor.id;
  for (const field of ['debtApp', 'platform', 'acquisitionChannel']) {
    const missing = { ...details }; delete missing[field];
    assert.equal((await request('/api/debtors', missing)).status, 400);
    assert.equal((await request(`/api/debtors/${debtorId}`, { [field]: '  ' }, token, 'PATCH')).status, 400);
    assert.equal((await request(`/api/debtors/${debtorId}`, { [field]: null }, token, 'PATCH')).status, 400);
  }
  assert.equal(created.body.debtor.hasPromise, false);
  assert.equal(created.body.debtor.hasComplaintHistory, true);
  assert.equal(created.body.debtor.callHistorySummary, details.callHistorySummary);
  const updated = await request(`/api/debtors/${debtorId}`, { hasComplaintHistory: 'false', gender: '未知' }, token, 'PATCH');
  assert.equal(updated.status, 200);
  assert.equal(updated.body.debtor.hasComplaintHistory, false);
  assert.equal(updated.body.debtor.debtApp, details.debtApp);
  assert.equal(updated.body.debtor.platform, details.platform);
  assert.equal(updated.body.debtor.acquisitionChannel, details.acquisitionChannel);
  assert.equal(updated.body.debtor.amount, 0);
  assert.equal((await request(`/api/debtors/${debtorId}`, { hasPromise: 'invalid' }, token, 'PATCH')).status, 400);
  await request('/api/debtors/debtor_wang', { promise: null }, token, 'PATCH');
  assert.equal((await boot()).debtors.find(item => item.id === 'debtor_wang').hasPromise, true);

  assert.equal((await request('/api/routes', { extension: '1001\napi shutdown', agoraSip: DEFAULT_AGORA_SIP })).status, 400);
  const preview = await request('/api/debtors/debtor_chen/agora-input');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.deliveryStatus, 'not_sent');
  assert.equal(preview.body.payload.agent_properties.llm.template_variables.platform, '召集令');
  assert.equal((await request('/api/debtors/not-found/agora-input')).status, 404);
  const started = await request('/api/calls/debtor_chen/start', {});
  assert.equal(started.status, 201);
  const call = started.body.call;
  assert.equal(call.answeredAt, null);
  assert.deepEqual(call.agoraInput.payload, preview.body.payload);
  assert.equal(call.agoraInput.deliveryStatus, 'prepared');
  assert.match(call.taskId, /^[A-Za-z0-9]{16}$/);
  const command = commands.find(item => item.startsWith('bgapi originate'));
  assert.ok(command.includes(`sip_h_X-Switch-Id=${call.taskId}`));
  assert.deepEqual(JSON.parse(Buffer.from(command.match(/sip_h_X-Customer-Str=([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf8')), call.agoraInput.payload);
  assert.equal(call.agoraInput.sip.headers['X-Switch-Id'], call.taskId);
  await request('/api/debtors/debtor_chen', { debtApp: '后续修改APP' }, token, 'PATCH');
  assert.deepEqual((await boot()).calls.find(item => item.id === call.id).agoraInput.payload, preview.body.payload);
  assert.ok(commands.some(command => command.includes('user/1001@demo.local &bridge(')));
  assert.equal((await request('/api/calls/debtor_li/start', {})).status, 409);
  const findCall = async () => (await boot()).calls.find(item => item.id === call.id);
  socket.write(eventFrame({ 'Event-Name': 'CHANNEL_ANSWER', 'Unique-ID': call.switchUuid }));
  await waitFor(async () => (await findCall()).status === '正在连接 AI');
  socket.write(eventFrame({ 'Event-Name': 'CHANNEL_BRIDGE', 'Unique-ID': call.switchUuid }));
  await waitFor(async () => (await findCall()).status === '通话中');
  const payload = { taskId: call.taskId, summary: '客户承诺明天还款', transcript: [{ speaker: '客户', text: '明天还' }], needRecall: true };
  assert.equal((await request('/api/webhooks/agora/calls', payload, 'bad-token')).status, 401);
  await request('/api/webhooks/agora/calls', payload, 'webhook-test');
  assert.equal((await findCall()).agoraInput.deliveryStatus, 'callback_received');
  assert.equal((await request('/api/webhooks/agora/calls', { ...payload, taskId: 'Unknown123456789', callId: call.id }, 'webhook-test')).status, 404);
  assert.equal((await request('/api/webhooks/agora/calls', { ...payload, callId: (await boot()).calls.find(item => item.id !== call.id).id }, 'webhook-test')).status, 409);
  await request('/api/webhooks/agora/calls', payload, 'webhook-test');
  assert.equal((await boot()).calls.filter(item => item.id === call.id).length, 1);
  assert.equal((await findCall()).status, '通话中');
  assert.equal((await request(`/api/calls/${call.id}/hangup`, {})).status, 200);
  await waitFor(async () => (await findCall()).endedAt);
  assert.equal((await findCall()).summary, payload.summary);
  assert.equal((await request(`/api/calls/${call.id}/complete-mock`, {})).status, 404);
  const second = (await request('/api/calls/debtor_li/start', {})).body.call;
  live.delete(second.switchUuid);
  socket.destroy();
  await waitFor(async () => (await boot()).calls.find(item => item.id === second.id).endedAt);
  const reconciled = (await boot()).calls.find(item => item.id === second.id);
  assert.equal(reconciled.status, '已结束（状态未完整同步）');
  assert.equal(reconciled.durationSec, null);
  assert.equal((await boot()).stats.activeCalls, 0);
  assert.notEqual(second.taskId, call.taskId);
  const countBefore = (await boot()).calls.length;
  const commandsBefore = commands.filter(item => item.startsWith('bgapi originate')).length;
  await request('/api/debtors/debtor_chen', { callHistorySummary: '很长的历史'.repeat(10000) }, token, 'PATCH');
  assert.equal((await request('/api/debtors/debtor_chen/agora-input')).body.sipSize.withinLimit, false);
  assert.equal((await request('/api/calls/debtor_chen/start', {})).status, 413);
  assert.equal((await boot()).calls.length, countBefore);
  assert.equal(commands.filter(item => item.startsWith('bgapi originate')).length, commandsBefore);
});
