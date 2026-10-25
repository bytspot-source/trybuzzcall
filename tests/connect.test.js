'use strict';
// Stripe Connect (direct charges, fail closed, per-shop account in the config override). No network: a fake Stripe
// client is injected with connect.setStripe(); webhook signatures are generated and checked offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-connect-'));
// Never read the developer's .env in tests.
require('dotenv').config = () => ({ parsed: {} });
const CLEAR = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'STRIPE_PRICE_ID_BASE_MONTHLY',
  'STRIPE_PRICE_ID_BASE_ANNUAL', 'STRIPE_PRICE_ID_SETUP', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'OPENAI_API_KEY', 'DATABASE_URL',
  'FORWARD_TO_PHONE', 'VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_TYPE', 'BUSINESS_HOURS', 'BUSINESS_DAYS', 'SERVICES', 'LEAD_FEE', 'LEAD_FEE_WAIVED', 'DEPOSIT_AMOUNT',
  'BOOKING_LINK', 'SLOT_MINUTES', 'BILLING_REQUIRE_SUBSCRIPTION', 'BILLING_ENFORCE'];
for (const k of CLEAR) process.env[k] = '';
const ADMIN = 'connect-test-pass';
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: ADMIN, BUSINESS_NAME: 'Test Plumbing',
  OWNER_PHONE: '+15550000000', BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1', BUSINESS_DAYS: '0,1,2,3,4,5,6', BUSINESS_HOURS: '00:00-23:59',
  BOOKING_LEAD_MINUTES: '0', PUBLIC_BASE_URL: 'https://shop.example' });

const Stripe = require('stripe');
const store = require('../src/store');
const config = require('../src/config');
const connect = require('../src/connect');
const booking = require('../src/booking');
const { app } = require('../src/server');

const TEST_KEY = 'sk_test_' + 'fake'.repeat(6); // never a real key; the fake client below is used
function fakeStripe(acct = {}) {
  const calls = { create: [], retrieve: [], links: [], sessions: [] };
  const account = { id: 'acct_test_shop1', charges_enabled: false, details_submitted: false, payouts_enabled: false,
    requirements: { currently_due: ['external_account'], disabled_reason: 'requirements.past_due' }, ...acct };
  const client = {
    calls, account,
    accounts: {
      create: async (p) => { calls.create.push(p); return { ...account }; },
      retrieve: async (id) => { calls.retrieve.push(id); return { ...account, id }; },
    },
    accountLinks: { create: async (p) => { calls.links.push(p); return { url: 'https://connect.stripe.com/setup/s/test_link' }; } },
    checkout: { sessions: { create: async (p, o) => { calls.sessions.push({ p, o }); return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }; } } },
  };
  return client;
}
// Fresh state per test: no Stripe key, no connect state, no bookings.
function reset(t, envOver = {}) {
  const saved = {};
  for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_CONNECT_ACCOUNT_ID', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'LEAD_FEE', 'LEAD_FEE_WAIVED', 'DEPOSIT_AMOUNT']) saved[k] = process.env[k];
  Object.assign(process.env, envOver);
  store.setOverride({});
  store.db.bookings.length = 0; store.db.leads.length = 0; store.db.alerts.length = 0;
  t.after(() => { Object.assign(process.env, saved); connect.setStripe(null); store.setOverride({}); });
}
const fakeBooking = (amount = 49) => {
  const b = { id: 'bk' + Math.random().toString(36).slice(2, 8), leadId: 'l1', phone: '+15551112222', name: 'Pat', need: 'leak',
    slotStart: new Date(Date.now() + 86400000).toISOString(), slotEnd: new Date(Date.now() + 86400000 + 7200000).toISOString(), slotLabel: 'Tomorrow 9-11',
    status: 'held', paid: false, amount, holdExpiresAt: new Date(Date.now() + 1800000).toISOString(), createdAt: new Date().toISOString() };
  store.db.bookings.unshift(b); return b;
};

