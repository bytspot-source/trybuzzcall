// Shop subscription billing (the shop pays BuzzCall). Live = Stripe Billing (stripe npm 16.12.0, API 2024-06-20);
// no STRIPE_SECRET_KEY = mock mode: same state machine and webhook handler, driven by /billing/mock/* routes
// and a mock clock so the whole lifecycle (trial -> active -> past_due -> plan change -> cancel) can be simulated.
//
// Setup fee ($99 estimate, STRIPE_PRICE_ID_SETUP): waived for the first FOUNDING_SHOPS_LIMIT shops (default 10), for a
// per-shop override (SETUP_FEE_WAIVED=1, or a signup with SETUP_WAIVER_CODE / admin auth), and always on annual plans.
// Otherwise it is charged when the free trial ends, never at signup: on checkout.session.completed we create a pending
// InvoiceItem {customer, price, subscription} so Stripe puts it on that subscription's first non-trial invoice.
// If the shop cancels during the trial (or switches to annual), the pending item is deleted, so no setup fee.
//
// State: store.db.billing = { subscription (primary = newest signup, drives service gating), subs {id: summary},
//   shops [{ subscriptionId, customer, plan, founding, setup: {status, reason, amount, itemId} }], invoices, events, mock }.
const crypto = require('crypto');
const store = require('./store');
const env = process.env;
const on = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const num = (v, d) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const DAY = 86400000;

const cfg = () => ({
  live: !!env.STRIPE_SECRET_KEY,
  trialDays: Math.round(num(env.TRIAL_DAYS, 14)),
  prices: { monthly: env.STRIPE_PRICE_ID_BASE_MONTHLY || '', annual: env.STRIPE_PRICE_ID_BASE_ANNUAL || '', setup: env.STRIPE_PRICE_ID_SETUP || '' },
  foundingLimit: Math.round(num(env.FOUNDING_SHOPS_LIMIT, 10)),
  setupWaivedAll: on(env.SETUP_FEE_WAIVED), // per-deploy (= per-shop, single-tenant) override
  setupWaiverCode: (env.SETUP_WAIVER_CODE || '').trim() || null,
  setupLabel: num(env.SETUP_FEE_DISPLAY, 99), // shown in texts/Checkout; live charge = your Stripe setup Price
  upgradeProration: env.ANNUAL_UPGRADE_PRORATION || 'always_invoice',
  downgradeProration: env.MONTHLY_DOWNGRADE_PRORATION || 'create_prorations',
  enforce: env.BILLING_ENFORCE === undefined || env.BILLING_ENFORCE === '' ? true : on(env.BILLING_ENFORCE),
  requireSub: on(env.BILLING_REQUIRE_SUBSCRIPTION),
  graceDays: num(env.PAST_DUE_GRACE_DAYS, 0),
  inactiveMode: (env.INACTIVE_MODE || 'generic').toLowerCase(),
  portalReturn: env.BILLING_PORTAL_RETURN_URL || '',
  mock: { monthly: num(env.MOCK_PRICE_MONTHLY, 49), annual: num(env.MOCK_PRICE_ANNUAL, 588), setup: num(env.MOCK_SETUP_FEE, 99) },
});

const B = () => { store.db.billing = store.db.billing || {}; const b = store.db.billing;
  for (const [k, v] of [['invoices', []], ['events', []], ['mock', {}], ['subs', {}], ['shops', []]]) b[k] = b[k] || v;
  b.mock.subs = b.mock.subs || {}; b.mock.sessions = b.mock.sessions || {};
  if (b.subscription && !b.subs[b.subscription.id]) b.subs[b.subscription.id] = b.subscription; // migrate older single-sub state
  return b; };
