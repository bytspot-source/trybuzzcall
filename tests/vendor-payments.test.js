'use strict';
// No server, credentials or network: all provider calls go through connect.setStripe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-vendor-payments-'));
process.env.DATA_DIR = path.join(dir, 'root');
process.env.DATABASE_URL = '';
process.env.SPILL_DIR = '';
process.env.STRIPE_SECRET_KEY = '';
process.env.NODE_ENV = 'test';
const store = require('../src/store');
const context = require('../src/shopContext');
const billing = require('../src/billing');
const connect = require('../src/connect');
const booking = require('../src/booking');
const BASE = 'https://platform.example';
const TTL = 23 * 3600000;
let sequence = 0, messages;
function tenant(values = {}, shop = {}) {
  const id = `vendor_${++sequence}`;
  const scoped = store.createStore({ namespace: id, dir: path.join(dir, id) });
  scoped.setOverride({ values });
  return { id, store: scoped, shop: { id, ...shop } };
}
const run = (shop, fn) => context.run(shop, fn);
const checkout = (options = {}) => billing.createCheckout({ plan: 'monthly', BASE, ...options });
function live() { process.env.STRIPE_SECRET_KEY = ['sk', 'test', 'offline_fixture'].join('_'); }
function fakeStripe() {
  const calls = { accounts: [], links: [], sessions: [], portals: [], retrieves: [], setupItems: [] };
  const sessions = new Map(), setupItems = new Map();
  const client = {
    accounts: {
      create: async (params, options) => {
        calls.accounts.push({ params, options });
        return { id: `acct_${params.metadata.shopId || 'root'}`, charges_enabled: true, details_submitted: true };
      },
      retrieve: async (id) => { calls.retrieves.push(id); return { id, charges_enabled: true }; },
    },
    accountLinks: { create: async (params) => { calls.links.push(params); return { url: 'https://connect.example/onboard' }; } },
    checkout: { sessions: { create: async (params, options) => {
      calls.sessions.push({ params, options });
      const key = options?.idempotencyKey;
      if (key && sessions.has(key)) return sessions.get(key);
      const id = `cs_${calls.sessions.length}`;
      const session = { id, url: `https://checkout.example/${id}`, customer: params.customer || null,
        subscription: null, expires_at: params.expires_at };
      if (key) sessions.set(key, session);
      return session;
    } } },
    invoiceItems: { create: async (params, options) => {
      calls.setupItems.push({ params, options });
      if (!setupItems.has(options.idempotencyKey)) setupItems.set(options.idempotencyKey, { id: `ii_${setupItems.size + 1}`, amount: 9900 });
      return setupItems.get(options.idempotencyKey);
    } },
    billingPortal: { sessions: { create: async (params) => { calls.portals.push(params); return { url: 'https://portal.example/session' }; } } },
    subscriptions: { retrieve: async (id) => ({ id, customer: 'cus_completed', status: 'trialing', metadata: { plan: 'annual' } }) },
  };
  connect.setStripe(client);
  return { client, calls, sessions, setupItems };
}
const event = (type, object) => ({ id: `evt_${++sequence}`, type, data: { object } });
function primary(shop, status, customer = 'cus_scoped') {
  shop.store.db.billing = { subscription: { id: `sub_${shop.id}`, customer, status, plan: 'monthly' } };
}
function deposit(shop) {
  const b = { id: `booking_${shop.id}`, amount: 49, status: 'held', paid: false, slotLabel: 'Tomorrow morning' };
  shop.store.db.bookings.push(b);
  return b;
}
test.beforeEach(() => {
  Object.assign(process.env, { STRIPE_SECRET_KEY: '', STRIPE_CONNECT_ACCOUNT_ID: 'acct_legacy',
    STRIPE_PRICE_ID_BASE_MONTHLY: 'price_monthly', STRIPE_PRICE_ID_BASE_ANNUAL: 'price_annual', STRIPE_PRICE_ID_SETUP: 'price_setup',
    SETUP_FEE_WAIVED: '', SETUP_WAIVER_CODE: '', BILLING_PORTAL_RETURN_URL: '', FOUNDING_SHOPS_LIMIT: '10',
    TRIAL_DAYS: '14', MOCK_SETUP_FEE: '99', MOCK_PRICE_MONTHLY: '49', MOCK_PRICE_ANNUAL: '588',
    BILLING_ENFORCE: '1', BILLING_REQUIRE_SUBSCRIPTION: '', PAST_DUE_GRACE_DAYS: '0' });
  store.root.db.billing = {};
  store.root.setOverride({});
  messages = [];
  billing.init({ BASE, notify: async (text) => { messages.push({ shopId: context.shopId(), text }); } });
  connect.setStripe(() => { throw new Error('Unexpected provider access'); });
});
test.after(() => { connect.setStripe(null); fs.rmSync(dir, { recursive: true, force: true }); });

