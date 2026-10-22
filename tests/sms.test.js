'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Hermetic VM modules: no inherited env, real credentials, disk writes, SDK or network.
const source = Object.fromEntries(['store', 'consent', 'sms'].map((name) =>
  [name, fs.readFileSync(path.join(__dirname, '..', 'src', `${name}.js`), 'utf8')]));
const PHONE = '+14155550101', OTHER = '+14155550102', SENDER = '+14155550100';
const plain = (value) => JSON.parse(JSON.stringify(value));
function harness({ live = false, initial } = {}) {
  const env = { DATA_DIR: '/isolated', SMS_ENABLED: '1', SMS_CONSENT_BUSINESS_ID: 'shop-1',
    TWILIO_PHONE_NUMBER: SENDER, BUSINESS_NAME: 'Test Business' };
  if (live) Object.assign(env, { TWILIO_ACCOUNT_SID: 'test-account', TWILIO_AUTH_TOKEN: 'test-token-placeholder' });
  const files = new Map();
  if (initial) files.set('/isolated/db.json', JSON.stringify(initial));
  let clock = Date.parse('2026-10-22T12:00:00.000Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const state = {
    sdkLoads: 0, clients: 0, calls: [], output: [], logWrites: 0, failLog: false, failSave: false,
    onClient: null, provider: async () => ({ sid: 'SM-test', status: 'queued' }),
  };
  const io = {
    mkdirSync() {},
    readFileSync(file) {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFileSync(file, data) { if (state.failSave) throw new Error('disk failed'); files.set(file, data); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(file) { files.delete(file); },
    appendFileSync(file, data) {
      if (state.failLog) throw new Error('log failed');
      state.logWrites++; files.set(file, (files.get(file) || '') + data);
    },
  };
  let cache = {};
  function load(name) {
    if (cache[name]) return cache[name].exports;
    const module = { exports: {} }; cache[name] = module;
    const requireDouble = (dependency) => {
      if (dependency === 'fs') return io;
      if (dependency === 'path') return path;
      if (dependency === './store' || dependency === './consent') return load(dependency.slice(2));
      if (dependency === 'twilio') {
        state.sdkLoads++;
        return () => {
          state.clients++;
          if (state.onClient) state.onClient();
          return { messages: { create(input) { state.calls.push(input); return state.provider(input); } } };
        };
      }
      throw new Error(`Unexpected dependency: ${dependency}`);
    };
    vm.runInNewContext(source[name], {
      module, exports: module.exports, require: requireDouble, __dirname: '/application/src',
      process: { env, pid: 12345 }, Date: Clock,
      console: Object.fromEntries(['log', 'error', 'warn'].map((level) =>
        [level, (...args) => state.output.push([level, ...args])])),
    }, { filename: `${name}.js` });
    return module.exports;
  }
  return {
    env, files, state, load, tick: (ms = 2000) => { clock += ms; },
    restart() { if (cache.consent) cache.consent.exports.close(); cache = {}; return load('sms'); },
    grant(purpose = 'customer_service', phone = PHONE) {
      return load('consent').grant({ phone, purpose, consentedAt: new Date(clock - 1000).toISOString(),
        disclosureVersion: 'sms-v1', evidenceRef: 'written-form/test' });
    },
  };
}
function noSend(h) {
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.state.logWrites, 0);
  assert.equal(h.state.output.length, 0);
  assert.equal(h.files.has('/isolated/sms.log'), false);
}
async function blocked(h, reason, options) {
  assert.deepEqual(plain(await h.load('sms').sendSms(PHONE, 'private body must not be logged', options)),
    { sent: false, reason });
}

test('default deny with configured provider: no SDK load, call, stdout body or sms.log', async () => {
  const h = harness({ live: true });
  assert.equal(h.load('sms').live, true);
  assert.deepEqual(plain(h.load('sms').canSend(PHONE)), { allowed: false, reason: 'consent_required' });
  await blocked(h, 'consent_required');
  await blocked(h, 'consent_required', { force: true, bypass: true, purpose: 'customer_service' });
  noSend(h); assert.equal(h.state.sdkLoads, 0);
});

test('default deny applies to log-only and legacy leads, not just live provider sends', async () => {
  const h = harness({ initial: { leads: [{ phone: PHONE, consent: true, messages: [{ body: 'START' }] }] } });
  assert.equal(h.load('sms').live, false);
  await blocked(h, 'consent_required'); noSend(h);
});

test('SMS_ENABLED must be exactly 1, read dynamically, even with granted consent', async () => {
  const h = harness({ live: true }); h.grant();
  for (const value of [undefined, '', '0', 'true', 'yes', 1, true]) {
    h.env.SMS_ENABLED = value;
    assert.equal(h.load('sms').canSend(PHONE).reason, 'sms_disabled');
    await blocked(h, 'sms_disabled');
  }
  noSend(h); assert.equal(h.state.sdkLoads, 0);
  h.env.SMS_ENABLED = '1';
  assert.equal(h.load('sms').canSend(PHONE).allowed, true);
});

test('missing or malformed configuration and recipients fail closed without coercion', async () => {
  const h = harness({ live: true }); h.grant();
  delete h.env.SMS_CONSENT_BUSINESS_ID;
  await blocked(h, 'consent_not_configured');
  h.env.SMS_CONSENT_BUSINESS_ID = '__proto__';
  await blocked(h, 'consent_not_configured');
  h.env.SMS_CONSENT_BUSINESS_ID = 'shop-1'; h.env.TWILIO_PHONE_NUMBER = '14155550100';
  await blocked(h, 'consent_not_configured');
  h.env.TWILIO_PHONE_NUMBER = SENDER;
  for (const recipient of [undefined, null, 14155550101, {}, [], ` ${PHONE}`, `${PHONE}\n`, '__proto__']) {
    assert.equal((await h.load('sms').sendSms(recipient, 'private body')).reason, 'invalid_phone');
  }
  noSend(h); assert.equal(h.state.sdkLoads, 0);
});

test('customer_service and owner_alerts permissions cannot be substituted or bypassed', async () => {
  const h = harness({ live: true }); h.grant('owner_alerts');
  await blocked(h, 'consent_required');
  for (const purpose of ['__proto__', 'constructor', 'marketing', null, {}, ['owner_alerts']]) {
    await blocked(h, 'invalid_purpose', { purpose, bypass: true });
  }
  noSend(h);
  assert.deepEqual(plain(await h.load('sms').sendSms(PHONE, 'Owner notice', { purpose: 'owner_alerts' })),
    { sent: true, mode: 'live' });
  assert.equal(h.state.calls.length, 1);
  const second = harness({ live: true }); second.grant();
  await blocked(second, 'consent_required', { purpose: 'owner_alerts' }); noSend(second);
});

test('business, sender and recipient changes do not reuse a grant', async () => {
  const h = harness({ live: true }); h.grant();
  h.env.SMS_CONSENT_BUSINESS_ID = 'shop-2'; await blocked(h, 'consent_required');
  h.env.SMS_CONSENT_BUSINESS_ID = 'shop-1'; h.env.TWILIO_PHONE_NUMBER = OTHER;
  await blocked(h, 'consent_required');
  h.env.TWILIO_PHONE_NUMBER = SENDER;
  assert.equal((await h.load('sms').sendSms(OTHER, 'private body')).reason, 'consent_required');
  noSend(h); assert.equal(h.state.sdkLoads, 0);
});

test('a revocation or disable after an earlier canSend check is still honored at send time', async () => {
  for (const change of ['revoke', 'disable']) {
    const h = harness({ live: true }); h.grant();
    const sms = h.load('sms'); assert.equal(sms.canSend(PHONE).allowed, true);
    // Simulate an AI response being generated while the recipient opts out.
    const pendingReply = Promise.resolve().then(() => sms.sendSms(PHONE, 'Late generated reply'));
    if (change === 'revoke') h.load('consent').revoke(PHONE);
    else h.env.SMS_ENABLED = '0';
    assert.equal((await pendingReply).sent, false);
    noSend(h); assert.equal(h.state.sdkLoads, 0);
  }
});

test('permission is rechecked immediately before SDK handoff', async () => {
  const h = harness({ live: true }); h.grant();
  h.state.onClient = () => h.load('consent').revoke(PHONE, { providerBlocked: true });
  await blocked(h, 'provider_blocked'); noSend(h);
  assert.equal(h.state.clients, 1);
});

test('a configuration change during SDK setup cannot send under a different scope', async () => {
  const h = harness({ live: true }); h.grant();
  h.env.SMS_CONSENT_BUSINESS_ID = 'shop-2'; h.grant();
  h.env.SMS_CONSENT_BUSINESS_ID = 'shop-1';
  h.state.onClient = () => { h.env.SMS_CONSENT_BUSINESS_ID = 'shop-2'; };
  await blocked(h, 'configuration_changed'); noSend(h);
});

test('SDK initialization failure is handled without exposing details or simulating success', async () => {
  const h = harness({ live: true }); h.grant();
  h.state.onClient = () => { throw new Error('private SDK initialization details'); };
  await blocked(h, 'provider_failed'); noSend(h);
});

test('no live success before provider acceptance; stable footer cannot be omitted by generated body', async () => {
  const h = harness({ live: true }); h.grant();
  let resolve;
  h.state.provider = () => new Promise((done) => { resolve = done; });
  const pending = h.load('sms').sendSms(PHONE, 'Generated message with no disclosures');
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.output.length, 0); assert.equal(h.state.logWrites, 0);
  const sent = h.state.calls[0];
  assert.equal(sent.to, PHONE); assert.equal(sent.from, SENDER);
  assert.match(sent.body, /^Generated message with no disclosures\n\nTest Business:/);
  assert.match(sent.body, /Reply STOP to opt out or HELP for help/);
  assert.match(sent.body, /Message frequency varies/);
  assert.match(sent.body, /Message and data rates may apply\.$/);
  resolve({ sid: 'SM-accepted', status: 'queued' });
  assert.deepEqual(plain(await pending), { sent: true, mode: 'live' });
  assert.deepEqual(h.state.output, [['log', 'SMS accepted (live)']]);
  assert.equal(h.state.logWrites, 0); assert.equal(h.files.has('/isolated/sms.log'), false);
});

