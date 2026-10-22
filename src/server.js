require('dotenv').config();
if (process.env.BUSINESS_TZ) process.env.TZ = process.env.BUSINESS_TZ; // slot math uses local time
const express = require('express');
const path = require('path');
const store = require('./store');
const { sendSms, canSend, hasPendingSends, live } = require('./sms');
const consent = require('./consent');
const { timingSafeEqual } = require('crypto');
const agent = require('./agent');
const booking = require('./booking');
const billing = require('./billing');

const app = express();
// Stripe webhook needs the raw body for signature verification, so it's registered before the JSON parser.
app.post('/stripe/webhook', express.raw({ type: '*/*' }), async (req, res, next) => {
  // Mock payments use the explicit mock routes; unsigned public payment events are never trusted.
  if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe webhook not configured');
  let event;
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_unused');
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] || '', process.env.STRIPE_WEBHOOK_SECRET);
  } catch { return res.status(400).send('Invalid Stripe webhook'); }
  try {
    // Shop subscription events go to billing.js. Deposit checkouts fall through.
    if (await billing.handleEvent(event)) return res.json({ received: true });
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const s = event.data.object;
      const id = s.metadata?.bookingId || s.client_reference_id;
      if (id && s.payment_status === 'paid') await onPaid(id);
    }
    res.json({ received: true });
  } catch (error) { next(error); }
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
// Public site. `extensions` gives clean URLs (/privacy, /terms, /refunds, /sms-consent) as well as the .html paths.
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
const env = process.env;
const BASE = env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`;
function isAdmin(req) {
  const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(req.headers.authorization || '');
  if (!match || !env.ADMIN_PASSWORD) return false;
  const decoded = Buffer.from(match[1], 'base64').toString();
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const supplied = Buffer.from(decoded.slice(separator + 1));
  const expected = Buffer.from(env.ADMIN_PASSWORD);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.set('WWW-Authenticate', 'Basic realm="admin"').status(401).send('auth required');
  next();
}
function billingHtml(esc) {
  const x = billing.summary(), s = x.subscription;
  const d = (v) => (v ? new Date(v).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
  return `<h1>Subscription <small style="font-weight:400;font-size:.6em">(${x.mode}${x.mode === 'mock' ? `, mock clock ${d(x.now)}` : ''})</small></h1>` + (s
    ? `<p>Status: <b>${esc(s.status)}</b> · plan <b>${esc(s.plan)}</b>${s.amount != null ? ` ($${esc(s.amount)})` : ''} · current period ends ${esc(d(s.current_period_end))}${s.trial_end ? ` · trial end ${esc(d(s.trial_end))}` : ''}${s.cancel_at_period_end ? ' · <b>cancels at period end</b>' : ''}<br>Service: <b>${x.access.active ? 'ACTIVE' : 'INACTIVE'}</b> (${esc(x.access.reason)}) · <a href="/billing/portal">Billing portal</a></p>`
    : `<p>No subscription on file. Service: <b>${x.access.active ? 'ACTIVE' : 'INACTIVE'}</b> (${esc(x.access.reason)})</p>`)
    + `<p>Founding shops (setup waived): ${x.founding.taken}/${x.founding.limit}</p>`
    + (x.shops.length ? `<details><summary>Shops (${x.shops.length})</summary><table><tr><th>#</th><th>Subscription</th><th>Plan</th><th>Status</th><th>Founding</th><th>Setup fee</th></tr>${x.shops.map((h) => `<tr><td>${h.n}</td><td>${esc(h.subscription)}</td><td>${esc(h.plan)}</td><td>${esc(h.status)}</td><td>${h.founding ? 'yes' : ''}</td><td>${esc(h.setup.status)}${h.setup.amount != null ? ' $' + esc(h.setup.amount) : ''} (${esc(h.setup.reason)})</td></tr>`).join('')}</table></details>` : '')
    + (x.invoices.length ? `<details><summary>Invoices (${x.invoices.length})</summary><ul>${x.invoices.map((i) => `<li>${esc(d(i.at))}: $${esc(i.amount_due)} ${esc(i.status)} (${esc(i.reason)})</li>`).join('')}</ul></details>` : '');
}
const twiml = (res, xml) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`);

// Never let unsigned webhooks fabricate consent state in live deployments.
function verifyTwilio(req, res, next) {
  if (!req.is('application/x-www-form-urlencoded')) return res.status(415).send('form webhook required');
  if (env.TWILIO_ACCOUNT_SID || env.TWILIO_AUTH_TOKEN) {
    if (!live || req.body.AccountSid !== env.TWILIO_ACCOUNT_SID) return res.status(403).send('invalid Twilio account');
    const ok = require('twilio').validateRequest(env.TWILIO_AUTH_TOKEN,
      req.headers['x-twilio-signature'] || '', BASE + req.originalUrl, req.body);
    if (!ok) return res.status(403).send('bad signature');
  } else {
    const localAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
    let localBase = false;
    try { localBase = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname); } catch {}
    if (env.ALLOW_UNSIGNED_TWILIO_WEBHOOKS !== '1' || env.NODE_ENV === 'production' ||
        !localBase || !localAddresses.includes(req.socket.remoteAddress)) {
      return res.status(403).send('verified Twilio webhook required');
    }
  }
  const config = consent.configuration();
  if (!config || req.body.To !== config.sender) return res.status(403).send('invalid Twilio recipient');
  if (req.path === '/twilio/sms' && (!consent.validPhone(req.body.From) ||
      typeof req.body.MessageSid !== 'string' || !/^(SM|MM)[a-fA-F0-9]{32}$/.test(req.body.MessageSid))) {
    return res.status(400).send('valid sender and message ID required');
  }
  next();
}

const missedSay = () => 'Sorry we missed you. Please call again later. Text messages are sent only when written permission is on file.';

// When the shop's subscription lapsed (past_due/canceled, see billing.access), callers get one polite generic text
// (at most once per number per 24h; INACTIVE_MODE=silent sends nothing) and no booking/deposit flow.
async function inactiveText(phone) {
  if (!canSend(phone).allowed || billing.cfg().inactiveMode === 'silent') return;
  store.db.inactiveTexts = store.db.inactiveTexts || {};
  const last = store.db.inactiveTexts[phone];
  if (last && Date.now() - Date.parse(last) < 86400000) return;
  const biz = env.BUSINESS_NAME || 'us';
  const msg = env.INACTIVE_MESSAGE || (agent.isBraiders()
    ? `Hi, this is ${biz}. Sorry I missed your call! Please try calling again later. Reply STOP to opt out.`
    : `Hi, this is ${biz}. Sorry we missed your call! Please try calling again later. Reply STOP to opt out.`);
  const result = await sendSms(phone, msg);
  if (result.sent) { store.db.inactiveTexts[phone] = new Date().toISOString(); store.save(); }
}

// Record outcomes honestly: a suppressed message is not an outgoing conversation message.
async function sendLeadMessage(lead, body) {
  const result = await sendSms(lead.phone, body);
  if (lead.messages) {
    lead.messages.push({ dir: result.sent ? 'out' : 'blocked', body,
      delivery: result.sent ? result.mode : result.reason, at: new Date().toISOString() });
    store.save();
  }
  return result;
}

async function startTextBack(phone) {
  if (!canSend(phone).allowed) return;
  if (!billing.access().active) return inactiveText(phone);
  let lead = store.findOpenLead(phone);
  if (!lead) lead = store.createLead(phone);
  await sendLeadMessage(lead, agent.firstMessage());
}

// 1) Incoming call: forward to owner if configured, else treat as missed
app.post('/twilio/voice', verifyTwilio, async (req, res, next) => {
  try {
    if (env.FORWARD_TO_PHONE) {
      return twiml(res, `<Dial timeout="${env.RING_TIMEOUT_SECONDS || 20}" action="${BASE}/twilio/voice/status">${env.FORWARD_TO_PHONE}</Dial>`);
    }
    await startTextBack(req.body.From);
    twiml(res, `<Say>${missedSay()}</Say><Hangup/>`);
  } catch (error) { next(error); }
});

// 2) Dial result: no-answer/busy/failed => missed call
app.post('/twilio/voice/status', verifyTwilio, async (req, res, next) => {
  try {
    const s = req.body.DialCallStatus;
    if (['no-answer', 'busy', 'failed', 'canceled'].includes(s)) {
      await startTextBack(req.body.From);
      return twiml(res, `<Say>${missedSay()}</Say><Hangup/>`);
    }
    twiml(res, '<Hangup/>');
  } catch (error) { next(error); }
});

const stopKeyword = (body) => /^(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout)[.!?]*$/i.test(body.trim());
const stopRequest = (body) => stopKeyword(body) ||
  /\b(stop|quit|cease)\s+(texting|messaging|sending)|\b(?:do not|don't|don’t)\s+(text|message|contact)|\bremove me\b|\bunsubscribe\b|\bopt\s+(?:me\s+)?out\b|\bno more\s+(texts|messages)\b/i.test(body);

// 3) Process suppression before billing, AI, lead creation, or any send.
app.post('/twilio/sms', verifyTwilio, async (req, res, next) => {
  try {
    const from = req.body.From, body = typeof req.body.Body === 'string' ? req.body.Body : '';
    const optOutType = req.body.OptOutType;
    if (optOutType !== undefined && !['STOP', 'START', 'HELP'].includes(optOutType)) {
      return res.status(400).send('invalid opt-out event');
    }
    if (optOutType === 'STOP' || stopRequest(body)) {
      consent.revoke(from, { method: optOutType === 'STOP' ? 'twilio_stop' : 'inbound_stop',
        messageSid: req.body.MessageSid, providerBlocked: optOutType === 'STOP' || stopKeyword(body) });
      return twiml(res, '');
    }
    if (optOutType === 'START' || /^(START|UNSTOP|YES)$/i.test(body.trim())) {
      // Unblocking transport is not a new consent grant; old grants remain revoked.
      consent.providerOptIn(from, { messageSid: req.body.MessageSid });
      return twiml(res, '');
    }
    if (optOutType === 'HELP') return twiml(res, ''); // Twilio already replied.
    if (/^(HELP|INFO)$/i.test(body.trim())) {
      await sendSms(from, 'For help with BuzzCall, call (470) 482-8377 or email hello@trybuzzcall.com.');
      return twiml(res, '');
    }
    if (!canSend(from).allowed || !body.trim()) return twiml(res, '');
    if (!billing.access().active) { await inactiveText(from); return twiml(res, ''); }
    // Include completed leads: a retry must not open a fresh conversation.
    if (store.db.leads.some((lead) => lead.phone === from &&
        lead.messages.some((message) => message.messageSid === req.body.MessageSid))) return twiml(res, '');
    let lead = store.findOpenLead(from);
    const newLead = !lead;
    if (!lead) lead = store.createLead(from);
    lead.messages.push({ dir: 'in', body, messageSid: req.body.MessageSid });
    store.save();
    if (newLead) {
      await sendLeadMessage(lead, 'Thanks for contacting us. What is your name?');
      return twiml(res, '');
    }
    const { reply, completed, booking: b } = await agent.handleReply(lead, body);
    // AI or other asynchronous work may have overlapped a STOP request.
    if (!canSend(from).allowed) { store.save(); return twiml(res, ''); }
    if (b) { await onBooked(lead, b); return twiml(res, ''); }
    await sendLeadMessage(lead, reply);
    if (completed) await buzzOwner(lead);
    twiml(res, '');
  } catch (error) { next(error); }
});

const tag = (lead) => `${lead.urgent ? '🚨 URGENT ' : ''}`;
const owner = async (leadId, msg) => {
  const result = await sendSms(env.OWNER_PHONE, msg, { purpose: 'owner_alerts' });
  store.addAlert({ leadId, to: env.OWNER_PHONE, body: msg,
    delivery: result.sent ? result.mode : result.reason, sent: result.sent });
};

async function onBooked(lead, b) {
  let msg;
  if (b.status === 'held') {
    let url;
    try { url = await booking.depositLink(b, BASE); } catch (e) { console.error('deposit link failed:', e.message); }
    const c = booking.cfg();
    msg = url ? agent.texts.held(lead.name, b, c.holdMin, url) : agent.texts.heldNoLink(lead.name, b);
  } else msg = agent.texts.bookedNoDeposit(lead.name, b);
  await sendLeadMessage(lead, msg);
  const status = b.status === 'held' ? `slot held, deposit pending ($${b.amount}, hold expires ${new Date(b.holdExpiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})` : 'BOOKED (no deposit)';
  if (b.service) await owner(lead.id, `BUZZ ${env.BUSINESS_NAME || ''}: ${status.replace('slot held', 'time held')}: ${lead.name}, ${lead.need}, ${b.slotLabel}. tel:${lead.phone}`);
  else await owner(lead.id, `${tag(lead)}BUZZ ${env.BUSINESS_NAME || ''}: ${status}: ${lead.name}, ${lead.need}, ${b.slotLabel}. Tap to call: tel:${lead.phone}`);
}

const money = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(2));
const feeNote = (b) => b.lead_fee_status === 'waived' ? 'lead fee waived (pilot)' : `lead fee $${money(b.lead_fee || 0)}${b.lead_fee_status === 'collected' ? ' (auto-deducted)' : ''}`;

async function onPaid(id) {
  const { booking: b, changed, conflict } = booking.markPaid(id);
  if (!b || !changed) return b;
  const lead = store.db.leads.find((l) => l.id === b.leadId) || { id: b.leadId, phone: b.phone, name: b.name, need: b.need };
  if (conflict) {
    await sendSms(b.phone, agent.texts.paidConflict(b));
    await owner(b.leadId, `⚠️ PAID BUT SLOT LOST $${b.amount}: ${b.name}, ${b.need}, ${b.slotLabel} (hold expired). Reschedule/refund (lead fee on hold for review). Tap to call: tel:${b.phone}`);
    return b;
  }
  const msg = agent.texts.paid(b);
  await sendLeadMessage(lead, msg);
  if (b.service) { // braiders: 'BOOKED + PAID: <name>, <service>, <time>, $50 deposit'
    await owner(b.leadId, `BOOKED + PAID: ${b.name}, ${b.service}, ${b.slotLabel}, $${money(b.amount)} deposit${b.details ? `. Notes: ${b.details}` : ''}. tel:${b.phone}`);
  } else await owner(b.leadId, `${tag(lead)}BOOKED + PAID $${b.amount}: ${b.name}, ${b.need}, ${b.slotLabel}, ${feeNote(b)}, tel:${b.phone}`);
  return b;
}

// Mock deposit page (only when Stripe isn't configured): visiting marks it paid.
app.get('/pay/mock/:id', async (req, res) => {
  if (env.STRIPE_SECRET_KEY) return res.status(404).send('mock payments disabled');
  const b0 = store.findBooking(req.params.id);
  if (!b0) return res.status(404).send('booking not found');
  const b = await onPaid(b0.id);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Deposit</title><body style="font-family:sans-serif;margin:2rem"><h1>${b.status === 'confirmed' ? 'Paid - you\'re booked!' : 'Payment received'}</h1><p>MOCK $${b.amount} deposit for ${b.slotLabel}. Status: ${b.status}</p>`);
});

