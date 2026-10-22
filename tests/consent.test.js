'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Only source files are read. All database operations and all environment values are doubles.
const source = Object.fromEntries(['store', 'consent'].map((name) =>
  [name, fs.readFileSync(path.join(__dirname, '..', 'src', `${name}.js`), 'utf8')]));
const PHONE = '+14155550101', OTHER = '+14155550102', SENDER = '+14155550100';
const plain = (value) => JSON.parse(JSON.stringify(value));
function harness({ initial, readError, files = new Map() } = {}) {
  const env = { DATA_DIR: '/isolated', SMS_CONSENT_BUSINESS_ID: 'shop-1', TWILIO_PHONE_NUMBER: SENDER };
  let clock = Date.parse('2026-10-22T12:00:00.000Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  if (initial !== undefined) files.set('/isolated/db.json', typeof initial === 'string' ? initial : JSON.stringify(initial));
  const state = { failWrite: false, failRename: false, writes: 0, beforeWrite: null, operations: [] };
  const io = {
    mkdirSync() {},
    readFileSync(file) {
      if (readError) throw Object.assign(new Error('read failure'), { code: readError });
      if (!files.has(file)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFileSync(file, data, options) {
      state.operations.push(['write', file, options]);
      if (state.beforeWrite) state.beforeWrite();
      if (state.failWrite) throw new Error('disk full');
      if (options.flag === 'wx' && files.has(file)) throw new Error('already exists');
      files.set(file, data); state.writes++;
    },
    renameSync(from, to) {
      state.operations.push(['rename', from, to]);
      if (state.failRename) throw new Error('rename failed');
      files.set(to, files.get(from)); files.delete(from);
    },
    unlinkSync(file) { state.operations.push(['unlink', file]); files.delete(file); },
  };
  let cache = {};
  function load(name) {
    if (cache[name]) return cache[name].exports;
    const module = { exports: {} };
    cache[name] = module;
    const requireDouble = (dependency) => {
      if (dependency === 'fs') return io;
      if (dependency === 'path') return path;
      if (dependency === './store') return load('store');
      throw new Error(`Unexpected dependency: ${dependency}`);
    };
    vm.runInNewContext(source[name], {
      module, exports: module.exports, require: requireDouble, __dirname: '/application/src',
      process: { env, pid: 12345 }, Date: Clock,
    }, { filename: `${name}.js` });
    // Count business writes separately from the mandatory startup safety marker.
    if (name === 'consent') { state.writes = 0; state.operations = []; }
    return module.exports;
  }
  return {
    env, files, state, load, now: () => new Date(clock).toISOString(), tick: (ms = 1000) => { clock += ms; },
    restart({ crash = false } = {}) {
      if (!crash && cache.consent) cache.consent.exports.close();
      cache = {}; return load('consent');
    },
    evidence(purpose = 'customer_service', phone = PHONE) {
      return { phone, purpose, consentedAt: new Date(clock - 1000).toISOString(),
        disclosureVersion: 'sms-v1', evidenceRef: 'written-form/123' };
    },
  };
}
const denied = (consent, phone = PHONE, purpose = 'customer_service', reason = 'consent_required') =>
  assert.deepEqual(plain(consent.check(phone, purpose)), { allowed: false, reason });

test('legacy leads, messages and arbitrary legacy consent flags never grant either purpose', () => {
  const h = harness({ initial: { leads: [{ phone: PHONE, consent: true, messages: [{ body: 'START' }] }],
    optedIn: [PHONE], smsConsent: { [PHONE]: true } } });
  const consent = h.load('consent');
  assert.deepEqual(plain(h.load('store').db.smsPermissions), []);
  denied(consent); denied(consent, PHONE, 'owner_alerts');
  assert.deepEqual(plain(consent.snapshot()), []);
  assert.equal(h.state.writes, 0);
});

test('strict E.164 and dynamically read stable business/sender configuration, with no coercion', () => {
  const h = harness(), consent = h.load('consent');
  for (const phone of [PHONE, '+12', '+123456789012345']) assert.equal(consent.validPhone(phone), true);
  for (const phone of [undefined, null, 14155550101, {}, [], new String(PHONE), true,
    '+1', '+0123', '14155550101', ` ${PHONE}`, `${PHONE}\n`, '+1234567890123456',
    { toString() { throw new Error('must not coerce'); } }]) {
    assert.equal(consent.validPhone(phone), false);
    denied(consent, phone === undefined ? null : phone, 'customer_service', 'invalid_phone');
  }
  assert.deepEqual(plain(consent.configuration()), { businessId: 'shop-1', sender: SENDER });
  for (const invalid of [undefined, null, '', '_bad', '-bad', '__proto__', 'bad space', 'shop\n', 'a'.repeat(65), {}, ['shop']]) {
    h.env.SMS_CONSENT_BUSINESS_ID = invalid;
    assert.equal(consent.configuration(), null);
    denied(consent, PHONE, 'customer_service', 'consent_not_configured');
    assert.throws(() => consent.grant(h.evidence()), (e) => e.status === 409);
    assert.deepEqual(plain(consent.snapshot()), []);
  }
  for (const valid of ['a', 'A_1-b', 'a'.repeat(64), 'constructor', 'toString']) {
    h.env.SMS_CONSENT_BUSINESS_ID = valid;
    assert.equal(consent.configuration().businessId, valid);
  }
  h.env.TWILIO_PHONE_NUMBER = 'not-e164';
  assert.equal(consent.configuration(), null);
  h.env.TWILIO_PHONE_NUMBER = SENDER;
  assert.notEqual(consent.configuration(), null);
});

test('grants are explicit per purpose and scoped to business, sender and recipient', () => {
  const h = harness(), consent = h.load('consent');
  const granted = consent.grant(h.evidence());
  assert.equal(consent.check(PHONE).allowed, true);
  denied(consent, PHONE, 'owner_alerts'); denied(consent, OTHER);
  assert.equal(granted.businessId, 'shop-1');
  assert.equal(granted.sender, SENDER); assert.equal(granted.phone, PHONE);
  assert.equal(granted.events[0].method, 'admin');
  assert.equal(granted.events[0].evidenceRef, 'written-form/123');
  assert.equal(granted.events[0].disclosureVersion, 'sms-v1');
  consent.grant(h.evidence('owner_alerts'));
  assert.equal(consent.check(PHONE, 'owner_alerts').allowed, true);
  h.env.SMS_CONSENT_BUSINESS_ID = 'shop-2';
  denied(consent); assert.deepEqual(plain(consent.snapshot()), []);
  consent.grant(h.evidence());
  h.env.TWILIO_PHONE_NUMBER = OTHER;
  denied(consent); assert.deepEqual(plain(consent.snapshot()), []);
  consent.grant(h.evidence('owner_alerts'));
  assert.equal(consent.snapshot().length, 1);
  denied(consent); assert.equal(consent.check(PHONE, 'owner_alerts').allowed, true);
  h.env.SMS_CONSENT_BUSINESS_ID = 'shop-1'; h.env.TWILIO_PHONE_NUMBER = SENDER;
  assert.equal(consent.snapshot().length, 1);
  assert.equal(consent.snapshot()[0].events.length, 2);
  assert.equal(consent.check(PHONE).allowed, true);
  assert.equal(h.load('store').db.smsPermissions.length, 3);
});

test('grant validates purpose, strict ISO dates, bounded evidence, and future timestamps', () => {
  const h = harness(), consent = h.load('consent'), good = h.evidence();
  const invalid = [null, {}, { ...good, extra: true }, { ...good, phone: {} },
    ...[undefined, null, '', '__proto__', 'constructor', 'marketing', {}, ['customer_service']].map((purpose) => ({ ...good, purpose })),
    ...['2026-02-30T12:00:00Z', '2025-02-29T12:00:00Z', '2026-10-22', '2026-10-22T12:00:00',
      '2026-10-22T24:00:00Z', '2026-10-22T12:00:60Z', '2026-10-22T12:00:00+24:00',
      '2026-10-22T12:00:01Z', 123, {}].map((consentedAt) => ({ ...good, consentedAt })),
    ...['', ' ', 'a'.repeat(129), {}, 'bad\nvalue'].map((disclosureVersion) => ({ ...good, disclosureVersion })),
    ...['', ' ', 'a'.repeat(513), {}, 'bad\u0000value'].map((evidenceRef) => ({ ...good, evidenceRef }))];
  for (const value of invalid) assert.throws(() => consent.grant(value), (e) => e.status === 400);
  for (const purpose of ['__proto__', 'constructor', {}, null]) denied(consent, PHONE, purpose, 'invalid_purpose');
  assert.equal(h.state.writes, 0);
  const record = consent.grant({ ...good, consentedAt: '2026-10-22T13:59:59+02:00' });
  assert.equal(record.events[0].consentedAt, '2026-10-22T11:59:59.000Z');
});

test('global revocation preserves history, revokes both purposes and requires strictly newer evidence', () => {
  const h = harness(), consent = h.load('consent');
  consent.grant(h.evidence()); consent.grant(h.evidence('owner_alerts'));
  const revoked = consent.revoke(PHONE);
  assert.equal(revoked.events.length, 3);
  assert.equal(revoked.events[2].method, 'admin');
  denied(consent); denied(consent, PHONE, 'owner_alerts');
  assert.throws(() => consent.grant(h.evidence()), (e) => e.status === 409);
  assert.throws(() => consent.grant({ ...h.evidence(), consentedAt: h.now() }), (e) => e.status === 409);
  h.tick(2000);
  consent.grant(h.evidence());
  assert.equal(consent.check(PHONE).allowed, true);
  denied(consent, PHONE, 'owner_alerts');
  assert.equal(consent.snapshot()[0].events.length, 4);
});

test('provider START is never consent and cannot restore grants after STOP', () => {
  const h = harness(), consent = h.load('consent');
  consent.providerOptIn(PHONE, { messageSid: 'start-initial' });
  denied(consent); denied(consent, PHONE, 'owner_alerts');
  consent.grant(h.evidence()); consent.grant(h.evidence('owner_alerts'));
  consent.revoke(PHONE, { method: 'STOP', messageSid: 'stop-1', providerBlocked: true });
  denied(consent, PHONE, 'customer_service', 'provider_blocked');
  h.tick(2000);
  assert.throws(() => consent.grant(h.evidence()), (e) => e.status === 409);
  // An admin revoke is not a provider unblock.
  consent.revoke(PHONE);
  assert.equal(consent.snapshot()[0].providerBlocked, true);
  consent.providerOptIn(PHONE, { messageSid: 'start-1' });
  assert.equal(consent.snapshot()[0].providerBlocked, false);
  denied(consent); denied(consent, PHONE, 'owner_alerts');
  h.tick(2000);
  consent.grant(h.evidence('owner_alerts'));
  denied(consent); assert.equal(consent.check(PHONE, 'owner_alerts').allowed, true);
});

test('MessageSid duplicates are no-ops even when replaying an old START after a later STOP and restart', () => {
  const h = harness(); let consent = h.load('consent');
  consent.providerOptIn(PHONE, { messageSid: 'start-old' });
  const writes = h.state.writes;
  consent.providerOptIn(PHONE, { messageSid: 'start-old' });
  assert.equal(h.state.writes, writes);
  h.tick();
  consent.revoke(PHONE, { messageSid: 'stop-new', providerBlocked: true });
  consent = h.restart();
  const before = plain(consent.snapshot());
  consent.providerOptIn(PHONE, { messageSid: 'start-old' });
  consent.revoke(PHONE, { messageSid: 'stop-new', providerBlocked: false });
  // Deduplication covers SID reuse across different event kinds too.
  consent.providerOptIn(PHONE, { messageSid: 'stop-new' });
  assert.deepEqual(plain(consent.snapshot()), before);
  denied(consent, PHONE, 'customer_service', 'provider_blocked');
  consent.providerOptIn(PHONE, { messageSid: 'start-new' });
  h.tick(2000); consent.grant(h.evidence());
  consent.revoke(PHONE, { messageSid: 'stop-new', providerBlocked: true });
  assert.equal(consent.check(PHONE).allowed, true);
});

test('MessageSid deduplication namespaces include business, sender and recipient', () => {
  const h = harness(), consent = h.load('consent');
  for (const [business, sender, phone] of [
    ['shop-1', SENDER, PHONE], ['shop-2', SENDER, PHONE],
    ['shop-1', OTHER, PHONE], ['shop-1', SENDER, OTHER],
  ]) {
    h.env.SMS_CONSENT_BUSINESS_ID = business; h.env.TWILIO_PHONE_NUMBER = sender;
    consent.revoke(phone, { messageSid: '__proto__', providerBlocked: true });
    assert.equal(consent.snapshot()[0].events.length, 1);
    denied(consent, phone, 'owner_alerts', 'provider_blocked');
  }
  assert.equal(h.load('store').db.smsPermissions.length, 4);
  assert.equal(h.state.writes, 4);
});

test('events are immutable internally and returned records/snapshots are detached', () => {
  const h = harness(), consent = h.load('consent');
  const returned = consent.grant(h.evidence());
  returned.events[0].purpose = 'owner_alerts'; returned.events.push({ type: 'revoke' });
  returned.permissions.owner_alerts = returned.permissions.customer_service;
  const snapshot = consent.snapshot(); snapshot[0].events.length = 0;
  assert.equal(consent.check(PHONE).allowed, true); denied(consent, PHONE, 'owner_alerts');
  assert.equal(Object.isFrozen(h.load('store').db.smsPermissions[0].events[0]), true);
  assert.equal(consent.snapshot()[0].events.length, 1);
});

test('persist first, then expose grants; atomic saves preserve the normal store API', () => {
  const h = harness(), consent = h.load('consent'), store = h.load('store');
  h.state.beforeWrite = () => denied(consent);
  consent.grant(h.evidence()); h.state.beforeWrite = null;
  assert.equal(consent.check(PHONE).allowed, true);
  assert.equal(h.state.operations[0][0], 'write');
  assert.notEqual(h.state.operations[0][1], '/isolated/db.json');
  assert.equal(h.state.operations[0][2].mode, 0o600);
  assert.equal(h.state.operations[0][2].flag, 'wx');
  assert.equal(h.state.operations[1][0], 'rename');
  assert.equal(h.files.size, 1);
  store.createLead(OTHER); store.addAlert({ to: OTHER }); store.addWaitlist('test@example.test', 'braiders');
  assert.equal(store.findOpenLead(OTHER).phone, OTHER);
  assert.equal(store.db.alerts.length, 1); assert.equal(store.db.waitlist.length, 1);
  store.db.bookings.push({ id: 'booking-1' }); store.save();
  assert.equal(store.findBooking('booking-1').id, 'booking-1');
  const restarted = h.restart();
  assert.equal(restarted.check(PHONE).allowed, true);
  assert.equal(h.load('store').db.leads.length, 1);
});

test('failed writes and failed renames never authorize; original database survives restart', () => {
  for (const failure of ['failWrite', 'failRename']) {
    const h = harness(), consent = h.load('consent');
    h.load('store').save();
    const before = h.files.get('/isolated/db.json');
    h.state[failure] = true;
    assert.throws(() => consent.grant(h.evidence()), (e) => e.status === 409);
    assert.equal(h.load('store').db.smsPermissions.length, 0);
    denied(consent, PHONE, 'customer_service', 'consent_unavailable');
    assert.equal(h.files.get('/isolated/db.json'), before);
    assert.equal(h.files.size, 1);
    h.state[failure] = false;
    const restarted = h.restart();
    denied(restarted, PHONE, 'customer_service', 'consent_unavailable');
    assert.equal(restarted.status().recoveryRequired, true);
    restarted.recover('suppression_history_reviewed');
    denied(restarted);
  }
});

test('a failed revocation blocks all sends in the running process instead of leaving old grants usable', () => {
  const h = harness(), consent = h.load('consent');
  consent.grant(h.evidence()); h.state.failWrite = true;
  assert.throws(() => consent.revoke(PHONE), (e) => e.status === 409);
  denied(consent, PHONE, 'customer_service', 'consent_unavailable');
  h.state.failWrite = false;
  assert.throws(() => consent.grant(h.evidence()), (e) => e.status === 409);
});

test('failed suppression retries are durable; a crash cannot restore the older grant', () => {
  for (const failure of ['failWrite', 'failRename']) {
    const h = harness(), consent = h.load('consent');
    consent.grant(h.evidence()); consent.grant(h.evidence('owner_alerts'));
    assert.equal(JSON.parse(h.files.get('/isolated/db.json')).smsSessionClean, false);
    h.state[failure] = true;
    assert.throws(() => consent.revoke(PHONE, { messageSid: 'failed-stop' }), (e) => e.status === 409);
    assert.equal(consent.snapshot()[0].permissions.customer_service, null);
    assert.equal(consent.close(), false);
    h.state[failure] = false;
    // The same delivery may be retried without losing its original suppression timestamp.
    consent.revoke(PHONE, { messageSid: 'failed-stop' });
    denied(consent); denied(consent, PHONE, 'owner_alerts');
    const restarted = h.restart();
    denied(restarted); denied(restarted, PHONE, 'owner_alerts');
    assert.equal(restarted.snapshot()[0].events.filter(e => e.messageSid === 'failed-stop').length, 1);
  }
  const h = harness(), consent = h.load('consent');
  consent.grant(h.evidence()); h.state.failWrite = true;
  assert.throws(() => consent.revoke(PHONE), (e) => e.status === 409);
  h.state.failWrite = false;
  const restarted = h.restart({ crash: true });
  denied(restarted, PHONE, 'customer_service', 'consent_unavailable');
  assert.equal(restarted.status().recoveryRequired, true);
  assert.throws(() => restarted.grant(h.evidence()), (e) => e.status === 409);
  assert.throws(() => restarted.recover('skip-review'), (e) => e.status === 400);
  h.env.SMS_ENABLED = '1';
  assert.throws(() => restarted.recover('suppression_history_reviewed'), (e) => e.status === 409);
  // Operator reconciles the missed opt-out while quarantined, then explicitly recovers with SMS off.
  restarted.revoke(PHONE);
  h.env.SMS_ENABLED = '0'; restarted.recover('suppression_history_reviewed');
  denied(restarted); denied(h.restart());
});

test('startup must persist its crash marker before granting access', () => {
  const h = harness(); h.state.failWrite = true;
  assert.throws(() => h.load('consent'), /Unable to persist/);
  assert.throws(() => harness({ initial: { smsSessionClean: 'true' } }).load('consent'), /Invalid SMS session/);
});

test('existing corrupt or unreadable databases fail startup; only ENOENT is new', () => {
  for (const initial of ['', '{', 'null', '[]', 'false', '{"leads":{}}', '{"billing":[]}', '{"smsPermissions":null}']) {
    const h = harness({ initial });
    assert.throws(() => h.load('store'), /Invalid database/);
    assert.equal(h.state.writes, 0);
  }
  for (const readError of ['EACCES', 'EIO', 'EISDIR']) {
    assert.throws(() => harness({ readError }).load('store'), /Unable to read database/);
  }
  assert.deepEqual(plain(harness().load('store').db.smsPermissions), []);
});

test('malformed persisted permission data, duplicate scopes and impossible grants fail closed', () => {
  const baseline = harness(), consent = baseline.load('consent');
  consent.grant(baseline.evidence());
  const good = JSON.parse(baseline.files.get('/isolated/db.json')).smsPermissions[0];
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
    assert.throws(() => harness({ initial: { smsPermissions } }).load('consent'), /Invalid|Duplicate/);
  }
  baseline.load('store').db.smsPermissions = [{ ...good, phone: '__proto__' }];
  denied(consent, PHONE, 'customer_service', 'consent_unavailable');
});

test('webhook inputs do not coerce phones, SIDs, methods or provider block flags', () => {
  const h = harness(), consent = h.load('consent');
  for (const options of [null, [], { messageSid: {} }, { messageSid: '' }, { messageSid: 'a'.repeat(129) },
    { method: '' }, { method: {} }, { providerBlocked: 'true' }, { arbitrary: true },
    new Date(), Object.create({ providerBlocked: true }), Object.create({ messageSid: 'inherited' })]) {
    assert.throws(() => consent.revoke(PHONE, options), (e) => e.status === 400);
  }
  for (const options of [null, [], { messageSid: {} }, { providerBlocked: false }, { method: 'admin' }]) {
    assert.throws(() => consent.providerOptIn(PHONE, options), (e) => e.status === 400);
  }
  assert.throws(() => consent.revoke({}), (e) => e.status === 400);
  assert.throws(() => consent.providerOptIn({}), (e) => e.status === 400);
  assert.equal(h.state.writes, 0);
});

test('valid prototype-like business identifiers remain ordinary isolated data, not object keys', () => {
  const h = harness(), consent = h.load('consent');
  for (const business of ['constructor', 'toString', 'prototype']) {
    h.env.SMS_CONSENT_BUSINESS_ID = business;
    denied(consent);
    consent.grant(h.evidence());
    assert.equal(consent.check(PHONE).allowed, true);
    assert.equal(consent.snapshot().length, 1);
    assert.equal(consent.snapshot()[0].businessId, business);
  }
  h.env.SMS_CONSENT_BUSINESS_ID = 'shop-1'; denied(consent);
  const malicious = JSON.parse('{"phone":"+14155550101","__proto__":{"allowed":true}}');
  assert.throws(() => consent.grant(malicious), (e) => e.status === 400);
  assert.equal({}.allowed, undefined);
});
