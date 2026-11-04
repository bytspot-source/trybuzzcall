'use strict';
// Instant owner buzz on a missed call (INSTANT_MISSED_BUZZ): exactly one short SMS to the owner per CallSid, worded by
// the press-1 outcome, deduped across repeated status/consent callbacks, off with INSTANT_MISSED_BUZZ=0, and never for
// anonymous / non-US-Canada caller IDs. The end-of-conversation buzz is unchanged (covered elsewhere).
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

const store = require('../src/store');
const { app } = require('../src/server');

let server, BASE;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); BASE = `http://127.0.0.1:${server.address().port}`; });
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

test('missed call + press 1: exactly one instant buzz, "texting them now"; repeated consent callback does not re-buzz', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  assert.match(await (await form('/twilio/voice', { From: p, CallSid })).text(), /<Gather/);
  assert.equal(app.locals.instantBuzzPending(), 1, 'fallback armed while the caller hears the prompt');
  await settle();
  assert.equal(buzzesFor(p).length, 0, 'no buzz until the press-1 outcome is known');
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  await settle();
  const b = buzzesFor(p);
  assert.equal(b.length, 1);
  assert.ok(b[0].endsWith(`: ${PREFIX} ${p} just now. Pressed 1 - texting them now.`), b[0]);
  assert.equal(app.locals.instantBuzzPending(), 0, 'fallback cleared');
  assert.equal(sentTo(p).length, 1, 'caller still gets exactly one text-back');
});

test('forwarded call: repeated no-answer status callbacks + declined prompt -> one buzz "Didn\'t opt in"', async (t) => {
  quiet(t);
  withEnv(t, { FORWARD_TO_PHONE: '+14045550199' });
  const p = num(), CallSid = callSid();
  assert.match(await (await form('/twilio/voice', { From: p, CallSid })).text(), /<Dial/);
  assert.equal(app.locals.instantBuzzPending(), 0, 'ringing the owner is not a missed call yet');
  for (let i = 0; i < 3; i++) assert.match(await (await form('/twilio/voice/status', { From: p, CallSid, DialCallStatus: 'no-answer' })).text(), /<Gather/);
  assert.equal(app.locals.instantBuzzPending(), 1, 'repeat callbacks do not arm twice');
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '2' });
  await form('/twilio/voice/status', { From: p, CallSid, DialCallStatus: 'no-answer' });
  await settle();
  const b = buzzesFor(p);
  assert.equal(b.length, 1);
  assert.ok(b[0].endsWith(`: ${PREFIX} ${p} just now. Didn't opt in to texts - call them back.`), b[0]);
  assert.equal(app.locals.instantBuzzPending(), 0);
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
  assert.equal(app.locals.instantBuzzPending(), 0);
});

test('caller hangs up during the prompt (no consent callback): fallback timer buzzes once; a late callback does not re-buzz', async (t) => {
  quiet(t);
  withEnv(t, { INSTANT_MISSED_BUZZ_FALLBACK_SECONDS: '0.05' });
  const p = num(), CallSid = callSid();
  await form('/twilio/voice', { From: p, CallSid });
  await settle(250);
  assert.equal(app.locals.instantBuzzPending(), 0);
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '' });
  await settle();
  const b = buzzesFor(p);
  assert.equal(b.length, 1);
  assert.ok(b[0].endsWith(`: ${PREFIX} ${p} just now. Didn't opt in to texts - call them back.`), b[0]);
});

test('pressed 1 but the text-back was throttled: buzz says no text went out', async (t) => {
  quiet(t);
  const p = num();
  for (const _ of [1, 2]) {
    const CallSid = callSid();
    await form('/twilio/voice', { From: p, CallSid });
    await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  }
  await settle();
  const b = buzzesFor(p);
  assert.equal(b.length, 2, 'one buzz per missed call (different CallSids)');
  assert.ok(b[0].endsWith('Pressed 1 - texting them now.'));
  assert.ok(b[1].endsWith('Pressed 1 but no text went out - call them back.'), b[1]);
  assert.equal(sentTo(p).length, 1, 'caller texted once (cooldown)');
});

test('opted-out caller: no prompt, instant buzz right away says opted out; caller gets nothing', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  await store.optOut(p, 'test');
  assert.doesNotMatch(await (await form('/twilio/voice', { From: p, CallSid })).text(), /<Gather/);
  await settle();
  const b = buzzesFor(p);
  assert.equal(b.length, 1);
  assert.ok(b[0].endsWith(`: ${PREFIX} ${p} just now. Opted out of texts - call them back.`), b[0]);
  assert.equal(app.locals.instantBuzzPending(), 0);
  assert.equal(sentTo(p).length, 0);
});

test('INSTANT_MISSED_BUZZ=0: no instant buzz, no timer; the text-back flow is unchanged', async (t) => {
  quiet(t);
  withEnv(t, { INSTANT_MISSED_BUZZ: '0' });
  const p = num(), CallSid = callSid();
  await form('/twilio/voice', { From: p, CallSid });
  assert.equal(app.locals.instantBuzzPending(), 0);
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  await settle();
  assert.equal(buzzesFor(p).length, 0);
  assert.equal(sentTo(p).length, 1, 'caller still texted after pressing 1');
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
  assert.equal(app.locals.instantBuzzPending(), 0);
  assert.equal(sentTo(OWNER).filter((l) => l.includes('Missed call from')).length, before);
});

test('per-line ceiling INSTANT_MISSED_BUZZ_MAX_PER_HOUR bounds a call flood', async (t) => {
  quiet(t);
  app.locals.resetInstantBuzz();
  withEnv(t, { INSTANT_MISSED_BUZZ_MAX_PER_HOUR: '2' });
  t.after(() => app.locals.resetInstantBuzz());
  const nums = [num(), num(), num()];
  for (const p of nums) { const CallSid = callSid(); await form('/twilio/voice', { From: p, CallSid }); await form('/twilio/voice/consent', { From: p, CallSid, Digits: '2' }); }
  await settle();
  assert.deepEqual(nums.map((p) => buzzesFor(p).length), [1, 1, 0]);
});
