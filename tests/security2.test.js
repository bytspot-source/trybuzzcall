'use strict';
// Second security pass (2026-10-25): SMS failures can't crash the process, opt-outs, admin password check,
// caller-id validation + outbound cap, strict admin Origin + phone-change confirm, global lockout slow-down,
// production detection, regex-safe service names, log bodies/retention, side-effect-free GET connect/refresh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-security2-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER', 'OPENAI_API_KEY', 'DATABASE_URL', 'FORWARD_TO_PHONE', 'VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_TYPE', 'SERVICES', 'BOOKING_LINK',
  'BILLING_REQUIRE_SUBSCRIPTION', 'BILLING_ENFORCE', 'DEMO_MODE', 'ADMIN_USERNAME', 'RENDER', 'CLIENT_IP_HEADER', 'TEXTBACK_COOLDOWN_MINUTES',
  'OUTBOUND_MAX_PER_HOUR', 'RETENTION_DAYS', 'ADMIN_PASSWORD_STRICT', 'BOOKING_ENABLED', 'DEPOSIT_ENABLED']) delete process.env[k];
const ADMIN = 'security2-test-password-long';
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: ADMIN, BUSINESS_NAME: 'Test Plumbing',
  OWNER_PHONE: '+15550000000', PUBLIC_BASE_URL: 'https://shop.example', ADMIN_MAX_FAILS: '100', ADMIN_GLOBAL_MAX_FAILS: '3', ADMIN_GLOBAL_DELAY_MS: '300' });

const store = require('../src/store');
const sms = require('../src/sms');
const sec = require('../src/security');
const agent = require('../src/agent');
const optout = require('../src/optout');
const connect = require('../src/connect');
const { app, bootChecks } = require('../src/server');

let server, BASE;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); BASE = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const basic = (u, p) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
const auth = basic('admin', ADMIN);
const req = (p, opts = {}) => fetch(BASE + p, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}) } });
const form = (p, fields, headers = {}) => req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
const call = (from) => form('/twilio/voice/status', { From: from, DialCallStatus: 'no-answer' });
const text = (from, Body) => form('/twilio/sms', { From: from, Body });
const smsLog = () => { try { return fs.readFileSync(path.join(dir, 'sms.log'), 'utf8'); } catch { return ''; } };
const sentTo = (p) => smsLog().split('\n').filter((l) => l.includes(`SMS -> ${p}:`));
const quiet = (t) => { const o = console.error, l = console.log; console.error = () => {}; console.log = () => {}; t.after(() => { console.error = o; console.log = l; }); };
function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
let n = 0; const num = () => `+1470555${String(1000 + (n++)).slice(-4)}`;
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

// ---------- (1) crash reproduction + fix ----------
// The reviewer's PoC: a Twilio send error (21610) inside /twilio/voice killed the process via an unhandled rejection.
// Here a real child process runs src/server.js with a preloaded fake Twilio client whose messages.create always throws.
test('crash repro: Twilio 21610 on a text-back no longer kills the server; the number is opted out', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-crash-'));
  const preload = path.join(d, 'fake-twilio.js');
  fs.writeFileSync(preload, `
const Module = require('module'); const orig = Module._load;
const fake = () => ({ messages: { create: async () => { const e = new Error('Attempt to send to unsubscribed recipient'); e.code = 21610; throw e; } } });
fake.validateRequest = () => true;
Module._load = function (r, ...a) { return r === 'twilio' ? fake : orig.call(this, r, ...a); };`);
  const port = await freePort();
  const child = spawn(process.execPath, ['-r', preload, path.resolve(__dirname, '../src/server.js')], { cwd: d, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), DATA_DIR: d, PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, ADMIN_PASSWORD: 'x'.repeat(20),
      TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_AUTH_TOKEN: 'f'.repeat(32), TWILIO_PHONE_NUMBER: '+15005550006', OWNER_PHONE: '+15550000000', DOTENV_CONFIG_PATH: '/nonexistent' } });
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(d, { recursive: true, force: true }); });
  await new Promise((r, j) => { const tm = setTimeout(() => j(new Error('boot timeout: ' + out)), 4000); const i = setInterval(() => { if (out.includes(`on :${port}`)) { clearTimeout(tm); clearInterval(i); r(); } }, 20); });
  const B = `http://127.0.0.1:${port}`;
  const post = (p, f) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f).toString() });
  const r1 = await post('/twilio/voice', { From: '+14045550123' });
  assert.equal(r1.status, 200);
  assert.match(await r1.text(), /Please try again later/, 'caller is not told "we texted you" when the text failed');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(child.exitCode, null, 'process still alive:\n' + out);
  assert.equal((await fetch(B + '/health')).status, 200);
  assert.equal((await post('/twilio/sms', { From: '+14045550123', Body: 'hello' })).status, 200);
  assert.equal(child.exitCode, null);
  const db = JSON.parse(fs.readFileSync(path.join(d, 'db.json'), 'utf8'));
  assert.equal(db.optOuts['+14045550123'].source, 'twilio_21610');
  assert.match(out, /FAILED 21610/);
});

