'use strict';
// Persisted self-serve onboarding state (platform store). Feature flags default OFF.
// The full EIN lives only long enough to submit a brand, then it is reduced to the last four digits.
const sec = require('./security');
const shopContext = require('./shopContext');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const GRANT_MS = 30 * 60 * 1000;
const HELD_MAX = 50;

const enabled = () => sec.on(process.env.AUTO_ONBOARDING);
const provisionEnabled = () => sec.on(process.env.AUTO_PROVISION_NUMBERS);
const a2pEnabled = () => sec.on(process.env.AUTO_A2P);
const maxPerDay = () => Math.max(0, Math.round(sec.num(process.env.AUTO_PROVISION_MAX_PER_DAY, 25)));
const balanceFloor = () => sec.num(process.env.AUTO_PROVISION_MIN_BALANCE, 20);

function peek() {
  const db = require('./store').root.db;
  const o = db && db.onboarding;
  return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
}
function data() {
  const root = require('./store').root;
  const db = root.db;
  if (!db.onboarding || typeof db.onboarding !== 'object' || Array.isArray(db.onboarding)) db.onboarding = {};
  const o = db.onboarding;
  o.shops ||= {};
  o.verifications ||= {};
  o.grants ||= {};
  o.purchases ||= [];
  o.phoneAllows ||= {};
  o.held ||= {};
  return o;
}
function save() { require('./store').root.save(); }

const digits = (v) => String(v || '').replace(/\D/g, '');
function maskEin(value) {
  const d = digits(value);
  return d.length >= 4 ? `••-•••${d.slice(-4)}` : '';
}
// EIN is 9 digits, often written NN-NNNNNNN. Phone numbers we log are E.164 (+1 and 10 digits), so this does not mask them.
function redact(value) {
  return String(value ?? '').replace(/\b\d{2}-\d{7}\b/g, '[ein]').replace(/\b\d{9}\b/g, '[ein]');
}
function publicRegistration(reg) {
  if (!reg) return null;
  const last4 = reg.einLast4 || (reg.ein ? digits(reg.ein).slice(-4) : '');
  return {
    legalName: reg.legalName || '',
    street: reg.street || '', city: reg.city || '', region: reg.region || '',
    postalCode: reg.postalCode || '', country: reg.country || '',
    website: reg.website || '', contactName: reg.contactName || '',
    contactEmail: reg.contactEmail || '', contactPhone: reg.contactPhone || '',
    einOnFile: !!(reg.ein || reg.einLast4),
    einMasked: last4 ? `••-•••${last4}` : '',
    entity: reg.entity || '',
  };
}
function forgetEin(reg) {
  if (!reg || !reg.ein) return;
  const d = digits(reg.ein);
  if (d.length >= 4) reg.einLast4 = d.slice(-4);
  delete reg.ein;
}

function shopRecord(id) {
  const shops = peek()?.shops;
  return id && shops ? shops[id] || null : null;
}

// Auto-onboarded shops do not text customers until carrier registration is approved.
// Owner alerts use kind 'owner' and are not held. Admin-created shops have no record.
function callerTextsHeld() {
  const id = shopContext.shopId();
  const rec = shopRecord(id);
  if (!rec || !rec.auto) return false;
  return rec.a2p?.status !== 'approved';
}
function queueHeld(to, body) {
  const id = shopContext.shopId();
  if (!id) return;
  const bucket = data();
  const list = (bucket.held[id] ||= []);
  if (list.length >= HELD_MAX) list.shift();
  list.push({ to, body: String(body || '').slice(0, 1000), at: new Date().toISOString() });
  save();
}
function takeHeld(id) {
  const bucket = data();
  const list = bucket.held[id] || [];
  delete bucket.held[id];
  save();
  return list;
}

function namesMismatch(legal, business) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const a = norm(legal), b = norm(business);
  if (!a || !b) return false;
  return !(a.includes(b) || b.includes(a));
}
function regionOf(city) {
  const m = String(city || '').trim().match(/,\s*([A-Za-z]{2})\s*$/);
  if (!m) return '';
  const code = m[1].toUpperCase();
  const states = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
  return states.has(code) ? code : '';
}

let limits = null;
function limiters() {
  const phoneMax = Math.max(1, sec.num(process.env.ONBOARD_CODE_MAX_PER_PHONE, 5));
  const ipMax = Math.max(1, sec.num(process.env.ONBOARD_CODE_MAX_PER_IP, 10));
  const verifyMax = Math.max(1, sec.num(process.env.ONBOARD_VERIFY_MAX_PER_IP, 30));
  if (!limits || limits.phoneMax !== phoneMax || limits.ipMax !== ipMax || limits.verifyMax !== verifyMax) {
    limits = {
      phoneMax, ipMax, verifyMax,
      phone: sec.limiter({ windowMs: 3600000, max: phoneMax }),
      ip: sec.limiter({ windowMs: 600000, max: ipMax }),
      verifyIp: sec.limiter({ windowMs: 600000, max: verifyMax }),
    };
  }
  return limits;
}
function resetLimits() { limits = null; }

module.exports = {
  CODE_TTL_MS, MAX_ATTEMPTS, GRANT_MS, HELD_MAX,
  enabled, provisionEnabled, a2pEnabled, maxPerDay, balanceFloor,
  peek, data, save, digits, maskEin, redact, publicRegistration, forgetEin,
  shopRecord, callerTextsHeld, queueHeld, takeHeld, namesMismatch, regionOf,
  limiters, resetLimits,
};
