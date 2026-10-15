// Share payload creation between the preview and the immutable SIP call snapshot.
const { encodeInput } = require('./agora-sip');
const PREVIOUS_FIELDS = ['ability', 'abnormal', 'complaint', 'debtor_self', 'dispute', 'willingness'];

function moneyInChinese(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return null;
  const fen = Math.round(Number(value) * 100);
  const yuan = Math.floor(fen / 100), jiao = Math.floor(fen % 100 / 10), remainder = fen % 10;
  return `${yuan}元${jiao ? `${jiao}角` : ''}${remainder ? `${remainder}分` : ''}`;
}

function shanghaiTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 19) + '+08:00';
}

function previousConnection(call) {
  if (!call) return null;
  if (call.answeredAt || call.bridgedAt || call.wasBridged || call.status === '已接通') return '是';
  if (['未接通', '呼叫失败'].includes(call.status)) return '否';
  return null;
}

function debtorCallRecords(debtor, calls) {
  const records = calls.filter(call => call.debtorId === debtor.id).map(call => ({ ...call, historyOnly: false }));
  const ids = new Set(records.map(call => call.id));
  for (const history of debtor.history || []) {
    const id = history.callId || history.id;
    if (ids.has(id)) continue;
    ids.add(id);
    records.push({ id, startedAt: history.time, status: history.result, summary: history.summary, historyOnly: true });
  }
  return records.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
}

function buildAgoraInput(debtor, calls, now = new Date().toISOString()) {
  const variables = {};
  const sources = {};
  const omitted = [];
  const add = (field, value, source, reason = '尚未录入对应资料') => {
    if (value === null || value === undefined || String(value).trim() === '') {
      omitted.push({ field, reason });
    } else {
      variables[field] = String(value);
      sources[field] = source;
    }
  };
  const records = debtorCallRecords(debtor, calls);
  const previous = records[0];
  const source = (field, label) => `债务人资料：${label}${debtor.demoSourceFields?.includes(field) ? '（演示补充，可在客户资料中修改）' : ''}`;
  add('app_name', debtor.debtApp, source('debtApp', '欠款 APP'));
  add('platform', debtor.platform, source('platform', '欠款平台'));
  add('channel', debtor.acquisitionChannel, source('acquisitionChannel', '欠款引流渠道'));
  add('name', debtor.name, '债务人资料：姓名');
  add('gender', debtor.gender === '未知' ? null : debtor.gender, '债务人资料：性别');
  add('overdue', moneyInChinese(debtor.amount), '债务人资料：当前逾期金额，转换为元/角/分');
  add('contract_overdue', Number.isInteger(Number(debtor.overduePeriods)) && debtor.overduePeriods != null && debtor.overduePeriods !== '' && Number(debtor.overduePeriods) >= 0 ? debtor.overduePeriods : null, '债务人资料：当前逾期期数');
  add('complaint', debtor.hasComplaintHistory === true ? '有' : debtor.hasComplaintHistory === false ? '无' : null, '债务人资料：是否有投诉历史');
  const promise = debtor.promise;
  let commitment = debtor.hasPromise === true ? '有承诺记录' : debtor.hasPromise === false ? '无承诺记录' : null;
  if (promise) {
    const amount = moneyInChinese(promise.amount);
    commitment = `有承诺记录${promise.date ? `，承诺日期：${promise.date}` : ''}${amount ? `，承诺金额：${amount}` : ''}${promise.note ? `，备注：${promise.note}` : ''}`;
  }
  add('commitment', commitment, '债务人资料：承诺历史标记与已记录的承诺明细；不推定承诺仍有效');
  const previousSource = previous ? `上一通电话：${previous.id}` : '暂无历史通话';
  add('calls_records_connected', previousConnection(previous), previousSource + '，是否接听', previous ? '上一通电话接听状态未确认' : '暂无上一通电话');
  add('calls_records_time', shanghaiTime(previous?.startedAt), previousSource + '，开始时间（北京时间）', previous ? '上一通电话没有有效时间' : '暂无上一通电话');
  // A debtor-level promise can be older than the previous call. Use only the
  // promise explicitly returned for that call; never copy the global promise.
  const previousPromiseDate = previous?.webhookPayload?.promiseDate;
  add('calls_records_prev_commit_time', typeof previousPromiseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(previousPromiseDate) ? previousPromiseDate : null,
    previousSource + '，该通电话回传的承诺日期', '上一通电话未回传承诺日期，不等同于已确认无承诺');
  for (const suffix of PREVIOUS_FIELDS) omitted.push({ field: `calls_records_prev_${suffix}`, reason: '尚无上一通电话的对应结构化结论，不从客户整体资料或转写猜测' });

  // Assemble ALL available summaries in chronological order. This is an
  // explicit history digest, not an invented AI conclusion or the last call.
  let context;
  if (!records.length) {
    context = debtor.callHistorySummary ? `已维护的历史总结：${debtor.callHistorySummary}\n系统中暂无逐通电话记录。` : '暂无历史通话记录。';
  } else {
    const connected = records.filter(call => previousConnection(call) === '是').length;
    const unknown = records.filter(call => previousConnection(call) === null).length;
    context = `此前共记录 ${records.length} 次通话，其中 ${connected} 次有接听记录${unknown ? `，${unknown} 次接听状态未确认` : ''}。`;
    if (debtor.callHistorySummary) context += `\n已维护的历史总结：${debtor.callHistorySummary}`;
    context += '\n历次记录（从早到晚）：\n' + [...records].reverse().map((call, index) =>
      `${index + 1}. ${shanghaiTime(call.startedAt) || '时间未记录'}，${call.status || '状态未记录'}：${call.summary || '暂无摘要'}`
    ).join('\n');
  }
  add('call_context', context, '合并该客户全部通话及历史摘要，去重后按时间汇总；包含已维护的整体总结，未调用 AI');
  for (const field of ['contract_paid', 'contract_total', 'contract_unpaid']) omitted.push({ field, reason: '尚未录入合同已还、总计或未还期数，不能用逾期期数代替' });
  omitted.push({ field: 'max_ptp_date', reason: '尚未配置本通电话允许的最晚还款日期，不使用历史承诺日期代替' });
  for (const field of ['permission', 'redline', 'strategy', 'target']) omitted.push({ field, reason: '待接入 AI 策略大脑，本阶段不生成' });
  const payload = { agent_properties: { llm: { template_variables: variables } } };
  const { encoded, ...sipSize } = encodeInput(payload);
  return {
    debtorId: debtor.id, debtorName: debtor.name, generatedAt: now,
    deliveryStatus: 'not_sent', previousCallId: previous?.id || null, historyCount: records.length,
    payload, sipSize, sources, omitted
  };
}

module.exports = { buildAgoraInput, moneyInChinese, debtorCallRecords };