test('sendSms never throws: Twilio errors resolve { ok:false, code }, 21610 records an opt-out', async (t) => {
  quiet(t);
  t.after(() => sms.setClient(null));
  sms.setClient({ messages: { create: async () => { const e = new Error('boom'); e.code = 21610; throw e; } } });
  const p = num();
  const r = await sms.sendSms(p, 'hi');
  assert.deepEqual([r.ok, r.code], [false, 21610]);
  assert.equal(store.isOptedOut(p), true);
  sms.setClient({ messages: { create: async () => { throw new Error('network down'); } } });
  const r2 = await sms.sendSms(num(), 'hi');
  assert.equal(r2.ok, false);
  assert.equal(store.isOptedOut('+14705559999'), false);
});

test('errors inside async routes go to the error handler (500 / empty TwiML), not the process', async (t) => {
  quiet(t);
  const orig = store.createLead;
  t.after(() => { store.createLead = orig; });
  store.createLead = () => { throw new Error('db exploded'); };
  const r = await text(num(), 'hello');
  assert.equal(r.status, 200); assert.match(await r.text(), /<Response><\/Response>/);
  const origFind = store.findBooking;
  store.findBooking = () => { throw new Error('db exploded'); };
  t.after(() => { store.findBooking = origFind; });
  const p = await req('/pay/mock/abc');
  assert.equal(p.status, 500); assert.equal(await p.text(), 'server error');
});

test('production: placeholder OWNER_PHONE is never texted (warning, no crash); boot checks warn only', async (t) => {
  quiet(t);
  withEnv(t, { NODE_ENV: 'production', OWNER_PHONE: undefined });
  const r = await sms.sendSms(sec.PLACEHOLDER_PHONE, 'alert', { kind: 'owner' });
  assert.equal(r.skipped, 'placeholder_owner');
  assert.doesNotMatch(smsLog(), /\+10000000000/);
  assert.deepEqual(bootChecks(), [], 'strong password, missing OWNER_PHONE is only a warning');
});

// ---------- (2) opt-outs ----------
test('opt-out keywords (Twilio list, any case/punctuation) stop all texts; START/UNSTOP resubscribe', async (t) => {
  quiet(t);
  for (const kw of ['STOP', 'stopall', 'Unsubscribe', 'cancel', 'END', 'quit', 'OptOut', 'revoke', 'Stop!']) {
    const p = num();
    await call(p);
    const before = sentTo(p).length;
    const r = await text(p, kw);
    assert.match(await r.text(), /<Response><\/Response>/);
    assert.equal(store.isOptedOut(p), true, kw);
    await call(p); await text(p, 'Dana');
    assert.equal(sentTo(p).length, before, `${kw}: nothing sent after opting out`);
  }
  const p = num();
  await text(p, 'STOP');
  await text(p, 'UNSTOP');
  assert.equal(store.isOptedOut(p), false);
  const q = num(); await text(q, 'stop'); await text(q, 'start'); assert.equal(store.isOptedOut(q), false);
  const y = num(); await text(y, 'stop'); await text(y, 'YES'); assert.equal(store.isOptedOut(y), false, 'YES re-subscribes an opted-out number');
  assert.ok(store.db.optOuts && typeof store.db.optOuts === 'object', 'persisted in db');
});
test('YES from a subscribed caller is a normal reply; HELP gets a help text, even when opted out', async (t) => {
  quiet(t);
  const p = num();
  await call(p);
  await text(p, 'yes');
  assert.equal(sentTo(p).length, 2, 'conversation continued');
  const h = num();
  await text(h, 'STOP'); await text(h, 'help');
  const lines = sentTo(h);
  assert.equal(lines.length, 1); assert.match(lines[0], /Reply STOP to opt out/);
});
test('plain-language revocation: one confirmation, opted out, owner told; nothing after that', async (t) => {
  quiet(t);
  for (const msg of ['please stop texting me', "Don't text me", 'no more texts', 'remove me from your list']) {
    const p = num();
    await call(p);
    await text(p, msg);
    assert.equal(store.isOptedOut(p), true, msg);
    const lines = sentTo(p);
    assert.match(lines[lines.length - 1], /unsubscribed/);
    await text(p, 'hello?'); await call(p);
    assert.equal(sentTo(p).length, lines.length, msg);
  }
  assert.ok(store.db.alerts.some((a) => /asked not to be texted/.test(a.body)));
  assert.equal(optout.classify('Stop by tomorrow?'), null);
  assert.equal(optout.classify('I need the leak to stop'), null);
  assert.equal(optout.classify('cancel my appointment'), null);
});

