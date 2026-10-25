'use strict';
// Fifth security pass (2026-10-25, re-review of 3cb0755): S1 Spanish opt-outs + bilingual confirmation, S2 standalone /
// repeated stop beats job words + refusals + obfuscated stop, S3 SPILL_DIR + masked numbers in outage alerts,
// S4 toll-free/premium blocked before TEXT_EXTRA_AREA_CODES and kept out of the area report, S5 public storage summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-security5-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER', 'OPENAI_API_KEY', 'DATABASE_URL', 'FORWARD_TO_PHONE', 'VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_TYPE', 'SERVICES', 'BOOKING_LINK',
  'BILLING_REQUIRE_SUBSCRIPTION', 'BILLING_ENFORCE', 'DEMO_MODE', 'ADMIN_USERNAME', 'RENDER', 'CLIENT_IP_HEADER', 'TEXTBACK_COOLDOWN_MINUTES',
  'OUTBOUND_MAX_PER_HOUR', 'OUTBOUND_MAX_PER_DAY', 'RETENTION_DAYS', 'ADMIN_PASSWORD_STRICT', 'BOOKING_ENABLED', 'DEPOSIT_ENABLED', 'REQUIRE_POSTGRES',
  'TEXT_EXTRA_AREA_CODES', 'BOT_PAUSE_HOURS', 'STORAGE_ALERT_MINUTES', 'SPILL_DIR']) delete process.env[k];
const ADMIN = 'security5-test-password-long';
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

// ---------- S1: Spanish ----------
const ES_OPT_OUT = ['basta', 'Basta ya', 'ya basta', 'BASTA!', 'alto', 'Alto por favor', 'cancelar', 'para', 'PARA', 'Para.', 'pare', 'baja', 'detener',
  'no me escriban', 'No me escribas más', 'no me escribas mas', 'no me manden mensajes', 'No me envíen más mensajes', 'deja de escribirme', 'Dejen de escribirme',
  'deja de mandarme mensajes', 'dejen de mandarme', 'dar de baja', 'darme de baja', 'Quiero darme de baja', 'denme de baja', 'número equivocado', 'numero equivocado',
  'Número equivocado, gracias', 'no más mensajes', 'no mas mensajes', 'No quiero más mensajes', 'no me molesten', 'borren mi número', 'no me interesa', 'no estoy interesada'];
const ES_REPLIES = ['para el martes', 'Para mañana por favor', 'es para la cocina', 'la llave no para de gotear', 'cancelar la cita del martes', 'no me mandaron la factura',
  'Me llamo Ana', 'el baño está goteando', 'alto voltaje en la casa'];
