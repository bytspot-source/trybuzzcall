'use strict';
// A2P 10DLC compliance (2026-11-03): voice consent before any text (press 1), consent log, no text without a shop
// name, HELP/START/STOP and lapsed-shop wording, and the public per-shop SMS page (/s/<slug>/sms).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-a2p-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER', 'OPENAI_API_KEY', 'DATABASE_URL', 'FORWARD_TO_PHONE', 'VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_TYPE', 'SERVICES', 'BOOKING_LINK',
  'BILLING_REQUIRE_SUBSCRIPTION', 'BILLING_ENFORCE', 'DEMO_MODE', 'ADMIN_USERNAME', 'RENDER', 'CLIENT_IP_HEADER', 'TEXTBACK_COOLDOWN_MINUTES',
  'OUTBOUND_MAX_PER_HOUR', 'OUTBOUND_MAX_PER_DAY', 'RETENTION_DAYS', 'BOOKING_ENABLED', 'DEPOSIT_ENABLED', 'REQUIRE_POSTGRES', 'HELP_MESSAGE',
  'INACTIVE_MESSAGE', 'INACTIVE_MODE', 'KEYWORD_REPLIES', 'VOICE_CONSENT_PROMPT', 'VOICE_CONSENT_SPANISH', 'TEXT_EXTRA_AREA_CODES', 'VOICE_NAME', 'VOICE_NAME_ES',
  'MISSED_CALL_SAY', 'INSTANT_MISSED_BUZZ', 'INSTANT_MISSED_BUZZ_FALLBACK_SECONDS', 'INSTANT_MISSED_BUZZ_MAX_PER_HOUR']) delete process.env[k];
const OWNER = '+14045550100';
const OWNER_EMAIL = 'owner-private@example.com';
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: 'a2p-test-password-long-enough', BUSINESS_NAME: 'Peach State Plumbing',
  OWNER_PHONE: OWNER, PUBLIC_BASE_URL: 'https://shop.example', TWILIO_PHONE_NUMBER: '+14705550100' });

const store = require('../src/store');
const sms = require('../src/sms');
const consent = require('../src/consent');
const smsPage = require('../src/smsPage');
const { app } = require('../src/server');

