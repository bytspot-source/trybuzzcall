'use strict';
// Fourth security pass (2026-10-25, re-review of 984e00a): R1 short/plain-language opt-outs + bot pause on ambiguous
// "stop", R2 fail-closed storage in production + admin storage state, R3 opt-out spill file during Postgres write
// failures, R4 daily owner report of area-code skips + area-code list freshness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-security4-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER', 'OPENAI_API_KEY', 'DATABASE_URL', 'FORWARD_TO_PHONE', 'VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_TYPE', 'SERVICES', 'BOOKING_LINK',
  'BILLING_REQUIRE_SUBSCRIPTION', 'BILLING_ENFORCE', 'DEMO_MODE', 'ADMIN_USERNAME', 'RENDER', 'CLIENT_IP_HEADER', 'TEXTBACK_COOLDOWN_MINUTES',
  'OUTBOUND_MAX_PER_HOUR', 'OUTBOUND_MAX_PER_DAY', 'RETENTION_DAYS', 'ADMIN_PASSWORD_STRICT', 'BOOKING_ENABLED', 'DEPOSIT_ENABLED', 'REQUIRE_POSTGRES',
  'TEXT_EXTRA_AREA_CODES', 'BOT_PAUSE_HOURS', 'STORAGE_ALERT_MINUTES']) delete process.env[k];
const ADMIN = 'security4-test-password-long';
const OWNER = '+14045550100';
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: ADMIN, BUSINESS_NAME: 'Test Plumbing',
  OWNER_PHONE: OWNER, PUBLIC_BASE_URL: 'https://shop.example', ADMIN_MAX_FAILS: '1000', ADMIN_GLOBAL_MAX_FAILS: '1000' });

const store = require('../src/store');
const optout = require('../src/optout');
const areaCodes = require('../src/areaCodes');
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
let n = 0; const num = () => `+1770555${String(1000 + (n++)).slice(-4)}`;

// ---------- R1 ----------
const MUST_OPT_OUT = ['please stop', 'pls stop', 'I said stop', 'STOP STOP', 'Stop. Wrong number', 'stop sending these', 'quit texting me', 'lose my number'];
const ALSO_OPT_OUT = ['Please stop!', 'who is this? stop', 'wrong number stop', 'stop stop stop', 'Stop!! Who is this', 'wrong number', 'Wrong number!',
  'quit messaging me', 'stop texting me already', 'please stop 2nd time asking', 'I mean stop', 'delete my number', 'stop pls', 'PLEASE STOP!!!'];
const MUST_STAY_REPLIES = ['stop leak under sink', 'Stop valve is broken', 'opt out of the 3pm slot', 'stop, I meant Saturday'];
const ALSO_REPLIES = ['I want to opt out of the 3pm slot', 'Stop by at 3?', 'Can you stop by tomorrow', "The water won't stop running", 'Stop the leak asap please',
  'Stopped working yesterday', "My faucet won't stop dripping all night long", 'stop 3pm instead', 'toilet wont stop running', 'cancel my appointment', 'Dana', 'tomorrow after 3'];
