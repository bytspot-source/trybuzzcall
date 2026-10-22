'use strict';
// Trades catalog + both text flows (appointments / jobs) across trades, and exact backward compat for the
// legacy env (VERTICAL=braiders, BUSINESS_VERTICAL=plumber|hvac). Runs the app's own functions; no SMS is sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-trades-'));
const SHOP_KEYS = ['BUSINESS_TYPE', 'BUSINESS_FLOW', 'BUSINESS_TRADE_LABEL', 'VERTICAL', 'BUSINESS_VERTICAL', 'SERVICES', 'BUSINESS_HOURS', 'BUSINESS_DAYS',
  'BOOKING_ENABLED', 'DEPOSIT_ENABLED', 'DEPOSIT_AMOUNT', 'SLOT_MINUTES', 'BOOKING_LINK', 'LEAD_FEE', 'BUSINESS_CITY', 'OPENAI_API_KEY', 'SLOT_STEP_MINUTES', 'HOLD_MINUTES', 'BOOKING_LEAD_MINUTES'];
Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', BUSINESS_NAME: 'Acme', STRIPE_SECRET_KEY: '', DOTENV_CONFIG_PATH: '/nonexistent' });
const T = require('../src/trades');
const config = require('../src/config');
const booking = require('../src/booking');
const agent = require('../src/agent');
const store = require('../src/store');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function shop(env = {}) {
  config.clear();
  for (const k of SHOP_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  store.db.bookings.length = 0;
}
let n = 0;
async function talk(lines) {
  const lead = store.createLead(`+1404555${String(1000 + n++)}`);
  const out = [{ who: 'shop', body: agent.firstMessage() }];
  let last;
  for (const line of lines) {
    last = await agent.handleReply(lead, line);
    out.push({ who: 'caller', body: line }, { who: 'shop', body: last.reply, booking: last.booking, completed: last.completed });
  }
  return { lead, out, last, replies: out.filter((x) => x.who === 'shop').map((x) => x.body) };
}
const COMPLIANCE = 'Reply STOP to opt out, HELP for help. Msg & data rates may apply.';

test('catalog: required trades, valid flows and complete defaults', () => {
  const need = ['braiders', 'nails', 'lashes_brows', 'barber', 'hair_salon', 'makeup', 'esthetician', 'massage', 'pet_grooming', 'tutoring', 'photography',
    'catering_bakery', 'cleaning', 'plumbing', 'hvac', 'electrical', 'handyman', 'landscaping', 'mobile_detailing', 'other'];
  for (const k of need) assert.ok(T.KEYS.includes(k), k);
  for (const t of T.list()) {
    assert.ok(['appointments', 'jobs'].includes(t.flow), `${t.key} flow`);
    assert.ok(t.label && t.noun, `${t.key} label/noun`);
    assert.match(t.hours, /^\d\d:\d\d-\d\d:\d\d$/, `${t.key} hours`);
    assert.ok(t.days.length && t.days.every((d) => d >= 0 && d <= 6), `${t.key} days`);
    assert.ok(t.deposit >= 10 && t.deposit <= 200, `${t.key} deposit within the setup-form balance range`);
    if (t.flow === 'appointments') {
      assert.ok(t.services.length >= 1 && t.ask && t.serviceWord && t.pro, `${t.key} services/ask`);
      assert.equal(t.urgentRe, null, `${t.key}: no urgent flag for appointments`);
      const [o, c] = t.hours.split('-').map((x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3)));
      for (const s of t.services) assert.ok(s.minutes > 0 && s.minutes <= c - o, `${t.key}: ${s.name} fits the default day`);
    } else {
      assert.ok(t.need && t.urgentRe instanceof RegExp && t.slotMinutes > 0, `${t.key} need/urgent/slot`);
      assert.deepEqual(t.services, []);
    }
  }
  const groups = T.grouped();
  assert.deepEqual(groups.map((g) => g.label), ['Beauty & personal care', 'Home services', 'Other services']);
  assert.equal(groups.reduce((a, g) => a + g.trades.length, 0), T.KEYS.length, 'every trade is in exactly one group');
  assert.equal(T.keyOf('plumber'), 'plumbing');
  assert.equal(T.keyOf('Nail tech'), 'nails');
  assert.equal(T.keyOf('nope'), '');
  assert.equal(T.get('other', { flow: 'jobs', label: 'Pool cleaning' }).flow, 'jobs');
  assert.equal(T.get('other_jobs').flow, 'jobs');
  assert.equal(T.get('other').flow, 'appointments');
  assert.equal(T.get('other', { label: 'Piano lessons' }).label, 'Piano lessons');
});

