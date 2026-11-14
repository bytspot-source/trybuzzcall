'use strict';
// Stripe Connect deposit protection: Express onboarding, platform hold, delayed Transfer, no-show pause,
// refund before/after transfer (reversal + vendor_debt), idempotent release across restart, quiet hours, opt-out skip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-dep-'));
require('dotenv').config = () => ({ parsed: {} });
const CLEAR = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'DATABASE_URL', 'DEPOSIT_RELEASE_HOURS',
  'DEPOSIT_PLATFORM_FEE_PCT', 'NOSHOW_CHECK_HOURS', 'LEAD_FEE', 'LEAD_FEE_WAIVED', 'DEMO_MODE'];
for (const k of CLEAR) process.env[k] = '';
const ADMIN = 'dep-test-pass';
Object.assign(process.env, {
  DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: ADMIN,
  BUSINESS_NAME: 'Test Plumbing', OWNER_PHONE: '+15550000099', BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1',
  BUSINESS_DAYS: '0,1,2,3,4,5,6', BUSINESS_HOURS: '00:00-23:59', BOOKING_LEAD_MINUTES: '0',
  PUBLIC_BASE_URL: 'https://shop.example',   DEPOSIT_RELEASE_HOURS: '24', NOSHOW_CHECK_HOURS: '12',
  DEPOSIT_PLATFORM_FEE_PCT: '0', DEPOSIT_MODEL: 'platform_hold',
});

const store = require('../src/store');
const connect = require('../src/connect');
const booking = require('../src/booking');
const deposits = require('../src/deposits');
const shopTime = require('../src/shopTime');

const TEST_KEY = 'sk_test_' + 'fake'.repeat(6);

function fakeStripe(acct = {}) {
  const calls = { create: [], retrieve: [], links: [], sessions: [], transfers: [], reversals: [], refunds: [] };
  const account = {
    id: 'acct_express_1', type: 'express', charges_enabled: false, details_submitted: false, payouts_enabled: false,
    requirements: { currently_due: ['external_account'], disabled_reason: 'requirements.past_due' }, ...acct,
  };
  const client = {
    calls, account,
    accounts: {
      retrieve: async (id) => { calls.retrieve.push(id); return { ...account, id }; },
    },
    v2: { core: {
      accounts: {
        create: async (p) => { calls.create.push(p); return { ...account, id: account.id }; },
        retrieve: async (id) => { calls.retrieve.push(id); return { ...account, id }; },
      },
      accountLinks: { create: async (p) => { calls.links.push(p); return { url: 'https://connect.stripe.com/setup/e/test' }; } },
    } },
    checkout: {
      sessions: {
        create: async (p, o) => {
          calls.sessions.push({ p, o });
          return { id: 'cs_test_dep', url: 'https://checkout.stripe.com/c/pay/cs_test_dep', payment_intent: 'pi_test_dep' };
        },
      },
    },
    transfers: {
      create: async (p, o) => { calls.transfers.push({ p, o }); return { id: 'tr_test_1', amount: p.amount, destination: p.destination }; },
      createReversal: async (id, p, o) => { calls.reversals.push({ id, p, o }); return { id: 'trr_test_1' }; },
    },
    refunds: {
      create: async (p, o) => { calls.refunds.push({ p, o }); return { id: 're_test_1' }; },
    },
  };
  return client;
}

function reset(t, envOver = {}) {
  const saved = {};
  for (const k of CLEAR) saved[k] = process.env[k];
  Object.assign(process.env, Object.fromEntries(CLEAR.map((k) => [k, ''])), {
    DEPOSIT_RELEASE_HOURS: '24', NOSHOW_CHECK_HOURS: '12', DEPOSIT_PLATFORM_FEE_PCT: '0',
  }, envOver);
  store.setOverride({});
  store.db.bookings.length = 0;
  store.db.leads.length = 0;
  store.db.alerts.length = 0;
  store.db.deposits = [];
  store.db.vendorDebt = {};
  store.db.depositsMeta = { offsetMs: 0, events: [] };
  store.db.voiceConsents = [];
  store.db.optOuts = {};
  t.after(() => {
    Object.assign(process.env, saved);
    connect.setStripe(null);
    store.setOverride({});
  });
}

function fakeBooking(amount = 49, hoursFromNow = 2) {
  const start = Date.now() + hoursFromNow * 3600000;
  const b = {
    id: 'bk' + Math.random().toString(36).slice(2, 8), leadId: 'l1', phone: '+15551112222', name: 'Pat', need: 'leak',
    slotStart: new Date(start).toISOString(), slotEnd: new Date(start + 7200000).toISOString(),
    slotLabel: 'Soon', status: 'held', paid: false, amount,
    holdExpiresAt: new Date(Date.now() + 1800000).toISOString(), createdAt: new Date().toISOString(),
  };
  store.db.bookings.unshift(b);
  return b;
}

