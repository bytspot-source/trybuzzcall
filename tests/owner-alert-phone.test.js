'use strict';
// Owner/vendor SMS should use a normal US number so phone apps auto-link it, never a tel: URI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-owner-alert-phone-'));
require('dotenv').config = () => ({ parsed: {} });
for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_ACCOUNT_ID',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'OPENAI_API_KEY', 'DATABASE_URL', 'FORWARD_TO_PHONE', 'DEMO_MODE',
  'INSTANT_MISSED_BUZZ', 'OUTCOMES_EMAIL_STEP', 'LEAD_FEE', 'LEAD_FEE_WAIVED', 'KEYWORD_REPLIES', 'RENDER']) {
  delete process.env[key];
}
const OWNER = '+14045550100';
Object.assign(process.env, {
  DATA_DIR: dir, TZ: 'UTC', BUSINESS_TZ: 'UTC', NODE_ENV: 'test', BUSINESS_NAME: 'Stripe Test Plumbing',
  OWNER_PHONE: OWNER, PUBLIC_BASE_URL: 'https://shop.example', TWILIO_PHONE_NUMBER: '+14705550100',
  BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1', DEPOSIT_AMOUNT: '49', HOLD_MINUTES: '30', LEAD_FEE_WAIVED: '1',
  INSTANT_MISSED_BUZZ: '0', BILLING_ENFORCE: '0',
});

const { formatPhone, tapToCall } = require('../src/ui');
const store = require('../src/store');
const { onPaid, onBooked } = require('../src/server');

const smsLog = () => { try { return fs.readFileSync(path.join(dir, 'sms.log'), 'utf8'); } catch { return ''; } };
const sentTo = (p) => smsLog().split('\n').filter((l) => l.includes(`SMS -> ${p}:`)).map((l) => l.replace(/^.*?SMS -> \+[0-9]+:\s*/, ''));
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

function reset(t) {
  const o = console.error, l = console.log;
  console.error = () => {}; console.log = () => {};
  t.after(() => { console.error = o; console.log = l; });
  store.db.bookings.length = 0; store.db.leads.length = 0; store.db.alerts.length = 0;
  store.db.deposits = [];
}

