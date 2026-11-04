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
  'INACTIVE_MESSAGE', 'INACTIVE_MODE', 'KEYWORD_REPLIES', 'VOICE_CONSENT_PROMPT', 'VOICE_CONSENT_SPANISH', 'TEXT_EXTRA_AREA_CODES', 'VOICE_NAME', 'VOICE_NAME_ES']) delete process.env[k];
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
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const req = (p, opts = {}) => fetch(BASE + p, { redirect: 'manual', ...opts });
const form = (p, fields) => req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
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
test('consent gate: no digit or another key -> goodbye, no text, logged; 1 -> one text, logged', async (t) => {
  quiet(t);
  const none = num(), two = num(), one = num();
  for (const [p, Digits] of [[none, ''], [two, '2']]) {
    const CallSid = callSid();
    await form('/twilio/voice', { From: p, CallSid });
    const r = await form('/twilio/voice/consent', { From: p, CallSid, Digits });
    const xml = await r.text();
    assert.match(xml, /won't text you|won&apos;t text you/);
    assert.match(xml, /Goodbye\.<\/Say><Hangup\/>/);
    assert.equal(sentTo(p).length, 0, `Digits=${JSON.stringify(Digits)}: no text`);
    assert.ok(!store.findOpenLead(p));
    const rec = store.db.voiceConsents.find((c) => c.callSid === CallSid);
    assert.deepEqual([rec.from, rec.shopId, rec.digits, rec.consented], [p, 'legacy', Digits, false]);
  }
  const CallSid = callSid();
  await form('/twilio/voice', { From: one, CallSid });
  const r = await form('/twilio/voice/consent', { From: one, CallSid, Digits: '1' });
  assert.match(await r.text(), /We just texted you/);
  const lines = sentTo(one);
  assert.equal(lines.length, 1, 'exactly one text after pressing 1');
  assert.match(lines[0], /Hi, this is Peach State Plumbing\./);
  const rec = store.db.voiceConsents.find((c) => c.callSid === CallSid);
  assert.equal(rec.consented, true); assert.equal(rec.digits, '1'); assert.equal(rec.from, one); assert.equal(rec.shopId, 'legacy');
  assert.ok(Number.isFinite(Date.parse(rec.at))); assert.equal(rec.prompt, PROMPT);
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
  withEnv(t, { VOICE_CONSENT_PROMPT: 'Thanks for calling {shop}. Press 1 and we will text you to book. Message frequency varies, message and data rates may apply. Reply STOP to opt out or HELP for help.' });
  assert.equal(consent.voicePrompt(), 'Thanks for calling Peach State Plumbing. Press 1 and we will text you to book. Message frequency varies, message and data rates may apply. Reply STOP to opt out or HELP for help.');
  process.env.VOICE_CONSENT_PROMPT = 'Press 1 for texts from {shop}!'; // missing disclosures -> default script
  assert.equal(consent.voicePrompt(), PROMPT);
  process.env.VOICE_CONSENT_PROMPT = '';
  process.env.VOICE_CONSENT_SPANISH = '1';
  const xml = await (await form('/twilio/voice', { From: num(), CallSid: callSid() })).text();
  assert.match(xml, /<Say language="es-MX" voice="Polly\.Mia-Neural">Peach State Plumbing no puede atender su llamada en este momento\. Oprima 1 /);
  assert.ok(xml.indexOf('es-MX') < xml.indexOf('</Gather>'), 'Spanish script is inside the same Gather');
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