test('R1: short / plain-language opt-outs are opt-outs (revoke -> one app confirmation)', () => {
  for (const m of [...MUST_OPT_OUT, ...ALSO_OPT_OUT]) assert.equal(optout.classify(m), 'revoke', m);
});
test('R1: job and scheduling replies stay normal replies (job-word guard applies to short messages too)', () => {
  for (const m of [...MUST_STAY_REPLIES, ...ALSO_REPLIES]) assert.equal(optout.classify(m), null, m);
});
test('R1: longer messages mentioning stop with no job context are "maybe" (pause + owner check)', () => {
  // ("I dont know who this is but stop" is now an opt-out: stop as its own clause, see security5 S2)
  for (const m of ['I never asked for this so stop it already ok', 'Who gave you this number? Stop now ok?', 'I really need you guys to stop this right away ok'])
    assert.equal(optout.classify(m), 'maybe', m);
  assert.equal(optout.classify('My faucet will not stop dripping since last night'), null, 'job word: normal reply');
});
test('R1 e2e: missed call, then "please stop": one confirmation, opted out, owner told, no bot reply', async (t) => {
  quiet(t);
  const p = num(); await call(p);
  const first = sentTo(p); assert.equal(first.length, 1, 'text-back');
  const alerts = store.db.alerts.length;
  await text(p, 'please stop');
  assert.equal(store.isOptedOut(p), true);
  const after = sentTo(p);
  assert.equal(after.length, 2, 'exactly one more text: the confirmation');
  assert.match(after[1], /unsubscribed/);
  assert.doesNotMatch(after[1], /What's going on|Thanks/);
  assert.ok(store.db.alerts.slice(0, store.db.alerts.length - alerts).some((a) => /asked not to be texted \("please stop"\)/.test(a.body)));
  await text(p, 'please stop'); await text(p, 'hello'); await call(p);
  assert.equal(sentTo(p).length, 2, 'silence afterwards');
});
test('R1 e2e: every required string opts out mid-conversation with one confirmation and no bot reply', async (t) => {
  quiet(t);
  for (const m of MUST_OPT_OUT) {
    const p = num(); await call(p); await text(p, 'Dana');
    const before = sentTo(p).length;
    await text(p, m);
    assert.equal(store.isOptedOut(p), true, m);
    const after = sentTo(p);
    assert.equal(after.length, before + 1, m);
    assert.match(after[after.length - 1], /unsubscribed/, m);
  }
});
test('R1 e2e: required job replies continue the conversation', async (t) => {
  quiet(t);
  for (const m of MUST_STAY_REPLIES) {
    const p = num(); await call(p); await text(p, 'Dana');
    const before = sentTo(p).length;
    await text(p, m);
    assert.equal(store.isOptedOut(p), false, m);
    assert.equal(store.isPaused(p), false, m);
    assert.equal(sentTo(p).length, before + 1, `${m}: bot replied`);
  }
});
test('R1 e2e: ambiguous longer "stop" message pauses automated texts and alerts the owner once; START resumes', async (t) => {
  quiet(t);
  const p = num(); await call(p); await text(p, 'Dana');
  const before = sentTo(p).length, alerts = store.db.alerts.length;
  await text(p, 'I never asked for this so stop it already ok');
  assert.equal(store.isOptedOut(p), false);
  assert.equal(store.isPaused(p), true);
  assert.equal(sentTo(p).length, before, 'no automated reply');
  const newAlerts = store.db.alerts.slice(0, store.db.alerts.length - alerts);
  assert.equal(newAlerts.filter((a) => /possible opt-out/.test(a.body)).length, 1);
  await text(p, 'Who gave you this number? Stop now ok?'); await text(p, 'hello?'); await call(p);
  assert.equal(sentTo(p).length, before, 'still nothing while paused');
  assert.equal(store.db.alerts.slice(0, store.db.alerts.length - alerts).filter((a) => /possible opt-out/.test(a.body)).length, 1, 'owner alerted once per pause');
  const lead = store.findOpenLead(p); assert.ok(lead.messages.some((m) => m.body === 'hello?'), 'messages kept for the owner');
  const admin = await (await req('/admin', { headers: auth })).text();
  assert.match(admin, /automated texts paused \(possible opt-out\): [^<]*\+1770555/);
  await text(p, 'START');
  assert.equal(store.isPaused(p), false);
  await text(p, 'leak under the sink');
  assert.equal(sentTo(p).length, before + 1, 'bot resumes after START');
});
test('R1: pause expires after BOT_PAUSE_HOURS', (t) => {
  withEnv(t, { BOT_PAUSE_HOURS: '1' });
  const p = num();
  store.pauseBot(p, 'x');
  assert.equal(store.isPaused(p), true);
  assert.equal(store.isPaused(p, Date.now() + 3600001), false);
  assert.equal(store.isPaused(p), false, 'expired entry removed');
});

// ---------- R2 ----------
test('R2: admin /health shows storage state and fail-closed policy; public /health shows storageState only', async (t) => {
  const pub = await (await req('/health')).json();
  assert.equal(pub.storageState, 'ok', 'dev file storage = ok (public summary is ok|degraded)');
  assert.equal(pub.storageDetail, undefined);
  const adm = await (await req('/health', { headers: auth })).json();
  assert.deepEqual(Object.keys(adm.storageDetail).sort(), ['backend', 'databaseConfigured', 'degraded', 'failClosed', 'failClosedReason', 'failingSince', 'fallback', 'lastError', 'optOutSpillPending', 'pathWarnings', 'spillDir', 'state']);
  assert.equal(adm.storageDetail.failClosed, false);
  withEnv(t, { REQUIRE_POSTGRES: '1' });
  assert.equal((await (await req('/health', { headers: auth })).json()).storageDetail.failClosed, true);
  const orig = store.status;
  store.status = () => ({ ...orig(), backend: 'postgres', degraded: true, failingSince: new Date().toISOString(), lastError: 'connect ECONNREFUSED' });
  t.after(() => { store.status = orig; });
  assert.equal((await (await req('/health')).json()).storageState, 'degraded');
  assert.match(await (await req('/admin', { headers: auth })).text(), /DEGRADED/);
});

// ---------- R3 ----------
function ctlPool() {
  const pool = { fail: false, writes: [], async query(sql, params) { if (this.fail) throw new Error('write failed: connection terminated'); if (/INSERT/.test(sql)) this.writes.push(JSON.parse(params[0])); return { rows: this.rows || [] }; }, async end() {}, on() {} };
  return pool;
}
test('R3: Postgres write failures after boot spill opt-outs to a local file, alert the owner once, show degraded; recovery clears it', async (t) => {
  quiet(t);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-r3-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const pool = ctlPool();
  const s = store.createStore({ dir: d, databaseUrl: 'postgres://u:secretpw@db.example/x', poolFactory: () => pool });
  await s.init();
  const alerts = []; s.setDegradedAlert((a) => alerts.push(a));
  pool.fail = true;
  await s.optOut('+14045550401', 'keyword');
  await s.optOut('+14045550402', 'message');
  const spillFile = path.join(d, 'optout-spill.jsonl');
  const lines = fs.readFileSync(spillFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.op, l.phone]), [['out', '+14045550401'], ['out', '+14045550402']]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(alerts.length, 2, 'one outage alert + one follow-up per later opt-out (S3)');
  assert.deepEqual(alerts.map((a) => [a.reason, a.optedOut]), [['spill', ['+1******0401']], ['spill_more', ['+1******0402']]]);
  const st = s.status();
  assert.deepEqual([st.degraded, st.spillPending], [true, 2]);
  assert.doesNotMatch(JSON.stringify(st), /secretpw/);
  s.optIn('+14045550402');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.status().spillPending, 2, 'T1: opt-ins are not spilled (kept in memory, written on recovery)');
  pool.fail = false;
  await s.flush();
  assert.equal(s.status().degraded, false);
  assert.equal(fs.existsSync(spillFile), false, 'spill cleared once Postgres has everything');
  const last = pool.writes[pool.writes.length - 1];
  assert.ok(last.optOuts['+14045550401']); assert.ok(!last.optOuts['+14045550402']);
  await s.close();
});
test('R3: spill file is merged at boot (Postgres) and written through', async (t) => {
  quiet(t);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-r3b-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'optout-spill.jsonl'), [
    JSON.stringify({ op: 'out', phone: '+14045550411', at: '2026-10-25T10:00:00Z', source: 'keyword' }),
    'not json',
    JSON.stringify({ op: 'out', phone: '+14045550412', at: '2026-10-25T10:01:00Z', source: 'message' }),
    JSON.stringify({ op: 'in', phone: '+14045550412', at: '2026-10-25T10:02:00Z' }),
  ].join('\n') + '\n');
  const pool = ctlPool();
  pool.rows = [{ key: 'db', value: { leads: [], alerts: [], optOuts: { '+14045550499': { at: '2026-01-01T00:00:00Z', source: 'keyword' } } } }];
  const s = store.createStore({ dir: d, databaseUrl: 'postgres://u:p@db.example/x', poolFactory: () => pool });
  await s.init();
  assert.equal(s.isOptedOut('+14045550411'), true);
  assert.equal(s.isOptedOut('+14045550412'), true, 'T1: opt-in lines in the spill file are ignored (it can only add opt-outs)');
  assert.equal(s.isOptedOut('+14045550499'), true, 'existing data kept');
  assert.ok(pool.writes.length && pool.writes[pool.writes.length - 1].optOuts['+14045550411'], 'merged opt-out written to Postgres');
  assert.equal(fs.existsSync(path.join(d, 'optout-spill.jsonl')), false);
  await s.close();
});
test('R3: spill merged on file backend; kept (but honoured) when Postgres is unreachable at boot', async (t) => {
  quiet(t);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-r3c-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const spill = path.join(d, 'optout-spill.jsonl');
  fs.writeFileSync(spill, JSON.stringify({ op: 'out', phone: '+14045550421', at: '2026-10-25T10:00:00Z' }) + '\n');
  const bad = ctlPool(); bad.fail = true;
  const s1 = store.createStore({ dir: d, databaseUrl: 'postgres://u:p@db.example/x', poolFactory: () => bad });
  await s1.init();
  assert.equal(s1.backend(), 'file'); assert.equal(s1.isOptedOut('+14045550421'), true);
  assert.equal(fs.existsSync(spill), true, 'kept until Postgres has it');
  const s2 = store.createStore({ dir: d });
  await s2.init();
  assert.equal(s2.isOptedOut('+14045550421'), true);
  assert.equal(fs.existsSync(spill), false);
});
test('R3: writes failing for STORAGE_ALERT_MINUTES alert the owner even without an opt-out', async (t) => {
  quiet(t);
  withEnv(t, { STORAGE_ALERT_MINUTES: '0' });
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-r3d-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const pool = ctlPool();
  const s = store.createStore({ dir: d, databaseUrl: 'postgres://u:p@db.example/x', poolFactory: () => pool });
  await s.init();
  const alerts = []; s.setDegradedAlert((a) => alerts.push(a));
  pool.fail = true;
  s.createLead('+14045550431');
  await s.flush();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(alerts.length, 1); assert.equal(alerts[0].reason, 'writes_failing');
  pool.fail = false; await s.flush(); await s.close();
});