function booking(extra = {}) {
  const start = Date.now() + 3600000;
  return {
    id: 'bk' + Math.random().toString(36).slice(2, 10),
    leadId: 'lead-kay',
    phone: '+17705275396',
    name: 'Kay',
    need: 'Water heater',
    slotStart: new Date(start).toISOString(),
    slotEnd: new Date(start + 2 * 3600000).toISOString(),
    slotLabel: 'Wed, Nov 18 10:00 AM-12:00 PM',
    status: 'held',
    paid: false,
    amount: 49,
    holdExpiresAt: new Date(Date.now() + 1800000).toISOString(),
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

test('formatPhone and tapToCall: US/Canada formatted, other E.164 kept, never a tel: URI', () => {
  assert.equal(formatPhone('+17705275396'), '(770) 527-5396');
  assert.equal(formatPhone('+14045550101'), '(404) 555-0101');
  assert.equal(formatPhone('+442079460123'), '+442079460123');
  assert.equal(formatPhone(''), '');
  assert.equal(formatPhone(null), '');
  assert.equal(tapToCall('+17705275396'), 'Tap to call: (770) 527-5396');
  assert.equal(tapToCall('+442079460123'), 'Tap to call: +442079460123');
  assert.equal(tapToCall(''), '');
  assert.equal(tapToCall(null), '');
  assert.doesNotMatch(tapToCall('+17705275396'), /tel:/i);
  assert.doesNotMatch(tapToCall('+442079460123'), /tel:/i);
});

test('BOOKED + PAID owner buzz uses a formatted number and keeps the check-in https link', async (t) => {
  reset(t);
  const b = booking();
  store.db.bookings.unshift(b);
  store.db.leads.unshift({ id: b.leadId, phone: b.phone, name: b.name, need: b.need, messages: [] });
  const before = sentTo(OWNER).length;
  await onPaid(b.id);
  await settle();
  const lines = sentTo(OWNER).slice(before);
  const buzz = lines.find((l) => l.includes('BOOKED + PAID'));
  assert.ok(buzz, 'paid buzz sent');
  assert.match(buzz, /Tap to call: \(770\) 527-5396/);
  assert.doesNotMatch(buzz, /tel:/i);
  assert.match(buzz, /Tap when you arrive: https:\/\/shop\.example\/v\/checkin\//);
});

test('BOOKED + PAID appointment buzz also uses Tap to call with a formatted number', async (t) => {
  reset(t);
  const b = booking({ service: 'Water heater service', details: 'tankless' });
  store.db.bookings.unshift(b);
  store.db.leads.unshift({ id: b.leadId, phone: b.phone, name: b.name, need: b.need, service: b.service, messages: [] });
  const before = sentTo(OWNER).length;
  await onPaid(b.id);
  await settle();
  const buzz = sentTo(OWNER).slice(before).find((l) => l.includes('BOOKED + PAID'));
  assert.ok(buzz);
  assert.match(buzz, /Tap to call: \(770\) 527-5396/);
  assert.doesNotMatch(buzz, /tel:/i);
  assert.match(buzz, /Tap when you arrive: https:\/\/shop\.example\/v\/checkin\//);
});

test('held-slot owner buzz uses Tap to call with a formatted number', async (t) => {
  reset(t);
  const b = booking();
  const lead = { id: b.leadId, phone: b.phone, name: b.name, need: b.need, messages: [] };
  store.db.bookings.unshift(b);
  store.db.leads.unshift(lead);
  const before = sentTo(OWNER).length;
  await onBooked(lead, b);
  await settle();
  const buzz = sentTo(OWNER).slice(before).find((l) => /slot held|time held|BUZZ/.test(l));
  assert.ok(buzz, 'held-slot buzz sent');
  assert.match(buzz, /Tap to call: \(770\) 527-5396/);
  assert.doesNotMatch(buzz, /tel:/i);
  assert.doesNotMatch(buzz, /Tap when you arrive/, 'check-in link is only added once the booking is confirmed');
});

test('PAID BUT SLOT LOST owner buzz uses Tap to call with a formatted number', async (t) => {
  reset(t);
  const start = Date.now() + 3600000;
  const taken = booking({
    id: 'taken-slot', leadId: 'other', phone: '+14045550999', name: 'Other',
    slotStart: new Date(start).toISOString(), slotEnd: new Date(start + 2 * 3600000).toISOString(),
    status: 'confirmed', paid: true,
  });
  const lost = booking({
    id: 'lost-slot', status: 'held', paid: false,
    slotStart: taken.slotStart, slotEnd: taken.slotEnd,
    holdExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  store.db.bookings.unshift(lost, taken);
  const before = sentTo(OWNER).length;
  await onPaid(lost.id);
  await settle();
  const buzz = sentTo(OWNER).slice(before).find((l) => l.includes('PAID BUT SLOT LOST'));
  assert.ok(buzz, 'conflict buzz sent');
  assert.match(buzz, /Tap to call: \(770\) 527-5396/);
  assert.doesNotMatch(buzz, /tel:/i);
});

test('non-US caller numbers fall back to E.164 without tel:', async (t) => {
  reset(t);
  const b = booking({ phone: '+442079460123' });
  store.db.bookings.unshift(b);
  store.db.leads.unshift({ id: b.leadId, phone: b.phone, name: b.name, need: b.need, messages: [] });
  const before = sentTo(OWNER).length;
  await onPaid(b.id);
  await settle();
  const buzz = sentTo(OWNER).slice(before).find((l) => l.includes('BOOKED + PAID'));
  assert.ok(buzz);
  assert.match(buzz, /Tap to call: \+442079460123/);
  assert.doesNotMatch(buzz, /tel:/i);
});

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
