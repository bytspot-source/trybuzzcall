'use strict';
// In-process file/Postgres/provider fakes only: no dotenv, external DB or provider calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { newDb } = require('pg-mem');
const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-shop-storage-'));
Object.assign(process.env, { DATA_DIR: path.join(suiteDir, 'root'), DATABASE_URL: '', SPILL_DIR: '', NODE_ENV: 'test',
  TZ: 'UTC', BUSINESS_TZ: 'UTC', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_PHONE_NUMBER: '',
  STRIPE_SECRET_KEY: '', OPENAI_API_KEY: '', OUTBOUND_MAX_PER_HOUR: '0', OUTBOUND_MAX_PER_DAY: '0' });
const store = require('../src/store');
const context = require('../src/shopContext');
const config = require('../src/config');
const time = require('../src/shopTime');
const booking = require('../src/booking');
const agent = require('../src/agent');
const sms = require('../src/sms');
test.after(async () => { sms.setClient(null); await store.root.close(); fs.rmSync(suiteDir, { recursive: true, force: true }); });
let counter = 0;
function makeShop(t, id, opts = {}) {
  const dir = path.join(suiteDir, `store-${++counter}`);
  const actual = store.createStore({ dir, namespace: id, ...opts });
  t.after(() => actual.close());
  return { id, store: actual, shop: { id, name: id, email: `${id}@example.test`, status: 'active', phoneNumber: '+15550001001' } };
}
function envFor(t, values) {
  const before = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
}
const turn = () => new Promise((r) => setImmediate(r));
function memoryPg() {
  const mem = newDb(), calls = [];
  const { Pool } = mem.adapters.createPg();
  const poolFactory = () => {
    const p = new Pool(), query = p.query.bind(p);
    p.query = (sql, params) => {
      calls.push({ sql, params });
      if (/^CREATE TABLE IF NOT EXISTS/.test(sql)) {
        try { mem.public.getTable('buzz_kv'); return Promise.resolve({ rows: [] }); } catch {}
      }
      return query(sql, params);
    };
    return p;
  };
  return { mem, calls, poolFactory };
}

test('AsyncLocalStorage: concurrent awaits, nesting, errors and extracted facade methods stay scoped', async (t) => {
  const a = makeShop(t, 'shop-a'), b = makeShop(t, 'shop-b');
  const rootBefore = JSON.stringify(store.root.db);
  const { createLead, save, getOverride } = store;
  await Promise.all([a, b].map((c) => context.run(c, async () => {
    assert.equal(context.current(), c);
    assert.equal(context.shopId(), c.id);
    createLead(c.id);
    config.apply({ BUSINESS_NAME: c.id });
    await turn();
    assert.equal(store.db, c.store.db);
    assert.equal(getOverride().values.BUSINESS_NAME, c.id);
    assert.equal(config.env.BUSINESS_NAME, c.id);
    await assert.rejects(context.run(c === a ? b : a, async () => { await turn(); throw new Error('nested failure'); }), /nested failure/);
    assert.equal(context.current(), c);
    assert.throws(() => context.run(c === a ? b : a, () => { throw new Error('sync failure'); }), /sync failure/);
    assert.equal(context.current(), c);
    context.run(null, () => { assert.equal(store.db, store.root.db); assert.equal(context.shopId(), null); });
    save();
    assert.deepEqual(store.db.leads.map((l) => l.phone), [c.id]);
  })));
  await assert.rejects(context.run(a, async () => { await turn(); throw new Error('outer failure'); }), /outer failure/);
  assert.equal(context.current(), null);
  assert.equal(context.shopId(), null);
  assert.equal(store.db, store.root.db);
  assert.equal(JSON.stringify(store.root.db), rootBefore);
  for (const c of [a, b]) {
    const again = store.createStore({ dir: c.store.dataDir(), namespace: c.id });
    assert.deepEqual(again.db.leads.map((l) => l.phone), [c.id]);
    assert.equal(again.getOverride().values.BUSINESS_NAME, c.id);
    await again.close();
  }
});

test('root access is read-only and facade-as-context is rejected without recursion', (t) => {
  const root = store.root, a = makeShop(t, 'root-check');
  assert.equal(store.createStore, root.createStore);
  assert.throws(() => { store.root = a.store; }, TypeError);
  assert.throws(() => Object.defineProperty(store, 'root', { value: a.store }), TypeError);
  context.run(a, () => assert.equal(store.root, root));
  assert.throws(() => context.run({ ...a, store }, () => store.db), /actual store/);
  assert.equal(store.root, root);
});

