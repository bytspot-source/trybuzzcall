'use strict';
// Instant owner buzz on a missed call (INSTANT_MISSED_BUZZ): exactly one short SMS to the owner per CallSid, worded by
// what happened to the caller (texting with written permission on file, no text, no permission, SMS off, opted out),
// deduped across repeated callbacks, off with INSTANT_MISSED_BUZZ=0, never for anonymous / non-US-Canada caller IDs,
// and only with the owner's own owner_alerts permission. The end-of-conversation buzz is covered elsewhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-instant-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER', 'OPENAI_API_KEY', 'DATABASE_URL', 'FORWARD_TO_PHONE', 'VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_TYPE', 'SERVICES', 'BOOKING_LINK',
  'BILLING_REQUIRE_SUBSCRIPTION', 'BILLING_ENFORCE', 'DEMO_MODE', 'ADMIN_USERNAME', 'RENDER', 'CLIENT_IP_HEADER', 'TEXTBACK_COOLDOWN_MINUTES',
  'OUTBOUND_MAX_PER_HOUR', 'OUTBOUND_MAX_PER_DAY', 'RETENTION_DAYS', 'BOOKING_ENABLED', 'DEPOSIT_ENABLED', 'REQUIRE_POSTGRES', 'HELP_MESSAGE',
  'INACTIVE_MESSAGE', 'INACTIVE_MODE', 'KEYWORD_REPLIES', 'VOICE_CONSENT_PROMPT', 'VOICE_CONSENT_SPANISH', 'TEXT_EXTRA_AREA_CODES',
  'INSTANT_MISSED_BUZZ', 'INSTANT_MISSED_BUZZ_FALLBACK_SECONDS', 'INSTANT_MISSED_BUZZ_MAX_PER_HOUR']) delete process.env[k];
const OWNER = '+14045550100';
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: 'instant-buzz-test-password-long', BUSINESS_NAME: 'Peach State Plumbing',
  OWNER_PHONE: OWNER, PUBLIC_BASE_URL: 'https://shop.example', TWILIO_PHONE_NUMBER: '+14705550100' });
const { enableSms, grantSms } = require('./helpers/smsPermission');
enableSms();

const store = require('../src/store');
const { app } = require('../src/server');

