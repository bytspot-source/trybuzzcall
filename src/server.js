require('dotenv').config();
const config = require('./config'); // shop config: stored override (admin 'Apply to this line') > env > default
config.applyTZ(); // slot math uses local time (BUSINESS_TZ)
const express = require('express');
const path = require('path');
const store = require('./store');
const { sendSms, live } = require('./sms');
const agent = require('./agent');
const booking = require('./booking');
const billing = require('./billing');
const connect = require('./connect');
const setupRules = require('./setupRules');
const setupPages = require('./setupPages');
const crypto = require('crypto');
const sec = require('./security');

const app = express();
app.disable('x-powered-by');
// Behind Render's proxy: trust one hop so req.ip is the client (used by the rate limiters). TRUST_PROXY overrides
// (a hop count, or 0/false to disable). Off by default outside production.
{ const tp = process.env.TRUST_PROXY; app.set('trust proxy', tp !== undefined && tp !== '' ? (/^\d+$/.test(tp) ? Number(tp) : sec.on(tp)) : (sec.isProduction() ? 1 : false)); }
app.use(sec.securityHeaders(process.env.PUBLIC_BASE_URL));
// Unsigned (mock) Stripe events are only accepted with no STRIPE_SECRET_KEY (mock mode) AND outside production unless
// DEMO_MODE=1. Everything else needs a verified signature.
const unsignedStripeOk = () => !process.env.STRIPE_SECRET_KEY && sec.demoAllowed();
if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) console.error('[security] STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not: /stripe/webhook will refuse events (503) until it is set.');
// Stripe webhook needs the raw body for signature verification, so it's registered before the JSON parser.
app.post('/stripe/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_unused');
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] || '', process.env.STRIPE_WEBHOOK_SECRET);
    } else if (unsignedStripeOk()) event = JSON.parse(req.body.toString('utf8')); // dev/mock only
    else return res.status(503).send('Webhook not configured');
  } catch (e) { console.error('stripe webhook rejected:', e.message); return res.status(400).send('Webhook error'); }
  if (!event || typeof event !== 'object' || !event.type) return res.status(400).send('Webhook error');
  // Shop subscription events (and subscription-mode checkout) -> billing.js. Deposit checkouts fall through.
  try { if (await billing.handleEvent(event)) return res.json({ received: true }); }
  catch (e) { console.error('billing webhook error:', e.message); return res.status(500).send('billing handler error'); }
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const s = event.data.object;
    const id = s.metadata?.bookingId || s.client_reference_id;
    if (id && s.payment_status !== 'unpaid') await onPaid(id);
  }
  res.json({ received: true });
});
// Stripe Connect webhook (endpoint scope "Connected accounts", its own signing secret STRIPE_CONNECT_WEBHOOK_SECRET).
// Deposits are direct charges on the shop's account, so their checkout events arrive here with a top-level `account`.
// Only events for THIS shop's connected account are acted on (every Connect endpoint of a platform receives every
// connected account's events); others are acknowledged and ignored so Stripe doesn't retry them.
app.post('/stripe/connect/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    if (secret) event = require('stripe').webhooks.constructEvent(req.body, req.headers['stripe-signature'] || '', secret);
    else if (connect.mode() === 'mock' && sec.demoAllowed()) event = JSON.parse(req.body.toString('utf8')); // dev/mock only
    else return res.status(503).send('Connect webhook not configured');
  } catch (e) { console.error('connect webhook rejected:', e.message); return res.status(400).send('Webhook error'); }
  const ignore = (why) => res.json({ received: true, ignored: why });
  const acct = connect.accountId();
  if (!event || !event.account || !acct || event.account !== acct) return ignore('account mismatch');
  if (!connect.livemodeOk(event)) return ignore('livemode mismatch');
  const o = event.data?.object || {};
  try {
    switch (event.type) {
      case 'checkout.session.completed': case 'checkout.session.async_payment_succeeded': {
        if (o.mode && o.mode !== 'payment') return ignore('not a deposit');
        const id = o.metadata?.bookingId || o.client_reference_id;
        const b = id && store.findBooking(id);
        if (!b) return ignore('unknown booking');
        if (b.connectAccount && b.connectAccount !== event.account) return ignore('booking account mismatch');
        if (o.payment_status === 'paid' || o.payment_status === 'no_payment_required') await onPaid(id);
        break;
      }
      case 'checkout.session.async_payment_failed': {
        const b = store.findBooking(o.metadata?.bookingId || o.client_reference_id);
        if (b && !b.paid) { b.paymentFailed = true; store.save(); }
        break;
      }
      case 'account.updated': connect.applyAccount(o); break;
      case 'account.application.deauthorized':
        connect.deauthorize();
        await owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: Stripe was disconnected from BuzzCall. Deposits are off until you reconnect Stripe.`);
        break;
      default: return ignore('unhandled type');
    }
  } catch (e) { console.error('connect webhook error:', e.message); return res.status(500).send('connect handler error'); }
  res.json({ received: true });
});
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
// Never serve editor/backup leftovers (e.g. public/terms.html.bak-*) or dotfiles from public/.
app.use((req, res, next) => (/\.(bak|orig|swp)\b|~$|\/\./i.test(req.path) ? res.status(404).send('Not found') : next()));
// Public site. `extensions` gives clean URLs (/privacy, /terms, /refunds, /sms-consent) as well as the .html paths.
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
const env = config.env;
const BASE = env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`;
// Admin = HTTP Basic auth against ADMIN_PASSWORD (constant-time). Username: any, unless ADMIN_USERNAME is set.
// Brute-force protection: ADMIN_MAX_FAILS (default 10) wrong passwords per client IP per ADMIN_LOCKOUT_MINUTES
// (default 15) lock that IP out; a global cap (ADMIN_GLOBAL_MAX_FAILS, default 100 per window) stops distributed guessing.
// While locked, even the right password gets 429 so there is no oracle.
const adminWindowMs = sec.num(process.env.ADMIN_LOCKOUT_MINUTES, 15) * 60000;
const adminFails = sec.limiter({ windowMs: adminWindowMs, max: Math.max(1, sec.num(process.env.ADMIN_MAX_FAILS, 10)) });
const adminGlobalFails = sec.limiter({ windowMs: adminWindowMs, max: Math.max(1, sec.num(process.env.ADMIN_GLOBAL_MAX_FAILS, 100)) });
function basicCreds(req) {
  const [scheme, b64] = (req.headers.authorization || '').split(' ');
  if (!/^basic$/i.test(scheme || '') || !b64) return null;
  const raw = Buffer.from(b64, 'base64').toString();
  const i = raw.indexOf(':');
  return i < 0 ? { user: raw, pass: '' } : { user: raw.slice(0, i), pass: raw.slice(i + 1) };
}
function adminLocked(req) { return adminFails.blocked(sec.clientIp(req)) || adminGlobalFails.blocked('all'); }
function checkAdmin(req) {
  const c = basicCreds(req);
  if (!c) return false;
  if (!env.ADMIN_PASSWORD) return false;
  const userOk = env.ADMIN_USERNAME ? sec.safeEqual(c.user, env.ADMIN_USERNAME) : true;
  return sec.safeEqual(c.pass, env.ADMIN_PASSWORD) && userOk;
}
// Side-effect free check (also used to read optional admin flags on public routes). Counts failed attempts.
function isAdmin(req) {
  if (req._admin !== undefined) return req._admin;
  if (!basicCreds(req) || adminLocked(req)) return (req._admin = false);
  const ok = checkAdmin(req);
  if (!ok) { adminFails.hit(sec.clientIp(req)); adminGlobalFails.hit('all'); }
  return (req._admin = ok);
}
function requireAdmin(req, res, next) {
  const locked = adminLocked(req);
  if (locked) return res.set('Retry-After', String(locked)).status(429).send('too many failed logins, try again later');
  if (!isAdmin(req)) return res.set('WWW-Authenticate', 'Basic realm="admin"').status(401).send('auth required');
  next();
}
app.locals.resetAdminLockout = () => { adminFails.reset(); adminGlobalFails.reset(); };
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

// Twilio signature check. With TWILIO_AUTH_TOKEN set, every webhook must carry a valid X-Twilio-Signature
// (SKIP_TWILIO_VALIDATION=1 is honored outside production only). Without a token there is nothing to validate
// against: allowed for local/demo use (SMS are then log-only), refused in production unless DEMO_MODE=1.
// Signatures are computed over PUBLIC_BASE_URL + path, so PUBLIC_BASE_URL must be exactly the URL Twilio calls.
if (sec.isProduction() && env.SKIP_TWILIO_VALIDATION === '1') console.error('[security] SKIP_TWILIO_VALIDATION=1 is ignored in production.');
function verifyTwilio(req, res, next) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return sec.demoAllowed() ? next() : res.status(503).send('twilio webhook not configured');
  if (env.SKIP_TWILIO_VALIDATION === '1' && !sec.isProduction()) return next();
  const ok = require('twilio').validateRequest(token, req.headers['x-twilio-signature'] || '', BASE + req.originalUrl, req.body || {});
  return ok ? next() : res.status(403).send('bad signature');
}

const missedSay = () => (!agent.isAppointments() ? 'Sorry we missed you. We just texted you and will call back shortly.'
  : agent.solo() ? 'Sorry I missed you. I just sent you a text so we can get you booked.' : 'Sorry we missed you. We just sent you a text so we can get you booked.');

// When the shop's subscription lapsed (past_due/canceled, see billing.access), callers get one polite generic text
// (at most once per number per 24h; INACTIVE_MODE=silent sends nothing) and no booking/deposit flow.
async function inactiveText(phone) {
  if (!phone || billing.cfg().inactiveMode === 'silent') return;
  store.db.inactiveTexts = store.db.inactiveTexts || {};
  const last = store.db.inactiveTexts[phone];
  if (last && Date.now() - Date.parse(last) < 86400000) return;
  store.db.inactiveTexts[phone] = new Date().toISOString(); store.save();
  const biz = env.BUSINESS_NAME || 'us';
  const msg = env.INACTIVE_MESSAGE || (agent.isAppointments() && agent.solo()
    ? `Hi, this is ${biz}. Sorry I missed your call! Please try calling again later. Reply STOP to opt out.`
    : `Hi, this is ${biz}. Sorry we missed your call! Please try calling again later. Reply STOP to opt out.`);
  await sendSms(phone, msg);
}

// Per-number throttle on the first text-back: at most one per TEXTBACK_COOLDOWN_MINUTES (default 60) per caller,
// so repeated (or forged) calls from one number can't make the shop's line text it over and over.
// 0 disables. Timestamps live in db.textBacks (pruned as they expire).
const textBackCooldownMs = () => sec.num(process.env.TEXTBACK_COOLDOWN_MINUTES, 60) * 60000;
function textBackAllowed(phone) {
  const ms = textBackCooldownMs();
  if (!ms) return true;
  const t = (store.db.textBacks = store.db.textBacks || {}), now = Date.now();
  for (const [k, v] of Object.entries(t)) if (now - Date.parse(v) >= ms) delete t[k];
  if (t[phone]) return false;
  t[phone] = new Date(now).toISOString();
  return true;
}
async function startTextBack(phone) {
  if (!phone) return;
  if (!billing.access().active) return inactiveText(phone);
  if (!textBackAllowed(phone)) { console.log(`[textback] throttled ${sec.maskPhone(phone)} (already texted recently)`); return; }
  let lead = store.findOpenLead(phone);
  if (!lead) lead = store.createLead(phone);
  const msg = agent.firstMessage();
  lead.messages.push({ dir: 'out', body: msg }); store.save();
  await sendSms(phone, msg);
}

// 1) Incoming call: forward to owner if configured, else treat as missed
app.post('/twilio/voice', verifyTwilio, async (req, res) => {
  if (env.FORWARD_TO_PHONE) {
    return twiml(res, `<Dial timeout="${env.RING_TIMEOUT_SECONDS || 20}" action="${BASE}/twilio/voice/status">${env.FORWARD_TO_PHONE}</Dial>`);
  }
  await startTextBack(req.body.From);
  twiml(res, `<Say>${missedSay()}</Say><Hangup/>`);
});

// 2) Dial result: no-answer/busy/failed => missed call
app.post('/twilio/voice/status', verifyTwilio, async (req, res) => {
  const s = req.body.DialCallStatus;
  if (['no-answer', 'busy', 'failed', 'canceled'].includes(s)) {
    await startTextBack(req.body.From);
    return twiml(res, `<Say>${missedSay()}</Say><Hangup/>`);
  }
  twiml(res, '<Hangup/>');
});

// 3) Caller SMS replies
app.post('/twilio/sms', verifyTwilio, async (req, res) => {
  const from = req.body.From, body = req.body.Body || '';
  if (/^(stop|unsubscribe|cancel|end|quit)$/i.test(body.trim())) return twiml(res, ''); // Twilio handles opt-out
  if (!billing.access().active) { await inactiveText(from); return twiml(res, ''); }
  let lead = store.findOpenLead(from) || store.createLead(from);
  lead.messages.push({ dir: 'in', body });
  const { reply, completed, booking: b } = await agent.handleReply(lead, body);
  if (b) { await onBooked(lead, b); return twiml(res, ''); }
  lead.messages.push({ dir: 'out', body: reply }); store.save();
  await sendSms(from, reply);
  if (completed) await buzzOwner(lead);
  twiml(res, '');
});

const tag = (lead) => `${lead.urgent ? '🚨 URGENT ' : ''}`;
const owner = async (leadId, msg) => { store.addAlert({ leadId, to: env.OWNER_PHONE, body: msg }); await sendSms(env.OWNER_PHONE || '+10000000000', msg); };

async function onBooked(lead, b) {
  let msg;
  if (b.status === 'held') {
    let url;
    try { url = await booking.depositLink(b, BASE); } catch (e) { console.error('deposit link failed:', e.message); }
    // Fail closed: null = Stripe live/test but the shop's connected account isn't ready. No deposit, plain booking.
    if (url === null) booking.skipDeposit(b, 'stripe_not_connected');
  }
  if (b.status === 'held') {
    const c = booking.cfg();
    msg = b.payUrl ? agent.texts.held(lead.name, b, c.holdMin, b.payUrl) : agent.texts.heldNoLink(lead.name, b);
  } else msg = agent.texts.bookedNoDeposit(lead.name, b);
  lead.messages.push({ dir: 'out', body: msg }); store.save();
  await sendSms(lead.phone, msg);
  const status = b.status === 'held' ? `slot held, deposit pending ($${b.amount}, hold expires ${new Date(b.holdExpiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})`
    : b.depositSkipped ? 'BOOKED (no deposit; deposit off: Stripe not connected)' : 'BOOKED (no deposit)';
  if (b.service) await owner(lead.id, `BUZZ ${env.BUSINESS_NAME || ''}: ${status.replace('slot held', 'time held')}: ${lead.name}, ${lead.need}, ${b.slotLabel}. tel:${lead.phone}`);
  else await owner(lead.id, `${tag(lead)}BUZZ ${env.BUSINESS_NAME || ''}: ${status}: ${lead.name}, ${lead.need}, ${b.slotLabel}. Tap to call: tel:${lead.phone}`);
}

const money = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(2));
const feeNote = (b) => b.lead_fee_status === 'waived' ? 'lead fee waived (pilot)' : `lead fee $${money(b.lead_fee || 0)}${b.lead_fee_status === 'collected' ? ' (auto-deducted)' : ''}`;

