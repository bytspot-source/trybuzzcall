'use strict';
// Fraud/abuse hardening for deposits, webhooks, disputes, and onboarding.
// No Stripe or Twilio network: fake clients and signed webhook fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-harden-'));
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'STRIPE_CONNECT_WEBHOOK_SECRET',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'DATABASE_URL', 'RESEND_API_KEY', 'DEMO_MODE',
  'AUTO_ONBOARDING', 'AUTO_PROVISION_NUMBERS', 'AUTO_A2P', 'AUTO_SPEND_APPROVAL', 'CAPTCHA_REQUIRED', 'LOOKUP_REJECT_VOIP',
  'OTP_MAX_PER_DAY', 'DEPOSIT_AMOUNT_MAX', 'DEPOSIT_DAILY_MAX_COUNT', 'DEPOSIT_DAILY_MAX_DOLLARS', 'NEW_VENDOR_HOLD_DAYS',
  'NEW_VENDOR_HOLD_JOBS', 'EIN_TTL_HOURS', 'EIN_ENCRYPTION_KEY', 'OUTBOUND_MAX_PER_HOUR', 'OUTBOUND_MAX_PER_DAY']) delete process.env[k];
const ADMIN = 'harden-test-password';
const SECRET = 'whsec_harden_test';
const TEST_KEY = 'sk_test_' + 'notreal'.repeat(4);
Object.assign(process.env, {
  DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: ADMIN,
  BUSINESS_NAME: 'Harden Plumbing', OWNER_PHONE: '+15550000077', BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1',
  BUSINESS_DAYS: '0,1,2,3,4,5,6', BUSINESS_HOURS: '00:00-23:59', BOOKING_LEAD_MINUTES: '0',
  PUBLIC_BASE_URL: 'http://shop.example', DEPOSIT_RELEASE_HOURS: '24', OUTBOUND_MAX_PER_HOUR: '0', OUTBOUND_MAX_PER_DAY: '0',
});

const Stripe = require('stripe');
const store = require('../src/store');
const connect = require('../src/connect');
const booking = require('../src/booking');
const deposits = require('../src/deposits');
const disputes = require('../src/disputes');
const vendors = require('../src/vendors');
const sms = require('../src/sms');
const captcha = require('../src/captcha');
const lookup = require('../src/lookup');
const onboardingStore = require('../src/onboardingStore');
const { app } = require('../src/server');

