'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { randomBytes } = require('node:crypto');

const SECTIONS = ['overview', 'leads', 'bookings', 'payments', 'operations', 'setups'];
// Independent of src/ui.js: a broken production esc() must not change our expectations.
const escaped = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hostile = (label) => `${label}<img src=x onerror="alert(1)"> & ' " </script><script>alert(2)</script>`;

// Scan actual opening tags, not text containing escaped markup. No browser or DOM dependency.
function attributes(html, name) {
  // Tokenize complete attributes first so escaped text inside data-state cannot look like an event handler.
  const pattern = /([^\s=<>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  return (html.replace(/<!--[\s\S]*?-->/g, '').match(/<[a-z][^>]*>/gi) || [])
    .flatMap(tag => [...tag.replace(/^<[\w:-]+/, '').matchAll(pattern)]
      .filter(match => match[1].toLowerCase() === name.toLowerCase())
      .map(match => match[2] ?? match[3] ?? match[4] ?? ''));
}
function html(response, status = 200) {
  assert.equal(response.status, status);
  assert.match(response.headers['content-type'], /^text\/html\b/i);
  assert.match(response.body, /<!doctype html>/i);
  const ids = attributes(response.body, 'id');
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length, 'No duplicate element IDs');
  assert.ok(attributes(response.body, 'href').includes('/dashboard.css'));
  assert.ok(attributes(response.body, 'src').includes('/dashboard.js'));
  assert.match(response.body, /<script\b[^>]*src="\/dashboard\.js"[^>]*\bdefer\b/);
  return response.body;
}
function json(response, status = 200) {
  assert.equal(response.status, status);
  assert.match(response.headers['content-type'], /^application\/json\b/i);
  assert.equal(response.headers.location, undefined, 'JSON clients must not be redirected');
  return JSON.parse(response.body);
}
function redirect(response, location) {
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, location);
}
function assertEscaped(body, values) {
  for (const value of values) {
    assert.ok(body.includes(escaped(value)), 'Untrusted content remains visible as escaped text');
    assert.ok(!body.includes(value), 'Raw hostile markup must not be published');
  }
  assert.equal(attributes(body, 'onerror').length, 0);
  assert.equal(attributes(body, 'onload').length, 0);
  assert.doesNotMatch(body, /<script\b[^>]*>\s*alert\(/i);
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-dashboard-http-'));
  const originalEnv = { ...process.env };
  const replaceEnv = (next) => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, next);
  };
  const markers = new Set();
  const marker = () => { const value = `fixture-only-${randomBytes(24).toString('hex')}`; markers.add(value); return value; };
  const adminPassword = marker();
  const baseline = {
    NODE_ENV: 'test', TZ: 'UTC', BUSINESS_TZ: 'UTC', DATA_DIR: dir,
    PUBLIC_BASE_URL: 'http://shop.example', ADMIN_PASSWORD: adminPassword,
    BUSINESS_NAME: 'Fixture shop', OWNER_PHONE: '', FORWARD_TO_PHONE: '',
    BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1', DEPOSIT_AMOUNT: '49',
    LEAD_FEE_WAIVED: '1', TRIAL_DAYS: '14', FOUNDING_SHOPS_LIMIT: '0',
    MOCK_PRICE_MONTHLY: '49', MOCK_PRICE_ANNUAL: '588', MOCK_SETUP_FEE: '99',
    TRUST_PROXY: '0', CHECKOUT_RATE_MAX: '1000',
  };
  let blockedCalls = 0;
  const denyProvider = () => { blockedCalls++; throw new Error('Provider transport is disabled in dashboard tests'); };
  let server, store;
  const timers = [];
  t.after(async () => {
    for (const timer of timers) clearInterval(timer);
    try {
      if (server) {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections?.();
        });
      }
      if (store) await store.close();
      // Exact mkdtemp result, containing fake fixture data only.
      fs.rmSync(dir, { recursive: true, force: true });
    } finally { replaceEnv(originalEnv); }
    assert.equal(blockedCalls, 0, 'No route may even attempt external provider transport');
  });
  // No inherited provider credentials, database URL, Render flags or dotenv file.
  // Register cleanup first so even an import failure restores the environment.
  replaceEnv(baseline);
  t.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
  t.mock.method(https, 'request', denyProvider);
  t.mock.method(https, 'get', denyProvider);
  t.mock.method(globalThis, 'fetch', denyProvider);
  store = require('../src/store');
  const billing = require('../src/billing');
  const connect = require('../src/connect');
  const sms = require('../src/sms');
  connect.setStripe(denyProvider);
  sms.setClient(null);
  t.after(() => connect.setStripe(null));
  // Keep the server's hold-expiry interval from outliving this isolated fixture.
  const setIntervalOriginal = globalThis.setInterval;
  globalThis.setInterval = (...args) => { const timer = setIntervalOriginal(...args); timers.push(timer); return timer; };
  let app;
  try { ({ app } = require('../src/server')); }
  finally { globalThis.setInterval = setIntervalOriginal; }
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (target, { method = 'GET', admin = false, headers = {}, body } = {}) => {
    const url = new URL(target, origin);
    assert.equal(url.origin, origin, 'Requests must stay on this fixture, never follow provider redirects');
    assert.equal(url.username + url.password, '');
    return new Promise((resolve, reject) => {
      const req = http.request(url, {
        method, agent: false, signal: t.signal,
        headers: { accept: 'text/html', ...(admin ? { authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}` } : {}),
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }), ...headers },
      });
      const timeout = setTimeout(() => req.destroy(new Error('Local HTTP request timed out')), 3000);
      const fail = (error) => { clearTimeout(timeout); reject(error); };
      req.on('error', fail);
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', fail);
        res.on('end', () => {
          clearTimeout(timeout);
          try {
            const result = { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
            const published = JSON.stringify(result);
            for (const value of markers) assert.ok(!published.includes(value), 'Response must never contain a fixture secret');
            if (/^\/(admin|api\/billing|billing|pay|payment)(\/|$)/i.test(url.pathname)) {
              assert.equal(res.headers['cache-control'], 'private, no-store', `${method} ${url.pathname}: private cache policy`);
              assert.equal(res.headers['referrer-policy'], 'no-referrer', `${method} ${url.pathname}: capability URL privacy`);
            }
            resolve(result);
          } catch (error) { reject(error); }
        });
      });
      req.end(body);
    });
  };
  const post = (target, { body = {}, json: asJson = false, admin = false, origin: from = origin, referer, accept } = {}) => request(target, {
    method: 'POST', admin,
    headers: { 'content-type': asJson ? 'application/json' : 'application/x-www-form-urlencoded',
      accept: accept || (asJson ? 'application/json' : 'text/html'),
      ...(from === null ? {} : { origin: from }), ...(referer ? { referer } : {}) },
    body: asJson ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  });
  function reset(overrides = {}) {
    replaceEnv({ ...baseline, ...overrides });
    store.setOverride({});
    for (const key of Object.keys(store.db)) delete store.db[key];
    Object.assign(store.db, { leads: [], bookings: [], alerts: [], waitlist: [], billing: {}, setups: [], optOuts: {} });
    billing.summary(); // Initialise billing defaults before read-only snapshots.
    store.save();
    app.locals.resetAdminLockout();
    app.locals.resetFormLimits();
    sms.resetCap();
  }
  function seedBooking(extra = {}) {
    const now = Date.now();
    const b = { id: `booking-${randomBytes(6).toString('hex')}`, leadId: 'fixture-lead', phone: '+14705550123',
      name: 'Fixture customer', need: 'Fixture repair', service: 'Fixture service', slotLabel: 'Tomorrow 9–11',
      slotStart: new Date(now + 86400000).toISOString(), slotEnd: new Date(now + 93600000).toISOString(),
      createdAt: new Date(now).toISOString(), holdExpiresAt: new Date(now + 3600000).toISOString(),
      status: 'held', paid: false, amount: 49, ...extra };
    store.db.bookings.push(b); store.save(); return b;
  }
  function snapshot() {
    const files = {};
    for (const name of fs.readdirSync(dir).sort()) {
      const filename = path.join(dir, name), stat = fs.statSync(filename, { bigint: true });
      files[name] = { contents: fs.readFileSync(filename, 'utf8'), mtime: stat.mtimeNs, ctime: stat.ctimeNs };
    }
    return { state: JSON.stringify(store.db), override: JSON.stringify(store.getOverride()), files };
  }
  async function checkout(plan = 'monthly') {
    const result = json(await post('/api/checkout', { json: true, body: { plan, email: 'fixture@example.com' } }));
    assert.equal(result.mock, true);
    assert.match(result.id, /^cs_mock_[a-f0-9]+$/);
    // PUBLIC_BASE_URL is deliberately inert; only its local path is requested.
    const url = new URL(result.url);
    assert.equal(url.origin, baseline.PUBLIC_BASE_URL);
    assert.equal(url.pathname, `/billing/mock/checkout/${result.id}`);
    return { ...result, path: url.pathname };
  }
  reset();
  return { request, post, reset, seedBooking, snapshot, checkout, store, marker, origin };
}

test('dashboard and payment safety over isolated local HTTP', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);

  await t.test('authenticated dashboard and billing portal link real assets and all six workspace sections', async () => {
    f.reset();
    for (const route of ['/admin', '/admin/legacy', '/billing/mock/portal', '/billing/portal', '/billing/status', '/admin/connect/mock']) {
      const denied = await f.request(route);
      assert.equal(denied.status, 401);
      assert.match(denied.headers['www-authenticate'], /^Basic /);
      assert.doesNotMatch(denied.body, /Fixture shop|Owner workspace/);
    }
    const before = f.snapshot();
    const dashboard = html(await f.request('/admin/legacy', { admin: true }));
    const portal = html(await f.request('/billing/mock/portal', { admin: true }));
    assert.deepEqual(attributes(dashboard, 'data-page'), SECTIONS);
    for (const body of [dashboard, portal]) {
      assert.deepEqual(attributes(body, 'data-nav'), SECTIONS);
      for (const section of SECTIONS) {
        assert.ok(attributes(body, 'href').includes(`/admin#${section}`));
        assert.ok(attributes(dashboard, 'id').includes(section), 'Navigation resolves into the dashboard');
      }
      assert.match(body, /Demo payments/);
      assert.match(body, /No real money moves/);
    }
    assert.match(dashboard, /No leads yet/);
    assert.match(dashboard, /No bookings yet|Your schedule starts here/);
    assert.match(portal, /No real card is stored here/);
    redirect(await f.request('/billing/portal', { admin: true }), 'http://shop.example/billing/mock/portal');
    assert.deepEqual(f.snapshot(), before, 'Reading private pages cannot seed customers or billing records');
    for (const [asset, type] of [['/dashboard.css', /^text\/css\b/], ['/dashboard.js', /^(application|text)\/javascript\b/]]) {
      const response = await f.request(asset);
      assert.equal(response.status, 200);
      assert.match(response.headers['content-type'], type);
      assert.ok(response.body.trim().length > 0);
    }
  });

  await t.test('hostile business, lead, booking, alert and invoice data stay text, including attribute contexts', async () => {
    const business = hostile('Business'), leadName = hostile('Lead'), need = hostile('Need'), window = hostile('Callback');
    const bookingName = hostile('Booking'), service = hostile('Service'), slot = hostile('Time'), alert = hostile('Alert');
    const state = 'collecting" onmouseover="alert(3)', email = hostile('Waitlist');
    f.reset({ BUSINESS_NAME: business });
    f.store.db.leads.push({ id: 'fixture-lead', name: leadName, phone: 'javascript:alert(4)', need, window,
      status: state, messages: [], createdAt: new Date().toISOString() });
    const b = f.seedBooking({ name: bookingName, service, slotLabel: slot });
    f.store.db.alerts.push({ body: alert, at: new Date().toISOString() });
    f.store.db.waitlist.push({ email, businessType: 'braiders', at: new Date().toISOString() });
    const invoiceId = hostile('Invoice');
    const badLinks = ['javascript:alert(5)', 'https://invoice.stripe.com.evil.example/x', '//invoice.stripe.com/x',
      'https://evil.example/invoice', 'https://user@invoice.stripe.com/x', 'http://invoice.stripe.com/x'];
    f.store.db.billing.invoices = badLinks.map((url, i) => ({ id: `${invoiceId}${i}`, reason: 'subscription', status: 'open',
      amount_due: 49, at: new Date().toISOString(), url }));
    f.store.db.billing.invoices.push({ id: 'safe-invoice', status: 'paid', amount_paid: 49,
      at: new Date().toISOString(), url: 'https://invoice.stripe.com/i/fixture?one=1&two=2' });
    f.store.save();
    const before = f.snapshot();
    const dashboard = html(await f.request('/admin/legacy', { admin: true }));
    assertEscaped(dashboard, [business, leadName, need, window, bookingName, service, slot, alert, email]);
    assert.ok(dashboard.includes(`data-state="${escaped(state)}"`));
    assert.equal(attributes(dashboard, 'onmouseover').length, 0);
    const portal = html(await f.request('/billing/mock/portal', { admin: true }));
    for (const body of [dashboard, portal]) {
      assertEscaped(body, [business, invoiceId + '0']);
      const hrefs = attributes(body, 'href');
      for (const url of badLinks) assert.ok(!hrefs.includes(url), 'Unsafe invoice destinations must not be linked');
      assert.ok(!hrefs.some((url) => /^(javascript:|tel:javascript:)/i.test(url)));
      assert.ok(hrefs.includes('https://invoice.stripe.com/i/fixture?one=1&amp;two=2'));
      assert.match(body, /target="_blank" rel="noopener noreferrer"/);
    }
    assertEscaped(html(await f.request(`/pay/mock/${b.id}`)), [business, service, slot]);
    assert.deepEqual(f.snapshot(), before, 'Rendering hostile data is read-only');
    const session = await f.checkout(), created = f.snapshot();
    assertEscaped(html(await f.request(session.path)), [business]);
    assert.deepEqual(f.snapshot(), created, 'Rendering checkout is read-only too');
  });

  await t.test('secrets never reach private pages, payment pages, JSON status or headers', async () => {
    f.reset();
    // Synthetic sentinels only, set AFTER imports: no provider client/database is initialised with these.
    for (const key of ['STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'TWILIO_AUTH_TOKEN',
      'OPENAI_API_KEY', 'DATABASE_URL', 'SETUP_WAIVER_CODE']) process.env[key] = f.marker();
    const b = f.seedBooking(), session = await f.checkout();
    for (const route of ['/admin', '/admin/legacy', '/billing/mock/portal', '/admin/connect/mock', '/billing/status',
      '/admin/connect/status', `/pay/mock/${b.id}`, session.path, '/payment/return?status=success', '/billing/return?status=success']) {
      const response = await f.request(route, { admin: true });
      assert.equal(response.status, 200); // fixture checks every response body AND headers against every sentinel
    }
    for (const mode of ['test', 'live']) {
      process.env.STRIPE_SECRET_KEY = `sk_${mode}_${f.marker()}`;
      html(await f.request('/admin/legacy', { admin: true }));
      html(await f.request('/payment/return?status=success'));
      json(await f.request('/billing/status', { admin: true }));
    }
  });

  await t.test('mock, Stripe test and live readiness labels do not confuse simulations with real deposits', async () => {
    for (const mode of ['mock', 'test', 'live']) {
      f.reset(mode === 'mock' ? {} : { STRIPE_SECRET_KEY: `sk_${mode}_${f.marker()}` });
      f.store.setOverride({ stripeConnect: { accountId: `acct_fixture_${mode}`, mode,
        chargesEnabled: true, payoutsEnabled: true, requirementsDue: [] } });
      const before = f.snapshot();
      const body = html(await f.request('/admin/legacy', { admin: true }));
      if (mode === 'mock') {
        assert.match(body, /Demo payments/);
        assert.match(body, /Simulated amounts · no real money/);
        assert.match(body, /No live deposits/);
        assert.doesNotMatch(body, />Deposits enabled</);
      } else if (mode === 'test') {
        assert.match(body, /Stripe test mode/);
        assert.match(body, /Stripe test amounts · no real money/);
        assert.match(body, /Test deposits only/);
        assert.doesNotMatch(body, />Deposits enabled</);
        assert.doesNotMatch(body, /Demo payments/);
      } else {
        assert.match(body, /Live Stripe/);
        assert.match(body, />Deposits enabled</);
        assert.doesNotMatch(body, /Demo payments|Stripe test mode|Simulated amounts/);
        process.env.DEPOSIT_ENABLED = '0';
        const disabled = html(await f.request('/admin/legacy', { admin: true }));
        assert.match(disabled, />Deposits off</);
        assert.doesNotMatch(disabled, />Deposits enabled</);
      }
      assert.deepEqual(f.snapshot(), before, 'Mode labels are derived locally, without syncing providers or changing state');
    }
  });

  await t.test('demo GET and POST routes are hidden when production disallows demo or Stripe is configured', async () => {
    for (const env of [{ NODE_ENV: 'production', DEMO_MODE: '0' },
      { NODE_ENV: 'production', DEMO_MODE: '1', STRIPE_SECRET_KEY: `sk_test_${f.marker()}` },
      { STRIPE_SECRET_KEY: `sk_live_${f.marker()}` }]) {
      f.reset();
      const b = f.seedBooking(), session = await f.checkout();
      Object.assign(process.env, env);
      const before = f.snapshot();
      for (const route of [`/pay/mock/${b.id}`, session.path, '/billing/mock/portal', '/admin/connect/mock']) {
        assert.equal((await f.request(route, { admin: true })).status, 404);
      }
      for (const route of [`/pay/mock/${b.id}`, `${session.path}/complete`, '/billing/mock/update-card',
        '/billing/mock/advance', '/admin/connect/mock/complete']) {
        assert.equal((await f.post(route, { admin: true })).status, 404);
      }
      if (!env.STRIPE_SECRET_KEY) {
        assert.equal((await f.post('/api/checkout', { json: true })).status, 503);
        const body = html(await f.request('/admin/legacy', { admin: true }));
        assert.match(body, /Payments are not configured/);
        assert.doesNotMatch(body, /Demo payments|action="\/admin\/connect\/onboard"/);
      }
      assert.deepEqual(f.snapshot(), before, 'Disabled demo endpoints cannot write');
    }
    f.reset({ NODE_ENV: 'production', DEMO_MODE: '1' });
    const b = f.seedBooking(), session = await f.checkout();
    for (const route of [`/pay/mock/${b.id}`, session.path, '/billing/mock/portal', '/admin/connect/mock']) {
      assert.match(html(await f.request(route, { admin: true })), /Demo payments/);
    }
  });

  await t.test('deposit GET/HEAD do not pay; explicit same-origin POST confirms once and returns a safe receipt', async () => {
    f.reset();
    f.store.db.leads.push({ id: 'fixture-lead', name: 'Fixture customer', phone: '+14705550123', messages: [] });
    const b = f.seedBooking(), route = `/pay/mock/${b.id}`, before = f.snapshot();
    const body = html(await f.request(route + '?paid=true&status=success'));
    assert.match(body, /Held · awaiting demo payment/);
    assert.match(body, new RegExp(`<form method="post" action="${route}"`));
    assert.doesNotMatch(body, /Demo booking confirmed|Simulated confirmation/);
    assert.equal((await f.request(route, { method: 'HEAD' })).status, 200);
    assert.deepEqual(f.snapshot(), before, 'Link previews and GETs are read-only, including disk and SMS log');
    for (const origin of [null, 'null', 'https://evil.example', 'http://127.0.0.1:1']) {
      assert.equal((await f.post(route, { origin })).status, 403);
      assert.deepEqual(f.snapshot(), before);
    }
    redirect(await f.post(route), route); // No admin auth: the deposit URL is the capability.
    assert.equal(b.paid, true);
    assert.equal(b.status, 'confirmed');
    assert.ok(Number.isFinite(Date.parse(b.paidAt)));
    assert.equal(f.store.db.alerts.length, 1);
    assert.equal(f.store.db.leads[0].messages.length, 1);
    const paid = f.snapshot();
    redirect(await f.post(route), route);
    const receipt = html(await f.request(route));
    assert.match(receipt, /Demo booking confirmed/);
    assert.match(receipt, /not a real payment receipt/i);
    assert.ok(!attributes(receipt, 'action').includes(route), 'Completed receipt must not invite another payment');
    assert.deepEqual(f.snapshot(), paid, 'Duplicate POST does not rewrite payment, duplicate alerts or send another SMS');
    const second = f.seedBooking();
    redirect(await f.post(`/pay/mock/${second.id}`, { origin: null, referer: `${f.origin}/pay/mock/${second.id}` }), `/pay/mock/${second.id}`);
    assert.equal(second.paid, true, 'Existing same-origin Referer fallback remains supported');
  });

  await t.test('expired, invalid and unavailable holds return 409 without recording payment or writing anything', async () => {
    for (const extra of [{ holdExpiresAt: new Date(Date.now() - 3600000).toISOString() },
      { status: 'expired' }, { holdExpiresAt: 'not-a-date' }, { status: 'confirmed', paid: false }]) {
      f.reset();
      const b = f.seedBooking(extra), route = `/pay/mock/${b.id}`, before = f.snapshot();
      const responses = [[await f.request(route), 200], [await f.post(route), 409]];
      for (const [response, expectedStatus] of responses) {
        const body = html(response, expectedStatus);
        assert.ok(!attributes(body, 'action').includes(route));
        assert.doesNotMatch(body, /Demo booking confirmed|Confirm demo payment/);
      }
      assert.deepEqual(f.snapshot(), before, 'Rejected expired/invalid hold must not save, expire, notify or mark paid');
      assert.equal(b.paid, false);
    }
    const before = f.snapshot();
    assert.equal((await f.request('/pay/mock/unknown-fixture')).status, 404);
    assert.equal((await f.post('/pay/mock/unknown-fixture')).status, 404);
    assert.deepEqual(f.snapshot(), before);
  });

  await t.test('a recorded payment with a lost or unresolved slot never claims the booking is confirmed', async () => {
    for (const status of ['paid_conflict', 'expired']) {
      f.reset();
      const b = f.seedBooking({ status, paid: true }), route = `/pay/mock/${b.id}`, before = f.snapshot();
      const body = html(await f.request(route));
      assert.doesNotMatch(body, /Demo booking confirmed|Simulated confirmation|Confirm demo payment/);
      assert.ok(!attributes(body, 'action').includes(route));
      if (status === 'paid_conflict') {
        assert.match(body, /time was not booked/);
        assert.match(body, /Follow-up needed/);
      } else {
        assert.match(body, /Contact the business to confirm booking status/);
      }
      redirect(await f.post(route), route);
      assert.deepEqual(f.snapshot(), before, 'Retrying a recorded payment cannot silently resolve the lost slot');
    }
  });

  await t.test('mock checkout GET is read-only, HTML completes via 303, and JSON clients retain their contract', async () => {
    for (const trialDays of ['14', '0']) {
      f.reset({ TRIAL_DAYS: trialDays });
      const session = await f.checkout(), before = f.snapshot();
      const body = html(await f.request(session.path));
      assert.match(body, /Review your demo plan/);
      assert.match(body, /No real money moves/);
      assert.ok(attributes(body, 'action').includes(`${session.path}/complete`));
      if (trialDays === '14') {
        assert.match(body, /Simulated amount due today<\/span><strong>\$0\.00/);
        assert.match(body, /first simulated invoice after the trial is \$148\.00/);
      } else {
        assert.match(body, /Simulated amount due today<\/span><strong>\$148\.00/);
        assert.match(body, /No trial is configured/);
      }
      assert.deepEqual(f.snapshot(), before);
      for (const origin of [null, 'https://evil.example']) {
        assert.equal((await f.post(`${session.path}/complete`, { origin })).status, 403);
        assert.deepEqual(f.snapshot(), before);
      }
      redirect(await f.post(`${session.path}/complete`), session.path);
      const subscription = f.store.db.billing.subscription;
      assert.equal(subscription.status, trialDays === '14' ? 'trialing' : 'active');
      assert.equal(f.store.db.billing.mock.sessions[session.id].completed, true);
      assert.equal(f.store.db.billing.invoices.length, 1);
      assert.equal(f.store.db.billing.invoices[0].amount_paid, trialDays === '14' ? 0 : 148);
      const completed = f.snapshot();
      const receipt = html(await f.request(session.path));
      assert.match(receipt, /Checkout simulation finished/);
      assert.match(receipt, /not a receipt for a real payment/);
      assert.ok(!attributes(receipt, 'action').includes(`${session.path}/complete`));
      redirect(await f.post(`${session.path}/complete`), session.path);
      const duplicate = json(await f.post(`${session.path}/complete`, { json: true }));
      assert.equal(duplicate.ok, true);
      assert.deepEqual(duplicate.subscription, subscription);
      assert.deepEqual(f.snapshot(), completed, 'Repeated completion is read-only and does not create another invoice');
    }
    // JSON content type wins even if an HTML Accept header is also present.
    f.reset();
    const annual = await f.checkout('annual');
    const page = html(await f.request(annual.path));
    assert.match(page, /Annual plan/);
    assert.match(page, /Waived/);
    assert.match(page, /\$588\.00/);
    const result = json(await f.post(`${annual.path}/complete`, { json: true, accept: 'text/html' }));
    assert.equal(result.ok, true);
    assert.equal(result.subscription.plan, 'annual');
    assert.equal(result.subscription.status, 'trialing');
    assert.equal(f.store.db.billing.shops[0].setup.status, 'waived');
    assert.equal((await f.request('/billing/mock/checkout/unknown-fixture')).status, 404);
    json(await f.post('/billing/mock/checkout/unknown-fixture/complete', { json: true }), 404);
  });

  await t.test('billing cancel/resume preserve auth, origin and HTML redirect versus JSON response contracts', async () => {
    f.reset();
    const session = await f.checkout();
    json(await f.post(`${session.path}/complete`, { json: true }));
    const initial = f.store.db.billing.subscription;
    const periodEnd = initial.current_period_end, invoiceCount = f.store.db.billing.invoices.length;
    for (const [action, cancel] of [['cancel', true], ['resume', false]]) {
      const route = `/api/billing/${action}`, before = f.snapshot();
      for (const options of [{ admin: false }, { admin: true, origin: null }, { admin: true, origin: 'https://evil.example' }]) {
        assert.equal((await f.post(route, options)).status, options.admin ? 403 : 401);
        assert.deepEqual(f.snapshot(), before);
      }
      redirect(await f.post(route, { admin: true }), '/admin#payments');
      const sub = f.store.db.billing.subscription;
      assert.equal(sub.cancel_at_period_end, cancel);
      assert.equal(sub.current_period_end, periodEnd);
      assert.equal(sub.status, 'trialing', 'Cancel schedules the end, not immediate loss of access');
      assert.equal(f.store.db.billing.invoices.length, invoiceCount, 'Cancellation/resume does not charge or refund');
      const page = html(await f.request('/billing/mock/portal', { admin: true }));
      assert.ok(attributes(page, 'action').includes(`/api/billing/${cancel ? 'resume' : 'cancel'}`));
      if (cancel) assert.match(page, /Cancellation scheduled/);
    }
    for (const [action, cancel, options] of [['cancel', true, { json: true }], ['resume', false, { accept: 'application/json' }]]) {
      const result = json(await f.post(`/api/billing/${action}`, { admin: true, ...options }));
      assert.equal(result.id, initial.id);
      assert.equal(result.cancel_at_period_end, cancel);
      assert.equal(result.current_period_end, periodEnd);
      assert.equal(result.status, 'trialing');
    }
    const before = f.snapshot();
    for (const route of ['/admin/config/reset', '/admin/connect/onboard', '/admin/connect/mock/complete', '/billing/mock/update-card']) {
      assert.equal((await f.post(route)).status, 401);
      assert.equal((await f.post(route, { admin: true, origin: 'https://evil.example' })).status, 403);
      assert.deepEqual(f.snapshot(), before, 'Existing admin and billing guards remain effective');
    }
  });

  await t.test('generic deposit/subscription returns cannot verify payment from hostile query parameters', async () => {
    f.reset();
    const b = f.seedBooking(), session = await f.checkout(), before = f.snapshot();
    const injected = hostile('Return');
    for (const route of ['/payment/return', '/billing/return']) {
      for (const status of ['success', 'cancel', 'paid', injected]) {
        const query = new URLSearchParams({ status, paid: 'true', payment_status: 'paid', bookingId: b.id,
          session_id: session.id, subscription_status: 'active', businessName: injected, message: injected });
        const body = html(await f.request(`${route}?${query}`));
        if (status === 'success') {
          assert.match(body, /Confirmation comes separately/);
          assert.match(body, /does not verify payment, a booking or subscription activation/);
        } else {
          assert.match(body, /This is not a payment confirmation/);
          assert.match(body, /does not establish whether a payment was processed/);
        }
        assert.doesNotMatch(body, /Demo booking confirmed|Checkout simulation finished|Payment successful|Subscription activated|Payment received/i);
        assert.ok(!body.includes(injected));
        assert.equal(attributes(body, 'onerror').length, 0);
        assert.deepEqual(f.snapshot(), before, 'Query parameters cannot mark paid, activate billing, send messages or write files');
      }
    }
    assert.equal(b.paid, false);
    assert.equal(f.store.db.billing.subscription, undefined);
    assert.notEqual(f.store.db.billing.mock.sessions[session.id].completed, true);
  });
});