// Deposits are paid into the shop's own Stripe account: refunds are issued by the owner there (no in-app refund tool).
const refundNote = (b) => (b.connectAccount ? '. Deposit is in your Stripe account; refunds from your Stripe Dashboard.' : '');
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
  if (lead.messages) { lead.messages.push({ dir: 'out', body: msg }); store.save(); }
  await sendSms(b.phone, msg);
  if (b.service) { // appointment trades: 'BOOKED + PAID: <name>, <service>, <time>, $50 deposit'
    await owner(b.leadId, `BOOKED + PAID: ${b.name}, ${b.service}, ${b.slotLabel}, $${money(b.amount)} deposit${b.details ? `. Notes: ${b.details}` : ''}. tel:${b.phone}${refundNote(b)}`);
  } else await owner(b.leadId, `${tag(lead)}BOOKED + PAID $${b.amount}: ${b.name}, ${b.need}, ${b.slotLabel}, ${feeNote(b)}, tel:${b.phone}${refundNote(b)}`);
  return b;
}

// Mock deposit page (only when Stripe isn't configured, and in production only with DEMO_MODE=1): visiting marks it paid.
app.get('/pay/mock/:id', async (req, res) => {
  if (env.STRIPE_SECRET_KEY || !sec.demoAllowed()) return res.status(404).send('mock payments disabled');
  const b0 = store.findBooking(req.params.id);
  if (!b0) return res.status(404).send('booking not found');
  const b = await onPaid(b0.id);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Deposit</title><body style="font-family:sans-serif;margin:2rem"><h1>${b.status === 'confirmed' ? 'Paid - you\'re booked!' : 'Payment received'}</h1><p>MOCK $${b.amount} deposit for ${b.slotLabel}. Status: ${b.status}</p>`);
});

async function buzzOwner(lead) {
  const msg = agent.isAppointments()
    ? `BUZZ ${env.BUSINESS_NAME || ''}: ${lead.name} (${lead.phone}) wants: ${lead.need}. Call back: ${lead.window}. tel:${lead.phone}`
    : `${lead.urgent ? '🚨 URGENT ' : ''}BUZZ ${env.BUSINESS_NAME || ''}: ${lead.name} (${lead.phone}) needs: ${lead.need}. Callback: ${lead.window}. Tap to call: tel:${lead.phone}`;
  store.addAlert({ leadId: lead.id, to: env.OWNER_PHONE, body: msg });
  await sendSms(env.OWNER_PHONE || '+10000000000', msg);
}

// Public form throttles (per client IP).
const formLimit = (name, max) => sec.rateLimit({ windowMs: sec.num(process.env.FORM_RATE_WINDOW_MINUTES, 10) * 60000, max: sec.num(process.env[name], max) });
const waitlistLimit = formLimit('WAITLIST_RATE_MAX', 30), setupLimit = formLimit('SETUP_RATE_MAX', 20), checkoutLimit = formLimit('CHECKOUT_RATE_MAX', 30);
app.locals.resetFormLimits = () => { waitlistLimit.reset(); setupLimit.reset(); checkoutLimit.reset(); };
// Waitlist
app.post('/api/waitlist', waitlistLimit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
  const { businessType } = req.body;
  if (businessType !== undefined && businessType !== '' && !store.WAITLIST_TYPES.includes(businessType)) {
    return res.status(400).json({ error: 'invalid business type' });
  }
  if (!store.addWaitlist(email, businessType)) return res.status(503).json({ error: 'waitlist is full' });
  res.json({ ok: true });
});

// ---------- Shop subscription billing (see src/billing.js) ----------
// Signup: Stripe Checkout mode=subscription, card required, TRIAL_DAYS free trial (cancels if no card at trial end),
// setup price on monthly only. Without STRIPE_SECRET_KEY returns a mock checkout URL.
const planParam = (v) => (v === 'annual' ? 'annual' : v === 'monthly' || v === undefined || v === '' ? 'monthly' : null);
// Client errors (4xx/501 thrown on purpose) keep their message; unexpected/Stripe errors are logged, not echoed.
const apiErr = (res, e) => {
  const status = e.status || (e.type && e.type.startsWith('Stripe') ? 502 : 500);
  if (status >= 500 && status !== 501) { console.error('api error:', e.message); return res.status(status).json({ error: status === 502 ? 'payment provider error' : 'server error' }); }
  return res.status(status).json({ error: e.message });
};
app.post('/api/checkout', checkoutLimit, async (req, res) => {
  if (!env.STRIPE_SECRET_KEY && !sec.demoAllowed()) return res.status(503).json({ error: 'checkout not available' });
  const plan = planParam(req.body.plan); if (!plan) return res.status(400).json({ error: 'plan must be monthly or annual' });
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(req.body.email || '')) ? String(req.body.email).trim() : undefined;
  // Per-shop setup-fee override: a matching SETUP_WAIVER_CODE, or setup_waived=1 from an admin-authenticated request.
  const code = billing.cfg().setupWaiverCode;
  const given = String(req.body.setup_waiver_code || '');
  const setupWaived = (!!code && !!given && sec.safeEqual(given, code)) || (/^(1|true|yes)$/i.test(String(req.body.setup_waived || '')) && isAdmin(req));
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
const mockOnly = (req, res, next) => (env.STRIPE_SECRET_KEY ? res.status(404).send('mock billing disabled (Stripe live)')
  : !sec.demoAllowed() ? res.status(404).send('mock billing disabled (set DEMO_MODE=1)') : next());
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

// ---------- Shop-owner setup form ----------
// GET /setup is public/setup.html (static). The shared balance-check rules are served to the browser from src/.
app.get('/setup-rules.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'setupRules.js')));
app.get('/trades.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'trades.js')));
// POST /setup (JSON or form). 422 = errors, 409 = warnings not confirmed (send confirm=1), 200 = saved as 'pending'.
// Never touches the live config: an admin reviews it and clicks 'Apply to this line'.
const wantsJson = (req) => req.is('application/json') || /application\/json/.test(req.get('accept') || '');
app.post('/setup', setupLimit, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const json = wantsJson(req);
  const { values, issues, errors, warnings } = setupRules.validate(body);
  if (String(body.website || '').trim()) { // honeypot: bots fill hidden fields; pretend success, store nothing
    return json ? res.json({ ok: true, id: null }) : res.type('html').send(setupPages.thanksHtml({}));
  }
  if (errors.length) return json ? res.status(422).json({ ok: false, errors, warnings, issues }) : res.status(422).type('html').send(setupPages.errorsHtml(errors));
  if (warnings.length && !values.confirm) return json ? res.status(409).json({ ok: false, needsConfirm: true, warnings, issues }) : res.status(409).type('html').send(setupPages.confirmHtml(warnings, body));
  const { confirm, ...saved } = values;
  const s = store.addSetup({ id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(), status: 'pending',
    values: saved, warningsConfirmed: warnings, consentAt: new Date().toISOString() });
  const message = "We'll review your setup and text you within 1 business day.";
  return json ? res.json({ ok: true, id: s.id, message }) : res.type('html').send(setupPages.thanksHtml(saved));
});
// Admin POSTs: refuse cross-site form posts (basic-auth credentials ride along automatically).
function sameOrigin(req, res, next) {
  const o = req.get('origin');
  if (o && o !== 'null') { try { if (new URL(o).host !== req.get('host')) return res.status(403).send('cross-origin request refused'); } catch { return res.status(403).send('bad origin'); } }
  next();
}
app.post('/admin/setups/:id/apply', requireAdmin, sameOrigin, (req, res) => {
  const s = store.findSetup(req.params.id);
  if (!s) return res.status(404).json({ error: 'setup not found' });
  const { values, errors } = setupRules.validate(s.values);
  if (errors.length) return res.status(422).json({ error: 'setup has errors; fix before applying', errors });
  const applied = config.apply(setupRules.toEnv(values), { setupId: s.id });
  for (const x of store.db.setups) if (x.status === 'applied' && x.id !== s.id) x.status = 'replaced';
  s.status = 'applied'; s.appliedAt = new Date().toISOString(); store.save();
  if (wantsJson(req)) return res.json({ ok: true, id: s.id, config: applied });
  res.redirect(303, '/admin#setups');
});
app.post('/admin/config/reset', requireAdmin, sameOrigin, (req, res) => {
  config.clear();
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect(303, '/admin#setups');
});

// ---------- Stripe Connect onboarding (deposits go to the shop owner's own Stripe account) ----------
// Account Links are single-use and must only be given to the authenticated account holder: always a redirect from
// an admin-authenticated request, never texted or emailed.
const connectPrefill = () => ({ name: env.BUSINESS_NAME || '', url: /^https:\/\//.test(BASE) ? BASE : '' });
async function startOnboarding(req, res) {
  try {
    const r = await connect.onboard(BASE, connectPrefill());
    if (wantsJson(req)) return res.json({ ok: true, url: r.url, accountId: r.accountId, created: r.created });
    res.redirect(303, r.url);
  } catch (e) { console.error('connect onboarding failed:', e.message); res.status(502).type('text').send('Could not start Stripe onboarding. Check the server logs and try again.'); }
}
app.post('/admin/connect/onboard', requireAdmin, sameOrigin, startOnboarding);
app.get('/admin/connect/refresh', requireAdmin, startOnboarding); // Stripe sends the owner here when a link expired
app.get('/admin/connect/return', requireAdmin, async (req, res) => { // returning does NOT mean onboarding is complete
  try { await connect.refresh(); } catch (e) { console.error('connect status refresh failed:', e.message); }
  if (wantsJson(req)) return res.json(connect.summary());
  res.redirect(303, '/admin#connect');
});
app.post('/admin/connect/sync', requireAdmin, sameOrigin, async (req, res) => {
  try { await connect.refresh(); } catch (e) { console.error('connect status refresh failed:', e.message); }
  if (wantsJson(req)) return res.json(connect.summary());
  res.redirect(303, '/admin#connect');
});
app.get('/admin/connect/status', requireAdmin, (req, res) => res.json(connect.summary()));
// Mock mode only (no STRIPE_SECRET_KEY): simulated Stripe onboarding.
const connectMockOnly = (req, res, next) => (connect.mode() !== 'mock' ? res.status(404).send('mock onboarding disabled (Stripe configured)')
  : !sec.demoAllowed() ? res.status(404).send('mock onboarding disabled (set DEMO_MODE=1)') : next());
app.get('/admin/connect/mock', connectMockOnly, requireAdmin, (req, res) => {
  const x = connect.summary();
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>MOCK Stripe onboarding</title><body style="font-family:sans-serif;margin:2rem;max-width:40rem">
<h1>MOCK Stripe onboarding</h1><p>No Stripe key is configured, so this simulates the Stripe-hosted onboarding for account <code>${escH(x.accountId || '-')}</code>. No real money moves.</p>
<form method="post" action="/admin/connect/mock/complete"><button>Finish mock onboarding (charges enabled)</button></form><p><a href="/admin#connect">Back to admin</a></p>`);
});
app.post('/admin/connect/mock/complete', connectMockOnly, requireAdmin, sameOrigin, (req, res) => {
  const s = connect.mockComplete();
  if (!s) return res.status(409).json({ error: 'start onboarding first' });
  if (wantsJson(req)) return res.json(connect.summary());
  res.redirect(303, '/admin#connect');
});
function connectHtml(esc) {
  const x = connect.summary();
  const btn = x.status === 'charges_enabled' ? '' : `<form method="post" action="/admin/connect/onboard" style="display:inline"><button>${x.accountId ? 'Continue Stripe onboarding' : 'Connect Stripe to receive deposits'}</button></form> `;
  const sync = x.accountId && x.mode !== 'mock' ? '<form method="post" action="/admin/connect/sync" style="display:inline"><button>Refresh status</button></form>' : '';
  return `<h1 id="connect">Deposit payouts (Stripe Connect)</h1><p>Status: <b>${esc(x.label)}</b> (${esc(x.mode)})${x.accountId ? ` · account <code>${esc(x.accountId)}</code>${x.source === 'env' ? ' (from STRIPE_CONNECT_ACCOUNT_ID)' : ''}` : ''}${x.accountId ? ` · details submitted: ${x.detailsSubmitted ? 'yes' : 'no'} · payouts: ${x.payoutsEnabled ? 'on' : 'off'}` : ''}${x.requirementsDue.length ? ` · Stripe still needs: ${esc(x.requirementsDue.join(', '))}` : ''}</p>
<p>Deposits are paid straight into the shop's own Stripe account (the shop is the seller); refunds are issued by the owner from their Stripe Dashboard. ${x.depositsReady ? 'Deposits: <b>ON</b>.' : 'Deposits: <b>OFF</b> until charges are enabled; callers are booked without a deposit.'}</p>
<p>${btn}${sync}</p>`;
}