test('tenant settings do not inherit legacy waivers or portal return, and founding is explicitly assigned', () => {
  Object.assign(process.env, { SETUP_FEE_WAIVED: '1', SETUP_WAIVER_CODE: 'legacy-promotion', BILLING_PORTAL_RETURN_URL: 'https://legacy.example/return' });
  const a = tenant(), b = tenant({}, { founding: true });
  run(a, () => {
    assert.equal(billing.cfg().setupWaivedAll, false);
    assert.equal(billing.cfg().setupWaiverCode, null);
    assert.equal(billing.cfg().portalReturn, '');
    assert.equal(billing.decideSetup({ plan: 'monthly' }).status, 'pending');
    assert.equal(billing.decideSetup({ plan: 'annual' }).reason, 'annual plan');
    assert.equal(billing.decideSetup({ plan: 'monthly', override: true }).reason, 'override');
  });
  run(b, () => assert.equal(billing.decideSetup({ plan: 'monthly' }).founding, true));
  run(tenant({ SETUP_FEE_WAIVED: '1', STRIPE_PRICE_ID_BASE_MONTHLY: 'not-a-platform-price' }), () => {
    assert.equal(billing.decideSetup({ plan: 'monthly' }).reason, 'override');
    assert.equal(billing.cfg().prices.monthly, 'price_monthly');
  });
  assert.equal(billing.cfg().setupWaivedAll, true);
  process.env.SETUP_FEE_WAIVED = '';
  assert.equal(billing.decideSetup({ plan: 'monthly' }).founding, true);
  store.root.db.billing.shops = Array.from({ length: 10 }, () => ({ founding: true, status: 'active', everPaid: true }));
  assert.equal(billing.decideSetup({ plan: 'monthly' }).status, 'pending');
  run(tenant(), () => assert.equal(billing.decideSetup({ plan: 'monthly' }).status, 'pending'));
});

test('mock checkout paths, reuse, subscription ownership and durable routing stay scoped', async () => {
  const a = tenant(), b = tenant();
  const [ca, cb] = await Promise.all([run(a, checkout), run(b, checkout)]);
  assert.equal(ca.url, `${BASE}/vendor/billing/mock/checkout/${ca.id}`);
  assert.notEqual(ca.id, cb.id);
  assert.equal((await run(a, checkout)).id, ca.id);
  assert.equal(run(b, () => billing.mockSessionInfo(ca.id)), null);
  assert.equal(await run(a, () => billing.portalUrl(BASE)), `${BASE}/vendor/billing/mock/portal`);
  const sub = await run(a, () => billing.mockCompleteCheckout(ca.id, BASE));
  const pending = a.store.db.billing.pendingCheckouts[ca.id];
  assert.equal(pending.customer, sub.customer);
  assert.equal(pending.subscription, sub.id);
  assert.equal(pending.status, 'completed');
  assert.equal(pending.shopId, a.id);
  const disk = JSON.parse(fs.readFileSync(path.join(a.store.dataDir(), 'db.json'), 'utf8'));
  assert.equal(disk.billing.pendingCheckouts[ca.id].subscription, sub.id);
  await assert.rejects(run(a, checkout), { status: 409 });
  await assert.rejects(run(b, () => billing.setCancel(true, sub.id)), { status: 404 });
  await assert.rejects(run(b, () => billing.mockCompleteCheckout(ca.id, BASE)), { status: 404 });
  assert.equal(b.store.db.billing.subscription, undefined);
  const root = await checkout();
  assert.equal(root.url, `${BASE}/billing/mock/checkout/${root.id}`);
  assert.equal(await billing.portalUrl(BASE), `${BASE}/billing/mock/portal`);
  assert.notEqual((await checkout()).id, root.id); // legacy multi-shop demo remains available
});