async function buzzOwner(lead) {
  const msg = agent.isBraiders()
    ? `BUZZ ${env.BUSINESS_NAME || ''}: ${lead.name} (${lead.phone}) wants: ${lead.need}. Call back: ${lead.window}. tel:${lead.phone}`
    : `${lead.urgent ? '🚨 URGENT ' : ''}BUZZ ${env.BUSINESS_NAME || ''}: ${lead.name} (${lead.phone}) needs: ${lead.need}. Callback: ${lead.window}. Tap to call: tel:${lead.phone}`;
  await owner(lead.id, msg);
}

// Operator attestation only: this endpoint records evidence, it does not collect opt-in.
app.get('/api/consent', requireAdmin, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ records: consent.snapshot(), ...consent.status() }); } catch (error) { next(error); }
});
app.post('/api/consent', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.is('application/json')) return res.status(415).json({ error: 'application/json required' });
  try {
    if (req.headers.origin !== undefined && req.headers.origin !== new URL(BASE).origin) {
      return res.status(403).json({ error: 'same-origin request required' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'consent object required' });
    }
    const { action, ...input } = req.body;
    let record;
    if (action === 'grant') record = consent.grant(input);
    else if (action === 'revoke' && Object.keys(input).length === 1 && Object.hasOwn(input, 'phone')) {
      record = consent.revoke(input.phone);
    } else if (action === 'recover' && Object.keys(input).length === 1 && Object.hasOwn(input, 'acknowledgment')) {
      return res.json({ ok: true, ...consent.recover(input.acknowledgment) });
    } else return res.status(400).json({ error: 'documented grant, revoke or recovery fields required' });
    res.json({ ok: true, record });
  } catch (error) {
    res.status(error.status === 400 ? 400 : 409).json({ error: error.status ? error.message : 'unable to record permission' });
  }
});

