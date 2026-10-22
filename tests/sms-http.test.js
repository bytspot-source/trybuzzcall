'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const twilio = require('twilio');
const stripe = require('stripe')('sk_unused'); // Local webhook signing only; never calls Stripe.
const SERVER = path.resolve(__dirname, '../src/server.js');
const SENDER = '+14155550100', CALLER = '+14155550101', OWNER = '+14155550102';
const SECOND = '+14155550103';
const sid = () => `SM${randomBytes(16).toString('hex')}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
async function fixture(t, overrides = {}, { provider = false, initial, holdProvider = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buzzcall-sms-http-'));
  // Random, test-only credentials stay in process memory and the child's environment.
  const admin = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  const account = `AC${randomBytes(16).toString('hex')}`;
  if (initial) await writeFile(path.join(directory, 'db.json'), JSON.stringify(initial), { mode: 0o600 });
  // Validate real Twilio signatures, but prohibit all outbound network in the child.
  // Even the live branch can only write fake SDK acceptance records to our temp dir.
  const preload = path.join(directory, 'provider-double.cjs');
  await writeFile(preload, `
const fs = require('fs');
const path = require('path');
const Module = require('module');
const real = require(${JSON.stringify(require.resolve('twilio'))});
const original = Module._load;
function fake() { return { messages: { create: async (input) => {
  fs.appendFileSync(path.join(process.env.DATA_DIR, 'accepted.jsonl'), JSON.stringify(input) + '\\n');
  if (${JSON.stringify(holdProvider)}) await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(process.env.DATA_DIR, 'release-provider'))) { clearInterval(timer); resolve(); }
    }, 10);
  });
  return { sid: 'SM' + 'a'.repeat(32), status: 'queued' };
} } }; }
if (${JSON.stringify(holdProvider)}) process.once('SIGTERM', () => {
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'terminating'), '1');
});
fake.validateRequest = real.validateRequest;
Module._load = function (name, ...rest) { return name === 'twilio' ? fake : original.call(this, name, ...rest); };
for (const transport of [require('http'), require('https')]) {
  transport.request = () => { throw new Error('Outbound networking forbidden in SMS HTTP tests'); };
  transport.get = transport.request;
}
global.fetch = () => { throw new Error('Outbound fetch forbidden in SMS HTTP tests'); };
`, { mode: 0o600 });
  let state, origin, settings = { ...overrides };
  async function stop(signal = 'SIGTERM') {
    if (!state) return;
    const current = state;
    if (current.closed) return current.done;
    current.child.kill(signal);
    let timer;
    const exited = await Promise.race([
      current.done.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 1500); }),
    ]);
    clearTimeout(timer);
    if (!exited) {
      current.child.kill('SIGKILL');
      let killTimer;
      try {
        await Promise.race([current.done, new Promise((_, reject) => {
          killTimer = setTimeout(() => reject(new Error('Test child did not exit; preserve data')), 1500);
        })]);
      } finally { clearTimeout(killTimer); }
    }
    return current.done;
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true }); // Exact task-owned mkdtemp directory.
  });
  async function start() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const port = await freePort();
      origin = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ['--require', preload, SERVER], {
        cwd: directory,
        env: {
          NODE_ENV: 'test', TZ: 'UTC', BUSINESS_TZ: 'UTC', PORT: String(port),
          PUBLIC_BASE_URL: origin, DATA_DIR: directory, BUSINESS_NAME: 'Test Shop',
          SMS_ENABLED: '1', SMS_CONSENT_BUSINESS_ID: 'test-shop', TWILIO_PHONE_NUMBER: SENDER,
          TWILIO_ACCOUNT_SID: provider ? account : '', TWILIO_AUTH_TOKEN: provider ? token : '',
          ALLOW_UNSIGNED_TWILIO_WEBHOOKS: '1', ADMIN_PASSWORD: admin, OWNER_PHONE: OWNER,
          BOOKING_ENABLED: '0', DEPOSIT_ENABLED: '0', BUSINESS_DAYS: '0,1,2,3,4,5,6',
          BUSINESS_HOURS: '00:00-23:59', FORWARD_TO_PHONE: '', STRIPE_SECRET_KEY: '',
          STRIPE_WEBHOOK_SECRET: '', OPENAI_API_KEY: '', ...settings,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      state = { child, closed: false };
      const current = state;
      current.done = new Promise((resolve) => child.once('close', (code, signal) => {
        current.closed = true; resolve({ code, signal });
      }));
      try {
        await new Promise((resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => reject(new Error('SMS test server startup timeout')), 5000);
          const inspect = (chunk) => {
            output = (output + chunk.toString()).slice(-4096);
            if (output.includes(`missedcall-buzz on :${port} (`)) { clearTimeout(timer); resolve(); }
          };
          child.stdout.on('data', inspect); child.stderr.on('data', inspect);
          child.once('error', () => { clearTimeout(timer); reject(new Error('SMS test server spawn failed')); });
          child.once('close', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('SMS test server exited'), { retry: output.includes('EADDRINUSE') }));
          });
        });
        return;
      } catch (error) {
        await stop();
        if (!error.retry || attempt === 3) throw error;
      }
    }
  }
  await start();
  async function request(target, body, options = {}) {
    const url = new URL(target, origin);
    assert.equal(url.origin, origin, 'All HTTP must remain on our child server');
    const form = options.form;
    const payload = body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    const headers = { ...(payload === undefined ? {} : {
      'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    }), ...(options.admin ? { Authorization: `Basic ${Buffer.from(`operator:${admin}`).toString('base64')}` } : {}),
    ...options.headers };
    if (options.signed) headers['X-Twilio-Signature'] = twilio.getExpectedTwilioSignature(token, url.href, body);
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: payload === undefined ? 'GET' : 'POST', headers,
        agent: false, signal: options.signal }, (res) => {
        let result = '';
        res.setEncoding('utf8'); res.on('data', (chunk) => { result += chunk; });
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: result, headers: res.headers }); });
        res.on('error', reject);
      });
      const timer = setTimeout(() => req.destroy(new Error('Local SMS request timeout')), 4000);
      req.on('error', (error) => { clearTimeout(timer); reject(error); });
      req.end(payload);
    });
  }
  async function webhook(route, extra = {}, options = {}) {
    return request(route, { From: CALLER, To: SENDER, AccountSid: account, MessageSid: sid(),
      CallSid: `CA${'a'.repeat(32)}`, ...extra }, { form: true, signed: provider, ...options });
  }
  async function grant(phone = CALLER, purpose = 'customer_service', changes = {}) {
    const response = await request('/api/consent', { action: 'grant', phone, purpose,
      consentedAt: new Date().toISOString(), disclosureVersion: 'test-written-v1',
      evidenceRef: 'test-form/1', ...changes }, { admin: true });
    assert.equal(response.status, 200, `Grant must succeed: ${response.body}`);
    return JSON.parse(response.body).record;
  }
  async function read(name) {
    try { return await readFile(path.join(directory, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }
  return {
    request, webhook, grant, account, origin: () => origin,
    stop, crash: () => stop('SIGKILL'),
    terminating: async () => (await read('terminating')) === '1',
    releaseProvider: () => writeFile(path.join(directory, 'release-provider'), '1', { mode: 0o600 }),
    store: async () => JSON.parse(await read('db.json')),
    log: () => read('sms.log'),
    sends: async () => provider
      ? (await read('accepted.jsonl')).trim().split('\n').filter(Boolean).length
      : ((await read('sms.log')).match(/^\[.*\] SMS \(/gm) || []).length,
    records: async () => {
      const response = await request('/api/consent', undefined, { admin: true });
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      return JSON.parse(response.body).records;
    },
    restart: async (changes = {}) => { await stop(); settings = { ...settings, ...changes }; await start(); },
  };
}
const ok = (response) => assert.equal(response.status, 200, response.body);
const missingGrants = (record) => assert.deepEqual(record.permissions, { customer_service: null, owner_alerts: null });
async function eventually(check, message) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}
async function consentStatus(app) {
  const response = await app.request('/api/consent', undefined, { admin: true });
  ok(response);
  assert.equal(response.headers['cache-control'], 'no-store');
  return JSON.parse(response.body);
}
const grantInput = (phone = CALLER, purpose = 'customer_service') => ({ action: 'grant', phone, purpose,
  consentedAt: new Date().toISOString(), disclosureVersion: 'test-written-v1', evidenceRef: 'test-form/review' });
const paymentEvent = (bookingId, type = 'checkout.session.completed', payment_status = 'paid') => ({
  id: `evt_test_${randomBytes(12).toString('hex')}`, object: 'event', type,
  data: { object: { object: 'checkout.session', mode: 'payment', metadata: { bookingId }, payment_status } },
});
function signedPayment(app, event, secret) {
  // Sign exactly the JSON bytes request() sends; signatures never enter assertion output.
  const signature = stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret });
  return app.request('/stripe/webhook', event, { headers: { 'Stripe-Signature': signature } });
}

// These tests exercise the actual Express server, persistence and middleware, not DOM/route doubles.
test('HTTP: SMS defaults off, even after recorded permission; no implicit enrollment', async (t) => {
  const app = await fixture(t, { SMS_ENABLED: '' });
  ok(await app.webhook('/twilio/voice'));
  ok(await app.webhook('/twilio/voice/status', { DialCallStatus: 'no-answer' }));
  ok(await app.webhook('/twilio/sms', { Body: 'I need a plumber' }));
  ok(await app.request('/api/waitlist', { email: 'owner@example.test', businessType: 'braiders' }));
  assert.equal((await app.records()).length, 0);
  await app.grant();
  ok(await app.webhook('/twilio/voice'));
  ok(await app.webhook('/twilio/sms', { Body: 'Dana' }));
  assert.equal(await app.sends(), 0);
  assert.equal((await app.store()).leads.length, 0);
});

test('HTTP: operator API validates authentication, origin, media type, evidence and scope', async (t) => {
  const app = await fixture(t);
  const valid = { action: 'grant', phone: CALLER, purpose: 'customer_service',
    consentedAt: new Date().toISOString(), disclosureVersion: 'v1', evidenceRef: 'record/1' };
  assert.equal((await app.request('/api/consent')).status, 401);
  assert.equal((await app.request('/api/consent', valid)).status, 401);
  assert.equal((await app.request('/api/consent', valid, { admin: true, form: true })).status, 415);
  for (const origin of ['https://attacker.example', 'null', `${app.origin()}.attacker.example`]) {
    assert.equal((await app.request('/api/consent', valid, { admin: true, headers: { Origin: origin } })).status, 403);
  }
  for (const change of [{ purpose: 'marketing' }, { phone: {} }, { purpose: '__proto__' },
    { consentedAt: 'tomorrow' }, { consentedAt: '2099-01-01T00:00:00Z' }, { evidenceRef: '' },
    { disclosureVersion: '' }, { businessId: 'another-shop' }, { sender: SECOND }, { action: 'enable' }]) {
    assert.equal((await app.request('/api/consent', { ...valid, ...change }, { admin: true })).status, 400);
  }
  assert.deepEqual(await app.records(), []);
  ok(await app.request('/api/consent', valid, { admin: true, headers: { Origin: app.origin() } }));
  assert.equal((await app.records())[0].permissions.customer_service.evidenceRef, 'record/1');
  assert.equal((await app.records())[0].permissions.owner_alerts, null);
});

test('HTTP: unconsented call/text/START cannot send; voice does not claim a text was sent', async (t) => {
  const app = await fixture(t);
  for (const route of ['/twilio/voice', '/twilio/voice/status']) {
    const response = await app.webhook(route, { DialCallStatus: 'no-answer' });
    ok(response);
    assert.match(response.body, /Please call again/);
    assert.doesNotMatch(response.body, /just (?:sent|texted)/i);
  }
  ok(await app.webhook('/twilio/sms', { Body: 'START', OptOutType: 'START' }));
  ok(await app.webhook('/twilio/sms', { Body: 'Please book me' }));
  missingGrants((await app.records())[0]);
  assert.equal(await app.sends(), 0);
  assert.equal((await app.store()).leads.length, 0);
  await app.grant();
  ok(await app.webhook('/twilio/voice'));
  assert.equal(await app.sends(), 1);
  assert.match(await app.log(), /Test Shop: Reply STOP to opt out or HELP for help/);
});

test('HTTP: standard and natural-language STOP revoke both scopes before any other processing', async (t) => {
  const app = await fixture(t);
  const requests = [' STOP ', 'stopall', 'Unsubscribe', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT',
    'STOP!', 'Please stop texting me', "Don't text me again", 'Do not message me', 'Remove me', 'No more messages',
    'opt out', 'please opt me out'];
  for (let i = 0; i < requests.length; i++) {
    const phone = `+14155550${String(200 + i)}`;
    await app.grant(phone); await app.grant(phone, 'owner_alerts');
    const response = await app.webhook('/twilio/sms', { From: phone, Body: requests[i] });
    ok(response); assert.doesNotMatch(response.body, /<Message/);
    const record = (await app.records()).find((row) => row.phone === phone);
    missingGrants(record);
    ok(await app.webhook('/twilio/voice', { From: phone }));
    ok(await app.webhook('/twilio/sms', { From: phone, Body: 'HELP' }));
    ok(await app.webhook('/twilio/sms', { From: phone, Body: 'Dana' }));
  }
  assert.equal(await app.sends(), 0);
  assert.equal((await app.store()).leads.length, 0);
});

test('HTTP: provider opt-out states persist, duplicate events are ignored, START never restores consent', async (t) => {
  const app = await fixture(t);
  await app.grant(); await app.grant(CALLER, 'owner_alerts');
  const stopId = sid(), startId = sid();
  ok(await app.webhook('/twilio/sms', { Body: 'custom-language-stop', OptOutType: 'STOP', MessageSid: stopId }));
  const snapshot = await app.records();
  ok(await app.webhook('/twilio/sms', { Body: 'STOP', OptOutType: 'STOP', MessageSid: stopId }));
  assert.deepEqual(await app.records(), snapshot);
  assert.equal(snapshot[0].providerBlocked, true); missingGrants(snapshot[0]);
  const blockedGrant = await app.request('/api/consent', { action: 'grant', phone: CALLER,
    purpose: 'customer_service', consentedAt: new Date().toISOString(), disclosureVersion: 'v2', evidenceRef: 'new/2' }, { admin: true });
  assert.equal(blockedGrant.status, 409);
  ok(await app.webhook('/twilio/sms', { Body: 'START', OptOutType: 'START', MessageSid: startId }));
  const cleared = (await app.records())[0];
  assert.equal(cleared.providerBlocked, false); missingGrants(cleared);
  await app.restart();
  assert.deepEqual((await app.records())[0], cleared);
  ok(await app.webhook('/twilio/voice')); assert.equal(await app.sends(), 0);
  await app.grant();
  ok(await app.webhook('/twilio/sms', { Body: 'STOP' }));
  const newerStop = await app.records();
  ok(await app.webhook('/twilio/sms', { Body: 'START', OptOutType: 'START', MessageSid: startId }));
  assert.deepEqual(await app.records(), newerStop, 'An old START cannot undo a newer STOP');
  await app.restart();
  assert.deepEqual(await app.records(), newerStop);
  ok(await app.webhook('/twilio/voice')); assert.equal(await app.sends(), 0);
});

test('HTTP: provider HELP is not duplicated and never enters the booking conversation', async (t) => {
  const app = await fixture(t);
  await app.grant();
  ok(await app.webhook('/twilio/sms', { Body: 'HELP', OptOutType: 'HELP' }));
  assert.equal(await app.sends(), 0);
  assert.equal((await app.store()).leads.length, 0);
  ok(await app.webhook('/twilio/sms', { Body: 'HELP' }));
  assert.equal(await app.sends(), 1);
  assert.match(await app.log(), /hello@trybuzzcall.com/);
  ok(await app.webhook('/twilio/sms', { Body: 'Hi, can I book a visit?' }));
  const record = (await app.store()).leads[0];
  assert.equal(record.name, null);
  assert.equal(record.step, 'name');
  assert.match(await app.log(), /What is your name/);
});

test('HTTP: owner alerts need their own permission and completed-message retries do not resend', async (t) => {
  const app = await fixture(t);
  await app.grant(); await app.grant(OWNER); // Wrong scope for owner alerts.
  ok(await app.webhook('/twilio/voice'));
  for (const Body of ['Dana', 'Water heater maintenance', 'after 3pm']) ok(await app.webhook('/twilio/sms', { Body }));
  assert.equal(await app.sends(), 4);
  assert.equal((await app.store()).alerts[0].sent, false);
  await app.grant(OWNER, 'owner_alerts'); await app.grant(SECOND);
  ok(await app.webhook('/twilio/voice', { From: SECOND }));
  for (const Body of ['Alex', 'AC maintenance']) ok(await app.webhook('/twilio/sms', { From: SECOND, Body }));
  const last = { From: SECOND, Body: 'tomorrow morning', MessageSid: sid() };
  ok(await app.webhook('/twilio/sms', last));
  assert.equal(await app.sends(), 9);
  assert.equal((await app.store()).alerts[0].sent, true);
  const state = await app.store();
  ok(await app.webhook('/twilio/sms', last));
  assert.deepEqual(await app.store(), state);
  assert.equal(await app.sends(), 9);
});

test('HTTP: payment after customer and owner STOP updates booking but sends no confirmation', async (t) => {
  const app = await fixture(t, { BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1', LEAD_FEE_WAIVED: '1' });
  await app.grant(); await app.grant(OWNER, 'owner_alerts');
  ok(await app.webhook('/twilio/voice'));
  for (const Body of ['Dana', 'Scheduled water heater service', '1']) ok(await app.webhook('/twilio/sms', { Body }));
  const booking = (await app.store()).bookings[0];
  assert.equal(booking.status, 'held');
  const count = await app.sends();
  ok(await app.webhook('/twilio/sms', { Body: 'STOP' }));
  ok(await app.webhook('/twilio/sms', { From: OWNER, Body: 'STOP' }));
  ok(await app.request(`/pay/mock/${booking.id}`)); // Safe: isolated child has no Stripe credentials.
  assert.equal((await app.store()).bookings[0].paid, true);
  assert.equal(await app.sends(), count);
  assert.equal((await app.store()).alerts[0].sent, false);
  assert.equal((await app.store()).leads[0].messages.at(-1).dir, 'blocked');
});

test('HTTP: inactive-service messages cannot bypass consent or opt-out', async (t) => {
  const app = await fixture(t, { BILLING_REQUIRE_SUBSCRIPTION: '1', INACTIVE_MODE: 'generic' });
  ok(await app.webhook('/twilio/voice'));
  assert.equal(await app.sends(), 0);
  await app.grant();
  ok(await app.webhook('/twilio/voice'));
  assert.equal(await app.sends(), 1);
  ok(await app.webhook('/twilio/sms', { Body: 'STOP' }));
  ok(await app.webhook('/twilio/sms', { Body: 'HELP' }));
  ok(await app.webhook('/twilio/voice'));
  assert.equal(await app.sends(), 1);
});

test('HTTP: grants survive a restart but cannot cross business or sender identities', async (t) => {
  const app = await fixture(t);
  await app.grant();
  const record = await app.records();
  await app.restart();
  assert.deepEqual(await app.records(), record);
  ok(await app.webhook('/twilio/voice')); assert.equal(await app.sends(), 1);
  await app.restart({ SMS_CONSENT_BUSINESS_ID: 'other-shop' });
  assert.deepEqual(await app.records(), []);
  ok(await app.webhook('/twilio/voice')); assert.equal(await app.sends(), 1);
  await app.restart({ SMS_CONSENT_BUSINESS_ID: 'test-shop', TWILIO_PHONE_NUMBER: SECOND });
  assert.deepEqual(await app.records(), []);
  ok(await app.webhook('/twilio/voice', { To: SECOND })); assert.equal(await app.sends(), 1);
});

test('HTTP: live signatures, account and destination are mandatory despite the old skip flag', async (t) => {
  const app = await fixture(t, { SKIP_TWILIO_VALIDATION: '1' }, { provider: true });
  for (const route of ['/twilio/voice', '/twilio/voice/status', '/twilio/sms']) {
    const body = { Body: 'STOP', DialCallStatus: 'no-answer' };
    assert.equal((await app.webhook(route, body, { signed: false })).status, 403);
    assert.equal((await app.webhook(route, { ...body, AccountSid: `AC${'b'.repeat(32)}` })).status, 403);
    assert.equal((await app.webhook(route, { ...body, To: SECOND })).status, 403);
  }
  assert.deepEqual(await app.records(), []);
  assert.equal((await app.webhook('/twilio/sms', { Body: 'STOP', MessageSid: 'bad-id' })).status, 400);
  assert.equal((await app.webhook('/twilio/sms', { Body: 'STOP', From: 'anonymous' })).status, 400);
  assert.equal((await app.webhook('/twilio/sms', { Body: 'STOP', OptOutType: 'UNRECOGNIZED' })).status, 400);
  assert.deepEqual(await app.records(), []);
  await app.grant();
  ok(await app.webhook('/twilio/voice'));
  assert.equal(await app.sends(), 1);
  assert.equal(await app.log(), '', 'Live bodies must not enter the simulation log');
  ok(await app.webhook('/twilio/sms', { Body: 'STOP', OptOutType: 'STOP' }));
  ok(await app.webhook('/twilio/voice'));
  assert.equal(await app.sends(), 1);
});

test('HTTP: YES fallback only clears the provider block, without restoring grants or replying', async (t) => {
  const app = await fixture(t, {}, { provider: true });
  await app.grant(); await app.grant(CALLER, 'owner_alerts');
  ok(await app.webhook('/twilio/sms', { Body: 'STOP', OptOutType: 'STOP' }));
  assert.equal((await app.records())[0].providerBlocked, true);
  const yes = { Body: ' yes ', MessageSid: sid() }; // No OptOutType: exercise the fallback.
  const response = await app.webhook('/twilio/sms', yes);
  ok(response); assert.doesNotMatch(response.body, /<Message/);
  const records = await app.records();
  assert.equal(records[0].providerBlocked, false);
  missingGrants(records[0]);
  assert.equal(records[0].events.at(-1).type, 'provider_opt_in');
  ok(await app.webhook('/twilio/sms', yes));
  assert.deepEqual(await app.records(), records, 'Duplicate YES does not append another event');
  ok(await app.webhook('/twilio/sms', { From: SECOND, Body: 'YES' }));
  missingGrants((await app.records()).find((row) => row.phone === SECOND));
  for (const phone of [CALLER, SECOND]) {
    ok(await app.webhook('/twilio/voice', { From: phone }));
    ok(await app.webhook('/twilio/sms', { From: phone, Body: 'HELP' }));
    ok(await app.webhook('/twilio/sms', { From: phone, Body: 'Book me' }));
  }
  assert.equal(await app.sends(), 0);
  assert.equal((await app.store()).leads.length, 0);
});

test('HTTP: SIGTERM drains an in-flight send before closing consent and saving a clean session', async (t) => {
  const app = await fixture(t, {}, { provider: true, holdProvider: true });
  assert.equal((await app.store()).smsSessionClean, false, 'Boot persists the crash marker before traffic');
  assert.equal((await consentStatus(app)).recoveryRequired, false);
  await app.grant();
  const records = await app.records();
  // The fake provider cannot complete until released, so shutdown really has a request to drain.
  const pending = app.webhook('/twilio/voice').then((response) => ({ response }), (error) => ({ error }));
  let stopping;
  try {
    await eventually(async () => (await app.sends()) === 1, 'Provider send did not start');
    stopping = app.stop().then((exit) => ({ exit }), (error) => ({ error }));
    await eventually(app.terminating, 'Child did not receive SIGTERM');
    assert.equal((await app.store()).smsSessionClean, false, 'Pending work must keep the session unclean');
    await app.releaseProvider();
    const result = await pending;
    if (result.error) throw result.error;
    ok(result.response);
    const stopped = await stopping;
    if (stopped.error) throw stopped.error;
    assert.deepEqual(stopped.exit, { code: 0, signal: null }, 'SIGTERM must exit cleanly, not fall back to SIGKILL');
    const stored = await app.store();
    assert.equal(stored.smsSessionClean, true);
    assert.equal(stored.leads[0].messages.at(-1).dir, 'out', 'The drained send must be persisted');
    await app.restart();
    assert.equal((await app.store()).smsSessionClean, false);
    assert.equal((await consentStatus(app)).recoveryRequired, false);
    assert.deepEqual(await app.records(), records);
  } finally {
    await app.releaseProvider();
    await pending; // Never leave a request rejection or a gated provider behind.
    if (stopping) await stopping;
  }
});

test('HTTP: disconnected client cannot hide pending provider work from shutdown', async (t) => {
  const app = await fixture(t, {}, { provider: true, holdProvider: true });
  await app.grant();
  const controller = new AbortController();
  const pending = app.webhook('/twilio/voice', {}, { signal: controller.signal })
    .then(() => ({ aborted: false }), (error) => ({ aborted: error.code === 'ABORT_ERR' }));
  try {
    await eventually(async () => await app.sends() === 1, 'Provider was not reached');
    controller.abort();
    assert.equal((await pending).aborted, true);
    assert.deepEqual(await app.stop(), { code: 1, signal: null }, 'Unresolved provider work must not claim clean');
    assert.equal((await app.store()).smsSessionClean, false);
    await app.restart();
    assert.equal((await consentStatus(app)).recoveryRequired, true);
    ok(await app.webhook('/twilio/voice'));
    assert.equal(await app.sends(), 1, 'Older grants stay unusable after interrupted provider work');
  } finally {
    controller.abort();
    await pending;
    await app.releaseProvider();
  }
});

test('HTTP: real SIGKILL quarantines sends and grants until reviewed recovery with SMS disabled', async (t) => {
  const app = await fixture(t, { BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1' }, { provider: true });
  await app.grant(); await app.grant(SECOND); await app.grant(OWNER, 'owner_alerts');
  ok(await app.webhook('/twilio/voice'));
  for (const Body of ['Dana', 'Scheduled maintenance', '1']) ok(await app.webhook('/twilio/sms', { Body }));
  const before = await app.store(), booking = before.bookings[0];
  assert.equal(booking.status, 'held');
  const records = await app.records(), count = await app.sends();
  assert.equal(before.smsSessionClean, false);
  assert.deepEqual(await app.crash(), { code: null, signal: 'SIGKILL' });
  assert.equal((await app.store()).smsSessionClean, false);
  await app.restart();
  assert.equal((await consentStatus(app)).recoveryRequired, true);
  assert.deepEqual(await app.records(), records, 'Persisted grants remain visible but unusable');
  for (const purpose of ['customer_service', 'owner_alerts']) {
    assert.equal((await app.request('/api/consent', grantInput(SECOND, purpose), { admin: true })).status, 409);
  }
  for (const phone of [CALLER, SECOND]) {
    ok(await app.webhook('/twilio/voice', { From: phone }));
    ok(await app.webhook('/twilio/voice/status', { From: phone, DialCallStatus: 'no-answer' }));
    for (const Body of ['HELP', 'Please book me']) ok(await app.webhook('/twilio/sms', { From: phone, Body }));
  }
  ok(await app.request(`/pay/mock/${booking.id}`));
  assert.equal((await app.store()).bookings[0].paid, true);
  assert.equal((await app.store()).alerts[0].sent, false, 'Owner sends are quarantined too');
  assert.equal((await app.store()).leads.length, before.leads.length);
  assert.equal(await app.sends(), count);

  // Simulate operator reconciliation against retained/provider evidence: these opt-outs
  // were missing from the durable history at the time of the crash. Do this BEFORE recovery.
  ok(await app.webhook('/twilio/sms', { Body: 'STOP', OptOutType: 'STOP' }));
  ok(await app.request('/api/consent', { action: 'revoke', phone: OWNER }, { admin: true }));
  const reconciled = await app.records();
  missingGrants(reconciled.find((row) => row.phone === CALLER));
  missingGrants(reconciled.find((row) => row.phone === OWNER));
  assert.equal(reconciled.find((row) => row.phone === CALLER).providerBlocked, true);
  assert.equal((await consentStatus(app)).recoveryRequired, true, 'Revocations do not clear quarantine');
  const recovery = { action: 'recover', acknowledgment: 'suppression_history_reviewed' };
  assert.equal((await app.request('/api/consent', recovery, { admin: true })).status, 409, 'SMS must be off');
  assert.deepEqual(await app.stop(), { code: 1, signal: null }, 'Unrecovered shutdown cannot claim clean');
  assert.equal((await app.store()).smsSessionClean, false);
  await app.restart({ SMS_ENABLED: '0' });
  assert.equal((await consentStatus(app)).recoveryRequired, true);
  assert.equal((await app.request('/api/consent', recovery)).status, 401);
  assert.equal((await app.request('/api/consent', recovery, { admin: true, form: true })).status, 415);
  for (const Origin of ['https://attacker.example', 'null', `${app.origin()}.attacker.example`]) {
    assert.equal((await app.request('/api/consent', recovery, { admin: true, headers: { Origin } })).status, 403);
  }
  for (const input of [{ action: 'recover' }, { ...recovery, acknowledgment: 'yes' }, { ...recovery, phone: CALLER }]) {
    assert.equal((await app.request('/api/consent', input, { admin: true })).status, 400);
  }
  assert.equal((await consentStatus(app)).recoveryRequired, true);
  assert.equal((await app.request('/api/consent', grantInput(SECOND), { admin: true })).status, 409);
  const recovered = await app.request('/api/consent', recovery, { admin: true, headers: { Origin: app.origin() } });
  ok(recovered);
  assert.equal(JSON.parse(recovered.body).recoveryRequired, false);
  assert.equal(JSON.parse(recovered.body).persistenceFailed, false);
  assert.deepEqual(await app.records(), reconciled, 'Recovery must not restore revoked permissions');
  ok(await app.webhook('/twilio/voice', { From: SECOND }));
  assert.equal(await app.sends(), count, 'Recovery does not enable SMS');
  assert.deepEqual(await app.stop(), { code: 0, signal: null });
  assert.equal((await app.store()).smsSessionClean, true);
  await app.restart({ SMS_ENABLED: '1' });
  assert.equal((await consentStatus(app)).recoveryRequired, false);
  assert.deepEqual(await app.records(), reconciled);
  assert.equal((await app.request('/api/consent', grantInput(), { admin: true })).status, 409, 'Provider STOP survives recovery');
  for (const phone of [CALLER, OWNER]) ok(await app.webhook('/twilio/voice', { From: phone }));
  assert.equal(await app.sends(), count);
  ok(await app.webhook('/twilio/voice', { From: SECOND }));
  assert.equal(await app.sends(), count + 1, 'An unaffected existing grant works after clean restart');
  await app.grant(SECOND, 'owner_alerts');
  assert.ok((await app.records()).find((row) => row.phone === SECOND).permissions.owner_alerts,
    'New grants are available after recovery');
});

test('HTTP: Stripe requires a configured secret, authentic signatures and paid status before onPaid', async (t) => {
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
    await t.test(type, async (t) => {
      const app = await fixture(t, { BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1', LEAD_FEE_WAIVED: '1' }, { provider: true });
      await app.grant(); await app.grant(OWNER, 'owner_alerts');
      ok(await app.webhook('/twilio/voice'));
      for (const Body of ['Dana', 'Scheduled maintenance', '1']) ok(await app.webhook('/twilio/sms', { Body }));
      const booking = (await app.store()).bookings[0], count = await app.sends();
      assert.equal(booking.status, 'held');
      assert.equal(booking.paid, false);
      const paid = paymentEvent(booking.id, type);
      const unchanged = async () => {
        assert.deepEqual((await app.store()).bookings[0], booking);
        assert.equal(await app.sends(), count);
      };
      assert.equal((await app.request('/stripe/webhook', paid)).status, 503);
      await unchanged();
      // Generated locally, never persisted or printed; all SDK network transports remain blocked.
      const secret = randomBytes(32).toString('hex');
      await app.restart({ STRIPE_WEBHOOK_SECRET: secret });
      assert.equal((await app.request('/stripe/webhook', paid)).status, 400);
      await unchanged();
      assert.equal((await signedPayment(app, paid, randomBytes(32).toString('hex'))).status, 400);
      await unchanged();
      const otherPayload = paymentEvent(booking.id, type, 'unpaid');
      const signature = stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(otherPayload), secret });
      assert.equal((await app.request('/stripe/webhook', paid, { headers: { 'Stripe-Signature': signature } })).status, 400);
      await unchanged();
      for (const status of ['unpaid', 'no_payment_required', 'PAID', null, true, undefined]) {
        const event = paymentEvent(booking.id, type, status);
        if (status === undefined) delete event.data.object.payment_status;
        ok(await signedPayment(app, event, secret));
        await unchanged();
      }
      const unrelated = paymentEvent(booking.id, 'checkout.session.expired');
      ok(await signedPayment(app, unrelated, secret));
      await unchanged();
      ok(await app.webhook('/twilio/sms', { Body: 'STOP' }));
      ok(await app.webhook('/twilio/sms', { From: OWNER, Body: 'STOP' }));
      // Exercise both accepted booking-ID locations, still using a real Stripe HMAC.
      if (type === 'checkout.session.async_payment_succeeded') {
        paid.data.object.metadata = {};
        paid.data.object.client_reference_id = booking.id;
      }
      ok(await signedPayment(app, paid, secret));
      const stored = await app.store();
      assert.equal(stored.bookings[0].paid, true);
      assert.equal(stored.bookings[0].status, 'confirmed');
      assert.equal(stored.bookings[0].lead_fee_status, 'waived');
      assert.equal(stored.leads[0].messages.at(-1).dir, 'blocked');
      assert.equal(stored.alerts[0].sent, false);
      assert.equal(await app.sends(), count, 'Paid webhook cannot bypass customer or owner STOP');
      ok(await signedPayment(app, paid, secret));
      assert.deepEqual(await app.store(), stored, 'A duplicate signed payment is idempotent');
      assert.equal(await app.sends(), count);
      assert.equal(await app.log(), '', 'Provider isolation stays in effect for signed Stripe events');
    });
  }
});

test('HTTP: billing notifications require owner_alerts permission and honor subsequent STOP', async (t) => {
  const app = await fixture(t, { TRIAL_DAYS: '0' }, { provider: true });
  await app.grant(OWNER); // Customer-service permission is insufficient for billing alerts.
  const checkout = await app.request('/api/checkout', { plan: 'monthly', email: 'owner@example.test' });
  ok(checkout);
  ok(await app.request(`/billing/mock/checkout/${JSON.parse(checkout.body).id}/complete`, {}));
  const failRenewal = async () => {
    ok(await app.request('/billing/mock/fail-next', { on: '1' }, { admin: true }));
    const response = await app.request('/billing/mock/advance', { days: 32 }, { admin: true });
    ok(response);
    assert.equal(JSON.parse(response.body).subscription.status, 'past_due');
  };
  await failRenewal();
  assert.equal(await app.sends(), 0);
  assert.equal((await app.store()).alerts[0].sent, false);
  await app.grant(OWNER, 'owner_alerts');
  ok(await app.request('/billing/mock/update-card', {}, { admin: true }));
  await failRenewal();
  assert.equal(await app.sends(), 1);
  assert.equal((await app.store()).alerts[0].sent, true);
  assert.match((await app.store()).alerts[0].body, /BuzzCall billing/);
  ok(await app.webhook('/twilio/sms', { From: OWNER, Body: 'STOP' }));
  missingGrants((await app.records()).find((row) => row.phone === OWNER));
  ok(await app.request('/billing/mock/update-card', {}, { admin: true }));
  await failRenewal();
  assert.equal(await app.sends(), 1);
  assert.equal((await app.store()).alerts[0].sent, false);
});

test('HTTP: braiders booking needs customer permission and separately scoped owner alerts', async (t) => {
  const app = await fixture(t, { VERTICAL: 'braiders', BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1',
    SERVICES: 'Knotless braids:120,Twists:60' }, { provider: true });
  ok(await app.webhook('/twilio/voice'));
  ok(await app.webhook('/twilio/sms', { Body: '1 medium mid-back' }));
  assert.equal(await app.sends(), 0);
  assert.equal((await app.store()).leads.length, 0);
  assert.equal((await app.store()).bookings.length, 0);
  assert.deepEqual(await app.records(), []);
  await app.grant(); await app.grant(OWNER); // Wrong owner scope must still be suppressed.
  ok(await app.webhook('/twilio/voice'));
  for (const Body of ['Dana', '1 medium mid-back', 'soonest', '1']) ok(await app.webhook('/twilio/sms', { Body }));
  const booking = (await app.store()).bookings[0];
  assert.equal(booking.status, 'held');
  assert.equal(booking.service, 'Knotless braids');
  assert.equal(booking.details, 'medium mid-back');
  assert.equal(booking.amount, 50);
  assert.equal(Date.parse(booking.slotEnd) - Date.parse(booking.slotStart), 120 * 60000);
  assert.equal(await app.sends(), 5);
  assert.equal((await app.store()).alerts[0].sent, false);
  await app.grant(OWNER, 'owner_alerts');
  ok(await app.request(`/pay/mock/${booking.id}`));
  assert.equal((await app.store()).bookings[0].paid, true);
  assert.equal(await app.sends(), 7, 'Both scoped permissions allow their respective confirmations');
  assert.equal((await app.store()).alerts[0].sent, true);
  assert.match((await app.store()).alerts[0].body, /BOOKED \+ PAID: Dana, Knotless braids/);
  ok(await app.webhook('/twilio/sms', { Body: 'please opt me out' }));
  const stopped = await app.store();
  ok(await app.webhook('/twilio/voice'));
  ok(await app.webhook('/twilio/sms', { Body: 'Book another style' }));
  assert.equal(await app.sends(), 7);
  assert.deepEqual((await app.store()).bookings, stopped.bookings);
  assert.deepEqual((await app.store()).leads, stopped.leads);
});

test('HTTP: unsigned demo requires explicit local permission and never works in production', async (t) => {
  const app = await fixture(t, { ALLOW_UNSIGNED_TWILIO_WEBHOOKS: '' });
  assert.equal((await app.webhook('/twilio/voice')).status, 403);
  await app.restart({ ALLOW_UNSIGNED_TWILIO_WEBHOOKS: '1', NODE_ENV: 'production' });
  assert.equal((await app.webhook('/twilio/sms', { Body: 'STOP' })).status, 403);
  assert.deepEqual(await app.records(), []);
});