test('all noncanceled tenant subscription states conflict, including unknown or incomplete records', async () => {
  for (const status of ['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'incomplete_expired', undefined]) {
    const a = tenant(); primary(a, status);
    await assert.rejects(run(a, checkout), { status: 409 });
    assert.equal(Object.keys(a.store.db.billing.pendingCheckouts).length, 0);
  }
  const a = tenant();
  a.store.db.billing = { primaryId: 'sub_not_synced' };
  await assert.rejects(run(a, checkout), { status: 409 });
});

test('pending checkouts expire within 23 hours, even if a stored expiry is longer', async () => {
  const a = tenant();
  const first = await run(a, checkout);
  const pending = a.store.db.billing.pendingCheckouts[first.id];
  assert.equal(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt), TTL);
  pending.expiresAt = new Date(Date.now() + 48 * 3600000).toISOString();
  a.store.db.billing.mock.offsetMs = TTL + 1000;
  const second = await run(a, checkout);
  assert.notEqual(first.id, second.id);
  await assert.rejects(run(a, () => billing.mockCompleteCheckout(first.id, BASE)), { status: 409 });
  assert.equal(a.store.db.billing.subscription, undefined);
});

test('live checkout tags both Stripe objects, uses only the scoped customer, persists before returning and uses vendor return routes', async () => {
  live(); const { calls } = fakeStripe();
  const a = tenant(), b = tenant(); primary(a, 'canceled', 'cus_vendor_a');
  store.root.db.billing = { subscription: { id: 'sub_root', customer: 'cus_root', status: 'active' } };
  const result = await run(a, () => checkout({ email: 'owner@example.test' }));
  const p = calls.sessions[0].params;
  assert.equal(p.customer, 'cus_vendor_a'); assert.equal(p.customer_email, undefined);
  assert.equal(p.metadata.shopId, a.id); assert.equal(p.subscription_data.metadata.shopId, a.id);
  assert.equal(p.success_url, `${BASE}/vendor/billing/return?status=success`);
  assert.equal(p.cancel_url, `${BASE}/vendor/billing/return?status=cancel`);
  assert.ok(p.expires_at * 1000 <= Date.now() + TTL);
  assert.ok(p.expires_at * 1000 > Date.now() + TTL - 10000);
  const reloaded = store.createStore({ namespace: a.id, dir: a.store.dataDir() });
  assert.equal(reloaded.db.billing.pendingCheckouts[result.id].customer, 'cus_vendor_a');
  assert.equal(reloaded.db.billing.pendingCheckouts[result.id].subscription, null);
  await run({ ...a, store: reloaded }, checkout);
  assert.equal(calls.sessions.length, 1);
  await run(b, () => checkout({ email: 'other@example.test' }));
  assert.equal(calls.sessions[1].params.customer, undefined);
  assert.equal(calls.sessions[1].params.customer_email, 'other@example.test');
  await run(a, () => billing.handleEvent(event('checkout.session.completed', {
    id: result.id, mode: 'subscription', customer: 'cus_vendor_a', subscription: 'sub_completed', metadata: { plan: 'annual' },
  })));
  assert.equal(a.store.db.billing.pendingCheckouts[result.id].subscription, 'sub_completed');
  assert.equal(a.store.db.billing.pendingCheckouts[result.id].status, 'completed');
  assert.equal(b.store.db.billing.pendingCheckouts[result.id], undefined);
});

test('checkout lock rejects concurrent requests only for the same tenant, and releases on provider failure', async () => {
  live(); const { client, calls } = fakeStripe(); const a = tenant(), b = tenant();
  const create = client.checkout.sessions.create;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  client.checkout.sessions.create = async (params) => {
    if (params.metadata.shopId === a.id) await gate;
    return create(params);
  };
  const first = run(a, checkout);
  await assert.rejects(run(a, checkout), { status: 409 });
  await run(b, checkout);
  assert.equal(calls.sessions.length, 1);
  release(); await first;
  await run(a, checkout);
  assert.equal(calls.sessions.length, 2);
  const c = tenant();
  client.checkout.sessions.create = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(run(c, checkout), /provider unavailable/);
  client.checkout.sessions.create = create;
  await run(c, checkout);
  assert.equal(calls.sessions.length, 3);
});

