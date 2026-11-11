'use strict';
// Self-serve shop onboarding. AUTO_ONBOARDING defaults off, which leaves POST /setup as an admin review.
// Phone codes are hashed, expire in 10 minutes, and allow 5 attempts. One verified phone can open one shop
// unless an admin allows another. Customer text-backs wait until carrier registration is approved; owner buzzes do not.
const crypto = require('crypto');
const sec = require('./security');
const vendors = require('./vendors');
const shopContext = require('./shopContext');
const storeApi = require('./onboardingStore');
const provision = require('./provision');
const a2p = require('./a2p');

const {
  CODE_TTL_MS, MAX_ATTEMPTS, GRANT_MS, enabled, provisionEnabled, a2pEnabled,
  peek, data, save, redact, publicRegistration, shopRecord, takeHeld, namesMismatch, limiters,
  protectEin, spendApprovalRequired,
} = storeApi;

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const fail = (error, status) => ({ ok: false, error, status });

function sendAllowed(phone, ip) {
  const limits = limiters();
  if (limits.ip.blocked(ip) || limits.phone.blocked(phone)) return false;
  limits.ip.hit(ip);
  limits.phone.hit(phone);
  return true;
}
async function sendCode({ setupId, phone, ip, businessName }) {
  if (!sec.isNanp(phone)) return fail('Use a US or Canada mobile number.', 422);
  if (!sendAllowed(phone, ip || 'unknown')) return fail('Too many codes were sent. Try again later.', 429);
  const line = await require('./lookup').lineType(phone);
  if (!line.ok) return fail(line.error || 'Use a mobile number.', 422);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  data().verifications[setupId] = {
    phone, codeHash: hash(code), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, sentAt: new Date().toISOString(),
  };
  save();
  const name = String(businessName || 'Your shop').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 80) || 'Your shop';
  const sms = require('./sms');
  const sent = await sms.sendSms(phone, `${name}: Your BuzzCall code is ${code}. It expires in 10 minutes. Reply STOP to opt out.`, { kind: 'otp' });
  if (!sent.ok && !sent.logOnly) return fail('We could not text that code. Try again in a few minutes.', 502);
  return { ok: true };
}

function phoneTaken(phone) {
  if (peek()?.phoneAllows?.[phone]) return false;
  return vendors.all().some((shop) => shop.alertPhone === phone && shop.status !== 'provisioning');
}
async function verify({ setupId, code, ip }) {
  const limits = limiters();
  if (!limits.verifyIp.hit(ip || 'unknown').ok) return fail('Too many tries from this network. Try again later.', 429);
  const setup = require('./store').root.findSetup(setupId);
  const row = setupId && peek()?.verifications?.[setupId];
  if (!setup || !row) return fail('That setup could not be found. Send the form again.', 404);
  if (row.consumed && setup.vendorId) return fail('This cell is already verified. Sign in to your shop.', 409);
  const phone = row.phone;
  const email = String(setup.values?.email || '').trim().toLowerCase();
  if (phoneTaken(phone)) {
    setup.autoFlags = [...new Set([...(setup.autoFlags || []), 'duplicate_phone'])];
    save();
    return fail('This cell already has a BuzzCall shop. Sign in, or ask BuzzCall if this shop needs its own line.', 409);
  }
  if (vendors.all().some((shop) => shop.email === email && shop.status !== 'provisioning')) {
    setup.autoFlags = [...new Set([...(setup.autoFlags || []), 'duplicate_email'])];
    save();
    return fail('An account with this email already exists. Sign in instead.', 409);
  }
  if (row.attempts >= MAX_ATTEMPTS) return fail('That code was tried too many times. Request a new one.', 429);
  row.attempts += 1;
  save();
  if (Date.now() > row.expiresAt) return fail('That code has expired. Request a new one.', 400);
  if (!sec.safeEqual(hash(String(code || '').trim()), row.codeHash)) return fail('That code does not match.', 400);
  let created;
  try {
    created = await vendors.create({
      name: setup.values.businessName, email, values: require('./setupRules').toEnv(setup.values), setupId: setup.id,
    });
  } catch (e) {
    const duplicate = e && e.status === 409;
    setup.autoFlags = [...new Set([...(setup.autoFlags || []), duplicate ? 'duplicate_email' : 'provisioning_failure'])];
    save();
    return fail(duplicate ? 'An account with this email already exists. Sign in instead.' : 'We could not finish creating the shop. Try again.', duplicate ? 409 : 500);
  }
  const shop = vendors.get(created.shop.id);
  shop.alertPhone = phone;
  shop.onboardingAuto = true;
  setup.status = 'approved';
  setup.vendorId = shop.id;
  setup.approvedAt = new Date().toISOString();
  setup.autoFlags = (setup.autoFlags || []).filter((f) => f !== 'duplicate_phone' && f !== 'duplicate_email');
  row.consumed = true;
  const autoNumber = provisionEnabled();
  const autoA2p = a2pEnabled();
  data().shops[shop.id] = {
    auto: true, setupId: setup.id, phone, city: setup.values.city || '', areaCode: phone.slice(2, 5),
    businessType: setup.values.businessType || '', verifiedAt: new Date().toISOString(), trial: 'not_started',
    number: { status: autoNumber ? 'waiting_trial' : 'pending_admin' },
    a2p: { status: autoA2p ? 'not_started' : 'pending_admin' },
    flags: [],
  };
  const token = crypto.randomBytes(32).toString('base64url');
  data().grants[hash(token)] = { shopId: shop.id, invite: created.token, expiresAt: Date.now() + GRANT_MS };
  save();
  await vendors.persist();
  return { ok: true, grant: token, shopId: shop.id };
}