// Admin (HTTP Basic auth; any username unless ADMIN_USERNAME is set)
app.get('/admin', requireAdmin, (req, res) => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = store.db.leads.slice(0, 100).map((l) => `<tr><td>${esc(l.createdAt)}</td><td>${esc(l.phone)}</td><td>${esc(l.name)}</td><td>${l.urgent ? '🚨 ' : ''}${esc(l.need)}</td><td>${esc(l.window)}</td><td>${esc(l.status)}</td></tr>`).join('');
  const lf = booking.leadFeeTotals(), fc = booking.cfg();
  const alerts = store.db.alerts.slice(0, 50).map((a) => `<li>${esc(a.at)} → ${esc(a.to)}: ${esc(a.body)}</li>`).join('');
  const waitlist = store.db.waitlist.map((w) => {
    const label = { home_services: 'Home services', braiders: 'Braiders', other: 'Other local business' }[w.businessType] || '';
    return `<li>${esc(w.email)}${label ? ` · Business type: ${esc(label)}` : ''}</li>`;
  }).join('');
  res.send(`<!doctype html><meta charset="utf-8"><title>Admin</title><style>body{font-family:sans-serif;margin:2rem}td,th{border:1px solid #ccc;padding:4px 8px}table{border-collapse:collapse}</style>
${billingHtml(esc)}${connectHtml(esc)}<h1>Leads</h1><table><tr><th>When</th><th>Phone</th><th>Name</th><th>Need</th><th>Callback</th><th>Status</th></tr>${rows}</table>
<h2>Lead fees</h2><p><b>Total: $${money(lf.total)}</b> from ${lf.count} paid lead(s) (fee $${money(fc.leadFee)}/paid lead${fc.leadFeeWaived ? ', WAIVED' : ''}; ${fc.connectAccount ? 'Stripe Connect ' + esc(fc.connectAccount) + ' (application fee, capped at 1/3 of the deposit)' : 'no Stripe connected'})<br>Due (to invoice): $${money(lf.due)} · Collected via Connect: $${money(lf.collected)} · Waived (pilot): $${money(lf.waived)} · Under review (slot lost): $${money(lf.review)}</p>
<h2>Bookings</h2><ul>${(store.db.bookings || []).slice(0, 50).map((b) => `<li>${esc(b.slotLabel)}: ${esc(b.name)} (${esc(b.phone)}) - ${esc(b.status)}${b.paid ? ' PAID $' + esc(b.amount) : ''}${b.depositSkipped ? ' · deposit off: Stripe not connected' : ''}${b.lead_fee_status ? ` · lead fee $${money(b.lead_fee || 0)} ${esc(b.lead_fee_status)}` : ''}</li>`).join('')}</ul><h2>Owner alerts</h2><ul>${alerts}</ul><h2>Waitlist (${store.db.waitlist.length})</h2><ul>${waitlist}</ul>
${setupPages.adminSetupsHtml(store.db.setups, config.effective(), config.override(), booking.cfg())}`);
});

