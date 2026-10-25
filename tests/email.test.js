'use strict';
// Signup emails (2026-10-25): welcome + admin alert through Resend's HTTP API, with a mocked fetch only.
// No real network: email.setFetch() replaces the transport, and the server runs in-process on 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-email-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'OPENAI_API_KEY', 'DATABASE_URL',
  'DEMO_MODE', 'RENDER', 'CLIENT_IP_HEADER', 'RESEND_API_KEY', 'EMAIL_FROM', 'ADMIN_ALERT_EMAIL', 'EMAIL_TIMEOUT_MS',
  'EMAIL_RECIPIENT_WINDOW_HOURS', 'ADMIN_ALERT_MAX_PER_HOUR', 'WAITLIST_RATE_MAX', 'SETUP_RATE_MAX']) delete process.env[k];
const KEY = 're_test_fixture_key_never_logged_123456';
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: 'email-test-password-long',
  BUSINESS_NAME: 'Email Test', PUBLIC_BASE_URL: 'https://shop.example', WAITLIST_RATE_MAX: '1000', SETUP_RATE_MAX: '1000' });

const mail = require('../src/email');
const { app } = require('../src/server');

let server, BASE;
const sent = [];
let transport = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
mail.setFetch((url, init) => transport(url, init));
const logs = [];
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); BASE = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { mail.setFetch(null); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test.beforeEach((t) => {
  sent.length = 0; logs.length = 0; mail.reset(); process.env.RESEND_API_KEY = KEY;
  transport = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  for (const m of ['log', 'error', 'warn']) t.mock.method(console, m, (...a) => { logs.push(a.join(' ')); });
});
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: BASE }, body: JSON.stringify(body) });
const noSecretsLogged = (...addresses) => {
  const all = logs.join('\n');
  assert.ok(!all.includes(KEY), 'API key is never logged');
  for (const a of addresses) assert.ok(!all.includes(a), 'Full address is never logged');
};

test('maskEmail hides most of the address', () => {
  assert.equal(mail.maskEmail('kojo@bytspot.com'), 'k***@b***.com');
  assert.equal(mail.maskEmail('nope'), '***');
});