const now = () => Date.now() + (cfg().live ? 0 : (B().mock.offsetMs || 0)); // mock clock
const iso = (secs) => (secs ? new Date(secs * 1000).toISOString() : null);
const secs = (ms) => Math.floor(ms / 1000);
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
const fmtDate = (isoStr) => (isoStr ? new Date(isoStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '?');
let stripeClient = null;
const stripe = () => (stripeClient = stripeClient || require('stripe')(env.STRIPE_SECRET_KEY));
let notify = async () => {};
let PORTAL = '';
function init(opts) { if (opts.notify) notify = opts.notify; if (opts.BASE) PORTAL = `${opts.BASE}/billing/portal`; }
const err = (msg, status) => Object.assign(new Error(msg), { status });

// ---------- subscription state ----------
const planOf = (sub) => {
  const price = sub.items?.data?.[0]?.price;
  if (price?.id && price.id === cfg().prices.annual) return 'annual';
  if (price?.id && price.id === cfg().prices.monthly) return 'monthly';
  if (price?.recurring?.interval) return price.recurring.interval === 'year' ? 'annual' : 'monthly';
  return sub.metadata?.plan || 'monthly';
};
const shopOf = (subId) => B().shops.find((s) => s.subscriptionId === subId);
function applySubscription(sub, source) {
  const b = B(), prev = b.subs[sub.id] || {};
  const price = sub.items?.data?.[0]?.price;
  const s = {
    id: sub.id, customer: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id, status: sub.status,
    plan: planOf(sub), priceId: price?.id || null, amount: price?.unit_amount != null ? price.unit_amount / 100 : null,
    current_period_start: iso(sub.current_period_start), current_period_end: iso(sub.current_period_end),
    trial_end: iso(sub.trial_end), cancel_at_period_end: !!sub.cancel_at_period_end, canceled_at: iso(sub.canceled_at),
    past_due_since: sub.status === 'past_due' ? (prev.past_due_since || new Date(now()).toISOString()) : null,
    updatedAt: new Date(now()).toISOString(), source,
  };
  b.subs[s.id] = s;
  if (!b.primaryId) b.primaryId = s.id;
  if (b.primaryId === s.id) b.subscription = s;
  const shop = shopOf(s.id); if (shop) { shop.status = s.status; shop.plan = s.plan; if (s.status === 'active') shop.everPaid = true; }
  store.save(); return s;
}
async function syncFromStripe(subId, fallback, source) {
  // Live: re-read the subscription from Stripe so out-of-order (or forged unsigned) events can't set a wrong status.
  if (cfg().live && subId) { try { return applySubscription(await stripe().subscriptions.retrieve(subId), source); } catch (e) { console.error('subscription sync failed:', e.message); } }
  return fallback ? applySubscription(fallback, source) : B().subs[subId];
}

function access() {
  const c = cfg(), s = B().subscription;
  if (!c.enforce) return { active: true, reason: 'billing not enforced (BILLING_ENFORCE=0)' };
  if (!s) return c.requireSub ? { active: false, reason: 'no subscription on file' } : { active: true, reason: 'no subscription on file (pilot/manual)' };
  if (['trialing', 'active'].includes(s.status)) return { active: true, reason: s.status };
  if (s.status === 'past_due' && c.graceDays > 0 && s.past_due_since && now() - Date.parse(s.past_due_since) < c.graceDays * DAY)
    return { active: true, reason: `past_due, in ${c.graceDays}-day grace` };
  return { active: false, reason: s.status };
}

// ---------- setup fee ----------
// A founding slot is held by each of the first N shops, except shops that cancelled during their trial without ever paying.
const foundingTaken = () => B().shops.filter((s) => s.founding && !(s.status === 'canceled' && !s.everPaid)).length;
function decideSetup({ plan, override }) {
  const c = cfg();
  if (plan === 'annual') return { status: 'waived', reason: 'annual plan' };
  if (override || c.setupWaivedAll) return { status: 'waived', reason: 'override' };
  if (foundingTaken() < c.foundingLimit) return { status: 'waived', reason: `founding shop #${foundingTaken() + 1} of ${c.foundingLimit}`, founding: true };
  if (c.live ? !c.prices.setup : !(c.mock.setup > 0)) return { status: 'none', reason: 'no setup price configured' };
  return { status: 'pending', reason: 'charged on first invoice after the trial', amount: c.live ? null : c.mock.setup };
}
async function addSetupItem(shop) {
  const c = cfg();
  if (c.live) {
    const item = await stripe().invoiceItems.create({ customer: shop.customer, price: c.prices.setup, subscription: shop.subscriptionId,
      description: 'BuzzCall setup (one-time)', metadata: { kind: 'setup_fee', subscription: shop.subscriptionId } },
    { idempotencyKey: `setup-${shop.subscriptionId}` });
    shop.setup.itemId = item.id; shop.setup.amount = item.amount / 100;
  } else {
    const ms = B().mock.subs[shop.subscriptionId]; ms.pendingItems = [{ id: mid('ii'), amount: c.mock.setup, kind: 'setup_fee' }];
    shop.setup.itemId = ms.pendingItems[0].id; shop.setup.amount = c.mock.setup;
  }
  shop.setup.status = 'pending';
}
async function removeSetupItem(shop, status, reason) {
  if (shop.setup?.status !== 'pending') return;
  if (cfg().live && shop.setup.itemId) {
    try { const it = await stripe().invoiceItems.retrieve(shop.setup.itemId); if (it.invoice) { shop.setup.status = 'invoiced'; return; } await stripe().invoiceItems.del(shop.setup.itemId); }
    catch (e) { console.error('setup item delete failed:', e.message); return; }
  } else { const ms = B().mock.subs[shop.subscriptionId]; if (ms) ms.pendingItems = (ms.pendingItems || []).filter((i) => i.id !== shop.setup.itemId); }
  shop.setup.status = status; shop.setup.reason = reason;
}
async function registerShop({ subscriptionId, customer, plan, override, status }) {
  const b = B(); let shop = shopOf(subscriptionId);
  if (shop) return shop;
  const d = decideSetup({ plan, override });
  shop = { n: b.shops.length + 1, subscriptionId, customer, plan, status, createdAt: new Date(now()).toISOString(), founding: !!d.founding,
    setup: { status: d.status, reason: d.reason, amount: d.amount ?? null, itemId: null } };
  b.shops.push(shop);
  b.primaryId = subscriptionId; if (b.subs[subscriptionId]) b.subscription = b.subs[subscriptionId];
  if (d.status === 'pending') {
    if (status === 'trialing') await addSetupItem(shop);
    else { shop.setup.status = 'charged at signup (no trial)'; } // TRIAL_DAYS=0: setup was a Checkout line item
  }
  store.save(); return shop;
}

// ---------- webhook / event handler (used by /stripe/webhook and by mock mode) ----------
const WATCHED = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed', 'customer.subscription.trial_will_end'];

async function handleEvent(event) {
  if (!WATCHED.includes(event.type)) return false;
  const o = event.data.object;
  if (event.type === 'checkout.session.completed' && o.mode !== 'subscription') return false; // deposits handled by server.js
  const b = B();
  if (event.id && b.events.some((e) => e.id === event.id)) return true; // idempotent
  b.events.unshift({ id: event.id, type: event.type, at: new Date(now()).toISOString() }); b.events = b.events.slice(0, 300);
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = await syncFromStripe(o.subscription, null, event.type) || b.subs[o.subscription] || {};
      await registerShop({ subscriptionId: o.subscription, customer: o.customer, plan: s.plan || o.metadata?.plan || 'monthly',
        override: o.metadata?.setup_waived === '1', status: s.status || 'trialing' });
      break;
    }
    case 'customer.subscription.created': case 'customer.subscription.updated':
      await syncFromStripe(o.id, o, event.type); break;
    case 'customer.subscription.deleted': {
      const s = await syncFromStripe(o.id, o, event.type);
      const shop = shopOf(o.id);
      if (shop && !shop.everPaid) await removeSetupItem(shop, 'voided', 'cancelled during trial: no setup fee');
      void s; break;
    }
    case 'invoice.paid': case 'invoice.payment_failed': {
      const lines = (o.lines?.data || []).map((l) => ({ description: l.description, amount: l.amount / 100, invoice_item: l.invoice_item || null }));
      const inv = { id: o.id, subscription: o.subscription || null, status: event.type === 'invoice.paid' ? 'paid' : 'open',
        amount_due: (o.amount_due ?? 0) / 100, amount_paid: (o.amount_paid ?? 0) / 100, reason: o.billing_reason || null,
        lines, at: new Date(now()).toISOString(), url: o.hosted_invoice_url || null };
      const i = b.invoices.findIndex((x) => x.id === inv.id); if (i >= 0) b.invoices[i] = inv; else b.invoices.unshift(inv);
      b.invoices = b.invoices.slice(0, 300);
      const shop = shopOf(o.subscription);
      if (shop?.setup?.itemId && lines.some((l) => l.invoice_item === shop.setup.itemId))
        shop.setup.status = event.type === 'invoice.paid' ? 'paid' : 'invoiced (payment failed)';
      if (cfg().live && o.subscription) await syncFromStripe(o.subscription, null, event.type);
      if (event.type === 'invoice.payment_failed') {
        const a = access();
        await notify(`BuzzCall billing: your $${money(inv.amount_due)} payment didn't go through. Update your card here: ${PORTAL}${a.active ? '' : ' Until it is paid, callers get a short "please call back" text only (no booking or deposits).'}`);
      }
      break;
    }
    case 'customer.subscription.trial_will_end': {
      const s = await syncFromStripe(o.id, o, event.type) || {};
      const shop = shopOf(o.id);
      const setup = shop?.setup?.status === 'pending' ? ` plus the one-time $${money(shop.setup.amount ?? cfg().setupLabel)} setup fee` : '';
      const amt = s.amount != null ? `$${money(s.amount)} (${s.plan})${setup}` : `your ${s.plan || ''} plan${setup}`;
      await notify(`BuzzCall: your free trial ends ${fmtDate(s.trial_end)}. Your card will be charged ${amt} then, and the plan renews automatically unless you cancel before then: ${PORTAL}`);
      break;
    }
  }
  store.save(); return true;
}