// Waitlist
app.post('/api/waitlist', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
  const { businessType } = req.body;
  if (businessType !== undefined && businessType !== '' && businessType !== 'home_services' && businessType !== 'braiders') {
    return res.status(400).json({ error: 'invalid business type' });
  }
  store.addWaitlist(email, businessType); res.json({ ok: true });
});

// ---------- Shop subscription billing (see src/billing.js) ----------
// Signup: Stripe Checkout mode=subscription, card required, TRIAL_DAYS free trial (cancels if no card at trial end),
// setup price on monthly only. Without STRIPE_SECRET_KEY returns a mock checkout URL.
const planParam = (v) => (v === 'annual' ? 'annual' : v === 'monthly' || v === undefined || v === '' ? 'monthly' : null);
const apiErr = (res, e) => res.status(e.status || (e.type && e.type.startsWith('Stripe') ? 502 : 500)).json({ error: e.message });
app.post('/api/checkout', async (req, res) => {
  const plan = planParam(req.body.plan); if (!plan) return res.status(400).json({ error: 'plan must be monthly or annual' });
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(req.body.email || '')) ? String(req.body.email).trim() : undefined;
  // Per-shop setup-fee override: a matching SETUP_WAIVER_CODE, or setup_waived=1 from an admin-authenticated request.
  const code = billing.cfg().setupWaiverCode;
  const setupWaived = (!!code && String(req.body.setup_waiver_code || '') === code) || (isAdmin(req) && /^(1|true|yes)$/i.test(String(req.body.setup_waived || '')));
  try { res.json(await billing.createCheckout({ plan, email, BASE, setupWaived })); } catch (e) { apiErr(res, e); }
});
// Shop-owner billing actions: admin auth (single-tenant: the shop owner is the admin).
app.get('/billing/status', requireAdmin, (req, res) => res.json(billing.summary()));
app.post('/api/billing/preview', requireAdmin, async (req, res) => {
  const plan = planParam(req.body.plan); if (!plan) return res.status(400).json({ error: 'plan must be monthly or annual' });
  try { res.json(await billing.previewChange(plan, req.body.sub)); } catch (e) { apiErr(res, e); }
});
app.post('/api/billing/change-plan', requireAdmin, async (req, res) => {
  const plan = planParam(req.body.plan); if (!plan) return res.status(400).json({ error: 'plan must be monthly or annual' });
  try { res.json(await billing.changePlan(plan, req.body.proration_date, req.body.sub)); } catch (e) { apiErr(res, e); }
});
app.post('/api/billing/cancel', requireAdmin, async (req, res) => { try { res.json(await billing.setCancel(true, req.body.sub)); } catch (e) { apiErr(res, e); } });
app.post('/api/billing/resume', requireAdmin, async (req, res) => { try { res.json(await billing.setCancel(false, req.body.sub)); } catch (e) { apiErr(res, e); } });
// Self-service: Stripe Billing Portal (update card, invoices, cancel). Mock mode: local portal page.
app.get('/billing/portal', requireAdmin, async (req, res) => { try { res.redirect(303, await billing.portalUrl(BASE)); } catch (e) { apiErr(res, e); } });