test('BUSINESS_NAME is required in both modes and cannot be empty, multiline or an object', async () => {
  for (const live of [false, true]) {
    const h = harness({ live }); h.grant();
    for (const value of [undefined, '', '  ', 'Unsafe\nBusiness', 'x'.repeat(121), {}]) {
      h.env.BUSINESS_NAME = value;
      assert.equal(h.load('sms').canSend(PHONE).reason, 'business_name_required');
      await blocked(h, 'business_name_required');
    }
    noSend(h); assert.equal(h.state.sdkLoads, 0);
  }
});

test('log-only simulation persists disclosed body before success; stdout remains metadata-only', async () => {
  const h = harness(); h.grant();
  assert.deepEqual(plain(await h.load('sms').sendSms(PHONE, 'Simulated private body')), { sent: true, mode: 'log-only' });
  const log = h.files.get('/isolated/sms.log');
  assert.match(log, /Simulated private body/); assert.match(log, /Test Business:/);
  assert.match(log, /STOP/); assert.match(log, /HELP/);
  assert.match(log, /Message frequency varies/); assert.match(log, /Message and data rates may apply/);
  assert.equal(h.state.sdkLoads, 0);
  assert.deepEqual(h.state.output, [['log', 'SMS simulated (log-only)']]);
  h.load('consent').revoke(PHONE);
  await blocked(h, 'consent_required');
  assert.equal(h.files.get('/isolated/sms.log'), log);
  assert.equal(h.state.logWrites, 1);
});