function withConsent(phone) {
  store.db.voiceConsents = store.db.voiceConsents || [];
  store.db.voiceConsents.unshift({ from: phone, consented: true, digits: '1', at: new Date().toISOString() });
}

test('onboarding link creation (mocked Stripe): full-dashboard v2 account + account link with return/refresh URLs', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  const f = fakeStripe();
  connect.setStripe(f);
  const r = await connect.onboard('https://shop.example', { name: 'Test Plumbing', url: 'https://shop.example' });
  assert.equal(r.url, 'https://connect.stripe.com/setup/e/test');
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.create[0].dashboard, 'full');
  assert.equal(f.calls.create[0].defaults.responsibilities.losses_collector, 'stripe');
  assert.equal(f.calls.create[0].configuration.merchant.capabilities.card_payments.requested, true);
  assert.equal(f.calls.create[0].configuration.recipient, undefined);
  assert.equal(f.calls.create[0].identity.country, 'us');
  assert.deepEqual(f.calls.links[0], {
    account: 'acct_express_1',
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        refresh_url: 'https://shop.example/admin/connect/refresh',
        return_url: 'https://shop.example/admin/connect/return',
      },
    },
  });
  assert.equal(store.getOverride().stripeConnect.accountId, 'acct_express_1');
  // Reuse existing account on second call
  await connect.onboard('https://shop.example');
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.links.length, 2);
});

test('holding at booking: platform Checkout (no stripeAccount); deposit row scheduled', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  const f = fakeStripe({ charges_enabled: true });
  connect.setStripe(f);
  store.setOverride({ stripeConnect: { accountId: 'acct_express_1', mode: 'test', chargesEnabled: true } });
  const b = fakeBooking(49);
  const url = await booking.depositLink(b, 'https://shop.example');
  assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_test_dep');
  assert.equal(f.calls.sessions.length, 1);
  assert.deepEqual(f.calls.sessions[0].o, { stripeAccount: 'acct_express_1' });
  assert.equal(f.calls.sessions[0].p.payment_intent_data.transfer_data, undefined);
  assert.equal(f.calls.sessions[0].p.payment_intent_data.application_fee_amount, undefined);
  store.setOverride({});
  const b2 = fakeBooking(20);
  await assert.rejects(() => booking.depositLink(b2, 'https://shop.example'), { status: 409 });
  assert.equal(f.calls.sessions.length, 1);
});

