const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page() {
  const dom = { innerHTML: '' };
  const context = vm.createContext({ localStorage: { getItem: () => null }, document: { getElementById: () => dom }, window: { setInterval() {}, setTimeout() {} }, Intl, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  vm.runInContext(`
    api.token = 'test'; state.user = { name: '测试', role: '管理员' };
    state.debtors = [{ id: 'a', name: '客户甲', phone: '1001', gender: '未知',
      history: [{ id: 'h1', callId: 'a1', time: '2026-10-15T01:00:00Z' },
        { id: 'h2', callId: 'legacy', time: '2026-10-14T01:00:00Z', summary: '导入记录', result: '未接通' }] },
      { id: 'empty', name: '暂无通话客户', history: [] }];
    state.calls = [
      { id: 'a1', debtorId: 'a', startedAt: '2026-10-15T01:00:00Z', status: '已完成', summary: '第一次通话' },
      { id: 'b1', debtorId: 'b', startedAt: '2026-10-16T01:00:00Z', summary: '其他客户内容' },
      { id: 'a2', debtorId: 'a', startedAt: '2026-10-15T02:00:00Z', status: '呼叫失败', summary: '<script>bad()</script>' }
    ];
  `, context);
  return { dom, context };
}

test('debtor history is scoped by ID, includes failures and legacy entries without duplication, newest first', () => {
  const { dom, context } = page();
  assert.equal(vm.runInContext('debtorCalls(state.debtors[0]).map(call => call.id).join(",")', context), 'a2,a1,legacy');
  vm.runInContext('openDebtorHistory("a")', context);
  assert.match(dom.innerHTML, /共 3 条记录/);
  assert.match(dom.innerHTML, /呼叫失败/);
  assert.match(dom.innerHTML, /导入记录/);
  assert.doesNotMatch(dom.innerHTML, /其他客户内容|<script>/);
  assert.match(dom.innerHTML, /&lt;script&gt;/);
  vm.runInContext('openHistoryCall("a1")', context);
  assert.equal(vm.runInContext('state.selectedCallId', context), 'a1');
  assert.equal(vm.runInContext('state.view', context), 'qa');
});

test('empty history and manually edited overall summary display without inventing facts', () => {
  const { dom, context } = page();
  vm.runInContext('openDebtorHistory("empty")', context);
  assert.match(dom.innerHTML, /该债务人暂无通话记录/);
  vm.runInContext('state.debtors[0].callHistorySummary = "整体总结"; openDebtorHistory("a")', context);
  assert.match(dom.innerHTML, /整体总结/);
  assert.equal(vm.runInContext('factLabel(null)', context), '未知');
});

test('demo source migration preserves existing values and snapshots, fills missing sources only once', () => {
  const { backfillDemoSources, debtorDetails, requireDebtorSources } = require('../lib/debtors');
  const debtor = { debtApp: '已有 APP', platform: ' ', acquisitionChannel: '已有渠道', history: [{ summary: '原历史' }] };
  const beforeHistory = JSON.stringify(debtor.history);
  backfillDemoSources(debtor);
  assert.equal(debtor.debtApp, '已有 APP');
  assert.equal(debtor.platform, '召集令');
  assert.equal(debtor.acquisitionChannel, '已有渠道');
  assert.deepEqual(debtor.demoSourceFields, ['platform']);
  const migrated = JSON.stringify(debtor);
  backfillDemoSources(debtor);
  assert.equal(JSON.stringify(debtor), migrated);
  assert.equal(JSON.stringify(debtor.history), beforeHistory);
  const changed = debtorDetails({ platform: ' 实际平台 ' }, debtor);
  requireDebtorSources(changed);
  assert.equal(changed.platform, '实际平台');
  assert.deepEqual(changed.demoSourceFields, []);
});
