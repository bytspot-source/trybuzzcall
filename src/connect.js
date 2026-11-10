// Stripe Connect for deposit payouts: Express accounts for vendors. Customer deposits are charged on BuzzCall's
// platform account (separate charges + transfers — see src/deposits.js). Funds are NOT sent to the vendor at booking;
// a Transfer runs after the appointment. Destination charges transfer immediately, so they cannot delay payout until
// after the job. Express + separate charges/transfers cleanly support held funds, delayed release, refunds before
// transfer, and transfer reversals after release.
//
// State lives in the config override (store.getOverride().stripeConnect, persisted to Postgres/config.json):
//   { accountId, mode: 'live'|'test'|'mock', source: 'onboarding'|'env', chargesEnabled, detailsSubmitted,
//     payoutsEnabled, requirementsDue[], disabledReason, deauthorized, checkedAt, updatedAt }
// STRIPE_CONNECT_ACCOUNT_ID (env) is only a backward-compatible fallback for the account id.
// Mock mode (no STRIPE_SECRET_KEY): no Stripe calls; onboarding is simulated (/admin/connect/mock or /vendor/connect/mock).
const crypto = require('crypto');
const store = require('./store');
const shopContext = require('./shopContext');

const key = () => process.env.STRIPE_SECRET_KEY || '';
// 'mock' (no key) | 'test' (sk_test_/rk_test_) | 'live' (sk_live_/rk_live_ or anything else)
const mode = () => (!key() ? 'mock' : /^(sk|rk)_test_/.test(key()) ? 'test' : 'live');
const envId = () => shopContext.current() ? null : (process.env.STRIPE_CONNECT_ACCOUNT_ID || '').trim() || null;

let factory = null; // tests inject a fake client; never hits the network then
let client = null, clientKey = null;
function stripe() {
  if (factory) return factory();
  if (!client || clientKey !== key()) { client = require('stripe')(key()); clientKey = key(); }
  return client;
}
const setStripe = (fn) => { factory = fn ? (typeof fn === 'function' ? fn : () => fn) : null; };

const stored = () => store.getOverride().stripeConnect || null;
function save(next) {
  const o = store.getOverride();
  store.setOverride({ ...o, stripeConnect: next ? { ...next, updatedAt: new Date().toISOString() } : undefined });
}
// The stored record counts only for the current mode (a mock or test account never satisfies live keys).
function state() {
  const s = stored();
  if (s && s.accountId && s.mode === mode() && !s.deauthorized) return s;
  const id = envId();
  // Env fallback is NOT a payout destination. chargesEnabled stays false until Stripe
  // confirms the account (ensureFresh / account.updated). Deposits must use payableAccount().
  if (id && mode() !== 'mock') return { accountId: id, mode: mode(), source: 'env', chargesEnabled: false, payoutsEnabled: false, unverified: true };
  return null;
}
const accountId = () => state()?.accountId || null;
// 'not_connected' | 'pending' | 'charges_enabled' (payouts ready when charges_enabled for Express)
function status() { const s = state(); return !s ? 'not_connected' : s.chargesEnabled ? 'charges_enabled' : 'pending'; }
const statusLabel = (st = status()) => ({ not_connected: 'Not connected', pending: 'Pending (onboarding not finished or Stripe review)', charges_enabled: 'Charges enabled' }[st]);