// ---------- operations (live Stripe, or mock) ----------
async function createCheckout({ plan, email, BASE, setupWaived }) {
  const c = cfg(); PORTAL = `${BASE}/billing/portal`;
  if (!c.live) return mockCreateCheckout({ plan, email, BASE, setupWaived });
  const price = c.prices[plan];
  if (!price) throw err(`Stripe price not configured (set STRIPE_PRICE_ID_BASE_${plan.toUpperCase()})`, 501);
  const preview = decideSetup({ plan, override: setupWaived });
  const line_items = [{ price, quantity: 1 }];
  // No trial: the first paid invoice is at signup, so the setup price goes on it as a Checkout line item.
  if (!c.trialDays && preview.status === 'pending') line_items.push({ price: c.prices.setup, quantity: 1 });
  const setupNote = preview.status === 'pending' && c.trialDays
    ? `One-time setup fee (estimate $${money(c.setupLabel)}) is added to your first invoice after the ${c.trialDays}-day free trial, not today. Cancel during the trial and you pay nothing.` : null;
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription', line_items, payment_method_collection: 'always',
    ...(email ? { customer_email: email } : {}),
    // No billing_cycle_anchor: the cycle starts when the trial ends, so no partial first month.
    subscription_data: { metadata: { plan }, ...(c.trialDays ? { trial_period_days: c.trialDays, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } } : {}) },
    metadata: { plan, setup_waived: setupWaived ? '1' : '0' }, allow_promotion_codes: true,
    ...(setupNote ? { custom_text: { submit: { message: setupNote } } } : {}),
    success_url: `${BASE}/billing/return?status=success`, cancel_url: `${BASE}/billing/return?status=cancel`,
  });
  return { url: session.url, id: session.id, setup: preview };
}
const pick = (subId) => { const b = B(); const s = subId ? b.subs[subId] : b.subscription; if (!s || !s.id) throw err('no subscription on file', 404); return s; };
const prorationFor = (from, to) => (to === 'annual' && from !== 'annual' ? cfg().upgradeProration : cfg().downgradeProration);

