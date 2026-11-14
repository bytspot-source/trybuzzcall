'use strict';
// Written SMS permission ledger (src/smsPermission.js) against the real store (src/store.js) in temporary
// directories. Grants come only from grant(); calls, inbound texts, START and legacy data never create one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-ledger-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['SMS_ENABLED', 'SMS_CONSENT_BUSINESS_ID', 'TWILIO_PHONE_NUMBER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'DATABASE_URL', 'RENDER', 'SPILL_DIR']) delete process.env[k];
Object.assign(process.env, { DATA_DIR: path.join(base, 'root'), NODE_ENV: 'test', TZ: 'UTC' });
const store = require('../src/store');
const shopContext = require('../src/shopContext');
const smsPermission = require('../src/smsPermission');
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const PHONE = '+14155550101', OTHER = '+14155550102', SENDER = '+14155550100';
const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const plain = (value) => JSON.parse(JSON.stringify(value));
// One store directory per test; restart() reopens the same directory as a new process would.
const clocks = new WeakSet();
function harness(t, { initial } = {}) {
  if (!clocks.has(t)) { t.mock.timers.enable({ apis: ['Date'], now: NOW }); clocks.add(t); }
  const dir = fs.mkdtempSync(path.join(base, 'shop-'));
  if (initial !== undefined) fs.writeFileSync(path.join(dir, 'db.json'), typeof initial === 'string' ? initial : JSON.stringify(initial));
  const h = { dir, business: 'shop-1', sender: SENDER };
  h.open = () => { h.store = store.createStore({ dir, namespace: 'ledger' }); return h.store; };
  h.run = (fn) => shopContext.run({ id: h.business, store: h.store, shop: { id: h.business, phoneNumber: h.sender, status: 'active' } }, fn);
  for (const name of ['check', 'grant', 'revoke', 'providerOptIn', 'snapshot', 'status', 'recover', 'close', 'configuration']) {
    h[name] = (...args) => h.run(() => smsPermission[name](...args));
  }
  h.check = (phone = PHONE, purpose = 'customer_service') => h.run(() => smsPermission.check(phone, purpose));
  h.restart = async ({ crash = false } = {}) => { if (!crash) await h.close(); h.open(); };
  h.tick = (ms = 1000) => t.mock.timers.tick(ms);
  h.now = () => new Date().toISOString();
  h.evidence = (purpose = 'customer_service', phone = PHONE) => ({ phone, purpose, consentedAt: new Date(Date.now() - 1000).toISOString(),
    disclosureVersion: 'sms-v1', evidenceRef: 'written-form/123' });
  h.file = () => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  h.open();
  return h;
}
// Temporarily replaces an fs function used by the store's atomic writer.
function breakFs(t, name, fn = () => { throw new Error('disk failed'); }) {
  const original = fs[name];
  fs[name] = fn;
  const restore = () => { fs[name] = original; };
  t.after(restore);
  return restore;
}
const denied = (h, phone = PHONE, purpose = 'customer_service', reason = 'consent_required') =>
  assert.deepEqual(plain(h.check(phone, purpose)), { allowed: false, reason });
const rejects = (promise, status) => assert.rejects(promise, (e) => e.status === status);

test('legacy leads, messages, press-1 records and arbitrary consent flags never grant either purpose', (t) => {
  const h = harness(t, { initial: { leads: [{ phone: PHONE, consent: true, messages: [{ dir: 'in', body: 'START' }] }],
    optedIn: [PHONE], smsConsent: { [PHONE]: true },
    voiceConsents: [{ callSid: 'CA1', from: PHONE, digits: '1', consented: true, state: 'accepted', shopId: 'legacy' }] } });
  denied(h); denied(h, PHONE, 'owner_alerts');
  assert.deepEqual(plain(h.snapshot()), []);
  assert.deepEqual(plain(h.store.db.smsPermissions), []);
  assert.equal(h.file().voiceConsents.length, 1, 'old evidence is left untouched, never migrated');
});

