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
const deposits = require('./deposits');
const setupRules = require('./setupRules');
const setupPages = require('./setupPages');
const adminPages = require('./adminPages');
const paymentPages = require('./paymentPages');
const crypto = require('crypto');
const sec = require('./security');
const vendors = require('./vendors');
const mail = require('./email');
const onboarding = require('./onboarding');
const shopContext = require('./shopContext');
const consent = require('./consent');
const { say } = require('./voice');
const smsPage = require('./smsPage');
const outcomes = require('./outcomes'); // outcomes log: every entry point is failure-safe (never breaks call/SMS handling)
const disputes = require('./disputes'); // vendor check-in, no-show disputes, proof, auto-release, repeat-claim flags
const disputePages = require('./disputePages');

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
      event = connect.constructEvent(req.body, req.headers['stripe-signature'] || '', process.env.STRIPE_WEBHOOK_SECRET);
    } else if (unsignedStripeOk()) event = JSON.parse(req.body.toString('utf8')); // dev/mock only
    else return res.status(503).send('Webhook not configured');
  } catch (e) { console.error('stripe webhook rejected:', e.message); return res.status(400).send('Webhook error'); }
  if (!event || typeof event !== 'object' || !event.type) return res.status(400).send('Webhook error');
  const destination = await vendors.stripeShop(event);
  if (!destination) return res.json({ received: true, ignored: 'unassigned or conflicting shop' });
  if (destination.retry) return res.status(503).send('Shop ownership pending; retry this event.');
  const handle = async () => {
  // v2 account notifications are thin events on the Your account scope. They do not carry the account body.
  if (connect.isV2AccountEvent(event.type)) {
    if (!connect.livemodeOk(event)) return res.json({ received: true, ignored: 'livemode mismatch' });
    if (event.id && deposits.eventSeen(event.id)) return res.json({ received: true, duplicate: true });
    try {
      const result = await connect.handleAccountNotification(event);
      if (result && result.ignored) return res.json({ received: true, ignored: result.ignored });
      if (result && result.closed) await booking.voidOpenSessions(result.accountId);
    } catch (e) { console.error('v2 account webhook error:', e.message); return res.status(500).send('connect handler error'); }
    if (shopContext.current()) await vendors.flush(shopContext.current().store);
    if (event.id) deposits.rememberEvent(event.id);
    return res.json({ received: true });
  }
  // Shop subscription events (and subscription-mode checkout) -> billing.js. Deposit checkouts fall through.
  try {
    if (await billing.handleEvent(event)) {
      if (shopContext.current()) await vendors.flush(shopContext.current().store);
      return res.json({ received: true });
    }
  }
  catch (e) { console.error('billing webhook error:', e.message); return res.status(500).send('billing handler error'); }
  // Deposit Checkout Sessions are direct charges on the connected account. They are fulfilled
  // on /stripe/connect/webhook, not here. This endpoint stays for shop subscriptions.
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const s = event.data?.object || {};
    if (!s.mode || s.mode === 'payment') return res.json({ received: true, ignored: 'direct charge; use the connected-account webhook' });
  }
  try { await deposits.handleWebhookEvent(event); } catch (e) { console.error('deposits webhook error:', e.message); }
  res.json({ received: true });
  };
  return destination.shop ? vendors.run(destination.shop.id, handle, { suspended: true }) : handle();
});
// Stripe Connect webhook (endpoint scope "Connected accounts", its own signing secret STRIPE_CONNECT_WEBHOOK_SECRET).
// Direct-charge Checkout Sessions are fulfilled here. event.account must be this shop's account, and a paid
// session must match the booking's stored session id, amount, and currency. Only this shop's account is acted on.
app.post('/stripe/connect/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    if (secret) event = connect.constructEvent(req.body, req.headers['stripe-signature'] || '', secret);
    else if (connect.mode() === 'mock' && sec.demoAllowed()) event = JSON.parse(req.body.toString('utf8')); // dev/mock only
    else return res.status(503).send('Connect webhook not configured');
  } catch (e) { console.error('connect webhook rejected:', e.message); return res.status(400).send('Webhook error'); }
  const ignore = (why) => res.json({ received: true, ignored: why });
  const destination = await vendors.stripeShop(event || {}, true);
  if (!destination) return ignore('unassigned or conflicting shop');
  const handle = async () => {
  const acct = connect.accountId();
  const eventAcct = connect.eventAccountId(event);
  if (!event || !eventAcct || !acct || eventAcct !== acct) return ignore('account mismatch');
  if (!connect.livemodeOk(event)) return ignore('livemode mismatch');
  if (event.id && deposits.eventSeen(event.id)) return res.json({ received: true, duplicate: true });
  const o = event.data?.object || {};
  try {
    switch (event.type) {
      case 'checkout.session.completed': case 'checkout.session.async_payment_succeeded': {
        if (o.mode && o.mode !== 'payment') return ignore('not a deposit');
        if (o.payment_status === 'unpaid') return ignore('unpaid');
        const id = o.metadata?.bookingId;
        const b = id && store.findBooking(id);
        const problem = deposits.sessionProblem(o, b);
        if (problem) return ignore(problem);
        if (b.connectAccount && b.connectAccount !== event.account) return ignore('booking account mismatch');
        let payment = deposits.chargeFromSession(o);
        if (!payment.chargeId && payment.paymentIntentId && process.env.STRIPE_SECRET_KEY) {
          try {
            const stripe = connect.stripe();
            if (stripe.paymentIntents?.retrieve) {
              const pi = await stripe.paymentIntents.retrieve(payment.paymentIntentId, {}, { stripeAccount: event.account });
              const latest = pi && pi.latest_charge;
              payment.chargeId = typeof latest === 'string' ? latest : latest?.id || null;
              payment.cardFingerprint = payment.cardFingerprint || latest?.payment_method_details?.card?.fingerprint || null;
            }
          } catch (e) { console.error('[deposits] payment intent retrieve failed:', e.message); }
        }
        await onPaid(id, { ...payment, sessionId: o.id, livemode: event.livemode, email: b.email || null });
        break;
      }
      case 'checkout.session.async_payment_failed': {
        const b = store.findBooking(o.metadata?.bookingId);
        if (b && b.stripeSessionId === o.id && !b.paid) { b.paymentFailed = true; store.save(); }
        break;
      }
      case 'charge.refunded': {
        const d = deposits.findByPaymentIntent(typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id)
          || deposits.list().find((x) => x.chargeId === o.id);
        if (!d) return ignore('unknown charge');
        deposits.mirrorRefund(d, o.amount_refunded != null ? o.amount_refunded : o.amount, { reason: 'charge.refunded' });
        await platformAlert(`BUZZ ${shopContext.current()?.shop?.name || env.BUSINESS_NAME || 'Shop'}: vendor refund on booking ${d.bookingId} ($${((d.refundedCents || 0) / 100).toFixed(2)} of $${((d.amountCents || 0) / 100).toFixed(2)}). The shop refunded in Stripe. Customer ${sec.maskPhone(d.phone || '')}.`, 'BuzzCall: vendor refund');
        break;
      }
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed': {
        const chargeId = typeof o.charge === 'string' ? o.charge : o.charge?.id;
        const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
        const d = deposits.findByPaymentIntent(pi) || deposits.list().find((x) => x.chargeId === chargeId);
        if (!d) return ignore('unknown charge');
        deposits.mirrorDispute(d, o, { closed: event.type === 'charge.dispute.closed' });
        const shopName = shopContext.current()?.shop?.name || env.BUSINESS_NAME || 'Shop';
        const closed = event.type.endsWith('closed');
        await owner(null, `BUZZ ${shopName}: card dispute ${o.id || ''} ${closed ? 'closed' : 'opened'} on booking ${d.bookingId}. The shop handles it in Stripe. Customer ${sec.maskPhone(d.phone || '')}.`);
        await platformAlert(`BUZZ ${shopName}: card dispute ${o.id || ''} ${closed ? 'closed' : 'opened'} on booking ${d.bookingId}. The shop handles it in Stripe. Customer ${sec.maskPhone(d.phone || '')}.`, closed ? 'BuzzCall: dispute closed' : 'BuzzCall: card dispute');
        break;
      }
      case 'radar.early_fraud_warning.created':
      case 'radar.early_fraud_warning.updated': {
        const chargeId = typeof o.charge === 'string' ? o.charge : o.charge?.id;
        const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
        const d = deposits.findByPaymentIntent(pi) || deposits.list().find((x) => x.chargeId === chargeId);
        if (!d) return ignore('unknown charge');
        d.fraudWarning = { id: o.id || null, fraudType: o.fraud_type || null, actionable: o.actionable !== false, at: new Date().toISOString() };
        d.updatedAt = new Date().toISOString();
        store.save();
        await platformAlert(`BUZZ ${shopContext.current()?.shop?.name || env.BUSINESS_NAME || 'Shop'}: early fraud warning ${o.id || ''} on booking ${d.bookingId}. The shop handles it in Stripe. BuzzCall did not refund this direct charge. Customer ${sec.maskPhone(d.phone || '')}.`, 'BuzzCall: fraud warning');
        break;
      }
      case 'account.updated':
        connect.applyAccount(o);
        connect.syncDepositPause(o);
        break;
      case 'account.application.deauthorized':
        connect.deauthorize();
        connect.markDepositsPaused('deauthorized');
        await booking.voidOpenSessions(event.account);
        await owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: Stripe was disconnected. Deposit links are stopped and open checkout sessions are voided. The shop keeps any payment already taken and refunds it in Stripe.`);
        break;
      default:
        if (connect.isV2AccountEvent(event.type)) {
          const result = await connect.handleAccountNotification(event);
          if (result && result.ignored) return ignore(result.ignored);
          if (result && result.closed) {
            await booking.voidOpenSessions(result.accountId);
            await owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: Stripe was disconnected. Deposit links are stopped and open checkout sessions are voided. The shop keeps any payment already taken and refunds it in Stripe.`);
          }
          break;
        }
        return ignore('unhandled type');
    }
  } catch (e) { console.error('connect webhook error:', e.message); return res.status(500).send('connect handler error'); }
  if (shopContext.current()) await vendors.flush(shopContext.current().store);
  if (event && event.id) deposits.rememberEvent(event.id);
  res.json({ received: true });
  };
  return destination.shop ? vendors.run(destination.shop.id, handle, { suspended: true }) : handle();
});
// Vendor proof forms carry one client-compressed photo (data URL), so they get a larger body limit; everything else 100kb.
const PROOF_UPLOAD = /^\/(v\/proof\/[^/]+|vendor\/disputes\/[^/]+\/proof)$/;
const bodyParsers = (limit) => [express.urlencoded({ extended: false, limit }), express.json({ limit })];
{
  const [smallForm, smallJson] = bodyParsers('100kb'), [bigForm, bigJson] = bodyParsers('1mb');
  app.use((req, res, next) => (PROOF_UPLOAD.test(req.path) && req.method === 'POST' ? bigForm : smallForm)(req, res, next));
  app.use((req, res, next) => (PROOF_UPLOAD.test(req.path) && req.method === 'POST' ? bigJson : smallJson)(req, res, next));
}
// Central CSRF guard: every state-changing request (anything but GET/HEAD/OPTIONS) to an admin or billing endpoint
// (/admin/*, /api/billing/*, /billing/*, including the mock billing routes) must come from this site. Registered once,
// before every such route, so a new route can't forget it. Case-insensitive because Express routing is.
// Private business/payment pages must never be stored in shared caches or leak capability URLs as referrers.
app.use((req, res, next) => {
  if (/^\/(admin|vendor|v|api\/billing|billing|pay|payment)(\/|$)/i.test(req.path)) {
    res.set('Cache-Control', 'private, no-store');
    res.set('Referrer-Policy', 'no-referrer');
  }
  next();
});
const ORIGIN_GUARDED = /^\/(admin|vendor|v|onboarding|api\/billing|billing)(\/|$)/i;
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
  const biz = consent.shopName();
  if (!biz) return; // sms.js would block it anyway: never text without the shop's name
  const msg = env.INACTIVE_MESSAGE ? consent.named(env.INACTIVE_MESSAGE, biz) : (agent.isAppointments() && agent.solo()
    ? `Hi, this is ${biz}. Sorry I missed your call! Please try calling again later. Reply STOP to opt out, HELP for help. Msg & data rates may apply.`
    : `Hi, this is ${biz}. Sorry we missed your call! Please try calling again later. Reply STOP to opt out, HELP for help. Msg & data rates may apply.`);
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
// Called ONLY after the caller pressed 1 at the voice consent prompt (/twilio/voice/consent).
async function startTextBack(phone) {
  if (!consent.shopName()) { console.error('[textback] skipped: the shop has no business name (no texts without it)'); return false; }
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

// Can this caller be offered texts at all? Non-US/Canada / anonymous caller IDs, opted-out and paused numbers, and a
// shop without a name never hear the opt-in prompt (nothing would be sent).
async function missedCallTwiml(phone) {
  if (!consent.shopName()) { await noNameAlert(shopContext.current()?.id || null, 'missed call'); return `${say(missedSayNoText())}<Hangup/>`; }
  if (!sec.isNanp(phone)) {
    const why = sec.nanpReason(phone);
    console.log(`[textback] no opt-in prompt for caller id ${phone ? sec.maskPhone(String(phone).slice(0, 20)) : '(blank)'}: ${why}`);
    if (why === 'non-US/Canada NANP area code' || why === 'not a US/Canada area code') recordAreaSkip(String(phone).slice(2, 5)); // never toll-free/premium/non-geographic
    return `${say(missedSayNoText())}<Hangup/>`;
  }
  if (store.isOptedOut(phone) || store.isPaused(phone)) return `${say(missedSayNoText())}<Hangup/>`;
  return consent.gatherTwiml(BASE);
}
const consentNoTextSay = () => 'Thanks. We were not able to send a text right now. Please try calling again later. Goodbye.';
let noNameAlertedAt = new Map();
async function noNameAlert(shopId, where) {
  const key = shopId || 'legacy';
  if (Date.now() - (noNameAlertedAt.get(key) || 0) < 3600000) return;
  noNameAlertedAt.set(key, Date.now());
  const who = shopId ? `vendor ${shopId.slice(0, 8)}` : 'the legacy line';
  const msg = `BUZZ platform: ${who} has no business name, so BuzzCall is not texting its callers (${where}). Set the business name before this line sends any texts.`;
  console.error(`[compliance] ${msg}`);
  try { await platformAlert(msg, 'BuzzCall: texts blocked, business name missing'); } catch (e) { console.error('no-name alert failed:', e.message); }
}
sms.setNoNameAlert(({ shopId } = {}) => noNameAlert(shopId, 'outbound text'));
app.locals.resetNoNameAlerts = () => { noNameAlertedAt = new Map(); };

// Instant owner buzz: ONE short SMS to the shop owner per missed call (on top of the end-of-conversation buzz).
// INSTANT_MISSED_BUZZ=0 turns it off (default on). The wording needs the press-1 outcome, so:
//  - caller hears the opt-in prompt -> buzz from /twilio/voice/consent as soon as they answer (1, other key or no
//    input); if they hang up during the prompt Twilio never posts the consent result, so a fallback timer
//    (INSTANT_MISSED_BUZZ_FALLBACK_SECONDS, default 60) sends the "didn't opt in" buzz instead;
//  - caller isn't offered texts (opted out / paused / no shop name) -> buzz right away.
// Deduped by CallSid in the shop's own store (db.missedBuzzes, 24h), so repeated status callbacks, the consent
// callback and the fallback timer can never buzz twice. Anonymous/blank/non-US-Canada caller IDs (sec.isNanp) get
// no buzz: there is no number to call back, and it keeps robocall/toll-fraud floods from turning into owner SMS.
// Lapsed shops (billing.access) get none. Owner alerts don't count toward caller text caps, so a separate per-line
// ceiling (INSTANT_MISSED_BUZZ_MAX_PER_HOUR, default 30) bounds a call flood.
const instantBuzzOn = () => String(env.INSTANT_MISSED_BUZZ ?? '').trim() !== '0';
const instantBuzzFallbackMs = () => sec.num(process.env.INSTANT_MISSED_BUZZ_FALLBACK_SECONDS, 60) * 1000;
const instantBuzzTimers = new Map();
let instantBuzzLimit = null, instantBuzzLimitMax = null;
const instantBuzzKey = (callSid) => `${shopContext.shopId() || 'legacy'}:${callSid}`;
const validCallSid = (s) => typeof s === 'string' && /^[A-Za-z0-9]{1,80}$/.test(s);
const MISSED_BUZZ_OUTCOMES = {
  texting: 'Pressed 1 - texting them now.',
  not_sent: 'Pressed 1 but no text went out - call them back.',
  no_optin: "Didn't opt in to texts - call them back.",
  opted_out: 'Opted out of texts - call them back.',
};
const missedBuzzText = (from, outcome) => `BUZZ ${env.BUSINESS_NAME || ''}: Missed call from ${from} just now. ${MISSED_BUZZ_OUTCOMES[outcome] || MISSED_BUZZ_OUTCOMES.no_optin}`;
function missedBuzzSeen(callSid) {
  const t = (store.db.missedBuzzes ||= {}), now = Date.now();
  for (const [k, v] of Object.entries(t)) if (now - Date.parse(v) >= 86400000) delete t[k];
  return !!t[callSid];
}
// Sends the buzz once per CallSid. Returns true when this call sent it.
async function missedBuzz(callSid, from, outcome) {
  if (!instantBuzzOn() || !validCallSid(callSid)) return false;
  const key = instantBuzzKey(callSid);
  const timer = instantBuzzTimers.get(key);
  if (timer) { clearTimeout(timer); instantBuzzTimers.delete(key); }
  if (!sec.isNanp(from) || missedBuzzSeen(callSid)) return false;
  store.db.missedBuzzes[callSid] = new Date().toISOString();
  const keys = Object.keys(store.db.missedBuzzes);
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete store.db.missedBuzzes[k];
  store.save();
  if (!billing.access().active) { console.log(`[buzz] no instant buzz for ${sec.maskPhone(from)}: shop subscription inactive`); return false; }
  const max = sec.num(process.env.INSTANT_MISSED_BUZZ_MAX_PER_HOUR, 30);
  if (max > 0) {
    if (!instantBuzzLimit || instantBuzzLimitMax !== max) { instantBuzzLimit = sec.limiter({ windowMs: 3600000, max }); instantBuzzLimitMax = max; }
    if (!instantBuzzLimit.hit(shopContext.shopId() || 'legacy').ok) { console.error(`[buzz] instant missed-call buzz limit reached (${max}/hour) on this line: not buzzing for ${sec.maskPhone(from)}`); return false; }
  }
  await owner(null, missedBuzzText(from, outcome));
  outcomes.ownerBuzzed(callSid, outcome);
  return true;
}
// Called when a call is determined missed. `offered` = the caller hears the press-1 prompt (consent callback buzzes).
async function armMissedBuzz(callSid, from, offered) {
  if (!instantBuzzOn() || !validCallSid(callSid)) return;
  if (!sec.isNanp(from)) { console.log(`[buzz] no instant buzz: caller id ${from ? sec.maskPhone(String(from).slice(0, 20)) : '(blank)'} is ${sec.nanpReason(from)}`); return; }
  if (missedBuzzSeen(callSid)) return;
  if (!offered) return void await missedBuzz(callSid, from, store.isOptedOut(from) || store.isPaused(from) ? 'opted_out' : 'no_optin');
  const key = instantBuzzKey(callSid);
  if (instantBuzzTimers.has(key)) return;
  // Timers keep the request's shop context (AsyncLocalStorage), so the fallback reaches the right owner and store.
  const timer = setTimeout(() => {
    instantBuzzTimers.delete(key);
    missedBuzz(callSid, from, 'no_optin').catch((e) => console.error('instant buzz failed:', e.message));
  }, instantBuzzFallbackMs());
  timer.unref?.();
  instantBuzzTimers.set(key, timer);
}
// Webhook handlers don't wait on the owner SMS (the caller's TwiML goes back right away); the dedupe mark is set
// synchronously before the send, so a repeat callback arriving meanwhile still can't buzz twice.
const buzzLater = (p) => { p.catch((e) => console.error('instant buzz failed:', e.message)); };
app.locals.instantBuzzPending = () => instantBuzzTimers.size;
app.locals.resetInstantBuzz = () => { for (const t of instantBuzzTimers.values()) clearTimeout(t); instantBuzzTimers.clear(); instantBuzzLimit = null; };

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
  const xml = await missedCallTwiml(req.body.From); // opt-in prompt; nothing is texted until the caller presses 1
  outcomes.missed({ callSid: req.body.CallSid, from: req.body.From, offered: xml.includes('<Gather') });
  buzzLater(armMissedBuzz(req.body.CallSid, req.body.From, xml.includes('<Gather')));
  twiml(res, xml);
});

