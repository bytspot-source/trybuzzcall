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
const setupRules = require('./setupRules');
const setupPages = require('./setupPages');
const crypto = require('crypto');

const app = express();
// Stripe webhook needs the raw body for signature verification, so it's registered before the JSON parser.
app.post('/stripe/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_unused');
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] || '', process.env.STRIPE_WEBHOOK_SECRET);
    } else event = JSON.parse(req.body.toString('utf8'));
  } catch (e) { return res.status(400).send(`Webhook error: ${e.message}`); }
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
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
// Public site. `extensions` gives clean URLs (/privacy, /terms, /refunds, /sms-consent) as well as the .html paths.
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
const env = config.env;
const BASE = env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`;
function isAdmin(req) {
  const [, b64] = (req.headers.authorization || '').split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  return !!env.ADMIN_PASSWORD && pass === env.ADMIN_PASSWORD;
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

// Optional Twilio signature check when live
function verifyTwilio(req, res, next) {
  if (!live || env.SKIP_TWILIO_VALIDATION === '1') return next();
  const ok = require('twilio').validateRequest(env.TWILIO_AUTH_TOKEN, req.headers['x-twilio-signature'] || '', BASE + req.originalUrl, req.body);
  return ok ? next() : res.status(403).send('bad signature');
}

const missedSay = () => (agent.isBraiders() ? 'Sorry I missed you. I just sent you a text so we can get you booked.' : 'Sorry we missed you. We just texted you and will call back shortly.');

// When the shop's subscription lapsed (past_due/canceled, see billing.access), callers get one polite generic text
// (at most once per number per 24h; INACTIVE_MODE=silent sends nothing) and no booking/deposit flow.
async function inactiveText(phone) {
  if (!phone || billing.cfg().inactiveMode === 'silent') return;
  store.db.inactiveTexts = store.db.inactiveTexts || {};
  const last = store.db.inactiveTexts[phone];
  if (last && Date.now() - Date.parse(last) < 86400000) return;
  store.db.inactiveTexts[phone] = new Date().toISOString(); store.save();
  const biz = env.BUSINESS_NAME || 'us';
  const msg = env.INACTIVE_MESSAGE || (agent.isBraiders()
    ? `Hi, this is ${biz}. Sorry I missed your call! Please try calling again later. Reply STOP to opt out.`
    : `Hi, this is ${biz}. Sorry we missed your call! Please try calling again later. Reply STOP to opt out.`);
  await sendSms(phone, msg);
}

async function startTextBack(phone) {
  if (!phone) return;
  if (!billing.access().active) return inactiveText(phone);
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
    const c = booking.cfg();
    msg = url ? agent.texts.held(lead.name, b, c.holdMin, url) : agent.texts.heldNoLink(lead.name, b);
  } else msg = agent.texts.bookedNoDeposit(lead.name, b);
  lead.messages.push({ dir: 'out', body: msg }); store.save();
  await sendSms(lead.phone, msg);
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
  if (lead.messages) { lead.messages.push({ dir: 'out', body: msg }); store.save(); }
  await sendSms(b.phone, msg);
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
  store.addAlert({ leadId: lead.id, to: env.OWNER_PHONE, body: msg });
  await sendSms(env.OWNER_PHONE || '+10000000000', msg);
}

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

// ---------- Shop-owner setup form ----------
// GET /setup is public/setup.html (static). The shared balance-check rules are served to the browser from src/.
app.get('/setup-rules.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'setupRules.js')));
// POST /setup (JSON or form). 422 = errors, 409 = warnings not confirmed (send confirm=1), 200 = saved as 'pending'.
// Never touches the live config: an admin reviews it and clicks 'Apply to this line'.
const wantsJson = (req) => req.is('application/json') || /application\/json/.test(req.get('accept') || '');
app.post('/setup', (req, res) => {
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

// Admin (HTTP Basic auth, any username)
app.get('/admin', requireAdmin, (req, res) => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = store.db.leads.slice(0, 100).map((l) => `<tr><td>${esc(l.createdAt)}</td><td>${esc(l.phone)}</td><td>${esc(l.name)}</td><td>${l.urgent ? '🚨 ' : ''}${esc(l.need)}</td><td>${esc(l.window)}</td><td>${esc(l.status)}</td></tr>`).join('');
  const lf = booking.leadFeeTotals(), fc = booking.cfg();
  const alerts = store.db.alerts.slice(0, 50).map((a) => `<li>${esc(a.at)} → ${esc(a.to)}: ${esc(a.body)}</li>`).join('');
  const waitlist = store.db.waitlist.map((w) => {
    const label = w.businessType === 'home_services' ? 'Home services' : w.businessType === 'braiders' ? 'Braiders' : '';
    return `<li>${esc(w.email)}${label ? ` · Business type: ${esc(label)}` : ''}</li>`;
  }).join('');
  res.send(`<!doctype html><meta charset="utf-8"><title>Admin</title><style>body{font-family:sans-serif;margin:2rem}td,th{border:1px solid #ccc;padding:4px 8px}table{border-collapse:collapse}</style>
${billingHtml(esc)}<h1>Leads</h1><table><tr><th>When</th><th>Phone</th><th>Name</th><th>Need</th><th>Callback</th><th>Status</th></tr>${rows}</table>
<h2>Lead fees</h2><p><b>Total: $${money(lf.total)}</b> from ${lf.count} paid lead(s) (fee $${money(fc.leadFee)}/paid lead${fc.leadFeeWaived ? ', WAIVED' : ''}; ${fc.connectAccount ? 'Stripe Connect ' + esc(fc.connectAccount) : 'no Connect: invoice monthly'})<br>Due (to invoice): $${money(lf.due)} · Collected via Connect: $${money(lf.collected)} · Waived (pilot): $${money(lf.waived)} · Under review (slot lost): $${money(lf.review)}</p>
<h2>Bookings</h2><ul>${(store.db.bookings || []).slice(0, 50).map((b) => `<li>${esc(b.slotLabel)}: ${esc(b.name)} (${esc(b.phone)}) - ${esc(b.status)}${b.paid ? ' PAID $' + esc(b.amount) : ''}${b.lead_fee_status ? ` · lead fee $${money(b.lead_fee || 0)} ${esc(b.lead_fee_status)}` : ''}</li>`).join('')}</ul><h2>Owner alerts</h2><ul>${alerts}</ul><h2>Waitlist (${store.db.waitlist.length})</h2><ul>${waitlist}</ul>
${setupPages.adminSetupsHtml(store.db.setups, config.effective(), config.override(), booking.cfg())}`);
});

setInterval(() => booking.expireHolds(), 60000).unref();
billing.init({ notify: (msg) => owner(null, msg), BASE });
app.get('/health', (_, res) => res.json({ ok: true, vertical: booking.cfg().vertical, billing: billing.summary().mode, serviceActive: billing.access().active, twilio: live, openai: !!env.OPENAI_API_KEY, booking: booking.cfg().booking, deposit: booking.cfg().deposit, stripe: !!env.STRIPE_SECRET_KEY, leadFee: booking.cfg().leadFee, leadFeeWaived: booking.cfg().leadFeeWaived, connect: !!booking.cfg().connectAccount }));
const port = env.PORT || 3000;
app.listen(port, () => console.log(`missedcall-buzz on :${port} (vertical ${booking.cfg().vertical}, twilio ${live ? 'LIVE' : 'LOG-ONLY'}, ai ${env.OPENAI_API_KEY ? 'openai' : 'templates'})`));
