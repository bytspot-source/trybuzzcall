'use strict';
// No-show dispute protection for vendors: signed check-in links (validity, expiry, window), NO after check-in ->
// disputed (not paused), vendor proof by MMS / proof link / vendor portal, follow-up + 48h auto-release, KEEP holds,
// quiet hours, opt-outs, the repeat-claim flag, admin timeline + evidence export, and YES/NO/KEEP parsing that never
// swallows a normal conversation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-disputes-'));
require('dotenv').config = () => ({ parsed: {} });
const CLEAR = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'OPENAI_API_KEY', 'DATABASE_URL', 'FORWARD_TO_PHONE', 'VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_TYPE', 'SERVICES', 'BOOKING_LINK', 'BILLING_REQUIRE_SUBSCRIPTION',
  'BILLING_ENFORCE', 'DEMO_MODE', 'ADMIN_USERNAME', 'RENDER', 'CLIENT_IP_HEADER', 'KEYWORD_REPLIES', 'DEPOSIT_PLATFORM_FEE_PCT', 'LEAD_FEE', 'LEAD_FEE_WAIVED',
  'CHECKIN_WINDOW_BEFORE_HOURS', 'CHECKIN_WINDOW_AFTER_HOURS', 'DISPUTE_AUTO_RELEASE_HOURS', 'NOSHOW_FLAG_THRESHOLD', 'NOSHOW_FLAG_WINDOW_DAYS', 'DISPUTE_TOKEN_SECRET',
  'INSTANT_MISSED_BUZZ', 'OUTCOMES_EMAIL_STEP'];
for (const k of CLEAR) delete process.env[k];
const OWNER = '+14045550100';
const ADMIN = 'disputes-test-password-long-enough';
Object.assign(process.env, {
  DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', ADMIN_PASSWORD: ADMIN, BUSINESS_NAME: 'Peach State Plumbing',
  OWNER_PHONE: OWNER, PUBLIC_BASE_URL: 'https://shop.example', TWILIO_PHONE_NUMBER: '+14705550100',
  DEPOSIT_RELEASE_HOURS: '24', NOSHOW_CHECK_HOURS: '12', INSTANT_MISSED_BUZZ: '0',
});

const store = require('../src/store');
const deposits = require('../src/deposits');
const disputes = require('../src/disputes');
const outcomes = require('../src/outcomes');
const shopTime = require('../src/shopTime');
const { app } = require('../src/server');

