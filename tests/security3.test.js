'use strict';
// Third security pass (2026-10-25, re-review of 10e2fa2): N1 central Origin guard on admin/billing POSTs, N2 durable
// opt-outs + storage fallback warning / REQUIRE_POSTGRES, N3 US/Canada-only area codes + daily outbound cap, N4 narrow
// opt-out phrases, N5 NFKC + who confirms an opt-out, L5 retention default + inactiveTexts pruning.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-security3-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER', 'OPENAI_API_KEY', 'DATABASE_URL', 'FORWARD_TO_PHONE', 'VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_TYPE', 'SERVICES', 'BOOKING_LINK',
  'BILLING_REQUIRE_SUBSCRIPTION', 'BILLING_ENFORCE', 'DEMO_MODE', 'ADMIN_USERNAME', 'RENDER', 'CLIENT_IP_HEADER', 'TEXTBACK_COOLDOWN_MINUTES',
  'OUTBOUND_MAX_PER_HOUR', 'OUTBOUND_MAX_PER_DAY', 'RETENTION_DAYS', 'ADMIN_PASSWORD_STRICT', 'BOOKING_ENABLED', 'DEPOSIT_ENABLED', 'REQUIRE_POSTGRES',
  'TEXT_EXTRA_AREA_CODES', 'SETUP_WAIVER_CODE']) delete process.env[k];
const ADMIN = 'security3-test-password-long';
const OWNER = '+14045550100';
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: ADMIN, BUSINESS_NAME: 'Test Plumbing',
  OWNER_PHONE: OWNER, PUBLIC_BASE_URL: 'https://shop.example', ADMIN_MAX_FAILS: '1000', ADMIN_GLOBAL_MAX_FAILS: '1000' });

const store = require('../src/store');
const sms = require('../src/sms');
const sec = require('../src/security');
const optout = require('../src/optout');
const billing = require('../src/billing');
const areaCodes = require('../src/areaCodes');
const { app, initStorage } = require('../src/server');

let server, BASE;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); BASE = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const auth = { authorization: 'Basic ' + Buffer.from(`admin:${ADMIN}`).toString('base64') };
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
let n = 0; const num = () => `+1678555${String(1000 + (n++)).slice(-4)}`;
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

// ---------- N1: one central Origin guard ----------
const GUARDED_POSTS = ['/api/billing/preview', '/api/billing/change-plan', '/api/billing/cancel', '/api/billing/resume',
  '/billing/mock/checkout/cs_x/complete', '/billing/mock/update-card', '/billing/mock/advance', '/billing/mock/primary', '/billing/mock/fail-next',
  '/admin/setups/x/apply', '/admin/config/reset', '/admin/connect/onboard', '/admin/connect/sync', '/admin/connect/mock/complete'];
