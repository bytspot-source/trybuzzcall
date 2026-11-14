'use strict';
// A2P 10DLC compliance with written permission only: a missed call never asks for, offers or creates text permission.
// Only callers with recorded written customer_service permission get a text-back; everyone else hears a call-again
// message. No text without a shop name, HELP/STOP/START and lapsed-shop wording, and the public per-shop SMS page.
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
  'MISSED_CALL_SAY', 'INSTANT_MISSED_BUZZ', 'INSTANT_MISSED_BUZZ_FALLBACK_SECONDS', 'INSTANT_MISSED_BUZZ_MAX_PER_HOUR', 'SMS_ENABLED', 'SMS_CONSENT_BUSINESS_ID']) delete process.env[k];
const OWNER = '+14045550100';
const OWNER_EMAIL = 'owner-private@example.com';
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: 'test-admin-password-a2p', BUSINESS_NAME: 'Peach State Plumbing',
  OWNER_PHONE: OWNER, PUBLIC_BASE_URL: 'https://shop.example', TWILIO_PHONE_NUMBER: '+14705550100' });
const { enableSms, grantSms } = require('./helpers/smsPermission');
enableSms();

const store = require('../src/store');
const sms = require('../src/sms');
const consent = require('../src/consent');
const smsPage = require('../src/smsPage');
const { app } = require('../src/server');