setInterval(() => booking.expireHolds(), 60000).unref();
billing.init({ notify: (msg) => owner(null, msg), BASE });
// Public health: status fields only (ops checks use ok/storage/billing/serviceActive/...). Pricing config and the
// OpenAI flag are admin-only (send Basic auth to get them too).
app.get('/health', (req, res) => {
  const c = booking.cfg();
  const h = { ok: true, vertical: c.vertical, trade: c.trade, flow: c.flow, billing: billing.summary().mode, serviceActive: billing.access().active, twilio: live, booking: c.booking, deposit: c.deposit, stripe: !!env.STRIPE_SECRET_KEY, connect: connect.mode() !== 'mock' && connect.depositsReady(), connectStatus: connect.status(), storage: store.backend() };
  if (req.headers.authorization && isAdmin(req)) Object.assign(h, { openai: !!env.OPENAI_API_KEY, leadFee: c.leadFee, leadFeeWaived: c.leadFeeWaived, demoMode: sec.demoAllowed() });
  res.json(h);
});
module.exports = { app, onPaid, onBooked };
if (require.main !== module) return; // required by tests: no listener, no signal handlers
const port = env.PORT || 3000;
// Load persisted state first (Postgres when DATABASE_URL is set; no-op for file storage), then accept traffic.
store.init().then(() => {
config.applyTZ(); // the stored override may have just been loaded from Postgres
const server = app.listen(port, () => console.log(`missedcall-buzz on :${port} (vertical ${booking.cfg().vertical}, trade ${booking.cfg().trade}, twilio ${live ? 'LIVE' : 'LOG-ONLY'}, ai ${env.OPENAI_API_KEY ? 'openai' : 'templates'}, storage ${store.backend()})`));
// Render sends SIGTERM on restart/redeploy: flush pending writes to Postgres before exiting.
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { server.close(); store.close().finally(() => process.exit(0)); });
});