test('N1: every admin/billing POST refuses a cross-site Origin and a missing Origin, even with valid admin auth', async (t) => {
  quiet(t);
  for (const p of GUARDED_POSTS) {
    const evil = await form(p, { plan: 'annual', days: '1' }, { ...auth, origin: 'https://evil.example' });
    assert.equal(evil.status, 403, `${p} cross-site`);
    const none = await form(p, { plan: 'annual', days: '1' }, auth);
    assert.equal(none.status, 403, `${p} no Origin`);
    const evilRef = await form(p, {}, { ...auth, referer: 'https://evil.example/x' });
    assert.equal(evilRef.status, 403, `${p} cross-site Referer`);
  }
  // Express routes are case-insensitive, so the guard is too
  assert.equal((await form('/ADMIN/config/reset', {}, { ...auth, origin: 'https://evil.example' })).status, 403);
  assert.equal((await form('/Api/Billing/cancel', {}, { ...auth, origin: 'https://evil.example' })).status, 403);
});
test('N1: same-origin admin/billing POSTs still work (Origin or same-host Referer)', async (t) => {
  quiet(t);
  const o = { origin: BASE };
  const co = await (await form('/api/checkout', { plan: 'monthly' }, o)).json();
  const done = await form(`/billing/mock/checkout/${co.id}/complete`, {}, o);
  assert.equal(done.status, 200);
  const sub = (await done.json()).subscription.id;
  assert.equal((await form('/billing/mock/primary', { sub }, { ...auth, ...o })).status, 200);
  assert.equal((await form('/api/billing/preview', { plan: 'annual' }, { ...auth, ...o })).status, 200);
  const c = await form('/api/billing/cancel', {}, { ...auth, referer: `${BASE}/billing/mock/portal` });
  assert.equal(c.status, 200); assert.equal((await c.json()).cancel_at_period_end, true);
  assert.equal((await form('/api/billing/resume', {}, { ...auth, ...o })).status, 200);
  assert.equal((await form('/billing/mock/advance', { days: '0' }, { ...auth, ...o })).status, 200);
  assert.equal((await form('/admin/config/reset', {}, { ...auth, ...o })).status, 303);
  // without auth, same-origin still needs the password
  assert.equal((await form('/api/billing/cancel', {}, o)).status, 401);
  // GETs are not affected
  assert.equal((await req('/billing/status', { headers: auth })).status, 200);
});
test('N1: guard covers every registered POST under /admin, /api/billing, /billing (new routes cannot skip it)', async (t) => {
  quiet(t);
  const posts = [];
  for (const l of app._router.stack) if (l.route && l.route.methods.post && /^\/(admin|api\/billing|billing)\//i.test(l.route.path)) posts.push(l.route.path);
  assert.ok(posts.length >= GUARDED_POSTS.length, posts.join(','));
  for (const p of posts) {
    const url = p.replace(/:(\w+)/g, 'x');
    assert.equal((await form(url, {}, { ...auth, origin: 'https://evil.example' })).status, 403, url);
  }
});
test('N1: /api/checkout honours setup_waived from an admin only when same-origin', async (t) => {
  quiet(t);
  const evil = await (await form('/api/checkout', { plan: 'monthly', setup_waived: '1' }, { ...auth, origin: 'https://evil.example' })).json();
  assert.equal(billing.mockSessionInfo(evil.id).setupWaived, false, 'cross-site admin waiver ignored');
  const same = await (await form('/api/checkout', { plan: 'monthly', setup_waived: '1' }, { ...auth, origin: BASE })).json();
  assert.equal(billing.mockSessionInfo(same.id).setupWaived, true);
});

// ---------- N2: durable opt-outs, storage fallback ----------
function fakePool({ fail = false } = {}) {
  const queries = [];
  const pool = { queries, async query(sql, params) { queries.push({ sql, params }); if (fail) throw new Error('connect ECONNREFUSED'); if (/^SELECT/.test(sql)) return { rows: [] }; return { rows: [] }; }, async end() {}, on() {} };
  return pool;
}
test('N2: with Postgres an opt-out is written immediately (not debounced) and optOut() resolves after the write', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-n2-'));
  const pool = fakePool();
  const s = store.createStore({ dir: d, databaseUrl: 'postgres://u:p@db.example/x', poolFactory: () => pool });
  await s.init();
  assert.equal(s.backend(), 'postgres');
  s.createLead('+14045550111');
  const before = pool.queries.length;
  await s.optOut('+14045550111', 'keyword');
  const writes = pool.queries.slice(before).filter((q) => /INSERT INTO buzz_kv/.test(q.sql));
  assert.ok(writes.length >= 1, 'flushed right away');
  const saved = JSON.parse(writes[writes.length - 1].params[0]);
  assert.ok(saved.optOuts['+14045550111'], 'opt-out is in the written document');
  assert.equal(saved.leads[0].status, 'opted_out');
  const before2 = pool.queries.length;
  await s.optOut('+14045550111', 'keyword');
  assert.equal(pool.queries.length, before2, 'no-op when already opted out');
  assert.equal(s.optIn('+14045550111'), true);
  await s.flush();
  assert.ok(!JSON.parse(pool.queries.filter((q) => /INSERT/.test(q.sql)).pop().params[0]).optOuts['+14045550111']);
  await s.close(); fs.rmSync(d, { recursive: true, force: true });
});
test('N2: unreachable Postgres -> file fallback flagged in status()', async (t) => {
  quiet(t);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-n2b-'));
  const s = store.createStore({ dir: d, databaseUrl: 'postgres://u:p@db.example/x', poolFactory: () => fakePool({ fail: true }) });
  await s.init();
  assert.deepEqual([s.backend(), s.status().fallback, s.status().configured], ['file', true, true]);
  await s.optOut('+14045550112', 'keyword');
  assert.ok(JSON.parse(fs.readFileSync(path.join(d, 'db.json'), 'utf8')).optOuts['+14045550112'], 'file fallback still writes synchronously');
  fs.rmSync(d, { recursive: true, force: true });
});
test('N2: in production, file storage logs a loud warning and alerts the owner; REQUIRE_POSTGRES=1 makes it fatal; dev is quiet', async (t) => {
  const errs = []; const o = console.error, l = console.log; console.error = (...a) => errs.push(a.join(' ')); console.log = () => {};
  t.after(() => { console.error = o; console.log = l; });
  withEnv(t, { NODE_ENV: 'development', REQUIRE_POSTGRES: undefined });
  assert.equal((await initStorage()).ok, true, 'development: file storage is fine');
  withEnv(t, { NODE_ENV: 'production', DEMO_MODE: '1' });
  const alertsBefore = store.db.alerts.length;
  const r = await initStorage();
  assert.deepEqual([r.ok, r.fatal], [false, false]);
  assert.ok(errs.some((e) => /WARNING: DATABASE_URL is not set: running on FILE storage/.test(e)), errs.join('\n'));
  assert.ok(store.db.alerts.slice(0, store.db.alerts.length - alertsBefore).some((a) => /storage warning/.test(a.body)), 'owner alert recorded');
  withEnv(t, { REQUIRE_POSTGRES: '1' });
  const f = await initStorage({ retries: 1 });
  assert.equal(f.fatal, true);
  assert.ok(errs.some((e) => /FATAL: REQUIRE_POSTGRES=1/.test(e)));
});
test('N2: real boot with unreachable DATABASE_URL: stays up on file storage by default, exits with REQUIRE_POSTGRES=1', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-n2c-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const dead = await freePort(); // nothing listens here
  const boot = async (extra) => {
    const port = await freePort();
    const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server.js')], { cwd: d, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, NODE_ENV: 'production', DEMO_MODE: '1', PORT: String(port), DATA_DIR: d, PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
        ADMIN_PASSWORD: 'x'.repeat(24), OWNER_PHONE: OWNER, DATABASE_URL: `postgres://u:p@127.0.0.1:${dead}/x`, DOTENV_CONFIG_PATH: '/nonexistent', ...extra } });
    let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
    t.after(() => child.kill('SIGKILL'));
    const exit = new Promise((r) => child.on('exit', (code) => r(code)));
    const up = new Promise((r) => { const i = setInterval(() => { if (out.includes(`on :${port}`)) { clearInterval(i); r('up'); } }, 20); child.on('exit', () => clearInterval(i)); });
    const res = await Promise.race([up, exit, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
    return { res, out, port, child };
  };
  const a = await boot({});
  assert.equal(a.res, 'up', a.out);
  assert.match(a.out, /WARNING: DATABASE_URL is set but Postgres is unreachable/);
  assert.equal((await (await fetch(`http://127.0.0.1:${a.port}/health`)).json()).storage, 'file');
  a.child.kill('SIGKILL');
  const b = await boot({ REQUIRE_POSTGRES: '1', REQUIRE_POSTGRES_RETRIES: '2' });
  assert.equal(b.res, 1, b.out);
  assert.match(b.out, /attempt 1\/2/);
  assert.match(b.out, /FATAL: REQUIRE_POSTGRES=1/);
});
test('N2: an inbound STOP is recorded before the webhook answers', async (t) => {
  quiet(t);
  const p = num();
  const orig = store.optOut; let resolved = false;
  store.optOut = (...a) => orig.apply(store, a).then(() => new Promise((r) => setTimeout(() => { resolved = true; r(); }, 50)));
  t.after(() => { store.optOut = orig; });
  await text(p, 'STOP');
  assert.equal(resolved, true, 'webhook waited for the durable write');
});