// 2) Dial result: no-answer/busy/failed => missed call
app.post('/twilio/voice/status', verifyTwilio, routeTwilio(true), async (req, res) => {
  const s = req.body.DialCallStatus;
  if (recordVendorCall(req, ['no-answer','busy','failed','canceled'].includes(s) ? 'missed' : s === 'completed' ? 'answered' : 'ringing') === false) return twiml(res, '<Hangup/>');
  if (['no-answer', 'busy', 'failed', 'canceled'].includes(s)) {
    const xml = await missedCallTwiml(req.body.From); // same consent gate
    outcomes.missed({ callSid: req.body.CallSid, from: req.body.From, offered: xml.includes('<Gather') });
    buzzLater(armMissedBuzz(req.body.CallSid, req.body.From, xml.includes('<Gather')));
    return twiml(res, xml);
  }
  twiml(res, '<Hangup/>');
});

// 2b) Consent prompt result (<Gather action>). Signed like every Twilio webhook; vendor calls must match a call this
// line routed (routeTwilio callback mode). Every outcome is logged; only Digits=1 starts the text-back.
app.post('/twilio/voice/consent', verifyTwilio, routeTwilio(true), async (req, res) => {
  const from = req.body.From, digits = String(req.body.Digits ?? '');
  if (!consent.shopName()) { await noNameAlert(shopContext.current()?.id || null, 'consent'); return twiml(res, `${say(missedSayNoText())}<Hangup/>`); }
  const entry = await consent.record({ callSid: req.body.CallSid, from, digits });
  const call = shopContext.current() && (store.db.calls || []).find((c) => c.id === req.body.CallSid);
  if (call) { call.consent = entry.consented ? 'yes' : entry.digits ? 'declined' : 'no_input'; store.save(); }
  if (!entry.consented) {
    outcomes.consent({ callSid: req.body.CallSid, from, digits: entry.digits, consented: false });
    buzzLater(missedBuzz(req.body.CallSid, from, 'no_optin')); return twiml(res, consent.goodbyeTwiml(entry.digits));
  }
  const texted = sec.isNanp(from) ? await startTextBack(from) : false;
  outcomes.consent({ callSid: req.body.CallSid, from, digits: entry.digits, consented: true, texted });
  buzzLater(missedBuzz(req.body.CallSid, from, texted ? 'texting' : 'not_sent'));
  twiml(res, `${say(texted ? missedSay() : consentNoTextSay())}<Hangup/>`);
});

