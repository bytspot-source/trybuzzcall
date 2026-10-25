require('dotenv').config();
const config = require('./config'); // shop config: stored override (admin 'Apply to this line') > env > default
config.applyTZ(); // slot math uses local time (BUSINESS_TZ)
const express = require('express');
const path = require('path');
const store = require('./store');
const sms = require('./sms');
const { sendSms, live } = sms;
const optout = require('./optout');
const agent = require('./agent');
const booking = require('./booking');
const billing = require('./billing');
const connect = require('./connect');
const setupRules = require('./setupRules');
const setupPages = require('./setupPages');
const adminPages = require('./adminPages');
const paymentPages = require('./paymentPages');
const crypto = require('crypto');
const sec = require('./security');
const vendors = require('./vendors');
const shopContext = require('./shopContext');

const app = express();
app.disable('x-powered-by');
// Express 4 doesn't catch rejected async handlers (an unhandled rejection used to kill the process). Every route and
// middleware registered below is wrapped so a rejection goes to next(err) and the error handler at the bottom.
const wrap = (fn) => (typeof fn !== 'function' || fn.length === 4 ? fn
  : function wrapped(req, res, next) { try { const r = fn.call(this, req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); } });
for (const m of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
  const orig = app[m].bind(app);
  app[m] = (...args) => (m === 'get' && args.length === 1 && typeof args[0] === 'string' ? orig(...args) : orig(...args.map(wrap)));
}
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
  const destination = await vendors.stripeShop(event);
  if (!destination) return res.json({ received: true, ignored: 'unassigned or conflicting shop' });
  if (destination.retry) return res.status(503).send('Shop ownership pending; retry this event.');
  const handle = async () => {
  // Shop subscription events (and subscription-mode checkout) -> billing.js. Deposit checkouts fall through.
  try {
    if (await billing.handleEvent(event)) {
      if (shopContext.current()) await vendors.flush(shopContext.current().store);
      return res.json({ received: true });
    }
  }
  catch (e) { console.error('billing webhook error:', e.message); return res.status(500).send('billing handler error'); }
  // Vendor deposits are direct Connect charges; platform-account events cannot mark them paid.
  if (!shopContext.current() && ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const s = event.data.object;
    const id = s.metadata?.bookingId || s.client_reference_id;
    if (id && s.payment_status !== 'unpaid') await onPaid(id);
  }
  res.json({ received: true });
  };
  return destination.shop ? vendors.run(destination.shop.id, handle, { suspended: true }) : handle();
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
  const destination = await vendors.stripeShop(event || {}, true);
  if (!destination) return ignore('unassigned or conflicting shop');
  const handle = async () => {
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
  if (shopContext.current()) await vendors.flush(shopContext.current().store);
  res.json({ received: true });
  };
  return destination.shop ? vendors.run(destination.shop.id, handle, { suspended: true }) : handle();
});
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
// Central CSRF guard: every state-changing request (anything but GET/HEAD/OPTIONS) to an admin or billing endpoint
// (/admin/*, /api/billing/*, /billing/*, including the mock billing routes) must come from this site. Registered once,
// before every such route, so a new route can't forget it. Case-insensitive because Express routing is.
// Private business/payment pages must never be stored in shared caches or leak capability URLs as referrers.
app.use((req, res, next) => {
  if (/^\/(admin|vendor|api\/billing|billing|pay|payment)(\/|$)/i.test(req.path)) {
    res.set('Cache-Control', 'private, no-store');
    res.set('Referrer-Policy', 'no-referrer');
  }
  next();
});
const ORIGIN_GUARDED = /^\/(admin|vendor|api\/billing|billing)(\/|$)/i;
app.use((req, res, next) => (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !ORIGIN_GUARDED.test(req.path) ? next() : sameOrigin(req, res, next)));
// Never serve editor/backup leftovers (e.g. public/terms.html.bak-*) or dotfiles from public/.
app.use((req, res, next) => (/\.(bak|orig|swp)\b|~$|\/\./i.test(req.path) ? res.status(404).send('Not found') : next()));
// Public site. `extensions` gives clean URLs (/privacy, /terms, /refunds, /sms-consent) as well as the .html paths.
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
const env = config.env;
const BASE = env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`;
// Admin = HTTP Basic auth against ADMIN_PASSWORD (constant-time). Username: any, unless ADMIN_USERNAME is set.
// Brute-force protection: ADMIN_MAX_FAILS (default 10) wrong passwords per client IP per ADMIN_LOCKOUT_MINUTES
// (default 15) lock that IP out; a global cap (ADMIN_GLOBAL_MAX_FAILS, default 100 per window) stops distributed guessing.
// While an IP is locked, even the right password gets 429 from it so there is no oracle. The global cap does NOT
// hard-block (that would let anyone lock the owner out): past it every admin request is delayed
// (ADMIN_GLOBAL_DELAY_MS, default 3000) and the owner is alerted once per window.
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
function adminLocked(req) { return adminFails.blocked(sec.clientIp(req)); }
let adminAlertedAt = 0;
function adminUnderAttack() {
  if (!adminGlobalFails.blocked('all')) return false;
  if (Date.now() - adminAlertedAt > adminWindowMs) {
    adminAlertedAt = Date.now();
    console.error('[security] many failed admin logins from many clients: slowing down admin requests');
    owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: many failed admin password attempts in the last ${Math.round(adminWindowMs / 60000)} min. Admin logins are slowed down. Use a long ADMIN_PASSWORD and consider setting ADMIN_USERNAME.`).catch(() => {});
  }
  return true;
}
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
async function requireAdmin(req, res, next) {
  if (adminUnderAttack()) await sec.sleep(sec.num(process.env.ADMIN_GLOBAL_DELAY_MS, 3000));
  const locked = adminLocked(req);
  if (locked) return res.set('Retry-After', String(locked)).status(429).send('too many failed logins, try again later');
  if (!isAdmin(req)) return res.set('WWW-Authenticate', 'Basic realm="admin"').status(401).send('auth required');
  next();
}
app.locals.resetAdminLockout = () => { adminFails.reset(); adminGlobalFails.reset(); adminAlertedAt = 0; };
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

