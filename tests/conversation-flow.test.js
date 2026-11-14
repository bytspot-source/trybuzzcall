'use strict';
// Real state machine and booking logic, with a fixed clock and an isolated, log-only HTTP server.
// Run with: node --test tests/conversation-flow.test.js tests/trades.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-conversation-'));
// Never load developer/provider credentials, even from a configured checkout.
require('dotenv').config = () => ({ parsed: {} });
for (const key of Object.keys(process.env)) {
  if (/^(TWILIO_|STRIPE_|OPENAI_|RESEND_|DATABASE_|BUSINESS_|BILLING_|AUTO_|OUTBOUND_|INSTANT_MISSED_BUZZ|VOICE_|OUTCOMES_|BOOKING_|DEPOSIT_|SLOT_|HOLD_|LEAD_)/.test(key)
    || ['RENDER', 'SPILL_DIR', 'REQUIRE_POSTGRES', 'VERTICAL', 'SERVICES', 'BOOKING_LINK', 'FORWARD_TO_PHONE',
      'HELP_MESSAGE', 'INACTIVE_MESSAGE', 'INACTIVE_MODE', 'CLIENT_IP_HEADER', 'ADMIN_PASSWORD', 'ADMIN_USERNAME'].includes(key)) delete process.env[key];
}
const SHOP = 'Peach State Services', OWNER = '+14045550100', LINE = '+14705550100';
const NOW = new Date('2030-01-07T08:00:00.000Z'); // Monday before opening; no wall-clock slot assumptions.
Object.assign(process.env, {
  DATA_DIR: dir, NODE_ENV: 'test', TZ: 'UTC', BUSINESS_TZ: 'UTC', BUSINESS_NAME: SHOP,
  OWNER_PHONE: OWNER, TWILIO_PHONE_NUMBER: LINE, PUBLIC_BASE_URL: 'https://shop.example',
  BOOKING_ENABLED: '0', DEPOSIT_ENABLED: '1', BILLING_ENFORCE: '0', TEXTBACK_COOLDOWN_MINUTES: '0',
  KEYWORD_REPLIES: 'app', INSTANT_MISSED_BUZZ: '1', INSTANT_MISSED_BUZZ_FALLBACK_SECONDS: '3600',
});
const config = require('../src/config');
const store = require('../src/store');
const agent = require('../src/agent');
const booking = require('../src/booking');
const { app } = require('../src/server');
const emptyDb = structuredClone(store.db);
let server, base, sequence = 0;

