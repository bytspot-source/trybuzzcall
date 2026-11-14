'use strict';
// Central SMS gate (src/sms.js sendSms): SMS_ENABLED=1 plus recorded written permission for the purpose of the text
// (caller -> customer_service; owner/otp -> owner_alerts) in the current shop's scope. Injected provider double only:
// no network, no real credentials. Log-only simulations are gated exactly like live sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-sms-gate-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['SMS_ENABLED', 'SMS_CONSENT_BUSINESS_ID', 'TWILIO_PHONE_NUMBER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'DATABASE_URL', 'RENDER',
  'OUTBOUND_MAX_PER_HOUR', 'OUTBOUND_MAX_PER_DAY', 'OUTBOUND_SHOP_MAX_PER_HOUR', 'OUTBOUND_SHOP_MAX_PER_DAY', 'BUSINESS_NAME']) delete process.env[k];
Object.assign(process.env, { DATA_DIR: path.join(base, 'root'), NODE_ENV: 'test', TZ: 'UTC', SMS_ENABLED: '1',
  OUTBOUND_MAX_PER_HOUR: '0', OUTBOUND_MAX_PER_DAY: '0', OUTBOUND_SHOP_MAX_PER_HOUR: '0', OUTBOUND_SHOP_MAX_PER_DAY: '0' });
const store = require('../src/store');
const shopContext = require('../src/shopContext');
const smsPermission = require('../src/smsPermission');
const sms = require('../src/sms');
test.after(() => { sms.setClient(null); fs.rmSync(base, { recursive: true, force: true }); });

const PHONE = '+14155550101', OTHER = '+14155550102', SENDER = '+14155550100';
let n = 0;
// A vendor-like shop with its own store, business id and assigned sender; provider double optional.
function harness(t, { live = false } = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'shop-'));
  const id = `shop-${++n}`;
  const h = { calls: [], output: [], provider: async () => ({ sid: 'SMtest', status: 'queued' }), onCreate: null };
  h.store = store.createStore({ dir, namespace: id });
  h.store.setOverride({ values: { BUSINESS_NAME: 'Test Business' } });
  h.shop = { id, name: 'Test Business', status: 'active', phoneNumber: SENDER };
  h.run = (fn) => shopContext.run({ id: h.shop.id, store: h.store, shop: h.shop }, fn);
  h.send = (to, body, opts) => h.run(() => sms.sendSms(to, body, opts));
  h.canSend = (to, kind) => h.run(() => sms.canSend(to, kind));
  h.grant = (purpose = 'customer_service', phone = PHONE) => h.run(() => smsPermission.grant({ phone, purpose,
    consentedAt: new Date().toISOString(), disclosureVersion: 'sms-v1', evidenceRef: 'written-form/test' }));
  h.revoke = (phone = PHONE, opts) => h.run(() => smsPermission.revoke(phone, opts));
  h.log = () => { try { return fs.readFileSync(path.join(dir, 'sms.log'), 'utf8'); } catch { return ''; } };
  sms.resetCap();
  sms.setClient(live ? { messages: { create(input) { h.calls.push(input); if (h.onCreate) h.onCreate(input); return h.provider(input); } } } : null);
  t.after(() => sms.setClient(null));
  const original = console.log;
  console.log = (...args) => h.output.push(args.join(' '));
  t.after(() => { console.log = original; });
  return h;
}
function noSend(h) {
  assert.equal(h.calls.length, 0, 'no provider call');
  assert.equal(h.log(), '', 'no sms.log entry');
  assert.ok(!h.output.some((line) => /private body/.test(line)), 'no body on stdout');
}
const skipped = async (h, reason, opts, to = PHONE) => assert.equal((await h.send(to, 'private body must not be logged', opts)).skipped, reason);

test('default deny with a configured provider: no provider call, no stdout body, no sms.log; force/bypass do nothing', async (t) => {
  const h = harness(t, { live: true });
  assert.deepEqual(h.canSend(PHONE), { allowed: false, reason: 'consent_required' });
  await skipped(h, 'consent_required');
  await skipped(h, 'consent_required', { force: true, bypass: true, allowHeld: true });
  await skipped(h, 'consent_required', { kind: 'owner', force: true });
  await skipped(h, 'consent_required', { kind: 'otp' });
  noSend(h);
});

test('default deny applies to log-only simulations and legacy leads, not just live sends', async (t) => {
  const h = harness(t);
  h.store.db.leads.push({ phone: PHONE, consent: true, messages: [{ dir: 'out', body: 'earlier' }] });
  h.store.db.voiceConsents = [{ from: PHONE, consented: true, digits: '1' }];
  await skipped(h, 'consent_required');
  noSend(h);
});

