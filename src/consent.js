// Written consent only: calls, incoming messages, START and legacy leads never grant it.
const store = require('./store');
const PURPOSES = ['customer_service', 'owner_alerts'];
const BUSINESS_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
let persistenceFailed = false;
let sessionClosed = false;
let recoveryRequired = false;

function validPhone(value) {
  return typeof value === 'string' && value === value.trim() && /^\+[1-9][0-9]{1,14}$/.test(value);
}
function validBusiness(value) {
  return typeof value === 'string' && value === value.trim() && BUSINESS_ID.test(value);
}
function configuration() {
  const businessId = process.env.SMS_CONSENT_BUSINESS_ID;
  const sender = process.env.TWILIO_PHONE_NUMBER;
  return validBusiness(businessId) && validPhone(sender) ? { businessId, sender } : null;
}
function text(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
    !/[\x00-\x1f\x7f]/.test(value);
}
function validSid(value) {
  return typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
// Require a full ISO timestamp with timezone, and reject dates Date.parse normalizes (Feb 30).
function isoTime(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[0] !== value) return NaN;
  const [, y, m, d, h, minute, second, , zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(h) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return NaN;
  return Date.parse(value);
}
function error(status, message) {
  return Object.assign(new Error(message), { status });
}
function fields(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]' &&
    required.every((key) => Object.hasOwn(value, key)) &&
    optional.every((key) => !(key in value) || Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function view(record) {
  const permissions = { customer_service: null, owner_alerts: null };
  let providerBlocked = false;
  for (const event of record.events) {
    if (event.type === 'grant') permissions[event.purpose] = event;
    if (event.type === 'revoke') {
      permissions.customer_service = null;
      permissions.owner_alerts = null;
      providerBlocked = providerBlocked || event.providerBlocked;
    }
    if (event.type === 'provider_opt_in') providerBlocked = false;
  }
  // Detached views cannot mutate the durable event history.
  return JSON.parse(JSON.stringify({ ...record, providerBlocked, permissions }));
}
function validateRecords(records) {
  if (!Array.isArray(records)) throw error(409, 'Invalid SMS permission history');
  const scopes = new Set();
  for (const record of records) {
    if (!fields(record, ['businessId', 'sender', 'phone', 'events']) ||
        !validBusiness(record.businessId) || !validPhone(record.sender) ||
        !validPhone(record.phone) || !Array.isArray(record.events)) {
      throw error(409, 'Invalid SMS permission history');
    }
    const scope = JSON.stringify([record.businessId, record.sender, record.phone]);
    if (scopes.has(scope)) throw error(409, 'Duplicate SMS permission scope');
    scopes.add(scope);
    const messageSids = new Set();
    let lastAt = -Infinity, revokedAt = -Infinity, blocked = false;
    for (const event of record.events) {
      if (!event || !Number.isFinite(isoTime(event.at)) ||
          isoTime(event.at) < lastAt || isoTime(event.at) > Date.now()) {
        throw error(409, 'Invalid SMS permission event timestamp');
      }
      lastAt = isoTime(event.at);
      if (event.type === 'grant') {
        if (!fields(event, ['type', 'at', 'method', 'purpose', 'consentedAt', 'disclosureVersion', 'evidenceRef']) ||
            event.method !== 'admin' || !PURPOSES.includes(event.purpose) ||
            !Number.isFinite(isoTime(event.consentedAt)) || isoTime(event.consentedAt) > lastAt ||
            isoTime(event.consentedAt) <= revokedAt || blocked ||
            !text(event.disclosureVersion, 128) || !text(event.evidenceRef, 512)) {
          throw error(409, 'Invalid SMS permission grant');
        }
      } else if (event.type === 'revoke' || event.type === 'provider_opt_in') {
        const required = ['type', 'at', 'method', 'purpose'];
        if (event.type === 'revoke') required.push('providerBlocked');
        if (!fields(event, required, ['messageSid']) || event.purpose !== 'all' ||
            !text(event.method, 64) ||
            (Object.hasOwn(event, 'messageSid') && (!validSid(event.messageSid) || messageSids.has(event.messageSid)))) {
          throw error(409, 'Invalid SMS permission webhook event');
        }
        if (event.messageSid) messageSids.add(event.messageSid);
        if (event.type === 'revoke') {
          if (typeof event.providerBlocked !== 'boolean') throw error(409, 'Invalid provider block');
          revokedAt = lastAt;
          blocked = blocked || event.providerBlocked;
        } else {
          if (event.method !== 'provider') throw error(409, 'Invalid provider opt-in');
          blocked = false;
        }
      } else throw error(409, 'Unknown SMS permission event');
    }
  }
  return records;
}
// A legacy database has an empty array supplied by store; malformed consent is not migrated.
freeze(validateRecords(store.db.smsPermissions));
// Persist an unclean-session marker BEFORE accepting traffic or allowing any SMS.
// A crash or failed opt-out write must not resurrect a disk's older grants on restart.
if (Object.hasOwn(store.db, 'smsSessionClean') && typeof store.db.smsSessionClean !== 'boolean') {
  throw error(409, 'Invalid SMS session state');
}
recoveryRequired = store.db.smsSessionClean === false;
store.save({ ...store.db, smsSessionClean: false }); // Failure aborts startup.
store.db.smsSessionClean = false;

function records(suppressionOnly = false) {
  if (sessionClosed || (!suppressionOnly && (persistenceFailed || recoveryRequired))) {
    throw error(409, 'SMS permission persistence unavailable; recovery required');
  }
  return validateRecords(store.db.smsPermissions);
}
function scoped(phone, suppressionOnly = false) {
  if (!validPhone(phone)) throw error(400, 'Invalid E.164 recipient');
  const config = configuration();
  if (!config) throw error(409, 'SMS consent configuration required');
  const all = records(suppressionOnly);
  const index = all.findIndex((record) => record.businessId === config.businessId &&
    record.sender === config.sender && record.phone === phone);
  return { all, index, record: index < 0 ? { ...config, phone, events: [] } : all[index] };
}
function check(phone, purpose = 'customer_service') {
  if (!validPhone(phone)) return { allowed: false, reason: 'invalid_phone' };
  if (!PURPOSES.includes(purpose)) return { allowed: false, reason: 'invalid_purpose' };
  if (!configuration()) return { allowed: false, reason: 'consent_not_configured' };
  let record;
  try { record = view(scoped(phone).record); }
  catch { return { allowed: false, reason: 'consent_unavailable' }; }
  if (record.providerBlocked) return { allowed: false, reason: 'provider_blocked' };
  return record.permissions[purpose]
    ? { allowed: true, reason: 'consented' }
    : { allowed: false, reason: 'consent_required' };
}
function persist(next) {
  try { store.save({ ...store.db, smsPermissions: next }); }
  catch {
    persistenceFailed = true;
    throw error(409, 'SMS permission persistence unavailable');
  }
  store.db.smsPermissions = next;
  persistenceFailed = false;
}
function append(context, event) {
  const record = { ...context.record, events: [...context.record.events, event] };
  const next = [...context.all];
  if (context.index < 0) next.push(record);
  else next[context.index] = record;
  validateRecords(next);
  freeze(next);
  try {
    // Never make a grant visible to senders until atomic persistence succeeds.
    persist(next);
  } catch (failure) {
    // Preserve failed suppressions for a retry; never publish a failed grant/unblock.
    if (event.type === 'revoke') store.db.smsPermissions = next;
    throw failure;
  }
  return view(record);
}
function grant(input) {
  if (!fields(input, ['phone', 'purpose', 'consentedAt', 'disclosureVersion', 'evidenceRef']) ||
      !PURPOSES.includes(input.purpose) || !Number.isFinite(isoTime(input.consentedAt)) ||
      isoTime(input.consentedAt) > Date.now() || !text(input.disclosureVersion, 128) || !text(input.evidenceRef, 512)) {
    throw error(400, 'Explicit purpose, valid consent timestamp, disclosure version and evidence reference required');
  }
  const context = scoped(input.phone);
  if (view(context.record).providerBlocked) throw error(409, 'Provider opt-out must be cleared before new written consent');
  const revocation = context.record.events.filter((event) => event.type === 'revoke').at(-1);
  if (revocation && isoTime(input.consentedAt) <= isoTime(revocation.at)) {
    throw error(409, 'Written consent must be newer than the latest revocation');
  }
  return append(context, {
    type: 'grant', at: new Date().toISOString(), method: 'admin', purpose: input.purpose,
    consentedAt: new Date(isoTime(input.consentedAt)).toISOString(),
    disclosureVersion: input.disclosureVersion, evidenceRef: input.evidenceRef,
  });
}
function webhookContext(phone, options, kind) {
  const optional = kind === 'revoke' ? ['method', 'messageSid', 'providerBlocked'] : ['messageSid'];
  if (!fields(options, [], optional) ||
      (options.messageSid !== undefined && !validSid(options.messageSid)) ||
      (kind === 'revoke' && ((options.method !== undefined && !text(options.method, 64)) ||
        (options.providerBlocked !== undefined && typeof options.providerBlocked !== 'boolean')))) {
    throw error(400, 'Invalid SMS permission event options');
  }
  return scoped(phone, kind === 'revoke');
}
function revoke(phone, options = {}) {
  const context = webhookContext(phone, options, 'revoke');
  const { method = 'admin', messageSid, providerBlocked = false } = options;
  if (messageSid && context.record.events.some((event) => event.messageSid === messageSid)) {
    if (persistenceFailed) persist(context.all); // A duplicate is also a safe retry of a failed save.
    return view(context.record);
  }
  return append(context, {
    type: 'revoke', at: new Date().toISOString(), method, purpose: 'all', providerBlocked,
    ...(messageSid === undefined ? {} : { messageSid }),
  });
}
function providerOptIn(phone, options = {}) {
  const context = webhookContext(phone, options, 'provider_opt_in');
  const { messageSid } = options;
  if (messageSid && context.record.events.some((event) => event.messageSid === messageSid)) return view(context.record);
  return append(context, {
    type: 'provider_opt_in', at: new Date().toISOString(), method: 'provider', purpose: 'all',
    ...(messageSid === undefined ? {} : { messageSid }),
  });
}
function snapshot() {
  const config = configuration();
  if (!config) return [];
  return validateRecords(store.db.smsPermissions)
    .filter((record) => record.businessId === config.businessId && record.sender === config.sender).map(view);
}
function status() { return { recoveryRequired, persistenceFailed }; }
function recover(acknowledgment) {
  if (acknowledgment !== 'suppression_history_reviewed') throw error(400, 'Suppression review acknowledgment required');
  if (process.env.SMS_ENABLED === '1' || sessionClosed) throw error(409, 'Disable SMS before reviewed recovery');
  // Operator must first reconcile missing opt-outs against provider records and retained evidence.
  persist(freeze(validateRecords(store.db.smsPermissions)));
  recoveryRequired = false;
  return status();
}
function close() {
  if (sessionClosed) return true;
  if (persistenceFailed || recoveryRequired) return false;
  try {
    validateRecords(store.db.smsPermissions);
    store.save({ ...store.db, smsSessionClean: true });
    store.db.smsSessionClean = true;
    sessionClosed = true;
    return true;
  } catch { persistenceFailed = true; return false; }
}

module.exports = { validPhone, configuration, check, grant, revoke, providerOptIn, snapshot, status, recover, close };