// Mock billing (only without STRIPE_SECRET_KEY): checkout page, portal page, and a clock to simulate the lifecycle.
const mockOnly = (req, res, next) => (env.STRIPE_SECRET_KEY ? res.status(404).send('mock billing disabled (Stripe live)') : next());
const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.get('/billing/mock/checkout/:id', mockOnly, (req, res) => {
  const sess = billing.mockSessionInfo(req.params.id); if (!sess) return res.status(404).send('session not found');
  const c = billing.cfg();
  const setupTxt = sess.setup.status === 'pending' ? ` One-time setup $${c.mock.setup} (estimate) is added to your first invoice after the free trial, not today; cancel during the trial and you pay nothing.`
    : sess.setup.status === 'waived' ? ` Setup fee waived (${escH(sess.setup.reason)}).` : '';
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>MOCK checkout</title><body style="font-family:sans-serif;margin:2rem;max-width:36rem">
<h1>MOCK Stripe Checkout</h1><p>Plan: <b>${escH(sess.plan)}</b> ($${c.mock[sess.plan]}/${sess.plan === 'annual' ? 'yr' : 'mo'}, demo amount).${setupTxt}</p>
<p>${c.trialDays ? `${c.trialDays}-day free trial. Card required; it is charged automatically when the trial ends unless you cancel.` : 'No trial.'}</p>
<form method="post" action="/billing/mock/checkout/${escH(req.params.id)}/complete"><label>Card (mock) <input value="4242 4242 4242 4242" readonly></label> <button>Start ${c.trialDays ? 'free trial' : 'subscription'}</button></form>`);
});
app.post('/billing/mock/checkout/:id/complete', mockOnly, async (req, res) => {
  try { const s = await billing.mockCompleteCheckout(req.params.id, BASE); res.json({ ok: true, subscription: s }); } catch (e) { apiErr(res, e); }
});
app.get('/billing/mock/portal', mockOnly, requireAdmin, (req, res) => {
  const x = billing.summary(), s = x.subscription || {};
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>MOCK billing portal</title><body style="font-family:sans-serif;margin:2rem;max-width:40rem">
<h1>MOCK Billing Portal</h1><p>Status: <b>${escH(s.status || 'none')}</b> · plan ${escH(s.plan || '-')} · period ends ${escH(s.current_period_end || '-')}${s.cancel_at_period_end ? ' · <b>cancels at period end</b>' : ''} · access: ${x.access.active ? 'ON' : 'OFF'} (${escH(x.access.reason)})</p>
<form method="post" action="/billing/mock/update-card"><button>Update card (and pay open invoice)</button></form>
<form method="post" action="/api/billing/cancel"><button>Cancel at end of period</button></form>
<h2>Invoices</h2><ul>${x.invoices.map((i) => `<li>${escH(i.at)}: $${escH(i.amount_due)} ${escH(i.status)} (${escH(i.reason)})</li>`).join('')}</ul><p><a href="${escH(BASE)}/">Return to site</a></p>`);
});
app.post('/billing/mock/update-card', mockOnly, requireAdmin, async (req, res) => { try { res.json(await billing.mockUpdateCard(BASE, req.body.sub)); } catch (e) { apiErr(res, e); } });
app.post('/billing/mock/advance', mockOnly, requireAdmin, async (req, res) => {
  const days = Number(req.body.days); if (!Number.isFinite(days) || days < 0 || days > 800) return res.status(400).json({ error: 'days 0-800' });
  await billing.mockAdvance(days, BASE); res.json(billing.summary());
});
// Mock only: choose which mock subscription is 'this deploy's shop' (drives service gating).
app.post('/billing/mock/primary', mockOnly, requireAdmin, (req, res) => { try { res.json(billing.mockSetPrimary(req.body.sub)); } catch (e) { apiErr(res, e); } });
app.post('/billing/mock/fail-next', mockOnly, requireAdmin, (req, res) => { try { res.json(billing.mockFailNext(/^(1|true|on|yes)$/i.test(String(req.body.on ?? '1')), req.body.sub)); } catch (e) { apiErr(res, e); } });

