// Stripe Connect for direct charges. The customer pays the shop's connected account (Stripe-Account header).
// BuzzCall does not hold, transfer, or claw back that money. The account shape is isolated in accountCreateParams():
// CONNECT_DASHBOARD=full (default) sets v1 controller properties equivalent to a Standard account
// (full dashboard, the shop pays Stripe fees, Stripe collects losses). CONNECT_DASHBOARD=express opts into
// legacy Express, where Stripe's account-type table makes the platform liable for disputes. The owner picks.
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
  const profile = a.business_profile || {};
  return { accountId: a.id, mode: mode(), source, chargesEnabled: !!a.charges_enabled, detailsSubmitted: !!a.details_submitted,
    payoutsEnabled: !!a.payouts_enabled, requirementsDue: [...(a.requirements?.currently_due || [])].slice(0, 20),
    disabledReason: a.requirements?.disabled_reason || null, checkedAt: new Date().toISOString(), accountType: a.type || 'standard',
    businessName: profile.name || null, businessUrl: profile.url || null, country: a.country || null };
}
function keepApproval(next, prev) {
  if (!prev) return next;
  if (prev.needsPayoutApproval) {
    next.needsPayoutApproval = true;
    next.payoutsApproved = !!prev.payoutsApproved;
    if (prev.payoutsApprovedAt) next.payoutsApprovedAt = prev.payoutsApprovedAt;
  }
  if (prev.depositsPaused) next.depositsPaused = prev.depositsPaused;
  if (prev.accountModel) next.accountModel = prev.accountModel;
  if (prev.createAttempt) next.createAttempt = prev.createAttempt;
  if (!next.businessName && prev.businessName) next.businessName = prev.businessName;
  if (!next.businessUrl && prev.businessUrl) next.businessUrl = prev.businessUrl;
  if (!next.country && prev.country) next.country = prev.country;
  if (prev.nameMismatch) next.nameMismatch = true;
  return next;
}
// full (default): v1 controller properties equivalent to Accounts v2 dashboard=full,
// fees_collector=stripe, losses_collector=stripe. stripe@16 cannot call /v2/core/accounts.
// express: legacy Express. Stripe's account-type table says the platform is liable for those disputes.
// CONNECT_DASHBOARD=express only if the owner accepts that. It is not the pilot default.
function dashboardChoice() {
  return String(process.env.CONNECT_DASHBOARD || 'full').trim().toLowerCase() === 'express' ? 'express' : 'full';
}
function accountCreateParams(prefill = {}) {
  const shopId = shopContext.shopId();
  const params = { metadata: { platform: 'buzzcall', chargeModel: 'direct', ...(shopId ? { shopId } : {}) } };
  const bp = {};
  if (prefill.name) bp.name = String(prefill.name).slice(0, 100);
  if (prefill.url && /^https:\/\//.test(prefill.url)) bp.url = prefill.url;
  if (Object.keys(bp).length) params.business_profile = bp;
  if (prefill.email) params.email = prefill.email;
  if (dashboardChoice() === 'express') {
    params.type = 'express';
    params.capabilities = { card_payments: { requested: true }, transfers: { requested: true } };
  } else {
    params.controller = {
      stripe_dashboard: { type: 'full' },
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    };
    params.capabilities = { card_payments: { requested: true } };
  }
  return params;
}
function notifyConnect(kind, detail) {
  const shop = shopContext.current()?.shop;
  const who = shop?.name || 'Legacy line';
  const text = `${who}: ${detail}`;
  try {
    store.root.addAlert({ leadId: null, to: 'platform-admin', kind: 'connect', body: `Connect ${kind}: ${text}` });
  } catch (e) { console.error('[connect] in-app alert failed:', e.message); }
  try {
    const mail = require('./email');
    mail.adminAlert(`BuzzCall: Connect ${kind}`, text);
    if (shop?.email) mail.ownerNotice(shop.email, `BuzzCall payout account ${kind}`, text);
  } catch (e) { console.error('[connect] notify failed:', e.message); }
}
// Account object (from retrieve or an account.updated event) -> state. Ignores other accounts.
function applyAccount(a) {
  if (!a || !a.id || a.id !== accountId()) return false;
  const prev = state();
  const next = keepApproval(fromAccount(a, prev?.source || 'onboarding'), prev);
  const shopName = shopContext.current()?.shop?.name || '';
  if (next.businessName && shopName && next.businessName.trim().toLowerCase() !== shopName.trim().toLowerCase()) next.nameMismatch = true;
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
// Direct-charge checkout is allowed only when the shop can actually charge and an admin has approved the link.
function checkoutBlock() {
  const s = state();
  if (!s || !s.accountId || s.deauthorized || s.unverified) return 'not_connected';
  if (s.disabledReason) return 'disabled';
  if (s.depositsPaused) return 'deposits_paused';
  if (!s.chargesEnabled) return 'charges_disabled';
  if (s.needsPayoutApproval && !s.payoutsApproved) return 'needs_approval';
  return null;
}
const checkoutAccount = () => (checkoutBlock() ? null : state().accountId);
function markDepositsPaused(reason) {
  const s = stored();
  if (!s) return null;
  save({ ...s, depositsPaused: true, depositsPausedReason: reason || 'paused', chargesEnabled: reason === 'deauthorized' ? false : s.chargesEnabled });
  return stored();
}
function clearDepositsPause() {
  const s = stored();
  if (!s || s.deauthorized) return s;
  save({ ...s, depositsPaused: false, depositsPausedReason: null });
  return stored();
}
async function accountUsedElsewhere(accountId) {
  if (!accountId) return null;
  const vendors = require('./vendors');
  const self = shopContext.shopId();
  if (!self && (process.env.STRIPE_CONNECT_ACCOUNT_ID || '').trim() === accountId) return null;
  if (self && (process.env.STRIPE_CONNECT_ACCOUNT_ID || '').trim() === accountId) return 'legacy';
  for (const shop of vendors.all()) {
    if (!shop || shop.id === self || shop.status === 'provisioning') continue;
    let hit = null;
    try {
      hit = await vendors.run(shop.id, () => {
        const row = require('./store').getOverride().stripeConnect;
        return row && row.accountId === accountId && !row.deauthorized ? shop.id : null;
      }, { suspended: true });
    } catch { hit = null; }
    if (hit) return hit;
  }
  return null;
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
  notifyConnect('account created', `New Stripe account ${next.accountId} (${next.accountModel || 'full'} dashboard) needs admin approval before this shop can take deposits${shop ? ` (shop ${shop.id})` : ''}.`);
  return next;
}
// Live/test: a direct-charge checkout would be allowed. Mock: local pay pages still work with no Stripe account.
const depositsReady = () => mode() === 'mock' ? !stored()?.deauthorized : !checkoutBlock();
const payoutsReady = () => mode() === 'mock' ? !!chargeAccount() : !!chargeAccount();

// Admin/vendor onboarding: create the configured account if none, then a single-use Account Link.
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
        detailsSubmitted: false, payoutsEnabled: false, requirementsDue: ['mock onboarding'], accountType: 'standard', accountModel: dashboardChoice() };
      const taken = await accountUsedElsewhere(s.accountId);
      if (taken) throw Object.assign(new Error('That Stripe account is already linked to another shop.'), { status: 409 });
      s = flagNewAccount(s);
      created = true;
    }
    if (shopContext.current()) await persistAccount();
    return { url: `${BASE}${prefix}/mock`, accountId: s.accountId, created };
  }
  let id = accountId(), created = false;
  if (!id) {
    const params = accountCreateParams(prefill);
    const prev = stored();
    const attempt = prev && prev.deauthorized ? (Number(prev.createAttempt) || 1) + 1 : (Number(prev?.createAttempt) || 1);
    const a = await stripe().accounts.create(params, ...(shopContext.current()
      ? [{ idempotencyKey: `connect-${shopContext.shopId()}-${mode()}-${dashboardChoice()}-${attempt}` }] : []));
    const taken = await accountUsedElsewhere(a.id);
    if (taken) throw Object.assign(new Error('That Stripe account is already linked to another shop.'), { status: 409 });
    id = a.id; created = true;
    const rec = fromAccount(a, 'onboarding');
    rec.accountModel = dashboardChoice();
    rec.accountType = dashboardChoice() === 'full' ? 'standard' : 'express';
    rec.createAttempt = attempt;
    if (prefill.name && a.business_profile?.name && String(a.business_profile.name).toLowerCase() !== String(prefill.name).toLowerCase()) rec.nameMismatch = true;
    flagNewAccount(rec);
  }
  if (!created && shopContext.current() && setupComplete()) {
    noteSetupRefresh();
    throw Object.assign(new Error('This Stripe account is already set up. Bank details are changed in the Stripe Dashboard, not from BuzzCall.'), { status: 409 });
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
function setupComplete() {
  const s = state();
  return !!(s && s.accountId && s.detailsSubmitted && s.chargesEnabled && !s.deauthorized);
}
function noteSetupRefresh() {
  notifyConnect('onboarding refresh blocked', 'A signed-in session asked for a new Stripe onboarding link after this account was already set up. No link was created.');
}
function deauthorize() {
  const s = stored();
  if (!s || !s.accountId) return;
  save({ ...s, chargesEnabled: false, deauthorized: true, createAttempt: s.createAttempt || 1 });
  notifyConnect('disconnected', 'Stripe was disconnected. Deposit links for this shop are stopped. The shop refunds any payment already taken in its own Stripe Dashboard.');
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
    depositsReady: !checkoutBlock(), payoutsReady: !!checkoutAccount(), accountType: s?.accountType || (dashboardChoice() === 'full' ? 'standard' : 'express'),
    accountModel: s?.accountModel || dashboardChoice(),
    needsPayoutApproval: !!s?.needsPayoutApproval, payoutsApproved: !!s?.payoutsApproved,
    depositsPaused: !!s?.depositsPaused,
    businessName: s?.businessName || null, businessUrl: s?.businessUrl || null, country: s?.country || null,
    nameMismatch: !!s?.nameMismatch };
}

module.exports = { mode, state, accountId, status, statusLabel, summary, refresh, ensureFresh, chargeAccount, payableAccount,
  checkoutBlock, checkoutAccount, markDepositsPaused, clearDepositsPause, accountUsedElsewhere, dashboardChoice, accountCreateParams,
  approvePayouts, depositsReady, payoutsReady, onboard, mockComplete, deauthorize, applyAccount, livemodeOk, applicationFeeCents, stripe, setStripe,
  setupComplete, noteSetupRefresh };