test('waitlist: welcome to the person and an alert to the admin, via Resend', async () => {
  const r = await post('/api/waitlist', { email: 'Owner.One@Example.com', businessType: 'braiders' });
  assert.equal(r.status, 200);
  await mail.settle();
  assert.equal(sent.length, 2);
  for (const s of sent) {
    assert.equal(s.url, 'https://api.resend.com/emails');
    assert.equal(s.init.method, 'POST');
    assert.equal(s.init.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(s.init.signal, 'Every send has a timeout signal');
    assert.equal(s.body.from, 'BuzzCall <hello@trybuzzcall.com>');
  }
  const welcome = sent.find((s) => s.body.to[0] === 'owner.one@example.com');
  assert.equal(welcome.body.subject, "You're on the BuzzCall pilot list");
  assert.ok(welcome.body.text.includes('https://trybuzzcall.com/setup'));
  assert.doesNotMatch(welcome.body.text, /\$\d/, 'No fee numbers in the welcome');
  const admin = sent.find((s) => s.body.to[0] === 'kojo@bytspot.com');
  assert.match(admin.body.text, /Email: owner\.one@example\.com/);
  assert.match(admin.body.text, /Business type: Braiders/);
  assert.match(admin.body.text, /Time: \d{4}-\d\d-\d\dT/);
  noSecretsLogged('owner.one@example.com', 'kojo@bytspot.com');
  assert.ok(logs.some((l) => l.includes('o***@e***.com')), 'Masked address in the log');
});

test('one welcome per address per 24h; EMAIL_FROM and ADMIN_ALERT_EMAIL are honored', async (t) => {
  process.env.EMAIL_FROM = 'BuzzCall Team <team@trybuzzcall.com>'; process.env.ADMIN_ALERT_EMAIL = 'alerts@example.org';
  t.after(() => { delete process.env.EMAIL_FROM; delete process.env.ADMIN_ALERT_EMAIL; });
  for (let i = 0; i < 3; i++) assert.equal((await post('/api/waitlist', { email: 'repeat@example.com', businessType: 'home_services' })).status, 200);
  await mail.settle();
  assert.equal(sent.filter((s) => s.body.to[0] === 'repeat@example.com').length, 1);
  assert.equal(sent.filter((s) => s.body.to[0] === 'alerts@example.org').length, 1);
  assert.ok(sent.every((s) => s.body.from === 'BuzzCall Team <team@trybuzzcall.com>'));
  noSecretsLogged('repeat@example.com', 'alerts@example.org');
});

test('missing RESEND_API_KEY: masked "email skipped" log, signup still saved, nothing sent', async () => {
  delete process.env.RESEND_API_KEY;
  const r = await post('/api/waitlist', { email: 'nokey@example.com', businessType: 'other' });
  assert.equal(r.status, 200);
  await mail.settle();
  assert.equal(sent.length, 0);
  assert.ok(logs.some((l) => /\[email\] skipped \(RESEND_API_KEY not set\): waitlist welcome to n\*\*\*@e\*\*\*\.com/.test(l)));
  const store = require('../src/store');
  assert.ok(store.root.db.waitlist.some((w) => w.email === 'nokey@example.com'), 'Signup is saved');
  noSecretsLogged('nokey@example.com');
});

test('sending is non-blocking and failures/timeouts never break the form', async () => {
  const pending = [];
  transport = (url, init) => new Promise((resolve) => { pending.push(resolve); sent.push({ url, init }); });
  const r = await post('/api/waitlist', { email: 'slow@example.com', businessType: 'braiders' });
  assert.equal(r.status, 200, 'Response does not wait for the email provider');
  assert.ok(pending.length > 0);
  for (const resolve of pending) resolve({ ok: true, status: 200 });
  await mail.settle();
  mail.reset(); sent.length = 0;
  process.env.EMAIL_TIMEOUT_MS = '30';
  transport = (url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason)); });
  assert.equal((await post('/api/waitlist', { email: 'timeout@example.com' })).status, 200);
  await mail.settle();
  delete process.env.EMAIL_TIMEOUT_MS;
  assert.ok(logs.some((l) => /failed: timeout/.test(l)));
  mail.reset();
  transport = async () => { throw new Error(`boom ${KEY}`); };
  assert.equal((await post('/api/waitlist', { email: 'boom@example.com' })).status, 200);
  await mail.settle();
  transport = async () => ({ ok: false, status: 422 });
  mail.reset();
  assert.equal((await post('/api/waitlist', { email: 'bad@example.com' })).status, 200);
  await mail.settle();
  assert.ok(logs.some((l) => /failed: HTTP 422/.test(l)));
  noSecretsLogged('timeout@example.com', 'boom@example.com', 'bad@example.com');
});

test('setup submission: "we got your setup" welcome + admin alert with business type, no typed text echoed', async () => {
  const body = {
    businessName: 'Crown <b>Braids</b>', city: 'Atlanta, GA', vertical: 'braiders', ownerPhone: '(404) 555-0100', forwardPhone: '(404) 555-0111',
    ringSeconds: '20', days: ['2', '3', '4', '5', '6'], open: '10:00', close: '19:00', tz: 'America/Chicago',
    services: [{ row: 0, name: 'Knotless braids', hours: '6', minutes: '0' }], booking: 'times', leadMinutes: '120',
    deposit: true, depositAmount: '60', holdMinutes: '20', bookingLink: 'https://booksy.com/crown', email: 'setup.owner@example.com', consent: true, confirm: true,
  };
  const r = await post('/setup', body);
  assert.equal(r.status, 200);
  await mail.settle();
  const welcome = sent.find((s) => s.body.to[0] === 'setup.owner@example.com');
  assert.equal(welcome.body.subject, 'We got your BuzzCall setup');
  assert.match(welcome.body.text, /we'll review it and confirm the details with you before your line goes live/);
  assert.ok(welcome.body.text.includes('https://trybuzzcall.com/setup'));
  assert.ok(!welcome.body.text.includes('Crown'), 'The welcome never echoes text the person typed');
  const admin = sent.find((s) => s.body.to[0] === 'kojo@bytspot.com');
  assert.match(admin.body.subject, /new setup/);
  assert.match(admin.body.text, /Email: setup\.owner@example\.com/);
  assert.match(admin.body.text, /Business type: (Braiders|Hair braider)/);
  noSecretsLogged('setup.owner@example.com');
});

test('admin alerts are capped per hour', async (t) => {
  process.env.ADMIN_ALERT_MAX_PER_HOUR = '2'; t.after(() => { delete process.env.ADMIN_ALERT_MAX_PER_HOUR; });
  for (let i = 0; i < 4; i++) mail.adminAlert('subject', 'text');
  await mail.settle();
  assert.equal(sent.length, 2);
});