// Record an opt-out durably before answering (Postgres write-through), but never hold the webhook past 5s.
const optOutNow = (phone, source) => Promise.race([store.optOut(phone, source), sec.sleep(5000)]);

// 3) Caller SMS replies
app.post('/twilio/sms', verifyTwilio, routeTwilio(), async (req, res) => {
  const from = req.body.From, body = String(req.body.Body || '');
  if (!sec.isNanp(from)) return twiml(res, ''); // never text non-US/CA or anonymous senders
  const kw = optout.classify(body);
  const biz = consent.shopName(); // '' blocks every caller text in sms.js (and alerts the admin)
  // KEYWORD_REPLIES=twilio: Twilio Advanced Opt-Out sends the STOP/START confirmations, the app stays silent for exact
  // keywords (STOP, START, HELP). Default (app): the app sends the shop-named confirmations. With Twilio's own STOP handling on, Twilio
  // blocks the app's STOP confirmation (error 21610) and only Twilio's reply reaches the caller.
  const appKeywordReplies = String(process.env.KEYWORD_REPLIES || 'app').toLowerCase() !== 'twilio';
  if (kw === 'optout') { // exact Twilio keyword
    const already = store.isOptedOut(from); // confirm once, then silence (like every other opt-out)
    await optOutNow(from, 'keyword'); await owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: ${from} replied ${body.trim().slice(0, 20)} and is opted out of texts.`);
    if (appKeywordReplies && biz && !already) await sendSms(from, consent.stopText(biz), { force: true });
    return twiml(res, '');
  }
  if (kw === 'revoke') { // any other opt-out (keyword variant or plain language): exactly one confirmation, then silence
    if (!store.isOptedOut(from)) {
      await optOutNow(from, 'message');
      // Spanish opt-outs (basta, no me escriban, ...) get a bilingual confirmation; Twilio doesn't handle those keywords.
      const en = consent.stopText(biz);
      const es = 'Se canceló su suscripción y no recibirá más mensajes. Responda START para volver a suscribirse.';
      await sendSms(from, optout.language(body) === 'es' ? `${en} / ${es}` : en, { force: true });
      await owner(null, `BUZZ ${env.BUSINESS_NAME || ''}: ${from} asked not to be texted ("${body.trim().slice(0, 60)}") and is opted out.`);
    }
    return twiml(res, '');
  }
  if (kw === 'optin' && (store.isOptedOut(from) || optout.letters(body) !== 'YES')) {
    await Promise.race([store.optIn(from), sec.sleep(5000)]); store.resumeBot(from);
    if (appKeywordReplies && biz) await sendSms(from, consent.startText(biz));
    return twiml(res, '');
  }
  if (kw === 'help') { // in twilio mode Twilio's HELP auto-reply answers; the app stays silent to avoid a double reply
    if (appKeywordReplies && biz) await sendSms(from, env.HELP_MESSAGE ? consent.named(env.HELP_MESSAGE, biz) : consent.helpText(biz), { force: true });
    return twiml(res, '');
  }
  if (store.isOptedOut(from)) return twiml(res, ''); // opted out: no conversation until START
  // The shop owner's own phone replying while a no-show claim is open: the text / MMS photo is the vendor's proof.
  const proof = disputes.handleVendorMessage(from, body, req.body, { base: BASE });
  if (proof) {
    if (proof.reply) await sendSms(from, proof.reply, { kind: 'owner' });
    if (proof.adminAlert) await platformAlert(proof.adminAlert, 'BuzzCall: vendor sent no-show proof');
    return twiml(res, '');
  }
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
  // Optional email step (OUTCOMES_EMAIL_STEP=1, default off): a reply to "Want a confirmation by email?" after booking.
  const emailStep = outcomes.emailReply(from, body, { base: BASE, sendVerify: (to, link) => mail.outcomeVerify(to, link, consent.shopName()) });
  if (emailStep) { await sendSms(from, emailStep.reply); return twiml(res, ''); }
  // No-show check YES/NO: only when a check is pending for this number (does not collide with booking conversation).
  const noshow = deposits.handleNoshowReply(from, body, { base: BASE });
  if (noshow) {
    if (noshow.reply) await sendSms(from, noshow.reply);
    if (noshow.vendorText) await owner(null, noshow.vendorText); // the shop owner (vendor) in this shop's context
    if (noshow.adminAlert) await platformAlert(noshow.adminAlert, 'BuzzCall: no-show claim');
    return twiml(res, '');
  }
  // KEEP: only while a dispute follow-up ("Reply KEEP to keep your claim") is pending for this number.
  const keep = disputes.handleKeep(from, body, { base: BASE });
  if (keep) {
    if (keep.reply) await sendSms(from, keep.reply);
    if (keep.adminAlert) await platformAlert(keep.adminAlert, 'BuzzCall: no-show claim needs review');
    return twiml(res, '');
  }
  let lead = store.findOpenLead(from) || store.createLead(from);
  lead.messages.push({ dir: 'in', body });
  const { reply, completed, booking: b } = await agent.handleReply(lead, body);
  outcomes.conversation(from, lead);
  if (b) { await onBooked(lead, b); return twiml(res, ''); }
  lead.messages.push({ dir: 'out', body: reply }); store.save();
  await sendSms(from, reply);
  if (completed) await buzzOwner(lead);
  twiml(res, '');
});

// Public per-shop SMS program page (A2P 10DLC): /s/<slug>/sms. Public fields only (shop name, its BuzzCall number,
// the voice opt-in script, sample messages). Never the owner's phone or email.
app.get('/s/:slug/sms', async (req, res) => {
  const page = await smsPage.find(req.params.slug);
  if (!page) return res.status(404).type('text').send('Not found');
  const render = () => {
    const html = smsPage.render({ number: page.number });
    if (!html) return res.status(404).type('text').send('Not found');
    res.set('Cache-Control', 'public, max-age=300').type('html').send(html);
  };
  return page.shop ? vendors.run(page.shop.id, render) : shopContext.run(null, render);
});

const tag = (lead) => `${lead.urgent ? '🚨 URGENT ' : ''}`;
const owner = async (leadId, msg) => { store.addAlert({ leadId, to: env.OWNER_PHONE, body: msg }); await sendSms(env.OWNER_PHONE || sec.PLACEHOLDER_PHONE, msg, { kind: 'owner' }); };
// Outbound caps (src/sms.js). The platform administrator always hears about it (platform OWNER_PHONE, the platform
// alert log and ADMIN_ALERT_EMAIL); a vendor whose own line hit its limit also gets a plain-language note.
const capWindow = (per) => (per === 'day' ? '24-hour window' : 'hour');
async function platformAlert(msg, subject) {
  await shopContext.run(null, () => owner(null, msg));
  mail.adminAlert(subject, msg);
}
deposits.setAlert((msg, subject) => platformAlert(msg, subject));
sms.setCapAlert(async ({ scope, per = 'hour', max, shopId, shopName } = {}) => {
  if (scope === 'shop' && shopId) {
    const who = `${String(shopName || 'Vendor').slice(0, 80)} (vendor ${shopId.slice(0, 8)})`;
    await platformAlert(`BUZZ platform: ${who} reached its per-line text limit (${max}/${per}). Its text-backs are paused until the ${capWindow(per)} resets. If this wasn't a real rush, it may be SMS pumping: check Twilio logs. Adjust the vendor's limit in /admin or OUTBOUND_SHOP_MAX_PER_${per === 'day' ? 'DAY' : 'HOUR'} if needed.`,
      `BuzzCall: text limit reached for ${String(shopName || 'a vendor').slice(0, 60)}`);
    await owner(null, `BuzzCall: your line reached its automatic texting limit for ${per === 'day' ? 'today' : 'this hour'}, so new missed-call texts are paused until it resets. Missed calls still show in your dashboard. BuzzCall has been notified and will follow up.`);
    return;
  }
  const line = scope === 'shop' ? 'per-line' : 'platform-wide';
  await platformAlert(`BUZZ ${env.BUSINESS_NAME || ''}: outbound text limit reached (${max}/${per}) ${line === 'per-line' ? 'on this line' : 'across all lines'}. Text-backs are paused until the ${capWindow(per)} resets. If this wasn't a real rush, it may be SMS pumping: check Twilio logs. Raise ${scope === 'shop' ? `OUTBOUND_SHOP_MAX_PER_${per === 'day' ? 'DAY' : 'HOUR'}` : per === 'day' ? 'OUTBOUND_MAX_PER_DAY' : 'OUTBOUND_MAX_PER_HOUR'} if needed.`,
    'BuzzCall: outbound text limit reached');
});