// ---------- N3: US/Canada only, premium blocked, daily cap ----------
test('N3: only US/Canada geographic area codes are textable', (t) => {
  withEnv(t, { TEXT_EXTRA_AREA_CODES: undefined });
  for (const ok of ['+14045550188', '+12125550100', '+19075550100', '+18085550100', '+12025550100', '+14165550100', '+16045550100', '+15145550100', '+18675550100', '+17095550100'])
    assert.equal(sec.isNanp(ok), true, ok);
  const bad = {
    '+18765550100': 'Jamaica', '+16585550100': 'Jamaica', '+18095550100': 'Dominican Rep.', '+18295550100': 'DR', '+18495550100': 'DR', '+12425550100': 'Bahamas',
    '+12465550100': 'Barbados', '+12685550100': 'Antigua', '+16495550100': 'Turks & Caicos', '+14415550100': 'Bermuda', '+18685550100': 'Trinidad',
    '+17875550100': 'Puerto Rico (opt-in only)', '+16715550100': 'Guam (opt-in only)', '+19005550100': 'premium 900', '+18005550100': 'toll-free',
    '+18885550100': 'toll-free', '+15005550100': 'non-geographic', '+15555550100': 'unassigned', '+14049765555': 'exchange 976', '+14044115555': 'N11 exchange',
    '+1404555010': 'short', '+441234567890': 'UK',
  };
  for (const [p, why] of Object.entries(bad)) assert.equal(sec.isNanp(p), false, `${p} ${why}`);
  assert.equal(sec.nanpReason('+18765550100'), 'non-US/Canada NANP area code');
  assert.equal(sec.nanpReason('+19005550100'), 'premium area code');
  withEnv(t, { TEXT_EXTRA_AREA_CODES: '787, 939' });
  assert.equal(sec.isNanp('+17875550100'), true, 'territory can be opted in');
  withEnv(t, { TEXT_EXTRA_AREA_CODES: '900' });
  assert.equal(sec.isNanp('+19005550100'), false, '900 stays blocked');
});
test('N3: area-code table sanity (from NANPA, 50 states + DC and Canada; no Caribbean)', () => {
  assert.equal(areaCodes.US.size, 372); assert.equal(areaCodes.CA.size, 55);
  for (const c of areaCodes.NON_US_CA) { assert.ok(!areaCodes.US.has(c) && !areaCodes.CA.has(c), c); }
  for (const c of ['876', '809', '829', '849', '242', '246', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767', '784', '868', '869', '900', '976'])
    assert.ok(!areaCodes.US.has(c) && !areaCodes.CA.has(c), c);
  for (const c of [...areaCodes.US, ...areaCodes.CA]) assert.match(c, /^[2-9]\d\d$/);
});
test('N3: calls/texts from Caribbean or premium numbers get no text-back', async (t) => {
  quiet(t);
  for (const p of ['+18765550101', '+18095550101', '+12685550101', '+19005550101', '+14049765501']) {
    const before = smsLog().length;
    await call(p); await text(p, 'hi');
    assert.equal(smsLog().length, before, p);
  }
});
test('N3: daily outbound cap (OUTBOUND_MAX_PER_DAY) stops caller texts and alerts the owner once; owner texts not capped', async (t) => {
  quiet(t);
  sms.resetCap(); t.after(() => sms.resetCap());
  withEnv(t, { OUTBOUND_MAX_PER_HOUR: '100', OUTBOUND_MAX_PER_DAY: '2' });
  const ps = [num(), num(), num(), num()];
  for (const p of ps) await call(p);
  assert.deepEqual(ps.map((p) => sentTo(p).length), [1, 1, 0, 0]);
  await new Promise((r) => setTimeout(r, 50));
  const alerts = store.db.alerts.filter((a) => /outbound text limit reached \(2\/day\)/.test(a.body));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].body, /OUTBOUND_MAX_PER_DAY/);
  assert.ok(sentTo(OWNER).some((l) => /2\/day/.test(l)));
  const r = await sms.sendSms(num(), 'x');
  assert.equal(r.skipped, 'cap_day');
});
test('N3: daily cap default is 500, 0 disables', async (t) => {
  quiet(t);
  sms.resetCap(); t.after(() => sms.resetCap());
  withEnv(t, { OUTBOUND_MAX_PER_HOUR: '0', OUTBOUND_MAX_PER_DAY: undefined });
  let ok = 0; for (let i = 0; i < 501; i++) if ((await sms.sendSms('+14045559' + String(i).padStart(3, '0'), 'x')).ok) ok++;
  assert.equal(ok, 500);
  sms.resetCap(); withEnv(t, { OUTBOUND_MAX_PER_DAY: '0' });
  ok = 0; for (let i = 0; i < 520; i++) if ((await sms.sendSms('+14045558' + String(i).padStart(3, '0'), 'x')).ok) ok++;
  assert.equal(ok, 520);
});