let server, BASE;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); BASE = `http://127.0.0.1:${server.address().port}`; await grantSms(OWNER, 'owner_alerts'); });
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
const NO_TEXT = '<Say voice="Polly.Joanna-Neural">Sorry we missed you. Please call again later. Goodbye.</Say><Hangup/>';
const TEXTED = '<Say voice="Polly.Joanna-Neural">Thanks for calling Peach State Plumbing. Sorry we missed you. A text is on the way to this number. Goodbye.</Say><Hangup/>';
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. written permission before texting; no press-1 ----------
test('missed call without written permission: no prompt, no text, no lead; caller is asked to call again', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  const r = await form('/twilio/voice', { From: p, CallSid });
  assert.equal(r.status, 200);
  const xml = await r.text();
  assert.ok(xml.endsWith(`<Response>${NO_TEXT}</Response>`), xml);
  assert.doesNotMatch(xml, /<Gather|press 1|just texted|text is on the way/i, 'never offers or claims a text');
  assert.equal(sentTo(p).length, 0);
  assert.ok(!store.findOpenLead(p));
  assert.equal(store.db.outcomes[CallSid].result_stage, 'no_consent');
});
test('missed call with recorded written permission: text-back right away, no prompt, short "text is on the way"', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  await grantSms(p);
  const xml = await (await form('/twilio/voice', { From: p, CallSid })).text();
  assert.ok(xml.endsWith(`<Response>${TEXTED}</Response>`), xml);
  assert.doesNotMatch(xml, /<Gather/);
  assert.equal(sentTo(p).length, 1);
  assert.match(sentTo(p)[0], /Peach State Plumbing/);
  assert.equal(store.db.outcomes[CallSid].result_stage, 'consented');
  assert.equal(store.db.outcomes[CallSid].textback_sent, true);
  assert.equal(store.db.outcomes[CallSid].phone_verified, false, 'a call never verifies anything');
  assert.equal((await (await form('/twilio/voice', { From: p, CallSid })).text()).includes('<Hangup/>'), true, 'repeat webhook for the same call');
  assert.equal(sentTo(p).length, 1, 'repeated webhooks for one call never text twice');
});
test('owner_alerts permission never authorizes the caller text-back (and vice versa)', async (t) => {
  quiet(t);
  const p = num();
  await grantSms(p, 'owner_alerts');
  assert.ok((await (await form('/twilio/voice', { From: p, CallSid: callSid() })).text()).includes(NO_TEXT));
  assert.equal(sentTo(p).length, 0);
  assert.equal((await sms.sendSms(p, 'caller text')).skipped, 'consent_required');
  const q = num();
  await grantSms(q);
  assert.equal((await sms.sendSms(q, 'owner text', { kind: 'owner' })).skipped, 'consent_required');
});
test('SMS_ENABLED must be exactly 1: even a permitted caller is not texted and hears call-again', async (t) => {
  quiet(t);
  const p = num();
  await grantSms(p);
  withEnv(t, { SMS_ENABLED: undefined });
  for (const value of [undefined, '', '0', 'true', 'yes']) {
    if (value === undefined) delete process.env.SMS_ENABLED; else process.env.SMS_ENABLED = value;
    assert.ok((await (await form('/twilio/voice', { From: p, CallSid: callSid() })).text()).includes(NO_TEXT), String(value));
    assert.equal((await sms.sendSms(p, 'x')).skipped, 'sms_disabled');
    assert.equal((await sms.sendSms(OWNER, 'x', { kind: 'owner' })).skipped, 'sms_disabled');
    assert.equal((await sms.sendSms(OWNER, 'x', { kind: 'otp' })).skipped, 'sms_disabled');
  }
  assert.equal(sentTo(p).length, 0);
});
test('a press-1 callback (stale Gather) records nothing and texts nothing', async (t) => {
  quiet(t);
  const p = num(), CallSid = callSid();
  await form('/twilio/voice', { From: p, CallSid });
  for (const Digits of ['1', '', '2']) {
    const xml = await (await form('/twilio/voice/consent', { From: p, CallSid, Digits })).text();
    assert.ok(xml.endsWith(`<Response>${NO_TEXT}</Response>`), xml);
  }
  for (const q of ['?attempt=2', '?attempt=1']) await form(`/twilio/voice/consent${q}`, { From: p, CallSid, Digits: '1' });
  assert.equal(sentTo(p).length, 0);
  assert.equal(store.db.voiceConsents, undefined, 'no consent records are created');
  const smsPermission = require('../src/smsPermission');
  assert.equal(smsPermission.check(p).allowed, false);
  assert.ok(!smsPermission.snapshot().some((r) => r.phone === p));
});
test('old press-1 consent records never become permission', async (t) => {
  quiet(t);
  const p = num();
  store.db.voiceConsents = [{ at: new Date().toISOString(), callSid: callSid(), from: p, shopId: 'legacy', digits: '1', consented: true, state: 'accepted' }];
  t.after(() => { delete store.db.voiceConsents; });
  assert.ok((await (await form('/twilio/voice', { From: p, CallSid: callSid() })).text()).includes(NO_TEXT));
  assert.equal(sentTo(p).length, 0);
  assert.equal(require('../src/deposits').hasSmsConsent(p), false);
});
test('an explicit custom MISSED_CALL_SAY is used only when a text actually went out', async (t) => {
  quiet(t);
  withEnv(t, { MISSED_CALL_SAY: 'Peach State Plumbing: please reply to our text. Thanks & goodbye.' });
  const p = num(), q = num();
  await grantSms(p);
  const xml = await (await form('/twilio/voice', { From: p, CallSid: callSid() })).text();
  assert.ok(xml.includes(`<Say voice="Polly.Joanna-Neural">${xmlText(process.env.MISSED_CALL_SAY)}</Say><Hangup/>`));
  assert.equal(sentTo(p).length, 1);
  assert.ok((await (await form('/twilio/voice', { From: q, CallSid: callSid() })).text()).includes(NO_TEXT), 'no permission: never the custom wrap-up');
});
test('forwarded call: no-answer status texts a permitted caller once; answered call hangs up; others hear call-again', async (t) => {
  quiet(t);
  withEnv(t, { FORWARD_TO_PHONE: '+14045550199' });
  const p = num(), CallSid = callSid();
  await grantSms(p);
  assert.match(await (await form('/twilio/voice', { From: p, CallSid })).text(), /<Dial /);
  for (const DialCallStatus of ['no-answer', 'busy']) {
    const xml = await (await form('/twilio/voice/status', { From: p, CallSid, DialCallStatus })).text();
    assert.doesNotMatch(xml, /<Gather/);
  }
  assert.equal(sentTo(p).length, 1);
  const q = num(), other = callSid();
  await form('/twilio/voice', { From: q, CallSid: other });
  assert.equal(await (await form('/twilio/voice/status', { From: q, CallSid: other, DialCallStatus: 'completed' })).text(), '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  const r = callSid();
  assert.ok((await (await form('/twilio/voice/status', { From: q, CallSid: r, DialCallStatus: 'no-answer' })).text()).includes(NO_TEXT));
  assert.equal(sentTo(q).length, 0);
});
test('no text-back for callers who cannot be texted (international, anonymous, opted out), even with permission', async (t) => {
  quiet(t);
  for (const From of ['+442079460123', 'anonymous', '']) {
    const xml = await (await form('/twilio/voice', { From, CallSid: callSid() })).text();
    assert.doesNotMatch(xml, /<Gather|text is on the way/, From || '(blank)');
  }
  const p = num();
  await grantSms(p);
  await store.optOut(p, 'test');
  assert.ok((await (await form('/twilio/voice', { From: p, CallSid: callSid() })).text()).includes(NO_TEXT));
  assert.equal(sentTo(p).length, 0, 'an opted-out number is never texted');
});

// ---------- 3. a real shop name before any outbound text ----------
test('no shop name: no text-back, no HELP text; admin alerted; owner alerts unaffected', async (t) => {
  quiet(t);
  app.locals.resetNoNameAlerts(); sms.resetCap();
  withEnv(t, { BUSINESS_NAME: undefined });
  for (const name of [undefined, '', '   ', 'our team', 'Your business']) {
    if (name === undefined) delete process.env.BUSINESS_NAME; else process.env.BUSINESS_NAME = name;
    assert.equal(consent.shopName(), '', String(name));
    const p = num(), CallSid = callSid();
    await grantSms(p);
    const xml = await (await form('/twilio/voice', { From: p, CallSid })).text();
    assert.doesNotMatch(xml, /<Gather|text is on the way/);
    await form('/twilio/sms', { From: p, Body: 'HELP' });
    await form('/twilio/sms', { From: p, Body: 'hello' });
    assert.equal(sentTo(p).length, 0, `${JSON.stringify(name)}: nothing texted`);
    assert.equal((await sms.sendSms(p, 'direct caller text')).skipped, 'no_shop_name');
    assert.equal(sentTo(p).length, 0);
  }
  assert.ok(store.db.alerts.some((a) => /has no business name/.test(a.body)), 'platform admin alerted');
  process.env.BUSINESS_NAME = '';
  assert.equal((await sms.sendSms(OWNER, 'owner alert', { kind: 'owner' })).ok, true, 'owner alerts still go out (with owner_alerts permission)');
});
test('agent never falls back to "our team"', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/agent.js'), 'utf8');
  assert.doesNotMatch(src, /'our team'/);
});