test('isolated config never inherits legacy owner config; assigned SMS line is authoritative', async (t) => {
  envFor(t, { BUSINESS_NAME: 'Legacy business', OWNER_PHONE: '+15550009999', BUSINESS_TZ: 'Pacific/Honolulu',
    BUSINESS_TYPE: 'nails', STRIPE_CONNECT_ACCOUNT_ID: 'acct_legacy', TWILIO_PHONE_NUMBER: '+15550008888',
    HELP_MESSAGE: 'Legacy owner contact', INACTIVE_MESSAGE: 'Legacy callback', BOOKING_LINK: 'https://legacy.example',
    SLOT_STEP_MINUTES: '15', LEAD_FEE: '99', BILLING_PORTAL_RETURN_URL: 'https://legacy.example/billing', PUBLIC_BASE_URL: 'https://platform.example' });
  store.root.setOverride({ values: { BUSINESS_NAME: 'Root override' } });
  t.after(() => store.root.setOverride({}));
  const a = makeShop(t, 'config-a'), b = makeShop(t, 'config-b');
  b.shop.phoneNumber = null;
  await Promise.all([a, b].map((c) => context.run(c, async () => {
    for (const k of config.KEYS.filter((k) => k !== 'BUSINESS_TZ')) assert.equal(config.env[k], undefined, k);
    for (const k of ['STRIPE_CONNECT_ACCOUNT_ID', 'BILLING_PORTAL_RETURN_URL', 'TZ']) assert.equal(config.env[k], undefined, k);
    assert.equal(config.env.BUSINESS_TZ, 'America/New_York');
    assert.equal(agent.parseDay('today', new Date('2026-03-08T06:00:00Z')).toISOString(), '2026-03-08T05:00:00.000Z');
    c.store.setOverride({ values: { TWILIO_PHONE_NUMBER: '+15550007777' } });
    assert.equal(config.env.TWILIO_PHONE_NUMBER, c.shop.phoneNumber || undefined);
    assert.equal(config.env.PUBLIC_BASE_URL, 'https://platform.example');
    assert.equal(config.env.STRIPE_SECRET_KEY, '');
    assert.ok(config.effective().every((v) => v.source === 'default'));
    config.apply({ BUSINESS_NAME: c.id, BUSINESS_TZ: 'America/Los_Angeles' });
    await turn();
    assert.equal(config.env.BUSINESS_NAME, c.id);
    assert.equal(process.env.TZ, 'UTC');
    config.clear();
    assert.equal(config.env.BUSINESS_NAME, undefined);
    assert.equal(process.env.TZ, 'UTC');
  })));
  assert.equal(config.env.BUSINESS_NAME, 'Root override');
  assert.equal(config.env.OWNER_PHONE, '+15550009999');
  assert.equal(config.env.STRIPE_CONNECT_ACCOUNT_ID, 'acct_legacy');
});

test('namespace validation refuses path/SQL input and refuses unsafe file fallback', (t) => {
  for (const namespace of ['', '../other', "x' OR 1=1", 'x/y', 'x'.repeat(81), null, 123]) {
    assert.throws(() => store.createStore({ dir: path.join(suiteDir, 'invalid'), namespace }), /namespace/);
  }
  assert.throws(() => store.createStore({ namespace: 'no-dir' }), /data directory/);
  const c = makeShop(t, '12345678-abcd-4321-ABCD_0123456789ab');
  assert.equal(c.store.backend(), 'file');
});