// ---------- R4 ----------
test('R4: callers skipped for their area code are counted per day and reported to the owner once', async (t) => {
  quiet(t);
  store.db.areaSkips = {};
  for (const p of ['+18765550101', '+18765550102', '+17875550101', '+19005550101', 'anonymous', '+14045550188']) await call(p);
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(store.db.areaSkips[today], { 876: 2, 787: 1 }, 'premium/anonymous/valid not counted');
  assert.deepEqual(await app.locals.reportAreaSkips(), [], 'today is not reported yet');
  const sent = await app.locals.reportAreaSkips(Date.now() + 86400000);
  assert.deepEqual(sent, [{ day: today, total: 3 }]);
  const a = store.db.alerts.find((x) => /got no text-back because the caller's area code/.test(x.body));
  assert.match(a.body, /3 missed call\(s\).*876 x2, 787 x1.*TEXT_EXTRA_AREA_CODES/);
  assert.doesNotMatch(a.body, /5550101/, 'no phone numbers in the report');
  assert.deepEqual(store.db.areaSkips, {});
  assert.deepEqual(await app.locals.reportAreaSkips(Date.now() + 86400000), [], 'reported once');
});
test('R4: area-code list is less than ~12 months old (refresh src/areaCodes.js from NANPA when this fails)', () => {
  const age = Date.now() - Date.parse(areaCodes.REPORTED + 'T00:00:00Z');
  assert.ok(age > -86400000, 'REPORTED is not in the future');
  assert.ok(age < 365 * 86400000, `src/areaCodes.js was reported ${areaCodes.REPORTED}: refresh it from https://secure.nanpa.com/public-report/npa/geographic-use`);
});
