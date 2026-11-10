// Stripe Connect for deposit payouts. Customer deposits are charged on BuzzCall's platform account
// (separate charges + transfers — see src/deposits.js). Funds are NOT sent to the vendor at booking;
// a Transfer runs after the appointment. Destination charges transfer immediately, so they cannot delay payout until
// after the job.
//
// Account creation uses Accounts v2. Bytspot's platform is on Managed Risk, which rejects Accounts v1
// `type=express`. New accounts are created with dashboard=express (public preview API version), Stripe as the
// fees collector and the losses collector, the merchant card_payments capability, and Stripe-hosted onboarding
// (Account Links). See https://docs.stripe.com/connect/risk-management/connected-accounts-with-managed-risk
// and https://docs.stripe.com/connect/risk-management/managed-risk
//
// Separate charges and transfers are not a Managed Risk compatible charge type. This file still records whether
// the account can receive /v1/transfers (recipient stripe_transfers). Deposit release only transfers when that
// capability is active. Existing rows that predate the flag keep the old chargesEnabled gate.
//
// State lives in the config override (store.getOverride().stripeConnect, persisted to Postgres/config.json):
//   { accountId, mode: 'live'|'test'|'mock', source: 'onboarding'|'env', chargesEnabled, detailsSubmitted,
//     payoutsEnabled, transfersEnabled, requirementsDue[], disabledReason, deauthorized, checkedAt, updatedAt }
// STRIPE_CONNECT_ACCOUNT_ID (env) is only a backward-compatible fallback for the account id.
// Mock mode (no STRIPE_SECRET_KEY): no Stripe calls; onboarding is simulated (/admin/connect/mock or /vendor/connect/mock).
const crypto = require('crypto');
const store = require('./store');
const shopContext = require('./shopContext');

const key = () => process.env.STRIPE_SECRET_KEY || '';
// 'mock' (no key) | 'test' (sk_test_/rk_test_) | 'live' (sk_live_/rk_live_ or anything else)
const mode = () => (!key() ? 'mock' : /^(sk|rk)_test_/.test(key()) ? 'test' : 'live');
const envId = () => shopContext.current() ? null : (process.env.STRIPE_CONNECT_ACCOUNT_ID || '').trim() || null;

// Checkout, Billing, Transfers, and Refunds stay on the API version this app was built against
// (current_period_end lives on the subscription). Accounts v2 Express + Managed Risk is preview-only
// and passes CONNECT_API_VERSION on those requests.
const PLATFORM_API_VERSION = '2024-06-20';
const CONNECT_API_VERSION = '2026-10-28.preview';
const ACCOUNT_INCLUDE = ['configuration.merchant', 'defaults', 'identity', 'requirements'];

