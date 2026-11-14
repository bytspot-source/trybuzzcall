'use strict';
// Recorded written SMS permission. Only the authenticated operator API (POST /api/consent) records a grant: calls,
// key presses, inbound texts, START, payments, waitlist, setup and vendor onboarding never do. A record is bound to
// { businessId, sender, phone } and lives in the current shop's store (db.smsPermissions): the legacy line uses
// SMS_CONSENT_BUSINESS_ID + TWILIO_PHONE_NUMBER, a vendor shop its id + assigned number. Request input never picks
// the business or sender. customer_service and owner_alerts never authorize each other.
// Durability: grants and provider opt-ins are published only after the store durably saved them (store.commit).
// Revocations apply in memory at once (db.optOuts too), are written through, and a failed write quarantines that
// store's SMS and grants until a reviewed recover(). open() persists db.smsSessionClean=false before traffic; a
// graceful shutdown (closeAll) sets it back to true only with no pending sends and healthy persistence. A store
// that starts with an unclean marker stays quarantined until recover().
const store = require('./store');
const shopContext = require('./shopContext');

const PURPOSES = ['customer_service', 'owner_alerts'];
const BUSINESS_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CLOCK_SKEW_MS = 5 * 60000; // tolerated future skew of persisted events written by another instance
const PROVIDER_SOURCES = /^(keyword|twilio_|provider)/;
const states = new Map(); // actual store -> session state

