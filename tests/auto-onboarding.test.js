'use strict';
// Self-serve onboarding. Twilio and Stripe are fakes: no account, no network, flags default off in the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-onboard-'));
const SRC = path.resolve(__dirname, '../src') + path.sep;
const savedEnv = { ...process.env };
const savedCache = Object.entries(require.cache).filter(([file]) => file.startsWith(SRC));
for (const key of Object.keys(process.env)) delete process.env[key];
const adminPassword = `onboard-${randomBytes(12).toString('hex')}`;
const PRIMARY = `BU${'a'.repeat(32)}`;
Object.assign(process.env, {
  NODE_ENV: 'test', TZ: 'UTC', BUSINESS_TZ: 'UTC', DATA_DIR: dir, TRUST_PROXY: '0',
  PUBLIC_BASE_URL: 'http://shop.example', ADMIN_PASSWORD: adminPassword,
  BUSINESS_NAME: 'Legacy fixture', TWILIO_PHONE_NUMBER: '+14705550100',
  OWNER_PHONE: '', FORWARD_TO_PHONE: '', STRIPE_SECRET_KEY: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '',
  TRIAL_DAYS: '14', MOCK_PRICE_MONTHLY: '49', FOUNDING_SHOPS_LIMIT: '0',
  BILLING_REQUIRE_SUBSCRIPTION: '0', BILLING_ENFORCE: '1', TEXTBACK_COOLDOWN_MINUTES: '0',
  OUTBOUND_MAX_PER_HOUR: '0', OUTBOUND_MAX_PER_DAY: '0', OUTBOUND_SHOP_MAX_PER_HOUR: '0', OUTBOUND_SHOP_MAX_PER_DAY: '0',
  ONBOARD_CODE_MAX_PER_PHONE: '5', ONBOARD_CODE_MAX_PER_IP: '1000', ONBOARD_VERIFY_MAX_PER_IP: '1000',
  AUTO_PROVISION_MAX_PER_DAY: '25', AUTO_PROVISION_MIN_BALANCE: '20',
  TWILIO_PRIMARY_PROFILE_SID: PRIMARY,
});
for (const file of Object.keys(require.cache)) if (file.startsWith(SRC)) delete require.cache[file];
require('dotenv').config = () => ({ parsed: {} });

const EIN = '12-3456789';
const EIN_DIGITS = '123456789';
let network = 0;
https.request = () => { network += 1; throw new Error('live https blocked'); };
https.get = () => { network += 1; throw new Error('live https blocked'); };