const auth = { authorization: 'Basic ' + Buffer.from('admin:' + ADMIN).toString('base64') };
let server, base;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function reset(t, env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  store.setOverride({});
  store.db.bookings = [];
  store.db.leads = [];
  store.db.alerts = [];
  store.db.deposits = [];
  store.db.vendorDebt = {};
  store.db.depositsMeta = { offsetMs: 0, events: [] };
  store.db.voiceConsents = [];
  store.db.optOuts = {};
  store.root.db.paymentIndex = {};
  store.root.db.moneyAudit = [];
  store.root.db.photoHashes = {};
  store.root.db.noshowClaims = {};
  store.root.db.flaggedCustomers = {};
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    connect.setStripe(null);
    captcha.setVerifier(null);
    lookup.setLookup(null);
    sms.resetCap();
  });
}
function bookingRow(amount = 49, extra = {}) {
  const start = Date.now() + 2 * 3600000;
  const b = {
    id: 'bk' + Math.random().toString(36).slice(2, 10), leadId: 'l1', phone: '+15551110000', name: 'Pat', need: 'leak',
    slotStart: new Date(start).toISOString(), slotEnd: new Date(start + 7200000).toISOString(), slotLabel: 'Soon',
    status: 'held', paid: false, amount, stripeSessionId: 'cs_match',
    holdExpiresAt: new Date(Date.now() + 1800000).toISOString(), createdAt: new Date().toISOString(), ...extra,
  };
  store.db.bookings.unshift(b);
  return b;
}
function paid(amount = 49, extra = {}) {
  const b = bookingRow(amount, { status: 'confirmed', paid: true, paidAt: new Date().toISOString(), ...extra });
  const d = deposits.onBookingPaid(b, { chargeId: extra.chargeId || 'ch_test', paymentIntentId: extra.paymentIntentId || 'pi_test', ...extra.payment });
  d.releaseAt = new Date(Date.now() - 1000).toISOString();
  return { b, d };
}
function fakeStripe() {
  const calls = { transfers: [], reversals: [], refunds: [], disputes: [] };
  const client = {
    calls,
    transfers: {
      create: async (p, o) => { calls.transfers.push({ p, o }); return { id: 'tr_test', amount: p.amount }; },
      createReversal: async (id, p, o) => { calls.reversals.push({ id, p, o }); return { id: 'trr_test' }; },
    },
    refunds: { create: async (p, o) => { calls.refunds.push({ p, o }); return { id: 're_test' }; } },
    disputes: { update: async (id, p) => { calls.disputes.push({ id, p }); return { id }; } },
    paymentIntents: { retrieve: async (id) => ({ id, latest_charge: 'ch_from_pi' }) },
  };
  connect.setStripe(client);
  return client;
}
const signed = (event, secret = SECRET) => {
  const payload = JSON.stringify(event);
  return { payload, signature: Stripe.webhooks.generateTestHeaderString({ payload, secret }) };
};
function postRaw(pathname, { body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: pathname, headers: {
      host: 'shop.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers,
    } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('P1: signed connect webhook pays a vendor booking and rejects a bad session', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_CONNECT_WEBHOOK_SECRET: SECRET });
  const created = await vendors.create({ name: 'Vendor Harden', email: 'vendor-harden@example.com', values: { BUSINESS_TYPE: 'plumbing', BUSINESS_NAME: 'Vendor Harden' } });
  const shop = vendors.get(created.shop.id);
  const bookingId = await vendors.run(shop.id, () => {
    store.setOverride({ stripeConnect: { accountId: 'acct_vendor_ok', mode: 'test', chargesEnabled: true, source: 'onboarding', payoutsApproved: true } });
    const b = bookingRow(49, { stripeSessionId: 'cs_vendor_ok', phone: '+14045550111', connectAccount: 'acct_vendor_ok' });
    store.save();
    return b.id;
  });
  let n = 0;
  const session = (over = {}) => ({
    id: `evt_vendor_${n++}`, type: 'checkout.session.completed', livemode: false, account: 'acct_vendor_ok',
    data: { object: { id: 'cs_vendor_ok', mode: 'payment', payment_status: 'paid', amount_total: 4900, currency: 'usd',
      client_reference_id: bookingId, metadata: { bookingId, shopId: shop.id },
      payment_intent: { id: 'pi_vendor', latest_charge: 'ch_vendor' }, ...over } },
  });
  const postConnect = (signedEvent) => postRaw('/stripe/connect/webhook', { body: signedEvent.payload, headers: { 'stripe-signature': signedEvent.signature } });
  const badRef = signed(session({ client_reference_id: 'other-booking' }));
  const ignored = await postConnect(badRef);
  assert.equal(ignored.status, 200);
  assert.match(ignored.body, /ignored/);
  const badAmount = signed(session({ amount_total: 100, client_reference_id: bookingId }));
  const amountRes = await postConnect(badAmount);
  assert.match(amountRes.body, /amount/);
  const ok = signed(session());
  const paidRes = await postConnect(ok);
  assert.equal(paidRes.status, 200, paidRes.body);
  assert.equal(JSON.parse(paidRes.body).received, true);
  assert.equal(JSON.parse(paidRes.body).ignored, undefined);
  const row = await vendors.run(shop.id, () => {
    const b = store.findBooking(bookingId);
    const d = deposits.findByBooking(bookingId);
    return { paid: b.paid, chargeId: d && d.chargeId, mode: d && d.stripeMode, livemode: d && d.livemode, pi: d && d.paymentIntentId };
  });
  assert.equal(row.paid, true);
  assert.equal(row.chargeId, 'ch_vendor');
  assert.equal(row.pi, 'pi_vendor');
  assert.equal(row.mode, 'test');
  assert.equal(row.livemode, false);
  assert.equal(store.root.db.paymentIndex.pi_vendor.shopId, shop.id);
});

test('P2/P6: livemode guard, source_transaction, debt after success, amount in the idempotency key', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  const f = fakeStripe();
  store.setOverride({ stripeConnect: { accountId: 'acct_express_1', mode: 'test', chargesEnabled: true, source: 'onboarding' } });
  deposits.setVendorDebt('acct_express_1', 500);
  const { d } = paid(49);
  assert.equal(d.stripeMode, 'test');
  assert.equal(d.livemode, false);
  d.stripeMode = 'live';
  assert.equal((await deposits.releaseDeposit(d)).reason, 'direct_model');
  assert.equal(deposits.vendorDebt('acct_express_1'), 500, 'debt untouched on mode mismatch');
  assert.equal(f.calls.transfers.length, 0, 'no platform transfer in the direct model');
  const archived = deposits.archiveNonLive();
  assert.ok(archived.archived >= 1);
  assert.equal(d.archived, true);
});