let server, BASE;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  BASE = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const auth = { authorization: 'Basic ' + Buffer.from('admin:' + ADMIN).toString('base64') };
const req = (p, opts = {}) => fetch(BASE + p, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}) } });
const post = (p, body, headers = {}) => req(p, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', origin: BASE, ...auth, ...headers }, body: JSON.stringify(body || {}) });
const signed = (event, secret) => {
  const payload = JSON.stringify(event);
  return { body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }) } };
};
const sms = (from, Body) => req('/twilio/sms', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: from, Body }).toString() });
async function textToBooking(phone) {
  await sms(phone, 'Pat'); await sms(phone, 'leaky pipe'); await sms(phone, '1');
  return store.db.bookings.find((b) => b.phone === phone);
}
const quiet = (t) => { const o = console.error, l = console.log; console.error = () => {}; console.log = () => {}; t.after(() => { console.error = o; console.log = l; }); };

// ---------- fees ----------
test('application fee: waived = 0; else capped at amount-1c and at 1/3 of the deposit', () => {
  assert.equal(connect.applicationFeeCents(4900, 12, true), 0);
  assert.equal(connect.applicationFeeCents(4900, 12, false), 1200);
  assert.equal(connect.applicationFeeCents(2000, 12, false), 666); // 1/3 cap, not 60%
  assert.equal(connect.applicationFeeCents(100, 12, false), 33);
  assert.equal(connect.applicationFeeCents(2, 12, false), 0); // 1c cap would be >1/3: no fee at all
  assert.equal(connect.applicationFeeCents(5000, 0, false), 0);
});

test('LEAD_FEE_WAIVED defaults ON (pilot); only an explicit 0/false turns it off', (t) => {
  reset(t, { LEAD_FEE_WAIVED: '' });
  assert.equal(booking.cfg().leadFeeWaived, true);
  delete process.env.LEAD_FEE_WAIVED; assert.equal(booking.cfg().leadFeeWaived, true);
  process.env.LEAD_FEE_WAIVED = '0'; assert.equal(booking.cfg().leadFeeWaived, false);
  process.env.LEAD_FEE_WAIVED = '1'; assert.equal(booking.cfg().leadFeeWaived, true);
});

// ---------- depositLink: direct charges, fail closed ----------
test('fail closed: Stripe key but no connected account -> no Checkout Session, null link', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  const f = fakeStripe(); connect.setStripe(f);
  const b = fakeBooking();
  assert.equal(await booking.depositLink(b, 'https://shop.example'), null);
  assert.equal(f.calls.sessions.length, 0);
  assert.equal(b.payUrl, undefined);
});

test('fail closed: env account id that is not charges_enabled -> status checked with Stripe, still no session', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_ACCOUNT_ID: 'acct_env_1' });
  const f = fakeStripe(); connect.setStripe(f);
  assert.equal(await booking.depositLink(fakeBooking(), 'https://shop.example'), null);
  assert.deepEqual(f.calls.retrieve, ['acct_env_1']);
  assert.equal(f.calls.sessions.length, 0);
  assert.equal(connect.status(), 'pending');
  assert.equal(store.getOverride().stripeConnect.accountId, 'acct_env_1'); // status cached in the override
});

test('direct charge: session created ON the connected account, no transfer_data, fee waived by default', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_ACCOUNT_ID: 'acct_env_2' });
  const f = fakeStripe({ charges_enabled: true, details_submitted: true }); connect.setStripe(f);
  const b = fakeBooking(49);
  const url = await booking.depositLink(b, 'https://shop.example');
  assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(f.calls.sessions.length, 1);
  const { p, o } = f.calls.sessions[0];
  assert.deepEqual(o, { stripeAccount: 'acct_env_2' });
  assert.equal(p.mode, 'payment');
  assert.equal(p.metadata.bookingId, b.id); assert.equal(p.client_reference_id, b.id);
  assert.equal(p.payment_intent_data.transfer_data, undefined);
  assert.equal(p.payment_intent_data.application_fee_amount, undefined);
  assert.equal(p.payment_intent_data.metadata.bookingId, b.id);
  assert.equal(p.line_items[0].price_data.unit_amount, 4900);
  assert.equal(b.connectAccount, 'acct_env_2'); assert.equal(b.stripeSessionId, 'cs_test_1');
  assert.ok(!JSON.stringify(p).includes('transfer_data'));
});

