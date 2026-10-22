'use strict';
// Balance checks for the shop setup form (src/setupRules.js, shared with the browser).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/setupRules');

const BRAIDER = Object.freeze({
  businessName: 'Crown Braids', city: 'Atlanta, GA', vertical: 'braiders',
  ownerPhone: '(404) 555-0100', forwardPhone: '404-555-0111', ringSeconds: '20',
  days: ['1', '2', '3', '4', '5', '6'], open: '09:00', close: '19:00', tz: 'America/New_York',
  services: [{ row: 0, name: 'Knotless braids', hours: '6', minutes: '0' }, { row: 1, name: 'Twists', hours: '3', minutes: '0' }],
  booking: 'times', leadMinutes: '60', deposit: true, depositAmount: '50', holdMinutes: '30',
  bookingLink: '', email: 'owner@crown.example', consent: true,
});
const HOME = Object.freeze({ ...BRAIDER, vertical: 'plumber', services: [], slotMinutes: '120', open: '08:00', close: '17:00', days: ['1', '2', '3', '4', '5'] });

const issues = (base, patch = {}) => R.validate({ ...base, ...patch }).issues;
function has(list, field, level, re) {
  const hit = list.find((i) => i.field === field && i.level === level && (!re || re.test(i.message)));
  assert.ok(hit, `expected ${level} on ${field}${re ? ` matching ${re}` : ''}; got ${JSON.stringify(list)}`);
  assert.ok(hit.message.length > 10 && !/undefined|NaN|null/.test(hit.message), `plain message: ${hit.message}`);
}
const none = (list, field) => assert.ok(!list.some((i) => i.field === field), `no issue on ${field}: ${JSON.stringify(list)}`);

test('valid braider and home-service setups pass with no issues', () => {
  assert.deepEqual(issues(BRAIDER), []);
  assert.deepEqual(issues(HOME), []);
  assert.deepEqual(issues({ ...HOME, vertical: 'hvac' }), []);
});

test('every issue has field, level error|warning and a message', () => {
  for (const i of issues({})) {
    assert.equal(typeof i.field, 'string');
    assert.ok(['error', 'warning'].includes(i.level));
    assert.equal(typeof i.message, 'string');
  }
});

test('missing required fields are errors', () => {
  const list = issues({});
  for (const f of ['businessName', 'city', 'vertical', 'ownerPhone', 'days', 'open', 'close', 'tz', 'email', 'consent']) has(list, f, 'error');
  has(issues(BRAIDER, { businessName: '   ' }), 'businessName', 'error');
});

test('phones must be valid 10-digit US numbers', () => {
  for (const bad of ['404555010', '40455501000', '(404) 555-01OO', '123-555-0100', '+44 20 7946 0958']) {
    has(issues(BRAIDER, { ownerPhone: bad }), 'ownerPhone', 'error', /10-digit US/);
    has(issues(BRAIDER, { forwardPhone: bad }), 'forwardPhone', 'error', /10-digit US/);
  }
  for (const good of ['4045550100', '+1 404 555 0100', '1-404-555-0100', '(404) 555.0100']) none(issues(BRAIDER, { ownerPhone: good }), 'ownerPhone');
  assert.equal(R.phoneE164('(404) 555-0100'), '+14045550100');
});

test('alert cell same as ring-first phone is a warning', () => {
  has(issues(BRAIDER, { forwardPhone: '+1 (404) 555-0100' }), 'forwardPhone', 'warning', /both the call and the buzz/);
});

test('no ring-first phone is a warning (every call goes to text)', () => {
  has(issues(BRAIDER, { forwardPhone: '' }), 'forwardPhone', 'warning', /never rings/);
});

test('ring seconds under 10 or over 40 warn; non-number errors', () => {
  has(issues(BRAIDER, { ringSeconds: '8' }), 'ringSeconds', 'warning', /8 seconds/);
  has(issues(BRAIDER, { ringSeconds: '45' }), 'ringSeconds', 'warning', /45 seconds/);
  has(issues(BRAIDER, { ringSeconds: 'abc' }), 'ringSeconds', 'error');
  for (const ok of ['10', '20', '40', '']) none(issues(BRAIDER, { ringSeconds: ok }), 'ringSeconds');
});