// Thin events for v2 accounts. Delivered on the "Your account" scope, not the Connected accounts scope.
// Snapshot account.updated still arrives on the Connected accounts endpoint. Handled on both webhook routes.
const V2_ACCOUNT_EVENTS = new Set([
  'v2.core.account.updated',
  'v2.core.account[requirements].updated',
  'v2.core.account[configuration.merchant].updated',
  'v2.core.account[configuration.merchant].capability_status_updated',
  'v2.core.account[configuration.recipient].updated',
  'v2.core.account[configuration.recipient].capability_status_updated',
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
const v2Options = (extra) => ({ apiVersion: CONNECT_API_VERSION, ...(extra || {}) });

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
// charges_enabled means the merchant card_payments capability is active (or the legacy v1 flag).
// Receiving a platform Transfer is separate: see transfersEnabled / chargeAccount.
function status() { const s = state(); return !s ? 'not_connected' : s.chargesEnabled ? 'charges_enabled' : 'pending'; }
const statusLabel = (st = status()) => ({ not_connected: 'Not connected', pending: 'Pending (onboarding not finished or Stripe review)', charges_enabled: 'Charges enabled' }[st]);

function capActive(cap) { return !!(cap && cap.status === 'active'); }
function isV2Account(a) {
  return !!(a && (a.object === 'v2.core.account' || a.configuration));
}
function v2RequirementsDue(a) {
  const entries = Array.isArray(a.requirements?.entries) ? a.requirements.entries : [];
  return entries.filter((e) => e && e.awaiting_action_from !== 'stripe'
    && (e.minimum_deadline?.status === 'currently_due' || e.minimum_deadline?.status === 'past_due'))
    .map((e) => e.description).filter(Boolean).slice(0, 20);
}
function v2DetailsSubmitted(a) {
  if (!a.requirements) return false;
  const summary = a.requirements.summary?.minimum_deadline?.status;
  if (summary === 'currently_due' || summary === 'past_due') return false;
  return v2RequirementsDue(a).length === 0;
}
function fromV2(a, source) {
  const merchant = a.configuration?.merchant?.capabilities || {};
  const recipient = a.configuration?.recipient?.capabilities?.stripe_balance || {};
  const card = merchant.card_payments;
  const transfers = recipient.stripe_transfers;
  const payouts = merchant.stripe_balance?.payouts || recipient.payouts;
  const due = v2RequirementsDue(a);
  const disabled = card?.status_details?.[0]?.code || transfers?.status_details?.[0]?.code || payouts?.status_details?.[0]?.code || null;
  return {
    accountId: a.id, mode: mode(), source,
    chargesEnabled: capActive(card) || capActive(transfers),
    detailsSubmitted: v2DetailsSubmitted(a),
    payoutsEnabled: capActive(payouts),
    transfersEnabled: capActive(transfers),
    requirementsDue: due,
    disabledReason: disabled || (due.length ? 'requirements.past_due' : null),
    checkedAt: new Date().toISOString(),
    accountType: a.dashboard || 'express',
    lossesCollector: a.defaults?.responsibilities?.losses_collector || null,
  };
}
function fromV1(a, source) {
  const cap = a.capabilities?.transfers;
  const row = {
    accountId: a.id, mode: mode(), source, chargesEnabled: !!a.charges_enabled, detailsSubmitted: !!a.details_submitted,
    payoutsEnabled: !!a.payouts_enabled, requirementsDue: [...(a.requirements?.currently_due || [])].slice(0, 20),
    disabledReason: a.requirements?.disabled_reason || null, checkedAt: new Date().toISOString(),
    accountType: a.type || a.dashboard || 'express',
  };
  // A v1 snapshot that names the transfers capability is explicit. Omit the flag when it is absent so older
  // stored rows and fixtures keep the chargesEnabled payout gate.
  if (cap != null) row.transfersEnabled = (typeof cap === 'string' ? cap : cap.status) === 'active';
  return row;
}
function fromAccount(a, source) {
  return isV2Account(a) ? fromV2(a, source) : fromV1(a, source);
}
// Account object (from retrieve or an account.updated event) -> state. Ignores other accounts.
function applyAccount(a) {
  if (!a || !a.id || a.id !== accountId()) return false;
  save(fromAccount(a, state()?.source || 'onboarding'));
  return true;
}
async function retrieveAccount(id) {
  return stripe().v2.core.accounts.retrieve(id, { include: ACCOUNT_INCLUDE }, v2Options());
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
// Connected account that can receive a separate-charge Transfer, or null.
// Legacy rows with no transfersEnabled flag stay on the old chargesEnabled gate.
function chargeAccount() {
  const s = state();
  if (!s) return null;
  if (typeof s.transfersEnabled === 'boolean') return s.transfersEnabled ? s.accountId : null;
  return s.chargesEnabled ? s.accountId : null;
}
// Deposits are always taken on the platform when Stripe (or mock) is available; Connect only gates payouts.
const depositsReady = () => mode() === 'mock' || !!key();
const payoutsReady = () => !!chargeAccount();

function redactSecrets(text) {
  return String(text || '')
    .replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g, '[redacted-key]')
    .replace(/\bwhsec_[A-Za-z0-9]+/g, '[redacted-secret]');
}
// Stripe errors often use statusCode, not status. Vendor routes hide unmarked 5xx behind a generic message.
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

// Admin/vendor onboarding: create an Accounts v2 Express account if none, then a single-use Account Link.
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
function accountCreateParams(prefill = {}) {
  // Managed Risk sample: Express dashboard (preview), Stripe collects fees and losses, merchant card_payments.
  // https://docs.stripe.com/connect/risk-management/connected-accounts-with-managed-risk
  // Recipient stripe_transfers (the capability that receives separate-charge Transfers) is not part of that
  // sample. Managed Risk says indirect charges, including separate charges and transfers, are not compatible.
  const params = {
    dashboard: 'express',
    identity: { country: 'US' },
    configuration: {
      merchant: { capabilities: { card_payments: { requested: true } } },
    },
    defaults: {
      currency: 'usd',
      responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
    },
    metadata: { platform: 'buzzcall', ...(shopContext.current() ? { shopId: shopContext.shopId() } : {}) },
    include: ACCOUNT_INCLUDE,
  };
  if (prefill.email) params.contact_email = String(prefill.email).slice(0, 200);
  if (prefill.name) params.display_name = String(prefill.name).slice(0, 100);
  if (prefill.url && /^https:\/\//.test(prefill.url)) params.defaults.profile = { business_url: prefill.url };
  return params;
}
async function onboardAccount(BASE, prefill = {}) {
  const prefix = shopContext.current() ? '/vendor/connect' : '/admin/connect';
  if (mode() === 'mock') {
    let s = stored();
    if (!s || s.mode !== 'mock' || s.deauthorized) {
      s = { accountId: `acct_mock_${crypto.randomBytes(6).toString('hex')}`, mode: 'mock', source: 'onboarding', chargesEnabled: false,
        detailsSubmitted: false, payoutsEnabled: false, requirementsDue: ['mock onboarding'], accountType: 'express' };
      save(s);
    }
    if (shopContext.current()) await persistAccount();
    return { url: `${BASE}${prefix}/mock`, accountId: s.accountId, created: true };
  }
  let id = accountId(), created = false;
  if (!id) {
    const params = accountCreateParams(prefill);
    const options = v2Options(shopContext.current()
      ? { idempotencyKey: `connect-${shopContext.shopId()}-${mode()}` } : {});
    let a;
    try { a = await stripe().v2.core.accounts.create(params, options); }
    catch (e) { throw stripeOnboardError(e); }
    id = a.id; created = true;
    save(fromAccount(a, 'onboarding'));
  }
  if (shopContext.current()) await persistAccount();
  let link;
  try {
    link = await stripe().accountLinks.create({ account: id, type: 'account_onboarding',
      refresh_url: `${BASE}${prefix}/refresh`, return_url: `${BASE}${prefix}/return` });
  } catch (e) { throw stripeOnboardError(e); }
  return { url: link.url, accountId: id, created };
}
function mockComplete() {
  const s = stored();
  if (mode() !== 'mock' || !s || s.mode !== 'mock') return null;
  save({ ...s, chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true, requirementsDue: [], checkedAt: new Date().toISOString() });
  return stored();
}
function deauthorize() { const s = state(); if (s) save({ ...s, chargesEnabled: false, transfersEnabled: false, deauthorized: true }); }

// Livemode guard for Connect webhook events: test keys only accept test events, live keys only live events.
const livemodeOk = (event) => mode() === 'mock' || event.livemode === undefined || !!event.livemode === (mode() === 'live');

const isV2AccountEvent = (type) => V2_ACCOUNT_EVENTS.has(type);
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
function eventAccountId(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.account) return event.account;
  const rel = event.related_object;
  if (rel && rel.id && (rel.type === 'v2.core.account' || String(rel.id).startsWith('acct_'))) return rel.id;
  const object = event.data && event.data.object;
  if (object && object.id && (object.object === 'v2.core.account' || object.object === 'account')) return object.id;
  return null;
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
    transfersEnabled: typeof s?.transfersEnabled === 'boolean' ? s.transfersEnabled : null,
    requirementsDue: s?.requirementsDue || [], disabledReason: s?.disabledReason || null, checkedAt: s?.checkedAt || null,
    depositsReady: depositsReady(), payoutsReady: payoutsReady(), accountType: s?.accountType || 'express',
    lossesCollector: s?.lossesCollector || null };
}

module.exports = { mode, state, accountId, status, statusLabel, summary, refresh, ensureFresh, chargeAccount, depositsReady,
  payoutsReady, onboard, mockComplete, deauthorize, applyAccount, livemodeOk, applicationFeeCents, stripe, setStripe,
  isV2AccountEvent, eventAccountId, constructEvent, V2_ACCOUNT_EVENTS, CONNECT_API_VERSION };