test('SMS_ENABLED must be exactly 1, read dynamically, even with recorded permission', async (t) => {
  const h = harness(t, { live: true });
  await h.grant(); await h.grant('owner_alerts');
  t.after(() => { process.env.SMS_ENABLED = '1'; });
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) {
    if (value === undefined) delete process.env.SMS_ENABLED; else process.env.SMS_ENABLED = value;
    assert.equal(h.canSend(PHONE).reason, 'sms_disabled');
    await skipped(h, 'sms_disabled');
    await skipped(h, 'sms_disabled', { kind: 'owner' });
    await skipped(h, 'sms_disabled', { kind: 'otp' });
  }
  noSend(h);
  process.env.SMS_ENABLED = '1';
  assert.equal(h.canSend(PHONE).allowed, true);
});

test('missing or malformed scope and recipients fail closed without coercion', async (t) => {
  const h = harness(t, { live: true });
  await h.grant();
  h.shop.phoneNumber = null;
  await skipped(h, 'no_sender');
  h.shop.phoneNumber = SENDER;
  for (const recipient of [null, 14155550101, {}, [], ` ${PHONE}`, `${PHONE}\n`, '__proto__']) {
    const r = await h.send(recipient, 'private body');
    assert.equal(r.ok, false);
    assert.ok(['no_recipient', 'invalid_phone'].includes(r.skipped), String(r.skipped));
  }
  // The legacy line without SMS_CONSENT_BUSINESS_ID has no scope at all.
  process.env.TWILIO_PHONE_NUMBER = SENDER;
  t.after(() => { delete process.env.TWILIO_PHONE_NUMBER; });
  assert.equal(shopContext.run(null, () => sms.canSend(PHONE)).reason, 'consent_not_configured');
  noSend(h);
});

test('customer_service and owner_alerts cannot be substituted; unknown kinds are refused', async (t) => {
  const h = harness(t, { live: true });
  await h.grant('owner_alerts');
  await skipped(h, 'consent_required');
  for (const kind of ['__proto__', 'constructor', 'marketing', null, {}, ['owner']]) await skipped(h, 'invalid_kind', { kind });
  for (const opts of [null, 'customer_service', []]) await skipped(h, 'invalid_options', opts);
  noSend(h);
  assert.equal((await h.send(PHONE, 'Owner notice', { kind: 'owner' })).ok, true);
  assert.equal((await h.send(PHONE, 'Your code is 123456', { kind: 'otp' })).ok, true, 'OTP codes are owner_alerts texts');
  assert.equal(h.calls.length, 2);
  const second = harness(t, { live: true });
  await second.grant();
  await skipped(second, 'consent_required', { kind: 'owner' });
  await skipped(second, 'consent_required', { kind: 'otp' });
  noSend(second);
});

test('business, sender and recipient changes do not reuse a grant', async (t) => {
  const h = harness(t, { live: true });
  await h.grant();
  h.shop.phoneNumber = OTHER;
  await skipped(h, 'consent_required');
  h.shop.phoneNumber = SENDER;
  await skipped(h, 'consent_required', undefined, OTHER);
  const otherShop = harness(t, { live: true });
  await skipped(otherShop, 'consent_required');
  noSend(h);
});

test('a revocation or disable after an earlier canSend check is still honored at send time', async (t) => {
  for (const change of ['revoke', 'disable']) {
    const h = harness(t, { live: true });
    await h.grant();
    assert.equal(h.canSend(PHONE).allowed, true);
    // Simulate a reply being generated while the recipient opts out.
    const pending = Promise.resolve().then(() => h.send(PHONE, 'Late generated reply'));
    if (change === 'revoke') h.revoke(PHONE).catch(() => {});
    else process.env.SMS_ENABLED = '0';
    assert.equal((await pending).ok, false);
    process.env.SMS_ENABLED = '1';
    noSend(h);
  }
});

test('no live success before provider acceptance; the body is passed through unchanged', async (t) => {
  const h = harness(t, { live: true });
  await h.grant();
  let resolve;
  h.provider = () => new Promise((done) => { resolve = done; });
  assert.equal(sms.hasPendingSends(), false);
  const pending = h.send(PHONE, 'Generated message');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 1);
  assert.equal(sms.hasPendingSends(), true, 'provider work stays visible to graceful shutdown');
  assert.deepEqual(h.calls[0], { to: PHONE, from: SENDER, body: 'Generated message' });
  resolve({ sid: 'SMaccepted', status: 'queued' });
  assert.deepEqual(await pending, { ok: true, sid: 'SMaccepted' });
  assert.equal(sms.hasPendingSends(), false);
});