test('P5: direct charges do not release or refund from BuzzCall', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  fakeStripe();
  store.setOverride({ stripeConnect: { accountId: 'acct_express_1', mode: 'test', chargesEnabled: true, source: 'onboarding' } });
  const { d } = paid(40);
  assert.equal((await deposits.releaseDeposit(d)).reason, 'direct_model');
  assert.equal((await deposits.refundDeposit(d)).reason, 'vendor_dashboard');
  assert.equal(d.status, 'recorded');
});

test('P5/P14: partial refund does not mark the deposit refunded; full refund after release reverses', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  const f = fakeStripe();
  store.setOverride({ stripeConnect: { accountId: 'acct_express_1', mode: 'test', chargesEnabled: true, source: 'onboarding' } });
  const { d } = paid(49, { paymentIntentId: 'pi_part', chargeId: 'ch_part' });
  await deposits.handleWebhookEvent({ type: 'charge.refunded', livemode: false, data: { object: { id: 'ch_part', payment_intent: 'pi_part', amount: 4900, amount_refunded: 1000, refunded: false } } });
  assert.notEqual(d.status, 'refunded');
  assert.equal(d.partialRefund, true);
  assert.equal(d.refundedCents, 1000);
  assert.equal(f.calls.reversals.length, 0, 'the shop refunds in Stripe; BuzzCall does not reverse a transfer');
  await deposits.handleWebhookEvent({ type: 'charge.refunded', livemode: false, data: { object: { id: 'ch_part', payment_intent: 'pi_part', amount: 4900, amount_refunded: 4900, refunded: true } } });
  assert.equal(d.status, 'refunded');
});

test('P3: dispute, early fraud warning, refund update, payout failure, and new-vendor hold', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  const f = fakeStripe();
  const alerts = [];
  deposits.setAlert(async (msg, subject) => { alerts.push({ msg, subject }); });
  t.after(() => deposits.setAlert(null));
  store.setOverride({ stripeConnect: { accountId: 'acct_express_1', mode: 'test', chargesEnabled: true, source: 'onboarding' } });
  const { d } = paid(49, { paymentIntentId: 'pi_disp', chargeId: 'ch_disp' });
  await deposits.handleWebhookEvent({ type: 'charge.dispute.created', livemode: false, data: { object: { id: 'dp_1', charge: 'ch_disp', payment_intent: 'pi_disp', amount: 4900, reason: 'fraudulent', status: 'needs_response' } } });
  assert.equal(d.cardDispute.id, 'dp_1');
  assert.equal(d.reputation, 'card_dispute');
  assert.equal(f.calls.disputes.length, 0);
  assert.match(alerts.at(-1).subject, /dispute/);
  const { d: released } = paid(20, { paymentIntentId: 'pi_efw', chargeId: 'ch_efw' });
  await deposits.handleWebhookEvent({ type: 'radar.early_fraud_warning.created', livemode: false, data: { object: { id: 'issfr_1', charge: 'ch_efw', payment_intent: 'pi_efw', fraud_type: 'unauthorized_use_of_card' } } });
  assert.notEqual(released.status, 'refunded');
  assert.ok(released.fraudWarning);
  await deposits.handleWebhookEvent({ type: 'charge.refund.updated', livemode: false, data: { object: { id: 're_x', status: 'failed', charge: 'ch_missing' } } });
  assert.ok(alerts.some((a) => /refund update/i.test(a.subject)));
  await deposits.handleWebhookEvent({ type: 'payout.failed', livemode: false, data: { object: { id: 'po_1', failure_code: 'account_closed' } } });
  assert.ok(alerts.some((a) => /payout failed/i.test(a.subject)));

  const shop = (await vendors.create({ name: 'New Vendor Hold', email: 'hold-vendor@example.com', values: { BUSINESS_TYPE: 'plumbing', BUSINESS_NAME: 'New Vendor Hold' } })).shop;
  await vendors.run(shop.id, async () => {
    store.setOverride({ stripeConnect: { accountId: 'acct_new', mode: 'test', chargesEnabled: true, source: 'onboarding' } });
    const b = bookingRow(30, { status: 'confirmed', paid: true, paidAt: new Date().toISOString(), phone: '+14045550177' });
    const row = deposits.onBookingPaid(b, { chargeId: 'ch_new', paymentIntentId: 'pi_new', livemode: false });
    assert.equal((await deposits.releaseDeposit(row)).reason, 'direct_model');
    assert.equal(row.status, 'recorded');
  });
});