test('storage failures do not return a checkout URL or manufacture paid subscription state; retry reuses the session', async () => {
  live(); const { calls } = fakeStripe(); const a = tenant();
  const flush = a.store.flush, status = a.store.status;
  let failed = false, flushes = 0;
  a.store.flush = async () => { if (++flushes === 1) await flush(); else failed = true; }; // fail after provider success
  a.store.status = () => ({ ...status(), degraded: failed });
  await assert.rejects(run(a, checkout), { status: 503 });
  assert.equal(calls.sessions.length, 1);
  assert.equal(a.store.db.billing.subscription, undefined);
  assert.equal(a.store.db.billing.invoices.length, 0);
  assert.equal(Object.keys(a.store.db.billing.pendingCheckouts).length, 1);
  a.store.flush = flush; a.store.status = status;
  const result = await run(a, checkout);
  assert.equal(result.id, 'cs_1'); assert.equal(calls.sessions.length, 1);
  const b = tenant(); b.store.status = () => ({ fallback: true });
  await assert.rejects(run(b, checkout), { status: 503 });
  assert.equal(calls.sessions.length, 1);
});

test('checkout awaits durable flush and records provider references without inventing subscription success', async () => {
  live(); const { client } = fakeStripe(); const a = tenant();
  client.checkout.sessions.create = async () => ({ id: 'cs_refs', url: 'https://checkout.example/refs',
    customer: { id: 'cus_refs' }, subscription: { id: 'sub_refs' } });
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const flushing = new Promise((resolve) => { entered = resolve; });
  const flush = a.store.flush;
  let flushes = 0;
  a.store.flush = async () => { if (++flushes === 1) return flush(); entered(); await gate; };
  let returned = false;
  const pending = run(a, checkout).then((result) => { returned = true; return result; });
  await flushing;
  assert.equal(returned, false);
  assert.equal(a.store.db.billing.pendingCheckouts.cs_refs.customer, 'cus_refs');
  assert.equal(a.store.db.billing.pendingCheckouts.cs_refs.subscription, 'sub_refs');
  assert.equal(a.store.db.billing.subscription, undefined);
  release(); await pending;
  assert.equal(returned, true);
});

test('pending monthly checkout rejects annual or changed waiver requests without another session', async () => {
  for (const isLive of [false, true]) {
    if (isLive) live();
    const { calls } = fakeStripe(), a = tenant();
    const first = await run(a, checkout);
    const record = a.store.db.billing.pendingCheckouts[first.id];
    assert.equal(record.plan, 'monthly'); assert.equal(record.setupWaived, false);
    const reloaded = { ...a, store: store.createStore({ namespace: a.id, dir: a.store.dataDir() }) };
    for (const options of [{ plan: 'annual' }, { setupWaived: true }]) {
      await assert.rejects(run(reloaded, () => checkout(options)), { status: 409, message: /must finish or expire/ });
    }
    assert.equal((await run(reloaded, checkout)).id, first.id);
    assert.equal(Object.keys(reloaded.store.db.billing.pendingCheckouts).length, 1);
    assert.equal(calls.sessions.length, isLive ? 1 : 0);
  }
});

test('checkout attempt is durable before Stripe and survives uncertain creation with identical retry parameters', async () => {
  live(); const { client, calls, sessions } = fakeStripe(), a = tenant();
  const create = client.checkout.sessions.create;
  let first = true;
  client.checkout.sessions.create = async (params, options) => {
    const disk = JSON.parse(fs.readFileSync(path.join(a.store.dataDir(), 'db.json'), 'utf8'));
    assert.equal(disk.billing.checkoutAttempt.idempotencyKey, options.idempotencyKey);
    assert.deepEqual(disk.billing.checkoutAttempt.params, params);
    assert.equal(disk.billing.checkoutAttempt.plan, 'monthly');
    assert.equal(disk.billing.checkoutAttempt.setupWaived, false);
    assert.equal(Object.keys(disk.billing.pendingCheckouts).length, 0);
    const session = await create(params, options);
    if (first) { first = false; throw new Error('response lost after creation'); }
    return session;
  };
  await assert.rejects(run(a, () => checkout({ email: 'original@example.test' })), /response lost/);
  const reloaded = { ...a, store: store.createStore({ namespace: a.id, dir: a.store.dataDir() }) };
  for (const options of [{ plan: 'annual' }, { setupWaived: true }])
    await assert.rejects(run(reloaded, () => checkout(options)), { status: 409 });
  assert.equal(calls.sessions.length, 1);
  // Request/config changes must not change the parameters bound to the persisted Stripe key.
  process.env.TRIAL_DAYS = '7'; process.env.STRIPE_PRICE_ID_BASE_MONTHLY = 'price_changed';
  const result = await run(reloaded, () => checkout({ email: 'changed@example.test', BASE: 'https://changed.example' }));
  assert.equal(result.id, 'cs_1'); assert.equal(sessions.size, 1);
  assert.deepEqual(calls.sessions[1], calls.sessions[0]);
  assert.equal(reloaded.store.db.billing.checkoutAttempt, undefined);
  const disk = JSON.parse(fs.readFileSync(path.join(a.store.dataDir(), 'db.json'), 'utf8'));
  assert.equal(disk.billing.checkoutAttempt, undefined);
  assert.equal(disk.billing.pendingCheckouts[result.id].plan, 'monthly');
});

