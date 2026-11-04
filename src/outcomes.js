'use strict';
// Outcomes log: one clean, labeled, consent-aware record per missed call (keyed by Twilio CallSid), updated as the call
// moves through the flow (missed -> consented / no_consent -> conversed -> slot_offered -> booked -> deposit_paid, or
// opted_out). Lives in the current shop's store (db.outcomes: { [callSid]: record }), like db.voiceConsents.
//
// Safety: every entry point is wrapped (safe()) so a logging failure is logged and swallowed and NEVER breaks call or
// SMS handling. Records only ever move forward through the stages (opted_out overrides). Logs never contain phones.
//
// Privacy: the caller phone (and an optional email) is kept for operations only. The de-identified training export
// (trainingCsv) drops phone, email and name, replaces the caller with a salted hash (OUTCOMES_HASH_SALT, else a random
// salt persisted in the platform store), scrubs phone numbers / emails / the caller's name out of free text at capture
// time, and leaves out every training_excluded record (the caller opted out: see store.optOut).
//
// Retention: capped at OUTCOMES_MAX_RECORDS per shop (default 10000); the oldest records are pruned first.
//
// Optional email step (OUTCOMES_EMAIL_STEP=1, default OFF): after a booking the caller is asked for an email; a valid
// address is stored as email_unverified and a one-tap link /o/verify/:token marks email_verified=true. Without
// RESEND_API_KEY nothing is emailed (the record is still stored).
const crypto = require('crypto');
const store = require('./store');
const shopContext = require('./shopContext');
const sec = require('./security');

const STAGES = ['missed', 'no_consent', 'consented', 'conversed', 'slot_offered', 'booked', 'deposit_paid', 'opted_out'];
// Forward-only progression. no_consent and consented are alternatives at the same rank; opted_out always wins.
const RANK = { missed: 0, no_consent: 1, consented: 1, conversed: 2, slot_offered: 3, booked: 4, deposit_paid: 5, opted_out: 99 };
const DEFAULT_MAX = 10000;
const PHONE_LINK_DAYS = 7; // an SMS reply is tied to that caller's latest call record within this many days
const EMAIL_ASK = 'Want a confirmation by email? Reply with your email or SKIP.';
const EMAIL_TOKEN_DAYS = 7;
const URGENT_RE = /\b(emergenc\w*|urgent\w*|leak\w*|flood\w*|burst\w*|no heat|no hot water|no a\/?c|no air|no power|gas smell|smell(?:s|ing)? gas|sewage|backed up|overflow\w*|asap|right away|immediately)\b/i;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const validSid = (s) => typeof s === 'string' && /^[A-Za-z0-9]{1,80}$/.test(s);
const validPhone = (p) => typeof p === 'string' && /^\+[1-9]\d{7,14}$/.test(p);
const validEmail = (v) => typeof v === 'string' && v.length <= 254 && /^[^@\s<>,;"'()]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(v);

// Test hook: tests set hooks.beforeWrite to a throwing function to prove failures never reach the routes.
const hooks = { beforeWrite: null };
function safe(name, fn) {
  return (...args) => {
    try {
      if (hooks.beforeWrite) hooks.beforeWrite(name);
      return fn(...args);
    } catch (e) {
      console.error(`[outcomes] ${name} failed (ignored; call/SMS handling continues): ${e && e.message ? String(e.message).slice(0, 120) : e}`);
      return null;
    }
  };
}

const maxRecords = () => { const n = Number(process.env.OUTCOMES_MAX_RECORDS); return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX; };
const emailStepOn = () => sec.on(process.env.OUTCOMES_EMAIL_STEP);
const table = () => (store.db.outcomes && typeof store.db.outcomes === 'object' && !Array.isArray(store.db.outcomes) ? store.db.outcomes : (store.db.outcomes = {}));
const shopId = () => shopContext.shopId() || 'legacy';
function shopSlug() {
  try { return require('./smsPage').slugify(require('./consent').shopName()) || null; } catch { return null; }
}
function urgencyOf(text) {
  const t = String(text || '');
  if (!t.trim()) return { urgency: null, keyword: null };
  const m = t.match(URGENT_RE);
  let tradeUrgent = false;
  try { tradeUrgent = require('./agent').isUrgent(t); } catch {}
  return m || tradeUrgent ? { urgency: 'urgent', keyword: m ? m[1].toLowerCase() : 'trade_rule' } : { urgency: 'normal', keyword: null };
}
// Free text for the training export: phone numbers, emails and the caller's name are removed at capture time.
function scrub(text, name) {
  let t = String(text ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').slice(0, 300);
  t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]').replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]');
  for (const part of String(name || '').split(/\s+/).filter((w) => w.length >= 2)) t = t.replace(new RegExp(`\\b${sec.escapeRe(part)}\\b`, 'gi'), '[name]');
  return t.trim() || null;
}