test('failed log writes are failures, never successful simulations', async () => {
  const h = harness(); h.grant(); h.state.failLog = true;
  await blocked(h, 'log_failed'); noSend(h);
});

test('pending provider work stays visible until acceptance or opt-out persistence completes', async () => {
  for (const optOut of [false, true]) {
    const h = harness({ live: true }); h.grant();
    const sms = h.load('sms');
    let finish;
    h.state.provider = () => new Promise((resolve, reject) => {
      finish = () => optOut ? reject(Object.assign(new Error('blocked'), { code: 21610 }))
        : resolve({ sid: 'SM-accepted', status: 'queued' });
    });
    assert.equal(sms.hasPendingSends(), false);
    const pending = sms.sendSms(PHONE, 'Pending work');
    assert.equal(sms.hasPendingSends(), true);
    finish(); await pending;
    assert.equal(sms.hasPendingSends(), false);
    if (optOut) assert.equal(h.load('consent').snapshot()[0].providerBlocked, true);
  }
});

test('provider errors are safely failed and never dump error text, bodies or credentials', async () => {
  const h = harness({ live: true }); h.grant();
  h.state.provider = async () => { throw Object.assign(new Error('private body and secret-like provider details'), { code: 30003 }); };
  await blocked(h, 'provider_failed');
  assert.equal(h.state.calls.length, 1); assert.equal(h.state.output.length, 0); assert.equal(h.state.logWrites, 0);
  assert.equal(h.load('consent').check(PHONE).allowed, true);
});