test('direct charge with lead fee enabled: application_fee_amount capped at 1/3 of the deposit', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_ACCOUNT_ID: 'acct_env_3', LEAD_FEE_WAIVED: '0', LEAD_FEE: '12' });
  const f = fakeStripe({ charges_enabled: true }); connect.setStripe(f);
  await booking.depositLink(fakeBooking(20), 'https://shop.example');
  assert.equal(f.calls.sessions[0].p.payment_intent_data.application_fee_amount, 666);
  await booking.depositLink(fakeBooking(49), 'https://shop.example');
  assert.equal(f.calls.sessions[1].p.payment_intent_data.application_fee_amount, 1200);
});

test('mock mode (no key): /pay/mock link unchanged, no Stripe client used', async (t) => {
  reset(t);
  connect.setStripe(() => { throw new Error('must not call Stripe in mock mode'); });
  const b = fakeBooking();
  assert.equal(await booking.depositLink(b, 'https://shop.example'), `https://shop.example/pay/mock/${b.id}`);
  assert.equal(connect.depositsReady(), true);
});

test('a stored mock/test account never counts for different keys', (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  store.setOverride({ stripeConnect: { accountId: 'acct_mock_x', mode: 'mock', chargesEnabled: true } });
  assert.equal(connect.accountId(), null);
  assert.equal(connect.chargeAccount(), null);
  process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'x'.repeat(10);
  store.setOverride({ stripeConnect: { accountId: 'acct_t', mode: 'test', chargesEnabled: true } });
  assert.equal(connect.chargeAccount(), null);
});

// ---------- per-shop account in the config override ----------
test('connect state lives in the config override and survives Apply/Reset of the setup values', (t) => {
  reset(t);
  store.setOverride({ stripeConnect: { accountId: 'acct_keep', mode: 'mock', chargesEnabled: true } });
  config.apply({ BUSINESS_NAME: 'Crown' }, { setupId: 's1' });
  assert.equal(store.getOverride().stripeConnect.accountId, 'acct_keep');
  assert.equal(config.env.BUSINESS_NAME, 'Crown');
  config.clear();
  assert.equal(store.getOverride().stripeConnect.accountId, 'acct_keep');
  assert.equal(store.getOverride().values, undefined);
});

test('connect state persists in Postgres (buzz_kv config row) across a restart', async (t) => {
  quiet(t);
  const { newDb } = require('pg-mem');
  const mem = newDb(); const { Pool } = mem.adapters.createPg();
  const poolFactory = () => { const p = new Pool(); const q = p.query.bind(p);
    p.query = (sql, ...a) => { if (/^CREATE TABLE IF NOT EXISTS/.test(sql)) { try { mem.public.getTable('buzz_kv'); return Promise.resolve({ rows: [] }); } catch {} } return q(sql, ...a); };
    return p; };
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-cpg-')), d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-cpg-'));
  t.after(() => { fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true }); });
  const a = store.createStore({ dir: d1, databaseUrl: 'postgres://u:p@db.example/x', poolFactory });
  await a.init();
  a.setOverride({ values: { BUSINESS_NAME: 'X' }, stripeConnect: { accountId: 'acct_pg', mode: 'test', chargesEnabled: true } });
  await a.close();
  const b = store.createStore({ dir: d2, databaseUrl: 'postgres://u:p@db.example/x', poolFactory });
  assert.equal((await b.init()).backend, 'postgres');
  assert.equal(b.getOverride().stripeConnect.accountId, 'acct_pg');
  await b.close();
});

// ---------- admin onboarding ----------
test('onboarding routes require admin auth and same origin', async (t) => {
  reset(t);
  assert.equal((await req('/admin/connect/onboard', { method: 'POST' })).status, 403, 'no Origin: refused before auth');
  assert.equal((await req('/admin/connect/onboard', { method: 'POST', headers: { origin: BASE } })).status, 401);
  assert.equal((await req('/admin/connect/refresh')).status, 401);
  assert.equal((await req('/admin/connect/return')).status, 401);
  assert.equal((await req('/admin/connect/mock')).status, 401);
  assert.equal((await post('/admin/connect/onboard', {}, { origin: 'https://evil.example' })).status, 403);
});