function prune(t) {
  const max = maxRecords(), keys = Object.keys(t);
  if (keys.length <= max) return 0;
  // Oldest first by created_at; drop down to the cap.
  keys.sort((a, b) => String(t[a].created_at || '').localeCompare(String(t[b].created_at || '')));
  const drop = keys.slice(0, keys.length - max);
  for (const k of drop) delete t[k];
  return drop.length;
}
function setStage(r, stage, at = new Date().toISOString()) {
  if (!STAGES.includes(stage)) return false;
  r.stage_at = r.stage_at || {};
  if (!r.stage_at[stage]) r.stage_at[stage] = at;
  if (r.result_stage === 'opted_out') return false;
  if ((RANK[stage] ?? -1) < (RANK[r.result_stage] ?? -1)) return false;
  if ((RANK[stage] === RANK[r.result_stage]) && stage !== r.result_stage && stage !== 'consented') return false; // consented beats no_consent (a later press of 1)
  r.result_stage = stage; r.updated_at = at;
  return true;
}
function create(callSid, from) {
  const now = new Date(), at = now.toISOString(), t = table();
  let parts = null, zone = null;
  try { const st = require('./shopTime'); zone = st.timeZone(); parts = st.parts(now, zone); } catch {}
  const phone = validPhone(from) ? from : null;
  const r = {
    call_sid: callSid, shop_id: shopId(), shop_slug: shopSlug(), created_at: at, updated_at: at,
    hour_of_day: parts ? parts.hour : now.getUTCHours(), weekday: parts ? WEEKDAYS[require('./shopTime').weekday(parts)] : WEEKDAYS[now.getUTCDay()], time_zone: zone || 'UTC',
    caller_phone: phone, phone_verified: false, verification_method: null, verified_at: null,
    consent_digits: null, textback_sent: null,
    service: null, service_deid: null, urgency: null, urgency_keyword: null, callback_time: null, callback_time_deid: null,
    slots_offered: 0, booking_id: null, deposit_amount: null,
    result_stage: 'missed', stage_at: { missed: at },
    owner_buzzed_at: null, owner_buzz_outcome: null, owner_buzz_latency_ms: null, owner_response_ms: null,
    email_unverified: null, email: null, email_verified: false, email_verified_at: null, email_step: null,
    training_excluded: !!(phone && store.isOptedOut(phone)),
  };
  if (r.training_excluded) r.training_excluded_reason = 'opted_out_before_call';
  t[callSid] = r;
  prune(t);
  return r;
}
const get = (callSid) => (validSid(callSid) ? table()[callSid] || null : null);
// Latest record for a caller (within PHONE_LINK_DAYS): SMS replies, bookings and payments carry no CallSid.
function latestForPhone(phone, days = PHONE_LINK_DAYS) {
  if (!validPhone(phone)) return null;
  const cutoff = Date.now() - days * 86400000;
  let best = null;
  for (const r of Object.values(table())) {
    if (!r || r.caller_phone !== phone) continue;
    if (!(Date.parse(r.created_at) >= cutoff)) continue;
    if (!best || String(r.created_at) > String(best.created_at)) best = r;
  }
  return best;
}