test('Postgres namespace persistence, scoped config deletion and root legacy keys are independent', async (t) => {
  const pg = memoryPg(), options = { databaseUrl: 'postgres://localhost/test', poolFactory: pg.poolFactory };
  const a = makeShop(t, 'pg-a', options), b = makeShop(t, 'pg-b', options);
  const root = store.createStore({ dir: path.join(suiteDir, `pg-root-${++counter}`), ...options });
  t.after(() => root.close());
  // Deliberately initialize/mutate an actual store while a different shop is active.
  await context.run(b, async () => {
    for (const s of [root, a.store, b.store]) assert.equal((await s.init()).backend, 'postgres');
    root.createLead('root'); a.store.createLead('a'); b.store.createLead('b');
    root.setOverride({ values: { BUSINESS_NAME: 'root' } });
    a.store.setOverride({ values: { BUSINESS_NAME: 'a' } });
    b.store.setOverride({ values: { BUSINESS_NAME: 'b' } });
    await Promise.all([root, a.store, b.store].map((s) => s.flush()));
  });
  const a2 = makeShop(t, 'pg-a', options), b2 = makeShop(t, 'pg-b', options);
  await a2.store.init(); await b2.store.init();
  assert.deepEqual(a2.store.db.leads.map((l) => l.phone), ['a']);
  assert.deepEqual(b2.store.db.leads.map((l) => l.phone), ['b']);
  assert.equal(a2.store.getOverride().values.BUSINESS_NAME, 'a');
  assert.equal(b2.store.getOverride().values.BUSINESS_NAME, 'b');
  a2.store.setOverride({}); await a2.store.flush();
  const a3 = makeShop(t, 'pg-a', options); await a3.store.init();
  assert.deepEqual(a3.store.getOverride(), {});
  const rows = Object.fromEntries(pg.mem.public.many('SELECT key, value FROM buzz_kv').map((r) => [r.key, r.value]));
  assert.equal(rows.db.leads[0].phone, 'root');
  assert.equal(rows.config.values.BUSINESS_NAME, 'root');
  assert.equal(rows['shop:pg-b:config'].values.BUSINESS_NAME, 'b');
  assert.equal(rows['shop:pg-a:config'], undefined);
  assert.ok(pg.calls.some((c) => /WHERE key IN \(\$1, \$2\)/.test(c.sql) && c.params[0] === 'shop:pg-a:db'));
  for (const c of pg.calls) assert.ok(!c.sql.includes('shop:pg-'), 'namespace must be a SQL parameter');
});

test('same caller opt-outs and bot pauses are isolated and persisted to the actual file store', async (t) => {
  const a = makeShop(t, 'opt-a'), b = makeShop(t, 'opt-b'), phone = '+15550002002';
  await context.run(a, async () => { store.createLead(phone); await store.optOut(phone, 'test'); store.pauseBot(phone, 'possible stop'); });
  context.run(b, () => { assert.equal(store.isOptedOut(phone), false); assert.equal(store.isPaused(phone), false); });
  assert.equal(a.store.isOptedOut(phone), true);
  assert.equal(a.store.db.leads[0].status, 'opted_out');
  const again = store.createStore({ dir: a.store.dataDir(), namespace: a.id });
  assert.equal(again.isOptedOut(phone), true); assert.equal(again.isPaused(phone), true);
  await again.close();
  context.run(a, () => { assert.equal(store.optIn(phone), true); assert.equal(store.resumeBot(phone), true); });
  assert.equal(b.store.isOptedOut(phone), false);
});

test('shared SPILL_DIR writes/replays only the matching namespace, even during PG failure', async (t) => {
  const spillBase = path.join(suiteDir, `spills-${++counter}`);
  envFor(t, { SPILL_DIR: spillBase });
  const pg = memoryPg(); let fail = false;
  const poolFactory = () => {
    const p = pg.poolFactory(), query = p.query.bind(p);
    p.query = (sql, params) => fail && /^INSERT INTO/.test(sql) ? Promise.reject(new Error('simulated outage')) : query(sql, params);
    return p;
  };
  const opts = { databaseUrl: 'postgres://localhost/test', poolFactory };
  const a = makeShop(t, 'spill-a', opts), b = makeShop(t, 'spill-b', opts);
  await a.store.init(); await b.store.init(); fail = true;
  await Promise.all([
    context.run(a, () => store.optOut('+15550003001', 'test')),
    context.run(b, () => store.optOut('+15550003002', 'test')),
  ]);
  const readSpill = (id) => fs.readFileSync(path.join(spillBase, id, 'optout-spill.jsonl'), 'utf8');
  assert.match(readSpill(a.id), /15550003001/); assert.doesNotMatch(readSpill(a.id), /15550003002/);
  assert.match(readSpill(b.id), /15550003002/); assert.doesNotMatch(readSpill(b.id), /15550003001/);
  assert.equal(fs.existsSync(path.join(spillBase, 'optout-spill.jsonl')), false);
  // File fallback replays only its own spill; an unrelated shop cannot consume it.
  const other = makeShop(t, 'spill-other'); await other.store.init();
  assert.equal(other.store.isOptedOut('+15550003001'), false);
  assert.equal(fs.existsSync(path.join(spillBase, a.id, 'optout-spill.jsonl')), true);
  const a2 = makeShop(t, 'spill-a'); await a2.store.init();
  assert.equal(a2.store.isOptedOut('+15550003001'), true);
  assert.equal(a2.store.isOptedOut('+15550003002'), false);
  assert.equal(fs.existsSync(path.join(spillBase, b.id, 'optout-spill.jsonl')), true);
  fail = false; await Promise.all([a.store.flush(), b.store.flush()]);
});