test('P10: unverified env fallback is not attached and release waits for charges', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_ACCOUNT_ID: 'acct_env_unverified' });
  const { d } = paid(25);
  assert.equal(d.connectAccountId, null);
  assert.equal(d.payoutPendingConnect, true);
  assert.equal((await deposits.releaseDeposit(d)).reason, 'direct_model');
  assert.notEqual(d.connectAccountId, 'acct_env_unverified');
});

test('P13: only an exact NO or NOSHOW pauses the payout', (t) => {
  reset(t);
  store.setOverride({ stripeConnect: { accountId: 'acct_mock', mode: 'mock', chargesEnabled: true } });
  const samples = ['No problem, they were great', 'No worries thanks', 'no-show', 'NO SHOW', 'not today'];
  for (const body of samples) {
    const { b, d } = paid(10, { phone: '+1555000111' + samples.indexOf(body) });
    d.noshowSentAt = new Date().toISOString();
    d.phone = b.phone;
    assert.equal(deposits.handleNoshowReply(b.phone, body), null, body);
    assert.equal(d.status, 'recorded', body);
  }
  const { b, d } = paid(10, { phone: '+15550001999' });
  d.noshowSentAt = new Date().toISOString();
  d.phone = b.phone;
  assert.equal(deposits.handleNoshowReply(b.phone, 'NO!').answer, 'no');
  assert.equal(d.reputation, 'noshow');
  assert.equal(d.status, 'recorded');
  const again = paid(10, { phone: '+15550001888' });
  again.d.noshowSentAt = new Date().toISOString();
  again.d.phone = again.b.phone;
  assert.equal(deposits.handleNoshowReply(again.b.phone, 'noshow').answer, 'no');
});

test('P7: text-only evidence is not auto-released; reused photos and weak GPS are flagged', async (t) => {
  reset(t);
  store.setOverride({ stripeConnect: { accountId: 'acct_mock', mode: 'mock', chargesEnabled: true } });
  const { b, d } = paid(15, { phone: '+14045550222' });
  d.noshowSentAt = new Date().toISOString();
  d.phone = b.phone;
  deposits.handleNoshowReply(b.phone, 'NO');
  disputes.addEvidence(d, { source: 'sms', text: 'I was there, no photo' });
  d.dispute.followupSentAt = new Date().toISOString();
  d.dispute.autoReleaseAt = new Date(deposits.now() - 1000).toISOString();
  const tick = await deposits.tick({ sendSms: async () => ({ ok: true }) });
  assert.equal(tick.autoReleased, 0);
  assert.equal(d.dispute.adminReview, true);
  assert.equal(d.status, 'recorded');

  const photo = { type: 'image/jpeg', data: Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]).toString('base64'), bytes: 4 };
  const first = paid(15, { phone: '+14045550223' });
  first.d.noshowSentAt = new Date().toISOString();
  first.d.phone = first.b.phone;
  deposits.handleNoshowReply(first.b.phone, 'NO');
  assert.equal(disputes.addEvidence(first.d, { source: 'link', photo }).ok, true);
  const second = paid(15, { phone: '+14045550224' });
  second.d.noshowSentAt = new Date().toISOString();
  second.d.phone = second.b.phone;
  deposits.handleNoshowReply(second.b.phone, 'NO');
  const reused = disputes.addEvidence(second.d, { source: 'link', photo });
  assert.equal(reused.evidence.photoReused, true);
  assert.equal(second.d.photoReuse, true);

  const geo = paid(15, { phone: '+14045550225' });
  geo.b.slotStart = new Date(deposits.now() + 30 * 60000).toISOString();
  geo.b.status = 'confirmed';
  const weak = disputes.checkIn(geo.b, { lat: '33.75', lng: '-84.39', accuracy: '450', ip: '203.0.113.9' });
  assert.equal(weak.ok, true);
  assert.equal(geo.b.vendorCheckIn.gpsFlag, 'weak_gps');
  const none = paid(15, { phone: '+14045550226' });
  none.b.slotStart = new Date(deposits.now() + 20 * 60000).toISOString();
  none.b.status = 'confirmed';
  disputes.checkIn(none.b, { ip: '203.0.113.10' });
  assert.equal(none.b.vendorCheckIn.gpsFlag, 'no_gps');
});

