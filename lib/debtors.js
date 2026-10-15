const SOURCE_FIELDS = { debtApp: '欠款 APP', platform: '欠款平台', acquisitionChannel: '欠款引流渠道' };
const DEMO_SOURCES = { debtApp: '钱小乐', platform: '召集令', acquisitionChannel: '榕树贷' };

// One-time demo migration: preserve supplied values and label every filled field.
function backfillDemoSources(debtor) {
  const demoFields = new Set(debtor.demoSourceFields || []);
  for (const [field, value] of Object.entries(DEMO_SOURCES)) {
    if (typeof debtor[field] !== 'string' || !debtor[field].trim()) {
      debtor[field] = value;
      demoFields.add(field);
    }
  }
  debtor.demoSourceFields = [...demoFields];
}

function requireDebtorSources(debtor) {
  for (const [field, label] of Object.entries(SOURCE_FIELDS)) {
    if (typeof debtor[field] !== 'string' || !debtor[field].trim()) throw new Error(`${label}为必填项`);
  }
}

// Unknown historical facts stay unknown; absence of a record is not "no".
function debtorDetails(input = {}, existing = {}) {
  const details = {};
  for (const field of ["debtApp", "platform", "acquisitionChannel", "callHistorySummary"]) {
    const value = input[field] === undefined ? existing[field] ?? "" : input[field];
    if (typeof value !== "string") throw new Error(`${field} 必须为文本`);
    details[field] = value.trim();
  }
  const gender = input.gender === undefined ? existing.gender ?? "未知" : input.gender;
  if (!["男", "女", "其他", "未知"].includes(gender)) throw new Error("性别选项无效");
  details.gender = gender;
  for (const field of ["hasPromise", "hasComplaintHistory"]) {
    let value = input[field] === undefined ? existing[field] ?? null : input[field];
    if (value === "true") value = true;
    if (value === "false") value = false;
    if (value === "unknown" || value === "") value = null;
    if (value !== true && value !== false && value !== null) throw new Error(`${field} 必须为是、否或未知`);
    details[field] = value;
  }
  // A recorded promise remains historical evidence even after it is fulfilled.
  if (existing.promise || input.promise) details.hasPromise = true;
  details.demoSourceFields = (existing.demoSourceFields || []).filter(field => details[field] === existing[field]);
  return details;
}

module.exports = { debtorDetails, backfillDemoSources, requireDebtorSources };