let server, BASE;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); BASE = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { app.locals.resetInstantBuzz(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const req = (p, opts = {}) => fetch(BASE + p, { redirect: 'manual', ...opts });
const form = (p, fields, headers = {}) => req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
const smsLog = () => { try { return fs.readFileSync(path.join(dir, 'sms.log'), 'utf8'); } catch { return ''; } };
const sentTo = (p) => smsLog().split('\n').filter((l) => l.includes(`SMS -> ${p}:`));
const quiet = (t) => { const o = console.error, l = console.log; console.error = () => {}; console.log = () => {}; t.after(() => { console.error = o; console.log = l; }); };
function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
let n = 0; const num = () => `+1404555${String(2000 + (n++)).slice(-4)}`;
let sid = 0; const callSid = () => `CA${String(++sid).padStart(32, '0')}`;
const xmlText = (s) => s.replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PROMPT = "Peach State Plumbing can't take your call right now. Press 1 and we'll text you at this number to get you booked. Message frequency varies, message and data rates may apply. Reply STOP to opt out or HELP for help.";
const gatherAction = (xml) => {
  const match = xml.match(/<Gather\b[^>]*\baction="([^"]+)"/);
  assert.ok(match, 'response offers a Gather action');
  const url = new URL(match[1].replace(/&amp;/g, '&'));
  return url.pathname + url.search;
};

// ---------- 1. voice consent before texting ----------
test('missed call plays the press-1 opt-in prompt and texts nothing yet', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  const r = await form('/twilio/voice', { From: p, CallSid });
  assert.equal(r.status, 200);
  const xml = await r.text();
  assert.match(xml, /<Gather input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true" action="https:\/\/shop\.example\/twilio\/voice\/consent" method="POST">/);
  assert.ok(xml.includes(`<Say voice="Polly.Joanna-Neural">${xmlText(PROMPT)}</Say></Gather>`), 'exact opt-in script inside the Gather');
  assert.doesNotMatch(xml, /just texted|just sent you a text/i, 'never claims a text was sent');
  assert.equal(sentTo(p).length, 0, 'no text before consent');
  assert.ok(!store.findOpenLead(p), 'no lead before consent');
  assert.equal(consent.voicePrompt(), PROMPT);
});
test('first silence replays the full script; second silence ends without texting or a duplicate owner buzz', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid(), fields = { From: p, CallSid };
  const initial = await (await form('/twilio/voice', fields)).text();
  const first = await (await form(gatherAction(initial), fields)).text();
  assert.equal(gatherAction(first), '/twilio/voice/consent?attempt=2');
  assert.equal(first, initial.replace(gatherAction(initial), gatherAction(first)), 'one replay of the entire required script, not a shortened reminder');
  assert.equal(sentTo(p).length, 0);
  assert.equal(sentTo(OWNER).filter((l) => l.includes(`Missed call from ${p} `)).length, 0, 'no owner buzz on first silence');
  assert.equal(store.db.outcomes[CallSid].result_stage, 'missed', 'first silence is not a final no-consent outcome');
  const firstRecord = consent.latest(CallSid, p);
  assert.deepEqual([firstRecord.attempt, firstRecord.state, firstRecord.digits, firstRecord.prompt], [1, 'retry', '', PROMPT]);
  assert.ok(Number.isFinite(Date.parse(firstRecord.promptedAt)));
  // Reload persisted state as at boot: the recorded first silence still authorizes only attempt 2.
  store.db.voiceConsents = store.createStore({ dir }).db.voiceConsents;
  for (const route of ['/twilio/voice', '/twilio/voice/status']) {
    assert.doesNotMatch(await (await form(route, { ...fields, DialCallStatus: 'no-answer' })).text(), /<Gather/);
  }
  const second = await (await form(gatherAction(first), { ...fields, Digits: '' })).text();
  assert.doesNotMatch(second, /<Gather/);
  assert.match(second, /We didn&apos;t get a response, so we won&apos;t text you/);
  assert.match(second, /Goodbye\.<\/Say><Hangup\/>/);
  assert.equal(consent.latest(CallSid, p).attempt, 2);
  assert.equal(store.db.outcomes[CallSid].result_stage, 'no_consent');
  const closed = structuredClone(consent.latest(CallSid, p));
  for (const action of [gatherAction(initial), gatherAction(first)]) {
    for (const Digits of ['', '', '1']) {
      assert.doesNotMatch(await (await form(action, { ...fields, Digits })).text(), /<Gather/);
      assert.deepEqual(consent.latest(CallSid, p), closed, 'terminal callbacks never reset or overwrite the saved answer');
    }
  }
  assert.equal(store.db.voiceConsents.filter((c) => c.callSid === CallSid).length, 2, 'duplicates do not append evidence');
  assert.equal(sentTo(p).length, 0);
  assert.ok(!store.findOpenLead(p));
  assert.equal(sentTo(OWNER).filter((l) => l.includes(`Missed call from ${p} `)).length, 1, 'one final owner buzz');
});
test('any non-1 answer is a terminal explicit decline, with no replay or late opt-in', async (t) => {
  quiet(t);
  for (const Digits of ['2', '0', '*', '#', '11', 'x1']) {
    const p = num(), CallSid = callSid(), fields = { From: p, CallSid };
    await form('/twilio/voice', fields);
    const xml = await (await form('/twilio/voice/consent', { ...fields, Digits })).text();
    assert.doesNotMatch(xml, /<Gather/);
    assert.match(xml, /Okay, we won&apos;t text you/);
    assert.match(xml, /Goodbye\.<\/Say><Hangup\/>/);
    const rec = consent.latest(CallSid, p);
    assert.deepEqual([rec.from, rec.shopId, rec.digits, rec.consented, rec.attempt], [p, 'legacy', Digits, false, 1]);
    for (const answer of ['', '1']) assert.doesNotMatch(await (await form('/twilio/voice/consent', { ...fields, Digits: answer })).text(), /<Gather/);
    assert.equal(sentTo(p).length, 0, `Digits=${JSON.stringify(Digits)}: no text`);
    assert.ok(!store.findOpenLead(p));
  }
});
test('press 1 on either attempt texts once, names the business and explains how to continue in text', async (t) => {
  quiet(t);
  withEnv(t, { TEXTBACK_COOLDOWN_MINUTES: '0' });
  for (const replay of [false, true]) {
    const p = num(), CallSid = callSid(), fields = { From: p, CallSid };
    let prompt = await (await form('/twilio/voice', fields)).text();
    if (replay) prompt = await (await form(gatherAction(prompt), fields)).text();
    const action = gatherAction(prompt);
    assert.equal(sentTo(p).length, 0, 'no text before 1');
    const xml = await (await form(action, { ...fields, Digits: '1' })).text();
    assert.match(xml, /Thanks for calling Peach State Plumbing\. We just texted you\./);
    assert.match(xml, /hang up now and reply to that text to continue\. Goodbye\./);
    assert.doesNotMatch(xml, /<Gather/);
    const rec = consent.latest(CallSid, p);
    assert.deepEqual([rec.consented, rec.digits, rec.from, rec.shopId, rec.attempt], [true, '1', p, 'legacy', replay ? 2 : 1]);
    assert.ok(Number.isFinite(Date.parse(rec.at))); assert.equal(rec.prompt, PROMPT);
    // Even with the phone cooldown disabled, overlapping redeliveries cannot send another initial text.
    await Promise.all([1, 2, 3].map(() => form(action, { ...fields, Digits: '1' })));
    assert.equal(sentTo(p).length, 1);
    assert.match(sentTo(p)[0], /Hi, this is Peach State Plumbing\./);
    assert.equal(store.db.outcomes[CallSid].textback_sent, true, 'duplicates do not overwrite the successful outcome');
    assert.equal(sentTo(OWNER).filter((l) => l.includes(`Missed call from ${p} `)).length, 1);
  }
});
test('duplicate first silence returns the same replay without renewing the fallback; real replay press 1 texts once', async (t) => {
  quiet(t);
  withEnv(t, { TEXTBACK_COOLDOWN_MINUTES: '0', INSTANT_MISSED_BUZZ_FALLBACK_SECONDS: '120' });
  const originalTimeout = global.setTimeout;
  let fallbackTimers = 0;
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 120000) fallbackTimers++;
    return originalTimeout(callback, ms, ...args);
  });
  const p = num(), CallSid = callSid(), fields = { From: p, CallSid };
  const initial = await (await form('/twilio/voice', fields)).text();
  const action = gatherAction(initial);
  const results = await Promise.all([1, 2, 3].map(async () => (await form(action, fields)).text()));
  const replay = results[0];
  assert.equal(gatherAction(replay), '/twilio/voice/consent?attempt=2');
  assert.ok(results.every((xml) => xml === replay), 'overlapping first silences all receive the same replay');
  const saved = structuredClone(consent.latest(CallSid, p));
  assert.deepEqual([saved.attempt, saved.state], [1, 'retry']);
  for (let i = 0; i < 5; i++) assert.equal(await (await form(action, fields)).text(), replay);
  assert.deepEqual(consent.latest(CallSid, p), saved, 'duplicate silence does not change timestamps or evidence');
  assert.equal(store.db.voiceConsents.filter((c) => c.callSid === CallSid).length, 1);
  assert.equal(fallbackTimers, 2, 'only the offer and first silence arm a fallback, never duplicate callbacks');
  assert.equal(store.db.outcomes[CallSid].result_stage, 'missed');
  assert.equal(sentTo(p).length, 0);
  assert.equal(sentTo(OWNER).filter((l) => l.includes(`Missed call from ${p} `)).length, 0);
  const responses = await Promise.all([1, 2, 3].map(async () => (await form(gatherAction(replay), { ...fields, Digits: '1' })).text()));
  assert.equal(responses.filter((xml) => xml.includes('We just texted you')).length, 1);
  assert.deepEqual([consent.latest(CallSid, p).attempt, consent.latest(CallSid, p).state], [2, 'accepted']);
  assert.equal(sentTo(p).length, 1);
  assert.equal(sentTo(OWNER).filter((l) => l.includes(`Missed call from ${p} `)).length, 1);
  assert.equal(store.db.outcomes[CallSid].textback_sent, true);
  for (const endpoint of [action, gatherAction(replay)]) {
    assert.doesNotMatch(await (await form(endpoint, fields)).text(), /<Gather/);
  }
  assert.equal(store.db.voiceConsents.filter((c) => c.callSid === CallSid).length, 2);
  assert.equal(consent.latest(CallSid, p).state, 'accepted');
});
test('persisted replay survives a process restart and duplicate first silence still permits real replay consent', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid(), fields = { From: p, CallSid };
  const initial = await (await form('/twilio/voice', fields)).text();
  const replay = await (await form(gatherAction(initial), fields)).text();
  const saved = structuredClone(consent.latest(CallSid, p));
  const restarted = JSON.parse(require('node:child_process').execFileSync(process.execPath, ['-e', `
    require('dotenv').config = () => ({ parsed: {} });
    const consent = require('./src/consent');
    const fields = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    consent.record(fields).then((entry) => process.stdout.write(JSON.stringify({
      entry, xml: consent.gatherTwiml('https://shop.example', entry),
      saved: consent.latest(fields.callSid, fields.from)
    })));
  `], { cwd: path.join(__dirname, '..'), input: JSON.stringify({ callSid: CallSid, from: p, digits: '' }), encoding: 'utf8' }));
  assert.equal(restarted.entry.duplicate, true);
  assert.equal(restarted.entry.state, 'retry');
  assert.deepEqual(restarted.saved, saved, 'restart recognizes the existing first silence without rewriting it');
  assert.ok(replay.includes(restarted.xml), 'the restarted process produces the identical replay');
  store.db.voiceConsents = store.createStore({ dir }).db.voiceConsents;
  assert.equal(await (await form(gatherAction(initial), fields)).text(), replay);
  await form(gatherAction(replay), { ...fields, Digits: '1' });
  assert.equal(sentTo(p).length, 1);
  assert.equal(consent.latest(CallSid, p).attempt, 2);
  assert.equal(store.db.voiceConsents.filter((c) => c.callSid === CallSid).length, 2);
});
test('attempt markers cannot skip the first silence, invent a replay, or advance pending/retry state', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid(), fields = { From: p, CallSid };
  const initial = await (await form('/twilio/voice', fields)).text();
  const pending = structuredClone(consent.latest(CallSid, p));
  for (const query of ['attempt=2', 'attempt=0', 'attempt=3', 'attempt=unknown', 'attempt=', 'attempt=02', 'attempt=2&attempt=1', 'attempt[x]=2']) {
    for (const Digits of ['', '1']) {
      assert.doesNotMatch(await (await form(`/twilio/voice/consent?${query}`, { ...fields, Digits })).text(), /<Gather/);
      assert.deepEqual(consent.latest(CallSid, p), pending, 'invalid marker never advances the offer');
    }
  }
  const other = { From: num(), CallSid: callSid() };
  for (const Digits of ['', '1']) {
    for (const caller of [other, { ...fields, From: other.From }, { ...fields, CallSid: other.CallSid }]) {
      assert.doesNotMatch(await (await form('/twilio/voice/consent?attempt=2', { ...caller, Digits })).text(), /<Gather/);
      assert.equal(consent.latest(caller.CallSid, caller.From), null, 'query alone cannot create a replay or consent');
    }
  }
  const replay = await (await form(gatherAction(initial), fields)).text();
  const saved = structuredClone(consent.latest(CallSid, p));
  for (const query of ['attempt=unknown', 'attempt=3', 'attempt=2&attempt=2']) {
    for (const Digits of ['', '1']) {
      assert.doesNotMatch(await (await form(`/twilio/voice/consent?${query}`, { ...fields, Digits })).text(), /<Gather/);
      assert.deepEqual(consent.latest(CallSid, p), saved, 'invalid marker never consumes the genuine second chance');
    }
  }
  assert.doesNotMatch(await (await form(gatherAction(initial), { ...fields, Digits: '1' })).text(), /<Gather/);
  assert.deepEqual(consent.latest(CallSid, p), saved, 'a changed answer to the first attempt cannot opt in after silence');
  assert.equal(sentTo(p).length, 0);
  assert.equal(sentTo(other.From).length, 0);
  assert.equal(sentTo(OWNER).filter((l) => l.includes(`Missed call from ${p} `)).length, 0);
  assert.equal(store.db.outcomes[CallSid].result_stage, 'missed');
  await form(gatherAction(replay), { ...fields, Digits: '1' });
  assert.equal(sentTo(p).length, 1, 'only the genuine replay action authorizes the second answer');
});
test('the replay marker is signed, and even a valid signature cannot skip the persisted first silence', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid(), fields = { From: p, CallSid };
  const initial = await (await form('/twilio/voice', fields)).text();
  const pending = structuredClone(consent.latest(CallSid, p));
  withEnv(t, { TWILIO_AUTH_TOKEN: require('node:crypto').randomBytes(32).toString('hex'), SKIP_TWILIO_VALIDATION: '0' });
  const signed = (action, body, signedAction = action) => form(action, body, {
    'x-twilio-signature': require('twilio').getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, 'https://shop.example' + signedAction, body),
  });
  const secondAction = '/twilio/voice/consent?attempt=2';
  assert.doesNotMatch(await (await signed(secondAction, { ...fields, Digits: '1' })).text(), /<Gather/);
  assert.deepEqual(consent.latest(CallSid, p), pending, 'signed attempt 2 cannot bypass the initial prompt');
  const replay = await (await signed(gatherAction(initial), fields)).text();
  const saved = structuredClone(consent.latest(CallSid, p));
  const press = { ...fields, Digits: '1' };
  assert.equal((await signed(gatherAction(replay), press, gatherAction(initial))).status, 403, 'changing the signed URL invalidates its signature');
  assert.equal((await form(gatherAction(replay), press)).status, 403, 'unsigned replay is refused');
  assert.deepEqual(consent.latest(CallSid, p), saved);
  assert.equal(sentTo(p).length, 0);
  const accepted = await signed(gatherAction(replay), press);
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /We just texted you/);
  await signed(gatherAction(replay), press);
  assert.equal(sentTo(p).length, 1);
});
test('silence needs a valid call/from pair and a recorded offer to earn a replay', async (t) => {
  quiet(t);
  for (const fields of [{ From: num() }, { From: num(), CallSid: '../invalid' }, { From: 'anonymous', CallSid: callSid() }]) {
    await form('/twilio/voice', fields);
    assert.doesNotMatch(await (await form('/twilio/voice/consent?retry=0', fields)).text(), /<Gather/);
  }
  const From = num(), CallSid = callSid();
  await form('/twilio/voice', { From, CallSid });
  assert.doesNotMatch(await (await form('/twilio/voice/consent', { From: num(), CallSid })).text(), /<Gather/, 'another caller cannot borrow the offer');
  assert.doesNotMatch(await (await form('/twilio/voice/consent', { From, CallSid: callSid() })).text(), /<Gather/, 'another call cannot borrow the offer');
  assert.match(await (await form('/twilio/voice/consent', { From, CallSid })).text(), /<Gather/, 'original valid pair retains its one retry');
});
test('an explicit custom MISSED_CALL_SAY remains the successful call wrap-up', async (t) => {
  quiet(t);
  withEnv(t, { MISSED_CALL_SAY: 'Peach State Plumbing: please reply to our text. Thanks & goodbye.' });
  const p = num(), CallSid = callSid();
  await form('/twilio/voice', { From: p, CallSid });
  const xml = await (await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' })).text();
  assert.ok(xml.includes(`<Say voice="Polly.Joanna-Neural">${xmlText(process.env.MISSED_CALL_SAY)}</Say><Hangup/>`));
  assert.equal(sentTo(p).length, 1);
});
test('forwarded call: no-answer status plays the prompt (no text); answered call hangs up; 1 then texts', async (t) => {
  quiet(t);
  withEnv(t, { FORWARD_TO_PHONE: '+14045550199' });
  const p = num(), CallSid = callSid();
  const dial = await (await form('/twilio/voice', { From: p, CallSid })).text();
  assert.match(dial, /<Dial /);
  for (const DialCallStatus of ['no-answer', 'busy', 'failed', 'canceled']) {
    const xml = await (await form('/twilio/voice/status', { From: p, CallSid, DialCallStatus })).text();
    assert.match(xml, /<Gather [^>]*numDigits="1"/, DialCallStatus);
  }
  assert.equal(sentTo(p).length, 0, 'status callback never texts on its own');
  assert.equal(await (await form('/twilio/voice/status', { From: p, CallSid, DialCallStatus: 'completed' })).text(), '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  assert.equal(sentTo(p).length, 1);
});
test('no prompt for callers who cannot be texted (international, anonymous, opted out)', async (t) => {
  quiet(t);
  for (const From of ['+442079460123', 'anonymous', '']) {
    const xml = await (await form('/twilio/voice', { From, CallSid: callSid() })).text();
    assert.doesNotMatch(xml, /<Gather/, From || '(blank)');
  }
  const p = num();
  await store.optOut(p, 'test');
  assert.doesNotMatch(await (await form('/twilio/voice', { From: p, CallSid: callSid() })).text(), /<Gather/);
  await form('/twilio/voice/consent', { From: p, CallSid: callSid(), Digits: '1' });
  assert.equal(sentTo(p).length, 0, 'an opted-out number is never texted, even after pressing 1');
});
test('per-shop prompt wording (VOICE_CONSENT_PROMPT) needs the required disclosures; Spanish option', async (t) => {
  quiet(t);
  withEnv(t, { VOICE_CONSENT_SPANISH: undefined, VOICE_CONSENT_PROMPT: 'Thanks for calling {shop}. Press 1 and we will text you to book. Message frequency varies, message and data rates may apply. Reply STOP to opt out or HELP for help.' });
  assert.equal(consent.voicePrompt(), 'Thanks for calling Peach State Plumbing. Press 1 and we will text you to book. Message frequency varies, message and data rates may apply. Reply STOP to opt out or HELP for help.');
  process.env.VOICE_CONSENT_PROMPT = 'Press 1 for texts from {shop}!'; // missing disclosures -> default script
  assert.equal(consent.voicePrompt(), PROMPT);
  process.env.VOICE_CONSENT_PROMPT = '';
  process.env.VOICE_CONSENT_SPANISH = '1';
  const xml = await (await form('/twilio/voice', { From: num(), CallSid: callSid() })).text();
  assert.match(xml, /<Say language="es-MX" voice="Polly\.Mia-Neural">Peach State Plumbing no puede atender su llamada en este momento\. Oprima 1 /);
  assert.ok(xml.indexOf('es-MX') < xml.indexOf('</Gather>'), 'Spanish script is inside the same Gather');
});

test('bilingual replay and consent evidence keep the actual custom scripts issued before settings changed', async (t) => {
  quiet(t);
  withEnv(t, { VOICE_CONSENT_SPANISH: '1', VOICE_CONSENT_PROMPT: 'Thank you for calling {shop}. Press 1 for a text. Message frequency varies, message and data rates may apply. Reply STOP to opt out or HELP for help.' });
  const p = num(), CallSid = callSid(), fields = { From: p, CallSid };
  const prompt = consent.voicePrompt(), promptEs = consent.spanishPrompt();
  const initial = await (await form('/twilio/voice', fields)).text();
  process.env.VOICE_CONSENT_PROMPT = '';
  process.env.VOICE_CONSENT_SPANISH = '0';
  const replay = await (await form(gatherAction(initial), fields)).text();
  assert.equal(replay, initial.replace(gatherAction(initial), gatherAction(replay)), 'full English and Spanish scripts are replayed unchanged');
  assert.ok(replay.includes(xmlText(prompt)) && replay.includes(xmlText(promptEs)));
  assert.equal(await (await form(gatherAction(initial), fields)).text(), replay, 'duplicate silence also keeps both saved scripts');
  const goodbye = await (await form(gatherAction(replay), fields)).text();
  assert.doesNotMatch(goodbye, /<Gather/);
  assert.match(goodbye, /<Say language="es-MX" voice="Polly.Mia-Neural">No recibimos respuesta/);
  const entries = store.db.voiceConsents.filter((c) => c.callSid === CallSid);
  assert.deepEqual(entries.map((c) => [c.attempt, c.digits, c.prompt, c.promptEs]), [[2, '', prompt, promptEs], [1, '', prompt, promptEs]]);
  assert.equal(sentTo(p).length, 0);
});

// ---------- 3. a real shop name before any outbound text ----------
test('no shop name: no prompt, no text-back, no HELP text; admin alerted; owner alerts unaffected', async (t) => {
  quiet(t);
  app.locals.resetNoNameAlerts(); sms.resetCap();
  withEnv(t, { BUSINESS_NAME: undefined });
  for (const name of [undefined, '', '   ', 'our team', 'Your business']) {
    if (name === undefined) delete process.env.BUSINESS_NAME; else process.env.BUSINESS_NAME = name;
    assert.equal(consent.shopName(), '', String(name));
    const p = num(), CallSid = callSid();
    const xml = await (await form('/twilio/voice', { From: p, CallSid })).text();
    assert.doesNotMatch(xml, /<Gather/);
    await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
    await form('/twilio/sms', { From: p, Body: 'HELP' });
    await form('/twilio/sms', { From: p, Body: 'hello' });
    assert.equal(sentTo(p).length, 0, `${JSON.stringify(name)}: nothing texted`);
    assert.equal((await sms.sendSms(p, 'direct caller text')).skipped, 'no_shop_name');
    assert.equal(sentTo(p).length, 0);
  }
  assert.ok(store.db.alerts.some((a) => /has no business name/.test(a.body)), 'platform admin alerted');
  process.env.BUSINESS_NAME = '';
  assert.equal((await sms.sendSms(OWNER, 'owner alert', { kind: 'owner' })).ok, true, 'owner alerts still go out');
});
test('agent never falls back to "our team"', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/agent.js'), 'utf8');
  assert.doesNotMatch(src, /'our team'/);
});

// ---------- 4/5. HELP, START, STOP and lapsed wording ----------
test('HELP, START and STOP replies name the shop with the required wording', async (t) => {
  quiet(t);
  const p = num();
  await form('/twilio/sms', { From: p, Body: 'HELP' });
  assert.match(sentTo(p).at(-1), /: Peach State Plumbing missed-call text-back via BuzzCall\. For help call \(470\) 482-8377 or email hello@trybuzzcall\.com\. Msg frequency varies\. Msg & data rates may apply\. Reply STOP to opt out\.$/);
  await form('/twilio/sms', { From: p, Body: 'STOP' });
  assert.match(sentTo(p).at(-1), /: Peach State Plumbing: You're unsubscribed and won't get more texts from us\. Reply START to resubscribe\.$/);
  assert.equal(store.isOptedOut(p), true);
  await form('/twilio/sms', { From: p, Body: 'START' });
  assert.equal(store.isOptedOut(p), false);
  assert.match(sentTo(p).at(-1), /: Peach State Plumbing: You're resubscribed to texts about your service request\. Msg frequency varies\. Msg & data rates may apply\. Reply HELP for help, STOP to opt out\.$/);
  const es = num();
  await form('/twilio/sms', { From: es, Body: 'basta' });
  assert.match(sentTo(es).at(-1), /Peach State Plumbing: You're unsubscribed.* \/ Se canceló su suscripción/);
  withEnv(t, { HELP_MESSAGE: 'Call us anytime.' });
  const h = num();
  await form('/twilio/sms', { From: h, Body: 'help' });
  assert.match(sentTo(h).at(-1), /: Peach State Plumbing: Call us anytime\.$/, 'a custom HELP text still names the shop');
});
test('lapsed-subscription text includes HELP and rates (after consent only)', async (t) => {
  quiet(t);
  withEnv(t, { BILLING_REQUIRE_SUBSCRIPTION: '1', BILLING_ENFORCE: '1' });
  const p = num(), CallSid = callSid();
  await form('/twilio/voice', { From: p, CallSid });
  assert.equal(sentTo(p).length, 0, 'lapsed shop: still no text without consent');
  await form('/twilio/voice/consent', { From: p, CallSid, Digits: '1' });
  const lines = sentTo(p);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Hi, this is Peach State Plumbing\. Sorry we missed your call! Please try calling again later\. Reply STOP to opt out, HELP for help\. Msg & data rates may apply\.$/);
});

// ---------- 2. public per-shop SMS page ----------
test('per-shop SMS page: public fields only, exact script, samples, links; unknown slugs 404', async (t) => {
  quiet(t);
  const r = await req('/s/peach-state-plumbing/sms');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const page = await r.text();
  assert.ok(page.includes(PROMPT.replace(/'/g, '&#39;')), 'exact voice opt-in script');
  assert.match(page, /Peach State Plumbing/);
  assert.match(page, /\(470\) 555-0100/, 'the BuzzCall number');
  assert.match(page, /powered by BuzzCall \(TryBuzzCall LLC\)/i);
  assert.match(page, /href="\/privacy"/); assert.match(page, /href="\/terms"/);
  assert.match(page, /Reply STOP to opt out, HELP for help/);
  assert.match(page, /Peach State Plumbing missed-call text-back via BuzzCall/, 'HELP sample');
  assert.match(page, /You&#39;re unsubscribed/, 'STOP sample');
  assert.ok(!page.includes(OWNER) && !page.includes('404) 555-0100'), 'never the owner phone');
  assert.doesNotMatch(page, /@(?!trybuzzcall\.com)[\w.-]+\.\w+/, 'no email but BuzzCall support');
  for (const bad of ['/s/nope/sms', '/s/PEACH-STATE-PLUMBING/sms', '/s/%3Cscript%3E/sms', '/s/peach-state-plumbing/other']) assert.equal((await req(bad)).status, 404, bad);
});
test('per-shop SMS page escapes the shop name everywhere', async (t) => {
  quiet(t);
  const evil = `<script>alert("x")</script> & 'Sons' <img src=x onerror=alert(1)>`;
  withEnv(t, { BUSINESS_NAME: evil, OWNER_EMAIL });
  const slug = smsPage.slugify(evil);
  assert.match(slug, /^[a-z0-9-]+$/);
  const page = await (await req(`/s/${slug}/sms`)).text();
  assert.doesNotMatch(page, /<script>|<img src=x|onerror=alert\(1\)>/i);
  assert.ok(page.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Sons&#39; &lt;img src=x onerror=alert(1)&gt;'), 'name is HTML-escaped');
  assert.ok(!page.includes(OWNER_EMAIL));
});
test('slugs: lowercase words, accents dropped, empty -> null page', () => {
  assert.equal(smsPage.slugify('Crème Brûlée Braids & Co.'), 'creme-brulee-braids-co');
  assert.equal(smsPage.slugify('***'), '');
  assert.equal(smsPage.urlFor('a-b'), '/s/a-b/sms');
});
test('vendor shops get their own page; same-name shops get a suffixed slug; suspended shops 404', async (t) => {
  quiet(t);
  const vendors = require('../src/vendors');
  const one = await vendors.create({ name: 'Peach State Plumbing', email: 'dup@example.com' });
  const two = await vendors.create({ name: '<b>Ana</b> & Co', email: 'ana@example.com' });
  await vendors.assignPhone(two.shop.id, '+14705550111');
  const entries = smsPage.entries();
  assert.equal(entries.find((e) => !e.shop).slug, 'peach-state-plumbing', 'the legacy line keeps the base slug');
  assert.equal(entries.find((e) => e.shop?.id === one.shop.id).slug, `peach-state-plumbing-${one.shop.id.slice(0, 6)}`);
  const page = await (await req('/s/b-ana-b-co/sms')).text();
  assert.ok(page.includes('&lt;b&gt;Ana&lt;/b&gt; &amp; Co'), 'vendor name escaped');
  assert.match(page, /\(470\) 555-0111/);
  assert.ok(!page.includes('ana@example.com'), 'never the owner email');
  await vendors.setStatus(two.shop.id, 'suspended');
  assert.equal((await req('/s/b-ana-b-co/sms')).status, 404);
});

// ---------- 6. legal pages ----------
test('privacy, terms and sms-consent: no draft banners or TODO(legal); sms-consent has the exact voice script', () => {
  for (const f of ['privacy.html', 'terms.html', 'sms-consent.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
    assert.doesNotMatch(html, /TODO\(legal\)/, f); assert.doesNotMatch(html, /pending review by legal counsel/, f);
  }
  const c = fs.readFileSync(path.join(__dirname, '../public/sms-consent.html'), 'utf8');
  assert.ok(c.includes(`"${PROMPT.replace('Peach State Plumbing', '[Shop]')}"`));
  const home = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.doesNotMatch(home, /should not simply be assumed to authorize|must be finalized/);
  assert.match(home, /Only callers who press 1 get a text/);
});

test('consent retry state is scoped to the receiving shop even for the same call/from pair', async (t) => {
  quiet(t);
  const vendors = require('../src/vendors');
  const shops = await Promise.all(['Retry Shop One', 'Retry Shop Two'].map((name, i) => vendors.create({ name, email: `retry${i}@example.com` })));
  const fields = { callSid: callSid(), from: num() };
  for (const { shop } of shops) {
    await vendors.run(shop.id, async () => {
      assert.equal(consent.latest(fields.callSid, fields.from), null);
      await consent.offer(fields);
      const first = await consent.record({ ...fields, digits: '' });
      assert.equal(first.state, 'retry');
      assert.equal(first.attempt, 1);
      assert.equal(first.shopId, shop.id);
      const duplicate = await consent.record({ ...fields, digits: '' });
      assert.equal(duplicate.state, 'retry');
      assert.equal(duplicate.duplicate, true);
      const second = await consent.record({ ...fields, digits: '', attempt: '2' });
      assert.equal(second.state, 'no_input');
      assert.equal(second.attempt, 2);
    }, { suspended: true });
  }
  assert.equal(consent.latest(fields.callSid, fields.from), null, 'no vendor consent leaks to the legacy line');
});