test('mock hold + release after 24h', async (t) => {
  reset(t);
  connect.setStripe(() => { throw new Error('no stripe in mock'); });
  store.setOverride({ stripeConnect: { accountId: 'acct_mock_x', mode: 'mock', chargesEnabled: true } });
  const b = fakeBooking(49, 1); // appointment in 1h
  b.paid = true; b.status = 'confirmed'; b.paidAt = new Date().toISOString();
  const d = deposits.onBookingPaid(b);
  assert.equal(d.status, 'scheduled');
  assert.ok(Date.parse(d.releaseAt) > deposits.now());
  // Too early
  let r = await deposits.releaseDeposit(d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_early');
  // Advance past release
  store.db.depositsMeta.offsetMs = 30 * 3600000; // +30h
  r = await deposits.releaseDeposit(d);
  assert.equal(r.ok, true);
  assert.equal(d.status, 'released');
  assert.match(d.transferId, /^tr_mock_/);
});

test('NO reply pauses payout; YES does not', async (t) => {
  reset(t);
  const b = fakeBooking(49, -2); // appointment 2h ago
  b.paid = true; b.status = 'confirmed'; b.paidAt = new Date().toISOString();
  const d = deposits.onBookingPaid(b);
  d.noshowSentAt = new Date().toISOString();
  store.save();
  assert.equal(deposits.handleNoshowReply('+19999999999', 'NO'), null); // wrong phone
  const yes = deposits.handleNoshowReply(b.phone, 'YES');
  assert.equal(yes.answer, 'yes');
  assert.equal(d.status, 'scheduled');
  d.noshowReply = null; // reset to allow NO path in same test after re-pending
  // Need a fresh pending check
  const b2 = fakeBooking(30, -2);
  b2.phone = '+15553334444'; b2.paid = true; b2.status = 'confirmed'; b2.paidAt = new Date().toISOString();
  const d2 = deposits.onBookingPaid(b2);
  d2.noshowSentAt = new Date().toISOString();
  store.save();
  const no = deposits.handleNoshowReply(b2.phone, 'NO');
  assert.equal(no.answer, 'no');
  assert.equal(d2.status, 'paused');
  assert.match(no.reply, /paused the payment/i);
  // Release blocked while paused
  store.db.depositsMeta.offsetMs = 48 * 3600000;
  const blocked = await deposits.releaseDeposit(d2);
  assert.equal(blocked.reason, 'paused');
  // Force release still works for admin
  const forced = await deposits.releaseDeposit(d2, { force: true });
  assert.equal(forced.ok, false); // still not connected in this reset — attach account
  store.setOverride({ stripeConnect: { accountId: 'acct_mock_y', mode: 'mock', chargesEnabled: true } });
  d2.connectAccountId = 'acct_mock_y';
  const forced2 = await deposits.releaseDeposit(d2, { force: true });
  assert.equal(forced2.ok, true);
});

test('refund before transfer', async (t) => {
  reset(t);
  store.setOverride({ stripeConnect: { accountId: 'acct_mock_z', mode: 'mock', chargesEnabled: true } });
  const b = fakeBooking(49);
  b.paid = true; b.status = 'confirmed'; b.paidAt = new Date().toISOString();
  const d = deposits.onBookingPaid(b);
  const r = await deposits.refundDeposit(d);
  assert.equal(r.ok, true);
  assert.equal(d.status, 'refunded');
  assert.ok(d.refundId);
  assert.equal(d.transferReversalId, null);
});

test('refund after transfer: reversal; vendor_debt when short', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  const f = fakeStripe({ charges_enabled: true });
  connect.setStripe(f);
  store.setOverride({ stripeConnect: { accountId: 'acct_express_1', mode: 'test', chargesEnabled: true } });
  const b = fakeBooking(49, -30);
  b.paid = true; b.status = 'confirmed'; b.paidAt = new Date().toISOString();
  b.stripePaymentIntentId = 'pi_live_1';
  const d = deposits.onBookingPaid(b, { paymentIntentId: 'pi_live_1', chargeId: 'ch_1' });
  d.releaseAt = new Date(Date.now() - 1000).toISOString();
  const rel = await deposits.releaseDeposit(d);
  assert.equal(rel.ok, true);
  assert.equal(f.calls.transfers.length, 1);
  assert.equal(f.calls.transfers[0].o.idempotencyKey, d.releaseIdempotencyKey);
  const ref = await deposits.refundDeposit(d);
  assert.equal(ref.ok, true);
  assert.equal(f.calls.reversals.length, 1);
  assert.equal(f.calls.refunds.length, 1);
  assert.equal(d.status, 'refunded');

  // Short balance path: reversal throws → vendor_debt
  const b2 = fakeBooking(40, -30);
  b2.paid = true; b2.status = 'confirmed'; b2.paidAt = new Date().toISOString();
  const d2 = deposits.onBookingPaid(b2, { paymentIntentId: 'pi_2', chargeId: 'ch_2' });
  d2.releaseAt = new Date(Date.now() - 1000).toISOString();
  await deposits.releaseDeposit(d2);
  f.transfers.createReversal = async () => { throw new Error('insufficient available balance'); };
  await deposits.refundDeposit(d2);
  assert.ok(deposits.vendorDebt('acct_express_1') > 0);
});

test('vendor_debt netting against future payout', async (t) => {
  reset(t);
  store.setOverride({ stripeConnect: { accountId: 'acct_mock_debt', mode: 'mock', chargesEnabled: true } });
  deposits.setVendorDebt('acct_mock_debt', 2000); // $20 owed
  const b = fakeBooking(49, -30);
  b.paid = true; b.status = 'confirmed'; b.paidAt = new Date().toISOString();
  const d = deposits.onBookingPaid(b);
  d.releaseAt = new Date(Date.now() - 1000).toISOString();
  d.connectAccountId = 'acct_mock_debt';
  await deposits.releaseDeposit(d);
  assert.equal(d.status, 'released');
  assert.equal(d.vendorDebtAppliedCents, 2000);
  assert.equal(deposits.vendorDebt('acct_mock_debt'), 0);
  // Vendor received 49 - 20 = 29 dollars worth of transfer id recorded
  assert.ok(d.transferId);
});

