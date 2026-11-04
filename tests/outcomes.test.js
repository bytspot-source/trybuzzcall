'use strict';
// Outcomes log (src/outcomes.js): one record per CallSid, forward-only stage progression, opt-out exclusion, the
// de-identified training export (no phone/email/name), the email step (off by default) and failure isolation (a
// logging failure never breaks the voice or SMS webhooks).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-outcomes-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER', 'OPENAI_API_KEY', 'DATABASE_URL', 'FORWARD_TO_PHONE', 'VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_TYPE', 'SERVICES', 'BOOKING_LINK',
  'BILLING_REQUIRE_SUBSCRIPTION', 'BILLING_ENFORCE', 'DEMO_MODE', 'ADMIN_USERNAME', 'RENDER', 'CLIENT_IP_HEADER', 'TEXTBACK_COOLDOWN_MINUTES',
  'OUTBOUND_MAX_PER_HOUR', 'OUTBOUND_MAX_PER_DAY', 'RETENTION_DAYS', 'BOOKING_ENABLED', 'DEPOSIT_ENABLED', 'REQUIRE_POSTGRES', 'HELP_MESSAGE',
  'INACTIVE_MESSAGE', 'INACTIVE_MODE', 'KEYWORD_REPLIES', 'VOICE_CONSENT_PROMPT', 'VOICE_CONSENT_SPANISH', 'TEXT_EXTRA_AREA_CODES',
  'INSTANT_MISSED_BUZZ', 'INSTANT_MISSED_BUZZ_FALLBACK_SECONDS', 'INSTANT_MISSED_BUZZ_MAX_PER_HOUR', 'RESEND_API_KEY',
  'OUTCOMES_EMAIL_STEP', 'OUTCOMES_HASH_SALT', 'OUTCOMES_MAX_RECORDS', 'BUSINESS_HOURS', 'BUSINESS_DAYS', 'DEPOSIT_AMOUNT']) delete process.env[k];
const OWNER = '+14045550100';
const PASSWORD = 'outcomes-test-password-long';
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: PASSWORD, BUSINESS_NAME: 'Peach State Plumbing',
  OWNER_PHONE: OWNER, PUBLIC_BASE_URL: 'https://shop.example', TWILIO_PHONE_NUMBER: '+14705550100',
  BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1', DEPOSIT_AMOUNT: '50', BUSINESS_HOURS: '00:00-23:59', BUSINESS_DAYS: '0,1,2,3,4,5,6' });

const store = require('../src/store');
const outcomes = require('../src/outcomes');
const mail = require('../src/email');
const { app, onPaid } = require('../src/server');