const texts = [];
const state = {
  balance: '100.00', areaEmpty: false, regionEmpty: false, anyEmpty: false,
  areaNumber: '', regionNumber: '', anyNumber: '',
  searches: [], buys: [], brands: [], campaigns: [], owned: [],
  brandStatus: 'PENDING', campaignStatus: 'PENDING', failureReason: '',
  brandSid: 'BN' + 'b'.repeat(32), campaignSid: 'QE' + 'c'.repeat(32),
  einExact: false, einLength: 0, otps: 0, seq: 10, profiles: [],
};
function sid(prefix) { state.seq += 1; return prefix + String(state.seq).padStart(32, '0'); }
function handle(path, args) {
  const key = path.filter(Boolean).join('.');
  const attrs = args && args.attributes;
  if (args && args.type && attrs) {
    state.profiles.push({
      type: args.type,
      business_type: attrs.business_type || '',
      company_type: attrs.company_type || '',
      business_industry: attrs.business_industry || '',
      hasEin: !!attrs.business_registration_number,
    });
  }
  if (attrs && attrs.business_registration_number) {
    state.einExact = attrs.business_registration_number === EIN_DIGITS;
    state.einLength = String(attrs.business_registration_number).length;
    args = { type: args.type, hasRegistrationNumber: true };
  }
  if (key.endsWith('balance.fetch')) return { balance: state.balance, currency: 'USD' };
  if (key.endsWith('local.list')) {
    const q = args || {};
    state.searches.push(q);
    const next = (npa) => { state.seq += 1; return `+1${npa}555${String(1000 + state.seq).slice(-4)}`; };
    if (q.areaCode) return state.areaEmpty ? [] : [{ phoneNumber: next(String(q.areaCode).padStart(3, '0')) }];
    if (q.inRegion) return state.regionEmpty ? [] : [{ phoneNumber: next('470') }];
    return state.anyEmpty ? [] : [{ phoneNumber: next('212') }];
  }
  if (key.endsWith('incomingPhoneNumbers.list')) {
    const name = args && args.friendlyName;
    return state.owned.filter((item) => !name || item.friendlyName === name);
  }
  if (key.endsWith('incomingPhoneNumbers.create')) {
    const item = { sid: sid('PN'), phoneNumber: args.phoneNumber, friendlyName: args.friendlyName };
    state.owned.push(item);
    state.buys.push(args);
    return item;
  }
  if (key.endsWith('brandRegistrations.create')) {
    state.brands.push({ brandType: args.brandType, skipAutomaticSecVet: args.skipAutomaticSecVet === true });
    return { sid: state.brandSid, status: state.brandStatus, failureReason: state.failureReason };
  }
  if (key.includes('brandRegistrations') && key.endsWith('fetch')) return { sid: state.brandSid, status: state.brandStatus, failureReason: state.failureReason };
  if (key.includes('brandRegistrationOtps') && key.endsWith('create')) { state.otps += 1; return {}; }
  if (key.includes('usAppToPerson') && key.endsWith('create')) { state.campaigns.push(args); return { sid: state.campaignSid, campaignStatus: state.campaignStatus }; }
  if (key.includes('usAppToPerson') && key.endsWith('fetch')) return { sid: state.campaignSid, campaignStatus: state.campaignStatus, errors: [] };
  if (key.endsWith('Evaluations.create') || key.endsWith('evaluations.create')) return { sid: sid('EL'), status: 'compliant' };
  if (key.endsWith('.update')) return { status: args && args.status };
  if (key.endsWith('.create')) return { sid: sid(key.includes('address') ? 'AD' : key.includes('service') ? 'MG' : 'BU') };
  return {};
}
function proxy(path) {
  const target = function callable() {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop !== 'string') return undefined;
      if (['create', 'fetch', 'list', 'update'].includes(prop)) return (args) => Promise.resolve(handle(path.concat(prop), args));
      return proxy(path.concat(prop));
    },
    apply(_t, _this, args) { return proxy(path.concat(String(args[0] ?? ''))); },
  });
}

const store = require('../src/store');
const sms = require('../src/sms');
const twilioClient = require('../src/twilioClient');
const onboarding = require('../src/onboarding');
const { app } = require('../src/server');
sms.setClient({ messages: { create: async (params) => { texts.push(params); return { sid: 'SM_test' }; } } });
twilioClient.setClient(proxy([]));