test('P9: require-prepay is enforced, and the flag follows email and card fingerprint', (t) => {
  reset(t);
  store.setOverride({ stripeConnect: { accountId: 'acct_mock', mode: 'mock', chargesEnabled: true } });
  const one = paid(49, { phone: '+14045550301', payment: { cardFingerprint: 'fp_same', email: 'pat@example.com' } });
  one.d.email = 'pat@example.com';
  one.d.cardFingerprint = 'fp_same';
  one.d.noshowSentAt = new Date().toISOString();
  deposits.handleNoshowReply(one.b.phone, 'NO');
  const two = paid(49, { phone: '+14045550302', payment: { cardFingerprint: 'fp_same', email: 'pat@example.com' } });
  two.d.email = 'pat@example.com';
  two.d.cardFingerprint = 'fp_same';
  two.d.noshowSentAt = new Date().toISOString();
  const claim = deposits.handleNoshowReply(two.b.phone, 'NO');
  assert.ok(claim.repeatClaim, 'same card fingerprint counts as a repeat claim');
  disputes.setRequirePrepay(two.b.phone, true, { email: 'pat@example.com', fingerprint: 'fp_same' });
  const lead = { id: 'leadp', phone: '+14045550399', email: 'pat@example.com', name: 'Pat', need: 'leak' };
  store.db.leads.unshift(lead);
  process.env.DEPOSIT_ENABLED = '0';
  const held = booking.hold(lead, { start: new Date(Date.now() + 86400000).toISOString(), end: new Date(Date.now() + 90000000).toISOString(), label: 'Tomorrow' });
  process.env.DEPOSIT_ENABLED = '1';
  assert.equal(held.requirePrepay, true);
  assert.equal(held.status, 'held');
  assert.ok(held.amount > 0);
  booking.skipDeposit(held, 'deposit_off');
  assert.equal(held.status, 'held');
});