let server, BASE;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); BASE = `http://127.0.0.1:${server.address().port}`; await grantSms(OWNER, 'owner_alerts'); });
test.after(() => { app.locals.resetInstantBuzz(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const form = (p, fields) => fetch(BASE + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
const smsLog = () => { try { return fs.readFileSync(path.join(dir, 'sms.log'), 'utf8'); } catch { return ''; } };
const sentTo = (p) => smsLog().split('\n').filter((l) => l.includes(`SMS -> ${p}:`));
// Owner buzzes about one caller (the buzz is sent just after the TwiML reply, so give it a moment).
const buzzesFor = (p) => sentTo(OWNER).filter((l) => l.includes(`Missed call from ${p} just now`));
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const quiet = (t) => { const o = console.error, l = console.log; console.error = () => {}; console.log = () => {}; t.after(() => { console.error = o; console.log = l; }); };
function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
let n = 0; const num = () => `+1404555${String(3000 + (n++)).slice(-4)}`;
let sid = 0; const callSid = () => `CA${String(++sid).padStart(32, '7')}`;
const PREFIX = 'BUZZ Peach State Plumbing: Missed call from';

test('missed call with written permission: exactly one instant buzz, "texting them now"; repeated webhook does not re-buzz', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  await grantSms(p);
  assert.doesNotMatch(await (await form('/twilio/voice', { From: p, CallSid })).text(), /<Gather/);
  await form('/twilio/voice', { From: p, CallSid });
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  await settle();
  const b = buzzesFor(p);
  assert.equal(b.length, 1);
  assert.ok(b[0].endsWith(`: ${PREFIX} ${p} just now. Texting them now (written text permission on file).`), b[0]);
  assert.doesNotMatch(b[0], /Pressed 1/);
  assert.equal(app.locals.instantBuzzPending(), 0);
  assert.equal(sentTo(p).length, 1, 'caller gets exactly one text-back');
});

test('forwarded call: repeated no-answer status callbacks, no permission on file -> one buzz "No text permission on file"', async (t) => {
  quiet(t);
  withEnv(t, { FORWARD_TO_PHONE: '+14045550199' });
  const p = num(), CallSid = callSid();
  assert.match(await (await form('/twilio/voice', { From: p, CallSid })).text(), /<Dial/);
  for (let i = 0; i < 3; i++) assert.doesNotMatch(await (await form('/twilio/voice/status', { From: p, CallSid, DialCallStatus: 'no-answer' })).text(), /<Gather/);
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  await settle();
  const b = buzzesFor(p);
  assert.equal(b.length, 1);
  assert.ok(b[0].endsWith(`: ${PREFIX} ${p} just now. No text permission on file - call them back.`), b[0]);
  assert.equal(sentTo(p).length, 0, 'caller is not texted');
});

test('answered forwarded call never buzzes', async (t) => {
  quiet(t);
  withEnv(t, { FORWARD_TO_PHONE: '+14045550199' });
  const p = num(), CallSid = callSid();
  await form('/twilio/voice', { From: p, CallSid });
  await form('/twilio/voice/status', { From: p, CallSid, DialCallStatus: 'completed' });
  await settle();
  assert.equal(buzzesFor(p).length, 0);
});

test('texting turned off: buzz says so; the permitted caller is not texted', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  await grantSms(p);
  process.env.SMS_ENABLED = '0';
  try { await form('/twilio/voice', { From: p, CallSid }); } finally { process.env.SMS_ENABLED = '1'; }
  await settle();
  const owner = buzzesFor(p);
  assert.equal(owner.length, 0, 'owner alerts are blocked too while SMS is off');
  assert.equal(store.db.alerts.find((a) => a.body.includes(`Missed call from ${p}`)).body.endsWith('Texting is turned off - call them back.'), true);
  assert.equal(sentTo(p).length, 0);
});

test('permitted caller but the text-back was throttled: buzz says no text went out', async (t) => {
  quiet(t);
  const p = num();
  await grantSms(p);
  for (const _ of [1, 2]) await form('/twilio/voice', { From: p, CallSid: callSid() });
  await settle();
  const b = buzzesFor(p);
  assert.equal(b.length, 2, 'one buzz per missed call (different CallSids)');
  assert.ok(b[0].endsWith('Texting them now (written text permission on file).'));
  assert.ok(b[1].endsWith('No text went out - call them back.'), b[1]);
  assert.equal(sentTo(p).length, 1, 'caller texted once (cooldown)');
});

test('opted-out caller: instant buzz right away says opted out; caller gets nothing', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  await grantSms(p);
  await store.optOut(p, 'test');
  assert.doesNotMatch(await (await form('/twilio/voice', { From: p, CallSid })).text(), /<Gather/);
  await settle();
  const b = buzzesFor(p);
  assert.equal(b.length, 1);
  assert.ok(b[0].endsWith(`: ${PREFIX} ${p} just now. Opted out of texts - call them back.`), b[0]);
  assert.equal(sentTo(p).length, 0);
});

test('owner without owner_alerts permission gets no buzz; the alert is still logged as not sent', async (t) => {
  quiet(t);
  const other = '+14045550177';
  withEnv(t, { OWNER_PHONE: other });
  const p = num();
  await form('/twilio/voice', { From: p, CallSid: callSid() });
  await settle();
  assert.equal(sentTo(other).length, 0);
  const alert = store.db.alerts.find((a) => a.body.includes(`Missed call from ${p}`));
  assert.equal(alert.sent, false);
  assert.equal(alert.delivery, 'consent_required');
});

test('INSTANT_MISSED_BUZZ=0: no instant buzz; the text-back flow is unchanged', async (t) => {
  quiet(t);
  withEnv(t, { INSTANT_MISSED_BUZZ: '0' });
  const p = num(), CallSid = callSid();
  await grantSms(p);
  await form('/twilio/voice', { From: p, CallSid });
  await settle();
  assert.equal(buzzesFor(p).length, 0);
  assert.equal(sentTo(p).length, 1, 'permitted caller still texted');
});

test('anonymous, blank and non-US/Canada caller IDs: no instant buzz (nothing to call back, fraud guard)', async (t) => {
  quiet(t);
  const before = sentTo(OWNER).filter((l) => l.includes('Missed call from')).length;
  for (const From of ['anonymous', '', '+266696687', '+447700900123', '+19005550123']) {
    const CallSid = callSid();
    assert.doesNotMatch(await (await form('/twilio/voice', { From, CallSid })).text(), /<Gather/);
    await form('/twilio/voice/consent', { From, CallSid, Digits: '1' });
  }
  await settle();
  assert.equal(sentTo(OWNER).filter((l) => l.includes('Missed call from')).length, before);
});

test('per-line ceiling INSTANT_MISSED_BUZZ_MAX_PER_HOUR bounds a call flood', async (t) => {
  quiet(t);
  app.locals.resetInstantBuzz();
  withEnv(t, { INSTANT_MISSED_BUZZ_MAX_PER_HOUR: '2' });
  t.after(() => app.locals.resetInstantBuzz());
  const nums = [num(), num(), num()];
  for (const p of nums) await form('/twilio/voice', { From: p, CallSid: callSid() });
  await settle();
  assert.deepEqual(nums.map((p) => buzzesFor(p).length), [1, 1, 0]);
});