test('resolved provider failures or missing acceptance metadata are not successes', async () => {
  for (const response of [undefined, {}, { sid: '' }, { sid: 'SM-failed', status: 'failed' },
    { sid: 'SM-undelivered', status: 'undelivered' }, { sid: 'SM-canceled', status: 'canceled' },
    { sid: 'SM-error', errorCode: 30003 }]) {
    const h = harness({ live: true }); h.grant(); h.state.provider = async () => response;
    await blocked(h, 'provider_failed');
    assert.equal(h.state.output.length, 0); assert.equal(h.state.logWrites, 0);
  }
});

test('Twilio 21610 persists a global provider-block revocation; START is not permission', async () => {
  for (const code of [21610, '21610']) {
    const h = harness({ live: true }); h.grant(); h.grant('owner_alerts');
    h.state.provider = async () => { throw Object.assign(new Error('never log provider details'), { code }); };
    await blocked(h, 'provider_blocked');
    const record = h.load('consent').snapshot()[0];
    assert.equal(record.providerBlocked, true); assert.equal(record.events.at(-1).method, 'provider_21610');
    assert.equal(record.permissions.customer_service, null); assert.equal(record.permissions.owner_alerts, null);
    h.restart(); await blocked(h, 'provider_blocked');
    assert.equal(h.state.calls.length, 1);
    h.tick(); assert.throws(() => h.grant(), (e) => e.status === 409);
    h.load('consent').providerOptIn(PHONE, { messageSid: 'start-after-21610' });
    await blocked(h, 'consent_required'); await blocked(h, 'consent_required', { purpose: 'owner_alerts' });
    assert.equal(h.state.calls.length, 1);
    h.grant(); h.state.provider = async () => ({ sid: 'SM-regranted', status: 'queued' });
    assert.equal((await h.load('sms').sendSms(PHONE, 'New written consent')).sent, true);
    assert.equal(h.state.calls.length, 2);
    assert.equal(h.state.logWrites, 0);
  }
});

test('21610 in a resolved failed message also revokes rather than logging success', async () => {
  const h = harness({ live: true }); h.grant();
  h.state.provider = async () => ({ sid: 'SM-failed', errorCode: 21610, status: 'failed' });
  await blocked(h, 'provider_blocked');
  assert.equal(h.load('consent').snapshot()[0].providerBlocked, true);
  assert.equal(h.state.output.length, 0); assert.equal(h.state.logWrites, 0);
});

test('21610 persistence failure still blocks later sends in-process', async () => {
  const h = harness({ live: true }); h.grant(); h.state.failSave = true;
  h.state.provider = async () => { throw Object.assign(new Error('blocked'), { code: 21610 }); };
  await blocked(h, 'provider_blocked');
  await blocked(h, 'consent_unavailable');
  assert.equal(h.state.calls.length, 1); assert.equal(h.state.output.length, 0); assert.equal(h.state.logWrites, 0);
});

test('provider configuration is dynamic; partial credentials never silently simulate a live send', async () => {
  const h = harness(); h.grant(); const sms = h.load('sms');
  assert.equal(sms.live, false);
  h.env.TWILIO_ACCOUNT_SID = 'test-account';
  await blocked(h, 'provider_not_configured'); noSend(h);
  h.env.TWILIO_AUTH_TOKEN = 'test-token-placeholder';
  assert.equal(sms.live, true);
  assert.equal((await sms.sendSms(PHONE, 'Dynamic provider')).mode, 'live');
  assert.equal(h.state.calls.length, 1);
  delete h.env.TWILIO_ACCOUNT_SID; delete h.env.TWILIO_AUTH_TOKEN;
  assert.equal(sms.live, false);
});

test('invalid bodies/options cannot invoke the SDK or stringify arbitrary objects', async () => {
  const h = harness({ live: true }); h.grant();
  for (const body of ['', ' ', undefined, null, {}, ['text'], { toString() { throw new Error('do not coerce'); } }]) {
    assert.equal((await h.load('sms').sendSms(PHONE, body)).reason, 'invalid_body');
  }
  for (const options of [null, 'customer_service', []]) await blocked(h, 'invalid_options', options);
  noSend(h); assert.equal(h.state.sdkLoads, 0);
});
