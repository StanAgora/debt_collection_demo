const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildAgoraInput, moneyInChinese } = require('../lib/agora-input');

function fixture() {
  const debtor = { id: 'd1', name: '朱秀兰', debtApp: '钱小乐', platform: '召集令', acquisitionChannel: '榕树贷', amount: 296.4,
    overduePeriods: 3, gender: '女', hasComplaintHistory: true, hasPromise: true,
    promise: { date: '2026-10-20', amount: 100 }, callHistorySummary: '人工维护的全部通话总结',
    history: [{ id: 'h1', callId: 'old', summary: '重复的旧记录', time: '2026-10-05T01:00:00Z' },
      { id: 'imported', summary: '历史导入摘要', result: '已接通', time: '2026-10-04T01:00:00Z' }] };
  const calls = [
    { id: 'old', debtorId: 'd1', startedAt: '2026-10-05T01:00:00Z', answeredAt: '2026-10-05T01:00:05Z', status: '已完成', summary: '曾提出投诉', webhookPayload: { promiseDate: '2026-10-20' } },
    { id: 'last', debtorId: 'd1', startedAt: '2026-10-06T05:06:00Z', endedAt: '2026-10-06T05:06:30Z', status: '未接通', summary: '本次无人接听' },
    { id: 'other', debtorId: 'd2', startedAt: '2026-10-07T01:00:00Z', summary: '其他客户隐私' }
  ];
  return { debtor, calls };
}

test('preview maps known facts, separates previous call from global history, and omits unavailable policy', () => {
  const { debtor, calls } = fixture();
  const result = buildAgoraInput(debtor, calls);
  const vars = result.payload.agent_properties.llm.template_variables;
  assert.equal(result.deliveryStatus, 'not_sent');
  assert.equal(vars.app_name, '钱小乐');
  assert.equal(vars.platform, '召集令');
  assert.equal(vars.channel, '榕树贷');
  assert.equal(vars.overdue, '296元4角');
  assert.equal(vars.contract_overdue, '3');
  assert.equal(vars.calls_records_time, '2026-10-06T13:06:00+08:00');
  assert.equal(vars.calls_records_connected, '否');
  assert.equal(vars.complaint, '有');
  assert.equal(result.previousCallId, 'last');
  assert.equal(result.historyCount, 3);
  for (const field of ['calls_records_prev_complaint', 'calls_records_prev_commit_time', 'calls_records_prev_ability', 'calls_records_prev_debtor_self', 'max_ptp_date', 'contract_total', 'contract_paid', 'contract_unpaid', 'permission', 'redline', 'strategy', 'target']) {
    assert.equal(Object.hasOwn(vars, field), false, field);
    assert.ok(result.omitted.some(item => item.field === field), field);
  }
  for (const summary of ['人工维护的全部通话总结', '历史导入摘要', '曾提出投诉', '本次无人接听']) assert.ok(vars.call_context.includes(summary));
  assert.doesNotMatch(vars.call_context, /其他客户隐私|重复的旧记录/);
  assert.ok(vars.call_context.indexOf('历史导入摘要') < vars.call_context.indexOf('曾提出投诉'));
  assert.ok(Object.values(vars).every(value => typeof value === 'string'));
});

test('no-history and unknown facts are not invented; previous promise must be attached to that call', () => {
  const empty = buildAgoraInput({ id: 'new', name: '新客户', gender: '未知', amount: 0, overduePeriods: 0 }, []);
  const vars = empty.payload.agent_properties.llm.template_variables;
  assert.equal(vars.call_context, '暂无历史通话记录。');
  assert.equal(vars.overdue, '0元');
  assert.equal(vars.contract_overdue, '0');
  for (const key of ['gender', 'commitment', 'complaint', 'calls_records_time', 'calls_records_connected']) assert.equal(Object.hasOwn(vars, key), false);
  const { debtor, calls } = fixture();
  calls.find(item => item.id === 'last').webhookPayload = { promiseDate: '2026-10-18' };
  assert.equal(buildAgoraInput(debtor, calls).payload.agent_properties.llm.template_variables.calls_records_prev_commit_time, '2026-10-18');
});

test('money formatting retains yuan, jiao and fen without truncating precision', () => {
  for (const [amount, expected] of [[296.4, '296元4角'], [296.45, '296元4角5分'], [0.05, '0元5分'], [1200, '1200元'], [0, '0元']]) assert.equal(moneyInChinese(amount), expected);
  for (const value of [null, undefined, '', -1, 'not-a-number']) assert.equal(moneyInChinese(value), null);
});

test('card preview is clickable independently of dialing, escapes JSON and closes safely while loading', async () => {
  const dom = { innerHTML: '' };
  const { debtor, calls } = fixture();
  debtor.name = '<script>unsafe()</script>';
  const preview = buildAgoraInput(debtor, calls);
  let resolveRequest;
  const response = new Promise(resolve => { resolveRequest = resolve; });
  const context = vm.createContext({ preview, response, localStorage: { getItem: () => null }, document: { getElementById: () => dom }, window: { setInterval() {}, setTimeout() {} }, Intl, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  vm.runInContext('api.token="test"; state.user={name:"测试"}; state.view="planned"; state.plannedCalls=[{debtorId:"d1",name:"测试",attempt:1}]; render();', context);
  assert.match(dom.innerHTML, /查看 Agora 入参/);
  assert.match(dom.innerHTML, /onclick="event.stopPropagation\(\)"/);
  const html = vm.runInContext('renderAgoraInputPreview(preview)', context);
  assert.match(html, /尚未发送给 Agora/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  vm.runInContext('api.get=()=>response; globalThis.pending=openAgoraInput("d1"); closeModal();', context);
  resolveRequest(preview);
  await context.pending;
  assert.equal(vm.runInContext('state.modal', context), null);
});
