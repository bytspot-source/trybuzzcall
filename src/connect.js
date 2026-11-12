// Stripe Connect for direct charges. The customer pays the shop's connected account (Stripe-Account header).
// BuzzCall does not hold, transfer, or claw back that money. The account shape is isolated in accountCreateParams():
// new accounts are created with Accounts v2 (POST /v2/core/accounts).
// CONNECT_DASHBOARD=full (default) is the Standard-style direct-charge account: dashboard=full, the shop pays
// Stripe fees (fees_collector=stripe), Stripe collects losses (losses_collector=stripe), and the merchant
// card_payments capability is requested. Accounts v2 can request card_payments without stripe_transfers.
// CONNECT_DASHBOARD=express maps the legacy Express account: dashboard=express, fees_collector=application,
// losses_collector=application (the platform is liable), merchant card_payments, and recipient stripe_transfers.
// The owner picks. The dashboard cannot be changed after creation.
//
// Checkout, Billing, and the other v1 calls stay on API version 2024-06-20 (current_period_end is on the
// subscription). Accounts v2 create, retrieve, and Account Links send Stripe-Version 2026-10-28.endive.
//
// State lives in the config override (store.getOverride().stripeConnect, persisted to Postgres/config.json):
//   { accountId, mode: 'live'|'test'|'mock', source: 'onboarding'|'env', chargesEnabled, detailsSubmitted,
//     payoutsEnabled, requirementsDue[], disabledReason, deauthorized, checkedAt, updatedAt, accountsApi }
// STRIPE_CONNECT_ACCOUNT_ID (env) is only a backward-compatible fallback for the account id.
// Mock mode (no STRIPE_SECRET_KEY): no Stripe calls; onboarding is simulated (/admin/connect/mock or /vendor/connect/mock).
const crypto = require('crypto');
const store = require('./store');
const shopContext = require('./shopContext');

const key = () => process.env.STRIPE_SECRET_KEY || '';
// 'mock' (no key) | 'test' (sk_test_/rk_test_) | 'live' (sk_live_/rk_live_ or anything else)
const mode = () => (!key() ? 'mock' : /^(sk|rk)_test_/.test(key()) ? 'test' : 'live');
const envId = () => shopContext.current() ? null : (process.env.STRIPE_CONNECT_ACCOUNT_ID || '').trim() || null;

// Billing reads subscription.current_period_end, which later API versions moved onto the subscription item.
// Keep those calls on the version this app was written against. Accounts v2 uses the current stable version
// from https://docs.stripe.com/api/versioning (checked 2026-11-12: 2026-10-28.endive).
const PLATFORM_API_VERSION = '2024-06-20';
const ACCOUNTS_API_VERSION = '2026-10-28.endive';
const ACCOUNT_INCLUDE = ['configuration.merchant', 'configuration.recipient', 'defaults', 'identity', 'requirements'];

// Thin events for v2 accounts. Stripe delivers these on the "Your account" scope. Snapshot account.updated
// still arrives on the Connected accounts endpoint, including for v2 accounts.
// https://docs.stripe.com/connect/webhooks?accounts-namespace=v2
const V2_ACCOUNT_EVENTS = new Set([
  'v2.core.account.updated',
  'v2.core.account.closed',
  'v2.core.account[requirements].updated',
  'v2.core.account[configuration.merchant].updated',
  'v2.core.account[configuration.merchant].capability_status_updated',
  'v2.core.account[identity].updated',
  'v2.core.account[defaults].updated',
]);

let factory = null; // tests inject a fake client; never hits the network then
let client = null, clientKey = null;
function stripe() {
  if (factory) return factory();
  if (!client || clientKey !== key()) {
    const Stripe = require('stripe');
    client = new Stripe(key(), { apiVersion: PLATFORM_API_VERSION });
    clientKey = key();
  }
  return client;
}
const setStripe = (fn) => { factory = fn ? (typeof fn === 'function' ? fn : () => fn) : null; };
const v2Options = (extra) => ({ apiVersion: ACCOUNTS_API_VERSION, ...(extra || {}) });

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