test('live/test onboarding: creates a default-controller (Standard-equivalent) account once, then an Account Link', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  const f = fakeStripe(); connect.setStripe(f);
  const r1 = await req('/admin/connect/onboard', { method: 'POST', headers: { ...auth, origin: BASE } });
  assert.equal(r1.status, 303);
  assert.equal(r1.headers.get('location'), 'https://connect.stripe.com/setup/s/test_link');
  assert.equal(f.calls.create.length, 1);
  const p = f.calls.create[0];
  assert.equal(p.type, undefined);
  assert.deepEqual(p.controller, { fees: { payer: 'account' }, losses: { payments: 'stripe' }, requirement_collection: 'stripe', stripe_dashboard: { type: 'full' } });
  assert.equal(p.business_profile.name, 'Test Plumbing');
  assert.equal(p.business_profile.url, 'https://shop.example');
  assert.deepEqual(f.calls.links[0], { account: 'acct_test_shop1', type: 'account_onboarding',
    refresh_url: 'https://shop.example/admin/connect/refresh', return_url: 'https://shop.example/admin/connect/return' });
  assert.equal(store.getOverride().stripeConnect.accountId, 'acct_test_shop1');
  assert.equal(store.getOverride().stripeConnect.mode, 'test');
  // refresh re-issues a link for the SAME account
  const r2 = await req('/admin/connect/refresh', { headers: auth });
  assert.equal(r2.status, 303);
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.links.length, 2);
  // return re-reads the account; status follows charges_enabled
  let s = await (await req('/admin/connect/return', { headers: { ...auth, accept: 'application/json' } })).json();
  assert.equal(s.status, 'pending');
  f.account.charges_enabled = true; f.account.details_submitted = true; f.account.requirements = { currently_due: [] };
  const r3 = await req('/admin/connect/return', { headers: auth });
  assert.equal(r3.status, 303); assert.equal(r3.headers.get('location'), '/admin#connect');
  assert.equal(connect.status(), 'charges_enabled');
  const html = await (await req('/admin', { headers: auth })).text();
  assert.match(html, /Deposit payouts \(Stripe Connect\)/);
  assert.match(html, /Charges enabled/);
  // mock onboarding page is off when Stripe is configured
  assert.equal((await req('/admin/connect/mock', { headers: auth })).status, 404);
});

test('admin shows Not connected + Connect Stripe button; mock onboarding enables charges without Stripe', async (t) => {
  reset(t);
  connect.setStripe(() => { throw new Error('no Stripe calls in mock mode'); });
  let html = await (await req('/admin', { headers: auth })).text();
  assert.match(html, /Status: <b>Not connected<\/b>/);
  assert.match(html, /action="\/admin\/connect\/onboard"/);
  const r = await req('/admin/connect/onboard', { method: 'POST', headers: { ...auth, origin: BASE } });
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), 'https://shop.example/admin/connect/mock');
  assert.match(connect.accountId(), /^acct_mock_/);
  assert.equal(connect.status(), 'pending');
  assert.equal((await req('/admin/connect/mock', { headers: auth })).status, 200);
  const done = await post('/admin/connect/mock/complete');
  assert.equal((await done.json()).status, 'charges_enabled');
  html = await (await req('/admin', { headers: auth })).text();
  assert.match(html, /Charges enabled/);
  const h = await (await req('/health')).json();
  assert.equal(h.connectStatus, 'charges_enabled'); assert.equal(h.connect, false); // mock never counts as live connect
});

// ---------- text flow ----------
test('text flow, Stripe on but not connected: booked without deposit, owner told "deposit off: Stripe not connected"', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  quiet(t);
  const f = fakeStripe(); connect.setStripe(f);
  const b = await textToBooking('+14703330001');
  assert.ok(b);
  assert.equal(b.status, 'confirmed'); assert.equal(b.amount, 0); assert.equal(b.depositSkipped, 'stripe_not_connected');
  assert.equal(f.calls.sessions.length, 0);
  const lead = store.db.leads.find((l) => l.phone === '+14703330001');
  assert.match(lead.messages.at(-1).body, /You're booked/);
  assert.doesNotMatch(lead.messages.at(-1).body, /deposit/i);
  assert.ok(store.db.alerts.some((a) => /deposit off: Stripe not connected/.test(a.body)));
});

test('text flow, connected + charges enabled: deposit link is a direct-charge Checkout on the shop account', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  quiet(t);
  const f = fakeStripe({ charges_enabled: true }); connect.setStripe(f);
  store.setOverride({ stripeConnect: { accountId: 'acct_ready', mode: 'test', chargesEnabled: true } });
  const b = await textToBooking('+14703330002');
  assert.equal(b.status, 'held');
  assert.deepEqual(f.calls.sessions[0].o, { stripeAccount: 'acct_ready' });
  const lead = store.db.leads.find((l) => l.phone === '+14703330002');
  assert.match(lead.messages.at(-1).body, /checkout\.stripe\.com/);
});