const missedSayNoText = () => (agent.isAppointments() && agent.solo() ? 'Sorry I missed you. Please try again later.' : 'Sorry we missed you. Please try again later.');
const missedSay = () => (!agent.isAppointments() ? 'Sorry we missed you. We just texted you and will call back shortly.'
  : agent.solo() ? 'Sorry I missed you. I just sent you a text so we can get you booked.' : 'Sorry we missed you. We just sent you a text so we can get you booked.');

// When the shop's subscription lapsed (past_due/canceled, see billing.access), callers get one polite generic text
// (at most once per number per 24h; INACTIVE_MODE=silent sends nothing) and no booking/deposit flow.
async function inactiveText(phone) {
  if (!sec.isNanp(phone) || store.isOptedOut(phone) || billing.cfg().inactiveMode === 'silent') return;
  store.db.inactiveTexts = store.db.inactiveTexts || {};
  pruneInactiveTexts();
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
// Callers skipped only because of their area code (other NANP country, territory, or a code missing from
// src/areaCodes.js) are counted per UTC day; the owner gets one summary per day (reportAreaSkips, at boot and daily)
// so a new overlay or real customers from a blocked code are noticed. Only area codes are stored, never numbers.
function recordAreaSkip(npa) {
  if (!/^\d{3}$/.test(npa)) return;
  const day = new Date().toISOString().slice(0, 10);
  const t = (store.db.areaSkips = store.db.areaSkips || {});
  const d = (t[day] = t[day] || {});
  d[npa] = (d[npa] || 0) + 1;
  store.save();
}
async function reportAreaSkips(now = Date.now()) {
  const t = store.db.areaSkips || {}, today = new Date(now).toISOString().slice(0, 10), sent = [];
  for (const day of Object.keys(t).sort()) {
    if (day >= today) continue;
    const counts = Object.entries(t[day] || {}).sort((a, b) => b[1] - a[1]);
    const total = counts.reduce((a, [, n]) => a + n, 0);
    delete t[day];
    if (!total) continue;
    const list = counts.slice(0, 8).map(([c, n]) => `${c} x${n}`).join(', ');
    await owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: ${total} missed call(s) on ${day} got no text-back because the caller's area code isn't on the US/Canada list (${list}). If any were real customers (a new area code, or e.g. Puerto Rico 787/939), add the code to TEXT_EXTRA_AREA_CODES.`);
    sent.push({ day, total });
  }
  if (sent.length) store.save();
  return sent;
}
app.locals.reportAreaSkips = reportAreaSkips;
// Only valid US/Canada numbers get a text-back: anonymous/restricted/blank caller IDs and international or premium
// numbers are skipped (SMS pumping / toll fraud). Returns true when a text was sent.
async function startTextBack(phone) {
  if (!sec.isNanp(phone)) {
    const why = sec.nanpReason(phone);
    console.log(`[textback] skipped caller id ${phone ? sec.maskPhone(String(phone).slice(0, 20)) : '(blank)'}: ${why}`);
    if (why === 'non-US/Canada NANP area code' || why === 'not a US/Canada area code') recordAreaSkip(String(phone).slice(2, 5)); // never toll-free/premium/non-geographic
    return false;
  }
  if (store.isOptedOut(phone)) { console.log(`[textback] skipped ${sec.maskPhone(phone)}: opted out`); return false; }
  if (store.isPaused(phone)) { console.log(`[textback] skipped ${sec.maskPhone(phone)}: automated texts paused (possible opt-out)`); return false; }
  if (!billing.access().active) { await inactiveText(phone); return false; }
  if (!textBackAllowed(phone)) { console.log(`[textback] throttled ${sec.maskPhone(phone)} (already texted recently)`); return false; }
  let lead = store.findOpenLead(phone);
  if (!lead) lead = store.createLead(phone);
  const msg = agent.firstMessage();
  lead.messages.push({ dir: 'out', body: msg }); store.save();
  return (await sendSms(phone, msg)).ok;
}

// 1) Incoming call: forward to owner if configured, else treat as missed
const routeTwilio = (callback = false) => async (req, res, next) => {
  const destination = await vendors.twilioShop(req.body, callback);
  if (!destination) return twiml(res, '');
  if (destination.shop) {
    if (req.path.startsWith('/twilio/voice') && !req.body.CallSid) return twiml(res, '');
    return vendors.run(destination.shop.id, () => next());
  }
  next();
};
function recordVendorCall(req, status) {
  if (!shopContext.current() || typeof req.body.CallSid !== 'string' || req.body.CallSid.length > 80) return;
  const calls = (store.db.calls ||= []);
  const prior = calls.find(call => call.id === req.body.CallSid);
  if (prior) { if (prior.status !== 'ringing') return false; prior.status = status; }
  else calls.unshift({id:req.body.CallSid,phone:/^\+[1-9]\d{7,14}$/.test(req.body.From) ? req.body.From : null,status,at:new Date().toISOString()});
  if (calls.length > 500) calls.length = 500;
  store.save(); return true;
}
app.post('/twilio/voice', verifyTwilio, routeTwilio(), async (req, res) => {
  if (recordVendorCall(req, env.FORWARD_TO_PHONE ? 'ringing' : 'missed') === false) return twiml(res, '<Hangup/>');
  if (env.FORWARD_TO_PHONE) {
    return twiml(res, `<Dial timeout="${env.RING_TIMEOUT_SECONDS || 20}" action="${BASE}/twilio/voice/status">${env.FORWARD_TO_PHONE}</Dial>`);
  }
  const texted = await startTextBack(req.body.From);
  twiml(res, `<Say>${texted ? missedSay() : missedSayNoText()}</Say><Hangup/>`);
});

// 2) Dial result: no-answer/busy/failed => missed call
app.post('/twilio/voice/status', verifyTwilio, routeTwilio(true), async (req, res) => {
  const s = req.body.DialCallStatus;
  if (recordVendorCall(req, ['no-answer','busy','failed','canceled'].includes(s) ? 'missed' : s === 'completed' ? 'answered' : 'ringing') === false) return twiml(res, '<Hangup/>');
  if (['no-answer', 'busy', 'failed', 'canceled'].includes(s)) {
    const texted = await startTextBack(req.body.From);
    return twiml(res, `<Say>${texted ? missedSay() : missedSayNoText()}</Say><Hangup/>`);
  }
  twiml(res, '<Hangup/>');
});

// Record an opt-out durably before answering (Postgres write-through), but never hold the webhook past 5s.
const optOutNow = (phone, source) => Promise.race([store.optOut(phone, source), sec.sleep(5000)]);

// 3) Caller SMS replies
app.post('/twilio/sms', verifyTwilio, routeTwilio(), async (req, res) => {
  const from = req.body.From, body = String(req.body.Body || '');
  if (!sec.isNanp(from)) return twiml(res, ''); // never text non-US/CA or anonymous senders
  const kw = optout.classify(body);
  const biz = env.BUSINESS_NAME || 'us';
  if (kw === 'optout') { // exact Twilio keyword: Twilio's opt-out handling sends the confirmation; we just record it
    await optOutNow(from, 'keyword'); await owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: ${from} replied ${body.trim().slice(0, 20)} and is opted out of texts.`);
    return twiml(res, '');
  }
  if (kw === 'revoke') { // any other opt-out (keyword variant or plain language): exactly one confirmation, then silence
    if (!store.isOptedOut(from)) {
      await optOutNow(from, 'message');
      // Spanish opt-outs (basta, no me escriban, ...) get a bilingual confirmation; Twilio doesn't handle those keywords.
      const en = `${biz}: You're unsubscribed and won't get more texts from us. Reply START to resubscribe.`;
      const es = `Se canceló su suscripción y no recibirá más mensajes. Responda START para volver a suscribirse.`;
      await sendSms(from, optout.language(body) === 'es' ? `${en} / ${es}` : en, { force: true });
      await owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: ${from} asked not to be texted ("${body.trim().slice(0, 60)}") and is opted out.`);
    }
    return twiml(res, '');
  }
  if (kw === 'optin' && (store.isOptedOut(from) || optout.letters(body) !== 'YES')) {
    store.optIn(from); store.resumeBot(from); return twiml(res, ''); // Twilio sends the re-subscribe confirmation
  }
  if (kw === 'help') {
    const contact = env.OWNER_PHONE && env.OWNER_PHONE !== sec.PLACEHOLDER_PHONE ? ` or call ${env.OWNER_PHONE}` : '';
    await sendSms(from, env.HELP_MESSAGE || `${biz}: Missed-call text line for booking and callbacks. Reply STOP to opt out${contact}. Msg & data rates may apply.`, { force: true });
    return twiml(res, '');
  }
  if (store.isOptedOut(from)) return twiml(res, ''); // opted out: no conversation until START
  if (kw === 'maybe') { // longer message mentioning stop with no job context: don't guess; pause the bot, ask the owner
    const lead = store.findOpenLead(from);
    if (lead) { lead.messages.push({ dir: 'in', body }); }
    const already = store.isPaused(from);
    store.pauseBot(from, body);
    if (!already) await owner(lead ? lead.id : null, `BUZZ ${env.BUSINESS_NAME || ''}: possible opt-out from ${from}: "${body.trim().slice(0, 80)}". Automated texts to this number are paused for ${sec.num(process.env.BOT_PAUSE_HOURS, 72)}h. Please contact them yourself; they can reply START to get texts again.`);
    return twiml(res, '');
  }
  if (store.isPaused(from)) { // paused after a possible opt-out: keep the message for the owner, no automated reply
    const lead = store.findOpenLead(from);
    if (lead) { lead.messages.push({ dir: 'in', body }); store.save(); }
    return twiml(res, '');
  }
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
const owner = async (leadId, msg) => { store.addAlert({ leadId, to: env.OWNER_PHONE, body: msg }); await sendSms(env.OWNER_PHONE || sec.PLACEHOLDER_PHONE, msg, { kind: 'owner' }); };
sms.setCapAlert((max, per = 'hour') => owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: outbound text limit reached (${max}/${per}). Text-backs are paused until the ${per === 'day' ? '24-hour window' : 'hour'} resets. If this wasn't a real rush, it may be SMS pumping: check Twilio logs. Raise ${per === 'day' ? 'OUTBOUND_MAX_PER_DAY' : 'OUTBOUND_MAX_PER_HOUR'} if needed.`));

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

// A payment link is safe to open: only an explicit same-origin POST completes a simulation.
const mockPaymentOnly = (req, res, next) => env.STRIPE_SECRET_KEY || !sec.demoAllowed()
  ? res.status(404).send('mock payments disabled') : next();
const routeBooking = async (req, res, next) => {
  const destination = await vendors.bookingShop(req.params.id);
  if (!destination) return res.status(404).send('booking not found');
  if (destination.shop) return vendors.run(destination.shop.id, () => next());
  next();
};
app.get('/pay/mock/:id', mockPaymentOnly, routeBooking, (req, res) => {
  const b = store.findBooking(req.params.id);
  if (!b) return res.status(404).send('booking not found');
  res.type('html').send(paymentPages.deposit({ booking: b, businessName: env.BUSINESS_NAME || 'Your business' }));
});
app.post('/pay/mock/:id', mockPaymentOnly, sameOrigin, routeBooking, async (req, res) => {
  const b = store.findBooking(req.params.id);
  if (!b) return res.status(404).send('booking not found');
  if (!b.paid && (b.status !== 'held' || !Number.isFinite(Date.parse(b.holdExpiresAt)) || Date.parse(b.holdExpiresAt) <= Date.now())) {
    return res.status(409).type('html').send(paymentPages.deposit({ booking: b, businessName: env.BUSINESS_NAME || 'Your business' }));
  }
  await onPaid(b.id);
  res.redirect(303, `/pay/mock/${encodeURIComponent(b.id)}`);
});
// Redirect parameters never prove payment. These read-only pages wait for provider/webhook confirmation.
for (const [route, kind] of [['/payment/return', 'deposit'], ['/billing/return', 'subscription']]) {
  app.get(route, (req, res) => res.type('html').send(paymentPages.returnPage({ kind,
    outcome: req.query.status === 'success' ? 'success' : 'cancel',
    businessName: env.BUSINESS_NAME || 'Your business', mode: connect.mode() })));
}

async function buzzOwner(lead) {
  const msg = agent.isAppointments()
    ? `BUZZ ${env.BUSINESS_NAME || ''}: ${lead.name} (${lead.phone}) wants: ${lead.need}. Call back: ${lead.window}. tel:${lead.phone}`
    : `${lead.urgent ? '🚨 URGENT ' : ''}BUZZ ${env.BUSINESS_NAME || ''}: ${lead.name} (${lead.phone}) needs: ${lead.need}. Callback: ${lead.window}. Tap to call: tel:${lead.phone}`;
  store.addAlert({ leadId: lead.id, to: env.OWNER_PHONE, body: msg });
  await sendSms(env.OWNER_PHONE || sec.PLACEHOLDER_PHONE, msg, { kind: 'owner' });
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
  if (vendors.all().length) return res.status(401).json({ error: 'Sign in to your vendor dashboard to choose a subscription.', next: '/vendor/login' });
  if (!env.STRIPE_SECRET_KEY && !sec.demoAllowed()) return res.status(503).json({ error: 'checkout not available' });
  const plan = planParam(req.body.plan); if (!plan) return res.status(400).json({ error: 'plan must be monthly or annual' });
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(req.body.email || '')) ? String(req.body.email).trim() : undefined;
  // Per-shop setup-fee override: a matching SETUP_WAIVER_CODE, or setup_waived=1 from an admin-authenticated request.
  const code = billing.cfg().setupWaiverCode;
  const given = String(req.body.setup_waiver_code || '');
  const setupWaived = (!!code && !!given && sec.safeEqual(given, code)) || (/^(1|true|yes)$/i.test(String(req.body.setup_waived || '')) && isAdmin(req) && originCheck(req) === 'ok');
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
  try { billingReply(req, res, await billing.changePlan(plan, req.body.proration_date, req.body.sub)); } catch (e) { apiErr(res, e); }
});
app.post('/api/billing/cancel', requireAdmin, async (req, res) => { try { billingReply(req, res, await billing.setCancel(true, req.body.sub)); } catch (e) { apiErr(res, e); } });
app.post('/api/billing/resume', requireAdmin, async (req, res) => { try { billingReply(req, res, await billing.setCancel(false, req.body.sub)); } catch (e) { apiErr(res, e); } });
// Self-service: Stripe Billing Portal (update card, invoices, cancel). Mock mode: local portal page.
app.get('/billing/portal', requireAdmin, async (req, res) => { try { res.redirect(303, await billing.portalUrl(BASE)); } catch (e) { apiErr(res, e); } });