// ---------- N4: narrow phrase rules ----------
test('N4: job descriptions that start with or contain stop / opt out are NOT opt-outs', () => {
  for (const m of ['stop leak under sink', 'Stop valve is broken', 'stop, I meant Saturday', 'I want to opt out of the 3pm slot', 'opt out of the 3pm slot',
    'Stop by at 3?', 'Can you stop by tomorrow', 'The water won\'t stop running', 'need a shut off / stop cock replaced', 'Stop the leak asap please',
    'Stopped working yesterday', 'please remove me old water heater', 'remove the old toilet', 'cancel my appointment', 'take me off the waitlist for Friday and put me on Monday',
    'stop sending the tech before 9', 'END of the pipe is cracked'])
    assert.equal(optout.classify(m), null, m);
});
test('N4: real opt-out phrasing still counts', () => {
  for (const m of ['please stop texting me', 'Stop texting me', 'stop messaging this number', 'no more texts', "don't text me", 'Do not contact me', 'never text me again',
    'unsubscribe me', 'leave me alone', 'remove me', 'remove me from your list', 'take me off the list', 'opt me out', 'opt me out please', 'I want to opt out',
    'I want to opt out of these texts', 'opt out of texts', 'stop please', 'STOP IT', 'stop now', 'stop the texts'])
    assert.equal(optout.classify(m), 'revoke', m);
});