test('no open days is an error', () => {
  has(issues(BRAIDER, { days: [] }), 'days', 'error', /at least one day/);
  has(issues(BRAIDER, { days: ['9', 'x'] }), 'days', 'error');
});

test('close time before or equal to open time is an error', () => {
  has(issues(BRAIDER, { open: '18:00', close: '09:00' }), 'close', 'error', /after your opening/);
  has(issues(BRAIDER, { open: '09:00', close: '09:00' }), 'close', 'error', /after your opening/);
  has(issues(BRAIDER, { open: '9am' }), 'open', 'error');
});

test('open under 2 or over 16 hours a day warns', () => {
  has(issues(HOME, { open: '09:00', close: '10:30', slotMinutes: '60' }), 'close', 'warning', /only 1 hr 30 min/);
  has(issues(HOME, { open: '05:00', close: '22:00' }), 'close', 'warning', /17 hrs/);
  none(issues(HOME, { open: '06:00', close: '22:00' }), 'close');
});

test('time zone must be one of the US zones', () => {
  has(issues(BRAIDER, { tz: 'Europe/London' }), 'tz', 'error');
  for (const [tz] of R.US_TIMEZONES) none(issues(BRAIDER, { tz }), 'tz');
});

test('braider with no services is an error; home services do not need them', () => {
  has(issues(BRAIDER, { services: [] }), 'services', 'error', /at least one style/);
  has(issues(BRAIDER, { services: [{ name: '', hours: '', minutes: '0' }] }), 'services', 'error');
  none(issues(HOME, { services: [] }), 'services');
});

test('service duration: 0 or over 12 hours is an error, over 9 hours warns', () => {
  const svc = (hours, minutes = '0') => ({ services: [{ row: 0, name: 'Knotless', hours, minutes }], close: '23:30', open: '07:00' });
  has(issues(BRAIDER, svc('0')), 'services.0.duration', 'error', /How long/);
  has(issues(BRAIDER, svc('12', '15')), 'services.0.duration', 'error', /over 12 hours/);
  has(issues(BRAIDER, svc('9', '30')), 'services.0.duration', 'warning', /over 9 hours/);
  none(issues(BRAIDER, svc('9')), 'services.0.duration');
});

test('a service longer than the daily open hours can never be booked (error)', () => {
  has(issues(BRAIDER, { open: '10:00', close: '15:00' }), 'services.0.duration', 'error', /never be booked/);
});

test('a service row with a duration but no name is an error; duplicate names warn', () => {
  has(issues(BRAIDER, { services: [{ row: 3, name: '', hours: '2', minutes: '0' }] }), 'services.3.name', 'error');
  has(issues(BRAIDER, { services: [{ name: 'Twists', hours: '2' }, { name: 'twists', hours: '3' }] }), 'services.1.name', 'warning', /twice/);
});

test('home services: appointment window longer than open hours is an error', () => {
  has(issues(HOME, { open: '09:00', close: '12:00', slotMinutes: '240' }), 'slotMinutes', 'error', /no times can be offered/);
  has(issues(HOME, { slotMinutes: '' }), 'slotMinutes', 'error');
  none(issues(HOME, { booking: 'callback', slotMinutes: '' }), 'slotMinutes');
});

test('deposit on: missing or <= 0 amount errors; > $200 or < $10 warns', () => {
  for (const bad of ['', '0', '-5', 'abc']) has(issues(BRAIDER, { depositAmount: bad }), 'depositAmount', 'error', /deposit amount/);
  has(issues(BRAIDER, { depositAmount: '250' }), 'depositAmount', 'warning', /\$250 deposit is high/);
  has(issues(BRAIDER, { depositAmount: '5' }), 'depositAmount', 'warning', /\$5 deposit is very small/);
  for (const ok of ['10', '50', '200']) none(issues(BRAIDER, { depositAmount: ok }), 'depositAmount');
  none(issues(BRAIDER, { deposit: false, depositAmount: '' }), 'depositAmount');
});