function shop(trade = 'plumbing', overrides = {}) {
  config.apply({
    BUSINESS_NAME: SHOP, BUSINESS_TYPE: trade, BUSINESS_TZ: 'UTC', OWNER_PHONE: OWNER,
    BUSINESS_DAYS: '0,1,2,3,4,5,6', BUSINESS_HOURS: '09:00-19:00', BOOKING_ENABLED: '0',
    DEPOSIT_ENABLED: '1', DEPOSIT_AMOUNT: '20', HOLD_MINUTES: '30', BOOKING_LEAD_MINUTES: '60',
    ...overrides,
  });
}
const phone = () => `+1404555${String(2000 + sequence++)}`;
const callSid = () => `CA${String(sequence++).padStart(32, '0')}`;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  app.locals.resetInstantBuzz();
  for (const key of Object.keys(store.db)) delete store.db[key];
  Object.assign(store.db, structuredClone(emptyDb));
  shop();
  store.save();
  fs.writeFileSync(path.join(dir, 'sms.log'), '', { mode: 0o600 });
});
test.after(async () => {
  app.locals.resetInstantBuzz();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function conversation() {
  const lead = store.createLead(phone());
  const turns = [{ reply: agent.firstMessage(lead), step: lead.step }];
  return {
    lead, turns,
    async send(text, step) {
      const result = await agent.handleReply(lead, text);
      turns.push({ text, ...result, step: lead.step });
      assert.equal(lead.step, step, JSON.stringify(turns));
      return result;
    },
  };
}
function unfinished(result) {
  assert.equal(result.completed, undefined, 'this turn must not buzz the owner');
  assert.equal(result.booking, undefined, 'this turn must not create a booking');
}
function callbackSummary(reply, lead) {
  assert.ok(reply.includes(SHOP), 'callback summary identifies the shop');
  if (lead.need) assert.ok(reply.includes(lead.need), 'callback summary retains the request');
  assert.ok(reply.includes(`Preferred time: ${lead.window}`), 'the window is a preference, not a promise');
  assert.match(reply, /request is saved/i);
  assert.match(reply, /business will need to confirm timing/i);
  assert.match(reply, /not a booked appointment/i);
  assert.doesNotMatch(reply, /(?:I|we|a tech|the business)(?:'ll| will) call|you(?:'re| are) (?:booked|confirmed)/i);
  assert.doesNotMatch(reply, /undefined|null|Thanks (?:Caller|Friend|Customer)/i);
}
function resumes(lead, question) {
  const before = structuredClone(lead);
  const reply = agent.firstMessage(lead);
  assert.ok(reply.startsWith(`${SHOP}:`));
  assert.match(reply, question);
  assert.doesNotMatch(reply, /what(?:'s| is) your name|what name should/i);
  assert.deepEqual(lead, before, 'resuming must not reset data, retries or offered slots');
  return reply;
}

for (const trade of ['plumbing', 'nails']) {
  test(`${trade}: missing name gets one clarification, then skip or a second invalid reply continues unnamed`, async () => {
    shop(trade);
    for (const second of ['skip', 'can you help?']) {
      const c = conversation();
      assert.match(c.turns[0].reply, /What's your name\?/);
      const clarification = await c.send('hi', 'name');
      unfinished(clarification);
      assert.match(clarification.reply, /what name.*first name.*skip/i);
      assert.equal(c.lead.name, null);
      const next = await c.send(second, 'need');
      unfinished(next);
      assert.equal(c.lead.name, null, 'do not invent a name from a greeting, request or skip');
      assert.equal(c.lead.nameSkipped, true);
      assert.match(next.reply, trade === 'nails' ? /Which service.*\?\n1\)/ : /What's going on/);
      assert.doesNotMatch(next.reply, /what name|your name|Nice to meet you|Thanks (?:hi|skip|Caller|Friend)/i);
    }
  });
}

test('acknowledgements at the name step cannot become fake customer names', async () => {
  for (const text of ['thanks', 'okay', 'great', 'perfect', 'sounds good', 'got it', 'yes', 'no']) {
    const c = conversation();
    assert.equal(agent.isAcknowledgement(text), true);
    unfinished(await c.send(text, 'name'));
    assert.equal(c.lead.name, null, text);
    unfinished(await c.send(text, 'need'));
    assert.equal(c.lead.name, null, text);
    assert.equal(c.lead.nameSkipped, true);
    assert.equal(c.lead.need, null, 'an acknowledgement is not a service request');
  }
});

test('an explicit anonymous-name skip does not save Anonymous as a customer name', async () => {
  const c = conversation();
  await c.send('hi', 'name');
  const next = await c.send('anonymous', 'need');
  unfinished(next);
  assert.equal(c.lead.nameSkipped, true);
  assert.equal(c.lead.name, null);
  assert.doesNotMatch(next.reply, /Thanks anonymous/i);
});

test('a job supplied before the name survives clarification and is not requested again', async () => {
  const need = 'I need a water heater repair';
  for (const answer of ['Dana', 'skip', 'can you help?']) {
    const c = conversation();
    const first = await c.send(need, 'name');
    assert.match(first.reply, /Got your request.*what name/i);
    assert.equal(c.lead.need, need);
    assert.equal(c.lead.name, null);
    const next = await c.send(answer, 'window');
    unfinished(next);
    assert.equal(c.lead.need, need);
    assert.equal(c.lead.name, answer === 'Dana' ? 'Dana' : null);
    assert.match(next.reply, /good time for a callback/i);
    assert.doesNotMatch(next.reply, /What's going on|what.*need|your name/i);
  }
});

test('an explicitly named appointment service and notes survive the missing-name question', async () => {
  shop('nails', { BOOKING_ENABLED: '1' });
  for (const answer of ['Maya', 'skip', 'can you help?']) {
    const c = conversation();
    await c.send('Acrylic full set, almond, medium', 'name');
    assert.equal(c.lead.name, null);
    assert.equal(c.lead.service, 'Acrylic full set');
    assert.equal(c.lead.serviceMinutes, 90);
    assert.equal(c.lead.details, 'almond, medium');
    const next = await c.send(answer, 'day');
    unfinished(next);
    assert.equal(c.lead.need, 'Acrylic full set (almond, medium)');
    assert.equal(c.lead.name, answer === 'Maya' ? 'Maya' : null);
    assert.match(next.reply, /Acrylic full set.*What day works best/);
    assert.doesNotMatch(next.reply, /Which service|Reply with the number|your name/i);
  }
});

for (const { trade, text, need, step } of [
  { trade: 'plumbing', text: "I'm Dana, I need a water heater repair", need: 'I need a water heater repair', step: 'window' },
  { trade: 'plumbing', text: "I need a water heater repair, I'm Dana", need: 'I need a water heater repair', step: 'window' },
  { trade: 'nails', text: "I'm Dana, Acrylic full set, almond, medium", need: 'Acrylic full set (almond, medium)', step: 'day' },
]) {
  test(`${trade}: explicit name and need in one text are retained (${text})`, async () => {
    shop(trade, { BOOKING_ENABLED: trade === 'nails' ? '1' : '0' });
    const c = conversation();
    const result = await c.send(text, step);
    unfinished(result);
    assert.equal(c.lead.name, 'Dana');
    assert.equal(c.lead.need, need);
    assert.doesNotMatch(result.reply, /your name|Which service|What's going on/i);
    if (trade === 'nails') {
      assert.equal(c.lead.service, 'Acrylic full set');
      assert.equal(c.lead.details, 'almond, medium');
    }
  });
}

for (const step of ['need', 'day', 'slot']) {
  test(`invalid appointment ${step} answers get one recovery prompt, then a callback instead of a loop`, async () => {
    shop('nails', { BOOKING_ENABLED: '1' });
    const c = conversation();
    await c.send('Maya', 'need');
    if (step !== 'need') await c.send('2 almond, medium', 'day');
    if (step === 'slot') await c.send('soonest', 'slot');
    const invalid = { need: 'something fancy', day: 'whenever works for you', slot: 'not 1' }[step];
    const first = await c.send(invalid, step);
    unfinished(first);
    assert.match(first.reply, { need: /Sorry, which service.*\n1\)/, day: /What day.*Saturday/, slot: /listed number/ }[step]);
    assert.equal(c.lead.retries[step], 1);
    const second = await c.send(invalid, 'window');
    unfinished(second);
    assert.match(second.reply, /callback instead/i);
    assert.equal(c.lead.retries[step], 2);
    assert.equal(store.db.bookings.length, 0);
    const done = await c.send('tomorrow after 4pm', 'done');
    assert.equal(done.completed, true);
    assert.equal(c.lead.status, 'done');
    callbackSummary(done.reply, c.lead);
  });
}

test('valid service/day answers after clarification recover without repeating intake or forcing a callback', async () => {
  shop('nails', { BOOKING_ENABLED: '1' });
  const c = conversation();
  await c.send('Maya', 'need');
  unfinished(await c.send('something fancy', 'need'));
  unfinished(await c.send('2 almond, medium', 'day'));
  assert.equal(c.lead.service, 'Acrylic full set');
  assert.equal(c.lead.details, 'almond, medium');
  unfinished(await c.send('whenever works for you', 'day'));
  unfinished(await c.send('tomorrow', 'slot'));
  assert.equal(c.lead.prefDay, '2030-01-08T00:00:00.000Z');
  assert.equal(c.lead.offered[0].start, '2030-01-08T09:00:00.000Z');
  assert.deepEqual(c.lead.retries, { need: 1, day: 1 }, 'retry budgets are per question');
  assert.equal(c.lead.name, 'Maya');
  assert.equal(store.db.bookings.length, 0, 'a valid day still requires an explicit slot selection');
});

for (const trade of ['plumbing', 'nails']) {
  test(`${trade}: times, prices, negations, dates and questions never select a numbered booking`, async () => {
    shop(trade, { BOOKING_ENABLED: '1' });
    for (const invalid of ['1pm', '$20', 'not 1', '1/2', 'is 1 available?', '+14045550111', '1 and 2', '4']) {
      const c = conversation();
      await c.send('Dana', 'need');
      await c.send(trade === 'nails' ? '2 almond, medium' : 'water heater repair', trade === 'nails' ? 'day' : 'slot');
      if (trade === 'nails') await c.send('soonest', 'slot');
      const offered = structuredClone(c.lead.offered);
      const first = await c.send(invalid, 'slot');
      unfinished(first);
      assert.match(first.reply, /listed number/);
      assert.deepEqual(c.lead.offered, offered, 'invalid input does not silently change the choices');
      unfinished(await c.send(invalid, 'window'));
      assert.equal(c.lead.bookingId, undefined, invalid);
      assert.equal(store.db.bookings.length, 0, invalid);
    }
  });

  test(`${trade}: a valid slot choice after recovery creates a deposit hold, not a confirmed booking`, async () => {
    shop(trade, { BOOKING_ENABLED: '1' });
    const c = conversation();
    await c.send('Dana', 'need');
    await c.send(trade === 'nails' ? '2 almond, medium' : 'water heater repair', trade === 'nails' ? 'day' : 'slot');
    if (trade === 'nails') await c.send('tomorrow', 'slot');
    assert.equal(c.lead.offered.length, 3);
    assert.equal(c.lead.offered[0].start, trade === 'nails' ? '2030-01-08T09:00:00.000Z' : '2030-01-07T09:00:00.000Z');
    unfinished(await c.send('1pm', 'slot'));
    const selected = c.lead.offered[1];
    const done = await c.send('2', 'done');
    assert.equal(done.completed, true);
    assert.equal(done.reply, null, 'the server, not the agent, sends the hold/payment text');
    assert.equal(c.lead.status, 'done');
    assert.equal(c.lead.bookingId, done.booking.id);
    assert.equal(store.db.bookings.length, 1);
    assert.equal(done.booking.slotStart, selected.start);
    assert.equal(done.booking.slotEnd, selected.end);
    assert.equal(done.booking.status, 'held');
    assert.equal(done.booking.paid, false);
    assert.equal(done.booking.amount, 20);
    assert.equal(done.booking.holdExpiresAt, '2030-01-07T08:30:00.000Z');
    const held = agent.texts.held(c.lead.name, done.booking, booking.cfg().holdMin, 'https://shop.example/pay');
    assert.match(held, /holding/);
    assert.match(held, /\$20 deposit/);
    assert.ok(held.includes(selected.label));
    assert.doesNotMatch(held, /you(?:'re| are) (?:booked|confirmed)|deposit received/i);
  });

  test(`${trade}: callback summary is not a promise; acknowledgements never complete twice`, async () => {
    shop(trade);
    const c = conversation();
    await c.send('Dana', 'need');
    await c.send(trade === 'nails' ? '2 almond, medium' : 'water heater repair', 'window');
    const done = await c.send('tomorrow after 4pm', 'done');
    assert.equal(done.completed, true);
    callbackSummary(done.reply, c.lead);
    assert.ok(done.reply.includes('Dana'));
    const saved = structuredClone(c.lead);
    for (const text of ['thanks', 'thanks!', 'okay', 'great', 'yes', 'no', 'sounds good']) {
      assert.equal(agent.isAcknowledgement(text), true);
      const ack = await c.send(text, 'done');
      unfinished(ack);
      assert.ok(ack.reply.includes(SHOP));
      assert.match(ack.reply, /already saved/i);
      assert.doesNotMatch(ack.reply, /your name|What day|Which service|good time for a callback/i);
      assert.deepEqual(c.lead, saved, 'acknowledgements cannot overwrite the completed request');
    }
    assert.equal(agent.isAcknowledgement('I need a new water heater'), false);
    assert.equal(store.db.bookings.length, 0);
  });

  test(`${trade}: firstMessage resumes each active step without asking for the name again`, async () => {
    shop(trade, { BOOKING_ENABLED: '1' });
    const c = conversation();
    await c.send('Dana', 'need');
    resumes(c.lead, trade === 'nails' ? /Which service/ : /What's going on/);
    await c.send(trade === 'nails' ? '2 almond, medium' : 'water heater repair', trade === 'nails' ? 'day' : 'slot');
    if (trade === 'nails') {
      resumes(c.lead, /Acrylic full set.*What day/);
      await c.send('soonest', 'slot');
    }
    unfinished(await c.send('not 1', 'slot'));
    const prompt = resumes(c.lead, /Reply 1, 2 or 3/);
    for (const slot of c.lead.offered) assert.ok(prompt.includes(slot.label));
    await c.send('callback', 'window');
    resumes(c.lead, /good time.*call/i);
  });
}

test('invalid callback windows recover once, then finish without inventing a preferred time', async () => {
  const c = conversation();
  await c.send("I'm Dana, I need a water heater repair", 'window');
  const first = await c.send('okay', 'window');
  unfinished(first);
  assert.match(first.reply, /What time would you prefer a callback/);
  const second = await c.send('when?', 'done');
  assert.equal(second.completed, true);
  assert.equal(c.lead.window, 'not specified');
  callbackSummary(second.reply, c.lead);
});

test('questions containing a real job or callback time retain their meaning', async () => {
  const c = conversation();
  await c.send('Dana', 'need');
  await c.send('Can you fix a burst pipe?', 'window');
  assert.equal(c.lead.need, 'Can you fix a burst pipe?');
  assert.equal(c.lead.urgent, true);
  const done = await c.send('After 3pm?', 'done');
  assert.equal(c.lead.window, 'After 3pm?');
  callbackSummary(done.reply, c.lead);
});

test('a supplemental question with the missing name cannot overwrite the saved urgent job', async () => {
  const c = conversation();
  await c.send('I have a burst pipe', 'name');
  await c.send("I'm Dana, can you call me?", 'window');
  assert.equal(c.lead.name, 'Dana');
  assert.equal(c.lead.need, 'I have a burst pipe');
  assert.equal(c.lead.urgent, true);
  const done = await c.send('now', 'done');
  callbackSummary(done.reply, c.lead);
});

test('a job inside a pricing question is retained without quoting a price', async () => {
  const c = conversation();
  await c.send('Dana', 'need');
  const next = await c.send('How much does it cost to fix a burst pipe?', 'window');
  assert.equal(c.lead.need, 'How much does it cost to fix a burst pipe?');
  assert.equal(c.lead.urgent, true);
  assert.doesNotMatch(next.reply, /\$|free|discount|guarantee/i);
});

test('repeated callback requests finish the handoff instead of looping forever', async () => {
  const c = conversation();
  await c.send('human', 'window');
  unfinished(await c.send('callback', 'window'));
  const done = await c.send('call me', 'done');
  assert.equal(done.completed, true);
  assert.equal(c.lead.name, null);
  assert.equal(c.lead.window, 'not specified');
});

test('unoffered numbers, dates and times cannot silently choose an appointment service', async () => {
  shop('nails', { BOOKING_ENABLED: '1' });
  for (const text of ['1', '1/10', '1pm', '1 pm']) {
    const c = conversation();
    await c.send(text, 'name');
    assert.equal(c.lead.service, undefined, text);
    await c.send('Dana', 'need');
    assert.equal(c.lead.service, undefined, text);
  }
  for (const text of ['13/40', '2/30', 'monkey', 'satisfaction']) assert.equal(agent.parseDay(text, NOW), null, text);
});

test('critical intake never lets AI replace a name or the required question', async (t) => {
  process.env.OPENAI_API_KEY = 'test-only-placeholder';
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('critical intake must not call a model'); });
  const c = conversation();
  const next = await c.send('Dana', 'need');
  assert.match(next.reply, /Thanks Dana! What's going on/);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

async function post(route, fields) {
  const response = await fetch(base + route, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: LINE, ...fields }).toString(),
  });
  assert.equal(response.status, 200, route);
  assert.match(response.headers.get('content-type'), /xml/);
  const xml = await response.text();
  assert.match(xml, /<Response[\s>]/);
  return xml;
}
const smsLog = () => fs.readFileSync(path.join(dir, 'sms.log'), 'utf8');
const sentTo = (to) => smsLog().split('\n').filter((line) => line.includes(`] SMS -> ${to}:`));
async function inbound(from, body) {
  const before = sentTo(from).length;
  await post('/twilio/sms', { From: from, Body: body, MessageSid: `SM${String(sequence++).padStart(32, '0')}` });
  assert.equal(sentTo(from).length, before + 1, 'exactly one log-only reply to each caller message');
}
async function missedCall(from) {
  const sid = callSid();
  const xml = await post('/twilio/voice', { From: from, CallSid: sid });
  assert.match(xml, /<Gather/);
  assert.match(xml, /Press 1/);
  assert.ok(xml.includes(SHOP));
  return sid;
}
async function consent(from, sid) {
  const xml = await post('/twilio/voice/consent', { From: from, CallSid: sid, Digits: '1' });
  assert.match(xml, /<Hangup\/>/);
  assert.doesNotMatch(xml, /<Gather/);
}

test('HTTP: voice -> consent -> SMS -> owner buzz -> repeated thanks/okay/yes/no keeps one completed lead', async () => {
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.twilio, false);
  assert.equal(health.stripe, false);
  assert.equal(store.status().configured, false);
  assert.equal(store.dataDir(), dir);
  const from = phone();
  const sid = await missedCall(from);
  assert.equal(store.db.leads.length, 0, 'a missed call alone is not consent to start intake');
  assert.equal(sentTo(from).length, 0);
  assert.equal(sentTo(OWNER).length, 0);
  await consent(from, sid);
  assert.equal(store.db.voiceConsents.find((c) => c.callSid === sid).consented, true);
  assert.equal(store.db.leads.length, 1);
  assert.equal(sentTo(from).length, 1);
  assert.equal(sentTo(OWNER).length, 1, 'one instant missed-call buzz');
  assert.match(sentTo(OWNER)[0], /Pressed 1 - texting them now/);
  const lead = store.db.leads[0];
  assert.match(lead.messages[0].body, /What's your name\?.*STOP.*HELP/);
  await consent(from, sid);
  assert.equal(sentTo(from).length, 1, 'duplicate consent does not restart intake');
  assert.equal(sentTo(OWNER).length, 1);

  await inbound(from, 'I need a water heater repair');
  assert.equal(lead.step, 'name');
  assert.equal(lead.name, null);
  await inbound(from, 'skip');
  assert.equal(lead.step, 'window');
  assert.equal(lead.need, 'I need a water heater repair');
  assert.equal(sentTo(OWNER).length, 1, 'no completion buzz before a callback preference');
  await inbound(from, 'tomorrow after 4pm');
  assert.equal(lead.step, 'done');
  assert.equal(lead.status, 'done');
  callbackSummary(lead.messages.at(-1).body, lead);
  assert.ok(smsLog().includes(lead.messages.at(-1).body));
  const alerts = store.db.alerts.filter((alert) => alert.leadId === lead.id);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].body.includes(SHOP));
  assert.ok(alerts[0].body.includes(lead.need));
  assert.ok(alerts[0].body.includes(lead.window));
  assert.match(alerts[0].body, /Caller \(name not given\)/);
  assert.equal(sentTo(OWNER).length, 2, 'one instant buzz plus one completed-request buzz');
  assert.equal(store.db.alerts.length, 2);
  const completedAt = lead.completedAt;
  for (const text of ['thanks', 'thanks!', 'okay', 'great', 'yes', 'no', 'sounds good']) {
    const messages = lead.messages.length;
    await inbound(from, text);
    assert.equal(store.db.leads.length, 1, `${text}: no new intake`);
    assert.equal(store.db.leads[0].id, lead.id);
    assert.equal(lead.messages.length, messages + 2, 'the acknowledgement stays in the original thread');
    assert.equal(lead.completedAt, completedAt);
    assert.equal(lead.status, 'done');
    assert.match(lead.messages.at(-1).body, /already saved/i);
    assert.equal(store.db.alerts.length, 2, `${text}: no new owner alert`);
    assert.equal(sentTo(OWNER).length, 2, `${text}: no new owner SMS`);
    assert.equal(store.db.bookings.length, 0);
  }
  await inbound(from, 'new request');
  assert.equal(store.db.leads.length, 2, 'an explicit new request intentionally opens intake');
  assert.equal(store.db.leads[0].step, 'name');
  assert.match(store.db.leads[0].messages.at(-1).body, /What's your name/);
  assert.equal(sentTo(OWNER).length, 2, 'opening intake does not send a completion buzz');
});

test('HTTP: a repeat missed call resumes the active day/slot prompt and keeps the service and retries', async () => {
  shop('nails', { BOOKING_ENABLED: '1' });
  const from = phone();
  await consent(from, await missedCall(from));
  await inbound(from, "I'm Dana, Acrylic full set, almond, medium");
  const lead = store.db.leads[0];
  assert.equal(lead.step, 'day');
  for (const step of ['day', 'slot']) {
    const before = structuredClone(lead);
    const count = sentTo(from).length;
    await consent(from, await missedCall(from));
    assert.equal(sentTo(from).length, count + 1);
    assert.equal(store.db.leads.length, 1, 'repeat call must not create another lead');
    assert.equal(lead.step, step);
    assert.equal(lead.name, 'Dana');
    assert.equal(lead.need, 'Acrylic full set (almond, medium)');
    assert.equal(lead.serviceMinutes, 90);
    assert.deepEqual(lead.offered, before.offered);
    assert.deepEqual(lead.retries, before.retries);
    const reply = lead.messages.at(-1).body;
    assert.match(reply, step === 'day' ? /Acrylic full set.*What day/ : /Reply 1, 2 or 3/);
    assert.doesNotMatch(reply, /What's your name|Which service/);
    if (step === 'day') {
      await inbound(from, 'tomorrow');
      await inbound(from, '1pm');
      assert.equal(lead.retries.slot, 1);
    } else for (const slot of lead.offered) assert.ok(reply.includes(slot.label));
  }
  assert.equal(store.db.bookings.length, 0);
  assert.equal(store.db.alerts.filter((alert) => alert.leadId === lead.id).length, 0);
});