test('strict E.164 and stable business/sender configuration, with no coercion', async (t) => {
  const h = harness(t);
  for (const phone of [PHONE, '+12', '+123456789012345']) assert.equal(smsPermission.validPhone(phone), true);
  for (const phone of [undefined, null, 14155550101, {}, [], new String(PHONE), true,
    '+1', '+0123', '14155550101', ` ${PHONE}`, `${PHONE}\n`, '+1234567890123456',
    { toString() { throw new Error('must not coerce'); } }]) {
    assert.equal(smsPermission.validPhone(phone), false);
    denied(h, phone === undefined ? null : phone, 'customer_service', 'invalid_phone');
  }
  assert.deepEqual(plain(h.configuration()), { businessId: 'shop-1', sender: SENDER });
  for (const invalid of ['_bad', '-bad', '__proto__', 'bad space', 'shop\n', 'a'.repeat(65)]) {
    h.business = invalid;
    assert.equal(h.configuration(), null);
    denied(h, PHONE, 'customer_service', 'consent_not_configured');
    await rejects(h.grant(h.evidence()), 409);
    assert.deepEqual(plain(h.snapshot()), []);
  }
  for (const valid of ['a', 'A_1-b', 'a'.repeat(64), 'constructor', 'toString']) {
    h.business = valid;
    assert.equal(h.configuration().businessId, valid);
  }
  h.business = 'shop-1'; h.sender = 'not-e164';
  assert.equal(h.configuration(), null);
  h.sender = null;
  assert.equal(h.configuration(), null, 'an unassigned vendor line has no scope');
  h.sender = SENDER;
  assert.notEqual(h.configuration(), null);
});

test('the legacy line needs SMS_CONSENT_BUSINESS_ID and TWILIO_PHONE_NUMBER; request input never picks the scope', (t) => {
  t.after(() => { delete process.env.SMS_CONSENT_BUSINESS_ID; delete process.env.TWILIO_PHONE_NUMBER; });
  const legacy = () => shopContext.run(null, () => smsPermission.configuration());
  process.env.TWILIO_PHONE_NUMBER = SENDER;
  assert.equal(legacy(), null, 'missing business id denies');
  shopContext.run(null, () => denied({ check: (p, u) => smsPermission.check(p, u) }, PHONE, 'customer_service', 'consent_not_configured'));
  for (const id of ['', ' shop', 'Shop Name With Spaces', '__proto__']) { process.env.SMS_CONSENT_BUSINESS_ID = id; assert.equal(legacy(), null, id); }
  process.env.SMS_CONSENT_BUSINESS_ID = 'peach-state';
  assert.deepEqual(plain(legacy()), { businessId: 'peach-state', sender: SENDER });
  process.env.TWILIO_PHONE_NUMBER = '';
  assert.equal(legacy(), null, 'missing sender denies');
});

test('grants are explicit per purpose and scoped to business, sender and recipient', async (t) => {
  const h = harness(t);
  const granted = await h.grant(h.evidence());
  assert.equal(h.check().allowed, true);
  denied(h, PHONE, 'owner_alerts'); denied(h, OTHER);
  assert.equal(granted.businessId, 'shop-1');
  assert.equal(granted.sender, SENDER); assert.equal(granted.phone, PHONE);
  assert.equal(granted.events[0].method, 'admin');
  assert.equal(granted.events[0].evidenceRef, 'written-form/123');
  assert.equal(granted.events[0].disclosureVersion, 'sms-v1');
  await h.grant(h.evidence('owner_alerts'));
  assert.equal(h.check(PHONE, 'owner_alerts').allowed, true);
  h.business = 'shop-2';
  denied(h); assert.deepEqual(plain(h.snapshot()), []);
  await h.grant(h.evidence());
  h.sender = OTHER;
  denied(h); assert.deepEqual(plain(h.snapshot()), []);
  await h.grant(h.evidence('owner_alerts'));
  assert.equal(h.snapshot().length, 1);
  denied(h); assert.equal(h.check(PHONE, 'owner_alerts').allowed, true);
  h.business = 'shop-1'; h.sender = SENDER;
  assert.equal(h.snapshot().length, 1);
  assert.equal(h.snapshot()[0].events.length, 2);
  assert.equal(h.check().allowed, true);
  assert.equal(h.store.db.smsPermissions.length, 3);
});