function fromAccount(a, source) {
  return { accountId: a.id, mode: mode(), source, chargesEnabled: !!a.charges_enabled, detailsSubmitted: !!a.details_submitted,
    payoutsEnabled: !!a.payouts_enabled, requirementsDue: [...(a.requirements?.currently_due || [])].slice(0, 20),
    disabledReason: a.requirements?.disabled_reason || null, checkedAt: new Date().toISOString(), accountType: 'express' };
}
function keepApproval(next, prev) {
  if (!prev) return next;
  if (prev.needsPayoutApproval) {
    next.needsPayoutApproval = true;
    next.payoutsApproved = !!prev.payoutsApproved;
    if (prev.payoutsApprovedAt) next.payoutsApprovedAt = prev.payoutsApprovedAt;
  }
  return next;
}
function notifyConnect(kind, detail) {
  try {
    const mail = require('./email');
    const shop = shopContext.current()?.shop;
    const who = shop?.name || 'Legacy line';
    mail.adminAlert(`BuzzCall: Connect ${kind}`, `${who}: ${detail}`);
    if (shop?.email) mail.ownerNotice(shop.email, `BuzzCall payout account ${kind}`, `${who}: ${detail}`);
  } catch (e) { console.error('[connect] notify failed:', e.message); }
}
// Account object (from retrieve or an account.updated event) -> state. Ignores other accounts.
function applyAccount(a) {
  if (!a || !a.id || a.id !== accountId()) return false;
  const prev = state();
  const next = keepApproval(fromAccount(a, prev?.source || 'onboarding'), prev);
  save(next);
  if (prev && prev.accountId === next.accountId && (prev.chargesEnabled !== next.chargesEnabled || prev.payoutsEnabled !== next.payoutsEnabled || prev.disabledReason !== next.disabledReason)) {
    notifyConnect('updated', `charges ${next.chargesEnabled ? 'on' : 'off'}, payouts ${next.payoutsEnabled ? 'on' : 'off'}${next.disabledReason ? `, ${next.disabledReason}` : ''}.`);
  }
  return true;
}
async function refresh() {
  const id = accountId();
  if (!id || mode() === 'mock') return state();
  applyAccount(await stripe().accounts.retrieve(id));
  return state();
}
// Before reading payout readiness: re-check Stripe if the account isn't known to be ready, at most every 5 min.
async function ensureFresh(maxAgeMs = 5 * 60000) {
  const s = state();
  if (!s || mode() === 'mock' || s.chargesEnabled) return s;
  if (s.checkedAt && Date.now() - Date.parse(s.checkedAt) < maxAgeMs) return s;
  try { return await refresh(); } catch (e) { console.error('[connect] account refresh failed:', e.message); return state(); }
}
// Connected Express account with charges enabled, or null. This is NOT enough to pay a
// brand-new account: payableAccount() also requires admin approval (P12).
function chargeAccount() {
  const s = state();
  return s && s.chargesEnabled ? s.accountId : null;
}
// Payout destination. Unverified env fallback (chargesEnabled false) is never returned.
// A Connect account created by this app stays unpaid until an admin approves it.
function payableAccount() {
  const s = state();
  if (!s || !s.chargesEnabled || s.unverified) return null;
  if (s.needsPayoutApproval && !s.payoutsApproved) return null;
  return s.accountId;
}
function approvePayouts() {
  const s = stored();
  if (!s || !s.accountId || s.deauthorized) return null;
  save({ ...s, needsPayoutApproval: true, payoutsApproved: true, payoutsApprovedAt: new Date().toISOString() });
  return stored();
}
function flagNewAccount(record) {
  const next = { ...record, needsPayoutApproval: true, payoutsApproved: false };
  save(next);
  const shop = shopContext.current();
  notifyConnect('account created', `New Express account ${next.accountId} needs admin approval before deposits can be paid out${shop ? ` (shop ${shop.id})` : ''}.`);
  return next;
}
// Deposits are always taken on the platform when Stripe (or mock) is available; Connect only gates payouts.
const depositsReady = () => mode() === 'mock' || !!key();
const payoutsReady = () => mode() === 'mock' ? !!chargeAccount() : !!chargeAccount();

