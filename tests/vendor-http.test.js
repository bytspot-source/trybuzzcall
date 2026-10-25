'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { randomBytes, createHash } = require('node:crypto');

// Like dashboard-http.test.js, use a real loopback listener, not a browser or a live provider.
// Never pass response bodies, credentials, cookies, registry objects or snapshots to assertions:
// even a failing test must not publish them in a diff. All dynamic comparisons are booleans.
const check = (condition, message) => assert.equal(Boolean(condition), true, message);
const status = (response, expected) => assert.equal(response.status, expected);
const fingerprint = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const BASE = 'http://shop.example';
const CALLER = '+14705550123';
const NUMBERS = ['+14705550101', '+14705550102'];
const SRC = path.resolve(__dirname, '../src') + path.sep;

function json(response, expected = 200) {
  status(response, expected);
  check(/^application\/json\b/i.test(response.headers['content-type'] || ''), 'JSON response');
  // JSON.parse errors can contain a response excerpt (including credentials).
  try { return JSON.parse(response.body); } catch { throw new Error('Invalid fixture JSON response'); }
}
function html(response, expected = 200) {
  status(response, expected);
  check(/^text\/html\b/i.test(response.headers['content-type'] || ''), 'HTML response');
  check(/<!doctype html>/i.test(response.body), 'Complete HTML document');
  return response.body;
}
function invitationCode(response) {
  const body = html(response);
  const match = /<pre\b[^>]*class="activation-code"[^>]*>\s*<code>([A-Za-z0-9_-]{43})<\/code>\s*<\/pre>/.exec(body);
  check(!!match, 'Private invitation contains one activation code');
  return match[1];
}
function filesDigest(dir) {
  const entries = [];
  const walk = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const filename = path.join(current, name);
      const stat = fs.statSync(filename, { bigint: true });
      if (stat.isDirectory()) walk(filename);
      else entries.push([path.relative(dir, filename), fingerprint(fs.readFileSync(filename)),
        String(stat.mtimeNs), String(stat.ctimeNs)]);
    }
  };
  walk(dir);
  return fingerprint(JSON.stringify(entries));
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-vendor-http-'));
  const originalEnv = { ...process.env };
  const savedModules = Object.entries(require.cache).filter(([filename]) => filename.startsWith(SRC));
  const clearModules = () => {
    for (const filename of Object.keys(require.cache)) if (filename.startsWith(SRC)) delete require.cache[filename];
  };
  const replaceEnv = next => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, next);
  };
  const secrets = new Set();
  const makeSecret = () => { const value = secret(); secrets.add(value); return value; };
  const adminPassword = makeSecret(), twilioToken = makeSecret();
  const authorization = `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}`;
  secrets.add(authorization); secrets.add(authorization.slice(6));
  const intervals = [], timeouts = [], messages = [];
  const children = new Map();
  let blockedCalls = 0, server, store, vendors, sms, connect, gate;
  const denyProvider = () => { blockedCalls++; throw new Error('External provider transport disabled in vendor tests'); };
  const nativeRequest = http.request;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeSetInterval = globalThis.setInterval;

  // Cleanup is registered before imports so failed setup cannot leave an environment, timer or store behind.
  t.after(async () => {
    gate?.release();
    for (const timer of intervals) clearInterval(timer);
    for (const timer of timeouts) clearTimeout(timer);
    try {
      if (server) await new Promise((resolve, reject) => {
        server.close(error => error ? reject(new Error('Fixture listener cleanup failed')) : resolve());
        server.closeAllConnections?.();
      });
    } finally {
      try { if (vendors) await vendors.close(); }
      finally {
        try { if (store) await store.close(); }
        finally {
          sms?.setClient(null); connect?.setStripe(null);
          clearModules();
          for (const [filename, module] of savedModules) require.cache[filename] = module;
          replaceEnv(originalEnv);
          // Only the exact mkdtemp directory, containing this test's synthetic data, is removed.
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    assert.equal(blockedCalls, 0, 'No external provider transport was attempted');
  });
  replaceEnv({ NODE_ENV: 'test', TZ: 'UTC', BUSINESS_TZ: 'UTC', DATA_DIR: dir,
    PUBLIC_BASE_URL: BASE, ADMIN_PASSWORD: adminPassword, TWILIO_AUTH_TOKEN: twilioToken,
    TWILIO_PHONE_NUMBER: '+14705550100', BUSINESS_NAME: 'Legacy fixture business',
    OWNER_PHONE: '', FORWARD_TO_PHONE: '', TRUST_PROXY: '0', TEXTBACK_COOLDOWN_MINUTES: '0',
    BILLING_REQUIRE_SUBSCRIPTION: '0', TRIAL_DAYS: '14', FOUNDING_SHOPS_LIMIT: '0',
    MOCK_PRICE_MONTHLY: '49', MOCK_PRICE_ANNUAL: '588', MOCK_SETUP_FEE: '99',
    OUTBOUND_MAX_PER_HOUR: '0', OUTBOUND_MAX_PER_DAY: '0', CHECKOUT_RATE_MAX: '1000' });
  clearModules();
  t.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
  // Suppress application logging entirely, including unexpected provider/error messages. Do not retain or print
  // log arguments ourselves. Test diagnostics still come from node:test and contain only safe assertions.
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, method, () => {});
  t.mock.method(https, 'request', denyProvider);
  t.mock.method(https, 'get', denyProvider);
  t.mock.method(http, 'get', denyProvider);
  t.mock.method(globalThis, 'fetch', denyProvider);
  t.mock.method(http, 'request', (url, ...args) => {
    if (!(url instanceof URL) || !server || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.port !== String(server.address()?.port)) return denyProvider();
    return nativeRequest.call(http, url, ...args);
  });
  t.mock.method(globalThis, 'setInterval', (...args) => {
    const timer = nativeSetInterval(...args); intervals.push(timer); return timer;
  });
  t.mock.method(globalThis, 'setTimeout', (...args) => {
    const timer = nativeSetTimeout(...args); timeouts.push(timer); return timer;
  });
  store = require('../src/store');
  vendors = require('../src/vendors');
  connect = require('../src/connect');
  sms = require('../src/sms');
  const config = require('../src/config');
  const billing = require('../src/billing');
  const booking = require('../src/booking');
  const context = require('../src/shopContext');
  const twilio = require('twilio');
  await store.init();
  connect.setStripe(denyProvider);
  sms.setClient({ messages: { create: async params => {
    const before = context.shopId();
    const currentGate = gate;
    if (currentGate) {
      if (--currentGate.remaining === 0) { gate = null; currentGate.release(); }
      await currentGate.promise;
    }
    // Deliberately yield inside the shared client, exercising context across an asynchronous provider call.
    await new Promise(resolve => setImmediate(resolve));
    messages.push({ ...params, before, after: context.shopId() });
    return { sid: `SM${randomBytes(16).toString('hex')}` };
  } } });
  sms.resetCap();
  const { app } = require('../src/server');
  billing.summary();
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', () => reject(new Error('Fixture listener failed')));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (target, { method = 'GET', admin = false, cookie, headers = {}, body, invitation = false } = {}) => {
    const url = new URL(target, origin);
    check(url.origin === origin && !url.username && !url.password, 'Requests stay on the fixture; redirects are never followed');
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method, agent: false, signal: t.signal,
        headers: { host: new URL(BASE).host, accept: 'text/html',
          ...(admin ? { authorization } : {}), ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }), ...headers } });
      const timeout = nativeSetTimeout(() => req.destroy(new Error('Local request timed out')), 5000);
      const fail = () => { clearTimeout(timeout); reject(new Error('Local fixture HTTP request failed')); };
      req.on('error', fail);
      req.on('response', res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', fail);
        res.on('end', () => {
          clearTimeout(timeout);
          try {
            const result = { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
            const issued = invitation && result.status === 200 ? invitationCode(result) : null;
            if (issued) secrets.add(issued);
            const publishedHeaders = { ...result.headers };
            if (url.pathname === '/vendor/login' || url.pathname === '/vendor/logout') {
              for (const line of result.headers['set-cookie'] || []) {
                const value = /^buzzcall_vendor=([^;]+)/.exec(line)?.[1];
                if (value) secrets.add(value);
              }
              // A login cookie is intentionally returned in this header, never in HTML or a redirect URL.
              delete publishedHeaders['set-cookie'];
            }
            for (const value of secrets) {
              check(value === issued || !result.body.includes(value), 'Response body must not disclose a fixture credential');
              check(!JSON.stringify(publishedHeaders).includes(value), 'Response headers must not disclose a fixture credential');
            }
            if (/^\/(admin|vendor|billing|pay)(\/|$)/i.test(url.pathname)) {
              check(result.headers['cache-control'] === 'private, no-store', 'Private response cannot be cached');
              check(result.headers['referrer-policy'] === 'no-referrer', 'Private URLs cannot become referrers');
            }
            resolve(result);
          } catch (error) { reject(error); }
        });
      });
      req.end(body);
    });
  };
  const post = (target, { body = {}, json: asJson = true, origin: from = BASE, referer, headers = {}, ...options } = {}) => request(target, {
    ...options, method: 'POST', headers: { 'content-type': asJson ? 'application/json' : 'application/x-www-form-urlencoded',
      accept: asJson ? 'application/json' : 'text/html', ...(from === null ? {} : { origin: from }),
      ...(referer ? { referer } : {}), ...headers }, body: asJson ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  });
  const signed = (target, body, forged = false) => {
    const signature = forged ? makeSecret() : twilio.getExpectedTwilioSignature(twilioToken, BASE + target, body);
    secrets.add(signature);
    // Real helper + real middleware validation, never a stub that accepts every signature.
    check(twilio.validateRequest(twilioToken, signature, BASE + target, body) === !forged, 'Twilio fixture signature is valid only when intended');
    return post(target, { json: false, origin: null, body, headers: { 'x-twilio-signature': signature } });
  };
  const login = async (shop, password = shop.password) => {
    const response = await post('/vendor/login', { json: false, body: { email: shop.email, password } });
    status(response, 303);
    check(response.headers.location === '/vendor', 'Login redirects only to the vendor workspace');
    const cookies = response.headers['set-cookie'] || [];
    check(cookies.length === 1, 'Login issues exactly one cookie');
    const line = cookies[0];
    check(/^buzzcall_vendor=[A-Za-z0-9_-]{43};/.test(line), 'Opaque vendor session cookie');
    check(/; Path=\/vendor(?:;|$)/.test(line), 'Cookie is restricted to vendor routes');
    check(/; HttpOnly(?:;|$)/i.test(line), 'Cookie is not readable by JavaScript');
    check(/; SameSite=Lax(?:;|$)/i.test(line), 'Cookie allows provider GET returns; mutations require same-origin protection');
    return line.split(';')[0];
  };
  const shops = [];
  for (const [index, name] of ['Aster fixture shop', 'Birch fixture shop'].entries()) {
    const email = `vendor-${index}@example.com`, password = makeSecret();
    const response = await post('/admin/vendors', { admin: true, json: false, invitation: true, body: { name, email } });
    const token = invitationCode(response);
    const shop = vendors.all().find(candidate => candidate.email === email);
    check(!!shop, 'Platform creation registered the vendor');
    const account = { id: shop.id, name, email, password, token, number: NUMBERS[index] };
    const activated = await post('/vendor/activate', { json: false, body: { token, password, passwordConfirm: password } });
    status(activated, 303);
    check(activated.headers.location === '/vendor/login', 'Activation requires a separate sign-in');
    check(!activated.headers['set-cookie'], 'Activation does not silently issue a session');
    account.cookie = await login(account);
    await vendors.run(account.id, async () => {
      config.apply({ BUSINESS_NAME: name, BUSINESS_TZ: 'America/New_York', BUSINESS_DAYS: '0,1,2,3,4,5,6',
        BUSINESS_HOURS: '09:00-17:00', BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1', DEPOSIT_AMOUNT: '49',
        LEAD_FEE_WAIVED: '1', OWNER_PHONE: `+1470555019${index + 1}`, FORWARD_TO_PHONE: '' });
      billing.summary(); await vendors.persist(context.current().store);
    });
    children.set(account.id, await vendors.scopedStore(shop));
    shops.push(account);
  }
  const [a, b] = shops;
  const snapshot = () => fingerprint(JSON.stringify({ root: store.root.db, override: store.root.getOverride(),
    children: [...children].map(([id, child]) => ({ id, db: child.db, override: child.getOverride() })), files: filesDigest(dir) }));
  const shopSnapshot = async shop => {
    const child = await vendors.scopedStore(vendors.get(shop.id));
    return fingerprint(JSON.stringify({ db: child.db, override: child.getOverride(), files: filesDigest(child.dataDir()) }));
  };
  const unchanged = before => check(snapshot() === before, 'Rejected/read-only request changed no record or file');
  const assignNumbers = async () => {
    for (const shop of shops) status(await post(`/admin/vendors/${shop.id}/phone`, {
      admin: true, body: { phoneNumber: shop.number, confirm_phones: '1' },
    }), 200);
  };
  let sequence = 0;
  const seedBooking = (shop, extra = {}) => vendors.run(shop.id, async () => {
    const lead = store.createLead(extra.phone || CALLER);
    Object.assign(lead, { name: `${shop.name} customer`, need: `${shop.name} private repair`,
      messages: [{ dir: 'in', body: `${shop.name} conversation sentinel` }] });
    const start = Date.now() + (2 + sequence++) * 86400000;
    const bookingRecord = { id: randomBytes(12).toString('hex'), leadId: lead.id, phone: lead.phone,
      name: lead.name, need: lead.need, service: `${shop.name} private service`, slotLabel: `${shop.name} reserved appointment`,
      slotStart: new Date(start).toISOString(), slotEnd: new Date(start + 3600000).toISOString(),
      createdAt: new Date().toISOString(), holdExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      status: 'held', paid: false, amount: 49, ...extra };
    store.db.bookings.push(bookingRecord);
    await booking.depositLink(bookingRecord, BASE);
    await vendors.persist(context.current().store);
    return bookingRecord;
  });
  const barrier = count => {
    check(!gate, 'Only one provider concurrency barrier at a time');
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    gate = { remaining: count, promise, release };
  };
  return { a, b, shops, request, post, signed, login, snapshot, shopSnapshot, unchanged, assignNumbers,
    seedBooking, barrier, messages, makeSecret, store, vendors, config, connect, billing, booking, context };
}