test('parallel SMS operations use assigned senders, scoped logs and scoped provider opt-outs', async (t) => {
  const a = makeShop(t, 'sms-a'), b = makeShop(t, 'sms-b'), unassigned = makeShop(t, 'sms-none');
  b.shop.phoneNumber = '+15550001002'; unassigned.shop.phoneNumber = null;
  const calls = [], phone = '+15550004001';
  const rootLog = path.join(store.root.dataDir(), 'sms.log');
  const rootBefore = fs.existsSync(rootLog) ? fs.readFileSync(rootLog, 'utf8') : null;
  sms.resetCap();
  sms.setClient({ messages: { create: async (p) => {
    calls.push(p); await turn();
    if (p.body === 'A provider optout') throw Object.assign(new Error('unsubscribed'), { code: 21610 });
    return { sid: 'fake-message' };
  } } });
  t.after(() => sms.setClient(null));
  const result = await Promise.all([
    context.run(a, () => sms.sendSms(phone, 'A private message')),
    context.run(b, () => sms.sendSms(phone, 'B private message')),
    context.run(unassigned, () => sms.sendSms(phone, 'Must not be logged or sent', { force: true })),
  ]);
  assert.equal(result[0].ok, true); assert.equal(result[1].ok, true); assert.equal(result[2].skipped, 'no_sender');
  assert.deepEqual(calls.map((c) => c.from), [a.shop.phoneNumber, b.shop.phoneNumber]);
  const log = (c) => fs.readFileSync(path.join(c.store.dataDir(), 'sms.log'), 'utf8');
  assert.match(log(a), /A private message/); assert.doesNotMatch(log(a), /B private message/);
  assert.match(log(b), /B private message/); assert.doesNotMatch(log(b), /A private message/);
  assert.equal(fs.existsSync(path.join(unassigned.store.dataDir(), 'sms.log')), false);
  const rejected = await context.run(a, () => sms.sendSms(phone, 'A provider optout'));
  assert.equal(rejected.code, 21610);
  assert.equal(a.store.isOptedOut(phone), true); assert.equal(b.store.isOptedOut(phone), false);
  assert.equal((await context.run(a, () => sms.sendSms(phone, 'blocked'))).skipped, 'opted_out');
  assert.equal((await context.run(b, () => sms.sendSms(phone, 'B still allowed'))).ok, true);
  a.shop.phoneNumber = '+15550001003';
  await context.run(a, () => sms.sendSms('+15550004002', 'New assigned line'));
  assert.equal(calls.at(-1).from, '+15550001003');
  assert.equal(fs.existsSync(rootLog) ? fs.readFileSync(rootLog, 'utf8') : null, rootBefore);
  // Preserve the existing setClient test seam even with no legacy sender env.
  assert.equal((await sms.sendSms('+15550004003', 'Root fake-client message')).ok, true);
  assert.match(fs.readFileSync(rootLog, 'utf8'), /Root fake-client message/);
  assert.doesNotMatch(log(a), /Root fake-client message/);
  assert.doesNotMatch(log(b), /Root fake-client message/);
});