test('checkout attempt persistence fails closed before any provider call and retries with the reserved key', async () => {
  live(); const { calls } = fakeStripe(), a = tenant();
  const flush = a.store.flush, status = a.store.status;
  let failed = false;
  a.store.flush = async () => { failed = true; };
  a.store.status = () => ({ ...status(), degraded: failed });
  await assert.rejects(run(a, checkout), { status: 503 });
  assert.equal(calls.sessions.length, 0);
  const attempt = JSON.parse(JSON.stringify(a.store.db.billing.checkoutAttempt));
  assert.equal(Object.keys(a.store.db.billing.pendingCheckouts).length, 0);
  a.store.flush = flush; a.store.status = status;
  await run(a, checkout);
  assert.equal(calls.sessions[0].options.idempotencyKey, attempt.idempotencyKey);
  assert.deepEqual(calls.sessions[0].params, attempt.params);
});

test('expired uncertain checkout attempts fail closed instead of rotating a possibly used key', async () => {
  live(); const { client } = fakeStripe(), a = tenant();
  let calls = 0;
  client.checkout.sessions.create = async () => { calls++; throw new Error('uncertain creation'); };
  await assert.rejects(run(a, checkout), /uncertain creation/);
  a.store.db.billing.checkoutAttempt.createdAt = new Date(Date.now() - TTL - 1000).toISOString();
  await assert.rejects(run(a, checkout), { status: 409, message: /unresolved/ });
  assert.equal(calls, 1);
});

test('setup fee failure leaves the event retryable and resumes partial registration with the same key', async () => {
  live(); const { client, calls, setupItems } = fakeStripe(), a = tenant();
  client.subscriptions.retrieve = async (id) => ({ id, customer: 'cus_setup', status: 'trialing', metadata: { plan: 'monthly' } });
  const create = client.invoiceItems.create;
  let first = true;
  client.invoiceItems.create = async (params, options) => {
    const item = await create(params, options);
    if (first) { first = false; throw new Error('setup response lost'); }
    return item;
  };
  const ev = event('checkout.session.completed', { id: 'cs_setup', mode: 'subscription', customer: 'cus_setup', subscription: 'sub_setup' });
  await Promise.all([
    assert.rejects(run(a, () => billing.handleEvent(ev)), /setup response lost/),
    assert.rejects(run(a, () => billing.handleEvent(ev)), /setup response lost/),
  ]);
  assert.equal(calls.setupItems.length, 1);
  const b = a.store.db.billing;
  assert.equal(b.events.length, 0); assert.equal(b.shops.length, 1);
  assert.equal(b.shops[0].setup.status, 'pending'); assert.equal(b.shops[0].setup.itemId, null);
  assert.equal(await run(a, () => billing.handleEvent(ev)), true);
  assert.equal(b.events.length, 1); assert.equal(b.shops.length, 1);
  assert.equal(b.shops[0].setup.itemId, 'ii_1'); assert.equal(setupItems.size, 1);
  assert.equal(calls.setupItems.length, 2);
  assert.deepEqual(calls.setupItems.map((c) => c.options), [{ idempotencyKey: 'setup-sub_setup' }, { idempotencyKey: 'setup-sub_setup' }]);
  await run(a, () => billing.handleEvent(ev));
  assert.equal(calls.setupItems.length, 2);
  const disk = JSON.parse(fs.readFileSync(path.join(a.store.dataDir(), 'db.json'), 'utf8'));
  assert.deepEqual(Object.keys(disk.billing.events[0]).sort(), ['at', 'id', 'type']);
  assert.equal(disk.billing.events[0].id, ev.id);
});