async function previewChange(plan, subId) {
  const c = cfg(), s = pick(subId);
  if (!c.live) return mockChange(plan, true, s.id);
  const price = c.prices[plan]; if (!price) throw err(`STRIPE_PRICE_ID_BASE_${plan.toUpperCase()} not set`, 501);
  const sub = await stripe().subscriptions.retrieve(s.id);
  const proration_date = secs(Date.now());
  const inv = await stripe().invoices.createPreview({ customer: sub.customer, subscription: sub.id,
    subscription_details: { items: [{ id: sub.items.data[0].id, price }], proration_behavior: prorationFor(planOf(sub), plan), proration_date } });
  const prorations = inv.lines.data.filter((l) => l.proration).map((l) => ({ description: l.description, amount: l.amount / 100 }));
  return { from: planOf(sub), to: plan, proration_behavior: prorationFor(planOf(sub), plan), proration_date,
    prorations, amount_due: inv.amount_due / 100, total: inv.total / 100, note: 'Stripe invoice preview' };
}
async function setupOnPlanChange(subId, plan, status) {
  const shop = shopOf(subId); if (!shop) return;
  if (plan === 'annual') await removeSetupItem(shop, 'waived', 'annual plan');
  else if (status === 'trialing' && shop.setup.status === 'waived' && shop.setup.reason === 'annual plan') {
    const d = decideSetup({ plan, override: false }); shop.setup = { ...shop.setup, ...d };
    if (d.founding) shop.founding = true;
    if (d.status === 'pending') await addSetupItem(shop);
  }
  store.save();
}
async function changePlan(plan, proration_date, subId) {
  const c = cfg(), s = pick(subId);
  if (s.plan === plan) return { unchanged: true, subscription: s };
  if (!c.live) return mockChange(plan, false, s.id);
  const price = c.prices[plan]; if (!price) throw err(`STRIPE_PRICE_ID_BASE_${plan.toUpperCase()} not set`, 501);
  const sub = await stripe().subscriptions.retrieve(s.id);
  const updated = await stripe().subscriptions.update(sub.id, { items: [{ id: sub.items.data[0].id, price }],
    proration_behavior: prorationFor(planOf(sub), plan), ...(proration_date ? { proration_date: Number(proration_date) } : {}), metadata: { plan } });
  const out = applySubscription(updated, 'change-plan');
  await setupOnPlanChange(sub.id, plan, updated.status);
  return { subscription: out, setup: shopOf(sub.id)?.setup };
}
async function setCancel(atPeriodEnd, subId) {
  const s = pick(subId);
  if (!cfg().live) return mockSetCancel(atPeriodEnd, s.id);
  // Cancel at end of the paid period (or at trial end): access continues until then, no partial refunds.
  return applySubscription(await stripe().subscriptions.update(s.id, { cancel_at_period_end: atPeriodEnd }), atPeriodEnd ? 'cancel' : 'resume');
}
async function portalUrl(BASE) {
  if (!cfg().live) return `${BASE}/billing/mock/portal`;
  const customer = B().subscription?.customer;
  if (!customer) throw err('no Stripe customer on file yet (complete checkout first)', 404);
  const ps = await stripe().billingPortal.sessions.create({ customer, return_url: cfg().portalReturn || `${BASE}/admin#payments` });
  return ps.url;
}