test('grant validates purpose, strict ISO dates, bounded non-secret evidence, and future timestamps', async (t) => {
  const h = harness(t), good = h.evidence();
  const invalid = [null, {}, { ...good, extra: true }, { ...good, phone: {} }, { ...good, businessId: 'other' }, { ...good, sender: OTHER },
    ...[undefined, null, '', '__proto__', 'constructor', 'marketing', {}, ['customer_service']].map((purpose) => ({ ...good, purpose })),
    ...['2026-02-30T12:00:00Z', '2025-02-29T12:00:00Z', '2026-10-22', '2026-10-22T12:00:00',
      '2026-10-22T24:00:00Z', '2026-10-22T12:00:60Z', '2026-10-22T12:00:00+24:00',
      '2026-10-22T12:00:01Z', 123, {}].map((consentedAt) => ({ ...good, consentedAt })),
    ...['', ' ', 'a'.repeat(129), {}, 'bad\nvalue'].map((disclosureVersion) => ({ ...good, disclosureVersion })),
    ...['', ' ', 'a'.repeat(513), {}, 'bad\u0000value', 'https://drive.example.com/form.pdf', 'see www.example.com/x',
      'token=abc123', 'password: hunter2', 'api_key=xyz'].map((evidenceRef) => ({ ...good, evidenceRef }))];
  for (const value of invalid) await rejects(h.grant(value), 400);
  for (const purpose of ['__proto__', 'constructor', {}, null]) denied(h, PHONE, purpose, 'invalid_purpose');
  assert.deepEqual(plain(h.store.db.smsPermissions || []), []);
  const record = await h.grant({ ...good, consentedAt: '2026-10-22T13:59:59+02:00' });
  assert.equal(record.events[0].consentedAt, '2026-10-22T11:59:59.000Z');
});

test('global revocation preserves history, revokes both purposes and requires strictly newer evidence', async (t) => {
  const h = harness(t);
  await h.grant(h.evidence()); await h.grant(h.evidence('owner_alerts'));
  const revoked = await h.revoke(PHONE);
  assert.equal(revoked.events.length, 3);
  assert.equal(revoked.events[2].method, 'admin');
  denied(h); denied(h, PHONE, 'owner_alerts');
  assert.equal(h.store.isOptedOut(PHONE), true, 'revocations are mirrored in db.optOuts');
  await rejects(h.grant(h.evidence()), 409);
  await rejects(h.grant({ ...h.evidence(), consentedAt: h.now() }), 409);
  h.tick(2000);
  await h.grant(h.evidence());
  assert.equal(h.check().allowed, true);
  assert.equal(h.store.isOptedOut(PHONE), false, 'fresh written consent after the revocation lifts the local opt-out');
  denied(h, PHONE, 'owner_alerts');
  assert.equal(h.snapshot()[0].events.length, 4);
});

test('existing db.optOuts stay suppressed; a provider-sourced opt-out must be cleared before a fresh grant', async (t) => {
  const h = harness(t, { initial: { optOuts: { [PHONE]: { at: '2026-10-01T00:00:00.000Z', source: 'keyword' }, [OTHER]: { at: '2026-10-22T11:59:00.000Z', source: 'message' } } } });
  denied(h); denied(h, OTHER);
  await rejects(h.grant(h.evidence()), 409);
  await rejects(h.grant({ ...h.evidence('customer_service', OTHER), consentedAt: '2026-10-22T11:58:00.000Z' }), 409);
  await h.grant(h.evidence('customer_service', OTHER));
  assert.equal(h.check(OTHER).allowed, true, 'a non-provider opt-out yields to newer written consent');
  await h.providerOptIn(PHONE, { messageSid: 'start-legacy' });
  assert.equal(h.store.isOptedOut(PHONE), false);
  denied(h, PHONE, 'customer_service', 'consent_required');
  await h.grant(h.evidence());
  assert.equal(h.check().allowed, true);
});

test('provider START is never consent and cannot restore grants after STOP', async (t) => {
  const h = harness(t);
  await h.providerOptIn(PHONE, { messageSid: 'start-initial' });
  denied(h); denied(h, PHONE, 'owner_alerts');
  await h.grant(h.evidence()); await h.grant(h.evidence('owner_alerts'));
  await h.revoke(PHONE, { method: 'STOP', messageSid: 'stop-1', providerBlocked: true });
  denied(h, PHONE, 'customer_service', 'provider_blocked');
  h.tick(2000);
  await rejects(h.grant(h.evidence()), 409);
  // An admin revoke is not a provider unblock.
  await h.revoke(PHONE);
  assert.equal(h.snapshot()[0].providerBlocked, true);
  await h.providerOptIn(PHONE, { messageSid: 'start-1' });
  assert.equal(h.snapshot()[0].providerBlocked, false);
  denied(h); denied(h, PHONE, 'owner_alerts');
  h.tick(2000);
  await h.grant(h.evidence('owner_alerts'));
  denied(h); assert.equal(h.check(PHONE, 'owner_alerts').allowed, true);
});