// ---------- N5: NFKC, who confirms ----------
test('N5: exact Twilio keywords -> optout (Twilio confirms); every other variant -> revoke (app confirms)', () => {
  for (const k of ['STOP', 'stop', ' Stop ', 'STOPALL', 'UNSUBSCRIBE', 'cancel', 'END', 'QUIT', 'OPTOUT', 'REVOKE', '\tstop\n']) assert.equal(optout.classify(k), 'optout', JSON.stringify(k));
  for (const k of ['S T O P', 'STOP 2', '❌STOP❌', '🛑 stop 🛑', 'ＳＴＯＰ', 'Ｓｔｏｐ', 'stop.', 'STOP!!!', 'S.T.O.P', 'opt out', 'opt-out', 'Opt Out', 'un-subscribe', 'st\u200Bop'])
    assert.equal(optout.classify(k), 'revoke', JSON.stringify(k));
  assert.equal(optout.letters('ＳＴＯＰ'), 'STOP');
  assert.equal(optout.classify('ＨＥＬＰ'), 'help');
  assert.equal(optout.classify('ｓｔａｒｔ'), 'optin');
  assert.equal(optout.classify('don’t text me'), 'revoke', 'smart apostrophe');
});
test('N5: exact STOP -> no app confirmation; each variant -> exactly one confirmation, then silence', async (t) => {
  quiet(t);
  const p = num(); await call(p);
  const base = sentTo(p).length;
  await text(p, 'STOP');
  assert.equal(store.isOptedOut(p), true);
  assert.equal(sentTo(p).length, base, 'Twilio sends the STOP confirmation, not us');
  for (const v of ['S T O P', 'STOP 2', '❌STOP❌', 'ＳＴＯＰ', 'opt out', 'stop.', 'please stop texting me']) {
    const q = num(); await call(q);
    const b = sentTo(q).length;
    await text(q, v);
    assert.equal(store.isOptedOut(q), true, v);
    const after = sentTo(q);
    assert.equal(after.length, b + 1, `${v}: one confirmation`);
    assert.match(after[after.length - 1], /unsubscribed/);
    await text(q, v); await text(q, 'STOP'); await call(q); await text(q, 'hello');
    assert.equal(sentTo(q).length, b + 1, `${v}: nothing more`);
  }
});
test('N5: job texts mid-conversation keep the conversation going', async (t) => {
  quiet(t);
  const p = num(); await call(p);
  await text(p, 'Dana');
  await text(p, 'stop leak under sink');
  assert.equal(store.isOptedOut(p), false);
  assert.equal(sentTo(p).length, 3, 'agent replied to both messages');
});

// ---------- L5: retention ----------
test('L5: RETENTION_DAYS defaults to 365; inactiveTexts stamps older than 24h are pruned', (t) => {
  quiet(t);
  withEnv(t, { RETENTION_DAYS: undefined });
  const old400 = new Date(Date.now() - 400 * 86400000).toISOString(), old300 = new Date(Date.now() - 300 * 86400000).toISOString();
  store.db.leads.push({ id: 'l400', phone: '+14045550301', createdAt: old400, messages: [], status: 'done' }, { id: 'l300', phone: '+14045550302', createdAt: old300, messages: [], status: 'done' });
  store.db.inactiveTexts = { '+14045550303': new Date(Date.now() - 25 * 3600000).toISOString(), '+14045550304': new Date().toISOString(), '+14045550305': 'garbage' };
  const r = app.locals.runRetention();
  assert.equal(r.days, 365);
  assert.ok(!store.db.leads.some((l) => l.id === 'l400'));
  assert.ok(store.db.leads.some((l) => l.id === 'l300'));
  assert.deepEqual(Object.keys(store.db.inactiveTexts), ['+14045550304']);
  assert.equal(r.inactiveTexts, 2);
});