// ---------- mock mode ----------
const mid = (p) => `${p}_mock_${crypto.randomBytes(5).toString('hex')}`;
const addInterval = (ms, plan) => { const d = new Date(ms); if (plan === 'annual') d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1); return d.getTime(); };
const mockPrice = (plan) => ({ id: `price_mock_${plan}`, unit_amount: Math.round(cfg().mock[plan] * 100), recurring: { interval: plan === 'annual' ? 'year' : 'month' } });
async function fire(type, object) { const ev = { id: mid('evt'), type, data: { object: JSON.parse(JSON.stringify(object)) } }; await handleEvent(ev); return ev; }
const msub = (subId) => { const m = B().mock; const s = m.subs[subId || B().subscription?.id]; if (!s) throw err('no mock subscription', 404); return s; };

function mockCreateCheckout({ plan, email, BASE, setupWaived }) {
  const m = B().mock; PORTAL = `${BASE}/billing/portal`;
  const sid = mid('cs'); m.sessions[sid] = { plan, email: email || null, setupWaived: !!setupWaived, createdAt: new Date(now()).toISOString() };
  store.save(); return { url: `${BASE}/billing/mock/checkout/${sid}`, id: sid, mock: true, setup: decideSetup({ plan, override: setupWaived }) };
}
function mockSessionInfo(sid) { const s = B().mock.sessions[sid]; return s ? { ...s, setup: decideSetup({ plan: s.plan, override: s.setupWaived }) } : null; }
// Mock invoice: lines = base price (and any pending invoice items); customer credit balance is used first.
function mockInvoice(sub, lines, reason) {
  const m = B().mock; const total = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
  const bal = sub.balance || 0; const fromBal = Math.min(bal, Math.max(total, 0));
  sub.balance = Math.round((bal - fromBal) * 100) / 100;
  let due = Math.round((total - fromBal) * 100) / 100;
  if (due < 0) { sub.balance = Math.round((sub.balance - due) * 100) / 100; due = 0; }
  void m;
  return { id: mid('in'), subscription: sub.id, amount_due: Math.round(due * 100), amount_paid: Math.round(due * 100), billing_reason: reason,
    lines: { data: lines.map((l) => ({ description: l.description, amount: Math.round(l.amount * 100), invoice_item: l.invoice_item || null })) } };
}
async function mockCompleteCheckout(sid, BASE) {
  const mk = B().mock; PORTAL = `${BASE}/billing/portal`;
  const sess = mk.sessions[sid]; if (!sess) throw err('mock session not found', 404);
  if (sess.completed) return B().subs[sess.subscription];
  const c = cfg(), t = now(), trialEnd = c.trialDays ? t + c.trialDays * DAY : null;
  const sub = { id: mid('sub'), object: 'subscription', customer: mid('cus'), status: trialEnd ? 'trialing' : 'active', cancel_at_period_end: false,
    current_period_start: secs(t), current_period_end: secs(trialEnd || addInterval(t, sess.plan)), trial_end: trialEnd ? secs(trialEnd) : null,
    items: { data: [{ id: mid('si'), price: mockPrice(sess.plan) }] }, metadata: { plan: sess.plan }, pendingItems: [], balance: 0, failNext: false };
  mk.subs[sub.id] = sub; sess.completed = true; sess.subscription = sub.id;
  await fire('customer.subscription.created', sub);
  await fire('checkout.session.completed', { mode: 'subscription', customer: sub.customer, subscription: sub.id, metadata: { plan: sess.plan, setup_waived: sess.setupWaived ? '1' : '0' } });
  if (trialEnd) await fire('invoice.paid', mockInvoice(sub, [{ description: `Free trial (${c.trialDays} days)`, amount: 0 }], 'subscription_create'));
  else {
    const shop = shopOf(sub.id), lines = [{ description: `BuzzCall ${sess.plan}`, amount: c.mock[sess.plan] }];
    if (shop?.setup?.status === 'charged at signup (no trial)') lines.push({ description: 'BuzzCall setup (one-time)', amount: c.mock.setup });
    await fire('invoice.paid', mockInvoice(sub, lines, 'subscription_create'));
  }
  return B().subs[sub.id];
}
async function mockRenew(sub, reason) {
  const plan = sub.metadata.plan, start = sub.current_period_end * 1000;
  sub.current_period_start = secs(start); sub.current_period_end = secs(addInterval(start, plan));
  const lines = [{ description: `BuzzCall ${plan} (${fmtDate(new Date(start).toISOString())} - ${fmtDate(iso(sub.current_period_end))})`, amount: cfg().mock[plan] },
    ...(sub.pendingItems || []).map((i) => ({ description: 'BuzzCall setup (one-time)', amount: i.amount, invoice_item: i.id }))];
  sub.pendingItems = []; // pending invoice items are pulled into this invoice
  const inv = mockInvoice(sub, lines, reason);
  if (sub.failNext) { sub.status = 'past_due'; sub.openInvoice = inv; await fire('customer.subscription.updated', sub); await fire('invoice.payment_failed', { ...inv, amount_paid: 0 }); }
  else { sub.status = 'active'; await fire('customer.subscription.updated', sub); await fire('invoice.paid', inv); }
}
// Move the mock clock forward; fire what Stripe would have fired on the way, for every mock subscription.
async function mockAdvance(days, BASE) {
  PORTAL = `${BASE}/billing/portal`;
  const mk = B().mock; const target = now() + days * DAY;
  for (let guard = 0; guard < 500; guard++) {
    const ms = [];
    for (const sub of Object.values(mk.subs)) {
      if (sub.status === 'canceled') continue;
      if (sub.status === 'trialing' && !sub.trialWillEndSent) ms.push([sub, 'trial_will_end', sub.trial_end * 1000 - 3 * DAY]);
      ms.push([sub, 'period_end', sub.current_period_end * 1000]);
    }
    ms.sort((a, b) => a[2] - b[2]);
    if (!ms.length || ms[0][2] > target) break;
    const [sub, kind, at] = ms[0];
    mk.offsetMs = (mk.offsetMs || 0) + Math.max(0, at - now());
    if (kind === 'trial_will_end') { sub.trialWillEndSent = true; await fire('customer.subscription.trial_will_end', sub); continue; }
    if (sub.cancel_at_period_end || sub.status === 'past_due') { sub.status = 'canceled'; sub.canceled_at = secs(now()); await fire('customer.subscription.deleted', sub); continue; }
    await mockRenew(sub, sub.status === 'trialing' ? 'subscription_cycle (trial ended)' : 'subscription_cycle');
  }
  mk.offsetMs = (mk.offsetMs || 0) + Math.max(0, target - now());
  store.save(); return B().subscription;
}
async function mockUpdateCard(BASE, subId) {
  PORTAL = `${BASE}/billing/portal`;
  const sub = msub(subId); sub.failNext = false;
  if (sub.openInvoice && sub.status === 'past_due') { const inv = sub.openInvoice; sub.openInvoice = null; sub.status = 'active';
    await fire('invoice.paid', inv); await fire('customer.subscription.updated', sub); }
  store.save(); return B().subs[sub.id];
}
// Monthly<->annual changes the billing interval, so (like Stripe) the cycle restarts today: unused time on the old plan
// is credited, the new plan is charged for a full new period. During a trial nothing is charged.
async function mockChange(plan, previewOnly, subId) {
  const sub = msub(subId), from = sub.metadata.plan, c = cfg(), t = now();
  const behavior = prorationFor(from, plan);
  let p;
  if (from === plan) p = { from, to: plan, unchanged: true, amount_due_now: 0 };
  else if (sub.status === 'trialing') p = { from, to: plan, proration_behavior: behavior, credit: 0, charge: 0, amount_due_now: 0,
    note: `in trial: no charge now; first charge $${money(c.mock[plan])} on ${fmtDate(iso(sub.trial_end))}${plan === 'annual' ? ' (setup waived on annual)' : ''}` };
  else {
    const start = sub.current_period_start * 1000, end = sub.current_period_end * 1000;
    const frac = Math.max(0, Math.min(1, (end - t) / (end - start)));
    const credit = Math.round(c.mock[from] * frac * 100) / 100, charge = c.mock[plan], net = Math.round((charge - credit) * 100) / 100;
    p = { from, to: plan, proration_behavior: behavior, unused_fraction: Math.round(frac * 1000) / 1000, credit, charge, net,
      amount_due_now: Math.max(net, 0), credit_balance_after: Math.round(((sub.balance || 0) + Math.max(-net, 0)) * 100) / 100,
      new_period_end: new Date(addInterval(t, plan)).toISOString(),
      note: net >= 0 ? `charged now: $${money(charge)} ${plan} minus $${money(credit)} unused ${from} time` : `$${money(-net)} credit kept on account for future invoices` };
  }
  if (previewOnly || p.unchanged) return p;
  sub.items.data[0].price = mockPrice(plan); sub.metadata.plan = plan;
  const wasTrial = sub.status === 'trialing';
  if (!wasTrial) { sub.current_period_start = secs(t); sub.current_period_end = secs(addInterval(t, plan)); }
  await fire('customer.subscription.updated', sub);
  await setupOnPlanChange(sub.id, plan, sub.status);
  if (!wasTrial) {
    const inv = mockInvoice(sub, [{ description: `Unused ${from} time`, amount: -p.credit }, { description: `BuzzCall ${plan}`, amount: p.charge }], 'subscription_update');
    if (inv.amount_due > 0 || behavior === 'always_invoice') await fire('invoice.paid', inv);
  }
  store.save(); return { ...p, subscription: B().subs[sub.id], setup: shopOf(sub.id)?.setup };
}
async function mockSetCancel(atPeriodEnd, subId) { const sub = msub(subId); sub.cancel_at_period_end = atPeriodEnd; await fire('customer.subscription.updated', sub); return B().subs[sub.id]; }
function mockSetPrimary(subId) { const b = B(); if (!b.subs[subId]) throw err('unknown subscription', 404); b.primaryId = subId; b.subscription = b.subs[subId]; store.save(); return b.subscription; }
function mockFailNext(onOff, subId) { const sub = msub(subId); sub.failNext = !!onOff; store.save(); return { subscription: sub.id, failNext: sub.failNext }; }

function summary() {
  const b = B(), c = cfg();
  return { mode: c.live ? 'live' : 'mock', now: new Date(now()).toISOString(), subscription: b.subscription || null, access: access(),
    founding: { taken: foundingTaken(), limit: c.foundingLimit },
    shops: b.shops.map((s) => ({ n: s.n, subscription: s.subscriptionId, plan: s.plan, status: s.status, cancel_at_period_end: !!b.subs[s.subscriptionId]?.cancel_at_period_end, founding: s.founding, setup: s.setup })),
    invoices: b.invoices.slice(0, 20), events: b.events.slice(0, 20).map((e) => e.type),
    ...(c.live ? {} : { mockCreditBalance: b.subscription ? b.mock.subs[b.subscription.id]?.balance || 0 : 0 }) };
}

module.exports = { cfg, init, access, handleEvent, createCheckout, previewChange, changePlan, setCancel, portalUrl, summary, now, decideSetup,
  mockCompleteCheckout, mockAdvance, mockUpdateCard, mockFailNext, mockSessionInfo, mockSetPrimary, WATCHED };