test('MessageSid duplicates are no-ops even when replaying an old START after a later STOP and restart', async (t) => {
  const h = harness(t);
  await h.providerOptIn(PHONE, { messageSid: 'start-old' });
  const once = plain(h.snapshot());
  await h.providerOptIn(PHONE, { messageSid: 'start-old' });
  assert.deepEqual(plain(h.snapshot()), once);
  h.tick();
  await h.revoke(PHONE, { messageSid: 'stop-new', providerBlocked: true });
  await h.restart();
  const before = plain(h.snapshot());
  await h.providerOptIn(PHONE, { messageSid: 'start-old' });
  await h.revoke(PHONE, { messageSid: 'stop-new', providerBlocked: false });
  // Deduplication covers SID reuse across different event kinds too.
  await h.providerOptIn(PHONE, { messageSid: 'stop-new' });
  assert.deepEqual(plain(h.snapshot()), before);
  denied(h, PHONE, 'customer_service', 'provider_blocked');
  await h.providerOptIn(PHONE, { messageSid: 'start-new' });
  h.tick(2000); await h.grant(h.evidence());
  await h.revoke(PHONE, { messageSid: 'stop-new', providerBlocked: true });
  assert.equal(h.check().allowed, true);
});

test('MessageSid deduplication namespaces include business, sender and recipient', async (t) => {
  const h = harness(t);
  for (const [business, sender, phone] of [
    ['shop-1', SENDER, PHONE], ['shop-2', SENDER, PHONE],
    ['shop-1', OTHER, PHONE], ['shop-1', SENDER, OTHER],
  ]) {
    h.business = business; h.sender = sender;
    await h.revoke(phone, { messageSid: '__proto__', providerBlocked: true });
    assert.equal(h.snapshot().find((r) => r.phone === phone).events.length, 1);
    denied(h, phone, 'owner_alerts', 'provider_blocked');
  }
  assert.equal(h.store.db.smsPermissions.length, 4);
});

test('events are immutable internally and returned records/snapshots are detached', async (t) => {
  const h = harness(t);
  const returned = await h.grant(h.evidence());
  returned.events[0].purpose = 'owner_alerts'; returned.events.push({ type: 'revoke' });
  returned.permissions.owner_alerts = returned.permissions.customer_service;
  const snapshot = h.snapshot(); snapshot[0].events.length = 0;
  assert.equal(h.check().allowed, true); denied(h, PHONE, 'owner_alerts');
  assert.equal(Object.isFrozen(h.store.db.smsPermissions[0].events[0]), true);
  assert.equal(h.snapshot()[0].events.length, 1);
});

test('persist first, then expose grants: an atomic temp-file write and rename precede visibility', async (t) => {
  const h = harness(t);
  h.check(); // this session's unclean marker
  const operations = [];
  const write = fs.writeFileSync, rename = fs.renameSync;
  const restoreWrite = breakFs(t, 'writeFileSync', (file, data, options) => { operations.push(['write', file, options]); return write(file, data, options); });
  const restoreRename = breakFs(t, 'renameSync', (from, to) => { operations.push(['rename', from, to, h.check().allowed]); return rename(from, to); });
  await h.grant(h.evidence());
  restoreWrite(); restoreRename();
  assert.equal(h.check().allowed, true);
  assert.equal(operations[0][0], 'write');
  assert.notEqual(operations[0][1], path.join(h.dir, 'db.json'));
  assert.equal(operations[0][2].mode, 0o600);
  assert.equal(operations[0][2].flag, 'wx');
  assert.deepEqual(operations[1], ['rename', operations[0][1], path.join(h.dir, 'db.json'), false], 'still denied while the rename runs');
  assert.deepEqual(fs.readdirSync(h.dir).filter((f) => f.endsWith('.tmp')), []);
  h.store.createLead(OTHER); h.store.addAlert({ to: OTHER });
  assert.equal(h.store.findOpenLead(OTHER).phone, OTHER);
  await h.restart();
  assert.equal(h.check().allowed, true);
  assert.equal(h.store.db.leads.length, 1);
});