async function onBooked(lead, b) {
  let msg;
  if (b.status === 'held') {
    let url;
    try { url = await booking.depositLink(b, BASE); } catch (e) { console.error('deposit link failed:', e.message); }
    // Platform charges: Connect is optional (payout pending). Only skip if depositLink hard-failed with no URL.
    if (url === null) booking.skipDeposit(b, 'deposit_unavailable');
  }
  if (b.status === 'held') {
    const c = booking.cfg();
    msg = b.payUrl ? agent.texts.held(lead.name, b, c.holdMin, b.payUrl) : agent.texts.heldNoLink(lead.name, b);
  } else msg = agent.texts.bookedNoDeposit(lead.name, b);
  lead.messages.push({ dir: 'out', body: msg }); store.save();
  await sendSms(lead.phone, msg);
  outcomes.booked(lead, b);
  const ask = outcomes.askEmail(lead); // null unless OUTCOMES_EMAIL_STEP=1
  if (ask) { lead.messages.push({ dir: 'out', body: ask }); store.save(); await sendSms(lead.phone, ask); }
  const status = b.status === 'held' ? `slot held, deposit pending ($${b.amount}, hold expires ${new Date(b.holdExpiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})`
    : b.depositSkipped ? `BOOKED (no deposit; deposit off: ${b.depositSkipped})` : 'BOOKED (no deposit)';
  const arrive = b.status === 'confirmed' ? checkinNote(b) : '';
  if (b.service) await owner(lead.id, `BUZZ ${env.BUSINESS_NAME || ''}: ${status.replace('slot held', 'time held')}: ${lead.name || 'Caller (name not given)'}, ${lead.need}, ${b.slotLabel}. tel:${lead.phone}${arrive}`);
  else await owner(lead.id, `${tag(lead)}BUZZ ${env.BUSINESS_NAME || ''}: ${status}: ${lead.name || 'Caller (name not given)'}, ${lead.need}, ${b.slotLabel}. Tap to call: tel:${lead.phone}${arrive}`);
}
// Vendor's signed one-tap "I'm here" link (src/disputes.js), appended to the booking buzz once the booking is confirmed
// (no deposit: at booking; deposit: in the BOOKED + PAID buzz).
const checkinNote = (b) => ` Tap when you arrive: ${disputes.checkinLink(BASE, b)}`;

