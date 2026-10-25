'use strict';
// Sixth security pass (2026-10-25, re-review of 76faab7): T1 DATA_DIR/SPILL_DIR validation, 0700/0600 permissions,
// group/world-writable warning, spill merge ignores opt-ins; T2 "para" + filler only is a Spanish opt-out;
// T3 public /health drops the storage backend (admin-only), keeps storageState.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-security6-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER', 'OPENAI_API_KEY', 'DATABASE_URL', 'FORWARD_TO_PHONE', 'VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_TYPE', 'SERVICES', 'BOOKING_LINK',
  'BILLING_REQUIRE_SUBSCRIPTION', 'BILLING_ENFORCE', 'DEMO_MODE', 'ADMIN_USERNAME', 'RENDER', 'CLIENT_IP_HEADER', 'TEXTBACK_COOLDOWN_MINUTES',
  'OUTBOUND_MAX_PER_HOUR', 'OUTBOUND_MAX_PER_DAY', 'RETENTION_DAYS', 'ADMIN_PASSWORD_STRICT', 'BOOKING_ENABLED', 'DEPOSIT_ENABLED', 'REQUIRE_POSTGRES',
  'TEXT_EXTRA_AREA_CODES', 'BOT_PAUSE_HOURS', 'STORAGE_ALERT_MINUTES', 'SPILL_DIR']) delete process.env[k];
const ADMIN = 'security6-test-password-long';
const OWNER = '+14045550100';
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: ADMIN, BUSINESS_NAME: 'Test Plumbing',
  OWNER_PHONE: OWNER, PUBLIC_BASE_URL: 'https://shop.example', ADMIN_MAX_FAILS: '1000', ADMIN_GLOBAL_MAX_FAILS: '1000' });

const store = require('../src/store');
const sec = require('../src/security');
const optout = require('../src/optout');
const { app } = require('../src/server');

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
let n = 0; const num = () => `+1706555${String(1000 + (n++)).slice(-4)}`;


const APP = path.resolve(__dirname, '..');
const tmp = (t, tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `buzzcall-t1-${tag}-`)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const mode = (p) => fs.statSync(p).mode & 0o777;
const failingPool = () => ({ fail: false, writes: [], async query(sql, params) { if (this.fail) throw new Error('down'); if (/INSERT/.test(sql)) this.writes.push(JSON.parse(params[0])); return { rows: this.rows || [] }; }, async end() {}, on() {} });

