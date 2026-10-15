const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { EslClient, FrameParser } = require('../lib/esl');
const { DEFAULT_AGORA_SIP, validateRoute, buildOriginate, applyEvent, finish } = require('../lib/telephony');

const freshCall = () => ({ taskId: 'Ab12345678901234', agoraInput: { payload: { agent_properties: { llm: { template_variables: { name: '测试' } } } } }, provider: 'freeswitch', switchUuid: randomUUID(), agentUuid: randomUUID(), jobUuid: randomUUID(), status: '分机呼叫中', endedAt: null });
function eventFrame(event) {
  const body = JSON.stringify(event);
  return Buffer.from(`Content-Type: text/event-json\nContent-Length: ${Buffer.byteLength(body)}\n\n${body}`);
}

test('ESL parser handles split UTF-8 and multiple frames in one packet', () => {
  const results = [];
  const wire = Buffer.concat([eventFrame({ text: '分机已接听' }), Buffer.from('Content-Type: command/reply\nReply-Text: +OK\n\n')]);
  const parser = new FrameParser(frame => results.push(frame));
  for (const byte of wire) parser.push(Buffer.from([byte]));
  assert.equal(JSON.parse(results[0].body).text, '分机已接听');
  assert.equal(results[1].headers['reply-text'], '+OK');
});

test('dial plan validates addresses and uses answer-dependent bridge, with early media ignored', () => {
  const call = freshCall();
  const command = buildOriginate(call, { extension: '1001', agoraSip: DEFAULT_AGORA_SIP }, 'demo.local');
  assert.match(command, /ignore_early_media=true/);
  assert.match(command, /user\/1001@demo.local &bridge\(/);
  assert.match(command, /sofia\/external\/gpcz0@cn-north-1-sbc.ai.agora.io:5060;transport=tcp/);
  assert.match(command, new RegExp(`Job-UUID: ${call.jobUuid}`));
  for (const uri of [DEFAULT_AGORA_SIP + '\napi shutdown', 'sip:x@host;transport=tcp|user/1002', 'sip:${system(x)}@host;transport=tcp', 'sip:x@host:99999;transport=tcp']) {
    assert.throws(() => validateRoute({ extension: '1001', agoraSip: uri }));
  }
  assert.throws(() => validateRoute({ extension: '1001,user/1002', agoraSip: DEFAULT_AGORA_SIP }));
});

test('early media never means answered; bridge and hangup reflect actual events', () => {
  const call = freshCall();
  const emit = (name, at, extra = {}) => applyEvent(call, { 'Event-Name': name, 'Unique-ID': call.switchUuid, 'Event-Date-Timestamp': String(at * 1000000), ...extra });
  emit('CHANNEL_PROGRESS_MEDIA', 1);
  assert.equal(call.status, '分机振铃');
  assert.equal(call.answeredAt, undefined);
  emit('CHANNEL_ANSWER', 2);
  assert.equal(call.status, '正在连接 AI');
  applyEvent(call, { 'Event-Name': 'CHANNEL_ANSWER', 'Unique-ID': call.agentUuid });
  assert.equal(call.status, '正在连接 AI');
  emit('CHANNEL_BRIDGE', 5);
  assert.equal(call.status, '通话中');
  emit('CHANNEL_PROGRESS', 6);
  assert.equal(call.status, '通话中');
  emit('CHANNEL_HANGUP_COMPLETE', 15, { 'Hangup-Cause': 'NORMAL_CLEARING' });
  assert.equal(call.durationSec, 10);
  assert.equal(call.status, '已完成');
  emit('CHANNEL_ANSWER', 16);
  assert.equal(call.status, '已完成');
});

test('unregistered, rejected, unanswered, failed B leg and duplicate completion stay terminal', () => {
  for (const cause of ['USER_NOT_REGISTERED', 'NO_ANSWER', 'CALL_REJECTED', 'USER_BUSY']) {
    const call = freshCall();
    applyEvent(call, { 'Event-Name': 'BACKGROUND_JOB', 'Job-UUID': call.jobUuid, _body: `-ERR ${cause}\n` });
    assert.ok(call.endedAt);
    assert.equal(call.durationSec, 0);
    const endedAt = call.endedAt;
    finish(call, 'NORMAL_CLEARING');
    assert.equal(call.endedAt, endedAt);
  }
  const call = freshCall();
  applyEvent(call, { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': call.agentUuid, 'Hangup-Cause': 'CALL_REJECTED' });
  assert.equal(call.endedAt, null);
  applyEvent(call, { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': call.switchUuid, 'Hangup-Cause': 'NORMAL_CLEARING' });
  assert.equal(call.status, '呼叫失败');
  assert.match(call.summary, /Agora: CALL_REJECTED/);
});

test('ESL authenticates, subscribes, separates events from replies and rejects pending commands on disconnect', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.write('Content-Type: auth/request\n\n');
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      let index;
      while ((index = input.indexOf('\n\n')) >= 0) {
        const command = input.slice(0, index); input = input.slice(index + 2);
        if (command === 'auth test-secret' || command.startsWith('event json ')) socket.write('Content-Type: command/reply\nReply-Text: +OK accepted\n\n');
        else if (command === 'api status') {
          socket.write(eventFrame({ 'Event-Name': 'CHANNEL_ANSWER', text: '接听' }));
          socket.write('Content-Type: api/response\nContent-Length: 2\n\nOK');
        } else socket.destroy();
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new EslClient({ port: server.address().port, password: 'test-secret', timeout: 1000 });
  t.after(() => { client.close(); for (const socket of sockets) socket.destroy(); server.close(); });
  await client.connect();
  const event = once(client, 'event');
  assert.equal(await client.api('status'), 'OK');
  assert.equal((await event)[0].text, '接听');
  await assert.rejects(client.api('disconnect'));
  assert.equal(client.ready, false);
});