const money = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(2));
const feeNote = (b) => b.lead_fee_status === 'waived' ? 'lead fee waived (pilot)' : `lead fee $${money(b.lead_fee || 0)}${b.lead_fee_status === 'collected' ? ' (auto-deducted)' : ''}`;

// Deposits are direct charges on the shop's Stripe account (src/deposits.js). BuzzCall does not hold or transfer them.
const refundNote = () => '. The customer paid your Stripe account directly. Refunds and disputes are handled in your Stripe Dashboard.';
async function onPaid(id, payment = {}) {
  const { booking: b, changed, conflict } = booking.markPaid(id);
  if (!b || !changed) return b;
  if (!conflict) {
    outcomes.paid(b);
    try { deposits.onBookingPaid(b, payment); } catch (e) { console.error('deposits.onBookingPaid failed:', e.message); }
  }
  const lead = store.db.leads.find((l) => l.id === b.leadId) || { id: b.leadId, phone: b.phone, name: b.name, need: b.need };
  if (conflict) {
    await sendSms(b.phone, agent.texts.paidConflict(b));
    await owner(b.leadId, `⚠️ PAID BUT SLOT LOST $${b.amount}: ${b.name || 'Caller (name not given)'}, ${b.need}, ${b.slotLabel} (hold expired). Reschedule/refund (lead fee on hold for review). Tap to call: tel:${b.phone}`);
    return b;
  }
  const msg = agent.texts.paid(b);
  if (lead.messages) { lead.messages.push({ dir: 'out', body: msg }); store.save(); }
  await sendSms(b.phone, msg);
  if (b.service) { // appointment trades: 'BOOKED + PAID: <name>, <service>, <time>, $50 deposit'
    await owner(b.leadId, `BOOKED + PAID: ${b.name || 'Caller (name not given)'}, ${b.service}, ${b.slotLabel}, $${money(b.amount)} deposit${b.details ? `. Notes: ${b.details}` : ''}. tel:${b.phone}${refundNote(b)}${checkinNote(b)}`);
  } else await owner(b.leadId, `${tag(lead)}BOOKED + PAID $${b.amount}: ${b.name || 'Caller (name not given)'}, ${b.need}, ${b.slotLabel}, ${feeNote(b)}, tel:${b.phone}${refundNote(b)}${checkinNote(b)}`);
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
    ? `BUZZ ${env.BUSINESS_NAME || ''}: ${lead.name || 'Caller (name not given)'} (${lead.phone}) wants: ${lead.need}. Call back: ${lead.window}. tel:${lead.phone}`
    : `${lead.urgent ? '🚨 URGENT ' : ''}BUZZ ${env.BUSINESS_NAME || ''}: ${lead.name || 'Caller (name not given)'} (${lead.phone}) needs: ${lead.need}. Callback: ${lead.window}. Tap to call: tel:${lead.phone}`;
  store.addAlert({ leadId: lead.id, to: env.OWNER_PHONE, body: msg });
  await sendSms(env.OWNER_PHONE || sec.PLACEHOLDER_PHONE, msg, { kind: 'owner' });
}