test('legacy VERTICAL=braiders keeps the exact braider texts and defaults', async () => {
  shop({ VERTICAL: 'braiders', BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1' });
  const c = booking.cfg();
  assert.equal(c.vertical, 'braiders'); assert.equal(c.trade, 'braiders'); assert.equal(c.flow, 'appointments');
  assert.deepEqual([c.open, c.close, c.amount, c.leadFee, c.stepMin], [540, 1140, 50, 5, 60]);
  assert.deepEqual(c.services.map((s) => s.name), ['Knotless braids', 'Box braids', 'Locs retwist', 'Twists']);
  const r = await talk(['hi its Maya', '1 medium mid-back', 'saturday']);
  assert.equal(r.replies[0], `Hi, this is Acme! Sorry I missed your call - I'm probably in the middle of a client's hair. I can get you booked by text. What's your name? ${COMPLIANCE}`);
  assert.equal(r.replies[1], 'Nice to meet you, Maya! Which style are you looking for?\n1) Knotless braids (~6 hrs)\n2) Box braids (~5 hrs)\n3) Locs retwist (~2 hrs)\n4) Twists (~3 hrs)\nReply with the number. If you know the size and length you want (like "medium, mid-back"), add that too.');
  assert.equal(r.replies[2], 'Got it - Knotless braids. What day works best for you? (e.g. "Saturday", "10/24", or "soonest")');
  assert.match(r.replies[3], /^(Here's what I have open|I'm booked up that day, here are the closest openings) for Knotless braids:\n1\) .+\(done ~.+\)\n2\) .+\n3\) .+\nReply 1, 2 or 3 to book, or "call" if you'd rather I call you\.$/);
  assert.equal(r.lead.details, 'medium mid-back');
  shop({ BUSINESS_VERTICAL: 'braiders' });
  assert.equal(booking.cfg().vertical, 'braiders');
  assert.equal(agent.isBraiders(), true);
});

test('legacy BUSINESS_VERTICAL=plumber (and the default) keeps the exact plumbing texts, urgent flag and defaults', async () => {
  for (const env of [{ BUSINESS_VERTICAL: 'plumber' }, {}, { VERTICAL: 'home_services' }]) {
    shop({ ...env, BOOKING_ENABLED: '0' });
    const c = booking.cfg();
    assert.equal(c.vertical, 'home_services'); assert.equal(c.trade, 'plumbing');
    assert.deepEqual([c.open, c.close, c.amount, c.leadFee, c.slotMin], [480, 1020, 49, 12, 120]);
    const r = await talk(['Dana', 'burst pipe in the basement', 'after 3pm']);
    assert.deepEqual(r.replies, [
      `Hi, this is Acme. Sorry we missed your call! We're likely on a job. What's your name? ${COMPLIANCE}`,
      "Thanks Dana! What's going on - leak, clog, water heater, something else? Any active flooding?",
      'Got it. When\'s a good time for a callback today (e.g. "now", "after 3pm")?',
      "Thanks Dana, we'll call you back after 3pm. If water is actively leaking, shut off your main valve.",
    ]);
    assert.equal(r.lead.urgent, true);
  }
});

test('legacy BUSINESS_VERTICAL=hvac keeps the exact HVAC texts; booking offers windows', async () => {
  shop({ BUSINESS_VERTICAL: 'hvac', BOOKING_ENABLED: '0' });
  const r = await talk(['Lee', 'no heat at all', 'now']);
  assert.deepEqual(r.replies, [
    `Hi, this is Acme. Sorry we missed your call! What's your name? ${COMPLIANCE}`,
    "Thanks Lee! What's happening - no cooling, no heat, noise, maintenance? Anyone vulnerable in the home?",
    'Got it. When\'s a good time for a callback (e.g. "now", "after 3pm")?',
    'Thanks Lee, a tech will call you back now. Stay safe!',
  ]);
  assert.equal(r.lead.urgent, true);
  shop({ BUSINESS_VERTICAL: 'hvac', BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '0' });
  const b = await talk(['Lee', 'tune-up', '1']);
  assert.match(b.replies[2], /^Got it\. Next available times:\n1\) .+\n2\) .+\n3\) .+\nReply 1, 2 or 3 to book, or "callback" for a call instead\.$/);
  assert.equal(b.last.booking.status, 'confirmed');
  assert.match(agent.texts.bookedNoDeposit('Lee', b.last.booking), /Acme will text when the tech is on the way\.$/);
});

