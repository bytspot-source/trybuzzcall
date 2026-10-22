'use strict';
// Shop setup form over real local HTTP: POST /setup 422/409/200 (JSON and form), admin apply (auth), override effect.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const SERVER = path.resolve(__dirname, '../src/server.js');
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-setup-http-'));
  const pass = randomBytes(16).toString('hex');
  let child;
  for (let attempt = 0; ; attempt++) {
    const port = await freePort();
    child = spawn(process.execPath, [SERVER], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
      env: { NODE_ENV: 'test', TZ: 'UTC', BUSINESS_TZ: 'UTC', PORT: String(port), PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, DATA_DIR: dir,
        ADMIN_PASSWORD: pass, BUSINESS_NAME: 'Env Plumbing', STRIPE_SECRET_KEY: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_PHONE_NUMBER: '',
        OPENAI_API_KEY: '', BOOKING_ENABLED: '0', DEPOSIT_ENABLED: '0', OWNER_PHONE: '', FORWARD_TO_PHONE: '' },
    });
    let out = '';
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      const cap = (c) => { out += c; if (out.includes(`missedcall-buzz on :${port} (`)) { clearTimeout(timer); resolve(true); } };
      child.stdout.on('data', cap); child.stderr.on('data', cap);
      child.once('close', () => { clearTimeout(timer); resolve(false); });
    });
    if (ok) { child.port = port; break; }
    child.kill('SIGKILL');
    if (attempt >= 4 || !out.includes('EADDRINUSE')) throw new Error(`server failed to start\n${out}`);
  }
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.once('close', r)));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${child.port}`;
  const auth = (p) => ({ Authorization: `Basic ${Buffer.from(`admin:${p}`).toString('base64')}` });
  return {
    dir, pass, base, auth,
    get: (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' }),
    json: (p, body, headers = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) }),
    form: (p, body, headers = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() }),
    db: () => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')),
    setups: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).setups || []; } catch { return []; } },
  };
}

const GOOD = {
  businessName: 'Crown Braids', city: 'Atlanta, GA', vertical: 'braiders', ownerPhone: '(404) 555-0100', forwardPhone: '(404) 555-0111',
  ringSeconds: '20', days: ['2', '3', '4', '5', '6'], open: '10:00', close: '19:00', tz: 'America/Chicago',
  services: [{ row: 0, name: 'Knotless braids', hours: '6', minutes: '0' }, { row: 1, name: 'Locs retwist', hours: '2', minutes: '30' }],
  booking: 'times', leadMinutes: '120', deposit: true, depositAmount: '60', holdMinutes: '20',
  bookingLink: 'https://booksy.com/crown', email: 'owner@crown.example', consent: true,
};

test('setup form over HTTP', { timeout: 60000 }, async (t) => {
  const s = await start(t);
  let cleanId;

  await t.test('GET /setup and /setup.html serve the form; rules script is served as JavaScript', async () => {
    for (const p of ['/setup', '/setup.html']) {
      const r = await s.get(p);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /<form id="setup-form"[^>]*method="post"[^>]*action="\/setup"/);
      for (const id of ['businessName', 'city', 'ownerPhone', 'forwardPhone', 'ringSeconds', 'open', 'close', 'tz', 'slotMinutes', 'leadMinutes', 'deposit', 'depositAmount', 'holdMinutes', 'bookingLink', 'email', 'consent']) {
        assert.match(html, new RegExp(`id="${id}"`), `field ${id}`);
      }
      assert.match(html, /href="terms.html"/); assert.match(html, /href="sms-consent.html"/);
      assert.match(html, /<option value="America\/New_York" selected>/);
    }
    const js = await s.get('/setup-rules.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.match(await js.text(), /root\.SetupRules = factory\(root\.BuzzTrades\)/);
  });

  await t.test('POST /setup with errors returns 422 and the issue list, saving nothing', async () => {
    const r = await s.json('/setup', { ...GOOD, ownerPhone: '555-0100', consent: false, depositAmount: '0' });
    assert.equal(r.status, 422);
    const j = await r.json();
    assert.equal(j.ok, false);
    const fields = j.errors.map((e) => e.field);
    for (const f of ['ownerPhone', 'depositAmount', 'consent']) assert.ok(fields.includes(f), f);
    assert.ok(j.errors.every((e) => e.level === 'error' && e.message));
    assert.deepEqual(s.setups(), []);
  });

  await t.test('POST /setup with only warnings returns 409 until confirmed', async () => {
    const body = { ...GOOD, city: 'Atlanta', depositAmount: '250' };
    const r = await s.json('/setup', body);
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.needsConfirm, true);
    assert.deepEqual(j.warnings.map((w) => w.field).sort(), ['city', 'depositAmount']);
    assert.deepEqual(s.setups(), []);
    const ok = await s.json('/setup', { ...body, confirm: 1 });
    assert.equal(ok.status, 200);
    const done = await ok.json();
    assert.equal(done.ok, true);
    assert.match(done.message, /within 1 business day/);
    const [saved] = s.setups();
    assert.equal(saved.id, done.id);
    assert.equal(saved.status, 'pending');
    assert.equal(saved.values.depositAmount, 250);
    assert.equal(saved.warningsConfirmed.length, 2);
    assert.ok(Date.parse(saved.createdAt));
  });

  await t.test('a clean POST /setup returns 200, stores a pending setup and does NOT change the live config', async () => {
    const r = await s.json('/setup', GOOD);
    assert.equal(r.status, 200);
    const { id } = await r.json();
    cleanId = id;
    const saved = s.setups().find((x) => x.id === id);
    assert.equal(saved.status, 'pending');
    assert.equal(saved.values.ownerPhone, '+14045550100');
    assert.deepEqual(saved.values.services.map((x) => x.minutes), [360, 150]);
    assert.equal(fs.existsSync(path.join(s.dir, 'config.json')), false);
    const health = await (await s.get('/health')).json();
    assert.equal(health.vertical, 'home_services');
    assert.equal(health.booking, false);
  });

  await t.test('form posts (no JavaScript) get HTML pages with the same status codes', async () => {
    const form = { ...GOOD, services: '', service_name: 'Knotless braids', service_hours: '6', service_minutes: '0', days: '2', consent: '1', deposit: '1', booking: 'times' };
    delete form.services;
    const bad = await s.form('/setup', { ...form, email: '' });
    assert.equal(bad.status, 422);
    assert.match(await bad.text(), /A couple things to fix[\s\S]*Add an email/);
    const warn = await s.form('/setup', { ...form, holdMinutes: '90' });
    assert.equal(warn.status, 409);
    const page = await warn.text();
    assert.match(page, /Looks off, are you sure\?/);
    assert.match(page, /<input type="hidden" name="confirm" value="1">/);
    assert.match(page, /<input type="hidden" name="service_name" value="Knotless braids">/);
    const before = s.setups().length;
    const ok = await s.form('/setup', { ...form, holdMinutes: '90', confirm: '1' });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /We'll review your setup and text you within 1 business day/);
    assert.equal(s.setups().length, before + 1);
    assert.equal(s.setups()[0].values.holdMinutes, 90);
  });

  await t.test('honeypot submissions are accepted silently but not stored', async () => {
    const before = s.setups().length;
    const r = await s.json('/setup', { ...GOOD, website: 'http://spam.example' });
    assert.equal(r.status, 200);
    assert.equal(s.setups().length, before);
  });

  await t.test('admin apply requires auth and refuses cross-site posts', async () => {
    const id = cleanId;
    assert.equal((await s.json(`/admin/setups/${id}/apply`, {})).status, 401);
    assert.equal((await s.json(`/admin/setups/${id}/apply`, {}, s.auth('wrong'))).status, 401);
    assert.equal((await s.json(`/admin/setups/${id}/apply`, {}, { ...s.auth(s.pass), Origin: 'https://evil.example' })).status, 403);
    assert.equal((await s.json('/admin/setups/nope/apply', {}, s.auth(s.pass))).status, 404);
    assert.equal(fs.existsSync(path.join(s.dir, 'config.json')), false);
    assert.equal((await s.get('/admin')).status, 401);
  });

  await t.test('admin sees Shop setups with issues; Apply writes the override and the line uses it', async () => {
    const adminPage = await (await s.get('/admin', s.auth(s.pass))).text();
    assert.match(adminPage, /Shop setups \(\d+\)/);
    assert.match(adminPage, /Apply to this line/);
    assert.match(adminPage, /Current effective config/);
    assert.match(adminPage, /\$250 deposit is high/, 'warnings are listed with the submission');
    const target = s.setups().find((x) => x.id === cleanId);
    const r = await s.json(`/admin/setups/${target.id}/apply`, {}, s.auth(s.pass));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.config.VERTICAL, 'braiders');
    assert.equal(j.config.SERVICES, 'Knotless braids:360,Locs retwist:150');
    const stored = JSON.parse(fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8'));
    assert.equal(stored.setupId, target.id);
    assert.equal(stored.values.OWNER_PHONE, '+14045550100');
    assert.equal(s.setups().find((x) => x.id === target.id).status, 'applied');
    const health = await (await s.get('/health')).json();
    assert.equal(health.vertical, 'braiders');
    assert.equal(health.booking, true);
    assert.equal(health.deposit, true);
    const after = await (await s.get('/admin', s.auth(s.pass))).text();
    assert.match(after, /<td>BUSINESS_NAME<\/td><td>Crown Braids<\/td><td>override<\/td>/);
    assert.match(after, /<td>BOOKING_ENABLED<\/td><td>1<\/td><td>override<\/td>/);
  });

  await t.test('form-style apply redirects to /admin; reset clears the override back to env', async () => {
    const target = s.setups().find((x) => x.status === 'pending');
    const r = await s.form(`/admin/setups/${target.id}/apply`, {}, s.auth(s.pass));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/admin#setups');
    assert.equal(s.setups().filter((x) => x.status === 'applied').length, 1, 'only one applied at a time');
    const reset = await s.json('/admin/config/reset', {}, s.auth(s.pass));
    assert.equal(reset.status, 200);
    assert.equal(fs.existsSync(path.join(s.dir, 'config.json')), false);
    const health = await (await s.get('/health')).json();
    assert.equal(health.vertical, 'home_services');
    const page = await (await s.get('/admin', s.auth(s.pass))).text();
    assert.match(page, /<td>BUSINESS_NAME<\/td><td>Env Plumbing<\/td><td>env<\/td>/);
  });

  await t.test('a new trade (pet groomer, then "Other" jobs) submits, applies as an override and the line runs it', async () => {
    const pet = { ...GOOD, vertical: undefined, businessType: 'pet_grooming', businessName: 'Sudsy Paws', bookingLink: '',
      services: [{ row: 0, name: 'Full groom', hours: '2', minutes: '0' }, { row: 1, name: 'Nail trim', hours: '0', minutes: '30' }] };
    const r = await s.json('/setup', pet);
    assert.equal(r.status, 200);
    const { id } = await r.json();
    const admin = await (await s.get('/admin', s.auth(s.pass))).text();
    assert.match(admin, /Sudsy Paws · Atlanta, GA · Pet groomer \(clients pick a service and time\)/);
    const ap = await s.json(`/admin/setups/${id}/apply`, {}, s.auth(s.pass));
    assert.equal(ap.status, 200);
    const j = await ap.json();
    assert.equal(j.config.BUSINESS_TYPE, 'pet_grooming');
    assert.equal(j.config.BUSINESS_FLOW, 'appointments');
    assert.equal(j.config.SERVICES, 'Full groom:120,Nail trim:30');
    const stored = JSON.parse(fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8'));
    assert.equal(stored.values.BUSINESS_TYPE, 'pet_grooming');
    const health = await (await s.get('/health')).json();
    assert.equal(health.trade, 'pet_grooming');
    assert.equal(health.flow, 'appointments');
    assert.equal(health.vertical, 'appointments');
    const after = await (await s.get('/admin', s.auth(s.pass))).text();
    assert.match(after, /Running as: <b>Pet groomer<\/b> \(pet_grooming, appointments flow\)/);
    assert.match(after, /<td>BUSINESS_TYPE<\/td><td>pet_grooming<\/td><td>override<\/td>/);

    const missing = await s.json('/setup', { ...pet, businessType: 'other', tradeName: '', flow: '' });
    assert.equal(missing.status, 422);
    const fields = (await missing.json()).errors.map((e) => e.field);
    assert.ok(fields.includes('tradeName') && fields.includes('flow'), JSON.stringify(fields));

    const other = { ...pet, businessType: 'other', tradeName: 'Pool cleaning', flow: 'jobs', businessName: 'Blue Pools', services: [], slotMinutes: '120' };
    const o = await s.json('/setup', other);
    assert.equal(o.status, 200);
    const oid = (await o.json()).id;
    assert.equal((await s.json(`/admin/setups/${oid}/apply`, {}, s.auth(s.pass))).status, 200);
    const h2 = await (await s.get('/health')).json();
    assert.equal(h2.trade, 'other');
    assert.equal(h2.flow, 'jobs');
    assert.equal(h2.vertical, 'home_services');
    const cfg = JSON.parse(fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8')).values;
    assert.equal(cfg.BUSINESS_TRADE_LABEL, 'Pool cleaning');
    assert.equal(cfg.SLOT_MINUTES, '120');
  });

  await t.test('GET /setup offers a grouped business-type select with Other, a trade name and the two booking styles', async () => {
    const html = await (await s.get('/setup')).text();
    assert.match(html, /<select id="businessType" name="businessType">/);
    for (const g of ['Beauty &amp; personal care', 'Home services', 'Other services']) assert.match(html, new RegExp(`<optgroup label="${g}">`));
    for (const k of ['braiders', 'nails', 'plumbing', 'hvac', 'handyman', 'pet_grooming', 'other']) assert.match(html, new RegExp(`<option value="${k}">`));
    assert.match(html, /id="tradeName"/);
    assert.match(html, /name="flow" value="appointments"[^>]*>.*Clients pick a service and time/);
    assert.match(html, /name="flow" value="jobs">.*Customers describe a job/);
    assert.match(html, /<script src="trades.js" defer><\/script>\s*<script src="setup-rules.js" defer>/);
    const js = await s.get('/trades.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.match(await js.text(), /root\.BuzzTrades = factory\(\)/);
  });
});