let server, BASE;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); BASE = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { app.locals.resetInstantBuzz(); mail.setFetch(null); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const form = (p, fields) => fetch(BASE + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
const admin = (p, auth = true) => fetch(BASE + p, { headers: auth ? { authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}` } : {} });
const smsLog = () => { try { return fs.readFileSync(path.join(dir, 'sms.log'), 'utf8'); } catch { return ''; } };
const sentTo = (p) => smsLog().split('\n').filter((l) => l.includes(`SMS -> ${p}:`));
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const quiet = (t) => { const o = console.error, l = console.log; console.error = () => {}; console.log = () => {}; t.after(() => { console.error = o; console.log = l; }); };
function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
let n = 0; const num = () => `+1404555${String(6000 + (n++)).slice(-4)}`;
let sid = 0; const callSid = () => `CA${String(++sid).padStart(32, '9')}`;
const sms = (From, Body) => form('/twilio/sms', { From, Body });
// Missed call -> press 1 -> name -> job -> slot 1 (held, mock deposit link).
async function bookedCaller(p, CallSid, { name = 'Maria', need = 'water heater leak in the basement' } = {}) {
  await form('/twilio/voice', { From: p, CallSid });
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  await sms(p, name);
  await sms(p, need);
  await sms(p, '1');
  return outcomes.get(CallSid);
}

test('a missed call creates one record per CallSid; pressing 1 verifies the phone', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  assert.match(await (await form('/twilio/voice', { From: p, CallSid })).text(), /<Gather/);
  await form('/twilio/voice', { From: p, CallSid }); // repeated webhook: still one record
  const all = Object.values(store.db.outcomes).filter((r) => r.call_sid === CallSid);
  assert.equal(all.length, 1);
  let r = all[0];
  assert.equal(r.result_stage, 'missed');
  assert.equal(r.shop_id, 'legacy');
  assert.equal(r.shop_slug, 'peach-state-plumbing');
  assert.equal(r.caller_phone, p);
  assert.equal(r.phone_verified, false);
  assert.ok(Number.isInteger(r.hour_of_day) && r.hour_of_day >= 0 && r.hour_of_day < 24);
  assert.match(r.weekday, /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
  assert.ok(Date.parse(r.created_at));
  assert.equal(r.training_excluded, false);
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  await settle();
  r = outcomes.get(CallSid);
  assert.equal(r.result_stage, 'consented');
  assert.equal(r.phone_verified, true);
  assert.equal(r.verification_method, 'voice_press_1');
  assert.ok(Date.parse(r.verified_at));
  assert.equal(r.textback_sent, true);
  assert.ok(r.owner_buzzed_at, 'instant owner buzz time recorded');
  assert.ok(r.owner_buzz_latency_ms >= 0);
  assert.equal(r.owner_response_ms, null);
});

test('declining the prompt records no_consent and no verification', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  await form('/twilio/voice', { From: p, CallSid });
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '2' });
  const r = outcomes.get(CallSid);
  assert.equal(r.result_stage, 'no_consent');
  assert.equal(r.phone_verified, false);
  assert.equal(r.consent_digits, '2');
});

test('stages progress forward through conversation, slot offer, booking and deposit; never backwards', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  await form('/twilio/voice', { From: p, CallSid });
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  await sms(p, 'Maria');
  assert.equal(outcomes.get(CallSid).result_stage, 'conversed');
  await sms(p, 'water heater leak, need someone asap');
  let r = outcomes.get(CallSid);
  assert.equal(r.result_stage, 'slot_offered');
  assert.equal(r.slots_offered, 3);
  assert.match(r.service, /water heater leak/);
  assert.equal(r.urgency, 'urgent');
  assert.ok(['leak', 'asap', 'trade_rule'].includes(r.urgency_keyword), r.urgency_keyword);
  await sms(p, '1');
  r = outcomes.get(CallSid);
  assert.equal(r.result_stage, 'booked');
  assert.ok(r.booking_id);
  assert.equal(r.deposit_amount, 50);
  assert.match(r.callback_time, /^booked /);
  await onPaid(r.booking_id);
  r = outcomes.get(CallSid);
  assert.equal(r.result_stage, 'deposit_paid');
  for (const s of ['missed', 'consented', 'conversed', 'slot_offered', 'booked', 'deposit_paid']) assert.ok(r.stage_at[s], `stage_at.${s}`);
  assert.equal(outcomes.setStage(r, 'conversed'), false, 'no regression');
  assert.equal(r.result_stage, 'deposit_paid');
  // Callback-window path (no slot picked): callback time captured, urgency normal.
  const q = num(), sid2 = callSid();
  await form('/twilio/voice', { From: q, CallSid: sid2 });
  await form('/twilio/voice/consent', { From: q, CallSid: sid2, Digits: '1' });
  await sms(q, 'Dave'); await sms(q, 'faucet replacement'); await sms(q, 'callback'); await sms(q, 'after 5pm');
  const r2 = outcomes.get(sid2);
  assert.equal(r2.urgency, 'normal');
  assert.equal(r2.callback_time, 'after 5pm');
  assert.equal(r2.result_stage, 'slot_offered');
});

test('urgency keyword rule', () => {
  for (const s of ['EMERGENCY pipe burst', 'roof leak', 'no heat in the house', 'need it ASAP']) assert.equal(outcomes.urgencyOf(s).urgency, 'urgent', s);
  assert.equal(outcomes.urgencyOf('new faucet install').urgency, 'normal');
  assert.equal(outcomes.urgencyOf('').urgency, null);
});

test('STOP sets training_excluded on all of that caller\'s records and marks the latest opted_out', async (t) => {
  quiet(t);
  const p = num(), first = callSid(), second = callSid(), other = num(), otherSid = callSid();
  await form('/twilio/voice', { From: p, CallSid: first });
  await form('/twilio/voice/consent', { From: p, CallSid: first, Digits: '2' });
  await form('/twilio/voice', { From: p, CallSid: second });
  await form('/twilio/voice/consent', { From: p, CallSid: second, Digits: '1' });
  await form('/twilio/voice', { From: other, CallSid: otherSid });
  await sms(p, 'STOP');
  assert.equal(outcomes.get(first).training_excluded, true);
  assert.equal(outcomes.get(second).training_excluded, true);
  assert.equal(outcomes.get(second).result_stage, 'opted_out');
  assert.equal(outcomes.get(first).result_stage, 'no_consent', 'older record keeps its stage');
  assert.equal(outcomes.get(otherSid).training_excluded, false, 'other callers unaffected');
  const csv = await (await admin('/admin/outcomes-training.csv')).text();
  const ids = [first, second].map((s) => outcomes.saltedHash('call', s));
  for (const id of ids) assert.ok(!csv.includes(id), 'excluded from the training export');
  assert.ok(csv.includes(outcomes.saltedHash('call', otherSid)));
  // A new call from an opted-out number starts excluded.
  const third = callSid();
  await form('/twilio/voice', { From: p, CallSid: third });
  assert.equal(outcomes.get(third).training_excluded, true);
});

test('email step is OFF by default: no ask after booking, and an email reply is not captured', async (t) => {
  quiet(t);
  assert.equal(outcomes.emailStepOn(), false);
  const p = num(), CallSid = callSid();
  await bookedCaller(p, CallSid);
  assert.ok(!sentTo(p).some((l) => l.includes('confirmation by email')), 'no email ask');
  await sms(p, 'maria@example.com');
  const r = outcomes.get(CallSid);
  assert.equal(r.email_unverified, null);
  assert.equal(r.email_step, null);
});

test('email step ON: ask after booking, validate, store unverified, one-tap verify; no sender = nothing emailed', async (t) => {
  quiet(t);
  withEnv(t, { OUTCOMES_EMAIL_STEP: '1' });
  const sent = [];
  mail.setFetch(async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; });
  t.after(() => mail.setFetch(null));
  // Without RESEND_API_KEY: stored, nothing emailed.
  const p = num(), CallSid = callSid();
  await bookedCaller(p, CallSid);
  assert.ok(sentTo(p).some((l) => l.includes(outcomes.EMAIL_ASK)), 'asked after booking');
  await sms(p, 'not an email');
  assert.ok(sentTo(p).at(-1).includes("doesn't look like an email"));
  await sms(p, 'Maria@Example.com');
  let r = outcomes.get(CallSid);
  assert.equal(r.email_unverified, 'maria@example.com');
  assert.equal(r.email_verified, false);
  await mail.settle();
  assert.equal(sent.length, 0, 'no email without RESEND_API_KEY');
  // SKIP path.
  const s = num(), sSid = callSid();
  await bookedCaller(s, sSid);
  await sms(s, 'SKIP');
  assert.equal(outcomes.get(sSid).email_step, 'skipped');
  // With a sender configured: the link is emailed and verifies with one tap.
  withEnv(t, { RESEND_API_KEY: 'test-only-not-a-real-key' });
  const q = num(), qSid = callSid();
  await bookedCaller(q, qSid);
  await sms(q, 'dave@example.org');
  await mail.settle();
  assert.equal(sent.length, 1);
  const link = sent[0].text.match(/https:\/\/shop\.example(\/o\/verify\/[a-f0-9]{48})/);
  assert.ok(link, 'verify link in the email');
  const res = await fetch(BASE + link[1]);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /no-store/);
  r = outcomes.get(qSid);
  assert.equal(r.email_verified, true);
  assert.equal(r.email, 'dave@example.org');
  assert.ok(r.email_verified_at);
  assert.equal((await fetch(BASE + link[1])).status, 200, 'idempotent');
  assert.equal((await fetch(`${BASE}/o/verify/${'0'.repeat(48)}`)).status, 404);
  assert.equal((await fetch(`${BASE}/o/verify/nope`)).status, 404);
});

test('admin: outcomes page and CSVs need auth; training CSV has no phone, email, name or CallSid', async (t) => {
  quiet(t);
  withEnv(t, { OUTCOMES_EMAIL_STEP: '1', OUTCOMES_HASH_SALT: 'test-salt' });
  const p = num(), CallSid = callSid();
  await bookedCaller(p, CallSid, { name: 'Rosalind Okafor', need: 'leak, call Rosalind at 404-555-1212 or rosalind@example.net' });
  await sms(p, 'rosalind@example.com');
  for (const u of ['/admin/outcomes', '/admin/outcomes.csv', '/admin/outcomes-training.csv']) assert.equal((await admin(u, false)).status, 401, u);
  const page = await admin('/admin/outcomes');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Outcomes/); assert.match(html, /Count per stage/); assert.match(html, /outcomes-training\.csv/);
  assert.ok(!html.includes(p), 'phones masked on screen');
  const full = await admin('/admin/outcomes.csv');
  assert.match(full.headers.get('content-type'), /text\/csv/);
  const fullCsv = await full.text();
  assert.ok(fullCsv.includes(p) && fullCsv.includes('rosalind@example.com'), 'operations CSV has phone and email');
  const train = await admin('/admin/outcomes-training.csv');
  assert.equal(train.status, 200);
  const csv = await train.text();
  const header = csv.split('\r\n')[0].split(',');
  for (const bad of ['caller_phone', 'phone', 'email', 'email_unverified', 'name', 'call_sid']) assert.ok(!header.includes(bad), bad);
  assert.ok(header.includes('caller_hash'));
  assert.ok(!/\+1\d{10}/.test(csv), 'no phone numbers');
  assert.ok(!/404-555-1212/.test(csv), 'phone in free text scrubbed');
  assert.ok(!/@/.test(csv), 'no emails');
  assert.ok(!/Rosalind|Okafor/i.test(csv), 'no names');
  assert.ok(!csv.includes(CallSid), 'no CallSid');
  const row = csv.split('\r\n').find((l) => l.startsWith(outcomes.saltedHash('call', CallSid, 'test-salt')));
  assert.ok(row, 'row present');
  assert.ok(row.includes(outcomes.saltedHash('caller', p, 'test-salt')), 'caller replaced by the salted hash');
  assert.ok(row.includes('[number]') && row.includes('[email]') && row.includes('[name]'));
});

test('hash salt falls back to a random salt persisted in the platform store', (t) => {
  withEnv(t, { OUTCOMES_HASH_SALT: undefined });
  const a = outcomes.hashSalt();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(outcomes.hashSalt(), a);
  assert.equal(store.root.db.outcomesHashSalt, a);
});

test('retention: records are capped and the oldest pruned', (t) => {
  quiet(t);
  withEnv(t, { OUTCOMES_MAX_RECORDS: '3' });
  const saved = store.db.outcomes;
  store.db.outcomes = {};
  t.after(() => { store.db.outcomes = saved; store.save(); });
  const sids = [1, 2, 3, 4, 5].map(() => callSid());
  sids.forEach((s, i) => { outcomes.missed({ callSid: s, from: num() }); store.db.outcomes[s].created_at = new Date(Date.UTC(2026, 0, 1 + i)).toISOString(); });
  assert.equal(Object.keys(store.db.outcomes).length, 3);
  // The cap is enforced on insert; the two oldest (by created_at at insert time) were dropped.
  assert.ok(!store.db.outcomes[sids[0]] && !store.db.outcomes[sids[1]]);
  assert.equal(outcomes.maxRecords(), 3);
  withEnv(t, { OUTCOMES_MAX_RECORDS: undefined });
  assert.equal(outcomes.maxRecords(), 50000);
});

test('a logging failure never breaks the voice or SMS routes', async (t) => {
  quiet(t);
  outcomes.hooks.beforeWrite = () => { throw new Error('disk full'); };
  t.after(() => outcomes.reset());
  const p = num(), CallSid = callSid();
  const v = await (await form('/twilio/voice', { From: p, CallSid })).text();
  assert.match(v, /<Gather/);
  const c = await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  assert.equal(c.status, 200);
  assert.match(await c.text(), /We just texted you/);
  const s = await sms(p, 'Maria');
  assert.equal(s.status, 200);
  await sms(p, 'clogged drain');
  assert.equal(sentTo(p).length, 3, 'text-back plus two conversation replies still sent');
  const booked = await sms(p, '1');
  assert.equal(booked.status, 200);
  assert.ok(sentTo(p).at(-1).includes('deposit'), 'booking still confirmed');
  assert.equal(outcomes.get(CallSid), null, 'nothing recorded, nothing broken');
});

test('CSV cells are quoted and formula-safe', () => {
  assert.equal(outcomes.cell('a,b'), '"a,b"');
  assert.equal(outcomes.cell('say "hi"'), '"say ""hi"""');
  assert.equal(outcomes.cell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(outcomes.cell('+14045550100'), '+14045550100');
  assert.equal(outcomes.cell(null), '');
});

test('vendor shops keep outcomes in their own store; the admin export covers every shop', async (t) => {
  quiet(t);
  const vendors = require('../src/vendors');
  const { shop } = await vendors.create({ name: 'Aster Braids', email: 'aster@example.com' });
  const CallSid = callSid(), p = num();
  await vendors.run(shop.id, () => outcomes.missed({ callSid: CallSid, from: p, offered: true }), { suspended: true });
  assert.equal(store.root.db.outcomes[CallSid], undefined, 'not in the legacy store');
  const child = await vendors.scopedStore(shop);
  assert.equal(child.db.outcomes[CallSid].shop_id, shop.id);
  const csv = await (await admin('/admin/outcomes.csv')).text();
  assert.ok(csv.includes(CallSid) && csv.includes(shop.id));
});
