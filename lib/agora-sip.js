const { randomInt } = require('node:crypto');

// Application guard for this deployment, not an assertion of Agora SBC limits.
const MAX_CUSTOMER_HEADER_BYTES = 64 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9]{16}$/;
const validTaskId = value => typeof value === 'string' && value.length === 16 && TASK_ID_PATTERN.test(value);

function newTaskId(calls = []) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const used = new Set(calls.map(call => call.taskId));
  let id;
  do { id = Array.from({ length: 16 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (used.has(id));
  return id;
}

function encodeInput(payload) {
  if (!payload?.agent_properties?.llm?.template_variables) throw new Error('缺少 Agora 入参快照');
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, 'utf8').toString('base64');
  return {
    encoded, jsonBytes: Buffer.byteLength(json, 'utf8'), customerHeaderBytes: encoded.length,
    maxCustomerHeaderBytes: MAX_CUSTOMER_HEADER_BYTES, withinLimit: encoded.length <= MAX_CUSTOMER_HEADER_BYTES
  };
}

function prepareSipInput(taskId, payload) {
  if (!validTaskId(taskId)) throw new Error('task ID 须为 16 位英文字母或数字');
  const { encoded, ...size } = encodeInput(payload);
  if (!size.withinLimit) throw new Error(`Agora 入参 Base64 长度 ${size.customerHeaderBytes} 字节，超过 SIP Header 上限 ${MAX_CUSTOMER_HEADER_BYTES} 字节；请精简通话历史总结后重试，参数未截断、未拨号`);
  return { ...size, headers: { 'X-Switch-Id': taskId, 'X-Customer-Str': encoded } };
}

// Accept explicit normalized aliases. All supplied identifiers must agree;
// an unknown task ID must never fall back to another call's local identifier.
function matchWebhookCall(calls, body) {
  const taskValues = ['taskId', 'task_id', 'switch_id', 'X-Switch-Id'].filter(key => body[key] !== undefined).map(key => body[key]);
  if (taskValues.some(value => !validTaskId(value))) return { status: 400, error: 'task ID 须为 16 位英文字母或数字' };
  if (new Set(taskValues).size > 1) return { status: 409, error: '回调中的 task ID 不一致' };
  const identifiers = [
    ...(taskValues.length ? [['taskId', taskValues[0]]] : []),
    ...['callId', 'switchUuid'].filter(key => body[key] !== undefined).map(key => [key === 'callId' ? 'id' : key, body[key]])
  ];
  if (!identifiers.length || identifiers.some(([, value]) => typeof value !== 'string' || !value)) return { status: 400, error: '请提供 taskId（推荐）、callId 或 switchUuid' };
  const matches = identifiers.map(([key, value]) => calls.filter(call => call[key] === value));
  if (matches.some(items => !items.length)) return { status: 404, error: '未找到回调对应的通话' };
  if (matches.some(items => items.length !== 1 || items[0].id !== matches[0][0].id)) return { status: 409, error: '回调标识指向不同通话' };
  return { call: matches[0][0], matchedTaskId: taskValues.length > 0 };
}

module.exports = { MAX_CUSTOMER_HEADER_BYTES, newTaskId, encodeInput, prepareSipInput, matchWebhookCall };