test('setup removal provider failures also leave subscription deletion events retryable', async () => {
  live(); const { client } = fakeStripe(), a = tenant();
  primary(a, 'trialing');
  const subId = a.store.db.billing.subscription.id;
  const shop = { subscriptionId: subId, status: 'trialing', setup: { status: 'pending', itemId: 'ii_remove' } };
  a.store.db.billing.shops = [shop];
  client.subscriptions.retrieve = async () => ({ id: subId, status: 'canceled' });
  client.invoiceItems.retrieve = async () => ({ id: 'ii_remove', invoice: null });
  let deletes = 0;
  client.invoiceItems.del = async () => { if (++deletes === 1) throw new Error('delete unavailable'); return { deleted: true }; };
  const ev = event('customer.subscription.deleted', { id: subId, status: 'canceled' });
  await assert.rejects(run(a, () => billing.handleEvent(ev)), /delete unavailable/);
  assert.equal(a.store.db.billing.events.length, 0); assert.equal(shop.setup.status, 'pending');
  await run(a, () => billing.handleEvent(ev));
  assert.equal(deletes, 2); assert.equal(shop.setup.status, 'voided');
  assert.equal(a.store.db.billing.events[0].id, ev.id);
});

test('live retrieval errors preserve confirmed canceled state and do not complete or deduplicate the event', async () => {
  live(); const { client } = fakeStripe(), a = tenant(); primary(a, 'canceled');
  const confirmed = { ...a.store.db.billing.subscription };
  const ev = event('customer.subscription.updated', { ...confirmed, status: 'active' });
  let retrieves = 0;
  client.subscriptions.retrieve = async () => { retrieves++; throw new Error('retrieve unavailable'); };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(run(a, () => billing.handleEvent(ev)), /retrieve unavailable/);
    assert.deepEqual(a.store.db.billing.subscription, confirmed);
    assert.equal(a.store.db.billing.events.length, 0);
  }
  assert.equal(retrieves, 2);
  client.subscriptions.retrieve = async () => confirmed;
  await run(a, () => billing.handleEvent(ev));
  assert.equal(a.store.db.billing.subscription.status, 'canceled');
  assert.equal(a.store.db.billing.events[0].id, ev.id);
});

test('concurrent duplicate checkout events await one setup fee operation', async () => {
  live(); const { client, calls, setupItems } = fakeStripe(), a = tenant();
  client.subscriptions.retrieve = async (id) => ({ id, customer: 'cus_setup', status: 'trialing', metadata: { plan: 'monthly' } });
  const create = client.invoiceItems.create;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const creating = new Promise((resolve) => { entered = resolve; });
  client.invoiceItems.create = async (params, options) => { entered(); await gate; return create(params, options); };
  const ev = event('checkout.session.completed', { id: 'cs_concurrent', mode: 'subscription', customer: 'cus_setup', subscription: 'sub_concurrent' });
  const first = run(a, () => billing.handleEvent(ev));
  await creating;
  let returned = false;
  const second = run(a, () => billing.handleEvent(ev)).then((result) => { returned = true; return result; });
  await Promise.resolve();
  assert.equal(returned, false); assert.equal(a.store.db.billing.events.length, 0);
  release(); assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(calls.setupItems.length, 1); assert.equal(setupItems.size, 1);
  assert.equal(a.store.db.billing.events.length, 1);
});

test('concurrent duplicate notifications are single-flight but event IDs remain tenant and legacy scoped', async () => {
  const a = tenant(), b = tenant();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const notifying = new Promise((resolve) => { entered = resolve; });
  billing.init({ notify: async (text) => {
    messages.push({ shopId: context.shopId(), text });
    if (context.shopId() === a.id) { entered(); await gate; }
  } });
  const ev = event('invoice.payment_failed', { id: 'in_same', amount_due: 4900 });
  const first = run(a, () => billing.handleEvent(ev));
  await notifying;
  const second = run(a, () => billing.handleEvent(ev));
  await Promise.all([run(b, () => billing.handleEvent(ev)), billing.handleEvent(ev)]);
  assert.deepEqual(messages.map((m) => m.shopId).sort(), [a.id, b.id, null].sort());
  release(); await Promise.all([first, second]);
  await run(a, () => billing.handleEvent(ev));
  assert.equal(messages.length, 3);
});

