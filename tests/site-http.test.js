'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, readdir, rm, stat } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '../src/server.js');
const LEGAL = {
  privacy: 'Privacy Policy',
  terms: 'Terms of Service',
  refunds: 'Customer Deposit Refund Policy',
  'sms-consent': 'How text consent works',
};
const PAGES = ['/', '/index.html', ...Object.keys(LEGAL).flatMap((name) => [`/${name}.html`, `/${name}`]), '/setup.html', '/setup'];
const PUBLIC_PATHS = new Set([...PAGES, '/home.css', '/site.js', '/styles.css', '/setup.css', '/setup.js', '/setup-rules.js', '/trades.js']);
const REQUEST_MS = 3000;

// Reserve an OS-selected port, then release it immediately before spawning. A
// competing binder is handled by bounded EADDRINUSE retries, not a fixed port.
function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Timed out reserving a local port'));
    }, 2000);
    probe.once('error', (error) => { clearTimeout(timer); reject(error); });
    probe.listen({ port: 0, signal: controller.signal }, () => {
      const { port } = probe.address();
      probe.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function launchServer(port, cwd, adminPassword) {
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    // Deliberate allowlist: no process.env spread, PATH/HOME, NODE_OPTIONS,
    // dotenv overrides, proxy configuration, or credentials from the caller.
    env: {
      NODE_ENV: 'test',
      TZ: 'UTC',
      BUSINESS_TZ: 'UTC',
      PORT: String(port),
      PUBLIC_BASE_URL: origin,
      DATA_DIR: cwd,
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      STRIPE_CONNECT_ACCOUNT_ID: '',
      STRIPE_PRICE_ID_BASE_MONTHLY: '',
      STRIPE_PRICE_ID_BASE_ANNUAL: '',
      STRIPE_PRICE_ID_SETUP: '',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
      TWILIO_PHONE_NUMBER: '',
      OPENAI_API_KEY: '',
      ADMIN_PASSWORD: adminPassword,
      OWNER_PHONE: '',
      FORWARD_TO_PHONE: '',
      BOOKING_LINK: '',
      BILLING_PORTAL_RETURN_URL: '',
      SETUP_WAIVER_CODE: '',
      BOOKING_ENABLED: '0',
      DEPOSIT_ENABLED: '0',
      TRIAL_DAYS: '14',
      WAITLIST_RATE_MAX: '1000', // this suite posts many waitlist entries from one IP; the limiter has its own test
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, origin, closed: false, output: '' };
  state.closedPromise = new Promise((resolve) => {
    child.once('close', () => { state.closed = true; resolve(); });
  });
  state.ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Server startup timed out\n${state.output}`)), 3000);
    const capture = (chunk) => {
      state.output = (state.output + chunk.toString()).slice(-16384);
      // Do not probe /health until THIS child confirms it owns the port. A
      // different process could occupy the port between reservation and spawn.
      if (state.output.includes(`missedcall-buzz on :${port} (`)) finish();
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', finish);
    child.once('close', (code, signal) => {
      const error = new Error(`Server exited before readiness (${code ?? signal})\n${state.output}`);
      if (state.output.includes('EADDRINUSE')) error.code = 'EADDRINUSE';
      finish(error);
    });
  });
  return state;
}

async function closedWithin(state, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      state.closedPromise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopServer(state) {
  if (state.closed) return;
  // Signal only the ChildProcess we created, never a process group or a port's
  // current occupant. Do not remove its data directory until it has stopped.
  state.child.kill('SIGTERM');
  if (await closedWithin(state, 1000)) return;
  state.child.kill('SIGKILL');
  assert.ok(await closedWithin(state, 2000), 'Child did not stop; preserving its temporary directory');
}

function assertResponse(response, status, contentType, label) {
  assert.equal(response.status, status, `${label}: HTTP status`);
  const type = String(response.headers['content-type'] || '').split(';')[0].trim();
  assert.match(type, contentType, `${label}: Content-Type`);
  assert.ok(response.body.length > 0, `${label}: nonempty response`);
}

async function startSite(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'buzzcall-site-http-'));
  const adminPassword = randomBytes(24).toString('hex');
  const storeFile = path.join(cwd, 'db.json');
  let state;
  t.after(async () => {
    if (state) await stopServer(state);
    // cwd is exactly the fresh mkdtemp result, never the repository or a glob.
    await rm(cwd, { recursive: true, force: true });
  });
  assert.deepEqual(await readdir(cwd), [], 'Child cwd/DATA_DIR starts empty, with no .env');
  for (let attempt = 0; attempt < 5; attempt++) {
    t.signal.throwIfAborted();
    state = launchServer(await availablePort(), cwd, adminPassword);
    try {
      await state.ready;
      break;
    } catch (error) {
      await stopServer(state);
      if (error.code !== 'EADDRINUSE' || attempt === 4) throw error;
    }
  }

  const checkoutPaths = new Set();
  function request(target, body) {
    const url = new URL(target, state.origin);
    assert.equal(url.origin, state.origin, 'HTTP requests must stay on this local server');
    assert.equal(url.username + url.password, '', 'No URL credentials');
    const method = body === undefined ? 'GET' : 'POST';
    if (method === 'GET') {
      assert.ok(PUBLIC_PATHS.has(url.pathname) || ['/health', '/admin'].includes(url.pathname) || checkoutPaths.has(url.pathname),
        `Refusing unexpected GET ${url.pathname} (especially deposit/payment actions)`);
    } else {
      assert.ok(['/api/waitlist', '/api/checkout'].includes(url.pathname), 'Never complete a checkout or charge');
    }
    assert.equal(state.child.exitCode, null, 'Server must still be running');
    assert.equal(state.child.signalCode, null, 'Server must not have been signaled');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      // node:http never follows redirects, and requests use no pooled sockets.
      const req = http.request(url, {
        method,
        agent: false,
        signal: t.signal,
        headers: {
          ...(payload === undefined ? {} : {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
          ...(url.pathname === '/admin' ? {
            Authorization: `Basic ${Buffer.from(`test:${adminPassword}`).toString('base64')}`,
          } : {}),
        },
      });
      const timer = setTimeout(() => req.destroy(new Error(`${method} ${url.pathname} timed out`)), REQUEST_MS);
      const fail = (error) => { clearTimeout(timer); reject(error); };
      req.on('error', fail);
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', fail);
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.end(payload);
    });
  }
  const response = await request('/health');
  assertResponse(response, 200, /^application\/json$/i, '/health');
  const health = JSON.parse(response.body);
  assert.equal(health.ok, true);
  assert.equal(health.billing, 'mock');
  for (const key of ['twilio', 'stripe', 'connect', 'booking', 'deposit']) {
    assert.equal(health[key], false, `${key} must be disabled`);
  }
  for (const key of ['openai', 'leadFee', 'leadFeeWaived']) assert.equal(key in health, false, `public /health must not expose ${key}`);
  assert.equal('storage' in health, false, 'public /health must not expose the storage backend (T3: admin-only)');
  assert.ok(['ok', 'degraded'].includes(health.storageState));

  const cache = new Map();
  function publicResource(target) {
    const url = new URL(target, state.origin);
    assert.ok(PUBLIC_PATHS.has(url.pathname), `Unexpected public resource ${url.pathname}`);
    url.hash = ''; // Fragments are checked against the returned markup below.
    if (!cache.has(url.href)) cache.set(url.href, request(url.href).then((result) => {
      const type = url.pathname.endsWith('.css') ? /^text\/css$/i
        : url.pathname.endsWith('.js') ? /^(application|text)\/javascript$/i : /^text\/html$/i;
      assertResponse(result, 200, type, url.pathname);
      return result.body;
    }));
    return cache.get(url.href);
  }
  return {
    origin: state.origin, request, publicResource, checkoutPaths,
    readStore: async () => JSON.parse(await readFile(storeFile, 'utf8')),
    readStoreSnapshot: async () => {
      const [contents, metadata] = await Promise.all([readFile(storeFile, 'utf8'), stat(storeFile)]);
      return { contents, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs };
    },
  };
}

// A small attribute scanner for these static pages, not a DOM implementation.
// Restrict matches to actual opening tags; accept quoted or unquoted values.
function attributes(html, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\x60]+))`, 'gi');
  const tags = html.replace(/<!--[\s\S]*?-->/g, '').match(/<[a-z][^>]*>/gi) || [];
  return tags.flatMap((tag) => [...tag.matchAll(pattern)].map((match) =>
    (match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, '&')));
}

function localReferences(html, page, origin) {
  return [...attributes(html, 'href'), ...attributes(html, 'src')]
    .map((value) => new URL(value, new URL(page, origin)))
    .filter((url) => url.origin === origin);
}

function assertUncompleted(db) {
  const billing = db.billing;
  assert.equal(billing.subscription, undefined, 'No subscription was started');
  for (const key of ['invoices', 'events', 'shops']) assert.deepEqual(billing[key], [], `No billing ${key}`);
  assert.deepEqual(billing.subs, {});
  assert.deepEqual(billing.mock.subs, {});
  for (const session of Object.values(billing.mock.sessions)) {
    assert.notEqual(session.completed, true, 'Checkout must remain uncompleted');
    assert.equal(session.subscription, undefined);
  }
  for (const key of ['leads', 'alerts', 'bookings']) assert.deepEqual(db[key], [], `No ${key} created`);
}

test('public site over real local HTTP', { timeout: 60000 }, async (t) => {
  const site = await startSite(t);

  await t.test('landing homepage and local CSS/JavaScript are public with correct content types', async () => {
    const [home, index] = await Promise.all(['/', '/index.html'].map(site.publicResource));
    assert.equal(home, index);
    assert.match(home, /<title>BuzzCall\b/i);
    assert.match(home, /<h1\b[^>]*>Missed call\./i);
    assert.match(home, /Next customer\./i);
    await Promise.all(['/home.css', '/site.js', '/styles.css'].map(site.publicResource));
  });

  await t.test('all legal pages resolve as both .html and clean URLs', async () => {
    for (const [name, heading] of Object.entries(LEGAL)) {
      const [html, clean] = await Promise.all([`/${name}.html`, `/${name}`].map(site.publicResource));
      assert.equal(clean, html, `${name}: same document at both URLs`);
      assert.ok(html.includes(`<h1>${heading}</h1>`), `${name}: expected legal document`);
    }
  });

  await t.test('refund policy is trade-agnostic: job trades and appointment trades, no plumbing/HVAC/braider-only wording', async () => {
    const html = await site.publicResource('/refunds');
    const intro = html.slice(html.indexOf('<p>This policy covers'));
    assert.match(intro, /appointment or a job/i);
    assert.match(html, /<b>Job trades<\/b>/);
    assert.match(html, /<b>Appointment trades<\/b>/);
    assert.ok(html.includes('id="appointment-trades"'), 'appointment trades section anchor');
    assert.ok(html.includes('href="#appointment-trades"'), 'intro links to appointment trades section');
    assert.ok(!/a participating plumbing or HVAC business/i.test(html), 'scope must not be plumbing/HVAC-only');
    assert.ok(!/\bstylist\b[^.]*\("the stylist"\)/i.test(html), 'defined term must not be "the stylist"');
    // existing rules are unchanged
    for (const rule of [/100% of your deposit back/, /cancel at least 24 hours before/, /within 30 days/, /within 15 minutes/, /original card/, /5\u201310 business days/]) assert.match(html, rule);
    assert.match(html, /no partial refunds/);
    assert.match(html, /hello@trybuzzcall\.com/);
    assert.match(html, /\(470\) 482-8377/);
    const home = await site.publicResource('/');
    assert.match(home, /job trades like Home Services/);
    assert.match(home, /appointment trades like braiding/);
  });

  await t.test('expected local page links and assets resolve, including cross-page and SVG fragments', async () => {
    const home = await site.publicResource('/');
    const homeLinks = new Set(localReferences(home, '/', site.origin).map((url) => url.pathname + url.hash));
    for (const expected of ['/', '/#main', '/#home-services', '/#braiders', '/#how-it-works', '/#pricing', '/#faq', '/#waitlist',
      '/home.css', '/site.js', '/privacy.html', '/terms.html', '/refunds.html', '/terms.html#sms', '/sms-consent.html', '/setup.html']) {
      assert.ok(homeLinks.has(expected), `Homepage must link to ${expected}`);
    }
    for (const page of PAGES) {
      const html = await site.publicResource(page);
      const links = localReferences(html, page, site.origin);
      assert.ok(links.length > 0, `${page}: local references found`);
      for (const url of links) {
        const target = await site.publicResource(url.href);
        if (url.hash) {
          const fragment = decodeURIComponent(url.hash.slice(1));
          const ids = new Set([...attributes(target, 'id'), ...attributes(target, 'name')]);
          assert.ok(ids.has(fragment), `${page}: ${url.pathname}${url.hash} must identify an element`);
        }
      }
    }
  });

  await t.test('waitlist persists trimmed, lowercased emails without duplicates', async () => {
    let firstEntry;
    for (const email of [' \tShop.Owner+Pilot@Example.COM\n', 'shop.owner+pilot@example.com', 'SHOP.OWNER+PILOT@EXAMPLE.COM']) {
      const response = await site.request('/api/waitlist', { email });
      assertResponse(response, 200, /^application\/json$/i, 'waitlist signup');
      assert.deepEqual(JSON.parse(response.body), { ok: true });
      const { waitlist } = await site.readStore();
      assert.equal(waitlist.length, 1);
      assert.equal(waitlist[0].email, 'shop.owner+pilot@example.com');
      assert.equal(Object.hasOwn(waitlist[0], 'businessType'), false, 'Legacy signup has no segment');
      assert.ok(Number.isFinite(Date.parse(waitlist[0].at)), 'Persisted signup timestamp');
      if (firstEntry) assert.deepEqual(waitlist[0], firstEntry, 'Duplicate preserves the original entry');
      firstEntry = waitlist[0];
    }
    const response = await site.request('/api/waitlist', { email: ' Other.Shop@Example.COM ', businessType: '' });
    assertResponse(response, 200, /^application\/json$/i, 'second unique signup');
    assert.deepEqual(JSON.parse(response.body), { ok: true });
    const { waitlist } = await site.readStore();
    assert.deepEqual(waitlist.map((entry) => entry.email),
      ['shop.owner+pilot@example.com', 'other.shop@example.com']);
    assert.equal(Object.hasOwn(waitlist[1], 'businessType'), false, 'Empty segment remains legacy');
  });

  await t.test('all business types persist and duplicates preserve the segment and timestamp', async () => {
    for (const businessType of ['home_services', 'braiders', 'other']) {
      const email = `${businessType}@example.com`;
      const response = await site.request('/api/waitlist', { email: ` ${email.toUpperCase()} `, businessType });
      assertResponse(response, 200, /^application\/json$/i, 'segmented signup');
      assert.deepEqual(JSON.parse(response.body), { ok: true });
      const before = await site.readStore();
      const entries = before.waitlist.filter((entry) => entry.email === email);
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0], { email, at: entries[0].at, businessType });
      assert.ok(Number.isFinite(Date.parse(entries[0].at)), 'Persisted signup timestamp');
      for (const duplicateType of [businessType, undefined, '']) {
        const duplicate = await site.request('/api/waitlist', { email, businessType: duplicateType });
        assertResponse(duplicate, 200, /^application\/json$/i, 'duplicate segmented signup');
        assert.deepEqual(JSON.parse(duplicate.body), { ok: true });
        assert.deepEqual(await site.readStore(), before, 'Duplicate cannot erase the segment or reset the timestamp');
      }
    }
  });

  await t.test('legacy entries can be enriched and updated without duplicates or timestamp changes', async () => {
    const before = await site.readStore();
    const email = 'shop.owner+pilot@example.com';
    const original = before.waitlist.find((entry) => entry.email === email);
    assert.equal(Object.hasOwn(original, 'businessType'), false);
    let segment;
    for (const businessType of ['home_services', 'braiders', undefined, '', 'home_services']) {
      const response = await site.request('/api/waitlist', { email: ` ${email.toUpperCase()} `, businessType });
      assertResponse(response, 200, /^application\/json$/i, 'enrich/update signup');
      assert.deepEqual(JSON.parse(response.body), { ok: true });
      if (businessType) segment = businessType;
      assert.deepEqual(await site.readStore(), {
        ...before,
        waitlist: before.waitlist.map((entry) => entry.email === email ? { ...original, businessType: segment } : entry),
      });
    }
  });

  await t.test('invalid business types return 400 without writes for new or existing emails', async () => {
    const before = await site.readStoreSnapshot();
    const invalidTypes = [null, 'unknown', 'HOME_SERVICES', 'Braiders', ' home_services', 'braiders ', ' ',
      '__proto__', 0, 1, true, false, [], ['home_services'], ['braiders'], ['home_services', 'braiders'], {}, { businessType: 'braiders' }];
    for (const email of ['rejected@example.com', 'home_services@example.com']) {
      for (const businessType of invalidTypes) {
        const response = await site.request('/api/waitlist', { email, businessType });
        assertResponse(response, 400, /^application\/json$/i, 'invalid business type');
        assert.deepEqual(JSON.parse(response.body), { error: 'invalid business type' });
        assert.deepEqual(await site.readStoreSnapshot(), before, 'Rejected signup must not write data');
      }
    }
  });

  await t.test('invalid waitlist emails keep their existing response and leave persisted data unchanged', async () => {
    const before = await site.readStoreSnapshot();
    for (const email of [undefined, null, '', '   ', 'not-an-email', 'shop@example', '@example.com', 'shop@@example.com', 'shop owner@example.com']) {
      for (const businessType of [undefined, 'home_services', 'braiders', null]) {
        const response = await site.request('/api/waitlist', { email, businessType });
        assertResponse(response, 400, /^application\/json$/i, 'invalid waitlist signup');
        assert.deepEqual(JSON.parse(response.body), { error: 'invalid email' });
        assert.deepEqual(await site.readStoreSnapshot(), before, 'Rejected signup must not write data');
      }
    }
  });

  await t.test('admin waitlist labels both segments, escapes email text, and retains legacy entries', async () => {
    const email = '<owner&"tag>@example.com';
    const signup = await site.request('/api/waitlist', { email, businessType: 'braiders' });
    assertResponse(signup, 200, /^application\/json$/i, 'escaped admin signup');
    assert.deepEqual(JSON.parse(signup.body), { ok: true });
    const before = await site.readStore();
    const response = await site.request('/admin');
    assertResponse(response, 200, /^text\/html$/i, '/admin');
    assert.ok(response.body.includes('<td>home_services@example.com</td><td>Home services</td>'));
    assert.ok(response.body.includes('<td>braiders@example.com</td><td>Braiders</td>'));
    assert.ok(response.body.includes('<td>other@example.com</td><td>Other local business</td>'));
    assert.ok(response.body.includes('<td>other.shop@example.com</td><td>Not specified</td>'));
    assert.ok(response.body.includes('<td>&lt;owner&amp;&quot;tag&gt;@example.com</td><td>Braiders</td>'));
    assert.ok(!response.body.includes(email), 'Raw HTML must not appear in the admin waitlist');
    assert.deepEqual(await site.readStore(), before, 'Viewing admin must not change persisted data');
  });

  for (const plan of ['monthly', 'annual']) {
    await t.test(`${plan} checkout returns a local mock page without completing or charging`, async () => {
      const response = await site.request('/api/checkout', { plan });
      assertResponse(response, 200, /^application\/json$/i, `${plan} checkout`);
      const checkout = JSON.parse(response.body);
      assert.equal(checkout.mock, true);
      assert.match(checkout.id, /^cs_mock_[a-f0-9]+$/);
      const url = new URL(checkout.url);
      assert.equal(url.origin, site.origin);
      assert.equal(url.pathname, `/billing/mock/checkout/${checkout.id}`);
      assert.equal(url.search + url.hash + url.username + url.password, '');
      site.checkoutPaths.add(url.pathname);
      const before = await site.readStore();
      assert.equal(before.billing.mock.sessions[checkout.id].plan, plan);
      assertUncompleted(before);
      // GET the page only: never submit its /complete form.
      const page = await site.request(url.href);
      assertResponse(page, 200, /^text\/html$/i, `${plan} mock checkout page`);
      assert.match(page.body, /<h1>Review your demo plan<\/h1>/);
      assert.ok(page.body.includes(`<h2>${plan === 'annual' ? 'Annual' : 'Monthly'} plan</h2>`));
      assert.match(page.body, /No real money moves/);
      assert.doesNotMatch(page.body, /4242 4242/);
      assert.deepEqual(await site.readStore(), before, 'Viewing checkout must not complete it or charge');
    });
  }
});