function grantFor(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = peek()?.grants?.[hash(token)];
  if (!row || row.expiresAt <= Date.now()) return null;
  return row;
}
async function setPassword(token, password, passwordConfirm) {
  const row = grantFor(token);
  if (!row) return fail('Set your password from the verification step again. This page has expired.', 400);
  try { await vendors.activate(row.invite, password, passwordConfirm); }
  catch (e) { return fail(e && e.status && e.status < 500 ? e.message : 'Could not set that password.', e.status || 400); }
  const shop = vendors.get(row.shopId);
  delete data().grants[hash(token)];
  save();
  const session = await vendors.login(shop.email, password);
  const mail = require('./email');
  mail.onboardingWelcome({ email: shop.email, businessName: shop.name });
  return { ok: true, session: session.token, shop };
}

async function trialOf(shopId) {
  const read = () => {
    const sub = require('./billing').summary().subscription;
    if (!sub) return 'not_started';
    if (sub.status === 'trialing' || sub.status === 'active') return sub.status;
    return sub.status || 'not_started';
  };
  if (shopContext.shopId() === shopId) return read();
  return vendors.run(shopId, read, { suspended: true });
}
const trialOpen = (trial) => trial === 'trialing' || trial === 'active';

async function flushHeld(shopId) {
  const queued = takeHeld(shopId);
  if (!queued.length) return;
  const sms = require('./sms');
  await vendors.run(shopId, async () => {
    for (const message of queued) await sms.sendSms(message.to, message.body, { allowHeld: true });
  }, { suspended: true });
}

// Moves a shop forward. Number purchase and carrier submission wait until the trial exists, and never run when their flags are off.
async function advance(shopId, base) {
  const rec = shopRecord(shopId);
  if (!rec) return null;
  let trial = 'not_started';
  try { trial = await trialOf(shopId); } catch { trial = rec.trial || 'not_started'; }
  rec.trial = trial;
  if (!trialOpen(trial)) {
    if (!rec.number?.phone && rec.number?.status !== 'manual') rec.number = { ...(rec.number || {}), status: provisionEnabled() ? 'waiting_trial' : 'pending_admin' };
    if (!rec.a2p?.brandSid && rec.a2p?.status !== 'approved' && rec.a2p?.status !== 'rejected' && rec.a2p?.status !== 'manual') {
      if (!a2pEnabled() && rec.a2p.status === 'not_started') rec.a2p.status = 'pending_admin';
    }
    save();
    return rec;
  }
  if (spendApprovalRequired() && !rec.spendApproved) {
    if (!rec.number?.phone && rec.number?.status !== 'manual') rec.number = { ...(rec.number || {}), status: 'pending_admin' };
    if (!rec.a2p?.brandSid && rec.a2p && !['approved', 'rejected', 'manual'].includes(rec.a2p.status)) rec.a2p.status = 'pending_admin';
    rec.spendBlocked = true;
    save();
    return rec;
  }
  rec.spendBlocked = false;
  const before = rec.a2p?.status;
  if (!rec.number?.phone && rec.number?.status !== 'manual') {
    try { await provision.ensureNumber(shopId, base); } catch (e) { console.error('[onboarding] number:', redact(e && e.message)); }
  }
  if (rec.registration?.ready || rec.a2p?.brandSid) {
    try { await a2p.sync(shopId, base); } catch (e) { console.error('[onboarding] registration:', redact(e && e.message)); }
  } else if (!a2pEnabled() && rec.a2p.status === 'not_started') rec.a2p.status = 'pending_admin';
  save();
  if (before !== 'approved' && rec.a2p.status === 'approved') {
    try { await flushHeld(shopId); } catch (e) { console.error('[onboarding] held texts:', redact(e && e.message)); }
  }
  return rec;
}

