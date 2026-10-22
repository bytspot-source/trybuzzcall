// Effective shop config: stored override (data/config.json, written by admin 'Apply to this line') > env > code default.
// `env` is a drop-in for process.env: shop-config keys come from the override when present, everything else
// (secrets, Stripe, Twilio, ...) passes straight through to process.env. Defaults stay where they were (booking.js etc.).
const store = require('./store');

const KEYS = ['BUSINESS_NAME', 'BUSINESS_CITY', 'BUSINESS_TYPE', 'BUSINESS_FLOW', 'BUSINESS_TRADE_LABEL', 'VERTICAL', 'BUSINESS_VERTICAL', 'OWNER_PHONE', 'FORWARD_TO_PHONE',
  'RING_TIMEOUT_SECONDS', 'BUSINESS_TZ', 'BUSINESS_DAYS', 'BUSINESS_HOURS', 'SERVICES', 'BOOKING_ENABLED', 'SLOT_MINUTES',
  'BOOKING_LEAD_MINUTES', 'DEPOSIT_ENABLED', 'DEPOSIT_AMOUNT', 'HOLD_MINUTES', 'BOOKING_LINK'];
const startTZ = process.env.TZ;

const values = () => store.getOverride().values || {};
const fromOverride = (k) => KEYS.includes(k) && Object.prototype.hasOwnProperty.call(values(), k);
// An override saved before trades existed (VERTICAL but no BUSINESS_TYPE) must not pick up an env BUSINESS_TYPE.
const TRADE_KEYS = ['BUSINESS_TYPE', 'BUSINESS_FLOW', 'BUSINESS_TRADE_LABEL'];
const legacyOverride = (k) => TRADE_KEYS.includes(k) && !fromOverride('BUSINESS_TYPE') && (fromOverride('VERTICAL') || fromOverride('BUSINESS_VERTICAL'));
const env = new Proxy(process.env, {
  get(target, k) {
    if (typeof k !== 'string') return target[k];
    if (fromOverride(k)) return values()[k];
    return legacyOverride(k) ? '' : target[k];
  },
});

// Where each shop-config key currently comes from (for /admin). Non-secret keys only.
function effective() {
  return KEYS.map((key) => {
    if (fromOverride(key)) return { key, value: values()[key], source: 'override' };
    if (process.env[key] !== undefined && process.env[key] !== '') return { key, value: process.env[key], source: 'env' };
    return { key, value: '', source: 'default' };
  });
}
function applyTZ() {
  const tz = env.BUSINESS_TZ;
  if (tz) process.env.TZ = tz; else if (startTZ === undefined) delete process.env.TZ; else process.env.TZ = startTZ;
}
function apply(map, meta = {}) {
  const clean = {};
  for (const k of KEYS) if (map && map[k] !== undefined && map[k] !== null) clean[k] = String(map[k]);
  store.setOverride({ values: clean, ...meta, appliedAt: new Date().toISOString() });
  applyTZ();
  return clean;
}
function clear() { store.setOverride({}); applyTZ(); }

module.exports = { env, KEYS, effective, apply, clear, applyTZ, override: () => store.getOverride() };
