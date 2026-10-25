// Effective shop config: stored override (data/config.json, written by admin 'Apply to this line') > env > code default.
// In a shop context, business keys read ONLY that shop's override/defaults, never
// the legacy root environment. Infrastructure credentials remain platform-level.
const store = require('./store');
const shopContext = require('./shopContext');

const KEYS = ['BUSINESS_NAME', 'BUSINESS_CITY', 'BUSINESS_TYPE', 'BUSINESS_FLOW', 'BUSINESS_TRADE_LABEL', 'VERTICAL', 'BUSINESS_VERTICAL', 'OWNER_PHONE', 'FORWARD_TO_PHONE',
  'RING_TIMEOUT_SECONDS', 'BUSINESS_TZ', 'BUSINESS_DAYS', 'BUSINESS_HOURS', 'SERVICES', 'BOOKING_ENABLED', 'SLOT_MINUTES',
  'BOOKING_LEAD_MINUTES', 'DEPOSIT_ENABLED', 'DEPOSIT_AMOUNT', 'HOLD_MINUTES', 'BOOKING_LINK', 'SLOT_STEP_MINUTES', 'LEAD_FEE', 'LEAD_FEE_WAIVED', 'HELP_MESSAGE', 'INACTIVE_MESSAGE', 'INACTIVE_MODE'];
// These legacy deployment settings identify or customize a single owner. Never
// inherit them in a vendor context; provider credentials and platform prices stay shared.
const ISOLATED_KEYS = new Set([...KEYS, 'STRIPE_CONNECT_ACCOUNT_ID', 'BILLING_PORTAL_RETURN_URL',
  'SETUP_FEE_WAIVED', 'SETUP_WAIVER_CODE', 'TZ']);
const startTZ = process.env.TZ;

const values = () => store.getOverride().values || {};
const fromOverride = (k) => (KEYS.includes(k) || (shopContext.current() && ISOLATED_KEYS.has(k))) && Object.prototype.hasOwnProperty.call(values(), k);
// An override saved before trades existed (VERTICAL but no BUSINESS_TYPE) must not pick up an env BUSINESS_TYPE.
const TRADE_KEYS = ['BUSINESS_TYPE', 'BUSINESS_FLOW', 'BUSINESS_TRADE_LABEL'];
const legacyOverride = (k) => TRADE_KEYS.includes(k) && !fromOverride('BUSINESS_TYPE') && (fromOverride('VERTICAL') || fromOverride('BUSINESS_VERTICAL'));
const env = new Proxy(process.env, {
  get(target, k) {
    if (typeof k !== 'string') return target[k];
    const context = shopContext.current();
    if (context && k === 'TWILIO_PHONE_NUMBER') return context.shop.phoneNumber || undefined;
    if (fromOverride(k)) return values()[k];
    if (context && ISOLATED_KEYS.has(k)) return k === 'BUSINESS_TZ' ? 'America/New_York' : undefined;
    return legacyOverride(k) ? '' : target[k];
  },
});

// Where each shop-config key currently comes from (for /admin). Non-secret keys only.
function effective() {
  return KEYS.map((key) => {
    if (fromOverride(key)) return { key, value: values()[key], source: 'override' };
    if (shopContext.current()) return { key, value: env[key] || '', source: 'default' };
    if (process.env[key] !== undefined && process.env[key] !== '') return { key, value: process.env[key], source: 'env' };
    return { key, value: '', source: 'default' };
  });
}
function applyTZ() {
  if (shopContext.current()) return; // process TZ is shared: only legacy root may change it.
  const tz = env.BUSINESS_TZ;
  if (tz) process.env.TZ = tz; else if (startTZ === undefined) delete process.env.TZ; else process.env.TZ = startTZ;
}
function apply(map, meta = {}) {
  const clean = {};
  for (const k of KEYS) if (map && map[k] !== undefined && map[k] !== null) clean[k] = String(map[k]);
  const keep = store.getOverride().stripeConnect; // Stripe Connect state (src/connect.js) survives re-applying the setup
  store.setOverride({ values: clean, ...meta, appliedAt: new Date().toISOString(), ...(keep ? { stripeConnect: keep } : {}) });
  applyTZ();
  return clean;
}
function clear() { const keep = store.getOverride().stripeConnect; store.setOverride(keep ? { stripeConnect: keep } : {}); applyTZ(); }

module.exports = { env, KEYS, effective, apply, clear, applyTZ, override: () => store.getOverride() };