// 1) A call was determined missed (/twilio/voice or /twilio/voice/status). Idempotent per CallSid.
const missed = safe('missed', ({ callSid, from, offered }) => {
  if (!validSid(callSid)) return null;
  let r = get(callSid);
  if (!r) r = create(callSid, from);
  r.optin_offered = !!offered;
  store.save();
  return r;
});
// 2) Press-1 result (/twilio/voice/consent). Pressing 1 from that caller ID verifies the phone.
const consent = safe('consent', ({ callSid, from, digits, consented, texted }) => {
  if (!validSid(callSid)) return null;
  const r = get(callSid) || create(callSid, from);
  const at = new Date().toISOString();
  r.consent_digits = String(digits ?? '').replace(/[^0-9*#]/g, '').slice(0, 4) || null;
  if (consented) {
    if (validPhone(from) && (!r.caller_phone || r.caller_phone === from)) {
      r.caller_phone = from; r.phone_verified = true; r.verification_method = 'voice_press_1'; r.verified_at = r.verified_at || at;
    }
    r.textback_sent = !!texted;
    setStage(r, 'consented', at);
  } else setStage(r, 'no_consent', at);
  store.save();
  return r;
});
// 3) A caller SMS turn was handled (/twilio/sms), after agent.handleReply updated the lead.
const conversation = safe('conversation', (phone, lead) => {
  const r = latestForPhone(phone);
  if (!r || !lead) return null;
  const need = lead.service || lead.need;
  if (need) {
    r.service = String(need).slice(0, 300);
    r.service_deid = lead.service ? String(lead.service).slice(0, 100) : scrub(need, lead.name);
    const u = urgencyOf(lead.need || lead.service);
    r.urgency = lead.urgent ? 'urgent' : u.urgency; r.urgency_keyword = u.keyword || (lead.urgent ? 'trade_rule' : null);
  }
  const cb = lead.window && !/^booked /.test(lead.window) ? lead.window : lead.prefDayText || null;
  if (cb) { r.callback_time = String(cb).slice(0, 200); r.callback_time_deid = scrub(cb, lead.name); }
  setStage(r, 'conversed');
  if (lead.step === 'slot' && Array.isArray(lead.offered) && lead.offered.length) { r.slots_offered = lead.offered.length; setStage(r, 'slot_offered'); }
  store.save();
  return r;
});
// 4) A slot was booked (held for a deposit, or confirmed without one).
const booked = safe('booked', (lead, b) => {
  const r = latestForPhone(lead && lead.phone);
  if (!r || !b) return null;
  r.booking_id = b.id || null; r.deposit_amount = b.status === 'held' ? Number(b.amount) || 0 : 0;
  if (b.slotLabel && !r.callback_time) { r.callback_time = `booked ${String(b.slotLabel).slice(0, 80)}`; r.callback_time_deid = r.callback_time; }
  setStage(r, 'slot_offered'); setStage(r, 'booked');
  store.save();
  return r;
});
// 5) Deposit paid (onPaid). Matched by booking id, else the caller's latest record.
const paid = safe('paid', (b) => {
  if (!b) return null;
  const r = Object.values(table()).find((x) => x && b.id && x.booking_id === b.id) || latestForPhone(b.phone);
  if (!r) return null;
  r.deposit_amount = Number(b.amount) || r.deposit_amount; r.deposit_paid_at = b.paidAt || new Date().toISOString();
  setStage(r, 'booked'); setStage(r, 'deposit_paid');
  store.save();
  return r;
});
// Instant owner buzz sent for this call (missedBuzz). The owner's own reply is not observable by BuzzCall today, so
// owner_response_ms stays null; owner_buzz_latency_ms = missed call -> owner buzzed.
const ownerBuzzed = safe('ownerBuzzed', (callSid, outcome) => {
  const r = get(callSid);
  if (!r || r.owner_buzzed_at) return null;
  r.owner_buzzed_at = new Date().toISOString(); r.owner_buzz_outcome = outcome || null;
  r.owner_buzz_latency_ms = Math.max(0, Date.parse(r.owner_buzzed_at) - Date.parse(r.created_at));
  store.save();
  return r;
});

// ---------- optional email step (OUTCOMES_EMAIL_STEP=1) ----------
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
// Marks the record as asked and returns the ask text, or null (flag off / no record / already asked).
const askEmail = safe('askEmail', (lead) => {
  if (!emailStepOn()) return null;
  const r = latestForPhone(lead && lead.phone);
  if (!r || r.email_step || store.isOptedOut(r.caller_phone)) return null;
  r.email_step = 'asked'; r.email_asked_at = new Date().toISOString(); r.email_attempts = 0;
  store.save();
  return EMAIL_ASK;
});
// Handles a caller SMS while an email ask is pending. Returns { reply, email? } or null (not pending: normal flow).
const emailReply = safe('emailReply', (phone, body, { base = '', sendVerify } = {}) => {
  if (!emailStepOn()) return null;
  const r = latestForPhone(phone);
  if (!r || r.email_step !== 'asked') return null;
  if (Date.now() - Date.parse(r.email_asked_at || 0) > 86400000) { r.email_step = 'expired'; store.save(); return null; }
  const text = String(body || '').trim();
  if (/^skip\.?$/i.test(text) || /^no(\s+thanks?)?\.?$/i.test(text)) { r.email_step = 'skipped'; store.save(); return { reply: 'No problem, no email. See you then!' }; }
  const email = text.toLowerCase();
  if (!validEmail(email)) {
    if ((r.email_attempts || 0) >= 1) { r.email_step = 'abandoned'; store.save(); return null; }
    r.email_attempts = (r.email_attempts || 0) + 1; store.save();
    return { reply: "That doesn't look like an email address. Reply with your email or SKIP." };
  }
  const token = crypto.randomBytes(24).toString('hex');
  r.email_unverified = email; r.email_verified = false; r.email_step = 'captured'; r.email_captured_at = new Date().toISOString();
  r.email_token_hash = tokenHash(token);
  store.save();
  // Token index in the platform store, so /o/verify can find the right shop's record without the URL naming the shop.
  const root = store.root, idx = (root.db.outcomeEmailTokens ||= {}), now = Date.now();
  for (const [k, v] of Object.entries(idx)) if (!(now - Date.parse(v.at) < EMAIL_TOKEN_DAYS * 86400000)) delete idx[k];
  idx[r.email_token_hash] = { shopId: shopContext.shopId() || null, callSid: r.call_sid, at: new Date(now).toISOString() };
  root.save();
  const configured = !!process.env.RESEND_API_KEY;
  const link = `${String(base).replace(/\/+$/, '')}/o/verify/${token}`;
  if (configured && typeof sendVerify === 'function') { try { sendVerify(email, link); } catch {} }
  return { reply: configured ? 'Thanks! We just emailed you a link to confirm your address.' : 'Thanks, got it!', email, link };
});
// /o/verify/:token. Returns { shopId, callSid } for the caller of verify() to run in that shop's context, or null.
function lookupToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const e = (store.root.db.outcomeEmailTokens || {})[tokenHash(token)];
  if (!e || !(Date.now() - Date.parse(e.at) < EMAIL_TOKEN_DAYS * 86400000)) return null;
  return e;
}
// Runs inside the record's shop context. Idempotent.
const verify = safe('verify', (token) => {
  const e = lookupToken(token);
  if (!e) return null;
  const r = get(e.callSid);
  if (!r || r.email_token_hash !== tokenHash(token)) return null;
  if (!r.email_verified) {
    r.email = r.email_unverified || r.email; r.email_unverified = null; r.email_verified = true; r.email_verified_at = new Date().toISOString();
    store.save();
  }
  return r;
});

// ---------- exports (admin) ----------
const COLUMNS = ['call_sid', 'shop_id', 'shop_slug', 'created_at', 'hour_of_day', 'weekday', 'time_zone', 'caller_phone', 'phone_verified', 'verification_method', 'verified_at',
  'consent_digits', 'textback_sent', 'service', 'urgency', 'urgency_keyword', 'callback_time', 'slots_offered', 'booking_id', 'deposit_amount', 'result_stage',
  'owner_buzzed_at', 'owner_buzz_outcome', 'owner_buzz_latency_ms', 'owner_response_ms', 'email', 'email_unverified', 'email_verified', 'email_verified_at', 'training_excluded', 'updated_at'];
// No phone, email, name or CallSid: the caller and the call are salted hashes; free text was scrubbed at capture.
const TRAINING_COLUMNS = ['outcome_id', 'caller_hash', 'shop_id', 'shop_slug', 'created_date', 'hour_of_day', 'weekday', 'phone_verified', 'verification_method',
  'service', 'urgency', 'callback_time', 'slots_offered', 'deposit_amount', 'result_stage', 'reached_consented', 'reached_booked', 'reached_deposit_paid',
  'owner_buzz_latency_ms', 'email_provided', 'email_verified'];
function cell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?\d[\d.]*$/.test(s))) s = `'${s}`; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (columns, rows) => `${columns.join(',')}\r\n${rows.map((r) => columns.map((c) => cell(r[c])).join(',')).join('\r\n')}${rows.length ? '\r\n' : ''}`;
function hashSalt() {
  const env = String(process.env.OUTCOMES_HASH_SALT || '');
  if (env) return env;
  const root = store.root;
  if (!root.db.outcomesHashSalt) { root.db.outcomesHashSalt = crypto.randomBytes(32).toString('hex'); root.save(); }
  return root.db.outcomesHashSalt;
}
const saltedHash = (kind, value, salt = hashSalt()) => (value ? crypto.createHmac('sha256', salt).update(`${kind}:${value}`).digest('hex').slice(0, 32) : null);
function trainingRow(r, salt) {
  const st = r.stage_at || {};
  return {
    outcome_id: saltedHash('call', r.call_sid, salt), caller_hash: saltedHash('caller', r.caller_phone, salt), shop_id: r.shop_id, shop_slug: r.shop_slug,
    created_date: String(r.created_at || '').slice(0, 10), hour_of_day: r.hour_of_day, weekday: r.weekday,
    phone_verified: !!r.phone_verified, verification_method: r.verification_method,
    service: r.service_deid, urgency: r.urgency, callback_time: r.callback_time_deid, slots_offered: r.slots_offered, deposit_amount: r.deposit_amount,
    result_stage: r.result_stage, reached_consented: !!st.consented, reached_booked: !!st.booked, reached_deposit_paid: !!st.deposit_paid,
    owner_buzz_latency_ms: r.owner_buzz_latency_ms, email_provided: !!(r.email || r.email_unverified), email_verified: !!r.email_verified,
  };
}
const sortNewest = (rows) => rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
const recordsOf = (target) => Object.values((target && target.db && target.db.outcomes) || {}).filter((r) => r && typeof r === 'object');
const fullCsv = (rows) => toCsv(COLUMNS, sortNewest([...rows]));
function trainingCsv(rows) {
  const salt = hashSalt();
  return toCsv(TRAINING_COLUMNS, sortNewest(rows.filter((r) => !r.training_excluded)).map((r) => trainingRow(r, salt)));
}
function counts(rows) {
  const c = Object.fromEntries(STAGES.map((s) => [s, 0]));
  let excluded = 0, verified = 0;
  for (const r of rows) { if (c[r.result_stage] !== undefined) c[r.result_stage]++; if (r.training_excluded) excluded++; if (r.phone_verified) verified++; }
  return { total: rows.length, byStage: c, trainingExcluded: excluded, phoneVerified: verified };
}
const reset = () => { hooks.beforeWrite = null; };

module.exports = { STAGES, RANK, EMAIL_ASK, DEFAULT_MAX, hooks, safe, maxRecords, emailStepOn, urgencyOf, scrub, setStage, prune, get, latestForPhone,
  missed, consent, conversation, booked, paid, ownerBuzzed, askEmail, emailReply, lookupToken, verify, validEmail,
  COLUMNS, TRAINING_COLUMNS, toCsv, cell, hashSalt, saltedHash, trainingRow, recordsOf, fullCsv, trainingCsv, counts, reset };