// ---------- 4/5. HELP, START, STOP and lapsed wording ----------
test('HELP names the shop; STOP gets no application reply; START clears only the block and never restores permission', async (t) => {
  quiet(t);
  const p = num();
  await grantSms(p);
  await form('/twilio/sms', { From: p, Body: 'HELP' });
  assert.match(sentTo(p).at(-1), /: Peach State Plumbing missed-call text-back via BuzzCall\. For help call \(470\) 482-8377 or email hello@trybuzzcall\.com\. Msg frequency varies\. Msg & data rates may apply\. Reply STOP to opt out\.$/);
  const before = sentTo(p).length;
  await form('/twilio/sms', { From: p, Body: 'STOP' });
  assert.equal(sentTo(p).length, before, 'no application STOP confirmation (permission is revoked)');
  assert.equal(store.isOptedOut(p), true);
  await form('/twilio/sms', { From: p, Body: 'START' });
  assert.equal(store.isOptedOut(p), false, 'START lifts the delivery block');
  assert.equal(sentTo(p).length, before, 'no START reply');
  const smsPermission = require('../src/smsPermission');
  assert.equal(smsPermission.check(p).reason, 'consent_required', 'START never restores the old grant');
  await form('/twilio/sms', { From: p, Body: 'HELP' });
  assert.equal(sentTo(p).length, before, 'HELP needs permission too');
  const es = num();
  await grantSms(es);
  await form('/twilio/sms', { From: es, Body: 'basta' });
  assert.equal(store.isOptedOut(es), true);
  assert.equal(sentTo(es).length, 0);
  withEnv(t, { HELP_MESSAGE: 'Call us anytime.' });
  const h = num();
  await grantSms(h);
  await form('/twilio/sms', { From: h, Body: 'help' });
  assert.match(sentTo(h).at(-1), /: Peach State Plumbing: Call us anytime\.$/, 'a custom HELP text still names the shop');
  const none = num();
  await form('/twilio/sms', { From: none, Body: 'help' });
  assert.equal(sentTo(none).length, 0, 'no HELP reply without permission');
});
test('lapsed-subscription text includes HELP and rates (with written permission only)', async (t) => {
  quiet(t);
  withEnv(t, { BILLING_REQUIRE_SUBSCRIPTION: '1', BILLING_ENFORCE: '1' });
  const p = num(), q = num();
  await form('/twilio/voice', { From: q, CallSid: callSid() });
  assert.equal(sentTo(q).length, 0, 'lapsed shop: still no text without permission');
  await grantSms(p);
  const xml = await (await form('/twilio/voice', { From: p, CallSid: callSid() })).text();
  assert.ok(xml.includes(NO_TEXT), 'the inactive notice is not the text-back the voice would announce');
  const lines = sentTo(p);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Hi, this is Peach State Plumbing\. Sorry we missed your call! Please try calling again later\. Reply STOP to opt out, HELP for help\. Msg & data rates may apply\.$/);
});

