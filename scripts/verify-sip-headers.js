// Opt-in wire test: node scripts/verify-sip-headers.js --docker
// Uses an isolated network and fake endpoints; never contacts Agora.
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { EslClient } = require('../lib/esl');
const { buildOriginate } = require('../lib/telephony');
const { newTaskId, prepareSipInput, MAX_CUSTOMER_HEADER_BYTES } = require('../lib/agora-sip');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (check()) return; await delay(30); }
  throw new Error(`Timed out: ${description}`);
}
function attach(socket, receive) {
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const lines = buffer.subarray(0, end).toString().split('\r\n');
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i >= 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
      }
      const length = end + 4 + Number(headers['content-length'] || 0);
      if (buffer.length < length) return;
      const raw = buffer.subarray(0, length); buffer = buffer.subarray(length);
      receive({ first: lines[0], headers, raw }, socket);
    }
  });
}
function reply(message, socket, code, reason, body = '') {
  const h = message.headers;
  socket.write(`SIP/2.0 ${code} ${reason}\r\nVia: ${h.via}\r\nFrom: ${h.from}\r\nTo: ${h.to}${h.to.includes(';tag=') ? '' : ';tag=fixture'}\r\nCall-ID: ${h['call-id']}\r\nCSeq: ${h.cseq}\r\nContact: <sip:fixture@172.31.89.3:5070;transport=tcp>\r\n${body ? 'Content-Type: application/sdp\r\n' : ''}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
async function wireTest() {
  const sockets = new Set();
  let current, failure;
  const sdp = 'v=0\r\no=fixture 1 1 IN IP4 172.31.89.3\r\ns=fixture\r\nc=IN IP4 172.31.89.3\r\nt=0 0\r\nm=audio 19000 RTP/AVP 0 8\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\na=sendrecv\r\n';
  const listen = async (port, handler) => {
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('error', error => { failure ||= error; });
      attach(socket, (message, conn) => { try { handler(message, conn); } catch (error) { failure ||= error; } });
    });
    server.listen(port, '0.0.0.0'); await once(server, 'listening'); return server;
  };
  const softphone = await listen(5070, (message, socket) => {
    if (message.first.startsWith('INVITE ')) {
      assert.equal(message.headers['x-switch-id'], undefined);
      assert.equal(message.headers['x-customer-str'], undefined);
      current.aInvite = true;
      reply(message, socket, 183, 'Session Progress', sdp);
      setTimeout(() => {
        if (current.bInvite) failure ||= new Error('Agora dialed before extension answered');
        current.answered = true;
        reply(message, socket, 200, 'OK', sdp);
      }, 200);
    } else if (message.first.startsWith('BYE ')) reply(message, socket, 200, 'OK');
  });
  const agora = await listen(5090, (message, socket) => {
    if (message.first.startsWith('INVITE ')) {
      assert.ok(current.answered);
      const expected = prepareSipInput(current.call.taskId, current.call.agoraInput.payload);
      assert.equal(message.headers['x-switch-id'], current.call.taskId);
      assert.equal(message.headers['x-customer-str'], expected.headers['X-Customer-Str']);
      assert.deepEqual(JSON.parse(Buffer.from(message.headers['x-customer-str'], 'base64').toString('utf8')), current.call.agoraInput.payload);
      current.bInvite = true; current.messageBytes = message.raw.length;
      reply(message, socket, 200, 'OK', sdp);
    } else if (message.first.startsWith('BYE ')) reply(message, socket, 200, 'OK');
  });
  const esl = new EslClient({ host: 'sip-header-fs', password: process.env.FREESWITCH_ESL_PASSWORD, timeout: 15000 });
  try {
    for (let i = 0; i < 40; i++) {
      try { await esl.connect(); if ((await esl.api('sofia status')).includes('internal')) break; } catch {}
      await delay(500);
    }
    assert.ok(esl.ready, 'FreeSWITCH ready');
    console.log('FreeSWITCH:', await esl.api('version'));
    const register = net.createConnection({ host: 'sip-header-fs', port: 5060 });
    sockets.add(register); await once(register, 'connect');
    let response;
    attach(register, message => { response = message; });
    const callId = randomUUID();
    const sendRegister = (seq, auth = '') => {
      response = null;
      register.write(`REGISTER sip:demo.local SIP/2.0\r\nVia: SIP/2.0/TCP 172.31.89.3:5070;branch=z9hG4bK${randomBytes(6).toString('hex')}\r\nMax-Forwards: 70\r\nFrom: <sip:1001@demo.local>;tag=registration\r\nTo: <sip:1001@demo.local>\r\nCall-ID: ${callId}\r\nCSeq: ${seq} REGISTER\r\nContact: <sip:1001@172.31.89.3:5070;transport=tcp>\r\nExpires: 120\r\n${auth}Content-Length: 0\r\n\r\n`);
    };
    sendRegister(1); await until(() => response, 'REGISTER challenge');
    assert.match(response.first, /401/);
    const challenge = response.headers['www-authenticate'];
    const realm = challenge.match(/realm="([^"]+)"/)[1], nonce = challenge.match(/nonce="([^"]+)"/)[1];
    const md5 = value => createHash('md5').update(value).digest('hex');
    const digest = md5(`${md5(`1001:${realm}:${process.env.SIP_EXTENSION_PASSWORD}`)}:${nonce}:00000001:fixture:auth:${md5('REGISTER:sip:demo.local')}`);
    sendRegister(2, `Authorization: Digest username="1001", realm="${realm}", nonce="${nonce}", uri="sip:demo.local", response="${digest}", algorithm=MD5, qop=auth, nc=00000001, cnonce="fixture"\r\n`);
    await until(() => response, 'REGISTER accepted'); assert.match(response.first, /200/);
    esl.on('event', event => {
      if (current && event['Unique-ID'] === current.call.switchUuid && event['Event-Name'] === 'CHANNEL_BRIDGE') current.bridged = true;
    });
    for (const target of [2048, 16384, MAX_CUSTOMER_HEADER_BYTES]) {
      const payload = { agent_properties: { llm: { template_variables: { name: '朱秀兰😀', call_context: '' } } } };
      const padding = target * 3 / 4 - Buffer.byteLength(JSON.stringify(payload));
      payload.agent_properties.llm.template_variables.call_context = 'x'.repeat(padding);
      const call = { taskId: newTaskId(), switchUuid: randomUUID(), agentUuid: randomUUID(), jobUuid: randomUUID(), agoraInput: { payload } };
      current = { call };
      assert.equal(prepareSipInput(call.taskId, payload).customerHeaderBytes, target);
      const result = await esl.command(buildOriginate(call, { extension: '1001', agoraSip: 'sip:fixture@172.31.89.3:5090;transport=tcp' }, 'demo.local'));
      assert.match(result, /^\+OK/);
      await until(() => failure || current.bridged, `bridge with ${target} bytes`);
      if (failure) throw failure;
      assert.ok(current.aInvite && current.bInvite);
      console.log(`PASS X-Customer-Str=${target} bytes; INVITE=${current.messageBytes} bytes; taskId matched; JSON byte-perfect; A-leg has no custom headers; bridged after answer`);
      await esl.api(`uuid_kill ${call.switchUuid} NORMAL_CLEARING`);
      await delay(500);
    }
  } finally {
    esl.close(); for (const socket of sockets) socket.destroy(); softphone.close(); agora.close();
  }
}
function dockerTest() {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-header-wire-'));
  const suffix = randomBytes(4).toString('hex');
  const network = `sip-header-${suffix}`, fsName = `${network}-fs`, testName = `${network}-test`;
  const root = path.resolve(__dirname, '..');
  const envFile = path.join(dir, 'fixture.env');
  fs.writeFileSync(envFile, `FREESWITCH_ESL_PASSWORD=${randomBytes(24).toString('hex')}\nSIP_EXTENSION_PASSWORD=${randomBytes(24).toString('hex')}\n`, { mode: 0o600 });
  // An internal-only Docker network has no default route for auto-detection.
  // Pin the fixture bind address; all other profile settings stay unchanged.
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir);
  fs.copyFileSync(path.join(root, 'deploy/freeswitch/entrypoint.sh'), path.join(configDir, 'entrypoint.sh'));
  fs.writeFileSync(path.join(configDir, 'freeswitch.xml.template'), fs.readFileSync(path.join(root, 'deploy/freeswitch/freeswitch.xml.template'), 'utf8').replaceAll('$${local_ip_v4}', '172.31.89.2'));
  const docker = args => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error));
    return result.stdout.trim();
  };
  try {
    docker(['network', 'create', '--internal', '--subnet', '172.31.89.0/24', network]);
    docker(['run', '-d', '--name', fsName, '--network', network, '--network-alias', 'sip-header-fs', '--ip', '172.31.89.2', '--platform', 'linux/amd64', '--env-file', envFile,
      '-e', 'FREESWITCH_PUBLIC_IP=172.31.89.2', '-e', 'SIP_DOMAIN=demo.local', '-e', 'ESL_ALLOWED_CIDR=172.31.89.0/24',
      '-v', `${configDir}:/opt/demo:ro`, '--entrypoint', '/bin/sh',
      'safarov/freeswitch@sha256:f156e01a96d48944078ed7f0e24304be63ea15f6466cf607a0aeb6cb47761da7', '/opt/demo/entrypoint.sh']);
    console.log(docker(['run', '--rm', '--name', testName, '--network', network, '--ip', '172.31.89.3', '--env-file', envFile,
      '-v', `${root}/lib:/app/lib:ro`, '-v', `${root}/scripts:/app/scripts:ro`, '-w', '/app', 'node:22-bookworm-slim', 'node', 'scripts/verify-sip-headers.js', '--fixture']));
  } finally {
    for (const args of [['rm', '-f', testName, fsName], ['network', 'rm', network]]) spawnSync('docker', args, { stdio: 'ignore', timeout: 15000 });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv.includes('--docker')) dockerTest();
else if (process.argv.includes('--fixture')) wireTest().catch(error => { console.error(error); process.exit(1); });
else console.log('Usage: node scripts/verify-sip-headers.js --docker');