test('nails (appointments): trade-aware wording, service menu, notes, day and start times, deposit hold', async () => {
  shop({ BUSINESS_TYPE: 'nails', BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1', BUSINESS_CITY: 'Houston, TX' });
  const c = booking.cfg();
  assert.equal(c.trade, 'nails'); assert.equal(c.flow, 'appointments'); assert.equal(c.vertical, 'appointments');
  assert.equal(c.amount, 20); assert.equal(c.stepMin, 30); assert.equal(c.leadFee, 5);
  const r = await talk(["hey it's Tasha", '2 almond, medium', 'friday', '1']);
  assert.match(r.replies[0], /^Hi, this is Acme! Sorry I missed your call - I'm probably with a client\. I can get you booked by text\. What's your name\? /);
  assert.ok(r.replies[0].endsWith(COMPLIANCE));
  assert.match(r.replies[1], /^Nice to meet you, Tasha! Which service are you looking for\?\n1\) Gel manicure \(~1 hr\)\n2\) Acrylic full set \(~1\.5 hrs\)/);
  assert.match(r.replies[1], /almond, medium, french tip/);
  assert.equal(r.replies[2], 'Got it - Acrylic full set. What day works best for you? (e.g. "Saturday", "10/24", or "soonest")');
  assert.match(r.replies[3], /for Acrylic full set:\n1\) .+\(done ~/);
  assert.equal(r.lead.service, 'Acrylic full set');
  assert.equal(r.lead.details, 'almond, medium');
  assert.equal(r.lead.urgent, false);
  const b = r.last.booking;
  assert.equal(b.status, 'held'); assert.equal(b.amount, 20); assert.equal(b.service, 'Acrylic full set');
  assert.match(agent.texts.held('Tasha', b, 30, 'URL'), /^Thanks Tasha! I'm holding Acrylic full set, .+ A \$20 deposit \(goes toward your service\) locks it in: URL$/);
  assert.match(agent.systemPrompt(), /a nail tech in Houston, TX, writing as the nail tech \("I"\)/);
  assert.match(agent.systemPrompt(), /No prices, no urgency, no promises\./);
  const bad = await talk(['Tasha', 'something fancy']);
  assert.match(bad.replies[2], /^Sorry, which service\? Reply with a number:\n1\) Gel manicure/);
});