// Public form throttles (per client IP).
const formLimit = (name, max) => sec.rateLimit({ windowMs: sec.num(process.env.FORM_RATE_WINDOW_MINUTES, 10) * 60000, max: sec.num(process.env[name], max) });
const waitlistLimit = formLimit('WAITLIST_RATE_MAX', 30), setupLimit = formLimit('SETUP_RATE_MAX', 20), checkoutLimit = formLimit('CHECKOUT_RATE_MAX', 30);
app.locals.resetFormLimits = () => { waitlistLimit.reset(); setupLimit.reset(); checkoutLimit.reset(); verifyLimit.reset(); };
// Waitlist
app.post('/api/waitlist', waitlistLimit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
  const { businessType } = req.body;
  if (businessType !== undefined && businessType !== '' && !store.WAITLIST_TYPES.includes(businessType)) {
    return res.status(400).json({ error: 'invalid business type' });
  }
  if (!store.addWaitlist(email, businessType)) return res.status(503).json({ error: 'waitlist is full' });
  mail.signup('waitlist', { email, businessType }); // async, never blocks or fails the form
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
// Public self-serve checkout is retired: every new business signs up through /setup and is reviewed before activation.
// What remains is a platform-admin tool for the retained single-shop (legacy) mode only: Basic auth + same Origin.
app.post('/api/checkout', checkoutLimit, async (req, res) => {
  if (!(req.headers.authorization && isAdmin(req) && originCheck(req) === 'ok')) {
    return res.status(410).json({ error: 'Sign up through the setup form. We review every setup before activation.', next: '/setup' });
  }
  if (vendors.all().length) return res.status(409).json({ error: 'Vendor subscriptions are started from the vendor dashboard.', next: '/vendor/login' });
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
app.post('/setup', setupLimit, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const json = wantsJson(req);
  const captcha = await require('./captcha').check(body.captchaToken || body['cf-turnstile-response'] || body['g-recaptcha-response'], req);
  if (!captcha.ok) return json ? res.status(400).json({ ok: false, error: captcha.error }) : res.status(400).type('html').send(setupPages.errorsHtml([{ message: captcha.error }]));
  const { values, issues, errors, warnings } = setupRules.validate(body);
  if (String(body.website || '').trim()) { // honeypot: bots fill hidden fields; pretend success, store nothing
    return json ? res.json({ ok: true, id: null }) : res.type('html').send(setupPages.thanksHtml({}));
  }
  if (errors.length) return json ? res.status(422).json({ ok: false, errors, warnings, issues }) : res.status(422).type('html').send(setupPages.errorsHtml(errors));
  if (warnings.length && !values.confirm) return json ? res.status(409).json({ ok: false, needsConfirm: true, warnings, issues }) : res.status(409).type('html').send(setupPages.confirmHtml(warnings, body));
  const { confirm, ...saved } = values;
  if (onboarding.enabled() && !sec.isNanp(saved.ownerPhone)) {
    const nanp = [{ field: 'ownerPhone', level: 'error', message: 'Use a US or Canada mobile number, like (404) 555-0100.' }];
    return json ? res.status(422).json({ ok: false, errors: nanp, issues: nanp }) : res.status(422).type('html').send(setupPages.errorsHtml(nanp));
  }
  const s = store.addSetup({ id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(), status: 'pending',
    values: saved, warningsConfirmed: warnings, consentAt: new Date().toISOString() });
  if (!onboarding.enabled()) {
    mail.signup('setup', { email: saved.email, businessType: saved.businessType, businessName: saved.businessName }); // async
    const message = "We'll review your setup and text you within 1 business day.";
    return json ? res.json({ ok: true, id: s.id, message }) : res.type('html').send(setupPages.thanksHtml(saved));
  }
  const sent = await onboarding.sendCode({ setupId: s.id, phone: saved.ownerPhone, ip: sec.clientIp(req), businessName: saved.businessName });
  mail.adminAlert('BuzzCall: self-serve setup started', [`A shop submitted setup and is verifying their alert cell.`, `Business: ${saved.businessName || ''}`, `Email: ${saved.email || ''}`, `Time: ${new Date().toISOString()}`, 'Review it under Platform admin / Onboarding if it needs help.'].join('\n'));
  const message = sent.ok ? 'We texted a 6-digit code to your alert cell. It expires in 10 minutes.' : (sent.error || 'We saved your setup. Request another code in a minute.');
  return json ? res.json({ ok: true, id: s.id, next: 'verify', message }) : res.type('html').send(setupPages.verifyHtml(s.id, saved, message));
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
require('./onboardingRoutes').register(app, { requireAdmin, sameOrigin });
// ---------- Outcomes log (src/outcomes.js) ----------
// Admin: /admin/outcomes (counts per stage + recent records), /admin/outcomes.csv (operations, includes phones/emails),
// /admin/outcomes-training.csv (de-identified: no phone/email/name, salted caller hash, opted-out callers excluded).
async function allOutcomes() {
  const rows = outcomes.recordsOf(store.root), names = { legacy: env.BUSINESS_NAME || 'Legacy line' };
  for (const shop of vendors.all().filter((s) => s.status !== 'provisioning')) {
    names[shop.id] = shop.name;
    try { rows.push(...outcomes.recordsOf(await vendors.scopedStore(shop))); } catch { console.error('[outcomes] a vendor store is unavailable; its outcomes are left out of this view'); }
  }
  rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { rows, names };
}
const csvReply = (res, name, csv) => res.set('Content-Disposition', `attachment; filename="${name}"`).type('text/csv; charset=utf-8').send(csv);
app.get('/admin/outcomes', requireAdmin, async (req, res) => {
  const { rows, names } = await allOutcomes();
  res.type('html').send(require('./workspacePages').outcomes({ counts: outcomes.counts(rows), rows, shopNames: names, maskPhone: sec.maskPhone,
    emailStep: outcomes.emailStepOn(), maxRecords: outcomes.maxRecords() }));
});
app.get('/admin/outcomes.csv', requireAdmin, async (req, res) => csvReply(res, 'outcomes.csv', outcomes.fullCsv((await allOutcomes()).rows)));
app.get('/admin/outcomes-training.csv', requireAdmin, async (req, res) => csvReply(res, 'outcomes-training.csv', outcomes.trainingCsv((await allOutcomes()).rows)));
// Public one-tap email confirmation (OUTCOMES_EMAIL_STEP=1). The token (48 hex) is looked up by its SHA-256 in the
// platform store; the record is updated in its own shop's store. Idempotent. Unknown/expired tokens get a plain 404.
const verifyLimit = formLimit('OUTCOMES_VERIFY_RATE_MAX', 30);
const verifyPage = (ok) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${ok ? 'Email confirmed' : 'Link not valid'} | BuzzCall</title><link rel="stylesheet" href="/styles.css"></head><body><main class="doc"><div class="wrap"><h1>${ok ? 'Thanks, your email is confirmed.' : 'This link is not valid or has expired.'}</h1><p>${ok ? 'You can close this page.' : 'Nothing was changed.'}</p></div></main></body></html>`;
app.get('/o/verify/:token', verifyLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store').set('Referrer-Policy', 'no-referrer');
  let r = null;
  try {
    const e = outcomes.lookupToken(req.params.token);
    const run = () => outcomes.verify(req.params.token);
    if (e) r = e.shopId ? await vendors.run(e.shopId, run, { suspended: true }) : shopContext.run(null, run);
  } catch { r = null; }
  res.status(r ? 200 : 404).type('html').send(verifyPage(!!r));
});
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
  } catch (e) {
    const status = Number(e.status || e.statusCode) || 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    const show = !!(e.expose || (safeStatus >= 400 && safeStatus < 500));
    const message = show && e.message ? e.message : 'Could not start Stripe onboarding. Check the server logs and try again.';
    console.error('connect onboarding failed:', message);
    if (wantsJson(req)) return res.status(safeStatus).json({ error: message });
    res.status(safeStatus).type('text').send(message);
  }
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
app.post('/admin/connect/approve', requireAdmin, async (req, res) => {
  if (!sec.on(req.body?.confirm)) return res.status(409).json({ error: 'Confirm payout approval' });
  const s = connect.approvePayouts();
  if (!s) return res.status(409).json({ error: 'No Connect account to approve' });
  const attached = deposits.attachPayable();
  logMoney(req, 'connect_approve', { accountId: s.accountId, attached });
  await flushShop();
  if (wantsJson(req)) return res.json({ ...connect.summary(), attached });
  res.redirect(303, '/admin#connect');
});
app.post('/admin/connect/mock/complete', connectMockOnly, requireAdmin, (req, res) => {
  const s = connect.mockComplete();
  if (!s) return res.status(409).json({ error: 'start onboarding first' });
  if (wantsJson(req)) return res.json(connect.summary());
  res.redirect(303, '/admin#connect');
});
// ---------- Deposit protection admin (held / scheduled / paused / disputed / released / refunded) ----------
// ?shop=<vendor id> opens a vendor shop's deposits (no param: the legacy/platform line). Admin-only; the id only picks
// which store an authenticated admin is looking at.
const depositShop = (req, res, next) => {
  const id = String(req.query.shop || '');
  if (!id) return next();
  if (!vendors.get(id)) return res.status(404).json({ error: 'shop not found' });
  return vendors.run(id, () => next(), { suspended: true });
};
const shopQs = () => (shopContext.shopId() ? `?shop=${encodeURIComponent(shopContext.shopId())}` : '');
const backToDeposits = (res) => res.redirect(303, `/admin/deposits${shopQs()}`);
const flushShop = async () => { if (shopContext.current()) await vendors.flush(shopContext.current().store); };
app.post('/admin/deposits/archive-non-live', requireAdmin, depositShop, async (req, res) => {
  if (!sec.on(req.body?.confirm)) return res.status(409).json({ error: 'Confirm archive of non-live deposits' });
  const result = deposits.archiveNonLive();
  logMoney(req, 'archive_non_live', result);
  await flushShop();
  if (wantsJson(req)) return res.json(result);
  backToDeposits(res);
});
app.get('/admin/deposits', requireAdmin, depositShop, (req, res) => {
  if (wantsJson(req)) return res.json(deposits.summary());
  res.type('html').send(adminPages.depositsPage({
    businessName: env.BUSINESS_NAME || 'Your business',
    deposits: deposits.summary(),
    connect: connect.summary(),
    demoAllowed: sec.demoAllowed(),
    mode: connect.mode(),
    shopQs: shopQs(),
    shops: vendors.all().filter((s) => s.status !== 'provisioning').map((s) => ({ id: s.id, name: s.name })),
    currentShop: shopContext.shopId(),
  }));
});
app.post('/admin/deposits/:id/refund', requireAdmin, depositShop, async (req, res) => {
  const d = deposits.find(req.params.id);
  if (!d) return res.status(404).json({ error: 'deposit not found' });
  try {
    logMoney(req, 'refund', { depositId: d.id, bookingId: d.bookingId });
    const r = await deposits.refundDeposit(d, { reason: 'admin' });
    await flushShop();
    if (wantsJson(req)) return res.json(r);
    backToDeposits(res);
  } catch (e) { console.error('deposit refund failed:', e.message); return res.status(500).json({ error: 'refund failed' }); }
});
function moneyActor() {
  return sec.adminActor();
}
function logMoney(req, action, extra = {}) {
  const root = store.root;
  const log = (root.db.moneyAudit ||= []);
  log.unshift({ at: new Date().toISOString(), action, actor: moneyActor(req), ip: sec.clientIp(req), shopId: shopContext.shopId() || 'legacy', ...extra });
  if (log.length > 500) log.length = 500;
  root.save();
}
app.post('/admin/deposits/:id/release', requireAdmin, depositShop, async (req, res) => {
  const d = deposits.find(req.params.id);
  if (!d) return res.status(404).json({ error: 'deposit not found' });
  const held = d.status === 'disputed' || d.status === 'paused' || d.payoutPaused || d.cardDispute;
  if (held && !sec.on(req.body?.confirm_release)) {
    return res.status(409).json({ error: 'Confirm force-release of this held deposit', needsConfirm: true });
  }
  try {
    logMoney(req, 'release', { depositId: d.id, bookingId: d.bookingId, held: !!held });
    const r = await deposits.releaseDeposit(d, { force: true, by: moneyActor(req) });
    await flushShop();
    if (wantsJson(req)) return res.json(r);
    backToDeposits(res);
  } catch (e) { console.error('deposit release failed:', e.message); return res.status(500).json({ error: 'release failed' }); }
});
// Plain-text evidence summary (paste into a Stripe dispute response).
app.get('/admin/deposits/:id/evidence.txt', requireAdmin, depositShop, (req, res) => {
  const d = deposits.find(req.params.id);
  if (!d) return res.status(404).type('text').send('deposit not found');
  const text = disputes.evidenceText(d, store.findBooking(d.bookingId), { shop: env.BUSINESS_NAME || d.shopName });
  res.set('Content-Disposition', `attachment; filename="evidence-${d.bookingId.replace(/[^A-Za-z0-9_-]/g, '')}.txt"`).type('text/plain; charset=utf-8').send(text);
});
// A photo the vendor uploaded as proof (portal / proof link). Served only to the admin, only for its own deposit.
app.get('/admin/deposits/:id/photo/:pid', requireAdmin, depositShop, (req, res) => {
  const d = deposits.find(req.params.id);
  const p = d && disputes.getPhoto(d, req.params.pid);
  if (!p) return res.status(404).type('text').send('not found');
  res.set({ 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox" }).type(p.type).send(Buffer.from(p.data, 'base64'));
});
// Stored "require full prepay" flag for a flagged repeat claimer (platform-wide, by salted phone hash).
app.post('/admin/deposits/:id/prepay', requireAdmin, depositShop, (req, res) => {
  const d = deposits.find(req.params.id);
  if (!d) return res.status(404).json({ error: 'deposit not found' });
  logMoney(req, 'prepay', { depositId: d.id, on: sec.on(req.body?.on) });
  const f = disputes.setRequirePrepay(d.phone, sec.on(req.body?.on), { email: d.email, fingerprint: d.cardFingerprint });
  if (!f) return res.status(409).json({ error: 'customer is not flagged' });
  if (wantsJson(req)) return res.json({ ok: true, flag: f });
  backToDeposits(res);
});
// Demo/mock only: fast-forward deposit timers (gated to mock + DEMO_MODE / non-production).
app.post('/admin/deposits/demo/advance', requireAdmin, depositShop, async (req, res) => {
  if (connect.mode() !== 'mock' || !sec.demoAllowed()) return res.status(404).json({ error: 'demo advance unavailable' });
  const hours = Number(req.body?.hours ?? req.query?.hours ?? 24);
  try {
    const r = await deposits.mockAdvance(hours, { sendSms: (to, body) => sendSms(to, body) });
    await flushShop();
    if (wantsJson(req)) return res.json(r);
    backToDeposits(res);
  } catch (e) { return res.status(e.status || 500).json({ error: e.message || 'advance failed' }); }
});

// ---------- Vendor check-in and proof links (signed, single booking, expiring; src/disputes.js) ----------
const disputeLinkLimit = formLimit('DISPUTE_LINK_RATE_MAX', 60);
const linkHeaders = (res, geo = false) => {
  res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  if (geo) res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=()');
};
// Runs fn inside the token's shop. Returns null when the shop is gone.
async function inTokenShop(p, fn) {
  if (!p.s) return shopContext.run(null, fn);
  if (!vendors.get(p.s)) return null;
  return vendors.run(p.s, fn, { suspended: true });
}
const linkMode = () => (connect.mode() === 'mock' && !sec.demoAllowed() ? 'unconfigured' : connect.mode());
async function checkinRoute(req, res) {
  linkHeaders(res, true);
  const p = disputes.readToken(req.params.token, 'ci');
  if (!p) return res.status(404).type('html').send(disputePages.checkinPage({ error: 'not_found', mode: 'live' }));
  const out = await inTokenShop(p, async () => {
    const b = store.findBooking(p.b);
    const w = b ? disputes.windowFor(b) : null;
    const view = { booking: b, shopName: env.BUSINESS_NAME, action: `/v/checkin/${req.params.token}`, windowState: b ? disputes.windowState(b) : 'unknown',
      opensAt: w && new Date(w.opensAt).toISOString(), closesAt: w && new Date(w.closesAt).toISOString(), mode: linkMode() };
    if (!b) return { status: 404, html: disputePages.checkinPage({ ...view, error: 'not_found' }) };
    if (b.vendorCheckIn) return { status: 200, html: disputePages.checkinPage({ ...view, result: { ok: true, already: true, checkIn: b.vendorCheckIn } }) };
    if (disputes.expired(p)) return { status: 410, html: disputePages.checkinPage({ ...view, error: 'expired' }) };
    if (req.method === 'GET') {
      const ws = view.windowState;
      return { status: 200, html: disputePages.checkinPage(ws === 'open' && disputes.checkable(b) ? view : { ...view, error: !disputes.checkable(b) ? 'not_confirmed' : ws === 'early' ? 'too_early' : ws === 'late' ? 'too_late' : 'no_time' }) };
    }
    const r = disputes.checkIn(b, { lat: req.body?.lat, lng: req.body?.lng, accuracy: req.body?.accuracy, ip: sec.clientIp(req), source: 'link' });
    await flushShop();
    if (wantsJson(req)) return { json: r, status: r.ok ? 200 : 409 };
    return { status: r.ok ? 200 : 409, html: disputePages.checkinPage(r.ok ? { ...view, result: r } : { ...view, error: r.reason }) };
  });
  if (!out) return res.status(404).type('html').send(disputePages.checkinPage({ error: 'not_found', mode: 'live' }));
  if (out.json) return res.status(out.status).json(out.json);
  res.status(out.status).type('html').send(out.html);
}
app.get('/v/checkin/:token', disputeLinkLimit, checkinRoute);
app.post('/v/checkin/:token', disputeLinkLimit, checkinRoute);
// Applies a vendor proof submission (note + optional photo data URL). Shared by the signed link and the portal.
function submitProof(d, body, source) {
  const photo = body && body.photo ? disputes.decodePhoto(String(body.photo)) : null;
  if (photo && photo.error) return { ok: false, error: photo.error };
  const r = disputes.addEvidence(d, { source, text: body && body.note, photo });
  if (!r.ok) return { ok: false, error: r.reason === 'empty' ? 'Add a note or a photo first.' : r.reason === 'photo_limit' ? 'This claim already has the maximum number of photos. Add a note instead.' : r.reason === 'limit' ? 'This claim already has the maximum amount of proof.' : 'This claim is closed.' };
  return { ok: true, evidence: r.evidence };
}
app.locals.submitProof = submitProof;
async function proofRoute(req, res) {
  linkHeaders(res);
  const p = disputes.readToken(req.params.token, 'pf');
  const notFound = () => res.status(404).type('html').send(disputePages.proofPage({ open: false, error: 'This link is not valid.', mode: 'live' }));
  if (!p || typeof p.d !== 'string') return notFound();
  const out = await inTokenShop(p, async () => {
    const d = deposits.find(p.d);
    if (!d || d.bookingId !== p.b) return null;
    const b = store.findBooking(d.bookingId);
    const view = { deposit: d, booking: b, shopName: env.BUSINESS_NAME || d.shopName, action: `/v/proof/${req.params.token}`, mode: linkMode() };
    if (disputes.expired(p)) return { status: 410, html: disputePages.proofPage({ ...view, open: false, error: 'This link has expired. Reply to the BuzzCall text instead.' }) };
    if (req.method === 'GET') return { status: 200, html: disputePages.proofPage({ ...view, open: disputes.isOpen(d) }) };
    const r = submitProof(d, req.body, 'link');
    if (r.ok) {
      await flushShop();
      const sid = shopContext.shopId();
      await platformAlert(`BUZZ ${env.BUSINESS_NAME || d.shopName}: vendor sent proof (proof link) for no-show claim on booking ${d.bookingId}. Review: ${BASE}/admin/deposits${sid ? `?shop=${encodeURIComponent(sid)}` : ''}`, 'BuzzCall: vendor sent no-show proof');
    }
    if (wantsJson(req)) return { json: r, status: r.ok ? 200 : 400 };
    return { status: r.ok ? 200 : 400, html: disputePages.proofPage({ ...view, open: disputes.isOpen(d), message: r.ok ? 'Thanks, your proof was added. BuzzCall will review it.' : '', error: r.ok ? '' : r.error }) };
  });
  if (!out) return notFound();
  if (out.json) return res.status(out.status).json(out.json);
  res.status(out.status).type('html').send(out.html);
}
app.get('/v/proof/:token', disputeLinkLimit, proofRoute);
app.post('/v/proof/:token', disputeLinkLimit, proofRoute);
app.locals.platformAlert = (msg, subject) => platformAlert(msg, subject);

// Authenticated, server-rendered workspace. Only explicitly selected non-secret values reach templates.
app.get('/admin/legacy', requireAdmin, (req, res) => {
  res.type('html').send(adminPages.render({
    businessName: env.BUSINESS_NAME || 'Your business',
    leads: store.db.leads, bookings: store.db.bookings || [], alerts: store.db.alerts, waitlist: store.db.waitlist, optedOut: (phone) => store.isOptedOut(phone),
    billing: billing.summary(), connect: connect.summary(), deposits: deposits.summary(), cfg: booking.cfg(), fees: booking.leadFeeTotals(),
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
let depositsTickFlight = null;
function depositsTickAll() {
  if (depositsTickFlight) return depositsTickFlight;
  depositsTickFlight = (async () => {
    const run = async () => {
      try {
        await deposits.tick({ sendSms: (to, body) => sendSms(to, body) });
      } catch (e) { console.error('[deposits] tick failed:', e.message); }
    };
    await run();
    for (const shop of vendors.all().filter((s) => s.status !== 'provisioning')) {
      try { await vendors.run(shop.id, run, { suspended: true }); }
      catch (e) { console.error('[deposits] shop tick failed:', e.message); }
    }
  })().finally(() => { depositsTickFlight = null; });
  return depositsTickFlight;
}
setInterval(() => { depositsTickAll().catch(() => {}); }, 60000).unref();
app.locals.maintainShops = maintainShops;
app.locals.depositsTickAll = depositsTickAll;
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
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  if (mode.production && /^(sk|rk)_live_/.test(stripeKey) && sec.on(process.env.DEMO_MODE)) {
    const msg = 'DEMO_MODE=1 is set together with a live Stripe key. Refusing to start.';
    console.error(`[security] FATAL: ${msg}`);
    problems.push(msg);
  }
  if (!mode.production) return problems;
  const pw = env.ADMIN_PASSWORD || '';
  if (!pw) problems.push('ADMIN_PASSWORD is not set (admin disabled)');
  else if (pw.length < 16 || [...placeholderPasswords()].some((p) => sec.safeEqual(p, pw))) problems.push('ADMIN_PASSWORD is weak (shorter than 16 characters or the .env.example placeholder)');
  if (!env.OWNER_PHONE || env.OWNER_PHONE === sec.PLACEHOLDER_PHONE) console.error('[security] WARNING: OWNER_PHONE is not set: owner alerts are recorded on /admin but not texted.');
  for (const p of problems) {
    if (/live Stripe key/.test(p)) continue;
    console.error(`[security] WARNING: ${p}. Set a long random ADMIN_PASSWORD (20+ chars).`);
  }
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

module.exports = { app, onPaid, onBooked, bootChecks, runRetention, initStorage, depositsTickAll };
if (require.main !== module) return; // required by tests: no listener, no signal handlers
// Never let one stray rejection kill the line: log it and keep serving. An uncaught exception leaves the process in an
// unknown state, so it is logged and the process exits (Render restarts it).
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e && e.stack ? e.stack : e); process.exit(1); });
{
  const problems = bootChecks();
  if (problems.some((p) => /live Stripe key/.test(p))) { console.error('[security] refusing to start: DEMO_MODE=1 with a live Stripe key.'); process.exit(1); }
  if (problems.length && sec.isProduction() && sec.on(process.env.ADMIN_PASSWORD_STRICT)) { console.error('[security] ADMIN_PASSWORD_STRICT=1: refusing to start.'); process.exit(1); }
}
const port = env.PORT || 3000;
// Load persisted state first (Postgres when DATABASE_URL is set; no-op for file storage), check durability, then accept traffic.
initStorage().then((st) => {
if (st.fatal) process.exit(1);
config.applyTZ(); // the stored override may have just been loaded from Postgres
onboarding.startPoller();
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