// Admin (HTTP Basic auth, any username)
app.get('/admin', requireAdmin, (req, res) => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = store.db.leads.slice(0, 100).map((l) => `<tr><td>${esc(l.createdAt)}</td><td>${esc(l.phone)}</td><td>${esc(l.name)}</td><td>${l.urgent ? '🚨 ' : ''}${esc(l.need)}</td><td>${esc(l.window)}</td><td>${esc(l.status)}</td></tr>`).join('');
  const lf = booking.leadFeeTotals(), fc = booking.cfg();
  const alerts = store.db.alerts.slice(0, 50).map((a) => `<li>${esc(a.at)} → ${esc(a.to)}: ${esc(a.body)}${a.delivery ? ` [${esc(a.delivery)}]` : ''}</li>`).join('');
  const waitlist = store.db.waitlist.map((w) => {
    const label = w.businessType === 'home_services' ? 'Home services' : w.businessType === 'braiders' ? 'Braiders' : '';
    return `<li>${esc(w.email)}${label ? ` · Business type: ${esc(label)}` : ''}</li>`;
  }).join('');
  res.send(`<!doctype html><meta charset="utf-8"><title>Admin</title><style>body{font-family:sans-serif;margin:2rem}td,th{border:1px solid #ccc;padding:4px 8px}table{border-collapse:collapse}</style>
${billingHtml(esc)}<h1>Leads</h1><table><tr><th>When</th><th>Phone</th><th>Name</th><th>Need</th><th>Callback</th><th>Status</th></tr>${rows}</table>
<h2>Lead fees</h2><p><b>Total: $${money(lf.total)}</b> from ${lf.count} paid lead(s) (fee $${money(fc.leadFee)}/paid lead${fc.leadFeeWaived ? ', WAIVED' : ''}; ${fc.connectAccount ? 'Stripe Connect ' + esc(fc.connectAccount) : 'no Connect: invoice monthly'})<br>Due (to invoice): $${money(lf.due)} · Collected via Connect: $${money(lf.collected)} · Waived (pilot): $${money(lf.waived)} · Under review (slot lost): $${money(lf.review)}</p>
<h2>Bookings</h2><ul>${(store.db.bookings || []).slice(0, 50).map((b) => `<li>${esc(b.slotLabel)}: ${esc(b.name)} (${esc(b.phone)}) - ${esc(b.status)}${b.paid ? ' PAID $' + esc(b.amount) : ''}${b.lead_fee_status ? ` · lead fee $${money(b.lead_fee || 0)} ${esc(b.lead_fee_status)}` : ''}</li>`).join('')}</ul><h2>Owner alerts</h2><ul>${alerts}</ul><h2>Waitlist (${store.db.waitlist.length})</h2><ul>${waitlist}</ul>`);
});