function capActive(cap) { return !!(cap && cap.status === 'active'); }
function isV2Account(a) {
  return !!(a && a.object === 'v2.core.account');
}
function v2OpenEntries(a) {
  const entries = Array.isArray(a.requirements?.entries) ? a.requirements.entries : [];
  return entries.filter((e) => e && e.awaiting_action_from !== 'stripe'
    && (e.minimum_deadline?.status === 'currently_due' || e.minimum_deadline?.status === 'past_due'));
}
// v2 has no details_submitted field. Treat the form as submitted once card payments are active, or once
// Stripe is not waiting on the user for a currently_due or past_due requirement.
function v2DetailsSubmitted(a, chargesEnabled) {
  if (chargesEnabled) return true;
  if (!a.requirements) return false;
  const summary = a.requirements.summary?.minimum_deadline?.status;
  if (summary === 'currently_due' || summary === 'past_due') return false;
  return v2OpenEntries(a).length === 0;
}
function v2DisabledReason(a, card) {
  if (!card || card.status === 'active') return null;
  const code = card.status_details?.[0]?.code || null;
  // determining_status and requirements_pending_verification are review, not a disabled account.
  if (code && code !== 'determining_status' && code !== 'requirements_pending_verification') return code;
  const entries = Array.isArray(a.requirements?.entries) ? a.requirements.entries : [];
  const pastDue = entries.some((e) => e && (e.minimum_deadline?.status === 'past_due'
    || (e.impact?.restricts_capabilities || []).some((c) => c && (c.capability === 'card_payments' || c.configuration === 'merchant') && c.deadline?.status === 'past_due')));
  return pastDue ? 'requirements.past_due' : null;
}
function fromV2(a, source) {
  const card = a.configuration?.merchant?.capabilities?.card_payments;
  const payouts = a.configuration?.merchant?.capabilities?.stripe_balance?.payouts;
  const chargesEnabled = capActive(card);
  const profile = a.defaults?.profile || {};
  const identity = a.identity || {};
  const business = identity.business_details || {};
  return {
    accountId: a.id, mode: mode(), source, accountsApi: 'v2',
    chargesEnabled, detailsSubmitted: v2DetailsSubmitted(a, chargesEnabled),
    payoutsEnabled: capActive(payouts),
    requirementsDue: v2OpenEntries(a).map((e) => e.description).filter(Boolean).slice(0, 20),
    disabledReason: v2DisabledReason(a, card),
    checkedAt: new Date().toISOString(),
    accountType: a.dashboard === 'express' ? 'express' : 'standard',
    businessName: a.display_name || profile.doing_business_as || business.registered_name || null,
    businessUrl: profile.business_url || null,
    country: identity.country || null,
  };
}
function fromV1(a, source) {
  const profile = a.business_profile || {};
  return { accountId: a.id, mode: mode(), source, chargesEnabled: !!a.charges_enabled, detailsSubmitted: !!a.details_submitted,
    payoutsEnabled: !!a.payouts_enabled, requirementsDue: [...(a.requirements?.currently_due || [])].slice(0, 20),
    disabledReason: a.requirements?.disabled_reason || null, checkedAt: new Date().toISOString(), accountType: a.type || 'standard',
    businessName: profile.name || null, businessUrl: profile.url || null, country: a.country || null };
}
function fromAccount(a, source) {
  return isV2Account(a) ? fromV2(a, source) : fromV1(a, source);
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
  if (prev.accountsApi && !next.accountsApi) next.accountsApi = prev.accountsApi;
  if (prev.createAttempt) next.createAttempt = prev.createAttempt;
  if (!next.businessName && prev.businessName) next.businessName = prev.businessName;
  if (!next.businessUrl && prev.businessUrl) next.businessUrl = prev.businessUrl;
  if (!next.country && prev.country) next.country = prev.country;
  if (prev.nameMismatch) next.nameMismatch = true;
  return next;
}
// full (default): Accounts v2 dashboard=full, fees_collector=stripe, losses_collector=stripe.
// That is the v2 form of the v1 controller properties stripe_dashboard.type=full, fees.payer=account,
// losses.payments=stripe, requirement_collection=stripe. requirements_collector is calculated by Stripe.
// express: v2 form of legacy Express (losses.payments=application, fees.payer=application, dashboard express).
// CONNECT_DASHBOARD=express only if the owner accepts platform loss liability. It is not the pilot default.
function dashboardChoice() {
  return String(process.env.CONNECT_DASHBOARD || 'full').trim().toLowerCase() === 'express' ? 'express' : 'full';
}
// identity.country is required before configuration.merchant (error identity_country_required).
// The Accounts v2 create sample sends it in the same POST as configuration.merchant, as a lowercase
// ISO 3166-1 alpha-2 code (https://docs.stripe.com/api/v2/core/accounts/create). Unset defaults to US.
function accountCountry() {
  const raw = String(process.env.CONNECT_ACCOUNT_COUNTRY ?? '').trim().toLowerCase();
  if (!raw) return 'us';
  if (!/^[a-z]{2}$/.test(raw)) {
    throw Object.assign(new Error('CONNECT_ACCOUNT_COUNTRY must be a two-letter ISO country code. Leave it unset to use US.'), { status: 400, expose: true });
  }
  return raw;
}
function accountCreateParams(prefill = {}) {
  const shopId = shopContext.shopId();
  const express = dashboardChoice() === 'express';
  // Full dashboard: request merchant card_payments only.
  // v1 required transfers alongside card_payments (https://docs.stripe.com/connect/account-capabilities?accounts-namespace=v1
  // "For an Account to have the card_payments capability, you must request both card_payments and transfers.").
  // A live v1 create on this platform returned that error. Accounts v2 removed the pairing
  // (https://docs.stripe.com/connect/account-capabilities?accounts-namespace=v2 "you can request card_payments and
  // stripe_transfers independently"). The SaaS create sample for this responsibility set requests only card_payments:
  // https://docs.stripe.com/connect/saas/tasks/create
  // Express keeps both, matching the previous type=express request. stripe_transfers is the v2 recipient capability
  // (https://docs.stripe.com/api/v2/core/accounts/create). Checkout stays a direct charge either way.
  const params = {
    dashboard: express ? 'express' : 'full',
    metadata: { platform: 'buzzcall', chargeModel: 'direct', ...(shopId ? { shopId } : {}) },
    defaults: {
      responsibilities: express
        ? { fees_collector: 'application', losses_collector: 'application' }
        : { fees_collector: 'stripe', losses_collector: 'stripe' },
    },
    configuration: {
      merchant: { capabilities: { card_payments: { requested: true } } },
    },
    // Same request as merchant. v2 does not require stripe_transfers for card_payments
    // (https://docs.stripe.com/connect/account-capabilities?accounts-namespace=v2).
    identity: { country: accountCountry() },
    include: ['configuration.merchant', 'defaults', 'identity', 'requirements'],
  };
  if (express) {
    params.configuration.recipient = {
      capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
    };
    params.include = params.include.concat(['configuration.recipient']);
  }
  const profile = {};
  if (prefill.name) {
    const name = String(prefill.name).slice(0, 100);
    params.display_name = name;
    profile.doing_business_as = name;
  }
  if (prefill.url && /^https:\/\//.test(prefill.url)) profile.business_url = prefill.url;
  if (Object.keys(profile).length) params.defaults.profile = profile;
  if (prefill.email) params.contact_email = prefill.email;
  return params;
}
function redactSecrets(text) {
  return String(text || '')
    .replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g, '[redacted-key]')
    .replace(/\bwhsec_[A-Za-z0-9]+/g, '[redacted-secret]');
}
// Vendor routes hide unmarked 5xx behind a generic message. Stripe 4xx keeps its status so the message is shown.
function stripeOnboardError(e) {
  const statusCode = Number(e && (e.statusCode || e.status)) || 0;
  const code = (e && (e.code || (e.raw && e.raw.code))) || '';
  const requestId = (e && (e.requestId || (e.raw && e.raw.requestId))) || '';
  const detail = redactSecrets((e && e.message) || 'Stripe rejected the request');
  console.error('[connect] onboarding failed:', detail, JSON.stringify({
    type: (e && e.type) || null, code: code || null, statusCode: statusCode || null, requestId: requestId || null,
  }));
  const status = statusCode >= 400 && statusCode < 500 ? statusCode : 502;
  const message = `Stripe could not start payout onboarding${code ? ` (${code})` : ''}. ${detail}`;
  return Object.assign(new Error(message), { status, expose: true });
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
// Same pause rule as a v1 account.updated: charges off or a disabled reason stops new deposits.
function syncDepositPause(a) {
  if (!a) return stored();
  const row = fromAccount(a, 'webhook');
  if (!row.chargesEnabled || row.disabledReason) return markDepositsPaused(row.disabledReason || 'charges_disabled');
  return clearDepositsPause();
}
async function retrieveAccount(id) {
  const client = stripe();
  const v2 = client.v2?.core?.accounts?.retrieve;
  const preferV2 = state()?.accountsApi === 'v2' || !client.accounts?.retrieve;
  if (v2 && preferV2) {
    try {
      return await client.v2.core.accounts.retrieve(id, { include: ACCOUNT_INCLUDE }, v2Options());
    } catch (e) {
      const statusCode = Number(e && (e.statusCode || e.status)) || 0;
      if (statusCode === 404 && client.accounts?.retrieve) return client.accounts.retrieve(id);
      throw e;
    }
  }
  return client.accounts.retrieve(id);
}
async function refresh() {
  const id = accountId();
  if (!id || mode() === 'mock') return state();
  applyAccount(await retrieveAccount(id));
  return state();
}
// Before reading payout readiness: re-check Stripe if the account isn't known to be ready, at most every 5 min.
async function ensureFresh(maxAgeMs = 5 * 60000) {
  const s = state();
  if (!s || mode() === 'mock' || s.chargesEnabled) return s;
  if (s.checkedAt && Date.now() - Date.parse(s.checkedAt) < maxAgeMs) return s;
  try { return await refresh(); } catch (e) { console.error('[connect] account refresh failed:', redactSecrets(e && e.message)); return state(); }
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
async function createOnboardingLink(id, refreshUrl, returnUrl) {
  const client = stripe();
  // Accounts created here are v2 and use POST /v2/core/account_links. An older v1 account still uses
  // the v1 Account Link so a shop that connected before this change can finish onboarding.
  if (state()?.accountsApi === 'v2' || !client.accountLinks?.create) {
    return client.v2.core.accountLinks.create({
      account: id,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: { refresh_url: refreshUrl, return_url: returnUrl },
      },
    }, v2Options());
  }
  return client.accountLinks.create({ account: id, type: 'account_onboarding', refresh_url: refreshUrl, return_url: returnUrl });
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
    let a;
    try {
      a = await stripe().v2.core.accounts.create(params, v2Options(shopContext.current()
        ? { idempotencyKey: `connect-${shopContext.shopId()}-${mode()}-${dashboardChoice()}-${accountCountry()}-${attempt}` } : {}));
    } catch (e) { throw stripeOnboardError(e); }
    const taken = await accountUsedElsewhere(a.id);
    if (taken) throw Object.assign(new Error('That Stripe account is already linked to another shop.'), { status: 409 });
    id = a.id; created = true;
    const rec = fromAccount(a, 'onboarding');
    rec.accountsApi = 'v2';
    rec.accountModel = dashboardChoice();
    rec.accountType = dashboardChoice() === 'full' ? 'standard' : 'express';
    rec.createAttempt = attempt;
    const echoed = a.display_name || a.defaults?.profile?.doing_business_as || a.business_profile?.name;
    if (prefill.name && echoed && String(echoed).toLowerCase() !== String(prefill.name).toLowerCase()) rec.nameMismatch = true;
    flagNewAccount(rec);
  }
  if (!created && shopContext.current() && setupComplete()) {
    noteSetupRefresh();
    throw Object.assign(new Error('This Stripe account is already set up. Bank details are changed in the Stripe Dashboard, not from BuzzCall.'), { status: 409 });
  }
  if (shopContext.current()) await persistAccount();
  let link;
  try {
    link = await createOnboardingLink(id, `${BASE}${prefix}/refresh`, `${BASE}${prefix}/return`);
  } catch (e) { throw stripeOnboardError(e); }
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

const isV2AccountEvent = (type) => V2_ACCOUNT_EVENTS.has(type);
function eventAccountId(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.account) return event.account;
  const rel = event.related_object;
  if (rel && rel.id && (rel.type === 'v2.core.account' || String(rel.id).startsWith('acct_'))) return rel.id;
  const object = event.data && event.data.object;
  if (object && object.id && (object.object === 'v2.core.account' || object.object === 'account')) return object.id;
  return null;
}
// Snapshot events use constructEvent. Thin v2 notifications use parseEventNotification;
// Stripe's constructEvent rejects object "v2.core.event".
function constructEvent(rawBody, signature, secret) {
  const Stripe = require('stripe');
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
  let parsed = null;
  try { parsed = JSON.parse(payload.toString('utf8')); } catch { parsed = null; }
  if (parsed && parsed.object === 'v2.core.event') {
    const verifier = new Stripe(key() || 'sk_unused', { apiVersion: PLATFORM_API_VERSION });
    return verifier.parseEventNotification(payload, signature || '', secret);
  }
  return Stripe.webhooks.constructEvent(payload, signature || '', secret);
}
// Thin v2 account notifications do not include the account. Load it and apply the same charges gate.
async function handleAccountNotification(event) {
  const id = eventAccountId(event);
  if (!id || id !== accountId()) return { ignored: 'account mismatch' };
  if (!livemodeOk(event)) return { ignored: 'livemode mismatch' };
  if (event.type === 'v2.core.account.closed') {
    deauthorize();
    markDepositsPaused('deauthorized');
    return { closed: true, accountId: id };
  }
  const account = await stripe().v2.core.accounts.retrieve(id, { include: ACCOUNT_INCLUDE }, v2Options());
  applyAccount(account);
  syncDepositPause(account);
  return { ok: true, accountId: id };
}

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
  checkoutBlock, checkoutAccount, markDepositsPaused, clearDepositsPause, accountUsedElsewhere, dashboardChoice, accountCountry, accountCreateParams,
  approvePayouts, depositsReady, payoutsReady, onboard, mockComplete, deauthorize, applyAccount, livemodeOk, applicationFeeCents, stripe, setStripe,
  setupComplete, noteSetupRefresh, syncDepositPause, constructEvent, isV2AccountEvent, eventAccountId, handleAccountNotification,
  V2_ACCOUNT_EVENTS, ACCOUNTS_API_VERSION };