test('text flow, mock mode: /pay/mock unchanged and marks the deposit paid', async (t) => {
  reset(t);
  quiet(t);
  const b = await textToBooking('+14703330003');
  assert.equal(b.status, 'held');
  assert.equal(b.payUrl, `https://shop.example/pay/mock/${b.id}`);
  assert.equal((await req(`/pay/mock/${b.id}`)).status, 200);
  assert.equal(store.findBooking(b.id).paid, true);
});

// ---------- Connect webhook ----------
const SECRET = 'whsec_' + 'testsecret'.repeat(3);
const paidEvent = (account, bookingId, extra = {}) => ({ id: 'evt_' + Math.random().toString(36).slice(2), type: 'checkout.session.completed', account, livemode: false,
  data: { object: { id: 'cs_test_1', mode: 'payment', payment_status: 'paid', metadata: { bookingId }, client_reference_id: bookingId } }, ...extra });

test('connect webhook: bad signature rejected (400)', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_WEBHOOK_SECRET: SECRET });
  store.setOverride({ stripeConnect: { accountId: 'acct_ready', mode: 'test', chargesEnabled: true } });
  const b = fakeBooking();
  const s = signed(paidEvent('acct_ready', b.id), 'whsec_wrong');
  assert.equal((await req('/stripe/connect/webhook', { method: 'POST', ...s })).status, 400);
  assert.equal((await req('/stripe/connect/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(paidEvent('acct_ready', b.id)) })).status, 400);
  assert.equal(store.findBooking(b.id).paid, false);
});

test('connect webhook: no secret with Stripe configured -> refused (503), nothing applied', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_WEBHOOK_SECRET: '' });
  store.setOverride({ stripeConnect: { accountId: 'acct_ready', mode: 'test', chargesEnabled: true } });
  const b = fakeBooking();
  const r = await req('/stripe/connect/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(paidEvent('acct_ready', b.id)) });
  assert.equal(r.status, 503);
  assert.equal(store.findBooking(b.id).paid, false);
});

test('connect webhook: event for another connected account is acknowledged but ignored', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_WEBHOOK_SECRET: SECRET });
  store.setOverride({ stripeConnect: { accountId: 'acct_ready', mode: 'test', chargesEnabled: true } });
  const b = fakeBooking();
  for (const acct of ['acct_other_shop', undefined]) {
    const r = await req('/stripe/connect/webhook', { method: 'POST', ...signed(paidEvent(acct, b.id), SECRET) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ignored, 'account mismatch');
  }
  // livemode mismatch (live event, test keys)
  const r = await req('/stripe/connect/webhook', { method: 'POST', ...signed(paidEvent('acct_ready', b.id, { livemode: true }), SECRET) });
  assert.equal((await r.json()).ignored, 'livemode mismatch');
  assert.equal(store.findBooking(b.id).paid, false);
});

test('connect webhook: checkout.session.completed marks the deposit paid once (idempotent)', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_WEBHOOK_SECRET: SECRET });
  quiet(t);
  store.setOverride({ stripeConnect: { accountId: 'acct_ready', mode: 'test', chargesEnabled: true } });
  const b = fakeBooking(); b.connectAccount = 'acct_ready';
  for (let i = 0; i < 2; i++) {
    const r = await req('/stripe/connect/webhook', { method: 'POST', ...signed(paidEvent('acct_ready', b.id), SECRET) });
    assert.equal(r.status, 200); assert.equal((await r.json()).ignored, undefined);
  }
  const x = store.findBooking(b.id);
  assert.equal(x.paid, true); assert.equal(x.status, 'confirmed'); assert.equal(x.lead_fee_status, 'waived');
  const paidAlerts = store.db.alerts.filter((a) => /BOOKED \+ PAID/.test(a.body));
  assert.equal(paidAlerts.length, 1);
  assert.match(paidAlerts[0].body, /refunds from your Stripe Dashboard/);
});

