const test = require('node:test');
const assert = require('node:assert/strict');
const { newTaskId, prepareSipInput, MAX_CUSTOMER_HEADER_BYTES, matchWebhookCall } = require('../lib/agora-sip');
const { buildOriginate, applyEvent } = require('../lib/telephony');
const { randomUUID } = require('node:crypto');
const payload = text => ({ agent_properties: { llm: { template_variables: { call_context: text } } } });

test('task IDs are 16 alphanumeric characters and UTF-8 Base64 preserves full payload and padding', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = newTaskId(); assert.match(id, /^[A-Za-z0-9]{16}$/); ids.add(id);
  }
  assert.equal(ids.size, 1000);
  for (const text of ['朱秀兰😀\n姓名,${x}{}[]', 'a', 'ab', 'abc']) {
    const input = payload(text), sip = prepareSipInput(newTaskId(), input);
    assert.deepEqual(JSON.parse(Buffer.from(sip.headers['X-Customer-Str'], 'base64').toString('utf8')), input);
    assert.match(sip.headers['X-Customer-Str'], /^[A-Za-z0-9+/]+={0,2}$/);
  }
  for (const id of ['short', 'abcdefghijklmnop\n', 'abcdefghijklmn,=']) assert.throws(() => prepareSipInput(id, payload('')));
});

test('SIP length guard accepts exact boundary, rejects oversize without truncation, and headers are B-leg only', () => {
  const empty = payload('');
  const length = MAX_CUSTOMER_HEADER_BYTES * 3 / 4 - Buffer.byteLength(JSON.stringify(empty));
  const input = payload('x'.repeat(length));
  const call = { taskId: newTaskId(), switchUuid: randomUUID(), agentUuid: randomUUID(), jobUuid: randomUUID(), agoraInput: { payload: input } };
  assert.equal(prepareSipInput(call.taskId, input).customerHeaderBytes, MAX_CUSTOMER_HEADER_BYTES);
  const cmd = buildOriginate(call, { extension: '1001', agoraSip: 'sip:test@localhost:5060;transport=tcp' }, 'demo.local');
  const [a, b] = cmd.split('&bridge(');
  assert.doesNotMatch(a, /sip_h_/);
  assert.match(b, /sip_h_X-Switch-Id=/);
  const encoded = b.match(/sip_h_X-Customer-Str=([A-Za-z0-9+/=]+)/)[1];
  assert.equal(encoded.length, MAX_CUSTOMER_HEADER_BYTES);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), input);
  assert.throws(() => prepareSipInput(call.taskId, payload('x'.repeat(length + 1))), /超过 SIP Header 上限/);
});

test('webhook aliases match only one call and reject missing, malformed, unknown or conflicting identifiers', () => {
  const calls = [{ id: 'call_1', taskId: 'Ab12345678901234', switchUuid: 'uuid_1' }, { id: 'call_2', taskId: 'Cd12345678901234' }];
  for (const alias of ['taskId', 'task_id', 'switch_id', 'X-Switch-Id']) {
    assert.equal(matchWebhookCall(calls, { [alias]: calls[0].taskId }).call, calls[0]);
  }
  assert.equal(matchWebhookCall(calls, { callId: 'call_1' }).call, calls[0]);
  assert.equal(matchWebhookCall(calls, { switchUuid: 'uuid_1' }).call, calls[0]);
  assert.equal(matchWebhookCall(calls, {}).status, 400);
  assert.equal(matchWebhookCall(calls, { taskId: 123 }).status, 400);
  assert.equal(matchWebhookCall(calls, { taskId: 'Xx12345678901234', callId: 'call_1' }).status, 404);
  assert.equal(matchWebhookCall(calls, { taskId: calls[0].taskId, callId: 'call_2' }).status, 409);
  assert.equal(matchWebhookCall(calls, { taskId: calls[0].taskId, task_id: calls[1].taskId }).status, 409);
  assert.equal(matchWebhookCall([...calls, { ...calls[0], id: 'duplicate' }], { taskId: calls[0].taskId }).status, 409);
});

test('delivery metadata distinguishes preparation, B-leg attempt, bridge and correlated callback', () => {
  const call = { provider: 'freeswitch', switchUuid: 'A', agentUuid: 'B', agoraInput: { deliveryStatus: 'prepared', sip: {} } };
  applyEvent(call, { 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': 'B' });
  assert.equal(call.agoraInput.deliveryStatus, 'attempted');
  applyEvent(call, { 'Event-Name': 'CHANNEL_BRIDGE', 'Unique-ID': 'A' });
  assert.equal(call.agoraInput.deliveryStatus, 'bridged');
  call.agoraInput.deliveryStatus = 'callback_received';
  applyEvent(call, { 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': 'B' });
  applyEvent(call, { 'Event-Name': 'CHANNEL_BRIDGE', 'Unique-ID': 'A' });
  assert.equal(call.agoraInput.deliveryStatus, 'callback_received');
});