test('event persistence failures leave completion retryable, including a failed completion write', async () => {
  for (const failAt of [1, 2]) {
    const a = tenant(), flush = a.store.flush;
    let flushes = 0;
    a.store.flush = async () => { if (++flushes === failAt) throw new Error('persistence failed'); return flush(); };
    const ev = event('customer.subscription.updated', { id: 'sub_persist', status: 'active' });
    await assert.rejects(run(a, () => billing.handleEvent(ev)), /persistence failed/);
    assert.equal(a.store.db.billing.events.length, 0);
    a.store.flush = flush;
    await run(a, () => billing.handleEvent(ev));
    assert.equal(a.store.db.billing.events.length, 1);
  }
});

test('pending reuse never returns a session tagged for another shop', async () => {
  const a = tenant(), b = tenant();
  const first = await run(a, checkout);
  b.store.db.billing.pendingCheckouts = { [first.id]: { ...a.store.db.billing.pendingCheckouts[first.id] } };
  const second = await run(b, checkout);
  assert.notEqual(second.id, first.id);
  assert.equal(b.store.db.billing.pendingCheckouts[second.id].shopId, b.id);
});

test('live portal customer and return URL are tenant-local; root keeps its configured return', async () => {
  live(); const { calls } = fakeStripe();
  process.env.BILLING_PORTAL_RETURN_URL = 'https://legacy.example/payments';
  const a = tenant({ BILLING_PORTAL_RETURN_URL: 'https://other.example' }); primary(a, 'active');
  await run(a, () => billing.portalUrl(BASE));
  assert.deepEqual(calls.portals[0], { customer: 'cus_scoped', return_url: `${BASE}/vendor#payments` });
  store.root.db.billing = { subscription: { customer: 'cus_root' } };
  await billing.portalUrl(BASE);
  assert.deepEqual(calls.portals[1], { customer: 'cus_root', return_url: 'https://legacy.example/payments' });
  await assert.rejects(run(tenant(), () => billing.portalUrl(BASE)), { status: 404 });
});

test('notification links resolve current context each time, never the most recent checkout BASE', async () => {
  const a = tenant(), b = tenant();
  await run(a, () => checkout({ BASE: 'https://not-the-platform.example' }));
  await run(b, () => checkout({ BASE: 'https://another.example' }));
  const failed = () => billing.handleEvent(event('invoice.payment_failed', { id: `in_${++sequence}`, amount_due: 4900 }));
  await Promise.all([run(a, failed), run(b, failed), failed()]);
  for (const id of [a.id, b.id, null]) {
    const message = messages.find((m) => m.shopId === id);
    assert.ok(message.text.includes(`${BASE}${id ? '/vendor' : ''}/billing/portal`));
    assert.ok(!message.text.includes('not-the-platform')); assert.ok(!message.text.includes('another.example'));
  }
  await run(a, () => billing.handleEvent(event('customer.subscription.trial_will_end', {
    id: 'sub_trial', customer: 'cus_trial', status: 'trialing', trial_end: Math.floor(Date.now() / 1000) + 86400,
  })));
  assert.ok(messages.at(-1).text.includes(`${BASE}/vendor/billing/portal`));
  assert.equal(messages.at(-1).shopId, a.id);
});

test('Connect ignores legacy account fallback in tenant contexts, including config overrides', async () => {
  live(); fakeStripe();
  assert.equal(connect.accountId(), 'acct_legacy');
  const a = tenant({ STRIPE_CONNECT_ACCOUNT_ID: 'acct_override' });
  await run(a, async () => {
    assert.equal(connect.accountId(), null);
    const b = deposit(a);
    assert.equal(await booking.depositLink(b, BASE), null);
    assert.equal(b.paid, false); assert.equal(b.payUrl, undefined);
  });
});

test('Connect account creation is single-flight per tenant with metadata, stable idempotency and vendor URLs', async () => {
  live(); const { client, calls } = fakeStripe(); const a = tenant(), b = tenant();
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const create = client.accounts.create;
  client.accounts.create = async (params, options) => { if (params.metadata.shopId === a.id) await gate; return create(params, options); };
  const first = run(a, () => connect.onboard(BASE));
  const second = run(a, () => connect.onboard(BASE));
  await run(b, () => connect.onboard(BASE));
  release(); const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one, two);
  assert.equal(calls.accounts.length, 2);
  for (const shop of [a, b]) {
    const call = calls.accounts.find((c) => c.params.metadata.shopId === shop.id);
    assert.equal(call.options.idempotencyKey, `connect-${shop.id}-test`);
    const link = calls.links.find((p) => p.account === `acct_${shop.id}`);
    assert.equal(link.refresh_url, `${BASE}/vendor/connect/refresh`);
    assert.equal(link.return_url, `${BASE}/vendor/connect/return`);
    const disk = JSON.parse(fs.readFileSync(path.join(shop.store.dataDir(), 'config.json'), 'utf8'));
    assert.equal(disk.stripeConnect.accountId, `acct_${shop.id}`);
  }
  await run(a, () => connect.onboard(BASE));
  assert.equal(calls.accounts.length, 2);
  assert.equal(store.root.getOverride().stripeConnect, undefined);
});