// Mock billing (only without STRIPE_SECRET_KEY): checkout page, portal page, and a clock to simulate the lifecycle.
const mockOnly = (req, res, next) => (env.STRIPE_SECRET_KEY ? res.status(404).send('mock billing disabled (Stripe live)')
  : !sec.demoAllowed() ? res.status(404).send('mock billing disabled (set DEMO_MODE=1)') : next());
app.get('/billing/mock/checkout/:id', mockOnly, (req, res) => {
  const session = billing.mockSessionInfo(req.params.id); if (!session) return res.status(404).send('session not found');
  res.type('html').send(paymentPages.checkout({ session, cfg: billing.cfg(), id: req.params.id, businessName: env.BUSINESS_NAME || 'Your business' }));
});
app.post('/billing/mock/checkout/:id/complete', mockOnly, async (req, res) => {
  try {
    const s = await billing.mockCompleteCheckout(req.params.id, BASE);
    if (wantsHtml(req)) return res.redirect(303, `/billing/mock/checkout/${encodeURIComponent(req.params.id)}`);
    res.json({ ok: true, subscription: s });
  } catch (e) { apiErr(res, e); }
});
app.get('/billing/mock/portal', mockOnly, requireAdmin, (req, res) => {
  res.type('html').send(adminPages.billingPortal({ billing: billing.summary(), businessName: env.BUSINESS_NAME || 'Your business' }));
});
app.post('/billing/mock/update-card', mockOnly, requireAdmin, async (req, res) => { try { billingReply(req, res, await billing.mockUpdateCard(BASE, req.body.sub)); } catch (e) { apiErr(res, e); } });
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
const wantsHtml = (req) => !wantsJson(req) && /text\/html/.test(req.get('accept') || '');
const billingReply = (req, res, result) => wantsHtml(req) ? res.redirect(303, '/admin#payments') : res.json(result);
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
// Admin/billing POSTs (central guard above): refuse cross-site form posts (basic-auth credentials ride along automatically). Browsers send Origin on
// every POST; a missing or "null" Origin falls back to Referer, and with neither the request is refused.
// Scripts calling admin POSTs must send an Origin header matching the host.
function originCheck(req) {
  const host = req.get('host');
  const same = (u) => { try { return new URL(u).host === host; } catch { return false; } };
  const o = req.get('origin');
  if (o && o !== 'null') return same(o) ? 'ok' : 'cross';
  const ref = req.get('referer');
  return ref && same(ref) ? 'ok' : 'missing';
}
function sameOrigin(req, res, next) {
  const r = originCheck(req);
  if (r === 'ok') return next();
  return res.status(403).send(r === 'cross' ? 'cross-origin request refused' : 'cross-origin request refused (missing Origin)');
}
require('./vendorRoutes').register(app, { requireAdmin, BASE, sameOrigin });
app.post('/admin/setups/:id/apply', requireAdmin, (req, res) => {
  const s = store.findSetup(req.params.id);
  if (!s) return res.status(404).json({ error: 'setup not found' });
  const { values, errors } = setupRules.validate(s.values);
  if (errors.length) return res.status(422).json({ error: 'setup has errors; fix before applying', errors });
  // Changing where calls ring or where lead alerts go needs an explicit second confirmation (confirm_phones=1).
  const next = setupRules.toEnv(values);
  const changes = ['OWNER_PHONE', 'FORWARD_TO_PHONE'].filter((k) => (next[k] || '') !== (env[k] || '')).map((k) => ({ key: k, from: env[k] || '', to: next[k] || '' }));
  if (changes.length && !/^(1|true|yes)$/i.test(String(req.body.confirm_phones || ''))) {
    if (wantsJson(req)) return res.status(409).json({ ok: false, needsConfirm: true, phoneChanges: changes, hint: 'resend with confirm_phones=1' });
    return res.status(409).type('html').send(paymentPages.phoneConfirmation({ setupId: s.id, businessName: values.businessName || 'Your business', changes }));
  }
  const applied = config.apply(next, { setupId: s.id });
  for (const x of store.db.setups) if (x.status === 'applied' && x.id !== s.id) x.status = 'replaced';
  s.status = 'applied'; s.appliedAt = new Date().toISOString(); store.save();
  if (wantsJson(req)) return res.json({ ok: true, id: s.id, config: applied });
  res.redirect(303, '/admin#setups');
});
app.post('/admin/config/reset', requireAdmin, (req, res) => {
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
app.post('/admin/connect/onboard', requireAdmin, startOnboarding);
// Stripe sends the owner here when an onboarding link expired. GET must not create anything: with an existing account
// it only mints a fresh onboarding link for it; with none it goes back to the admin page (creating is POST onboard).
app.get('/admin/connect/refresh', requireAdmin, async (req, res) => {
  if (!connect.accountId() || connect.mode() === 'mock') return res.redirect(303, '/admin#connect');
  return startOnboarding(req, res);
});
app.get('/admin/connect/return', requireAdmin, async (req, res) => { // returning does NOT mean onboarding is complete
  try { await connect.refresh(); } catch (e) { console.error('connect status refresh failed:', e.message); }
  if (wantsJson(req)) return res.json(connect.summary());
  res.redirect(303, '/admin#connect');
});
app.post('/admin/connect/sync', requireAdmin, async (req, res) => {
  try { await connect.refresh(); } catch (e) { console.error('connect status refresh failed:', e.message); }
  if (wantsJson(req)) return res.json(connect.summary());
  res.redirect(303, '/admin#connect');
});
app.get('/admin/connect/status', requireAdmin, (req, res) => res.json(connect.summary()));
// Mock mode only (no STRIPE_SECRET_KEY): simulated Stripe onboarding.
const connectMockOnly = (req, res, next) => (connect.mode() !== 'mock' ? res.status(404).send('mock onboarding disabled (Stripe configured)')
  : !sec.demoAllowed() ? res.status(404).send('mock onboarding disabled (set DEMO_MODE=1)') : next());
app.get('/admin/connect/mock', connectMockOnly, requireAdmin, (req, res) => {
  res.type('html').send(paymentPages.connectOnboarding({ connect: connect.summary(), businessName: env.BUSINESS_NAME || 'Your business' }));
});
app.post('/admin/connect/mock/complete', connectMockOnly, requireAdmin, (req, res) => {
  const s = connect.mockComplete();
  if (!s) return res.status(409).json({ error: 'start onboarding first' });
  if (wantsJson(req)) return res.json(connect.summary());
  res.redirect(303, '/admin#connect');
});
// Authenticated, server-rendered workspace. Only explicitly selected non-secret values reach templates.
app.get('/admin/legacy', requireAdmin, (req, res) => {
  res.type('html').send(adminPages.render({
    businessName: env.BUSINESS_NAME || 'Your business',
    leads: store.db.leads, bookings: store.db.bookings || [], alerts: store.db.alerts, waitlist: store.db.waitlist,
    billing: billing.summary(), connect: connect.summary(), cfg: booking.cfg(), fees: booking.leadFeeTotals(),
    storage: store.status(), policy: storagePolicy(), production: sec.isProduction(), demoAllowed: sec.demoAllowed(),
    paused: Object.keys(store.db.botPaused || {}).filter(phone => store.isPaused(phone)), twilioLive: live,
    pendingSetups: (store.db.setups || []).filter(s => s.status === 'pending').length,
    setupHTML: setupPages.adminSetupsHtml(store.db.setups, config.effective(), config.override(), booking.cfg()),
  }));
});

async function maintainShops() {
  for (const shop of vendors.all().filter(s => s.status !== 'provisioning')) {
    try { await vendors.run(shop.id, () => { booking.expireHolds(); runRetention(); }, { suspended: true }); }
    catch { console.error('[vendors] Shop maintenance unavailable; check storage health.'); }
  }
}
setInterval(() => { booking.expireHolds(); maintainShops().catch(() => {}); }, 60000).unref();
app.locals.maintainShops = maintainShops;
billing.init({ notify: (msg) => owner(null, msg), BASE });
// Public health: status fields only (ops checks use ok/storageState/billing/serviceActive/...). Pricing config, the
// OpenAI flag and the storage backend (`storage`, `storageDetail`) are admin-only (send Basic auth to get them too).
app.get('/health', (req, res) => {
  const c = booking.cfg();
  const h = { ok: true, vertical: c.vertical, trade: c.trade, flow: c.flow, billing: billing.summary().mode, serviceActive: billing.access().active, twilio: live, booking: c.booking, deposit: c.deposit, stripe: !!env.STRIPE_SECRET_KEY, connect: connect.mode() !== 'mock' && connect.depositsReady(), connectStatus: connect.status() };
  // Full state (admins): ok | degraded (Postgres writes failing right now) | fallback (DATABASE_URL set, running on
  // files) | file (no DATABASE_URL).
  const st = store.status();
  const fullState = st.degraded ? 'degraded' : st.fallback ? 'fallback' : st.backend === 'postgres' ? 'ok' : 'file';
  // Public: only ok/degraded (file storage in production counts as degraded). Full detail is admin-only.
  h.storageState = fullState === 'ok' || (fullState === 'file' && !sec.isProduction()) ? 'ok' : 'degraded';
  if (req.headers.authorization && isAdmin(req)) {
    const pol = storagePolicy();
    Object.assign(h, { storage: store.backend(), openai: !!env.OPENAI_API_KEY, leadFee: c.leadFee, leadFeeWaived: c.leadFeeWaived, demoMode: sec.demoAllowed(),
      storageDetail: { state: fullState, backend: st.backend, spillDir: st.spillDir, databaseConfigured: st.configured, failClosed: pol.failClosed, failClosedReason: pol.why, fallback: st.fallback,
        degraded: st.degraded, failingSince: st.failingSince, lastError: st.lastError, optOutSpillPending: st.spillPending, pathWarnings: st.pathWarnings } });
  }
  res.json(h);
});
// Retention, at boot and daily. RETENTION_DAYS (default 365; 0 = keep forever) drops leads (with their message threads,
// i.e. caller names/numbers/job details) and owner alerts older than N days. Why 365: a lead is only actionable for
// days or weeks, but a year covers seasonal repeat customers (annual service, "same as last spring"), payment disputes
// on deposits (card chargeback windows run up to ~120 days) and a full year of the shop's own records, while not
// keeping caller PII indefinitely. Bookings (payment records) and opt-outs (needed to keep honouring STOP) are kept.
// Always: inactive-shop text dedupe stamps (db.inactiveTexts) older than 24h are dropped (they only matter for 24h).
const INACTIVE_TEXT_MS = 86400000;
function pruneInactiveTexts(now = Date.now()) {
  const t = store.db.inactiveTexts;
  if (!t) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(t)) if (!(now - Date.parse(v) < INACTIVE_TEXT_MS)) { delete t[k]; n++; }
  if (n) store.save();
  return n;
}
function runRetention() {
  const stamps = pruneInactiveTexts();
  for (const p of Object.keys(store.db.botPaused || {})) store.isPaused(p); // drops expired bot pauses
  const days = sec.num(process.env.RETENTION_DAYS, 365);
  const r = days ? store.purgeOlderThan(days) : { leads: 0, alerts: 0 };
  if (r.leads || r.alerts) console.log(`[retention] purged ${r.leads} lead(s) and ${r.alerts} alert(s) older than ${days} days`);
  return { ...r, inactiveTexts: stamps, days };
}
app.locals.runRetention = runRetention;
app.locals.pruneInactiveTexts = pruneInactiveTexts;

// Last-resort error handler: log, generic reply, never echo internals. Twilio webhooks get empty TwiML so Twilio
// doesn't play an error to the caller.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err && (err.status || err.statusCode) >= 400 && (err.status || err.statusCode) < 500 ? (err.status || err.statusCode) : 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
  if (res.headersSent) return;
  if (req.path.startsWith('/twilio/') && status >= 500) return twiml(res, '');
  res.status(status).type('text').send(status >= 500 ? 'server error' : 'bad request');
});