// Sequential subtests: each has a fresh environment, module graph, registry, stores and HTTP listener.
test('vendor isolation and verified provider routing over local HTTP', { timeout: 120000 }, async t => {
  await t.test('vendor sessions are scoped cookies, not platform credentials', async t => {
    const f = await fixture(t), { a, b } = f;
    for (const target of ['/vendor', '/vendor/settings', '/vendor/billing/status', '/vendor/connect/status',
      '/vendor/billing/mock/portal', '/vendor/connect/mock']) {
      status(await f.request(target, { headers: { accept: 'application/json' } }), 401);
      status(await f.request(target, { admin: true, headers: { accept: 'application/json' } }), 401);
    }
    const denied = await f.request('/vendor');
    status(denied, 303); check(denied.headers.location === '/vendor/login', 'HTML denial offers vendor sign-in');
    for (const shop of [a, b]) {
      const body = html(await f.request('/vendor', { cookie: shop.cookie }));
      const other = shop === a ? b : a;
      check(body.includes(shop.name) && body.includes(shop.email), 'Authenticated owner sees their identity');
      check(!body.includes(other.name) && !body.includes(other.email), 'Other owner identity is absent');
      for (const target of ['/admin', '/admin/legacy', `/admin/vendors/${other.id}`]) {
        status(await f.request(target, { cookie: shop.cookie }), 401);
      }
    }
    const unauthenticated = f.snapshot();
    for (const target of ['/vendor/settings', '/vendor/billing/checkout', '/vendor/billing/preview', '/vendor/billing/cancel',
      '/vendor/billing/resume', '/vendor/billing/change-plan', '/vendor/billing/mock/update-card',
      '/vendor/billing/mock/checkout/unknown-fixture/complete', '/vendor/connect/onboard', '/vendor/connect/sync', '/vendor/connect/mock/complete']) {
      for (const admin of [false, true]) status(await f.post(target, { admin, body: { plan: 'monthly' } }), 401);
      f.unchanged(unauthenticated);
    }
    status(await f.post('/admin/vendors', { cookie: a.cookie, body: { name: 'Unauthorized', email: 'no@example.com' } }), 401);
    status(await f.post('/vendor/login', { body: { email: a.email, password: b.password } }), 401);
    status(await f.request('/vendor', { cookie: `${a.cookie}; ${b.cookie}`, headers: { accept: 'application/json' } }), 401);
    // No ambient cookie jar: a prior successful request cannot authenticate this one.
    status(await f.request('/vendor/billing/status'), 303);
    status(await f.post('/api/checkout', { body: { plan: 'monthly' } }), 401);
    status(await f.post('/api/checkout', { admin: true, cookie: a.cookie, body: { plan: 'annual' } }), 401);
    const before = f.snapshot();
    status(await f.request('/vendor/login'), 200);
    status(await f.request('/vendor/activate'), 200);
    f.unchanged(before);
    status(await f.post('/vendor/logout', { cookie: a.cookie }), 200);
    status(await f.request('/vendor', { cookie: a.cookie, headers: { accept: 'application/json' } }), 401);
    status(await f.request('/vendor', { cookie: b.cookie }), 200);
  });

  await t.test('one-use and expired invitations, suspension and reinvitation revoke old sessions immediately', async t => {
    const f = await fixture(t), { a, b } = f;
    let before = f.snapshot();
    status(await f.post('/vendor/activate', { body: { token: a.token, password: a.password, passwordConfirm: a.password } }), 400);
    f.unchanged(before);
    const newToken = invitationCode(await f.post(`/admin/vendors/${a.id}/invite`, { admin: true, json: false, invitation: true }));
    status(await f.request('/vendor', { cookie: a.cookie, headers: { accept: 'application/json' } }), 401);
    status(await f.post('/vendor/login', { body: { email: a.email, password: a.password } }), 401);
    status(await f.request('/vendor', { cookie: b.cookie }), 200);
    before = f.snapshot();
    const nextPassword = f.makeSecret();
    status(await f.post('/vendor/activate', { body: { token: newToken, password: nextPassword, passwordConfirm: a.password } }), 400);
    f.unchanged(before);
    status(await f.post('/vendor/activate', { body: { token: newToken, password: nextPassword, passwordConfirm: nextPassword } }), 200);
    const freshCookie = await f.login(a, nextPassword);
    status(await f.request('/vendor', { cookie: freshCookie }), 200);
    status(await f.request('/vendor', { cookie: a.cookie, headers: { accept: 'application/json' } }), 401);
    const expired = invitationCode(await f.post(`/admin/vendors/${a.id}/invite`, { admin: true, json: false, invitation: true }));
    // Trusted fixture clock boundary, not a production backdoor or a forged HTTP setting.
    f.vendors.get(a.id).account.invite.expiresAt = Date.now() - 1;
    await f.vendors.persist();
    before = f.snapshot();
    status(await f.post('/vendor/activate', { body: { token: expired, password: nextPassword, passwordConfirm: nextPassword } }), 400);
    f.unchanged(before);
    status(await f.request('/vendor', { cookie: freshCookie, headers: { accept: 'application/json' } }), 401);
    status(await f.post(`/admin/vendors/${b.id}/status`, { admin: true, body: { status: 'suspended' } }), 200);
    status(await f.request('/vendor', { cookie: b.cookie, headers: { accept: 'application/json' } }), 401);
    status(await f.post('/vendor/login', { body: { email: b.email, password: b.password } }), 401);
    status(await f.post(`/admin/vendors/${b.id}/status`, { admin: true, body: { status: 'active' } }), 200);
    status(await f.request('/vendor', { cookie: b.cookie, headers: { accept: 'application/json' } }), 401);
    status(await f.request('/vendor', { cookie: await f.login(b) }), 200);
  });

  await t.test('vendor mutations reject missing, cross-site and wrong-protocol origins without writes', async t => {
    const f = await fixture(t);
    const routes = ['/vendor/settings', '/vendor/billing/checkout', '/vendor/billing/preview', '/vendor/billing/cancel',
      '/vendor/connect/onboard', '/vendor/connect/mock/complete', '/vendor/logout', '/vendor/login', '/vendor/activate'];
    const before = f.snapshot();
    for (const target of routes) {
      for (const origin of [null, 'null', 'https://evil.example', 'https://shop.example']) {
        status(await f.post(target, { cookie: f.a.cookie, origin, body: { plan: 'monthly', BUSINESS_NAME: 'Must not save' } }), 403);
        f.unchanged(before);
      }
    }
    for (const origin of [null, 'https://evil.example']) {
      status(await f.post('/admin/vendors', { admin: true, origin, body: { name: 'Must not create', email: 'no@example.com' } }), 403);
      f.unchanged(before);
    }
    status(await f.post('/vendor/settings', { cookie: f.a.cookie, origin: null, referer: `${BASE}/vendor/settings`,
      body: { BUSINESS_CITY: 'Atlanta, GA' } }), 200);
    check(await f.vendors.run(f.a.id, () => f.config.env.BUSINESS_CITY === 'Atlanta, GA'), 'Same-origin Referer fallback works');
  });

  await t.test('settings reject platform identifiers atomically and safe time-zone changes affect only their owner', async t => {
    const f = await fixture(t), { a, b } = f;
    const before = f.snapshot();
    for (const [key, value] of Object.entries({ OWNER_PHONE: '+14705550188', FORWARD_TO_PHONE: '+14705550188',
      STRIPE_CONNECT_ACCOUNT_ID: 'acct_forbidden', STRIPE_PRICE_ID_BASE_MONTHLY: 'price_forbidden',
      STRIPE_PRICE_ID_BASE_ANNUAL: 'price_forbidden', STRIPE_PRICE_ID_SETUP: 'price_forbidden',
      shopId: b.id, stripeConnect: { accountId: 'acct_forbidden' } })) {
      status(await f.post('/vendor/settings', { cookie: a.cookie, body: { BUSINESS_NAME: 'Must not partially save', [key]: value } }), 400);
      f.unchanged(before);
    }
    status(await f.post('/vendor/settings', { cookie: a.cookie, body: { BUSINESS_TZ: 'Not/A_Zone' } }), 400);
    f.unchanged(before);
    const bBefore = await f.shopSnapshot(b);
    status(await f.post('/vendor/settings', { cookie: a.cookie, body: { BUSINESS_NAME: 'Aster updated', BUSINESS_CITY: 'Los Angeles, CA',
      BUSINESS_TZ: 'America/Los_Angeles', BUSINESS_DAYS: '0,1,2,3,4,5,6', BUSINESS_HOURS: '09:00-17:00',
      SERVICES: 'Fixture consultation:60', SLOT_MINUTES: '60', HOLD_MINUTES: '45', BOOKING_LEAD_MINUTES: '30',
      BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1', DEPOSIT_AMOUNT: '65', BOOKING_LINK: 'https://booking.example/aster' } }), 200);
    check(await f.shopSnapshot(b) === bBefore, 'Safe settings did not change another shop');
    check(f.vendors.get(a.id).name === 'Aster updated' && f.vendors.get(b.id).name === b.name, 'Only own roster name changed');
    check(process.env.TZ === 'UTC', 'Vendor time zones never change process-wide TZ');
    for (const [shop, zone, amount] of [[a, 'America/Los_Angeles', 65], [b, 'America/New_York', 49]]) {
      await f.vendors.run(shop.id, async () => {
        await new Promise(resolve => setImmediate(resolve));
        check(f.config.env.BUSINESS_TZ === zone && f.booking.cfg().amount === amount, 'Effective settings remain shop-local');
        const slots = f.booking.nextSlots(1);
        check(slots.length === 1, 'Own settings produce an appointment slot');
        const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(slots[0].start)));
        check(hour >= 9 && hour < 17, 'Slot uses the owning shop local business hours');
      });
    }
    const page = html(await f.request('/vendor/settings', { cookie: a.cookie }));
    check(page.includes('America/Los_Angeles') && !page.includes(b.email), 'Settings render only the current identity');
  });

  await t.test('workspace renders own leads and bookings while platform roster omits customer conversations', async t => {
    const f = await fixture(t), { a, b } = f;
    const ownA = await f.seedBooking(a), ownB = await f.seedBooking(b);
    const rootLead = f.store.createLead('+14705550124');
    Object.assign(rootLead, { name: 'Root customer sentinel', need: 'Root repair sentinel',
      messages: [{ dir: 'in', body: 'Root private conversation sentinel' }] });
    f.store.save();
    const before = f.snapshot();
    for (const [shop, own, other] of [[a, ownA, ownB], [b, ownB, ownA]]) {
      // A request-supplied shop ID must not select a tenant, even on GET.
      const body = html(await f.request(`/vendor?shopId=${shop === a ? b.id : a.id}`, { cookie: shop.cookie }));
      check(body.includes(own.name) && body.includes(own.need) && body.includes(own.service), 'Own lead and booking are visible');
      for (const value of [other.name, other.need, other.service, 'Root customer sentinel', 'Root private conversation sentinel',
        'Storage diagnostic', 'Storage &amp; reliability', 'Platform service health', 'Fail-closed policy', 'data-page="operations"']) {
        check(!body.includes(value), 'Other customer data and platform diagnostics are absent');
      }
      check(!body.includes(process.env.DATA_DIR), 'Storage paths are not published to vendors');
    }
    const roster = html(await f.request('/admin', { admin: true }));
    check(roster.includes(a.name) && roster.includes(b.name), 'Platform roster lists both vendors');
    for (const value of [ownA.name, ownB.name, ownA.need, ownB.need, ownA.service, ownB.service,
      `${a.name} conversation sentinel`, `${b.name} conversation sentinel`, 'Root customer sentinel', 'Root private conversation sentinel']) {
      check(!roster.includes(value), 'Platform roster does not expose customer conversations');
    }
    status(await f.request('/admin/legacy'), 401);
    status(await f.request('/admin/legacy', { cookie: a.cookie }), 401);
    const legacy = html(await f.request('/admin/legacy', { admin: true }));
    check(legacy.includes('Root customer sentinel') && !legacy.includes(ownA.name) && !legacy.includes(ownB.name), 'Legacy records remain separate');
    f.unchanged(before);
  });

  await t.test('foreign subscription IDs and mock checkout capabilities cannot select another vendor', async t => {
    const f = await fixture(t), { a, b } = f;
    const sessions = [];
    for (const shop of [a, b]) {
      const checkout = json(await f.post('/vendor/billing/checkout', { cookie: shop.cookie, body: { plan: 'monthly' } }));
      check(checkout.mock === true && /^cs_mock_/.test(checkout.id), 'Checkout uses the local simulation');
      const target = new URL(checkout.url).pathname;
      check(target.startsWith('/vendor/billing/mock/checkout/'), 'Checkout is vendor-scoped');
      const before = f.snapshot();
      html(await f.request(target, { cookie: shop.cookie })); f.unchanged(before);
      const completed = json(await f.post(`${target}/complete`, { cookie: shop.cookie }));
      check(completed.ok === true && !!completed.subscription?.id, 'Own checkout creates a subscription');
      sessions.push({ target, id: checkout.id, sub: completed.subscription.id });
    }
    const before = f.snapshot();
    for (const [shop, foreign] of [[a, sessions[1]], [b, sessions[0]]]) {
      for (const target of ['/vendor/billing/preview', '/vendor/billing/cancel', '/vendor/billing/resume',
        '/vendor/billing/change-plan', '/vendor/billing/mock/update-card']) {
        status(await f.post(target, { cookie: shop.cookie, body: { sub: foreign.sub, plan: 'annual' } }), 404);
        f.unchanged(before);
      }
      status(await f.request(foreign.target, { cookie: shop.cookie }), 404);
      status(await f.post(`${foreign.target}/complete`, { cookie: shop.cookie }), 404);
      status(await f.request(`/billing/mock/checkout/${foreign.id}`), 404);
      f.unchanged(before);
    }
    const preview = json(await f.post('/vendor/billing/preview', { cookie: a.cookie, body: { sub: sessions[0].sub, plan: 'annual' } }));
    check(preview.to === 'annual', 'Own subscription can be previewed'); f.unchanged(before);
    const bBefore = await f.shopSnapshot(b);
    const cancelled = json(await f.post('/vendor/billing/cancel', { cookie: a.cookie, body: { sub: sessions[0].sub } }));
    check(cancelled.cancel_at_period_end === true, 'Own subscription can schedule cancellation');
    check(await f.shopSnapshot(b) === bBefore, 'Own cancellation cannot change another shop');
  });

  await t.test('only platform administrators can confirm phone assignments and owned numbers cannot be duplicated', async t => {
    const f = await fixture(t), { a, b } = f;
    let before = f.snapshot();
    const target = `/admin/vendors/${a.id}/phone`;
    status(await f.post(target, { body: { phoneNumber: a.number, confirm_phones: '1' } }), 401);
    status(await f.post(target, { cookie: a.cookie, body: { phoneNumber: a.number, confirm_phones: '1' } }), 401);
    status(await f.post(target, { admin: true, body: { phoneNumber: a.number } }), 409);
    f.unchanged(before);
    await f.assignNumbers();
    before = f.snapshot();
    for (const number of [b.number, process.env.TWILIO_PHONE_NUMBER]) {
      status(await f.post(target, { admin: true, body: { phoneNumber: number, confirm_phones: '1' } }), 409);
      f.unchanged(before);
    }
    check(f.vendors.get(a.id).phoneNumber === a.number && f.vendors.get(b.id).phoneNumber === b.number, 'Assignments remain unique');
  });

  await t.test('signed Twilio calls and callbacks isolate the same caller, STOP, and concurrent provider sends', async t => {
    const f = await fixture(t), { a, b } = f;
    await f.assignNumbers();
    for (const shop of [a, b]) await f.vendors.run(shop.id, async () => {
      f.config.apply({ ...f.store.getOverride().values, FORWARD_TO_PHONE: '+14705550199' });
      await f.vendors.persist(f.context.current().store);
    });
    const calls = [a, b].map(shop => ({ From: CALLER, To: shop.number, CallSid: `CA${randomBytes(16).toString('hex')}` }));
    const voices = await Promise.all(calls.map(body => f.signed('/twilio/voice', body)));
    for (const response of voices) { status(response, 200); check(response.body.includes('/twilio/voice/status'), 'Voice installs a signed callback destination'); }
    assert.equal(f.messages.length, 0, 'Forwarding does not text before a missed-call result');
    f.barrier(2);
    const callbacks = await Promise.all(calls.map(body => f.signed('/twilio/voice/status', { ...body, DialCallStatus: 'no-answer' })));
    for (const response of callbacks) status(response, 200);
    assert.equal(f.messages.length, 2, 'One initial caller text per shop');
    const leads = [];
    for (const shop of [a, b]) {
      const lead = await f.vendors.run(shop.id, () => f.store.findOpenLead(CALLER));
      check(!!lead && lead.phone === CALLER && lead.messages.length === 1, 'Caller has an independent lead in each store');
      leads.push(lead);
      const ownCalls = await f.vendors.run(shop.id, () => f.store.db.calls);
      check(ownCalls.length === 1 && ownCalls[0].status === 'missed' && ownCalls[0].phone === CALLER, 'Call history belongs to the assigned shop');
      const page = html(await f.request('/vendor', {cookie:shop.cookie}));
      check(page.includes('data-page="calls"') && page.includes('Call history'), 'Vendor can view their call history');
      const sent = f.messages.filter(message => message.from === shop.number && message.to === CALLER);
      check(sent.length === 1 && sent[0].body.includes(shop.name), 'Sender and text belong to the assigned business');
      check(sent[0].before === shop.id && sent[0].after === shop.id, 'Shop context survives overlapping provider awaits');
    }
    check(leads[0].id !== leads[1].id, 'Same caller does not share a lead identity');
    assert.equal(f.store.root.db.leads.length, 0, 'Verified vendor calls never fall back to root');
    const before = f.snapshot(), sentBefore = f.messages.length;
    for (const To of ['+14705550177', '+442079460123']) {
      status(await f.signed('/twilio/voice', { From: CALLER, To, CallSid: `CA${randomBytes(16).toString('hex')}` }), 200);
      status(await f.signed('/twilio/sms', { From: CALLER, To, Body: 'HELP' }), 200);
    }
    status(await f.signed('/twilio/voice/status', { ...calls[0], CallSid: `CA${randomBytes(16).toString('hex')}`, DialCallStatus: 'no-answer' }), 200);
    status(await f.signed('/twilio/voice/status', { ...calls[0], From: '+14705550124', DialCallStatus: 'no-answer' }), 200);
    for (const [target, body] of [['/twilio/voice', calls[0]], ['/twilio/sms', { From: CALLER, To: a.number, Body: 'STOP' }],
      ['/twilio/voice/status', { ...calls[0], DialCallStatus: 'no-answer' }]]) status(await f.signed(target, body, true), 403);
    f.unchanged(before);
    assert.equal(f.messages.length, sentBefore, 'Unassigned, unknown or forged callbacks cannot send messages');
    const bBefore = await f.shopSnapshot(b);
    status(await f.signed('/twilio/sms', { From: CALLER, To: a.number, Body: 'STOP' }), 200);
    check(await f.vendors.run(a.id, () => f.store.isOptedOut(CALLER)), 'STOP is durable for the receiving shop');
    check(!await f.vendors.run(b.id, () => f.store.isOptedOut(CALLER)), 'STOP does not opt out another shop');
    check(await f.shopSnapshot(b) === bBefore, 'STOP does not change other shop data or logs');
    check(!f.store.root.isOptedOut(CALLER), 'STOP does not fall back to the root opt-out list');
    const callerTexts = f.messages.filter(message => message.to === CALLER).length;
    for (const body of calls) {
      const next = {...body,CallSid:`CA${randomBytes(16).toString('hex')}`};
      status(await f.signed('/twilio/voice',next),200);
      status(await f.signed('/twilio/voice/status', { ...next, DialCallStatus: 'busy' }), 200);
    }
    const newTexts = f.messages.filter(message => message.to === CALLER).slice(callerTexts);
    check(newTexts.length === 1 && newTexts[0].from === b.number, 'Only the shop without STOP may send another text');
  });

  await t.test('Connect account and metadata must agree; overlapping matched webhooks retain shop context', async t => {
    const f = await fixture(t), { a, b } = f;
    await f.assignNumbers();
    check(!process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_CONNECT_WEBHOOK_SECRET, 'Unsigned Stripe events are confined to dev/mock mode');
    const accounts = await Promise.all([a, b].map(shop => f.vendors.run(shop.id, async () => {
      const result = await f.connect.onboard(BASE, { name: shop.name, email: shop.email });
      check(!!f.connect.mockComplete(), 'Mock Connect onboarding completes locally');
      await f.vendors.persist(f.context.current().store);
      return result.accountId;
    })));
    check(accounts[0] !== accounts[1] && accounts.every(id => /^acct_mock_/.test(id)), 'Two independent simulated Connect accounts');
    const bookingA = await f.seedBooking(a), bookingB = await f.seedBooking(b);
    const event = (account, bookingId, shopId) => ({ id: `evt_fixture_${randomBytes(8).toString('hex')}`,
      type: 'checkout.session.completed', account, livemode: false,
      data: { object: { id: `cs_fixture_${randomBytes(8).toString('hex')}`, mode: 'payment', payment_status: 'paid',
        metadata: { bookingId, ...(shopId === undefined ? {} : { shopId }) } } } });
    const before = f.snapshot();
    for (const payload of [event(accounts[0], bookingB.id), event(accounts[0], bookingA.id, b.id),
      event(accounts[1], bookingA.id, a.id), event('acct_unassigned_fixture', bookingA.id, a.id), event(undefined, bookingA.id, a.id)]) {
      const result = json(await f.post('/stripe/connect/webhook', { origin: null, body: payload }));
      check(result.received === true && typeof result.ignored === 'string', 'Conflicting or unknown event is acknowledged but ignored');
      check(!bookingA.paid && !bookingB.paid, 'Mismatched event cannot pay either booking');
      f.unchanged(before);
    }
    const bBefore = await f.shopSnapshot(b);
    const valid = event(accounts[0], bookingA.id, a.id);
    const accepted = json(await f.post('/stripe/connect/webhook', { origin: null, body: valid }));
    check(accepted.received === true && !accepted.ignored, 'Matched event is processed');
    check(bookingA.paid && bookingA.status === 'confirmed' && !bookingB.paid, 'Only matched shop A booking is paid');
    check(await f.shopSnapshot(b) === bBefore, 'Payment cannot alter another shop or its logs');
    const paid = f.snapshot(), sent = f.messages.length;
    json(await f.post('/stripe/connect/webhook', { origin: null, body: valid }));
    f.unchanged(paid); assert.equal(f.messages.length, sent, 'Duplicate event sends no duplicate notifications');
    const nextA = await f.seedBooking(a, { phone: '+14705550125' });
    const nextB = await f.seedBooking(b, { phone: '+14705550126' });
    const first = f.messages.length;
    f.barrier(2);
    const responses = await Promise.all([f.post('/stripe/connect/webhook', { origin: null, body: event(accounts[0], nextA.id, a.id) }),
      f.post('/stripe/connect/webhook', { origin: null, body: event(accounts[1], nextB.id, b.id) })]);
    for (const response of responses) check(json(response).received === true, 'Concurrent payment acknowledged');
    check(nextA.paid && nextB.paid && !bookingB.paid, 'Concurrent callbacks pay only their selected bookings');
    const sentTogether = f.messages.slice(first);
    check(sentTogether.length === 4, 'Each payment sends its caller and owner notification');
    for (const [shop, own, other] of [[a, nextA, nextB], [b, nextB, nextA]]) {
      const ownMessages = sentTogether.filter(message => message.from === shop.number);
      check(ownMessages.length === 2 && ownMessages.some(message => message.to === own.phone), 'Notifications use the owning line');
      check(ownMessages.every(message => message.before === shop.id && message.after === shop.id && !message.body.includes(other.name)),
        'Concurrent provider awaits preserve identity and message isolation');
      check(await f.vendors.run(shop.id, () => !!f.store.findBooking(own.id) && !f.store.findBooking(other.id)), 'Bookings stay in their own stores');
    }
    assert.equal(f.store.root.db.bookings.length, 0, 'Connect routing never creates root bookings');
    assert.equal(f.store.root.db.alerts.length, 0, 'Concurrent payment alerts never escape into root');
  });

  await t.test('reviewed onboarding creates a distinct vendor without assigning legacy data or automatic braider billing', async t => {
    const f=await fixture(t);
    process.env.FOUNDING_SHOPS_LIMIT='1';
    check(f.shops.every(s=>!f.vendors.get(s.id).founding),'Fixture approvals made while the founding program was off stay unchanged');
    const body={businessName:'Third studio fixture',city:'Atlanta, GA',vertical:'braiders',ownerPhone:'(404) 555-0100',forwardPhone:'(404) 555-0111',
      ringSeconds:'20',days:['2','3','4','5','6'],open:'10:00',close:'19:00',tz:'America/Chicago',
      services:[{row:0,name:'Knotless braids',hours:'6',minutes:'0'},{row:1,name:'Locs retwist',hours:'2',minutes:'30'}],
      booking:'times',leadMinutes:'120',deposit:true,depositAmount:'60',holdMinutes:'20',bookingLink:'https://booking.example/studio',
      email:'third-owner@example.com',consent:true,confirm:true};
    const pending=json(await f.post('/setup',{body}));
    const roster=html(await f.request('/admin',{admin:true}));
    check(roster.includes('Review submitted business settings') && roster.includes('name="confirm_setup"'),'Admin reviews the submitted settings before approving');
    const before=f.snapshot();
    status(await f.post('/admin/vendors/approve',{admin:true,body:{setupId:pending.id}}),409);f.unchanged(before);
    const token=invitationCode(await f.post('/admin/vendors/approve',{admin:true,json:false,invitation:true,body:{setupId:pending.id,confirm_setup:'1'}}));
    const shop=f.vendors.all().find(s=>s.email===body.email);
    check(!!shop && shop.setupId===pending.id && !shop.phoneNumber && shop.founding,'The next eligible approval reserves the global founding allocation without a legacy line');
    const fourth=await f.vendors.create({name:'Fourth fixture',email:'fourth-owner@example.com'});
    check(!fourth.shop.founding,'The next store cannot reset the platform founding counter');
    check(f.store.root.findSetup(pending.id).status==='approved','Approval is recorded');
    const password=f.makeSecret();
    status(await f.post('/vendor/activate',{body:{token,password,passwordConfirm:password}}),200);
    const cookie=await f.login({...shop,password});
    check(await f.vendors.run(shop.id,()=>f.config.env.OWNER_PHONE==='+14045550100' && f.config.env.BUSINESS_TYPE==='braiders'),'Validated configuration belongs to the new studio');
    status(await f.post('/vendor/billing/checkout',{cookie,body:{plan:'monthly'}}),409);
    check(html(await f.request('/vendor',{cookie})).includes('Confirm your pilot terms'),'Braider inquiry-only terms remain explicit');
  });

  await t.test('hashed identities, sessions and business stores survive a cold reload', async t => {
    const f=await fixture(t),{a,b}=f;
    const own=await f.seedBooking(a),other=await f.seedBooking(b);
    const saved=f.store.root.createStore({dir:f.store.root.dataDir()});
    const serialized=JSON.stringify(saved.db);
    for(const shop of [a,b]) {
      check(!serialized.includes(shop.password),'Plaintext passwords are never persisted');
      check(!serialized.includes(shop.cookie.split('=')[1]),'Raw session tokens are never persisted');
      check(!serialized.includes(shop.token),'Raw activation tokens are never persisted');
    }
    await f.vendors.close();
    for(const key of Object.keys(f.store.root.db)) delete f.store.root.db[key];
    Object.assign(f.store.root.db,saved.db);
    const page=html(await f.request('/vendor',{cookie:a.cookie}));
    check(page.includes(own.name) && !page.includes(other.name),'Reloaded session opens only its persisted namespace');
    status(await f.request('/vendor',{cookie:b.cookie}),200);
    await saved.close();
  });

  await t.test('initial invoices retry until ownership is known; verified subscription metadata routes safely', async t => {
    const f=await fixture(t),{a,b}=f;
    const dashboard=html(await f.request('/vendor',{cookie:a.cookie}));
    check(dashboard.includes('action="/vendor/billing/checkout"'),'Vendor has a working checkout entry');
    json(await f.post('/vendor/billing/checkout',{cookie:a.cookie,body:{plan:'monthly'}}));
    status(await f.post('/vendor/billing/checkout',{cookie:a.cookie,body:{plan:'annual'}}),409);
    const id=`in_${randomBytes(10).toString('hex')}`, sub=`sub_${randomBytes(10).toString('hex')}`;
    const event={id:`evt_${randomBytes(10).toString('hex')}`,type:'invoice.paid',data:{object:{id,customer:'cus_unbound_fixture',subscription:sub,
      amount_due:4900,amount_paid:4900,lines:{data:[]}}}};
    const before=f.snapshot();
    status(await f.post('/stripe/webhook',{origin:null,body:event}),503);f.unchanged(before);
    event.data.object.subscription_details={metadata:{shopId:a.id}};
    const bBefore=await f.shopSnapshot(b);
    json(await f.post('/stripe/webhook',{origin:null,body:event}));
    check(await f.vendors.run(a.id,()=>f.store.db.billing.invoices.some(i=>i.id===id)),'Invoice belongs only to metadata owner');
    check(await f.shopSnapshot(b)===bBefore,'Other invoice ledger stays unchanged');
    const confirmed=f.snapshot();
    event.data.object.metadata={shopId:b.id};
    const conflict=json(await f.post('/stripe/webhook',{origin:null,body:event}));
    check(!!conflict.ignored,'Conflicting signed ownership is ignored');f.unchanged(confirmed);
    status(await f.request('/vendor/billing/return?status=success'),200);
  });

  await t.test('legacy platform deposit sessions still reconcile after vendor enrollment', async t => {
    const f=await fixture(t);
    const booking={id:randomBytes(12).toString('hex'),stripeSessionId:`cs_${randomBytes(12).toString('hex')}`,
      status:'held',paid:false,amount:49,phone:CALLER,name:'Legacy customer',need:'Legacy visit',
      slotStart:new Date(Date.now()+86400000).toISOString(),slotEnd:new Date(Date.now()+90000000).toISOString(),
      slotLabel:'Legacy appointment',holdExpiresAt:new Date(Date.now()+3600000).toISOString()};
    f.store.root.db.bookings.push(booking);await f.vendors.persist();
    const event={id:'evt_legacy_fixture',type:'checkout.session.completed',data:{object:{id:booking.stripeSessionId,
      mode:'payment',payment_status:'paid',metadata:{bookingId:booking.id},client_reference_id:booking.id}}};
    const wrong=structuredClone(event);wrong.data.object.id='cs_unrecognized';
    const before=f.snapshot();check(!!json(await f.post('/stripe/webhook',{origin:null,body:wrong})).ignored,'Stored session must match');f.unchanged(before);
    json(await f.post('/stripe/webhook',{origin:null,body:event}));
    check(booking.paid,'Only a matched legacy payment marks the root booking paid');
    for(const shop of f.shops) check(await f.vendors.run(shop.id,()=>f.store.db.bookings.length===0),'No vendor booking is created');
  });

  await t.test('opening customer payment capabilities is public but read-only, including HEAD and paid query parameters', async t => {
    const f = await fixture(t), { a, b } = f;
    const own = await f.seedBooking(a), other = await f.seedBooking(b);
    const before = f.snapshot(), sent = f.messages.length;
    for (const cookie of [undefined, b.cookie]) for (const method of ['GET', 'HEAD']) {
      const response = await f.request(`/pay/mock/${own.id}?paid=true&status=success&shopId=${b.id}`, { method, cookie });
      status(response, 200);
      if (method === 'GET') {
        const body = html(response);
        check(body.includes(a.name) && body.includes(own.service), 'Capability selects the booking owner, not the supplied cookie or shop ID');
        check(!body.includes(b.name) && !body.includes(other.service), 'Other shop data is not rendered');
        check(!body.includes('Demo booking confirmed'), 'Opening a link is not payment confirmation');
      }
      f.unchanged(before);
    }
    status(await f.request('/pay/mock/unknown-fixture-booking'), 404);
    f.unchanged(before);
    check(!own.paid && !other.paid, 'GET and HEAD cannot mark either booking paid');
    assert.equal(f.messages.length, sent, 'Opening payment capabilities sends no notifications');
  });
});