test('Connect creation failures release single-flight and reuse the idempotency key on retry', async () => {
  live(); const { client, calls } = fakeStripe(); const a = tenant(); const keys = [];
  const create = client.accounts.create;
  client.accounts.create = async (params, options) => {
    keys.push(options.idempotencyKey);
    if (keys.length === 1) throw new Error('provider unavailable');
    return create(params, options);
  };
  await assert.rejects(run(a, () => connect.onboard(BASE)), /provider unavailable/);
  await run(a, () => connect.onboard(BASE));
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal(calls.accounts.length, 1);
});

test('Connect mock vendor paths and legacy admin paths stay separate', async () => {
  const a = tenant(), b = tenant();
  const [one, two] = await Promise.all([run(a, () => connect.onboard(BASE)), run(b, () => connect.onboard(BASE))]);
  assert.equal(one.url, `${BASE}/vendor/connect/mock`); assert.notEqual(one.accountId, two.accountId);
  run(a, () => connect.mockComplete());
  assert.equal(run(a, connect.chargeAccount), one.accountId);
  assert.equal(run(b, connect.chargeAccount), null);
  assert.equal((await connect.onboard(BASE)).url, `${BASE}/admin/connect/mock`);
});

test('deposits charge only the scoped account and tag session and payment intent without changing timezone code', async () => {
  live(); const { calls } = fakeStripe(); const a = tenant({ LEAD_FEE_WAIVED: '0', LEAD_FEE: '12' }), b = tenant();
  await Promise.all([run(a, () => connect.onboard(BASE)), run(b, () => connect.onboard(BASE))]);
  for (const shop of [a, b]) {
    const held = deposit(shop);
    await run(shop, () => booking.depositLink(held, BASE));
    const call = calls.sessions.at(-1);
    assert.equal(call.options.stripeAccount, `acct_${shop.id}`);
    assert.deepEqual(call.params.metadata, { bookingId: held.id, shopId: shop.id });
    assert.deepEqual(call.params.payment_intent_data.metadata, call.params.metadata);
    assert.equal(call.params.payment_intent_data.application_fee_amount, shop === a ? 1200 : undefined);
    assert.equal(call.params.payment_intent_data.transfer_data, undefined);
    assert.equal(held.paid, false); assert.equal(held.status, 'held');
    const disk = JSON.parse(fs.readFileSync(path.join(shop.store.dataDir(), 'db.json'), 'utf8'));
    assert.equal(disk.bookings[0].stripeSessionId, held.stripeSessionId);
  }
  const legacy = { id: 'booking_root', amount: 49, slotLabel: 'Tomorrow' };
  await booking.depositLink(legacy, BASE);
  assert.equal(calls.sessions.at(-1).options.stripeAccount, 'acct_legacy');
  assert.deepEqual(calls.sessions.at(-1).params.metadata, { bookingId: 'booking_root' });
  assert.deepEqual(calls.sessions.at(-1).params.payment_intent_data.metadata, { bookingId: 'booking_root' });
});

test('Connect and deposit persistence failures reject without marking a payment successful', async () => {
  live(); const { calls } = fakeStripe(); const a = tenant();
  const status = a.store.status;
  a.store.status = () => ({ degraded: true });
  await assert.rejects(run(a, () => connect.onboard(BASE)), { status: 503 });
  assert.equal(calls.links.length, 0);
  a.store.status = status;
  await run(a, () => connect.onboard(BASE));
  assert.equal(calls.accounts.length, 1);
  const held = deposit(a);
  a.store.status = () => ({ degraded: true });
  await assert.rejects(run(a, () => booking.depositLink(held, BASE)), { status: 503 });
  assert.equal(held.paid, false); assert.equal(held.status, 'held');
});