test('parallel timezone parsing, calendar days, slot instants and labels do not mutate process TZ', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-03-07T12:00:00Z'));
  const a = makeShop(t, 'tz-east'), b = makeShop(t, 'tz-west');
  const cases = [[a, 'America/New_York', '2026-03-08T05:00:00.000Z', '2026-03-08T13:00:00.000Z'],
    [b, 'America/Los_Angeles', '2026-03-08T08:00:00.000Z', '2026-03-08T16:00:00.000Z']];
  await Promise.all(cases.map(([c, zone, midnight, firstSlot]) => context.run(c, async () => {
    config.apply({ BUSINESS_TZ: zone, BUSINESS_HOURS: '09:00-12:00', BUSINESS_DAYS: '0,1,2,3,4,5,6', SLOT_MINUTES: '60' });
    await turn();
    const tomorrow = agent.parseDay('tomorrow', new Date('2026-03-07T12:00:00Z'));
    assert.equal(tomorrow.toISOString(), midnight);
    assert.equal(agent.parseDay('Sunday', new Date('2026-03-07T12:00:00Z')).toISOString(), midnight);
    const slots = booking.nextSlots(2, { from: tomorrow });
    assert.equal(slots[0].start, firstSlot);
    assert.match(slots[0].label, /Sun, Mar 8 9:00 AM-10:00 AM/);
    assert.equal(time.sameDay(new Date(firstSlot), tomorrow), true);
    assert.equal(time.sameDay(new Date(midnight).getTime() - 1, tomorrow), false);
    assert.equal(process.env.TZ, 'UTC');
  })));
  const edge = new Date('2026-03-08T06:00:00Z');
  assert.equal(context.run(a, () => agent.parseDay('today', edge).toISOString()), '2026-03-08T05:00:00.000Z');
  assert.equal(context.run(b, () => agent.parseDay('today', edge).toISOString()), '2026-03-07T08:00:00.000Z');
});

test('DST gaps are skipped, folds are deterministic and nonexistent calendar dates are rejected', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-03-07T12:00:00Z'));
  const a = makeShop(t, 'dst');
  context.run(a, () => {
    config.apply({ BUSINESS_TZ: 'America/New_York', BUSINESS_HOURS: '01:00-04:00', BUSINESS_DAYS: '0', SLOT_MINUTES: '30' });
    const from = agent.parseDay('3/8', new Date('2026-03-07T12:00:00Z'));
    const slots = booking.nextSlots(4, { from });
    assert.deepEqual(slots.map((s) => s.start), ['2026-03-08T06:00:00.000Z', '2026-03-08T06:30:00.000Z', '2026-03-08T07:00:00.000Z', '2026-03-08T07:30:00.000Z']);
    assert.ok(slots.every((s) => time.parts(s.start).day === 8 && time.parts(s.start).hour !== 2));
    assert.equal(time.toInstant({ year: 2026, month: 3, day: 8 }, 150), null);
    assert.equal(time.toInstant({ year: 2026, month: 11, day: 1 }, 90).toISOString(), '2026-11-01T05:30:00.000Z');
    assert.equal(agent.parseDay('2/30', new Date('2026-01-01T12:00:00Z')), null);
    // A real 90-minute appointment starting at 01:00 ends at 03:30 after the gap,
    // so a 03:00 closing time must not offer it.
    config.apply({ BUSINESS_TZ: 'America/New_York', BUSINESS_HOURS: '01:00-03:00', BUSINESS_DAYS: '0', SLOT_MINUTES: '90' });
    assert.ok(booking.nextSlots(1, { from })[0].start.startsWith('2026-03-15'));
  });
  assert.equal(time.toInstant({ year: 2011, month: 12, day: 30 }, 540, 'Pacific/Apia'), null, 'skipped local date must not roll to another day');
  assert.equal(process.env.TZ, 'UTC');
});

test('root legacy env timezone behavior and file persistence remain available outside a context', async (t) => {
  envFor(t, { BUSINESS_TZ: 'UTC', BUSINESS_NAME: 'Legacy root' });
  assert.equal(context.current(), null);
  store.setOverride({});
  store.createLead('legacy-root');
  config.apply({ BUSINESS_NAME: 'Legacy applied', BUSINESS_TZ: 'UTC' });
  assert.equal(store.root.getOverride().values.BUSINESS_NAME, 'Legacy applied');
  assert.equal(agent.parseDay('tomorrow', new Date('2026-03-07T23:30:00Z')).toISOString(), '2026-03-08T00:00:00.000Z');
  const again = store.createStore({ dir: store.root.dataDir() });
  assert.ok(again.db.leads.some((l) => l.phone === 'legacy-root'));
  assert.equal(again.getOverride().values.BUSINESS_NAME, 'Legacy applied');
  await again.close();
  config.clear();
  assert.equal(config.env.BUSINESS_NAME, 'Legacy root');
});