test('connect webhook: unpaid (async) session does not mark paid; booking tied to another account is ignored', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_WEBHOOK_SECRET: SECRET });
  store.setOverride({ stripeConnect: { accountId: 'acct_ready', mode: 'test', chargesEnabled: true } });
  const b = fakeBooking();
  const ev = paidEvent('acct_ready', b.id); ev.data.object.payment_status = 'unpaid';
  await req('/stripe/connect/webhook', { method: 'POST', ...signed(ev, SECRET) });
  assert.equal(store.findBooking(b.id).paid, false);
  b.connectAccount = 'acct_old';
  const r = await req('/stripe/connect/webhook', { method: 'POST', ...signed(paidEvent('acct_ready', b.id), SECRET) });
  assert.equal((await r.json()).ignored, 'booking account mismatch');
  assert.equal(store.findBooking(b.id).paid, false);
});

test('connect webhook: account.updated sets status; deauthorized turns deposits off', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_WEBHOOK_SECRET: SECRET });
  quiet(t);
  store.setOverride({ stripeConnect: { accountId: 'acct_ready', mode: 'test', chargesEnabled: false } });
  const upd = (o) => ({ id: 'evt_u' + Math.random(), type: 'account.updated', account: 'acct_ready', livemode: false, data: { object: { id: 'acct_ready', ...o } } });
  await req('/stripe/connect/webhook', { method: 'POST', ...signed(upd({ charges_enabled: true, details_submitted: true, payouts_enabled: true, requirements: { currently_due: [] } }), SECRET) });
  assert.equal(connect.status(), 'charges_enabled'); assert.equal(connect.summary().payoutsEnabled, true);
  // another account's update can't change ours
  await req('/stripe/connect/webhook', { method: 'POST', ...signed({ ...upd({ charges_enabled: false }), account: 'acct_x', data: { object: { id: 'acct_x', charges_enabled: false } } }, SECRET) });
  assert.equal(connect.status(), 'charges_enabled');
  await req('/stripe/connect/webhook', { method: 'POST', ...signed(upd({ charges_enabled: false, requirements: { currently_due: ['individual.id_number'] } }), SECRET) });
  assert.equal(connect.status(), 'pending'); assert.deepEqual(connect.summary().requirementsDue, ['individual.id_number']);
  const de = { id: 'evt_d', type: 'account.application.deauthorized', account: 'acct_ready', livemode: false, data: { object: { id: 'ca_x' } } };
  await req('/stripe/connect/webhook', { method: 'POST', ...signed(de, SECRET) });
  assert.equal(connect.status(), 'not_connected'); assert.equal(connect.chargeAccount(), null);
});

test('platform webhook (/stripe/webhook) still works for deposits in mock/dev mode', async (t) => {
  reset(t);
  quiet(t);
  const b = fakeBooking();
  const r = await req('/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'evt_p', type: 'checkout.session.completed', data: { object: { mode: 'payment', payment_status: 'paid', metadata: { bookingId: b.id } } } }) });
  assert.equal(r.status, 200);
  assert.equal(store.findBooking(b.id).paid, true);
});

test('/health reports connect readiness without exposing anything secret', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  store.setOverride({ stripeConnect: { accountId: 'acct_ready', mode: 'test', chargesEnabled: true } });
  const h = await (await req('/health')).json();
  assert.equal(h.connect, true); assert.equal(h.connectStatus, 'charges_enabled');
  assert.ok(!JSON.stringify(h).includes(TEST_KEY));
});

test('legal drafts: shop is merchant of record/payee, Stripe Connected Account Agreement linked, review notes kept', () => {
  const terms = fs.readFileSync(path.join(__dirname, '../public/terms.html'), 'utf8');
  const refunds = fs.readFileSync(path.join(__dirname, '../public/refunds.html'), 'utf8');
  assert.match(terms, /merchant of record/);
  assert.match(terms, /payee/);
  assert.match(terms, /processed by Stripe|Payments are processed by Stripe/);
  assert.match(terms, /href="https:\/\/stripe\.com\/connect-account\/legal"/);
  assert.match(terms, /TODO\(legal\)/); assert.match(terms, /pending review by legal counsel/);
  assert.match(refunds, /TODO\(legal\)/); assert.match(refunds, /pending review by legal counsel/);
  assert.match(refunds, /own Stripe account/);
});