const CA_REGIONS = new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' '));
function registrationFrom(body, existing) {
  const str = (k, max) => String(body?.[k] ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
  const legalName = str('legalName', 120);
  const einRaw = str('ein', 20);
  const ein = storeApi.digits(einRaw);
  const entity = str('entity', 40);
  const spec = require('./a2p').entitySpec(entity);
  const street = str('street', 120), city = str('city', 80), region = str('region', 2).toUpperCase();
  const postalCode = str('postalCode', 10).toUpperCase();
  const website = str('website', 300);
  const contactName = str('contactName', 80);
  const contactEmail = str('contactEmail', 254).toLowerCase();
  const contactPhone = str('contactPhone', 20);
  const e164 = require('./setupRules').phoneE164(contactPhone);
  const errors = [];
  if (!spec) errors.push('Choose a business type: LLC, corporation, partnership, sole proprietor, or nonprofit.');
  if (legalName.length < 2) errors.push('Enter the legal name of the business.');
  const keptEin = !einRaw && existing?.ein ? storeApi.digits(existing.ein) : ein;
  if (spec && spec.flow !== 'sole_proprietor') {
    if (einRaw && ein.length !== 9) errors.push('EIN should be 9 digits.');
    else if (keptEin.length !== 9) errors.push('This business type needs a 9-digit EIN.');
  } else if (einRaw && ein.length !== 9) errors.push('EIN should be 9 digits, or leave it blank for a sole proprietor.');
  if (street.length < 3) errors.push('Enter the street address.');
  if (city.length < 2) errors.push('Enter the city.');
  if (!/^[A-Z]{2}$/.test(region)) errors.push('Enter the 2-letter state or province.');
  const country = CA_REGIONS.has(region) ? 'CA' : 'US';
  if (country === 'US' && !/^\d{5}(-\d{4})?$/.test(postalCode)) errors.push('Enter a US ZIP code.');
  if (country === 'CA' && !/^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/.test(postalCode)) errors.push('Enter a Canadian postal code.');
  let siteOk = false;
  try { const url = new URL(website); siteOk = url.protocol === 'https:' && !url.username && !url.password; } catch { siteOk = false; }
  if (!siteOk) errors.push('Enter the business website, starting with https://.');
  if (contactName.length < 2) errors.push('Enter the contact name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) errors.push('Enter the contact email.');
  if (!e164 || !sec.isNanp(e164)) errors.push('Enter a US or Canada contact cell.');
  if (errors.length) return { ok: false, error: errors[0] };
  const standard = spec.flow !== 'sole_proprietor';
  return {
    ok: true,
    registration: {
      legalName, entity: spec.key, street, city, region, postalCode, country, website, contactName, contactEmail, contactPhone: e164,
      ...(standard && keptEin.length === 9 ? { ein: keptEin } : {}), ready: true,
    },
  };
}
async function saveRegistration(shopId, body, base) {
  const rec = shopRecord(shopId);
  if (!rec) return fail('Onboarding has not started for this shop.', 404);
  if (rec.a2p?.brandSid) return fail('Registration was already submitted. It updates when the carrier finishes review.', 409);
  const parsed = registrationFrom(body, rec.registration);
  if (!parsed.ok) return parsed;
  rec.registration = protectEin(parsed.registration);
  rec.a2p.flow = require('./a2p').entitySpec(parsed.registration.entity).flow;
  rec.flags = (rec.flags || []).filter((flag) => flag !== 'needs_business_type');
  const shop = vendors.get(shopId);
  if (shop && namesMismatch(parsed.registration.legalName, shop.name)) {
    rec.flags = [...new Set([...(rec.flags || []), 'name_mismatch'])];
  } else rec.flags = (rec.flags || []).filter((f) => f !== 'name_mismatch');
  save();
  if (trialOpen(rec.trial)) await advance(shopId, base);
  return { ok: true, registration: publicRegistration(rec.registration) };
}
async function setEntity(shopId, body, base) {
  const rec = shopRecord(shopId);
  if (!rec) return fail('Shop not found', 404);
  if (!rec.registration) return fail('This shop has not saved a registration yet.', 400);
  if (rec.a2p?.brandSid) return fail('Registration was already submitted. It updates when the carrier finishes review.', 409);
  const src = rec.registration;
  const parsed = registrationFrom({
    legalName: src.legalName, street: src.street, city: src.city, region: src.region, postalCode: src.postalCode,
    website: src.website, contactName: src.contactName, contactEmail: src.contactEmail, contactPhone: src.contactPhone,
    entity: body?.entity, ein: body?.ein || '',
  }, src);
  if (!parsed.ok) return parsed;
  rec.registration = protectEin(parsed.registration);
  rec.a2p ||= { status: 'not_started' };
  rec.a2p.flow = require('./a2p').entitySpec(parsed.registration.entity).flow;
  rec.flags = (rec.flags || []).filter((flag) => flag !== 'needs_business_type');
  if (rec.a2p.reason && /business type|EIN/.test(rec.a2p.reason)) rec.a2p.reason = '';
  save();
  if (trialOpen(rec.trial)) await advance(shopId, base);
  return { ok: true, registration: publicRegistration(rec.registration) };
}

function attention(shop, rec) {
  const flags = new Set(rec.flags || []);
  const phone = rec.phone;
  if (phone && !peek()?.phoneAllows?.[phone]) {
    const dupes = vendors.all().filter((s) => s.alertPhone === phone && s.status !== 'provisioning');
    if (dupes.length > 1) flags.add('duplicate_phone');
  }
  if (shop && vendors.all().filter((s) => s.email === shop.email && s.status !== 'provisioning').length > 1) flags.add('duplicate_email');
  if (shop && rec.registration && namesMismatch(rec.registration.legalName, shop.name)) flags.add('name_mismatch');
  if (rec.registration && !require('./a2p').entitySpec(rec.registration.entity)) flags.add('needs_business_type');
  if (rec.number && (rec.number.status === 'failed' || (rec.number.lastError && rec.number.status !== 'purchased' && rec.number.status !== 'manual'))) flags.add('provisioning_failure');
  if (rec.a2p?.status === 'rejected') flags.add('rejected_registration');
  if ((rec.flags || []).includes('low_balance')) flags.add('low_balance');
  if ((rec.flags || []).includes('cap_hit')) flags.add('cap_hit');
  return [...flags];
}
const STEP = {
  verified: 'Verified',
  not_started: 'Not started',
  waiting_trial: 'Waiting for trial',
  pending_admin: 'Pending admin',
  queued: 'Queued',
  purchasing: 'Purchasing',
  purchased: 'Purchased',
  manual: 'Assigned',
  failed: 'Failed',
  pending: 'Pending',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  trialing: 'Trial',
  active: 'Active',
};
function stepLabel(value) { return STEP[value] || value || 'Not started'; }

function viewShop(shop) {
  const rec = shopRecord(shop.id);
  if (!rec) return null;
  return {
    id: shop.id, name: shop.name, email: shop.email, status: shop.status, phone: rec.phone,
    line: shop.phoneNumber || rec.number?.phone || '',
    verified: 'verified', trial: rec.trial || 'not_started',
    number: rec.number?.status || 'pending_admin', numberError: redact(rec.number?.lastError || ''),
    registration: rec.a2p?.status || 'not_started', registrationError: redact(rec.a2p?.reason || ''),
    flow: rec.a2p?.flow || '', registrationForm: publicRegistration(rec.registration),
    flags: attention(shop, rec), manualRegistration: !rec.a2p?.brandSid,
  };
}
function queue() {
  const rows = [];
  const bucket = peek();
  for (const shop of vendors.all()) {
    const view = viewShop(shop);
    if (view) rows.push({ kind: 'shop', ...view });
  }
  for (const setup of require('./store').root.db.setups || []) {
    if (setup.status !== 'pending') continue;
    const flags = setup.autoFlags || [];
    const pendingCode = !!(bucket && bucket.verifications && bucket.verifications[setup.id]);
    if (!flags.length && !pendingCode) continue;
    if (setup.vendorId && shopRecord(setup.vendorId)) continue;
    rows.push({
      kind: 'setup', id: setup.id, name: setup.values?.businessName || 'Unnamed business',
      email: setup.values?.email || '', status: 'pending', phone: setup.values?.ownerPhone || '',
      line: '', verified: pendingCode ? 'code sent' : 'not verified', trial: 'not_started',
      number: 'pending_admin', registration: 'not_started', flags: [...flags],
      numberError: '', registrationError: '',
    });
  }
  return rows;
}

function allowPhone(phone) {
  const e164 = require('./setupRules').phoneE164(phone);
  if (!e164) return fail('Enter the cell in +1 format.', 400);
  data().phoneAllows[e164] = true;
  save();
  return { ok: true, phone: e164 };
}
async function markRegistration(shopId, status, reason) {
  const rec = shopRecord(shopId);
  if (!rec) return fail('Shop not found', 404);
  if (rec.a2p?.brandSid) return fail('This registration is tracked with the carrier. Retry it to refresh the status.', 409);
  if (!['approved', 'rejected'].includes(status)) return fail('Status must be approved or rejected.', 400);
  const before = rec.a2p.status;
  rec.a2p.status = status;
  rec.a2p.manual = true;
  rec.a2p.reason = redact(reason || '').slice(0, 300);
  rec.a2p.updatedAt = new Date().toISOString();
  if (status === 'approved') rec.flags = (rec.flags || []).filter((f) => f !== 'rejected_registration');
  save();
  if (before !== 'approved' && status === 'approved') await flushHeld(shopId);
  return { ok: true };
}

let pollTimer = null;
function startPoller() {
  if (pollTimer || !a2pEnabled()) return;
  const tick = () => {
    const base = process.env.PUBLIC_BASE_URL || '';
    Promise.all(Object.keys(data().shops).filter((id) => {
      const rec = data().shops[id];
      return rec?.a2p?.brandSid && rec.a2p.status !== 'approved';
    }).map((id) => advance(id, base).catch((e) => console.error('[onboarding] poll:', redact(e && e.message))))).catch(() => {});
  };
  pollTimer = setInterval(tick, 15 * 60 * 1000);
  pollTimer.unref?.();
}

async function approveSpend(shopId, base) {
  const rec = shopRecord(shopId);
  if (!rec) return fail('Shop not found', 404);
  rec.spendApproved = true;
  rec.spendApprovedAt = new Date().toISOString();
  rec.spendBlocked = false;
  save();
  const next = await advance(shopId, base);
  return { ok: true, shop: next };
}

function checklistModel(shopId) {
  const shop = vendors.get(shopId);
  const view = shop && viewShop(shop);
  if (!view) return null;
  let price = '';
  try {
    const cfg = require('./billing').cfg();
    price = cfg.live ? '' : `$${cfg.mock.monthly}/mo`;
    return { ...view, trialDays: cfg.trialDays, price, businessName: shop.name };
  } catch { return { ...view, trialDays: 14, price: '', businessName: shop?.name || '' }; }
}

module.exports = {
  enabled, sendCode, verify, grantFor, setPassword, advance, approveSpend, saveRegistration, setEntity, queue, viewShop,
  allowPhone, markRegistration, startPoller, checklistModel, flushHeld, redact, publicRegistration,
  resetLimits: storeApi.resetLimits,
};