test('failed writes and failed renames never authorize; the original database survives', async (t) => {
  for (const failure of ['writeFileSync', 'renameSync']) {
    const h = harness(t);
    h.check();
    const before = fs.readFileSync(path.join(h.dir, 'db.json'), 'utf8');
    const restore = breakFs(t, failure);
    await rejects(h.grant(h.evidence()), 409);
    restore();
    assert.equal(h.store.db.smsPermissions.length, 0);
    denied(h);
    assert.equal(fs.readFileSync(path.join(h.dir, 'db.json'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(h.dir).filter((f) => f.endsWith('.tmp')), []);
    await h.restart();
    denied(h);
    assert.deepEqual(plain(h.status()), { recoveryRequired: false, persistenceFailed: false });
  }
});

test('a failed revocation blocks all sends in the running process instead of leaving old grants usable', async (t) => {
  const h = harness(t);
  await h.grant(h.evidence()); await h.grant(h.evidence('customer_service', OTHER));
  const restore = breakFs(t, 'renameSync');
  await rejects(h.revoke(PHONE), 409);
  restore();
  denied(h, PHONE, 'customer_service', 'consent_unavailable');
  denied(h, OTHER, 'customer_service', 'consent_unavailable');
  assert.equal(h.store.isOptedOut(PHONE), true, 'suppressed in memory at once');
  await rejects(h.grant(h.evidence()), 409);
});

test('failed suppression retries are durable; a crash cannot restore the older grant', async (t) => {
  for (const failure of ['writeFileSync', 'renameSync']) {
    const h = harness(t);
    await h.grant(h.evidence()); await h.grant(h.evidence('owner_alerts'));
    assert.equal(h.file().smsSessionClean, false);
    const restore = breakFs(t, failure);
    await rejects(h.revoke(PHONE, { messageSid: 'failed-stop' }), 409);
    assert.equal(h.snapshot()[0].permissions.customer_service, null);
    assert.equal(await h.close(), false);
    restore();
    // The same delivery may be retried without losing its original suppression timestamp.
    await h.revoke(PHONE, { messageSid: 'failed-stop' });
    denied(h, PHONE, 'customer_service', 'consent_unavailable');
    await h.restart();
    assert.equal(h.status().recoveryRequired, true, 'a failed write never ends in a clean session');
    assert.equal(h.snapshot()[0].events.filter((e) => e.messageSid === 'failed-stop').length, 1);
    assert.deepEqual(h.snapshot()[0].permissions, { customer_service: null, owner_alerts: null });
  }
  const h = harness(t);
  await h.grant(h.evidence());
  const restore = breakFs(t, 'renameSync');
  await rejects(h.revoke(PHONE), 409);
  restore();
  await h.restart({ crash: true });
  denied(h, PHONE, 'customer_service', 'consent_unavailable');
  assert.equal(h.status().recoveryRequired, true);
  await rejects(h.grant(h.evidence()), 409);
  await rejects(h.recover('skip-review'), 400);
  process.env.SMS_ENABLED = '1';
  t.after(() => { delete process.env.SMS_ENABLED; });
  await rejects(h.recover('suppression_history_reviewed'), 409);
  // Operator reconciles the missed opt-out while quarantined, then explicitly recovers with SMS off.
  await h.revoke(PHONE);
  process.env.SMS_ENABLED = '0';
  assert.deepEqual(plain(await h.recover('suppression_history_reviewed')), { recoveryRequired: false, persistenceFailed: false });
  denied(h, PHONE, 'customer_service', 'consent_required');
  await h.restart();
  denied(h, PHONE, 'customer_service', 'consent_required');
});

test('the session marker is persisted on first use; an invalid marker or failed marker write fails closed', async (t) => {
  const h = harness(t);
  assert.equal(fs.existsSync(path.join(h.dir, 'db.json')), false);
  assert.deepEqual(plain(await smsPermission.open(h.store)), { recoveryRequired: false, persistenceFailed: false });
  assert.equal(h.file().smsSessionClean, false, 'marker saved before any traffic');
  const broken = harness(t);
  const restore = breakFs(t, 'renameSync');
  await assert.rejects(smsPermission.open(broken.store), /Unable to persist/);
  restore();
  denied(broken, PHONE, 'customer_service', 'consent_unavailable');
  await rejects(broken.grant(broken.evidence()), 409);
  const bad = harness(t, { initial: { smsSessionClean: 'true' } });
  await assert.rejects(smsPermission.open(bad.store), /Invalid SMS permission history/);
  denied(bad, PHONE, 'customer_service', 'consent_unavailable');
});

test('existing corrupt or unreadable databases fail store startup; only ENOENT is new', (t) => {
  for (const initial of ['', '{', 'null', '[]', 'false', '{"leads":{}}', '{"billing":[]}', '{"smsPermissions":null}']) {
    const dir = fs.mkdtempSync(path.join(base, 'corrupt-'));
    fs.writeFileSync(path.join(dir, 'db.json'), initial);
    assert.throws(() => store.createStore({ dir, namespace: 'corrupt' }), /Invalid database/);
    assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), initial, 'never overwritten');
  }
  const unreadable = fs.mkdtempSync(path.join(base, 'unreadable-'));
  fs.mkdirSync(path.join(unreadable, 'db.json'));
  assert.throws(() => store.createStore({ dir: unreadable, namespace: 'unreadable' }), /Unable to read database/);
  const fresh = harness(t);
  assert.deepEqual(plain(fresh.store.db.optOuts), {});
});