// ---------- (4) caller id + global cap ----------
test('text-backs only to US/Canada numbers; anonymous/restricted/blank/international skipped', async (t) => {
  quiet(t);
  for (const bad of ['anonymous', '+266696687', '+7378742833', '+8656696', '', '+447700900123', '+12345', '+10005550123', '+14041550123']) {
    const before = smsLog().length;
    const r = await call(bad);
    assert.equal(r.status, 200);
    assert.equal(smsLog().length, before, `no text for ${JSON.stringify(bad)}`);
    await text(bad, 'hi');
    assert.equal(smsLog().length, before);
  }
  assert.equal(sentTo('+14045550188').length, 0);
  await call('+14045550188');
  assert.equal(sentTo('+14045550188').length, 1);
});
test('global hourly cap on caller texts; owner alerted once; owner alerts not capped', async (t) => {
  quiet(t);
  sms.resetCap();
  withEnv(t, { OUTBOUND_MAX_PER_HOUR: '3' });
  t.after(() => sms.resetCap());
  const ps = [num(), num(), num(), num(), num()];
  for (const p of ps) await call(p);
  assert.deepEqual(ps.map((p) => sentTo(p).length), [1, 1, 1, 0, 0]);
  await new Promise((r) => setTimeout(r, 50));
  const alerts = store.db.alerts.filter((a) => /outbound text limit reached/.test(a.body));
  assert.equal(alerts.length, 1);
  assert.ok(sentTo('+15550000000').some((l) => /outbound text limit reached/.test(l)), 'owner alert went out despite the cap');
});

// ---------- (3) admin password ----------
test('admin password check: production warns on short/placeholder passwords; STRICT=1 refuses to boot', async (t) => {
  quiet(t);
  withEnv(t, { NODE_ENV: 'production', ADMIN_PASSWORD: 'change-me' });
  assert.equal(bootChecks().length, 1);
  process.env.ADMIN_PASSWORD = 'short-but-15chr';
  assert.equal(bootChecks().length, 1);
  process.env.ADMIN_PASSWORD = 'a-long-random-password-1234';
  assert.equal(bootChecks().length, 0);
  process.env.NODE_ENV = 'test'; process.env.ADMIN_PASSWORD = 'x';
  assert.equal(bootChecks().length, 0, 'no checks outside production');
  const run = (extra) => new Promise(async (resolve) => {
    const port = await freePort(), d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-strict-'));
    const c = spawn(process.execPath, [path.resolve(__dirname, '../src/server.js')], { cwd: d, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, NODE_ENV: 'production', DEMO_MODE: '1', PORT: String(port), DATA_DIR: d, ADMIN_PASSWORD: 'change-me', DOTENV_CONFIG_PATH: '/nonexistent', ...extra } });
    let out = ''; c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { out += x; });
    const tm = setTimeout(() => { c.kill(); }, 2500);
    const i = setInterval(() => { if (out.includes(`on :${port}`)) { clearInterval(i); c.kill(); } }, 20);
    c.on('close', (code) => { clearTimeout(tm); clearInterval(i); fs.rmSync(d, { recursive: true, force: true }); resolve({ code, out }); });
  });
  const strict = await run({ ADMIN_PASSWORD_STRICT: '1' });
  assert.equal(strict.code, 1); assert.match(strict.out, /refusing to start/);
  const warn = await run({});
  assert.match(warn.out, /ADMIN_PASSWORD is weak/); assert.match(warn.out, /on :\d+/, 'boots with a warning');
  assert.match(warn.out, /\[mode\] production \(NODE_ENV=production\); demo\/mock routes ON \(DEMO_MODE=1\)/);
});