test('a real shop name is required for caller texts in both modes', async (t) => {
  for (const live of [false, true]) {
    const h = harness(t, { live });
    await h.grant();
    for (const value of ['', '  ', 'our team', 'Your business']) {
      h.store.setOverride({ values: { BUSINESS_NAME: value } });
      await skipped(h, 'no_shop_name');
    }
    noSend(h);
  }
});

test('log-only simulation writes only after permission; a revoked number gets nothing more', async (t) => {
  const h = harness(t);
  await h.grant();
  assert.deepEqual(await h.send(PHONE, 'Simulated private body'), { ok: true, logOnly: true });
  const log = h.log();
  assert.match(log, /Simulated private body/);
  assert.ok(!h.output.some((line) => /Simulated private body/.test(line)), 'stdout stays metadata-only');
  await h.revoke(PHONE);
  await skipped(h, 'consent_required');
  assert.equal(h.log(), log);
});

test('provider errors fail safely and never revoke unless the recipient is blocked (21610)', async (t) => {
  const h = harness(t, { live: true });
  await h.grant();
  h.provider = async () => { throw Object.assign(new Error('private provider details'), { code: 30003 }); };
  const r = await h.send(PHONE, 'x');
  assert.deepEqual([r.ok, r.code], [false, 30003]);
  assert.equal(h.run(() => smsPermission.check(PHONE).allowed), true);
});

test('resolved provider failures or missing acceptance metadata are not successes', async (t) => {
  for (const response of [undefined, { sid: 'SMfailed', status: 'failed' }, { sid: 'SMundelivered', status: 'undelivered' },
    { sid: 'SMcanceled', status: 'canceled' }, { sid: 'SMerror', errorCode: 30003 }]) {
    const h = harness(t, { live: true });
    await h.grant();
    h.provider = async () => response;
    assert.equal((await h.send(PHONE, 'x')).ok, false, JSON.stringify(response));
  }
});

test('Twilio 21610 records a provider-block revocation of both purposes; START never restores permission', async (t) => {
  for (const code of [21610, '21610']) {
    const h = harness(t, { live: true });
    await h.grant(); await h.grant('owner_alerts');
    h.provider = async () => { throw Object.assign(new Error('never log provider details'), { code }); };
    const r = await h.send(PHONE, 'x');
    assert.deepEqual([r.ok, r.code, r.skipped], [false, 21610, 'provider_blocked']);
    const record = h.run(() => smsPermission.snapshot())[0];
    assert.equal(record.providerBlocked, true);
    assert.equal(record.events.at(-1).method, 'twilio_21610');
    assert.deepEqual(record.permissions, { customer_service: null, owner_alerts: null });
    assert.equal(h.store.isOptedOut(PHONE), true);
    await skipped(h, 'provider_blocked');
    await assert.rejects(h.grant(), (e) => e.status === 409, 'provider block must be cleared first');
    await h.run(() => smsPermission.providerOptIn(PHONE, { messageSid: 'start-after-21610' }));
    await skipped(h, 'consent_required'); await skipped(h, 'consent_required', { kind: 'owner' });
    assert.equal(h.calls.length, 1);
    await new Promise((r) => setTimeout(r, 2));
    await h.grant();
    h.provider = async () => ({ sid: 'SMregranted', status: 'queued' });
    assert.equal((await h.send(PHONE, 'New written consent')).ok, true);
  }
});

test('21610 in a resolved failed message also revokes rather than counting as success', async (t) => {
  const h = harness(t, { live: true });
  await h.grant();
  h.provider = async () => ({ sid: 'SMfailed', errorCode: 21610, status: 'failed' });
  assert.equal((await h.send(PHONE, 'x')).skipped, 'provider_blocked');
  assert.equal(h.run(() => smsPermission.snapshot())[0].providerBlocked, true);
});

test('21610 persistence failure still blocks later sends in-process', async (t) => {
  const h = harness(t, { live: true });
  await h.grant(); await h.grant('customer_service', OTHER);
  h.provider = async () => { throw Object.assign(new Error('blocked'), { code: 21610 }); };
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk failed'); };
  t.after(() => { fs.renameSync = rename; });
  await h.send(PHONE, 'x');
  fs.renameSync = rename;
  await skipped(h, 'consent_unavailable');
  await skipped(h, 'consent_unavailable', undefined, OTHER);
  assert.equal(h.calls.length, 1);
});

test('invalid bodies never reach the provider', async (t) => {
  const h = harness(t, { live: true });
  await h.grant();
  for (const body of ['', ' ', undefined, null, {}, ['text'], { toString() { throw new Error('do not coerce'); } }]) {
    assert.equal((await h.send(PHONE, body)).skipped, 'invalid_body');
  }
  noSend(h);
});