// Boot-time checks (warnings only, so the live line keeps answering). ADMIN_PASSWORD_STRICT=1 makes a weak admin
// password fatal in production.
function placeholderPasswords() {
  const out = new Set(['change-me']);
  try { const m = require('fs').readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8').match(/^ADMIN_PASSWORD=([^\s#]*)/m); if (m && m[1]) out.add(m[1]); } catch {}
  return out;
}
function bootChecks() {
  const mode = sec.modeInfo(), problems = [];
  console.log(`[mode] ${mode.production ? `production (${mode.reasons.join(', ')})` : 'development'}; demo/mock routes ${sec.demoAllowed() ? 'ON' : 'OFF'}${mode.production && sec.demoAllowed() ? ' (DEMO_MODE=1)' : ''}; twilio ${live ? 'live' : 'log-only'}; stripe ${env.STRIPE_SECRET_KEY ? 'on' : 'mock'}`);
  if (!mode.production) return problems;
  const pw = env.ADMIN_PASSWORD || '';
  if (!pw) problems.push('ADMIN_PASSWORD is not set (admin disabled)');
  else if (pw.length < 16 || [...placeholderPasswords()].some((p) => sec.safeEqual(p, pw))) problems.push('ADMIN_PASSWORD is weak (shorter than 16 characters or the .env.example placeholder)');
  if (!env.OWNER_PHONE || env.OWNER_PHONE === sec.PLACEHOLDER_PHONE) console.error('[security] WARNING: OWNER_PHONE is not set: owner alerts are recorded on /admin but not texted.');
  for (const p of problems) console.error(`[security] WARNING: ${p}. Set a long random ADMIN_PASSWORD (20+ chars).`);
  return problems;
}
app.locals.bootChecks = bootChecks;

// Storage durability check after store.init(). In production, file storage means opt-outs (and leads/settings) live on
// Render's ephemeral disk and vanish on the next restart/deploy.
//  - Production with DATABASE_URL set: always fail closed (exit) if Postgres can't be reached, after
//    REQUIRE_POSTGRES_RETRIES attempts (default 5, 3s apart) so a brief blip doesn't crash-loop. Render then keeps the
//    previous deploy live / restarts the service. No env flag needed; to run on files deliberately, unset DATABASE_URL.
//  - REQUIRE_POSTGRES=1 also makes "no DATABASE_URL" fatal (and applies outside production).
//  - Production without DATABASE_URL (and no flag): loud warning + one owner alert, keeps serving.
// Returns { ok, fatal, message }.
function storagePolicy() {
  const configured = store.status().configured;
  const requirePg = sec.on(process.env.REQUIRE_POSTGRES);
  if (requirePg) return { failClosed: true, why: 'REQUIRE_POSTGRES=1' };
  if (configured && sec.isProduction()) return { failClosed: true, why: 'production with DATABASE_URL' };
  return { failClosed: false, why: configured ? 'development' : 'no DATABASE_URL' };
}
async function initStorage({ retries, retryDelayMs = 3000 } = {}) {
  const pol = storagePolicy();
  const tries = pol.failClosed ? Math.max(1, retries ?? sec.num(process.env.REQUIRE_POSTGRES_RETRIES, 5)) : 1;
  for (let i = 1; ; i++) {
    await store.init();
    if (store.backend() === 'postgres' || i >= tries || !store.status().configured) break;
    console.error(`[store] postgres not reachable (attempt ${i}/${tries}); retrying in ${Math.round(retryDelayMs / 1000)}s (fail-closed: ${pol.why})`);
    await sec.sleep(retryDelayMs);
  }
  const r = await storageCheck(pol);
  console.log(`[store] storage ${store.backend()}; fail-closed ${pol.failClosed ? `ON (${pol.why})` : `off (${pol.why})`}`);
  return r;
}
async function storageCheck(pol = storagePolicy()) {
  const st = store.status();
  if (st.backend === 'postgres') return { ok: true };
  const why = st.configured ? `DATABASE_URL is set but Postgres is unreachable${st.lastError ? ` (${String(st.lastError).slice(0, 120)})` : ''}` : 'DATABASE_URL is not set';
  if (pol.failClosed) {
    const message = `${why}; fail-closed storage (${pol.why}): refusing to start on file storage.`;
    console.error(`[store] FATAL: ${message}`);
    return { ok: false, fatal: true, message };
  }
  if (!sec.isProduction()) return { ok: true, message: 'file storage (development)' };
  const message = `${why}: running on FILE storage. Opt-outs, leads and settings are NOT durable (lost on the next restart/deploy).`;
  console.error(`[store] !!!!!!!!!! WARNING: ${message} Set DATABASE_URL (the app then refuses to start without Postgres).`);
  await owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: storage warning: ${why}. BuzzCall is running on temporary file storage, so opt-outs and leads may be lost on restart. Check the database and restart the service.`).catch(() => {});
  return { ok: false, fatal: false, message };
}
// Runtime Postgres write failures (after a good boot): one owner alert per outage (see store.js spill file).
const storageAlert = ({ reason, since, optedOut = [] }) => {
  const nums = optedOut.length ? ` Opted out during the outage (masked): ${optedOut.join(', ')}.` : '';
  if (reason === 'spill_more') return owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: opt-out during database outage: ${optedOut.join(', ')}. Do not text this number.`);
  console.error(`[store] !!!!!!!!!! WARNING: postgres writes failing${since ? ` since ${since}` : ''} (${reason}); opt-outs are kept in memory and in the local spill file until it recovers.`);
  return owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: storage problem: database writes are failing${since ? ` since ${since}` : ''}. Opt-outs are saved to a local backup file and will be merged when the database is back.${nums} Please check the database.`);
};
store.setDegradedAlert(storageAlert);
app.locals.storageAlert = storageAlert;
app.locals.storagePolicy = storagePolicy;
app.locals.initStorage = initStorage;

module.exports = { app, onPaid, onBooked, bootChecks, runRetention, initStorage };
if (require.main !== module) return; // required by tests: no listener, no signal handlers
// Never let one stray rejection kill the line: log it and keep serving. An uncaught exception leaves the process in an
// unknown state, so it is logged and the process exits (Render restarts it).
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e && e.stack ? e.stack : e); process.exit(1); });
{
  const problems = bootChecks();
  if (problems.length && sec.isProduction() && sec.on(process.env.ADMIN_PASSWORD_STRICT)) { console.error('[security] ADMIN_PASSWORD_STRICT=1: refusing to start.'); process.exit(1); }
}
const port = env.PORT || 3000;
// Load persisted state first (Postgres when DATABASE_URL is set; no-op for file storage), check durability, then accept traffic.
initStorage().then((st) => {
if (st.fatal) process.exit(1);
config.applyTZ(); // the stored override may have just been loaded from Postgres
const daily = () => { runRetention(); reportAreaSkips().catch((e) => console.error('area-code report failed:', e.message)); };
daily(); setInterval(runRetention, 86400000).unref();
setInterval(() => reportAreaSkips().catch(() => {}), 3600000).unref(); // reports each finished UTC day within the hour
const server = app.listen(port, () => console.log(`missedcall-buzz on :${port} (vertical ${booking.cfg().vertical}, trade ${booking.cfg().trade}, twilio ${live ? 'LIVE' : 'LOG-ONLY'}, ai ${env.OPENAI_API_KEY ? 'openai' : 'templates'}, storage ${store.backend()})`));
// Render sends SIGTERM on restart/redeploy: flush pending writes to Postgres before exiting.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => {
  if (stopping) return;
  stopping = true;
  require('./shutdown').drainAndFlush(server, async () => {
    await vendors.close({strict:true}); await store.close(); vendors.healthy(store.root);
  }).then(() => process.exit(0), () => { console.error('[shutdown] Requests or storage did not drain cleanly.'); process.exit(1); });
});
});