function validPhone(value) {
  return typeof value === 'string' && value === value.trim() && /^\+[1-9][0-9]{1,14}$/.test(value);
}
function validBusiness(value) {
  return typeof value === 'string' && value === value.trim() && BUSINESS_ID.test(value);
}
function configuration() {
  const context = shopContext.current();
  const businessId = context ? context.id : process.env.SMS_CONSENT_BUSINESS_ID;
  const sender = context ? context.shop.phoneNumber : process.env.TWILIO_PHONE_NUMBER;
  return validBusiness(businessId) && validPhone(sender) ? { businessId, sender } : null;
}
function text(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
    !/[\x00-\x1f\x7f]/.test(value);
}
// An internal record identifier, never a link or credential.
function evidenceText(value) {
  return text(value, 512) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) && !/\b(?:https?:|www\.)/i.test(value) &&
    !/(?:token|password|passwd|secret|api[_-]?key|bearer)\s*[=:]/i.test(value);
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
  const latest = Date.now() + CLOCK_SKEW_MS;
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
          isoTime(event.at) < lastAt || isoTime(event.at) > latest) {
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

// ---- per-store session state ----
const target = () => { const context = shopContext.current(); return context ? context.store : store.root; };
async function durable(actual) {
  try { await actual.flush(); } catch { return false; }
  return !actual.status().degraded;
}
// Created on first use (or again once a store switched from its boot file to Postgres): validates the history,
// latches an unclean marker from the previous session, and saves this session's unclean marker.
function state(actual = target()) {
  const backend = actual.backend();
  const existing = states.get(actual);
  if (existing && existing.backend === backend) return existing;
  const s = { backend, recoveryRequired: false, persistenceFailed: false, invalid: false, closed: false, ready: false,
    opening: null, queue: Promise.resolve(), pendingRevokes: new Map() };
  states.set(actual, s);
  const db = actual.db;
  if (Object.hasOwn(db, 'smsSessionClean') && typeof db.smsSessionClean !== 'boolean') s.invalid = true;
  if (db.smsPermissions === undefined) db.smsPermissions = [];
  // Malformed history is never repaired or migrated; it fails closed.
  try { freeze(validateRecords(db.smsPermissions)); } catch { s.invalid = true; }
  s.recoveryRequired = db.smsSessionClean === false;
  db.smsSessionClean = false;
  try { actual.save(); } catch { s.persistenceFailed = true; return s; }
  if (backend === 'postgres') {
    s.opening = durable(actual).then((ok) => { if (ok) s.ready = true; else s.persistenceFailed = true; s.opening = null; });
  } else s.ready = true;
  return s;
}
const usable = (s) => s.ready && !s.invalid && !s.closed && !s.persistenceFailed && !s.recoveryRequired;
// Ledger mutations of one store run one at a time; revocations still suppress in memory before they are queued.
function enqueue(s, task) {
  const run = s.queue.then(task);
  s.queue = run.catch(() => {});
  return run;
}
const bump = (map, key, by) => { const n = (map.get(key) || 0) + by; if (n > 0) map.set(key, n); else map.delete(key); };
// Boot (root store) and vendor store loading: rejects when the history is invalid or the marker cannot be saved.
async function open(actual = target()) {
  const s = state(actual);
  if (s.opening) await s.opening;
  if (s.invalid) throw error(409, 'Invalid SMS permission history');
  if (!s.ready) throw error(409, 'Unable to persist the SMS session marker');
  return status(actual);
}

function scoped(actual, config, phone) {
  const all = validateRecords(actual.db.smsPermissions);
  const index = all.findIndex((record) => record.businessId === config.businessId &&
    record.sender === config.sender && record.phone === phone);
  return { all, index, record: index < 0 ? { ...config, phone, events: [] } : all[index] };
}
function withEvent(context, event) {
  const record = { ...context.record, events: [...context.record.events, event] };
  const next = [...context.all];
  if (context.index < 0) next.push(record);
  else next[context.index] = record;
  validateRecords(next);
  return { next: freeze(next), record };
}
// Event times never go backwards within a record, even across instances with slightly different clocks.
function stamp(record) {
  const last = record.events.length ? isoTime(record.events.at(-1).at) : -Infinity;
  return new Date(Math.max(Date.now(), last)).toISOString();
}
const optOutOf = (actual, phone) => (actual.db.optOuts && Object.hasOwn(actual.db.optOuts, phone) ? actual.db.optOuts[phone] : null);
const withoutOptOut = (actual, phone) => {
  const optOuts = { ...(actual.db.optOuts || {}) };
  delete optOuts[phone];
  return optOuts;
};

function check(phone, purpose = 'customer_service') {
  if (!validPhone(phone)) return { allowed: false, reason: 'invalid_phone' };
  if (!PURPOSES.includes(purpose)) return { allowed: false, reason: 'invalid_purpose' };
  const config = configuration();
  if (!config) return { allowed: false, reason: 'consent_not_configured' };
  const actual = target();
  const s = state(actual);
  if (!usable(s)) return { allowed: false, reason: 'consent_unavailable' };
  let record;
  try { record = view(scoped(actual, config, phone).record); }
  catch { return { allowed: false, reason: 'consent_unavailable' }; }
  if (record.providerBlocked) return { allowed: false, reason: 'provider_blocked' };
  if (!record.permissions[purpose] || s.pendingRevokes.has(phone)) return { allowed: false, reason: 'consent_required' };
  if (actual.isOptedOut(phone)) return { allowed: false, reason: 'opted_out' };
  return { allowed: true, reason: 'consented' };
}

// Rejects (409) when the store cannot durably save it; nothing is published in that case.
async function commitEvent(actual, s, context, event, phone) {
  const { next, record } = withEvent(context, event);
  const clearOptOut = !!optOutOf(actual, phone);
  try {
    await actual.commit(
      () => ({ smsPermissions: next, ...(clearOptOut && !s.pendingRevokes.has(phone) ? { optOuts: withoutOptOut(actual, phone) } : {}) }),
      () => {
        actual.db.smsPermissions = next;
        if (clearOptOut && !s.pendingRevokes.has(phone) && actual.db.optOuts) delete actual.db.optOuts[phone];
      });
  } catch { throw error(409, 'SMS permission could not be saved durably; nothing was recorded'); }
  return view(record);
}
function grant(input) {
  if (!fields(input, ['phone', 'purpose', 'consentedAt', 'disclosureVersion', 'evidenceRef']) ||
      !validPhone(input.phone) || !PURPOSES.includes(input.purpose) || !Number.isFinite(isoTime(input.consentedAt)) ||
      isoTime(input.consentedAt) > Date.now() || !text(input.disclosureVersion, 128) || !evidenceText(input.evidenceRef)) {
    return Promise.reject(error(400, 'Explicit purpose, valid consent timestamp, disclosure version and non-secret evidence reference required'));
  }
  const config = configuration();
  if (!config) return Promise.reject(error(409, 'SMS consent configuration required'));
  const actual = target();
  const s = state(actual);
  return enqueue(s, async () => {
    if (s.opening) await s.opening;
    if (!usable(s)) throw error(409, 'SMS permission persistence unavailable; recovery required');
    const health = actual.status();
    if (health.degraded || health.fallback) throw error(409, 'Durable storage is unavailable; nothing was recorded');
    if (actual.backend() !== 'postgres' && require('./security').isProduction()) {
      throw error(409, 'Durable database storage (DATABASE_URL) is required to record SMS permission in production');
    }
    const context = scoped(actual, config, input.phone);
    const optOut = optOutOf(actual, input.phone);
    if (view(context.record).providerBlocked || s.pendingRevokes.has(input.phone) ||
        (optOut && PROVIDER_SOURCES.test(String(optOut.source || '')))) {
      throw error(409, 'Provider opt-out must be cleared before new written consent');
    }
    const consentedAt = isoTime(input.consentedAt);
    const revocation = context.record.events.filter((event) => event.type === 'revoke').at(-1);
    if ((revocation && consentedAt <= isoTime(revocation.at)) || (optOut && !(consentedAt > Date.parse(optOut.at)))) {
      throw error(409, 'Written consent must be newer than the latest revocation');
    }
    return commitEvent(actual, s, context, {
      type: 'grant', at: stamp(context.record), method: 'admin', purpose: input.purpose,
      consentedAt: new Date(consentedAt).toISOString(),
      disclosureVersion: input.disclosureVersion, evidenceRef: input.evidenceRef,
    }, input.phone);
  });
}
function eventOptions(phone, options, kind) {
  const optional = kind === 'revoke' ? ['method', 'messageSid', 'providerBlocked'] : ['messageSid'];
  if (!validPhone(phone) || !fields(options, [], optional) ||
      (options.messageSid !== undefined && !validSid(options.messageSid)) ||
      (kind === 'revoke' && ((options.method !== undefined && !text(options.method, 64)) ||
        (options.providerBlocked !== undefined && typeof options.providerBlocked !== 'boolean')))) {
    throw error(400, 'Invalid SMS permission event options');
  }
}
// Writes the whole store through; a failure latches quarantine for this store until recover().
async function writeThrough(actual, s) {
  let ok;
  try { actual.save(); ok = await durable(actual); } catch { ok = false; }
  if (!ok) {
    s.persistenceFailed = true;
    throw error(409, 'SMS permission persistence unavailable');
  }
}
// Revokes both purposes for this recipient. Suppression (db.optOuts, this process) applies before the first await,
// even when the history is invalid, quarantined or unconfigured.
function revoke(phone, options = {}) {
  try { eventOptions(phone, options, 'revoke'); } catch (e) { return Promise.reject(e); }
  const { method = 'admin', messageSid, providerBlocked = false } = options;
  const actual = target();
  const s = state(actual);
  const config = configuration();
  // A redelivered webhook (same MessageSid) is a no-op, or a retry of its failed save; it never re-suppresses.
  if (messageSid && config && !s.invalid) {
    let seen = null;
    try { seen = scoped(actual, config, phone).record; } catch { seen = null; }
    if (seen && seen.events.some((event) => event.messageSid === messageSid)) {
      return enqueue(s, async () => {
        if (s.persistenceFailed) await writeThrough(actual, s);
        return view(seen);
      });
    }
  }
  bump(s.pendingRevokes, phone, 1);
  let optOutWrite = null;
  try { optOutWrite = actual.optOut(phone, method); }
  catch { s.persistenceFailed = true; }
  if (s.closed) actual.db.smsSessionClean = false;
  return enqueue(s, async () => {
    try {
      if (optOutWrite) await optOutWrite;
      if (!config) throw error(409, 'SMS consent configuration required');
      if (s.invalid) throw error(409, 'Invalid SMS permission history');
      const context = scoped(actual, config, phone);
      if (messageSid && context.record.events.some((event) => event.messageSid === messageSid)) {
        if (s.persistenceFailed) await writeThrough(actual, s); // a duplicate is also a safe retry of a failed save
        return view(context.record);
      }
      const { next, record } = withEvent(context, {
        type: 'revoke', at: stamp(context.record), method, purpose: 'all', providerBlocked,
        ...(messageSid === undefined ? {} : { messageSid }),
      });
      actual.db.smsPermissions = next;
      await writeThrough(actual, s);
      return view(record);
    } finally { bump(s.pendingRevokes, phone, -1); }
  });
}
// START/UNSTOP/YES: clears only the provider delivery block (and the local opt-out entry). Never restores grants.
function providerOptIn(phone, options = {}) {
  try { eventOptions(phone, options, 'provider_opt_in'); } catch (e) { return Promise.reject(e); }
  const config = configuration();
  if (!config) return Promise.reject(error(409, 'SMS consent configuration required'));
  const actual = target();
  const s = state(actual);
  const { messageSid } = options;
  return enqueue(s, async () => {
    if (s.opening) await s.opening;
    if (!usable(s)) throw error(409, 'SMS permission persistence unavailable; recovery required');
    const context = scoped(actual, config, phone);
    if (messageSid && context.record.events.some((event) => event.messageSid === messageSid)) return view(context.record);
    if (s.pendingRevokes.has(phone)) return view(context.record);
    return commitEvent(actual, s, context, {
      type: 'provider_opt_in', at: stamp(context.record), method: 'provider', purpose: 'all',
      ...(messageSid === undefined ? {} : { messageSid }),
    }, phone);
  });
}
function snapshot() {
  const config = configuration();
  if (!config) return [];
  return validateRecords(target().db.smsPermissions || [])
    .filter((record) => record.businessId === config.businessId && record.sender === config.sender).map(view);
}
function status(actual = target()) {
  const s = state(actual);
  return { recoveryRequired: s.recoveryRequired || s.invalid, persistenceFailed: s.persistenceFailed };
}
// Admin views: counts only, never records.
function counts() {
  let records = [];
  try { records = snapshot(); } catch { return { records: 0, customerService: 0, ownerAlerts: 0, providerBlocked: 0, invalid: true }; }
  return {
    records: records.length,
    customerService: records.filter((r) => r.permissions.customer_service).length,
    ownerAlerts: records.filter((r) => r.permissions.owner_alerts).length,
    providerBlocked: records.filter((r) => r.providerBlocked).length,
  };
}
// Operator confirms missing opt-outs were reconciled first. Grants nothing and clears no revocation or block.
function recover(acknowledgment) {
  if (acknowledgment !== 'suppression_history_reviewed') return Promise.reject(error(400, 'Suppression review acknowledgment required'));
  const actual = target();
  const s = state(actual);
  return enqueue(s, async () => {
    if (s.opening) await s.opening;
    if (process.env.SMS_ENABLED === '1' || s.closed) throw error(409, 'Disable SMS before reviewed recovery');
    if (s.invalid) throw error(409, 'Invalid SMS permission history');
    validateRecords(actual.db.smsPermissions);
    actual.db.smsSessionClean = false;
    s.persistenceFailed = false;
    await writeThrough(actual, s);
    s.ready = true;
    s.recoveryRequired = false;
    return status(actual);
  });
}
async function closeOne(actual, s, pending) {
  await s.queue;
  if (s.closed) return true;
  if (s.opening) await s.opening;
  if (pending || !usable(s)) return false;
  try { validateRecords(actual.db.smsPermissions); } catch { return false; }
  actual.db.smsSessionClean = true;
  let ok;
  try { actual.save(); ok = await durable(actual); } catch { ok = false; }
  if (!ok) { actual.db.smsSessionClean = false; s.persistenceFailed = true; return false; }
  s.closed = true;
  return true;
}
// Current store only.
function close({ pending = false } = {}) {
  const actual = target();
  return closeOne(actual, state(actual), pending);
}
// Graceful shutdown: every store this process opened. Clean only when all of them could be marked clean.
async function closeAll({ pending = false } = {}) {
  let clean = true;
  for (const [actual, s] of states) if (!(await closeOne(actual, s, pending))) clean = false;
  return clean;
}

module.exports = { PURPOSES, validPhone, configuration, check, grant, revoke, providerOptIn, snapshot, status, counts, recover, open, close, closeAll };