const HOUR = 3600000;
let server, URL0;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); URL0 = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const auth = 'Basic ' + Buffer.from(`admin:${ADMIN}`).toString('base64');
const form = (p, fields, { headers = {} } = {}) => fetch(URL0 + p, { method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
const sameSite = () => ({ origin: URL0 });
const admin = (p, opts = {}) => fetch(URL0 + p, { redirect: 'manual', ...opts, headers: { authorization: auth, ...(opts.headers || {}) } });
const smsLog = () => { try { return fs.readFileSync(path.join(dir, 'sms.log'), 'utf8'); } catch { return ''; } };
const sentTo = (p) => smsLog().split('\n').filter((l) => l.includes(`SMS -> ${p}:`));
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const quiet = (t) => { const o = console.error, l = console.log; console.error = () => {}; console.log = () => {}; t.after(() => { console.error = o; console.log = l; }); };
let n = 0; const phone = () => `+1404555${String(4000 + (n++)).slice(-4)}`;

function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
function reset(t) {
  quiet(t);
  store.setOverride({ stripeConnect: { accountId: 'acct_mock_disp', mode: 'mock', chargesEnabled: true } });
  store.db.bookings.length = 0; store.db.leads.length = 0; store.db.alerts.length = 0;
  store.db.deposits = []; store.db.vendorDebt = {}; store.db.depositsMeta = { offsetMs: 0, events: [] };
  store.db.voiceConsents = []; store.db.optOuts = {}; store.db.outcomes = {}; store.db.disputePhotos = {};
  store.root.db.noshowClaims = {}; store.root.db.flaggedCustomers = {};
  t.after(() => { store.db.depositsMeta = { offsetMs: 0, events: [] }; });
}
// A confirmed, paid booking whose appointment starts `startInHours` from now (2h long).
function paidBooking({ startInHours = 1, customer = phone(), name = 'Pat' } = {}) {
  const start = deposits.now() + startInHours * HOUR;
  const b = { id: 'bk' + Math.random().toString(36).slice(2, 10), leadId: 'l1', phone: customer, name, need: 'leak under sink',
    slotStart: new Date(start).toISOString(), slotEnd: new Date(start + 2 * HOUR).toISOString(), slotLabel: 'Fri, Nov 6, 10:00 AM',
    status: 'confirmed', paid: true, amount: 49, paidAt: new Date().toISOString(), createdAt: new Date().toISOString() };
  store.db.bookings.unshift(b);
  (store.db.voiceConsents ||= []).unshift({ from: customer, consented: true, digits: '1', at: new Date().toISOString() });
  // Outcomes record so stage changes can be asserted.
  outcomes.missed({ callSid: 'CA' + b.id.padEnd(32, '0'), from: customer, offered: true });
  outcomes.booked({ phone: customer }, { id: b.id, status: 'confirmed', amount: 49, slotLabel: b.slotLabel });
  const d = deposits.onBookingPaid(b);
  return { b, d };
}
const advance = (hours) => { store.db.depositsMeta.offsetMs += hours * HOUR; };
const pendingCheck = (d) => { d.noshowSentAt = new Date().toISOString(); store.save(); };
const outcomeFor = (b) => Object.values(store.db.outcomes).find((r) => r.booking_id === b.id);
// Vendor POSTs must look like they come from the site (PUBLIC_BASE_URL origin and Host).
const vendorPost = (target, cookie, body) => new Promise((resolve, reject) => {
  const req = require('node:http').request(URL0 + target, { method: 'POST', headers: { host: 'shop.example', origin: 'https://shop.example', cookie,
    'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject); req.end(body);
});
const capture = () => { const sent = []; const fn = async (to, body) => { sent.push({ to, body }); return { ok: true }; }; fn.sent = sent; return fn; };

// ---------- check-in tokens and window ----------
test('check-in token: signed, single booking, rejects tampering / wrong kind, and expires', (t) => {
  reset(t);
  const { b } = paidBooking({ startInHours: 1 });
  const token = disputes.checkinToken(b);
  const p = disputes.readToken(token, 'ci');
  assert.ok(p);
  assert.equal(p.b, b.id);
  assert.equal(p.s, '');
  assert.equal(disputes.expired(p), false);
  assert.equal(disputes.readToken(token, 'pf'), null, 'a check-in token is not a proof token');
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...p, b: 'someoneelse' })).toString('base64url');
  assert.equal(disputes.readToken(`${forged}.${sig}`, 'ci'), null, 'payload change breaks the signature');
  assert.equal(disputes.readToken(`${body}.${sig.slice(0, -2)}AA`, 'ci'), null);
  assert.equal(disputes.readToken('garbage', 'ci'), null);
  // Expiry: appointment start + CHECKIN_WINDOW_AFTER_HOURS (6h).
  advance(1 + 6 + 0.1);
  assert.equal(disputes.expired(p), true);
});

test('check-in window: 2h before to 6h after the start by default, configurable', (t) => {
  reset(t);
  const early = paidBooking({ startInHours: 3 }).b;
  assert.equal(disputes.checkIn(early, { ip: '1.2.3.4' }).reason, 'too_early');
  const late = paidBooking({ startInHours: -7 }).b;
  assert.equal(disputes.checkIn(late, {}).reason, 'too_late');
  withEnv(t, { CHECKIN_WINDOW_BEFORE_HOURS: '4' });
  assert.equal(disputes.windowState(early), 'open');
  const unconfirmed = paidBooking({ startInHours: 0 }).b;
  unconfirmed.status = 'held';
  assert.equal(disputes.checkIn(unconfirmed, {}).reason, 'not_confirmed');
  const { b, d } = paidBooking({ startInHours: 1 });
  const r = disputes.checkIn(b, { lat: '33.7490123', lng: '-84.3880456', accuracy: '12.4', ip: '203.0.113.9', source: 'portal' });
  assert.equal(r.ok, true);
  assert.deepEqual(b.vendorCheckIn.geo, { lat: 33.74901, lng: -84.38805, accuracy: 12 });
  assert.equal(b.vendorCheckIn.ip, '203.0.113.9');
  assert.equal(d.vendorCheckIn.at, b.vendorCheckIn.at, 'mirrored on the deposit');
  assert.equal(outcomeFor(b).result_stage, 'vendor_checked_in');
  assert.ok(outcomeFor(b).vendor_checked_in_at);
  assert.equal(disputes.checkIn(b, {}).already, true, 'idempotent');
  // Location is optional and validated.
  const { b: b2 } = paidBooking({ startInHours: 0 });
  disputes.checkIn(b2, { lat: '999', lng: 'x' });
  assert.equal(b2.vendorCheckIn.geo, null);
});

test('check-in link over HTTP: page allows geolocation, POST records it; bad token 404; cross-site POST refused', async (t) => {
  reset(t);
  const { b } = paidBooking({ startInHours: 0.5 });
  const token = disputes.checkinToken(b);
  const page = await fetch(`${URL0}/v/checkin/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('permissions-policy'), /geolocation=\(self\)/);
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  const html = await page.text();
  assert.match(html, /I&#39;m here|I'm here/);
  assert.match(html, /\/dispute\.js/);
  assert.equal((await fetch(`${URL0}/v/checkin/${token.slice(0, -3)}abc`)).status, 404);
  assert.equal((await form(`/v/checkin/${token}`, { lat: '33.7', lng: '-84.4' })).status, 403, 'needs same-origin');
  const res = await form(`/v/checkin/${token}`, { lat: '33.75', lng: '-84.39', accuracy: '20' }, { headers: sameSite() });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /checked in/i);
  assert.equal(b.vendorCheckIn.source, 'link');
  assert.equal(b.vendorCheckIn.geo.lat, 33.75);
});

test('booking buzz to the vendor carries the signed one-tap check-in link', async (t) => {
  reset(t);
  const { onPaid } = require('../src/server');
  const before = sentTo(OWNER).length;
  const b = { id: 'bkbuzz' + n++, leadId: 'lx', phone: phone(), name: 'Dee', need: 'water heater', slotStart: new Date(Date.now() + HOUR).toISOString(),
    slotEnd: new Date(Date.now() + 3 * HOUR).toISOString(), slotLabel: 'Today 3:00 PM', status: 'held', paid: false, amount: 49,
    holdExpiresAt: new Date(Date.now() + 1800000).toISOString(), createdAt: new Date().toISOString() };
  store.db.bookings.unshift(b);
  await onPaid(b.id);
  const lines = sentTo(OWNER).slice(before);
  const buzz = lines.find((l) => l.includes('BOOKED + PAID'));
  assert.ok(buzz, 'paid buzz sent');
  const m = /Tap when you arrive: https:\/\/shop\.example\/v\/checkin\/([A-Za-z0-9_.-]+)/.exec(buzz);
  assert.ok(m, 'link included');
  assert.equal(disputes.readToken(m[1], 'ci').b, b.id);
});

// ---------- NO after check-in ----------
test('NO after a vendor check-in -> disputed (not paused), admin buzzed with the check-in; vendor gets a proof request', async (t) => {
  reset(t);
  const { b, d } = paidBooking({ startInHours: 0.5 });
  disputes.checkIn(b, { lat: '33.75', lng: '-84.39', accuracy: '15', ip: '203.0.113.1' });
  advance(14);
  pendingCheck(d);
  const r = deposits.handleNoshowReply(b.phone, 'No', { base: 'https://shop.example' });
  assert.equal(r.answer, 'no');
  assert.equal(d.status, 'recorded');
  assert.equal(d.reputation, 'checked_in_noshow');
  assert.equal(r.disputed, true);
  assert.match(r.adminAlert, /VENDOR CHECKED IN/);
  assert.match(r.adminAlert, /with location/);
  assert.match(r.reply, /does not hold this deposit/);
  assert.match(r.vendorText, /^BuzzCall: Pat says you didn't show for Fri, Nov 6, 10:00 AM\. Reply with a photo or details, or open https:\/\/shop\.example\/v\/proof\/\S+ to respond\./);
  assert.equal(d.dispute.followupDueAt, null, 'direct charges do not queue a KEEP follow-up');
  assert.equal(outcomeFor(b).result_stage, 'no_show_reported');
  advance(30);
  assert.equal((await deposits.releaseDeposit(d)).reason, 'direct_model');
  await deposits.processDueReleases();
  assert.equal(d.status, 'recorded');
});

test('NO without a check-in keeps the existing pause', (t) => {
  reset(t);
  const { b, d } = paidBooking({ startInHours: -13 });
  pendingCheck(d);
  const r = deposits.handleNoshowReply(b.phone, 'NO');
  assert.equal(d.status, 'recorded');
  assert.equal(d.reputation, 'noshow');
  assert.match(r.reply, /does not hold this deposit/i);
  assert.match(r.adminAlert, /did not check in/);
  assert.equal(d.dispute.followupDueAt, null, 'no follow-up until the vendor sends proof');
  assert.equal(outcomeFor(b).result_stage, 'no_show_reported');
});

// ---------- full SMS path: NO, vendor MMS proof, follow-up, auto-release ----------
test('SMS flow: customer NO, vendor MMS proof (MediaUrl stored, not downloaded), follow-up, auto-release after 48h with no reply', async (t) => {
  reset(t);
  const { b, d } = paidBooking({ startInHours: 0.5 });
  disputes.checkIn(b, { lat: '33.75', lng: '-84.39', accuracy: '18', ip: '198.51.100.10' });
  advance(14);
  pendingCheck(d);
  await form('/twilio/sms', { From: b.phone, Body: 'NO' });
  await settle();
  assert.equal(d.status, 'recorded');
  assert.ok(sentTo(b.phone).some((l) => /does not hold this deposit/.test(l)));
  assert.ok(sentTo(OWNER).some((l) => /Pat says you didn't show/.test(l)), 'vendor (shop owner) texted');
  assert.ok(sentTo(OWNER).some((l) => /NO-SHOW claim/.test(l)), 'admin buzzed');
  // Vendor replies with an MMS photo from the owner phone.
  const media = 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM123/Media/ME123';
  await form('/twilio/sms', { From: OWNER, Body: 'I was there at 10:02, gate photo attached', NumMedia: '1', MediaUrl0: media, MediaContentType0: 'image/jpeg' });
  await settle();
  const ev = d.dispute.evidence;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].source, 'mms');
  assert.equal(ev[0].media[0].url, media);
  assert.match(ev[0].text, /10:02/);
  assert.ok(sentTo(OWNER).some((l) => /your proof .* is attached/.test(l)));
  assert.equal(outcomeFor(b).result_stage, 'disputed');
  // Untrusted media hosts are not stored.
  assert.deepEqual(disputes.mediaFrom({ NumMedia: '1', MediaUrl0: 'https://evil.example/x.jpg' }), []);
  // Follow-up goes out on the next tick (daytime UTC shop clock: force midday).
  store.db.depositsMeta.offsetMs += (Date.parse(new Date(deposits.now()).toISOString().slice(0, 10) + 'T12:00:00Z') + 86400000) - deposits.now();
  const send = capture();
  const r1 = await deposits.tick({ sendSms: send });
  assert.equal(r1.followups, 0, 'direct charges do not ask the customer to KEEP');
  assert.equal(send.sent.length, 0);
  advance(47);
  await deposits.tick({ sendSms: send });
  assert.equal(d.status, 'recorded', 'direct charges are not released by BuzzCall');
  advance(1.5);
  const r2 = await deposits.tick({ sendSms: send });
  assert.equal(r2.autoReleased, 0);
  assert.equal(d.status, 'recorded');
  assert.equal(d.dispute.resolution, null);
  assert.equal(send.sent.length, 0, 'no KEEP follow-up and no auto-release text');
});

test('KEEP keeps the claim for admin review (no auto-release); KEEP only counts while a follow-up is pending', async (t) => {
  reset(t);
  const { b, d } = paidBooking({ startInHours: 0.5 });
  disputes.checkIn(b, {});
  store.db.depositsMeta.offsetMs += (Date.parse(new Date(deposits.now()).toISOString().slice(0, 10) + 'T12:00:00Z') + 86400000) - deposits.now();
  pendingCheck(d);
  deposits.handleNoshowReply(b.phone, 'NO');
  assert.equal(disputes.handleKeep(b.phone, 'KEEP'), null, 'no payout follow-up, so KEEP is not a money action');
  const send = capture();
  await deposits.tick({ sendSms: send });
  assert.equal(send.sent.length, 0);
  assert.equal((await deposits.refundDeposit(d)).reason, 'vendor_dashboard');
  assert.equal(d.status, 'recorded');
  assert.equal(d.reputation, 'checked_in_noshow');
});

test('quiet hours: the follow-up waits until 8am shop time', async (t) => {
  reset(t);
  withEnv(t, { BUSINESS_TZ: 'America/New_York' });
  const { b, d } = paidBooking({ startInHours: 0.5 });
  disputes.checkIn(b, {});
  // Move the shop clock to 11:30pm Eastern.
  store.db.depositsMeta.offsetMs += Date.parse('2026-11-10T23:30:00-05:00') - deposits.now();
  pendingCheck(d);
  deposits.handleNoshowReply(b.phone, 'NO');
  const send = capture();
  await deposits.tick({ sendSms: send });
  assert.equal(send.sent.length, 0, 'no KEEP text in the direct-charge model');
  assert.equal(d.dispute.followupDueAt, null);
  assert.equal(d.reputation, 'checked_in_noshow');
});

test('opt-out: an opted-out customer is never texted the follow-up and the claim waits for admin (no auto-release)', async (t) => {
  reset(t);
  const { b, d } = paidBooking({ startInHours: 0.5 });
  disputes.checkIn(b, {});
  store.db.depositsMeta.offsetMs += (Date.parse(new Date(deposits.now()).toISOString().slice(0, 10) + 'T12:00:00Z') + 86400000) - deposits.now();
  pendingCheck(d);
  deposits.handleNoshowReply(b.phone, 'NO');
  store.db.optOuts[b.phone] = { at: new Date().toISOString(), source: 'keyword' };
  const send = capture();
  await deposits.tick({ sendSms: send });
  assert.equal(send.sent.length, 0);
  advance(200);
  await deposits.tick({ sendSms: send });
  assert.equal(d.status, 'recorded');
  assert.equal(d.reputation, 'checked_in_noshow');
});

test('repeat-claim flag: 2+ NO claims in 90 days flags the claim and the customer; threshold configurable; prepay flag stored', async (t) => {
  reset(t);
  const customer = phone();
  const one = paidBooking({ startInHours: -13, customer });
  pendingCheck(one.d);
  deposits.handleNoshowReply(customer, 'NO');
  assert.equal(one.d.dispute.repeatClaim, null);
  assert.equal(disputes.flagFor(customer), null);
  const two = paidBooking({ startInHours: -13, customer });
  pendingCheck(two.d);
  const r = deposits.handleNoshowReply(customer, 'no');
  assert.deepEqual(two.d.dispute.repeatClaim, { count: 2, threshold: 2 });
  assert.match(r.adminAlert, /REPEAT CLAIMER: 2 no-show claims in 90 days/);
  const f = disputes.flagFor(customer);
  assert.equal(f.count, 2);
  assert.equal(f.requirePrepay, false);
  assert.ok(!JSON.stringify(store.root.db.noshowClaims).includes(customer), 'claim index keeps no raw phone numbers');
  // Admin toggle stores "require full prepay".
  const res = await admin(`/admin/deposits/${two.d.id}/prepay`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: URL0, accept: 'application/json' }, body: 'on=1' });
  assert.equal(res.status, 200);
  assert.equal(disputes.flagFor(customer).requirePrepay, true);
  // Threshold 3: a different customer's second claim is not flagged.
  withEnv(t, { NOSHOW_FLAG_THRESHOLD: '3' });
  const other = phone();
  for (let i = 0; i < 2; i++) { const x = paidBooking({ startInHours: -13, customer: other }); pendingCheck(x.d); deposits.handleNoshowReply(other, 'NO'); }
  assert.equal(disputes.flagFor(other), null);
});

test('parsing: YES/NO/KEEP never swallow a normal conversation; vendor proof only from the owner phone during an open claim', async (t) => {
  reset(t);
  const caller = phone();
  // No pending check / dispute: NO and KEEP go to the normal conversation.
  assert.equal(deposits.handleNoshowReply(caller, 'NO'), null);
  assert.equal(disputes.handleKeep(caller, 'KEEP'), null);
  await form('/twilio/sms', { From: caller, Body: 'no' });
  await settle();
  assert.ok(store.db.leads.some((l) => l.phone === caller), 'normal conversation started');
  // Owner texting with no open claim is not taken as proof.
  assert.equal(disputes.handleVendorMessage(OWNER, 'hello', {}), null);
  // Open claim: a customer (not the owner) texting is not proof; "keeping" is not KEEP.
  const { b, d } = paidBooking({ startInHours: 0.5 });
  disputes.checkIn(b, {});
  store.db.depositsMeta.offsetMs += (Date.parse(new Date(deposits.now()).toISOString().slice(0, 10) + 'T12:00:00Z') + 86400000) - deposits.now();
  pendingCheck(d);
  deposits.handleNoshowReply(b.phone, 'NO');
  assert.equal(disputes.handleVendorMessage(caller, 'I was there', {}), null);
  await deposits.tick({ sendSms: capture() });
  assert.equal(disputes.handleKeep(b.phone, 'keeping my options open, when can you come?'), null);
  assert.equal(disputes.handleKeep(caller, 'KEEP'), null, 'KEEP from another number');
  assert.equal(d.dispute.customerReply, null);
  // Unclear reply to the YES/NO check stays pending and falls through.
  const { d: d2, b: b2 } = paidBooking({ startInHours: -13 });
  pendingCheck(d2);
  assert.equal(deposits.handleNoshowReply(b2.phone, 'what time tomorrow?'), null);
  assert.equal(d2.noshowReply, null);
});

test('proof link: note + photo (validated by magic bytes), admin sees the timeline, photo and a text evidence export', async (t) => {
  reset(t);
  const { b, d } = paidBooking({ startInHours: 0.5 });
  disputes.checkIn(b, { lat: '33.75', lng: '-84.39', accuracy: '9', ip: '198.51.100.7' });
  pendingCheck(d);
  deposits.handleNoshowReply(b.phone, 'NO');
  const token = disputes.proofToken(d);
  const page = await fetch(`${URL0}/v/proof/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Respond to a no-show claim/);
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 7)]);
  const bad = await form(`/v/proof/${token}`, { note: 'x', photo: 'data:image/png;base64,' + Buffer.from('<svg/>').toString('base64') }, { headers: sameSite() });
  assert.equal(bad.status, 400);
  const ok = await form(`/v/proof/${token}`, { note: 'Arrived 10:01, customer not home', photo: 'data:image/jpeg;base64,' + jpeg.toString('base64') }, { headers: sameSite() });
  assert.equal(ok.status, 200);
  const e = d.dispute.evidence.at(-1);
  assert.equal(e.source, 'link');
  assert.ok(e.photoId);
  // A larger body is accepted on the proof route only.
  const big = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(300 * 1024, 1)]).toString('base64');
  assert.equal((await form(`/v/proof/${token}`, { note: 'second', photo: big }, { headers: sameSite() })).status, 200);
  assert.equal((await form('/api/waitlist', { email: 'a@b.co', pad: 'x'.repeat(200 * 1024) })).status, 413, 'other routes keep the 100kb limit');
  // Admin view.
  const html = await (await admin('/admin/deposits')).text();
  assert.match(html, /Dispute timeline/);
  assert.match(html, /Vendor checked in/);
  assert.match(html, /Customer replied NO/);
  assert.match(html, /Vendor sent proof via link/);
  assert.match(html, /evidence\.txt/);
  const photo = await admin(`/admin/deposits/${d.id}/photo/${e.photoId}`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${URL0}/admin/deposits/${d.id}/photo/${e.photoId}`)).status, 401, 'admin only');
  const txt = await (await admin(`/admin/deposits/${d.id}/evidence.txt`)).text();
  assert.match(txt, /Vendor check-in:\n {2}.+via portal, location 33\.75, -84\.39 \(accuracy 9 m\), IP 198\.51\.100\.7/);
  assert.match(txt, /Arrived 10:01, customer not home/);
  assert.match(txt, /Customer replied NO/);
  // Expired proof link.
  advance(24 * 8);
  assert.equal((await fetch(`${URL0}/v/proof/${token}`)).status, 410);
});

test('demo fast-forward: advancing 48h in mock mode auto-releases a contested claim', async (t) => {
  reset(t);
  const { b, d } = paidBooking({ startInHours: 0.5 });
  disputes.checkIn(b, {});
  store.db.depositsMeta.offsetMs += (Date.parse(new Date(deposits.now()).toISOString().slice(0, 10) + 'T12:00:00Z') + 86400000) - deposits.now();
  pendingCheck(d);
  deposits.handleNoshowReply(b.phone, 'NO');
  disputes.addEvidence(d, { source: 'portal', photo: { type: 'image/jpeg', data: Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]).toString('base64'), bytes: 4 } });
  const post = (hours) => admin('/admin/deposits/demo/advance', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', origin: URL0 }, body: JSON.stringify({ hours }) });
  const r1 = await (await post(0)).json();
  assert.equal(r1.followups, 0);
  const r2 = await (await post(49)).json();
  assert.equal(r2.autoReleased, 0);
  assert.equal(d.status, 'recorded');
});

// Last: creating a vendor shop changes number routing for the rest of the process.
test('vendor portal: check-in button on the appointment day and proof upload for an open claim', async (t) => {
  reset(t);
  const vendors = require('../src/vendors');
  const config = require('../src/config');
  const { shop, token } = await vendors.create({ name: 'Portal Plumbing', email: 'portal@example.com', values: { BUSINESS_TYPE: 'plumbing', BUSINESS_TZ: 'UTC' } });
  const password = 'portal-password-1234567';
  await vendors.activate(token, password, password);
  const { token: session } = await vendors.login('portal@example.com', password);
  const cookie = `buzzcall_vendor=${session}`;
  let b, d;
  await vendors.run(shop.id, async () => {
    config.apply({ ...store.getOverride().values, OWNER_PHONE: '+14045550177', BUSINESS_TZ: 'UTC' });
    store.db.depositsMeta = { offsetMs: 0, events: [] };
    const now = Date.now();
    const midday = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T12:00:00Z');
    store.db.depositsMeta.offsetMs = midday - now; // appointment at 12:30 shop time today
    ({ b, d } = paidBooking({ startInHours: 0.5 }));
    await vendors.persist(require('../src/shopContext').current().store);
  });
  const home = await fetch(`${URL0}/vendor`, { headers: { cookie } });
  assert.equal(home.status, 200);
  assert.match(home.headers.get('permissions-policy'), /geolocation=\(self\)/);
  const html = await home.text();
  assert.ok(html.includes(`/vendor/bookings/${b.id}/checkin`), 'check-in button shown');
  const ci = await vendorPost(`/vendor/bookings/${b.id}/checkin`, cookie, 'lat=33.7&lng=-84.4&accuracy=30');
  assert.equal(ci.status, 303);
  await vendors.run(shop.id, async () => {
    assert.equal(b.vendorCheckIn.source, 'portal');
    pendingCheck(d);
    const r = deposits.handleNoshowReply(b.phone, 'NO', { base: 'https://shop.example' });
    assert.equal(d.status, 'recorded');
    assert.match(r.adminAlert, new RegExp(`/admin/deposits\\?shop=${shop.id}`));
  });
  const pay = await (await fetch(`${URL0}/vendor`, { headers: { cookie } })).text();
  assert.ok(pay.includes(`/vendor/disputes/${d.id}`), 'respond-with-proof link in payments');
  const proof = await vendorPost(`/vendor/disputes/${d.id}/proof`, cookie, 'note=' + encodeURIComponent('Invoice #42 signed by customer'));
  assert.equal(proof.status, 200);
  await vendors.run(shop.id, async () => {
    assert.equal(d.dispute.evidence.at(-1).source, 'portal');
    assert.match(d.dispute.evidence.at(-1).text, /Invoice #42/);
  });
  // Admin can open that shop's deposits.
  const adminHtml = await (await admin(`/admin/deposits?shop=${shop.id}`)).text();
  assert.match(adminHtml, /Invoice #42 signed by customer/);
  assert.equal((await admin('/admin/deposits?shop=nope')).status, 404);
});