// Admin/vendor onboarding: create Express account if none, then a single-use Account Link.
const onboarding = new Map();
async function persistAccount() {
  save(stored());
  await store.flush();
  const s = store.status();
  if (s.degraded || s.fallback || s.lastError) throw Object.assign(new Error('Payment storage unavailable; please retry later'), { status: 503 });
}
async function onboard(BASE, prefill = {}) {
  if (!shopContext.current()) return onboardAccount(BASE, prefill);
  const id = shopContext.shopId();
  if (onboarding.has(id)) return onboarding.get(id);
  const pending = onboardAccount(BASE, prefill);
  onboarding.set(id, pending);
  try { return await pending; } finally { onboarding.delete(id); }
}
async function onboardAccount(BASE, prefill = {}) {
  const prefix = shopContext.current() ? '/vendor/connect' : '/admin/connect';
  if (mode() === 'mock') {
    let s = stored();
    let created = false;
    if (!s || s.mode !== 'mock' || s.deauthorized) {
      s = { accountId: `acct_mock_${crypto.randomBytes(6).toString('hex')}`, mode: 'mock', source: 'onboarding', chargesEnabled: false,
        detailsSubmitted: false, payoutsEnabled: false, requirementsDue: ['mock onboarding'], accountType: 'express' };
      s = flagNewAccount(s);
      created = true;
    }
    if (shopContext.current()) await persistAccount();
    return { url: `${BASE}${prefix}/mock`, accountId: s.accountId, created };
  }
  let id = accountId(), created = false;
  if (!id) {
    const params = {
      type: 'express',
      capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
      metadata: { platform: 'buzzcall', ...(shopContext.current() ? { shopId: shopContext.shopId() } : {}) },
    };
    const bp = {};
    if (prefill.name) bp.name = String(prefill.name).slice(0, 100);
    if (prefill.url && /^https:\/\//.test(prefill.url)) bp.url = prefill.url;
    if (Object.keys(bp).length) params.business_profile = bp;
    if (prefill.email) params.email = prefill.email;
    const a = await stripe().accounts.create(params, ...(shopContext.current()
      ? [{ idempotencyKey: `connect-${shopContext.shopId()}-${mode()}` }] : []));
    id = a.id; created = true;
    flagNewAccount(fromAccount(a, 'onboarding'));
  }
  if (shopContext.current()) await persistAccount();
  const link = await stripe().accountLinks.create({ account: id, type: 'account_onboarding',
    refresh_url: `${BASE}${prefix}/refresh`, return_url: `${BASE}${prefix}/return` });
  return { url: link.url, accountId: id, created };
}
function mockComplete() {
  const s = stored();
  if (mode() !== 'mock' || !s || s.mode !== 'mock') return null;
  save({ ...s, chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true, requirementsDue: [], checkedAt: new Date().toISOString() });
  return stored();
}
function deauthorize() {
  const s = state();
  if (!s) return;
  save({ ...s, chargesEnabled: false, deauthorized: true });
  notifyConnect('disconnected', 'Stripe was disconnected. Vendor payouts stay paused until an admin reconnects and approves the account.');
}

// Livemode guard for Connect webhook events: test keys only accept test events, live keys only live events.
const livemodeOk = (event) => mode() === 'mock' || event.livemode === undefined || !!event.livemode === (mode() === 'live');

// Legacy lead-fee helper (still used when recording application-style fees against deposit amount).
function applicationFeeCents(amountCents, leadFee, waived) {
  if (waived) return 0;
  const fee = Math.min(Math.round(Number(leadFee || 0) * 100), amountCents - 1, Math.floor(amountCents / 3));
  return fee > 0 ? fee : 0;
}

function summary() {
  const s = state();
  return { mode: mode(), status: status(), label: statusLabel(), accountId: s?.accountId || null, source: s?.source || null,
    chargesEnabled: !!s?.chargesEnabled, detailsSubmitted: !!s?.detailsSubmitted, payoutsEnabled: !!s?.payoutsEnabled,
    requirementsDue: s?.requirementsDue || [], disabledReason: s?.disabledReason || null, checkedAt: s?.checkedAt || null,
    depositsReady: depositsReady(), payoutsReady: !!payableAccount(), accountType: s?.accountType || 'express',
    needsPayoutApproval: !!s?.needsPayoutApproval, payoutsApproved: !!s?.payoutsApproved };
}

module.exports = { mode, state, accountId, status, statusLabel, summary, refresh, ensureFresh, chargeAccount, payableAccount,
  approvePayouts, depositsReady, payoutsReady, onboard, mockComplete, deauthorize, applyAccount, livemodeOk, applicationFeeCents, stripe, setStripe };