setInterval(() => booking.expireHolds(), 60000).unref();
billing.init({ notify: (msg) => owner(null, msg), BASE });
app.get('/health', (_, res) => res.json({ ok: true, vertical: booking.cfg().vertical, billing: billing.summary().mode, serviceActive: billing.access().active, twilio: live, smsEnabled: env.SMS_ENABLED === '1', openai: !!env.OPENAI_API_KEY, booking: booking.cfg().booking, deposit: booking.cfg().deposit, stripe: !!env.STRIPE_SECRET_KEY, leadFee: booking.cfg().leadFee, leadFeeWaived: booking.cfg().leadFeeWaived, connect: !!booking.cfg().connectAccount }));
// Express 4 needs an explicit handler for forwarded asynchronous route failures.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'request could not be completed' });
});
const port = env.PORT || 3000;
const server = app.listen(port, () => console.log(`missedcall-buzz on :${port} (vertical ${booking.cfg().vertical}, twilio ${live ? 'LIVE' : 'LOG-ONLY'}, ai ${env.OPENAI_API_KEY ? 'openai' : 'templates'})`));
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Drain requests before marking a clean session. Forced exits retain the recovery marker.
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  server.close(() => {
    // server.close alone does not wait for handlers whose clients disconnected.
    const clean = !hasPendingSends() && consent.close();
    clearTimeout(timeout);
    process.exit(clean ? 0 : 1);
  });
  server.closeIdleConnections?.();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