let server, port;
const auth = 'Basic ' + Buffer.from(`admin:${adminPassword}`).toString('base64');
function req(method, pathname, { body, cookie, admin = false, form = false, accept } = {}) {
  const payload = body == null ? null : form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: {
        host: 'shop.example', accept: accept || (form ? 'text/html' : 'application/json'),
        origin: 'http://shop.example', ...(cookie ? { cookie } : {}), ...(admin ? { authorization: auth } : {}),
        ...(payload ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end(payload || undefined);
  });
}
const cookieOf = (res) => (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie'] || ''])
  .map((line) => String(line).split(';')[0]).filter((part) => part && !part.endsWith('=')).join('; ');
const codeFor = (phone) => {
  const hit = [...texts].reverse().find((row) => row.to === phone && /code is (\d{6})/.test(row.body));
  const match = hit && /code is (\d{6})/.exec(hit.body);
  assert.ok(match, 'verification text');
  return match[1];
};
let n = 0;
const phone = () => { n += 1; return `+1404555${String(2000 + n).padStart(4, '0')}`; };
function setupBody(over = {}) {
  const owner = over.ownerPhone || '(404) 555-2100';
  return {
    businessName: 'Peach Plumbing', city: 'Atlanta, GA', businessType: 'plumbing',
    ownerPhone: owner, forwardPhone: '(404) 555-0199', ringSeconds: '20',
    days: ['1', '2', '3', '4', '5'], open: '08:00', close: '17:00', tz: 'America/New_York',
    booking: '1', slotMinutes: '120', leadMinutes: '60', deposit: false,
    email: over.email || `owner${n}@peach.example`, consent: true, ...over,
  };
}
const e164 = (value) => '+1' + String(value).replace(/\D/g, '').replace(/^1/, '').slice(-10);
const containsEin = (value) => String(value).includes(EIN_DIGITS) || String(value).includes(EIN);
const logs = [];
const methods = ['log', 'info', 'warn', 'error', 'debug'];
const originals = Object.fromEntries(methods.map((name) => [name, console[name]]));
for (const name of methods) console[name] = (...args) => { logs.push(args.map((part) => (typeof part === 'string' ? part : '')).join(' ')); };

test.before(async () => {
  await store.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});
test.after(async () => {
  for (const name of methods) console[name] = originals[name];
  if (server) await new Promise((resolve) => server.close(resolve));
  sms.setClient(null);
  twilioClient.setClient(null);
  for (const file of Object.keys(require.cache)) if (file.startsWith(SRC)) delete require.cache[file];
  for (const [file, mod] of savedCache) require.cache[file] = mod;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('flags off keeps review-only setup and admin approval', async () => {
  delete process.env.AUTO_ONBOARDING;
  delete process.env.AUTO_PROVISION_NUMBERS;
  delete process.env.AUTO_A2P;
  const before = texts.length;
  const body = setupBody({ email: 'legacy@peach.example', ownerPhone: '(404) 555-2101' });
  const res = await req('POST', '/setup', { body });
  assert.equal(res.status, 200);
  const json = JSON.parse(res.body);
  assert.equal(json.next, undefined);
  assert.match(json.message, /within 1 business day/);
  assert.equal(texts.length, before);
  assert.equal(state.buys.length, 0);
  const approved = await req('POST', '/admin/vendors/approve', { admin: true, body: { setupId: json.id, confirm_setup: '1' }, accept: 'text/html' });
  assert.equal(approved.status, 200);
  assert.match(approved.body, /activation-code/);
  assert.equal(network, 0);
});

test('auto onboarding: honeypot, consent, US/Canada, code limits, and one shop per cell', async () => {
  process.env.AUTO_ONBOARDING = '1';
  const honeypotBefore = texts.length;
  const honey = await req('POST', '/setup', { body: { ...setupBody({ email: 'bot@peach.example' }), website: 'http://spam.example' } });
  assert.equal(honey.status, 200);
  assert.equal(JSON.parse(honey.body).id, null);
  assert.equal(texts.length, honeypotBefore);
  const consent = await req('POST', '/setup', { body: { ...setupBody({ email: 'noconsent@peach.example' }), consent: false } });
  assert.equal(consent.status, 422);
  assert.equal(JSON.parse(consent.body).errors.some((e) => e.field === 'consent'), true);
  const foreign = await req('POST', '/setup', { body: setupBody({ email: 'foreign@peach.example', ownerPhone: '(876) 555-0100' }) });
  assert.equal(foreign.status, 422);
  assert.equal(JSON.parse(foreign.body).errors.some((e) => e.field === 'ownerPhone'), true);

  const owner = phone();
  const created = await req('POST', '/setup', { body: setupBody({ email: 'limits@peach.example', ownerPhone: owner }) });
  assert.equal(created.status, 200);
  const setupId = JSON.parse(created.body).id;
  assert.equal(JSON.parse(created.body).next, 'verify');
  const cell = e164(owner);
  const good = codeFor(cell);
  for (let i = 0; i < 5; i += 1) {
    const wrong = await req('POST', '/onboarding/verify', { body: { setupId, code: '000000' } });
    assert.equal(wrong.status, 400);
  }
  const locked = await req('POST', '/onboarding/verify', { body: { setupId, code: good } });
  assert.equal(locked.status, 429);
  for (let i = 0; i < 4; i += 1) {
    const again = await req('POST', '/onboarding/resend', { body: { setupId } });
    assert.equal(again.status, 200);
  }
  const capped = await req('POST', '/onboarding/resend', { body: { setupId } });
  assert.equal(capped.status, 429);

  const expiring = phone();
  const exp = await req('POST', '/setup', { body: setupBody({ email: 'expire@peach.example', ownerPhone: expiring }) });
  const expId = JSON.parse(exp.body).id;
  store.root.db.onboarding.verifications[expId].expiresAt = Date.now() - 1000;
  const stale = await req('POST', '/onboarding/verify', { body: { setupId: expId, code: codeFor(e164(expiring)) } });
  assert.equal(stale.status, 400);
  assert.match(stale.body, /expired/);

  process.env.ONBOARD_CODE_MAX_PER_IP = '2';
  onboarding.resetLimits();
  const ipA = await req('POST', '/setup', { body: setupBody({ email: 'ip-a@peach.example', ownerPhone: phone() }) });
  const ipB = await req('POST', '/setup', { body: setupBody({ email: 'ip-b@peach.example', ownerPhone: phone() }) });
  const ipC = await req('POST', '/setup', { body: setupBody({ email: 'ip-c@peach.example', ownerPhone: phone() }) });
  assert.equal(ipA.status, 200);
  assert.equal(ipB.status, 200);
  assert.match(JSON.parse(ipC.body).message, /Too many/);
  const third = await req('POST', '/onboarding/resend', { body: { setupId: JSON.parse(ipC.body).id } });
  assert.equal(third.status, 429);
  process.env.ONBOARD_CODE_MAX_PER_IP = '1000';
  onboarding.resetLimits();

  const shared = phone();
  const first = await signup({ email: 'first-shop@peach.example', ownerPhone: shared, businessName: 'First Shop Plumbing' });
  const second = await req('POST', '/setup', { body: setupBody({ email: 'second-shop@peach.example', ownerPhone: shared, businessName: 'Second Shop Plumbing' }) });
  const secondId = JSON.parse(second.body).id;
  const blocked = await req('POST', '/onboarding/verify', { body: { setupId: secondId, code: codeFor(e164(shared)) } });
  assert.equal(blocked.status, 409);
  const allowed = await req('POST', `/admin/onboarding/${first.shopId}/allow-phone`, { admin: true, body: { confirm: '1' } });
  assert.equal(allowed.status, 303);
  const opened = await req('POST', '/onboarding/verify', { body: { setupId: secondId, code: codeFor(e164(shared)) } });
  assert.equal(opened.status, 200);
});

async function signup(over) {
  const body = setupBody(over);
  const created = await req('POST', '/setup', { body });
  assert.equal(created.status, 200, created.body.slice(0, 180));
  const setupId = JSON.parse(created.body).id;
  const verified = await req('POST', '/onboarding/verify', { body: { setupId, code: codeFor(e164(body.ownerPhone)) } });
  assert.equal(verified.status, 200, verified.body.slice(0, 180));
  const password = 'buzzcall-test-password';
  const signed = await req('POST', '/onboarding/password', { cookie: cookieOf(verified), body: { password, passwordConfirm: password } });
  assert.equal(signed.status, 200, signed.body.slice(0, 180));
  const shop = require('../src/vendors').all().find((row) => row.email === body.email.toLowerCase());
  return { cookie: cookieOf(signed), shopId: shop.id, email: body.email.toLowerCase(), phone: e164(body.ownerPhone) };
}

test('checklist, trial, idempotent number purchase, cap, balance, and fallback', async () => {
  process.env.AUTO_ONBOARDING = '1';
  process.env.AUTO_PROVISION_NUMBERS = '1';
  delete process.env.AUTO_A2P;
  const shop = await signup({ email: 'numbers@peach.example', ownerPhone: phone(), businessName: 'Number Shop Plumbing' });
  const page = await req('GET', '/vendor', { cookie: shop.cookie, accept: 'text/html' });
  assert.equal(page.status, 200);
  assert.match(page.body, /Finish setting up/);
  assert.match(page.body, /14-day trial/);
  assert.equal(state.buys.length, 0);
  const checkout = await req('POST', '/vendor/billing/checkout', { cookie: shop.cookie, body: { plan: 'monthly' } });
  assert.equal(checkout.status, 200);
  const session = JSON.parse(checkout.body).id;
  const paid = await req('POST', `/vendor/billing/mock/checkout/${session}/complete`, { cookie: shop.cookie, body: {} });
  assert.equal(paid.status, 200);
  const after = await req('GET', '/vendor', { cookie: shop.cookie, accept: 'text/html' });
  assert.equal(state.buys.length, 1);
  assert.equal(state.buys[0].voiceUrl, 'http://shop.example/twilio/voice');
  assert.equal(state.buys[0].smsUrl, 'http://shop.example/twilio/sms');
  assert.equal(state.buys[0].voiceMethod, 'POST');
  assert.equal(state.buys[0].smsMethod, 'POST');
  assert.equal(state.searches[0].areaCode, 404);
  assert.match(after.body, /\*71/);
  assert.match(after.body, /Google/);
  await req('GET', '/vendor', { cookie: shop.cookie, accept: 'text/html' });
  assert.equal(state.buys.length, 1);

  const capBefore = state.buys.length;
  process.env.AUTO_PROVISION_MAX_PER_DAY = String(capBefore);
  const capped = await signup({ email: 'capped@peach.example', ownerPhone: phone(), businessName: 'Capped Shop Plumbing' });
  await startTrial(capped.cookie);
  await req('GET', '/vendor', { cookie: capped.cookie, accept: 'text/html' });
  assert.equal(state.buys.length, capBefore);
  const queue = await req('GET', '/admin/onboarding', { admin: true, accept: 'text/html' });
  assert.match(queue.body, /Cap hit/);
  process.env.AUTO_PROVISION_MAX_PER_DAY = '25';

  state.balance = '10.00';
  const broke = await signup({ email: 'broke@peach.example', ownerPhone: phone(), businessName: 'Broke Shop Plumbing' });
  await startTrial(broke.cookie);
  await req('GET', '/vendor', { cookie: broke.cookie, accept: 'text/html' });
  assert.equal(state.buys.length, capBefore);
  const low = await req('GET', '/admin/onboarding', { admin: true, accept: 'text/html' });
  assert.match(low.body, /Low balance/);
  state.balance = '100.00';

  state.areaEmpty = true;
  state.regionEmpty = true;
  state.searches = [];
  const fallback = await signup({ email: 'fallback@peach.example', ownerPhone: phone(), businessName: 'Fallback Shop Plumbing' });
  await startTrial(fallback.cookie);
  await req('GET', '/vendor', { cookie: fallback.cookie, accept: 'text/html' });
  assert.equal(state.searches.some((q) => q.areaCode === 404), true);
  assert.equal(state.searches.some((q) => q.inRegion === 'GA'), true);
  assert.equal(state.searches.some((q) => !q.areaCode && !q.inRegion), true);
  assert.equal(state.buys.at(-1).phoneNumber.startsWith('+1212'), true);
  state.areaEmpty = false;
  state.regionEmpty = false;

  const manual = await req('POST', `/admin/onboarding/${capped.shopId}/provision`, { admin: true, body: { phoneNumber: '+14045550198', confirm_phones: '1' } });
  assert.equal(manual.status, 303);
  const retry = await req('POST', `/admin/onboarding/${capped.shopId}/retry`, { admin: true, body: {} });
  assert.equal(retry.status, 303);
  const suspended = await req('POST', `/admin/onboarding/${capped.shopId}/suspend`, { admin: true, body: {} });
  assert.equal(suspended.status, 303);
  assert.equal(require('../src/vendors').get(capped.shopId).status, 'suspended');
  assert.equal(network, 0);
});

async function startTrial(cookie) {
  const checkout = await req('POST', '/vendor/billing/checkout', { cookie, body: { plan: 'monthly' } });
  assert.equal(checkout.status, 200, checkout.body.slice(0, 180));
  const session = JSON.parse(checkout.body).id;
  const paid = await req('POST', `/vendor/billing/mock/checkout/${session}/complete`, { cookie, body: {} });
  assert.equal(paid.status, 200, paid.body.slice(0, 180));
}

test('A2P state machine holds customer texts until approval and never prints the EIN', async () => {
  process.env.AUTO_ONBOARDING = '1';
  process.env.AUTO_PROVISION_NUMBERS = '1';
  process.env.AUTO_A2P = '1';
  const mark = logs.length;
  const shop = await signup({ email: 'a2p@peach.example', ownerPhone: phone(), businessName: 'Peach Plumbing' });
  const saved = await req('POST', '/vendor/onboarding/registration', { cookie: shop.cookie, body: {
    legalName: 'Other Legal Name LLC', entity: 'llc', ein: EIN, street: '100 Peachtree St', city: 'Atlanta', region: 'GA',
    postalCode: '30303', website: 'https://peach.example', contactName: 'Ada Owner', contactEmail: 'ada@peach.example',
    contactPhone: '(404) 555-0177',
  } });
  assert.equal(saved.status, 200, saved.body.slice(0, 200));
  assert.equal(containsEin(saved.body), false);
  const draft = await req('GET', '/vendor', { cookie: shop.cookie, accept: 'text/html' });
  assert.equal(containsEin(draft.body), false);
  assert.match(draft.body, /6789/);
  assert.equal(state.brands.length, 0);
  await startTrial(shop.cookie);
  const live = await req('GET', '/vendor', { cookie: shop.cookie, accept: 'text/html' });
  assert.equal(state.brands.length, 1);
  assert.equal(state.brands[0].brandType, 'STANDARD');
  assert.equal(state.brands[0].skipAutomaticSecVet, true);
  assert.equal(state.einExact, true);
  assert.equal(state.einLength, 9);
  assert.match(live.body, /pending|in review/i);
  assert.equal(containsEin(live.body), false);
  const admin = await req('GET', '/admin/onboarding', { admin: true, accept: 'text/html' });
  assert.match(admin.body, /Name mismatch/);
  assert.match(admin.body, /••-•••6789|6789/);
  assert.equal(containsEin(admin.body), false);
  const stored = JSON.stringify(store.root.db.onboarding);
  assert.equal(containsEin(stored), false);
  assert.equal(logs.slice(mark).some(containsEin), false);
  assert.equal(containsEin(fs.readFileSync(path.join(dir, 'sms.log'), 'utf8')), false);

  const line = require('../src/vendors').get(shop.shopId).phoneNumber;
  const caller = '+14045550123';
  const call = 'CA' + '1'.repeat(32);
  await req('POST', '/twilio/voice', { form: true, body: { From: caller, To: line, CallSid: call } });
  await req('POST', '/twilio/voice/status', { form: true, body: { From: caller, To: line, CallSid: call, DialCallStatus: 'no-answer' } });
  await req('POST', '/twilio/voice/consent', { form: true, body: { From: caller, To: line, CallSid: call, Digits: '1' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(texts.some((row) => row.to === caller), false);
  assert.equal(texts.some((row) => row.to === shop.phone && /BUZZ/.test(row.body)), true);
  const help = await req('POST', '/twilio/sms', { form: true, body: { From: caller, To: line, Body: 'HELP' } });
  assert.equal(help.status, 200);
  assert.equal(texts.some((row) => row.to === caller && /missed-call text-back/.test(row.body)), true);

  state.brandStatus = 'FAILED';
  state.failureReason = 'Address could not be verified';
  await req('POST', `/admin/onboarding/${shop.shopId}/retry`, { admin: true, body: {} });
  const rejected = await req('GET', '/admin/onboarding', { admin: true, accept: 'text/html' });
  assert.match(rejected.body, /Rejected/);
  assert.match(rejected.body, /Address could not be verified/);
  assert.equal(texts.filter((row) => row.to === caller && !/missed-call text-back/.test(row.body)).length, 0);

  state.brandStatus = 'APPROVED';
  state.campaignStatus = 'VERIFIED';
  state.failureReason = '';
  await req('GET', '/vendor', { cookie: shop.cookie, accept: 'text/html' });
  assert.equal(state.campaigns.length, 1);
  assert.equal(state.campaigns[0].usAppToPersonUsecase, 'LOW_VOLUME');
  assert.equal(/unsubscribed|START/.test(state.campaigns[0].optOutMessage), true);
  assert.equal(/help/i.test(state.campaigns[0].helpMessage), true);
  assert.equal(/press 1/i.test(state.campaigns[0].messageFlow), true);
  assert.equal(texts.some((row) => row.to === caller && !/missed-call text-back/.test(row.body)), true);
  const again = state.campaigns.length;
  await req('POST', `/admin/onboarding/${shop.shopId}/retry`, { admin: true, body: {} });
  assert.equal(state.brands.length, 1);
  assert.equal(state.campaigns.length, again);

  state.brandStatus = 'PENDING';
  state.campaignStatus = 'PENDING';
  state.failureReason = '';
  const sole = await signup({ email: 'sole@peach.example', ownerPhone: phone(), businessName: 'Sole Shop Plumbing' });
  const soleSaved = await req('POST', '/vendor/onboarding/registration', { cookie: sole.cookie, body: {
    legalName: 'Sam Sole', entity: 'sole_proprietor', street: '200 Edgewood Ave', city: 'Atlanta', region: 'GA', postalCode: '30303',
    website: 'https://sole.example', contactName: 'Sam Sole', contactEmail: 'sam@sole.example', contactPhone: sole.phone,
  } });
  assert.equal(soleSaved.status, 200);
  state.einExact = false;
  state.einLength = 0;
  await startTrial(sole.cookie);
  await req('GET', '/vendor', { cookie: sole.cookie, accept: 'text/html' });
  const last = state.brands.at(-1);
  assert.equal(last.brandType, 'SOLE_PROPRIETOR');
  assert.equal(last.skipAutomaticSecVet, false);
  assert.equal(state.einLength, 0);
  assert.equal(state.campaigns.filter((row) => row.usAppToPersonUsecase === 'SOLE_PROPRIETOR').length, 0);
  state.brandStatus = 'APPROVED';
  state.campaignStatus = 'VERIFIED';
  await req('GET', '/vendor', { cookie: sole.cookie, accept: 'text/html' });
  assert.equal(state.campaigns.at(-1).usAppToPersonUsecase, 'SOLE_PROPRIETOR');
  assert.equal(network, 0);
  assert.equal(logs.some(containsEin), false);
  const llcProfile = state.profiles.find((row) => row.business_type === 'Limited Liability Corporation');
  assert.equal(llcProfile.company_type, '');
  assert.equal(llcProfile.hasEin, true);
  assert.equal(state.profiles.some((row) => row.company_type === 'private' && row.type === 'us_a2p_messaging_profile_information'), true);
});

test('business type maps to Twilio fields, rejects a missing EIN, and holds legacy records', async () => {
  process.env.AUTO_ONBOARDING = '1';
  process.env.AUTO_A2P = '1';
  process.env.TWILIO_PRIMARY_PROFILE_SID = PRIMARY;
  const a2p = require('../src/a2p');
  const expected = [
    ['llc', 'Limited Liability Corporation', 'private', ''],
    ['corporation', 'Corporation', 'private', ''],
    ['partnership', 'Partnership', 'private', ''],
    ['nonprofit', 'Non-profit Corporation', 'non-profit', 'NOT_FOR_PROFIT'],
  ];
  for (const [key, businessType, companyType, industry] of expected) {
    const spec = a2p.entitySpec(key);
    assert.equal(spec.flow, 'low_volume_standard');
    assert.equal(spec.businessType, businessType);
    assert.equal(spec.companyType, companyType);
    assert.equal(spec.industry || '', industry);
  }
  assert.equal(a2p.entitySpec('sole_proprietor').flow, 'sole_proprietor');
  assert.equal(a2p.entitySpec('nope'), null);

  const shop = await signup({ email: 'entity@peach.example', ownerPhone: phone(), businessName: 'Entity Shop Plumbing' });
  const fields = {
    legalName: 'Entity Shop LLC', street: '10 Mitchell St', city: 'Atlanta', region: 'GA', postalCode: '30303',
    website: 'https://entity.example', contactName: 'Eve Owner', contactEmail: 'eve@entity.example', contactPhone: shop.phone,
  };
  const missing = await req('POST', '/vendor/onboarding/registration', { cookie: shop.cookie, body: fields });
  assert.equal(missing.status, 400);
  assert.match(missing.body, /business type/);
  const unknown = await req('POST', '/vendor/onboarding/registration', { cookie: shop.cookie, body: { ...fields, entity: 'co-op' } });
  assert.equal(unknown.status, 400);
  for (const key of ['llc', 'corporation', 'partnership', 'nonprofit']) {
    const rejected = await req('POST', '/vendor/onboarding/registration', { cookie: shop.cookie, body: { ...fields, entity: key } });
    assert.equal(rejected.status, 400, key);
    assert.match(rejected.body, /9-digit EIN/);
  }
  const short = await req('POST', '/vendor/onboarding/registration', { cookie: shop.cookie, body: { ...fields, entity: 'llc', ein: '12-345' } });
  assert.equal(short.status, 400);
  assert.match(short.body, /9 digits/);
  const soleBlank = await req('POST', '/vendor/onboarding/registration', { cookie: shop.cookie, body: { ...fields, entity: 'sole_proprietor' } });
  assert.equal(soleBlank.status, 200);
  assert.equal(containsEin(soleBlank.body), false);

  state.brandStatus = 'PENDING';
  for (const [key, businessType, companyType, industry] of expected) {
    const saved = await req('POST', '/vendor/onboarding/registration', { cookie: shop.cookie, body: { ...fields, entity: key, ein: EIN } });
    assert.equal(saved.status, 200, key);
    assert.equal(containsEin(saved.body), false);
    const mark = state.profiles.length;
    const brands = state.brands.length;
    await a2p.sync(shop.shopId, 'http://shop.example');
    const slice = state.profiles.slice(mark);
    const business = slice.find((row) => row.type === 'customer_profile_business_information');
    const company = slice.find((row) => row.type === 'us_a2p_messaging_profile_information');
    assert.equal(business.business_type, businessType);
    assert.equal(business.hasEin, true);
    assert.equal(company.company_type, companyType);
    if (industry) assert.equal(business.business_industry, industry);
    assert.equal(state.brands.length, brands + 1);
    assert.equal(state.brands.at(-1).brandType, 'STANDARD');
    assert.equal(state.brands.at(-1).skipAutomaticSecVet, true);
    const rec = store.root.db.onboarding.shops[shop.shopId];
    rec.a2p = { status: 'not_started' };
    rec.registration.ein = EIN_DIGITS;
    store.root.save();
  }
  const soleMark = state.profiles.length;
  const soleBrands = state.brands.length;
  await req('POST', '/vendor/onboarding/registration', { cookie: shop.cookie, body: { ...fields, entity: 'sole_proprietor' } });
  await a2p.sync(shop.shopId, 'http://shop.example');
  const soleSlice = state.profiles.slice(soleMark);
  assert.equal(soleSlice.some((row) => row.type === 'sole_proprietor_information'), true);
  assert.equal(soleSlice.some((row) => row.hasEin), false);
  assert.equal(state.brands.length, soleBrands + 1);
  assert.equal(state.brands.at(-1).brandType, 'SOLE_PROPRIETOR');

  const rec = store.root.db.onboarding.shops[shop.shopId];
  rec.a2p = { status: 'not_started' };
  rec.registration = { ...fields, country: 'US', contactPhone: shop.phone, ein: EIN_DIGITS, ready: true };
  delete rec.registration.entity;
  store.root.save();
  const brandsBefore = state.brands.length;
  await a2p.sync(shop.shopId, 'http://shop.example');
  assert.equal(state.brands.length, brandsBefore);
  assert.equal(rec.flags.includes('needs_business_type'), true);
  const queued = await req('GET', '/admin/onboarding', { admin: true, accept: 'text/html' });
  assert.match(queued.body, /Needs business type/);
  assert.match(queued.body, /Not set/);
  assert.equal(containsEin(queued.body), false);
  const edited = await req('POST', `/admin/onboarding/${shop.shopId}/entity`, { admin: true, body: { entity: 'corporation', confirm: '1' } });
  assert.equal(edited.status, 200);
  assert.equal(containsEin(edited.body), false);
  assert.match(edited.body, /"entity":"corporation"/);
  const shown = await req('GET', '/admin/onboarding', { admin: true, accept: 'text/html' });
  assert.match(shown.body, /value="corporation" selected/);
  assert.equal(shown.body.includes('Needs business type'), false);
  assert.equal(containsEin(shown.body), false);
  await a2p.sync(shop.shopId, 'http://shop.example');
  assert.equal(state.profiles.at(-1).company_type === 'private' || state.profiles.some((row) => row.business_type === 'Corporation' && row.hasEin), true);
  assert.equal(logs.some(containsEin), false);
  assert.equal(network, 0);
});