// ---------- (5) admin Origin + phone confirm (HTTP flow covered in setup-http.test.js) ----------
test('admin POST without Origin (and no same-host Referer) is refused', async () => {
  const r = await req('/admin/config/reset', { method: 'POST', headers: { ...auth, accept: 'application/json' } });
  assert.equal(r.status, 403);
  const ok = await req('/admin/config/reset', { method: 'POST', headers: { ...auth, accept: 'application/json', origin: BASE } });
  assert.equal(ok.status, 200);
});

// ---------- (6) global lockout = slow down + alert ----------
test('global failed-login cap slows admin down and alerts the owner once; the right password still works', async (t) => {
  quiet(t);
  app.locals.resetAdminLockout();
  t.after(() => app.locals.resetAdminLockout());
  for (let i = 0; i < 3; i++) assert.equal((await req('/admin', { headers: basic('x', 'nope' + i) })).status, 401);
  const t0 = Date.now();
  const r = await req('/admin', { headers: auth });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 >= 280, 'delayed');
  await req('/admin', { headers: auth });
  assert.equal(store.db.alerts.filter((a) => /failed admin password attempts/.test(a.body)).length, 1);
});

// ---------- (8) production detection ----------
test('production = NODE_ENV=production, RENDER, or https PUBLIC_BASE_URL with NODE_ENV unset', (t) => {
  withEnv(t, { NODE_ENV: undefined, RENDER: undefined, PUBLIC_BASE_URL: 'http://localhost:3000' });
  assert.equal(sec.isProduction(), false);
  process.env.PUBLIC_BASE_URL = 'https://trybuzzcall.com';
  assert.deepEqual(sec.modeInfo(), { production: true, reasons: ['https PUBLIC_BASE_URL'] });
  process.env.NODE_ENV = 'test';
  assert.equal(sec.isProduction(), false, 'explicit non-production NODE_ENV off Render');
  process.env.RENDER = 'true';
  assert.equal(sec.isProduction(), true);
  process.env.NODE_ENV = 'production'; process.env.DEMO_MODE = '1';
  assert.deepEqual(sec.modeInfo().reasons, ['NODE_ENV=production', 'RENDER']);
  assert.equal(sec.demoAllowed(), true, 'live site config (production + DEMO_MODE=1) keeps demo routes');
  delete process.env.DEMO_MODE;
});

// ---------- (9) regex-safe service names ----------
test('service names with regex characters do not throw', (t) => {
  withEnv(t, { BUSINESS_TYPE: 'braiders', SERVICES: '(small braids:60,Twists [long]:120,C++ cut:30' });
  assert.doesNotThrow(() => agent.pickService('something else'));
  assert.equal(agent.pickService('(small braids please').svc.name, '(small braids');
  assert.equal(agent.pickService('twists').svc.name, 'Twists [long]');
});

// ---------- (10) retention ----------
test('retention purge drops old leads/alerts only; off by default', (t) => {
  quiet(t);
  const old = new Date(Date.now() - 100 * 86400000).toISOString();
  store.db.leads.push({ id: 'oldlead', phone: '+14045550001', createdAt: old, messages: [{ dir: 'in', body: 'x' }], status: 'done' });
  store.db.alerts.push({ to: 'x', body: 'old alert', at: old });
  store.optOut('+14045550002', 'keyword');
  assert.equal(app.locals.runRetention(), null, 'RETENTION_DAYS unset = off');
  withEnv(t, { RETENTION_DAYS: '90' });
  const r = app.locals.runRetention();
  assert.equal(r.leads, 1); assert.equal(r.alerts, 1);
  assert.ok(!store.db.leads.some((l) => l.id === 'oldlead'));
  assert.equal(store.isOptedOut('+14045550002'), true, 'opt-outs are never purged');
});

// ---------- (13) GET /admin/connect/refresh ----------
test('GET /admin/connect/refresh creates nothing when no account exists', async (t) => {
  store.setOverride({});
  t.after(() => store.setOverride({}));
  const r = await req('/admin/connect/refresh', { headers: auth });
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/admin#connect');
  assert.equal(connect.accountId(), null);
});