// ---------- 2. public per-shop SMS page ----------
test('per-shop SMS page: public fields only, written opt-in (no press 1), samples, links; unknown slugs 404', async (t) => {
  quiet(t);
  const r = await req('/s/peach-state-plumbing/sms');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const page = await r.text();
  assert.match(page, /written permission first, on Peach State Plumbing&#39;s own sign-up form outside of text messages/);
  assert.doesNotMatch(page, /press 1|pressed 1|press a key and|Oprima 1/i, 'no press-1 opt-in claims');
  assert.match(page, /Peach State Plumbing/);
  assert.match(page, /\(470\) 555-0100/, 'the BuzzCall number');
  assert.match(page, /powered by BuzzCall \(TryBuzzCall LLC\)/i);
  assert.match(page, /href="\/privacy"/); assert.match(page, /href="\/terms"/);
  assert.match(page, /Reply STOP to opt out, HELP for help/);
  assert.match(page, /Replying START only lifts the carrier block/);
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
test('privacy, terms and sms-consent: no TODO(legal) or conflict markers; no press-1 opt-in claims', () => {
  for (const f of ['privacy.html', 'terms.html', 'sms-consent.html', 'index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
    if (f !== 'index.html') assert.doesNotMatch(html, /TODO\(legal\)/, f);
    assert.doesNotMatch(html, /^(<<<<<<<|>>>>>>>|=======)/m, `${f}: no merge conflict markers`);
    assert.doesNotMatch(html, /Only callers who press 1 get a text|press 1 (?:and|to) (?:we'll|get) text/i, `${f}: press 1 is not an opt-in`);
  }
});

test('vendor permission is scoped to the receiving shop even for the same caller', async (t) => {
  quiet(t);
  const vendors = require('../src/vendors');
  const smsPermission = require('../src/smsPermission');
  const shops = await Promise.all(['Scope Shop One', 'Scope Shop Two'].map((name, i) => vendors.create({ name, email: `scope${i}@example.com` })));
  await vendors.assignPhone(shops[0].shop.id, '+14705550121');
  await vendors.assignPhone(shops[1].shop.id, '+14705550122');
  const p = num();
  await grantSms(p, 'customer_service', { shopId: shops[0].shop.id });
  assert.equal(await vendors.run(shops[0].shop.id, () => smsPermission.check(p).allowed), true);
  assert.equal(await vendors.run(shops[1].shop.id, () => smsPermission.check(p).reason), 'consent_required', 'no leak to another vendor');
  assert.equal(smsPermission.check(p).reason, 'consent_required', 'no leak to the legacy line');
  const record = await vendors.run(shops[0].shop.id, () => smsPermission.snapshot()[0]);
  assert.deepEqual([record.businessId, record.sender, record.phone], [shops[0].shop.id, '+14705550121', p]);
});