// ---------- T1 ----------
test('T1: checkDir rules (absolute in production; never public/ or the app folder except data/)', (t) => {
  const d = tmp(t, 'chk');
  assert.deepEqual(store.checkDir('', 'DATA_DIR'), { dir: null });
  assert.equal(store.checkDir(d, 'DATA_DIR').dir, d);
  assert.equal(store.checkDir('/tmp/buzzdata', 'DATA_DIR').dir, '/tmp/buzzdata', 'the live Render value is accepted');
  assert.equal(store.checkDir(path.join(APP, 'data'), 'DATA_DIR').dir, path.join(APP, 'data'), 'the default data/ folder is fine');
  assert.match(store.checkDir(path.join(APP, 'public'), 'SPILL_DIR').problem, /inside public\//);
  assert.match(store.checkDir(path.join(APP, 'public', 'x'), 'SPILL_DIR').problem, /inside public\//);
  assert.match(store.checkDir(path.join(APP, 'src'), 'DATA_DIR').problem, /inside the app folder/);
  assert.match(store.checkDir(APP, 'DATA_DIR').problem, /inside the app folder/);
  assert.match(store.checkDir(path.join(APP, 'data', '..', 'public'), 'DATA_DIR').problem, /inside public\//, '.. is resolved');
  fs.symlinkSync(path.join(APP, 'public'), path.join(d, 'link'));
  assert.match(store.checkDir(path.join(d, 'link', 'spill'), 'SPILL_DIR').problem, /inside public\//, 'symlink into public/ is refused');
  const rel = path.relative(process.cwd(), path.join(d, 'reldir'));
  assert.ok(!path.isAbsolute(rel));
  assert.equal(store.checkDir(rel, 'DATA_DIR').dir, path.join(d, 'reldir'), 'relative (outside the app) is allowed outside production');
  assert.match(store.checkDir('rel/dir', 'DATA_DIR').problem || 'cwd-not-app', /inside the app folder|cwd-not-app/);
  withEnv(t, { NODE_ENV: 'production' });
  assert.match(store.checkDir('rel/dir', 'DATA_DIR').problem, /absolute path in production/);
  assert.equal(store.checkDir('/tmp/buzzdata', 'DATA_DIR').dir, '/tmp/buzzdata');
});
test('T1: a refused DATA_DIR / SPILL_DIR falls back to the safe default with a loud warning (no crash)', (t) => {
  const errs = []; const o = console.error; console.error = (...a) => errs.push(a.join(' ')); t.after(() => { console.error = o; });
  const pubSpill = path.join(APP, 'public', 'zz-t1-spill');
  t.after(() => fs.rmSync(pubSpill, { recursive: true, force: true }));
  withEnv(t, { SPILL_DIR: pubSpill, NODE_ENV: 'test' });
  const d = tmp(t, 'fb');
  const s = store.createStore({ dir: d });
  assert.equal(s.status().spillDir, 'DATA_DIR', 'spill falls back to DATA_DIR');
  assert.equal(fs.existsSync(pubSpill), false, 'nothing created under public/');
  assert.match(s.status().pathWarnings.join('\n'), /SPILL_DIR is inside public\/.*using DATA_DIR/);
  assert.ok(errs.some((e) => /!!!!!!!!!! WARNING: SPILL_DIR is inside public\//.test(e)));
  process.env.NODE_ENV = 'production'; delete process.env.SPILL_DIR; // restored by the withEnv above
  const s2 = store.createStore({ dir: 'relative-data' });
  assert.equal(s2.dataDir(), path.join(APP, 'data'), 'relative DATA_DIR in production -> <app>/data');
  assert.equal(fs.existsSync(path.resolve('relative-data')), false);
  assert.match(s2.status().pathWarnings[0], /DATA_DIR must be an absolute path in production/);
  const s3 = store.createStore({ dir: path.join(APP, 'public') });
  assert.equal(s3.dataDir(), path.join(APP, 'data'));
});
test('T1: folders are created 0700, db.json / spill file 0600; older loose files are tightened', async (t) => {
  quiet(t);
  const d = tmp(t, 'perm'), data = path.join(d, 'a', 'data'), spillDir = path.join(d, 'disk', 'spill');
  fs.mkdirSync(d + '/old', { mode: 0o700 }); fs.writeFileSync(path.join(d, 'old', 'db.json'), '{}', { mode: 0o644 }); fs.chmodSync(path.join(d, 'old', 'db.json'), 0o644);
  store.createStore({ dir: path.join(d, 'old') });
  assert.equal(mode(path.join(d, 'old', 'db.json')), 0o600, 'existing 0644 db.json tightened');
  withEnv(t, { SPILL_DIR: spillDir });
  const pool = failingPool();
  const s = store.createStore({ dir: data, databaseUrl: 'postgres://u:p@db.example/x', poolFactory: () => pool });
  assert.equal(mode(data), 0o700); assert.equal(mode(spillDir), 0o700); assert.equal(mode(path.dirname(spillDir)), 0o700);
  assert.deepEqual(s.status().pathWarnings, []);
  await s.init();
  pool.fail = true;
  await s.optOut('+14045550701', 'keyword');
  assert.equal(mode(path.join(spillDir, 'optout-spill.jsonl')), 0o600);
  const f = store.createStore({ dir: path.join(d, 'filebk') });
  f.db.leads.push({ id: 'x' }); f.save();
  assert.equal(mode(path.join(d, 'filebk', 'db.json')), 0o600);
  pool.fail = false; await s.close();
});
test('T1: group- or world-writable folder gets a warning', (t) => {
  const errs = []; const o = console.error; console.error = (...a) => errs.push(a.join(' ')); t.after(() => { console.error = o; });
  const d = tmp(t, 'ww'), w = path.join(d, 'open'); fs.mkdirSync(w); fs.chmodSync(w, 0o1777);
  const s = store.createStore({ dir: w });
  assert.match(s.status().pathWarnings.join('\n'), /DATA_DIR folder is group- or world-writable \(mode 0777\)/);
  assert.ok(errs.some((e) => /WARNING: DATA_DIR folder is group- or world-writable/.test(e)));
  const g = path.join(d, 'grp'); fs.mkdirSync(g); fs.chmodSync(g, 0o770);
  assert.match(store.createStore({ dir: g }).status().pathWarnings.join('\n'), /group- or world-writable \(mode 0770\)/);
  assert.deepEqual(store.createStore({ dir: path.join(d, 'fresh') }).status().pathWarnings, []);
});
test('T1: merge ignores opt-in lines (a planted {"op":"in"} cannot remove a real opt-out); bad phones ignored', async (t) => {
  quiet(t);
  const d = tmp(t, 'merge');
  const s0 = store.createStore({ dir: d }); await s0.init();
  await s0.optOut('+14045550711', 'keyword');
  fs.writeFileSync(path.join(d, 'optout-spill.jsonl'), [
    JSON.stringify({ op: 'in', phone: '+14045550711', at: '2099-01-01T00:00:00Z' }),
    JSON.stringify({ op: 'out', phone: '+14045550712', at: '2026-10-25T10:00:00Z' }),
    JSON.stringify({ op: 'out', phone: 'not-a-phone' }),
    JSON.stringify({ op: 'out', phone: { $ne: 1 } }),
  ].join('\n') + '\n');
  const s = store.createStore({ dir: d }); await s.init();
  assert.equal(s.isOptedOut('+14045550711'), true, 'opt-in line ignored');
  assert.equal(s.isOptedOut('+14045550712'), true, 'opt-out line merged');
  assert.equal(s.isOptedOut('not-a-phone'), false);
  assert.equal(Object.keys(s.db.optOuts).length, 2);
});
test('T1: opt-in during an outage is not spilled, stays in memory and reaches Postgres on recovery', async (t) => {
  quiet(t);
  const d = tmp(t, 'optin'), pool = failingPool();
  const s = store.createStore({ dir: d, databaseUrl: 'postgres://u:p@db.example/x', poolFactory: () => pool });
  await s.init();
  pool.fail = true;
  await s.optOut('+14045550721', 'keyword');
  s.optIn('+14045550721');
  await new Promise((r) => setTimeout(r, 10));
  const lines = fs.readFileSync(path.join(d, 'optout-spill.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).op);
  assert.deepEqual(lines, ['out']);
  assert.equal(s.isOptedOut('+14045550721'), false, 'opt-in applies in memory');
  // restart mid-outage: the safe direction wins (caller stays opted out until they text START again)
  const r = store.createStore({ dir: d, databaseUrl: 'postgres://u:p@db.example/x', poolFactory: () => pool });
  await r.init();
  assert.equal(r.isOptedOut('+14045550721'), true);
  pool.fail = false; await s.flush();
  assert.ok(!pool.writes[pool.writes.length - 1].optOuts['+14045550721'], 'recovered: opt-in written to Postgres');
  await s.close(); await r.close();
});
test('T1: sms.log lives in the validated DATA_DIR and is 0600', async (t) => {
  quiet(t);
  const p = num(); await call(p);
  assert.equal(store.dataDir(), dir);
  assert.equal(mode(path.join(dir, 'sms.log')), 0o600);
});
test('T1: admin /health and /admin show path warnings', async (t) => {
  const orig = store.status; t.after(() => { store.status = orig; });
  store.status = () => ({ ...orig(), pathWarnings: ['SPILL_DIR is inside public/ (files there are served on the web); using DATA_DIR'] });
  const a = await (await req('/health', { headers: auth })).json();
  assert.match(a.storageDetail.pathWarnings[0], /SPILL_DIR is inside public/);
  assert.equal((await (await req('/health')).json()).pathWarnings, undefined);
  assert.match(await (await req('/admin', { headers: auth })).text(), /path warning<\/b>: SPILL_DIR is inside public\//);
});

// ---------- T2 ----------
const PARA_OUT = ['para', 'Para.', 'Para por favor', 'para por favor', 'PARA POR FAVOR!', 'para ya', 'Para ya!', 'para porfa', 'para pls', 'Para please', 'para, gracias', 'ya para', 'Para por favor ya'];
const PARA_REPLY = ['para el martes', 'Para mañana por favor', 'para mañana a las 3', 'si, para hoy', 'para cuando pueden venir?', 'es para la cocina', 'para ok', 'para y media', 'para las 5 por favor'];
test('T2: "para" + filler only (por, favor, ya, porfa, pls, please, gracias) is an opt-out; "para el martes" is not', () => {
  for (const m of PARA_OUT) { assert.equal(optout.classify(m), 'revoke', m); assert.equal(optout.language(m), 'es', m); }
  for (const m of PARA_REPLY) assert.equal(optout.classify(m), null, m);
});
test('T2 e2e: "Para por favor" mid-conversation: one bilingual confirmation, no bot reply; "para el martes" continues', async (t) => {
  quiet(t);
  const p = num(); await call(p); await text(p, 'Dana');
  const before = sentTo(p).length;
  await text(p, 'Para por favor');
  assert.equal(store.isOptedOut(p), true);
  const after = sentTo(p);
  assert.equal(after.length, before + 1, 'exactly one confirmation');
  assert.match(after[after.length - 1], /You're unsubscribed/);
  assert.match(after[after.length - 1], /Se canceló su suscripción/);
  assert.doesNotMatch(after[after.length - 1], /Thanks Para/);
  const q = num(); await call(q); await text(q, 'Dana');
  const b2 = sentTo(q).length;
  await text(q, 'para el martes');
  assert.equal(store.isOptedOut(q), false);
  assert.equal(sentTo(q).length, b2 + 1, 'normal bot reply');
  assert.doesNotMatch(sentTo(q).pop(), /unsubscribed/);
});

// ---------- T3 ----------
test('T3: public /health has storageState but not storage; admin /health has both', async () => {
  const pub = await (await req('/health')).json();
  assert.equal('storage' in pub, false);
  assert.equal(pub.storageState, 'ok');
  assert.equal(pub.ok, true);
  const adm = await (await req('/health', { headers: auth })).json();
  assert.equal(adm.storage, 'file');
  assert.equal(adm.storageState, 'ok');
  assert.equal(adm.storageDetail.backend, 'file');
  const bad = await (await req('/health', { headers: { authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') } })).json();
  assert.equal('storage' in bad, false, 'wrong password = public view');
});
