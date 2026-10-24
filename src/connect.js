// Stripe Connect for deposits: each shop owner has their own Stripe account (v1 Accounts, default controller
// properties = Standard-equivalent: Stripe collects requirements, owner pays Stripe fees, Stripe covers losses, full
// Dashboard). Deposit Checkout Sessions are DIRECT charges created on that account (Stripe-Account header), so the
// shop is merchant of record and the money never touches BuzzCall's balance. See docs/stripe-connect-plan.md.
//
// State lives in the config override (store.getOverride().stripeConnect, persisted to Postgres/config.json):
//   { accountId, mode: 'live'|'test'|'mock', source: 'onboarding'|'env', chargesEnabled, detailsSubmitted,
//     payoutsEnabled, requirementsDue[], disabledReason, deauthorized, checkedAt, updatedAt }
// STRIPE_CONNECT_ACCOUNT_ID (env) is only a backward-compatible fallback for the account id; readiness is always
// read from Stripe (charges_enabled) before deposits are taken.
// Mock mode (no STRIPE_SECRET_KEY): no Stripe calls; onboarding is simulated (/admin/connect/mock).
const crypto = require('crypto');
const store = require('./store');

const key = () => process.env.STRIPE_SECRET_KEY || '';
// 'mock' (no key) | 'test' (sk_test_/rk_test_) | 'live' (sk_live_/rk_live_ or anything else)
const mode = () => (!key() ? 'mock' : /^(sk|rk)_test_/.test(key()) ? 'test' : 'live');
const envId = () => (process.env.STRIPE_CONNECT_ACCOUNT_ID || '').trim() || null;

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
  if (id && mode() !== 'mock') return { accountId: id, mode: mode(), source: 'env', chargesEnabled: false, unverified: true };
  return null;
}
const accountId = () => state()?.accountId || null;
// 'not_connected' | 'pending' | 'charges_enabled'
function status() { const s = state(); return !s ? 'not_connected' : s.chargesEnabled ? 'charges_enabled' : 'pending'; }
const statusLabel = (st = status()) => ({ not_connected: 'Not connected', pending: 'Pending (onboarding not finished or Stripe review)', charges_enabled: 'Charges enabled' }[st]);

function fromAccount(a, source) {
  return { accountId: a.id, mode: mode(), source, chargesEnabled: !!a.charges_enabled, detailsSubmitted: !!a.details_submitted,
    payoutsEnabled: !!a.payouts_enabled, requirementsDue: [...(a.requirements?.currently_due || [])].slice(0, 20),
    disabledReason: a.requirements?.disabled_reason || null, checkedAt: new Date().toISOString() };
}
// Account object (from retrieve or an account.updated event) -> state. Ignores other accounts.
function applyAccount(a) {
  if (!a || !a.id || a.id !== accountId()) return false;
  save(fromAccount(a, state()?.source || 'onboarding'));
  return true;
}
async function refresh() {
  const id = accountId();
  if (!id || mode() === 'mock') return state();
  applyAccount(await stripe().accounts.retrieve(id));
  return state();
}
// Before a deposit: re-check Stripe if the account isn't known to be ready (e.g. env-only id), at most every 5 min.
async function ensureFresh(maxAgeMs = 5 * 60000) {
  const s = state();
  if (!s || mode() === 'mock' || s.chargesEnabled) return s;
  if (s.checkedAt && Date.now() - Date.parse(s.checkedAt) < maxAgeMs) return s;
  try { return await refresh(); } catch (e) { console.error('[connect] account refresh failed:', e.message); return state(); }
}
// Account to create deposit Checkout Sessions on, or null (fail closed). Mock mode has no real money: deposits keep
// using /pay/mock and are tagged with the mock account if one was "onboarded".
function chargeAccount() {
  const s = state();
  return s && s.chargesEnabled ? s.accountId : null;
}
const depositsReady = () => mode() === 'mock' || !!chargeAccount();

// Admin onboarding: create the account if none, then a single-use Account Link. Returns { url, accountId, created }.
async function onboard(BASE, prefill = {}) {
  if (mode() === 'mock') {
    let s = stored();
    if (!s || s.mode !== 'mock' || s.deauthorized) {
      s = { accountId: `acct_mock_${crypto.randomBytes(6).toString('hex')}`, mode: 'mock', source: 'onboarding', chargesEnabled: false,
        detailsSubmitted: false, payoutsEnabled: false, requirementsDue: ['mock onboarding'] };
      save(s);
    }
    return { url: `${BASE}/admin/connect/mock`, accountId: s.accountId, created: true };
  }
  let id = accountId(), created = false;
  if (!id) {
    const params = {
      // Default controller properties, spelled out (= Standard): owner pays Stripe fees, Stripe owns losses and
      // requirement collection, full Stripe Dashboard. No `type`.
      controller: { fees: { payer: 'account' }, losses: { payments: 'stripe' }, requirement_collection: 'stripe', stripe_dashboard: { type: 'full' } },
      metadata: { platform: 'buzzcall' },
    };
    const bp = {};
    if (prefill.name) bp.name = String(prefill.name).slice(0, 100);
    if (prefill.url && /^https:\/\//.test(prefill.url)) bp.url = prefill.url;
    if (Object.keys(bp).length) params.business_profile = bp;
    if (prefill.email) params.email = prefill.email;
    const a = await stripe().accounts.create(params);
    id = a.id; created = true;
    save(fromAccount(a, 'onboarding'));
  }
  const link = await stripe().accountLinks.create({ account: id, type: 'account_onboarding',
    refresh_url: `${BASE}/admin/connect/refresh`, return_url: `${BASE}/admin/connect/return` });
  return { url: link.url, accountId: id, created };
}
function mockComplete() {
  const s = stored();
  if (mode() !== 'mock' || !s || s.mode !== 'mock') return null;
  save({ ...s, chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true, requirementsDue: [], checkedAt: new Date().toISOString() });
  return stored();
}
function deauthorize() { const s = state(); if (s) save({ ...s, chargesEnabled: false, deauthorized: true }); }

// Livemode guard for Connect webhook events: test keys only accept test events, live keys only live events.
const livemodeOk = (event) => mode() === 'mock' || event.livemode === undefined || !!event.livemode === (mode() === 'live');

// Lead fee as a direct-charge application fee (cents). 0 when waived. When enabled it is capped at
// amount - 1 cent (Stripe requires fee < charge) and at no more than 1/3 of the deposit.
function applicationFeeCents(amountCents, leadFee, waived) {
  if (waived) return 0;
  const fee = Math.min(Math.round(Number(leadFee || 0) * 100), amountCents - 1, Math.floor(amountCents / 3));
  return fee > 0 ? fee : 0;
}

function summary() {
  const s = state();
  return { mode: mode(), status: status(), label: statusLabel(), accountId: s?.accountId || null, source: s?.source || null,
    chargesEnabled: !!s?.chargesEnabled, detailsSubmitted: !!s?.detailsSubmitted, payoutsEnabled: !!s?.payoutsEnabled,
    requirementsDue: s?.requirementsDue || [], disabledReason: s?.disabledReason || null, checkedAt: s?.checkedAt || null, depositsReady: depositsReady() };
}

module.exports = { mode, state, accountId, status, statusLabel, summary, refresh, ensureFresh, chargeAccount, depositsReady, onboard,
  mockComplete, deauthorize, applyAccount, livemodeOk, applicationFeeCents, stripe, setStripe };