test('pet grooming mentions the pet; barber and tutor wording; appointments never flag urgent', async () => {
  shop({ BUSINESS_TYPE: 'pet_grooming', BOOKING_ENABLED: '1' });
  const p = await talk(['Sam', 'full groom - Max, doodle, 40 lbs emergency', 'call', 'tomorrow morning']);
  assert.match(p.replies[0], /I'm probably mid-groom with a furry client/);
  assert.match(p.replies[1], /What does your pet need\?/);
  assert.match(p.replies[1], /your pet's name, breed and size/);
  assert.equal(p.replies[2], 'Got it - Full groom. What day works best for you and your pet? (e.g. "Saturday", "10/24", or "soonest")');
  assert.match(p.replies[3], /When's a good time for me to call you back/);
  assert.equal(p.replies[4], "Thanks Sam! I'll call you back tomorrow morning.");
  assert.equal(p.lead.urgent, false, 'urgent words only matter for the jobs flow');
  assert.match(p.lead.need, /^Full groom \(.*Max, doodle, 40 lbs/);
  shop({ BUSINESS_TYPE: 'barber' });
  assert.match(agent.firstMessage(), /I've probably got someone in the chair/);
  shop({ BUSINESS_TYPE: 'tutoring' });
  assert.match(agent.firstMessage(), /in a session with a student/);
  assert.deepEqual(booking.cfg().days, [1, 2, 3, 4, 5]);
});

test('handyman (jobs): describe the need, urgent words, next windows, deposit, crew wording', async () => {
  shop({ BUSINESS_TYPE: 'handyman', BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '1' });
  const c = booking.cfg();
  assert.equal(c.flow, 'jobs'); assert.equal(c.vertical, 'home_services'); assert.equal(c.amount, 40); assert.equal(c.leadFee, 12);
  assert.deepEqual(c.services, []);
  const r = await talk(['Chris', 'mount a TV and fix a broken door', '2']);
  assert.equal(r.replies[0], `Hi, this is Acme. Sorry we missed your call! We're likely on a job. What's your name? ${COMPLIANCE}`);
  assert.equal(r.replies[1], 'Thanks Chris! What can we help with - repairs, mounting, assembly, drywall, something else? A quick description helps us plan.');
  assert.match(r.replies[2], /^Got it\. Next available times:\n1\) .+ \d+:\d\d (AM|PM)-\d+:\d\d (AM|PM)\n/);
  assert.equal(r.lead.urgent, true, 'broken door is urgent for a handyman');
  assert.equal(r.last.booking.amount, 40);
  assert.match(agent.texts.paid({ ...r.last.booking, name: 'Chris' }), /Acme will text when your handyman is on the way\.$/);
  assert.equal(agent.isUrgent("back door won't lock"), true);
  const cb = await talk(['Chris', 'shelves', 'callback', 'after 5']);
  assert.equal(cb.lead.urgent, false);
  assert.equal(cb.replies[4], "Thanks Chris, we'll call you back after 5.");
  assert.match(agent.systemPrompt(), /a local handyman business/);
  assert.match(agent.systemPrompt(), /No prices, no promises of arrival times\./);
});

test('urgent words are trade-specific for jobs (electrical sparks, plumbing floods)', async () => {
  shop({ BUSINESS_TYPE: 'electrical' });
  assert.equal(agent.isUrgent('outlet is sparking'), true);
  assert.equal(agent.isUrgent('need a new light fixture'), false);
  shop({ BUSINESS_TYPE: 'plumbing' });
  assert.equal(agent.isUrgent('basement flooding'), true);
  shop({ BUSINESS_TYPE: 'cleaning' });
  assert.equal(agent.isUrgent('regular clean, 3 bed 2 bath'), false);
});

test('BUSINESS_TYPE=other honors BUSINESS_FLOW and BUSINESS_TRADE_LABEL', async () => {
  shop({ BUSINESS_TYPE: 'other', BUSINESS_FLOW: 'jobs', BUSINESS_TRADE_LABEL: 'Pool cleaning', BOOKING_ENABLED: '0' });
  assert.equal(booking.cfg().flow, 'jobs');
  const r = await talk(['Ana', 'green pool', 'tomorrow']);
  assert.match(r.replies[0], /^Hi, this is Acme\. Sorry we missed your call!/);
  assert.match(r.replies[1], /What do you need help with\?/);
  assert.match(agent.systemPrompt(), /a local Pool cleaning business/);
  shop({ BUSINESS_TYPE: 'other', BUSINESS_FLOW: 'appointments', BUSINESS_TRADE_LABEL: 'Piano lessons', SERVICES: '30-min lesson:30,60-min lesson:60' });
  assert.equal(booking.cfg().flow, 'appointments');
  const a = await talk(['Ben', '2']);
  assert.match(a.replies[1], /1\) 30-min lesson/);
  assert.equal(a.lead.service, '60-min lesson');
  assert.match(agent.systemPrompt(), /a Piano lessons/);
});

test('BUSINESS_TYPE wins over legacy env; a pre-trades override ignores an env BUSINESS_TYPE', () => {
  shop({ BUSINESS_TYPE: 'nails', VERTICAL: 'braiders', BUSINESS_VERTICAL: 'hvac' });
  assert.equal(booking.cfg().trade, 'nails');
  config.apply({ VERTICAL: 'braiders', BUSINESS_NAME: 'Old Override Braids' });
  assert.equal(booking.cfg().trade, 'braiders', 'old override (VERTICAL only) keeps meaning braiders');
  config.apply({ BUSINESS_TYPE: 'barber', VERTICAL: 'appointments' });
  assert.equal(booking.cfg().trade, 'barber');
  config.clear();
});

test('every trade produces a first text with the business name and the STOP/HELP/rates line', () => {
  for (const key of T.KEYS) {
    shop({ BUSINESS_TYPE: key });
    const first = agent.firstMessage();
    assert.ok(first.startsWith('Hi, this is Acme'), key);
    assert.ok(first.endsWith(COMPLIANCE), `${key}: ${first}`);
    assert.ok(first.length <= 320, `${key}: first text stays short (${first.length})`);
    assert.doesNotMatch(first, /undefined|null|\.\./, key);
  }
});