test('deposit on but booking off warns (deposits only apply to booked times)', () => {
  has(issues(BRAIDER, { booking: 'callback' }), 'deposit', 'warning', /only apply to booked times/);
  none(issues(BRAIDER, { booking: 'callback', deposit: false }), 'deposit');
});

test('hold minutes under 5 or over 60 warn', () => {
  has(issues(BRAIDER, { holdMinutes: '3' }), 'holdMinutes', 'warning', /only 3 minutes/);
  has(issues(BRAIDER, { holdMinutes: '90' }), 'holdMinutes', 'warning', /90 minutes/);
  has(issues(BRAIDER, { holdMinutes: '' }), 'holdMinutes', 'error');
  for (const ok of ['5', '30', '60']) none(issues(BRAIDER, { holdMinutes: ok }), 'holdMinutes');
});

test('booking link must be an https URL', () => {
  for (const bad of ['booksy.com/crown', 'http://booksy.com/crown', 'https://', 'https://localhost/x', 'javascript:alert(1)']) {
    has(issues(BRAIDER, { bookingLink: bad }), 'bookingLink', 'error', /https:\/\//);
  }
  none(issues(BRAIDER, { bookingLink: 'https://booksy.com/en-us/123_crown-braids' }), 'bookingLink');
});

test('city without a state warns', () => {
  has(issues(BRAIDER, { city: 'Atlanta' }), 'city', 'warning', /state/);
  for (const ok of ['Atlanta, GA', 'Atlanta GA', 'Atlanta, Georgia', 'Kansas City, MO 64105', 'Washington, DC']) none(issues(BRAIDER, { city: ok }), 'city');
});

test('email and consent: invalid email errors, unchecked consent errors', () => {
  has(issues(BRAIDER, { email: 'crown@' }), 'email', 'error');
  has(issues(BRAIDER, { consent: false }), 'consent', 'error', /Terms/);
  has(issues(BRAIDER, { consent: '' }), 'consent', 'error');
});

test('normalize accepts form-encoded arrays and is idempotent', () => {
  const form = { ...BRAIDER, services: undefined, service_name: ['Knotless braids', 'Twists', ''], service_hours: ['6', '3', ''], service_minutes: ['0', '30', '0'], days: '1,3', consent: 'on', deposit: 'on' };
  const v = R.normalize(form);
  assert.deepEqual(v.services, [{ name: 'Knotless braids', minutes: 360, row: 0 }, { name: 'Twists', minutes: 210, row: 1 }]);
  assert.deepEqual(v.days, [1, 3]);
  assert.equal(v.ownerPhone, '+14045550100');
  assert.deepEqual(R.normalize(v).services, v.services);
  assert.deepEqual(R.validate(v).issues, R.validate(form).issues);
});

test('toEnv maps values onto the env keys booking.js reads', () => {
  const e = R.toEnv({ ...BRAIDER, services: [{ name: 'Box, small', hours: '5' }], bookingLink: 'https://styleseat.com/x' });
  assert.equal(e.VERTICAL, 'braiders');
  assert.equal(e.OWNER_PHONE, '+14045550100');
  assert.equal(e.FORWARD_TO_PHONE, '+14045550111');
  assert.equal(e.BUSINESS_HOURS, '09:00-19:00');
  assert.equal(e.BUSINESS_DAYS, '1,2,3,4,5,6');
  assert.equal(e.SERVICES, 'Box / small:300');
  assert.equal(e.BOOKING_ENABLED, '1');
  assert.equal(e.DEPOSIT_ENABLED, '1');
  assert.equal(e.BOOKING_LINK, 'https://styleseat.com/x');
  const h = R.toEnv({ ...HOME, vertical: 'hvac', booking: 'callback', deposit: false });
  assert.equal(h.VERTICAL, 'home_services');
  assert.equal(h.BUSINESS_VERTICAL, 'hvac');
  assert.equal(h.SLOT_MINUTES, '120');
  assert.equal(h.BOOKING_ENABLED, '0');
  assert.equal(h.DEPOSIT_ENABLED, '0');
  assert.equal(h.SERVICES, undefined);
});