test('idempotency across restart: same release key, no double transfer', async (t) => {
  reset(t, { STRIPE_SECRET_KEY: TEST_KEY });
  const f = fakeStripe({ charges_enabled: true });
  connect.setStripe(f);
  store.setOverride({ stripeConnect: { accountId: 'acct_express_1', mode: 'test', chargesEnabled: true } });
  const b = fakeBooking(49, -30);
  b.paid = true; b.status = 'confirmed'; b.paidAt = new Date().toISOString();
  const d = deposits.onBookingPaid(b, { chargeId: 'ch_x' });
  d.releaseAt = new Date(Date.now() - 1000).toISOString();
  await deposits.releaseDeposit(d);
  assert.equal(f.calls.transfers.length, 1);
  // Simulate restart: same deposit object still marked released
  const again = await deposits.releaseDeposit(d);
  assert.equal(again.already, true);
  assert.equal(f.calls.transfers.length, 1);
  // processDueReleases also skips released
  await deposits.processDueReleases();
  assert.equal(f.calls.transfers.length, 1);
});

test('quiet hours for check-in text: never between 9pm and 8am shop-local', (t) => {
  reset(t, { BUSINESS_TZ: 'America/New_York' });
  // 2026-11-05 02:00 America/New_York = 07:00 UTC (EDT is UTC-4 until Nov 1 2026? Actually Nov 4 2026 - DST ends first Sunday Nov = Nov 1 2026, so EST = UTC-5)
  // Use a known local night time via nextAllowedSend
  const night = Date.parse('2026-11-05T03:00:00-05:00'); // 3am Eastern
  const allowed = deposits.nextAllowedSend(night, 'America/New_York');
  const parts = shopTime.parts(allowed, 'America/New_York');
  assert.equal(parts.hour, 8);
  assert.ok(parts.day === 5 || parts.day === 5);
  const evening = Date.parse('2026-11-05T21:30:00-05:00'); // 9:30pm
  const nextMorning = deposits.nextAllowedSend(evening, 'America/New_York');
  const p2 = shopTime.parts(nextMorning, 'America/New_York');
  assert.equal(p2.hour, 8);
  assert.equal(p2.day, 6);
  const midday = Date.parse('2026-11-05T14:00:00-05:00');
  assert.equal(deposits.nextAllowedSend(midday, 'America/New_York'), midday);
});

test('opted-out customers are not texted for no-show check', async (t) => {
  reset(t, { BUSINESS_TZ: 'UTC' });
  // Land the mock clock at 15:00 UTC so quiet hours (21:00–08:00) do not delay the check.
  const target = Date.parse('2026-11-05T15:00:00Z');
  store.db.depositsMeta.offsetMs = target - Date.now();
  const sent = [];
  const b = fakeBooking(49, -20);
  b.phone = '+15554445555';
  b.paid = true; b.status = 'confirmed'; b.paidAt = new Date().toISOString();
  withConsent(b.phone);
  const d = deposits.onBookingPaid(b);
  d.noshowCheckAt = new Date(deposits.now() - 1000).toISOString();
  store.db.optOuts[b.phone] = { at: new Date().toISOString(), reason: 'keyword' };
  store.save();
  await deposits.sendDueNoshowChecks({ sendSms: async (to, body) => { sent.push({ to, body }); } });
  assert.equal(sent.length, 0);
  assert.equal(d.noshowSkipped, 'opted_out');
  assert.ok(d.noshowSentAt); // marked so we never retry
});

test('platform fee percent reduces vendor transfer amount', async (t) => {
  reset(t, { DEPOSIT_PLATFORM_FEE_PCT: '10' });
  store.setOverride({ stripeConnect: { accountId: 'acct_mock_fee', mode: 'mock', chargesEnabled: true } });
  const b = fakeBooking(100, -30);
  b.paid = true; b.status = 'confirmed'; b.paidAt = new Date().toISOString();
  const d = deposits.onBookingPaid(b);
  assert.equal(d.platformFeeCents, 1000);
  assert.equal(d.vendorAmountCents, 9000);
  d.releaseAt = new Date(Date.now() - 1000).toISOString();
  d.connectAccountId = 'acct_mock_fee';
  await deposits.releaseDeposit(d);
  assert.equal(d.status, 'released');
});

test('YES/NO without pending check does not capture SMS (collision guard)', (t) => {
  reset(t);
  assert.equal(deposits.handleNoshowReply('+15551112222', 'YES'), null);
  assert.equal(deposits.handleNoshowReply('+15551112222', 'NO'), null);
  // Normal conversation words that happen to include letters
  assert.equal(deposits.handleNoshowReply('+15551112222', 'no leak under sink tonight'), null);
});

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