test('malformed persisted permission data, duplicate scopes and impossible grants fail closed', async (t) => {
  const baseline = harness(t);
  await baseline.grant(baseline.evidence());
  const good = baseline.file().smsPermissions[0];
  const withEvent = (event) => [{ ...plain(good), events: [event] }];
  const grant = good.events[0];
  const invalid = [
    {}, [null], [{ ...good, businessId: '__proto__' }], [{ ...good, phone: {} }],
    [{ ...good, sender: '123' }], [{ ...good, events: {} }], [good, good],
    [{ ...good, permissions: { owner_alerts: true } }],
    withEvent({ ...grant, purpose: '__proto__' }), withEvent({ ...grant, method: 'voice' }),
    withEvent({ ...grant, evidenceRef: '' }), withEvent({ ...grant, at: 'not-a-date' }),
    withEvent({ ...grant, at: '2099-01-01T00:00:00Z' }),
    withEvent({ ...grant, consentedAt: '2099-01-01T00:00:00Z' }),
    withEvent({ type: 'provider_opt_in', at: grant.at, method: 'admin', purpose: 'all' }),
    [{ ...good, events: [
      { type: 'revoke', at: grant.at, method: 'STOP', purpose: 'all', providerBlocked: true }, grant,
    ] }],
    [{ ...good, events: [
      { type: 'provider_opt_in', at: grant.at, method: 'provider', purpose: 'all', messageSid: 'same' },
      { type: 'revoke', at: grant.at, method: 'STOP', purpose: 'all', providerBlocked: true, messageSid: 'same' },
    ] }],
  ];
  for (const smsPermissions of invalid) {
    const h = harness(t, { initial: { smsPermissions: Array.isArray(smsPermissions) ? smsPermissions : [smsPermissions] } });
    await assert.rejects(smsPermission.open(h.store), /Invalid|Duplicate/);
    denied(h, PHONE, 'customer_service', 'consent_unavailable');
    await rejects(h.grant(h.evidence()), 409);
  }
  baseline.store.db.smsPermissions = [{ ...good, phone: '__proto__' }];
  denied(baseline, PHONE, 'customer_service', 'consent_unavailable');
});

test('webhook inputs do not coerce phones, SIDs, methods or provider block flags', async (t) => {
  const h = harness(t);
  for (const options of [null, [], { messageSid: {} }, { messageSid: '' }, { messageSid: 'a'.repeat(129) },
    { method: '' }, { method: {} }, { providerBlocked: 'true' }, { arbitrary: true },
    new Date(), Object.create({ providerBlocked: true }), Object.create({ messageSid: 'inherited' })]) {
    await rejects(h.revoke(PHONE, options), 400);
  }
  for (const options of [null, [], { messageSid: {} }, { providerBlocked: false }, { method: 'admin' }]) {
    await rejects(h.providerOptIn(PHONE, options), 400);
  }
  await rejects(h.revoke({}), 400);
  await rejects(h.providerOptIn({}), 400);
  assert.deepEqual(plain(h.store.db.smsPermissions || []), []);
  assert.deepEqual(plain(h.store.db.optOuts), {});
});

test('valid prototype-like business identifiers remain ordinary isolated data, not object keys', async (t) => {
  const h = harness(t);
  for (const business of ['constructor', 'toString', 'prototype']) {
    h.business = business;
    denied(h);
    await h.grant(h.evidence());
    assert.equal(h.check().allowed, true);
    assert.equal(h.snapshot().length, 1);
    assert.equal(h.snapshot()[0].businessId, business);
  }
  h.business = 'shop-1'; denied(h);
  const malicious = JSON.parse('{"phone":"+14155550101","__proto__":{"allowed":true}}');
  await rejects(h.grant(malicious), 400);
  assert.equal({}.allowed, undefined);
});