test('S1: Spanish opt-outs are opt-outs; "para" only as the whole message', () => {
  for (const m of ES_OPT_OUT) { assert.equal(optout.classify(m), 'revoke', m); assert.equal(optout.language(m), 'es', m); }
  for (const m of ES_REPLIES) assert.equal(optout.classify(m), null, m);
  assert.equal(optout.language('please stop'), 'en');
});
test('S1 e2e: missed call, then "basta": one bilingual confirmation, opted out, no bot reply', async (t) => {
  quiet(t);
  const p = num(); await call(p);
  assert.equal(sentTo(p).length, 1);
  await text(p, 'basta');
  assert.equal(store.isOptedOut(p), true);
  const after = sentTo(p);
  assert.equal(after.length, 2, 'exactly one confirmation');
  assert.match(after[1], /You're unsubscribed/);
  assert.match(after[1], /Se canceló su suscripción y no recibirá más mensajes\. Responda START/);
  assert.doesNotMatch(after[1], /Thanks|What's going on/);
  await text(p, 'basta'); await text(p, 'hola'); await call(p);
  assert.equal(sentTo(p).length, 2, 'silence afterwards');
});
test('S1 e2e: other Spanish opt-outs mid-conversation; "para el martes" continues the conversation', async (t) => {
  quiet(t);
  for (const m of ['no me escriban', 'para', 'deja de escribirme', 'número equivocado', 'dar de baja']) {
    const p = num(); await call(p); await text(p, 'Ana');
    const before = sentTo(p).length;
    await text(p, m);
    assert.equal(store.isOptedOut(p), true, m);
    assert.equal(sentTo(p).length, before + 1, m);
    assert.match(sentTo(p).pop(), /Responda START/, m);
  }
  const q = num(); await call(q); await text(q, 'Ana');
  const before = sentTo(q).length;
  await text(q, 'para el martes');
  assert.equal(store.isOptedOut(q), false);
  assert.equal(sentTo(q).length, before + 1, 'bot replied');
  // English opt-outs keep the English-only confirmation
  const r = num(); await call(r); await text(r, 'please stop');
  assert.doesNotMatch(sentTo(r).pop(), /Responda/);
});

// ---------- S2 ----------
const S2_OPT_OUT = ['STOP! not today', 'stop. over it', 'Stop. I already called a plumber', 'stop. I fixed the sink myself', 'stop by now? no. stop',
  "stop it, I'm busy today", 'stop, leak fixed already', 'not interested', 'Not interested.', 'No thanks, not interested', 'go away', 'Go away!', '🛑', '🛑🛑', ' 🛑 ',
  'STOPP', 'stoooop', 'Stooop!', 'st0p', 'ST0P', 'pls stahp', 'I dont know who this is but stop', 'wont stop'];
const EARLIER_OPT_OUT = ['please stop', 'pls stop', 'I said stop', 'STOP STOP', 'Stop. Wrong number', 'stop sending these', 'quit texting me', 'lose my number',
  'Please stop!', 'who is this? stop', 'wrong number stop', 'stop stop stop', 'Stop!! Who is this', 'wrong number', 'stop por favor', 'stop please', 'STOP IT',
  'stop now', 'stop the texts', 'S T O P', 'STOP 2', '❌STOP❌', 'ＳＴＯＰ', 'stop.', 'opt out', 'please stop texting me', "don't text me", 'remove me',
  'unsubscribe me', 'leave me alone', 'opt me out', 'I want to opt out of these texts', 'stop-stop', '"stop"', '...stop', 'I mean stop', 'stop pls'];
const EARLIER_REPLIES = ['stop leak under sink', 'Stop valve is broken', 'opt out of the 3pm slot', 'stop, I meant Saturday', 'I want to opt out of the 3pm slot',
  'Stop by at 3?', 'Can you stop by tomorrow', 'stop by tomorrow', "The water won't stop running", 'Stop the leak asap please', 'Stopped working yesterday',
  "My faucet won't stop dripping all night long", 'stop 3pm instead', 'toilet wont stop running', 'cancel my appointment', 'Dana', 'tomorrow after 3',
  'stop the drip in the shower please', 'It started leaking again, can you stop by today?', 'please stop by tomorrow morning', 'shut-off valve: stop cock is stuck',
  "the water won't stop", 'I need the leak to stop', 'Water everywhere. Make it stop!', 'it stopped', 'it stopped leaking', 'nonstop dripping', 'stopped by earlier',
  "the smell won't go away", 'stop sending the tech before 9', 'END of the pipe is cracked', 'need a shut off / stop cock replaced',
  'My faucet will not stop dripping since last night', 'The water won\'t stop running', 'Stop by at 3?'];
test('S2: stop as its own sentence/clause or repeated is an opt-out even with a job word; refusals and obfuscated stop count', () => {
  for (const m of [...S2_OPT_OUT, ...EARLIER_OPT_OUT]) assert.equal(optout.classify(m), 'revoke', m);
});
test('S2: normal replies only when stop is followed by a job noun / "by", describes the problem, or is a correction', () => {
  for (const m of EARLIER_REPLIES) assert.equal(optout.classify(m), null, m);
  for (const m of ['I never asked for this so stop it already ok', 'Who gave you this number? Stop now ok?']) assert.equal(optout.classify(m), 'maybe', m);
});
test('S2: generic words (by, over, today, weekdays) no longer cancel a stop', () => {
  for (const m of ['stop today', 'stop it today', 'Stop. Monday', 'stop over']) assert.equal(optout.classify(m), 'revoke', m);
});
test('S2 e2e: "Stop. I already called a plumber" mid-conversation opts out with one confirmation', async (t) => {
  quiet(t);
  const p = num(); await call(p); await text(p, 'Dana');
  const before = sentTo(p).length;
  await text(p, 'Stop. I already called a plumber');
  assert.equal(store.isOptedOut(p), true);
  assert.equal(sentTo(p).length, before + 1);
});

// ---------- S3 ----------
test('S3: SPILL_DIR puts the spill file on a separate (persistent) directory; DATA_DIR is the fallback', async (t) => {
  quiet(t);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-s3-')), spillDir = path.join(d, 'disk');
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  withEnv(t, { SPILL_DIR: spillDir });
  const pool = { fail: false, async query(sql) { if (this.fail) throw new Error('down'); return { rows: [] }; }, async end() {}, on() {} };
  const s = store.createStore({ dir: path.join(d, 'data'), databaseUrl: 'postgres://u:p@db.example/x', poolFactory: () => pool });
  await s.init();
  pool.fail = true;
  await s.optOut('+14045550501', 'keyword');
  assert.ok(fs.existsSync(path.join(spillDir, 'optout-spill.jsonl')));
  assert.ok(!fs.existsSync(path.join(d, 'data', 'optout-spill.jsonl')));
  assert.equal(s.status().spillDir, 'SPILL_DIR');
  // a new instance with a fresh DATA_DIR but the same SPILL_DIR still honours the opt-out
  const s2 = store.createStore({ dir: path.join(d, 'data2'), databaseUrl: 'postgres://u:p@db.example/x', poolFactory: () => pool });
  await s2.init();
  assert.equal(s2.backend(), 'file'); assert.equal(s2.isOptedOut('+14045550501'), true);
  pool.fail = false;
  withEnv(t, { SPILL_DIR: undefined });
  assert.equal(store.createStore({ dir: path.join(d, 'data3') }).status().spillDir, 'DATA_DIR');
});
test('S3: outage owner alert lists masked opted-out numbers; follow-ups for later opt-outs; never full numbers', async (t) => {
  quiet(t);
  const before = store.db.alerts.length;
  await app.locals.storageAlert({ reason: 'spill', since: '2026-10-25T15:00:00.000Z', optedOut: [sec.maskPhone('+14045550601')] });
  await app.locals.storageAlert({ reason: 'spill_more', since: '2026-10-25T15:00:00.000Z', optedOut: [sec.maskPhone('+14045550602')] });
  const a = store.db.alerts.slice(0, store.db.alerts.length - before).map((x) => x.body).reverse();
  assert.match(a[0], /database writes are failing.*Opted out during the outage \(masked\): \+1\*{6}0601/);
  assert.match(a[1], /opt-out during database outage: \+1\*{6}0602\. Do not text this number/);
  assert.doesNotMatch(a.join(' '), /4045550601|4045550602/);
});

// ---------- S4 ----------
test('S4: toll-free, premium and non-geographic codes stay blocked even if listed in TEXT_EXTRA_AREA_CODES', (t) => {
  withEnv(t, { TEXT_EXTRA_AREA_CODES: '800,833,844,855,866,877,888,900,500,700,787' });
  for (const p of ['+18005550100', '+18335550100', '+18885550100', '+19005550100', '+15005550100', '+17005550100']) assert.equal(sec.isNanp(p), false, p);
  assert.equal(sec.nanpReason('+18885550100'), 'toll-free area code');
  assert.equal(sec.isNanp('+17875550100'), true, 'real extra codes still work');
});
test('S4: toll-free/premium/non-geographic callers are not in the area-code report', async (t) => {
  quiet(t);
  store.db.areaSkips = {};
  for (const p of ['+18005550101', '+18885550101', '+19005550101', '+15005550101', '+18765550101']) await call(p);
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(store.db.areaSkips[today], { 876: 1 });
  const sent = await app.locals.reportAreaSkips(Date.now() + 86400000);
  assert.deepEqual(sent, [{ day: today, total: 1 }]);
});

// ---------- S5 ----------
test('S5/T3: public /health has only an ok/degraded storage summary; storage + detail are admin-only', async (t) => {
  const pub = await (await req('/health')).json();
  assert.equal(pub.storage, undefined, 'T3: storage backend is admin-only');
  assert.ok(['ok', 'degraded'].includes(pub.storageState));
  assert.equal(pub.storageDetail, undefined);
  for (const k of ['lastError', 'failingSince', 'spillPending', 'fallback']) assert.equal(pub[k], undefined, k);
  withEnv(t, { NODE_ENV: 'production', DEMO_MODE: '1' });
  assert.equal((await (await req('/health')).json()).storageState, 'degraded', 'file storage in production is degraded');
  const orig = store.status;
  t.after(() => { store.status = orig; });
  store.status = () => ({ ...orig(), backend: 'postgres', configured: true, fallback: false, degraded: false });
  assert.equal((await (await req('/health')).json()).storageState, 'ok');
  store.status = () => ({ ...orig(), backend: 'file', configured: true, fallback: true });
  const p2 = await (await req('/health')).json();
  assert.equal(p2.storageState, 'degraded');
  const adm = await (await req('/health', { headers: auth })).json();
  assert.equal(adm.storageDetail.state, 'fallback');
});