test('P15/P17/P19: force-release confirm, audit log, live+demo boot refusal, EIN seal, masked alert', async (t) => {
  reset(t);
  store.setOverride({ stripeConnect: { accountId: 'acct_mock', mode: 'mock', chargesEnabled: true } });
  const { d, b } = paid(49, { phone: '+14045550444' });
  d.noshowSentAt = new Date().toISOString();
  d.phone = b.phone;
  const opened = deposits.handleNoshowReply(b.phone, 'NO');
  assert.match(opened.adminAlert, /\+1\*+0444/);
  assert.doesNotMatch(opened.adminAlert, /\+14045550444/);
  const origin = 'http://shop.example';
  const no = await postRaw(`/admin/deposits/${d.id}/release`, { body: '{}', headers: { ...auth, origin, accept: 'application/json' } });
  assert.equal(no.status, 200);
  assert.equal(JSON.parse(no.body).reason, 'direct_model');
  const releaseAudit = store.root.db.moneyAudit.find((row) => row.action === 'release' && row.depositId === d.id);
  assert.ok(releaseAudit && releaseAudit.ip);
  assert.equal(releaseAudit.actor, 'admin');
  process.env.ADMIN_USERNAME = 'kojo';
  const named = { authorization: 'Basic ' + Buffer.from('kojo:' + ADMIN).toString('base64') };
  const namedRelease = await postRaw(`/admin/deposits/${d.id}/release`, { body: '{}', headers: { ...named, origin, accept: 'application/json' } });
  assert.equal(namedRelease.status, 200);
  assert.equal(store.root.db.moneyAudit[0].actor, 'admin:kojo');
  delete process.env.ADMIN_USERNAME;

  const savedNode = process.env.NODE_ENV;
  const savedDemo = process.env.DEMO_MODE;
  const savedKey = process.env.STRIPE_SECRET_KEY;
  process.env.NODE_ENV = 'production';
  process.env.DEMO_MODE = '1';
  process.env.STRIPE_SECRET_KEY = 'sk_live_not_a_real_key';
  const problems = app.locals.bootChecks();
  process.env.NODE_ENV = savedNode;
  if (savedDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = savedDemo;
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = savedKey;
  assert.ok(problems.some((p) => /live Stripe key/.test(p)));

  const sealed = onboardingStore.protectEin({ ein: '12-3456789' });
  assert.match(sealed.ein, /^enc1\./);
  assert.equal(onboardingStore.digits(sealed.ein), '123456789');
  assert.equal(sealed.einLast4, '6789');
  sealed.einSavedAt = new Date(Date.now() - 80 * 3600000).toISOString();
  onboardingStore.expireEin(sealed);
  assert.equal(sealed.ein, undefined);
});

test('P4: vendor deposit cap and daily velocity', async (t) => {
  reset(t, { DEPOSIT_AMOUNT_MAX: '150', DEPOSIT_DAILY_MAX_COUNT: '1' });
  const created = await vendors.create({ name: 'Cap Shop', email: 'cap-shop@example.com', values: { BUSINESS_TYPE: 'plumbing', BUSINESS_NAME: 'Cap Shop', DEPOSIT_AMOUNT: '49' } });
  await vendors.activate(created.token, 'long-password-cap-1', 'long-password-cap-1');
  const session = await vendors.login('cap-shop@example.com', 'long-password-cap-1', { ip: '203.0.113.8', ua: 'device-a' });
  const cookie = `buzzcall_vendor=${session.token}`;
  const over = await postRaw('/vendor/settings', { body: JSON.stringify({ DEPOSIT_AMOUNT: '200' }), headers: { cookie, origin: 'http://shop.example', accept: 'application/json' } });
  assert.equal(over.status, 400, over.body);
  assert.match(over.body, /capped at \$150/);
  await vendors.run(created.shop.id, async () => {
    const b = bookingRow(49);
    await assert.rejects(() => booking.depositLink(b, base), /daily deposit limit/);
  });
});

test('P8: onboarding routes, captcha, VoIP lookup, OTP cap, spend approval', async (t) => {
  reset(t);
  const off = await postRaw('/onboarding/verify', { body: JSON.stringify({ setupId: 'x', code: '000000' }), headers: { origin: 'http://shop.example' } });
  assert.equal(off.status, 404);
  process.env.AUTO_ONBOARDING = '1';
  const cross = await postRaw('/onboarding/resend', { body: JSON.stringify({ setupId: 'x' }), headers: {} });
  assert.equal(cross.status, 403);
  delete process.env.AUTO_ONBOARDING;

  process.env.CAPTCHA_REQUIRED = '1';
  captcha.setVerifier(null);
  const unconfigured = await postRaw('/setup', { body: JSON.stringify({ businessName: 'X' }), headers: { origin: base, accept: 'application/json' } });
  assert.notEqual(unconfigured.status, 400);
  assert.doesNotMatch(unconfigured.body, /not configured/);
  captcha.setVerifier(async (token) => token === 'ok-token');
  const missing = await postRaw('/setup', { body: JSON.stringify({ businessName: 'X' }), headers: { origin: base, accept: 'application/json' } });
  assert.equal(missing.status, 400);
  delete process.env.CAPTCHA_REQUIRED;

  process.env.LOOKUP_REJECT_VOIP = '1';
  process.env.ONBOARD_CODE_MAX_PER_PHONE = '1';
  onboardingStore.resetLimits();
  let lookups = 0;
  lookup.setLookup(async () => { lookups += 1; return { lineType: 'mobile' }; });
  const { sendCode } = require('../src/onboarding');
  const firstCode = await sendCode({ setupId: 's-rate', phone: '+14045550801', ip: '203.0.113.50', businessName: 'Rate Shop' });
  const secondCode = await sendCode({ setupId: 's-rate-2', phone: '+14045550801', ip: '203.0.113.51', businessName: 'Rate Shop' });
  assert.equal(firstCode.ok, true);
  assert.equal(secondCode.status, 429);
  assert.equal(lookups, 1, 'a rate-limited code does not call the paid lookup');
  lookup.setLookup(async () => ({ lineType: 'nonFixedVoip' }));
  onboardingStore.resetLimits();
  const voip = await sendCode({ setupId: 's1', phone: '+14045550555', ip: '203.0.113.9', businessName: 'Voip Shop' });
  assert.equal(voip.ok, false);
  delete process.env.LOOKUP_REJECT_VOIP;
  delete process.env.ONBOARD_CODE_MAX_PER_PHONE;
  onboardingStore.resetLimits();
  lookup.setLookup(null);

  process.env.OTP_MAX_PER_DAY = '1';
  sms.resetCap();
  const first = await sms.sendSms('+14045550666', 'code 111111', { kind: 'otp' });
  const second = await sms.sendSms('+14045550667', 'code 222222', { kind: 'otp' });
  assert.equal(first.ok, true);
  assert.equal(second.skipped, 'otp_cap');
  const savedCaps = JSON.parse(JSON.stringify(store.root.db.rateCaps));
  sms.resetCap();
  store.root.db.rateCaps = savedCaps;
  store.root.save();
  const afterRestart = await sms.sendSms('+14045550668', 'code 333333', { kind: 'otp' });
  assert.equal(afterRestart.skipped, 'otp_cap');
  delete process.env.OTP_MAX_PER_DAY;
  sms.resetCap();

  const shop = (await vendors.create({ name: 'Spend Gate', email: 'spend-gate@example.com', values: { BUSINESS_TYPE: 'plumbing', BUSINESS_NAME: 'Spend Gate' } })).shop;
  await vendors.run(shop.id, () => { store.db.billing = { subscription: { id: 'sub_spend', status: 'trialing' } }; store.save(); });
  onboardingStore.data().shops[shop.id] = { auto: true, phone: '+14045550777', number: { status: 'waiting_trial' }, a2p: { status: 'not_started' }, flags: [] };
  onboardingStore.save();
  const blocked = await require('../src/onboarding').advance(shop.id, base);
  assert.equal(blocked.spendBlocked, true);
  assert.equal(blocked.number.status, 'pending_admin');
  process.env.AUTO_SPEND_APPROVAL = '0';
  const open = await require('../src/onboarding').advance(shop.id, base);
  assert.equal(open.spendBlocked, false);
  delete process.env.AUTO_SPEND_APPROVAL;
});

test('P12: a new Connect account needs admin approval before deposits attach', async (t) => {
  reset(t);
  const shop = (await vendors.create({ name: 'Connect Gate', email: 'connect-gate@example.com', values: { BUSINESS_TYPE: 'plumbing', BUSINESS_NAME: 'Connect Gate' } })).shop;
  await vendors.run(shop.id, async () => {
    const link = await connect.onboard('http://shop.example', { name: 'Connect Gate', email: 'connect-gate@example.com' });
    assert.equal(link.created, true);
    connect.mockComplete();
    assert.equal(connect.chargeAccount() != null, true, 'charges can be enabled before approval');
    assert.equal(connect.payableAccount(), null);
    const b = bookingRow(40, { status: 'confirmed', paid: true, paidAt: new Date().toISOString() });
    const d = deposits.onBookingPaid(b);
    assert.equal(d.payoutPendingConnect, true);
    assert.equal(d.connectAccountId, null);
    connect.approvePayouts();
    assert.equal(deposits.attachPayable(), 1);
    assert.equal(d.connectAccountId, connect.payableAccount());
    assert.equal(d.payoutPendingConnect, false);
  });
});

test('X5: a set-up vendor cannot mint another Account Link from refresh', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  const created = await vendors.create({ name: 'Refresh Shop', email: 'refresh-shop@example.com', values: { BUSINESS_TYPE: 'plumbing', BUSINESS_NAME: 'Refresh Shop' } });
  await vendors.activate(created.token, 'long-password-refresh-1', 'long-password-refresh-1');
  const session = await vendors.login('refresh-shop@example.com', 'long-password-refresh-1', { ip: '203.0.113.20', ua: 'device-a' });
  const cookie = `buzzcall_vendor=${session.token}`;
  let links = 0;
  connect.setStripe({
    accounts: { create: async () => { throw new Error('should not create'); } },
    accountLinks: { create: async () => { links += 1; return { url: 'https://connect.example/should-not' }; } },
  });
  await vendors.run(created.shop.id, () => {
    store.setOverride({ stripeConnect: { accountId: 'acct_done', mode: 'test', chargesEnabled: true, detailsSubmitted: true, source: 'onboarding', payoutsApproved: true } });
  });
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path: '/vendor/connect/refresh', headers: { host: 'shop.example', cookie } }, (r) => {
      r.resume(); r.on('end', () => resolve({ status: r.statusCode, location: r.headers.location }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(res.status, 303);
  assert.equal(res.location, '/vendor#payments');
  assert.equal(links, 0);
  assert.ok(store.root.db.alerts.some((a) => a.kind === 'connect' && /onboarding refresh blocked/.test(a.body)));
});

test('X6: an admin raise above the pilot cap is the cap checkout uses', async (t) => {
  reset(t, { DEPOSIT_AMOUNT_MAX: '50' });
  const created = await vendors.create({ name: 'Raise Shop', email: 'raise-shop@example.com', values: { BUSINESS_TYPE: 'plumbing', BUSINESS_NAME: 'Raise Shop', DEPOSIT_AMOUNT: '49' } });
  const origin = 'http://shop.example';
  const raised = await postRaw(`/admin/vendors/${created.shop.id}/deposit-amount`, { body: JSON.stringify({ amount: '80', confirm: '1', confirm_above_cap: '1' }), headers: { ...auth, origin, accept: 'application/json', 'content-type': 'application/json' } });
  assert.equal(raised.status, 303, raised.body);
  await vendors.run(created.shop.id, async () => {
    const b = bookingRow(80);
    const url = await booking.depositLink(b, 'http://shop.example');
    assert.ok(url);
    assert.equal(b.depositBlocked, undefined);
  });
});

test('Connect webhook alerts the platform on refund, dispute, and early fraud', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_CONNECT_WEBHOOK_SECRET: SECRET });
  const created = await vendors.create({ name: 'Alert Shop', email: 'alert-shop@example.com', values: { BUSINESS_TYPE: 'plumbing', BUSINESS_NAME: 'Alert Shop' } });
  const shop = vendors.get(created.shop.id);
  await vendors.run(shop.id, () => {
    store.setOverride({ stripeConnect: { accountId: 'acct_alert', mode: 'test', chargesEnabled: true, source: 'onboarding', payoutsApproved: true } });
    const b = bookingRow(49, { stripeSessionId: 'cs_alert', phone: '+14045550999', connectAccount: 'acct_alert', status: 'confirmed', paid: true, paidAt: new Date().toISOString() });
    const d = deposits.onBookingPaid(b, { chargeId: 'ch_alert', paymentIntentId: 'pi_alert' });
    d.phone = b.phone;
    store.save();
  });
  store.root.db.alerts = [];
  const post = (type, object) => {
    const event = { id: `evt_${type}_${Math.random().toString(36).slice(2, 6)}`, type, livemode: false, account: 'acct_alert', data: { object } };
    const signedEvent = signed(event);
    return postRaw('/stripe/connect/webhook', { body: signedEvent.payload, headers: { 'stripe-signature': signedEvent.signature } });
  };
  const refund = await post('charge.refunded', { id: 'ch_alert', payment_intent: 'pi_alert', amount: 4900, amount_refunded: 4900, refunded: true });
  assert.equal(refund.status, 200, refund.body);
  const dispute = await post('charge.dispute.created', { id: 'dp_alert', charge: 'ch_alert', payment_intent: 'pi_alert', amount: 4900, currency: 'usd', reason: 'fraudulent', status: 'needs_response' });
  assert.equal(dispute.status, 200, dispute.body);
  const fraud = await post('radar.early_fraud_warning.created', { id: 'issfr_alert', charge: 'ch_alert', payment_intent: 'pi_alert', fraud_type: 'unauthorized_use_of_card', actionable: true });
  assert.equal(fraud.status, 200, fraud.body);
  const bodies = store.root.db.alerts.map((a) => a.body).join('\n');
  assert.match(bodies, /vendor refund/);
  assert.match(bodies, /card dispute/);
  assert.match(bodies, /early fraud warning/);
  const flagged = await vendors.run(shop.id, () => deposits.findByBooking(store.db.bookings[0].id));
  assert.ok(flagged.cardDispute);
  assert.ok(flagged.fraudWarning);
  assert.equal(flagged.status, 'refunded');
});

test('P5: depositsTickAll is single-flight', async (t) => {
  reset(t);
  const first = app.locals.depositsTickAll();
  const second = app.locals.depositsTickAll();
  assert.equal(first, second);
  await first;
  const third = app.locals.depositsTickAll();
  assert.notEqual(third, first);
  await third;
});
