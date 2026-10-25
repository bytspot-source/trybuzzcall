// Platform-owned identity registry. Business records live in separate namespaced stores.
// Only authenticated middleware or verified provider routing may enter a shop context.
const crypto = require('crypto');
const { promisify } = require('util');
const path = require('path');
const store = require('./store');
const context = require('./shopContext');
const root = store.root;
const scrypt = promisify(crypto.scrypt);
const stores = new Map();
const provisioning = new Set();
let tenantPool = null;
function poolFactory(url) {
  if (!tenantPool) {
    tenantPool = new (require('pg').Pool)(store.pgConfig(url));
    tenantPool.on('error', () => console.error('[vendors] Shared tenant database connection failed.'));
  }
  // All vendor stores share a bounded pool; closing one store must not close the pool.
  return { query: (...args) => tenantPool.query(...args), end: async () => {} };
}
const DAY = 86400000;
const SESSION_MS = 12 * 3600000;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
const directory = () => (root.db.vendorDirectory ||= { shops: [], sessions: [], calls: [] });
const all = () => root.db.vendorDirectory?.shops || [];
const get = id => typeof id === 'string' ? all().find(shop => shop.id === id) : undefined;
function healthy(target = root) {
  const status = target.status();
  if (status.degraded || status.fallback) throw error('Storage is unavailable. Please try again later.', 503);
}
async function flush(target = root) { await target.flush(); healthy(target); }
async function persist(target = root) { target.save(); await flush(target); }
async function scopedStore(shop) {
  if (!get(shop.id) || !/^[a-f0-9]{32}$/.test(shop.id)) throw error('Vendor not found', 404);
  if (!stores.has(shop.id)) {
    const promise = (async () => {
      const child = root.createStore({ dir: path.join(root.dataDir(), 'shops', shop.id), namespace: shop.id,
        databaseUrl: process.env.DATABASE_URL || '', poolFactory });
      await child.init(); healthy(child); return child;
    })();
    stores.set(shop.id, promise);
    promise.catch(() => { if (stores.get(shop.id) === promise) stores.delete(shop.id); });
  }
  const child = await stores.get(shop.id); healthy(child); return child;
}
async function run(id, fn, { suspended = false } = {}) {
  healthy();
  const shop = get(id);
  if (!shop || (!suspended && shop.status !== 'active')) throw error('Vendor unavailable', 403);
  const child = await scopedStore(shop);
  // Check again after loading, since the administrator may suspend access during an await.
  if (!suspended && shop.status !== 'active') throw error('Vendor unavailable', 403);
  return context.run({ id: shop.id, shop, store: child }, fn);
}
function publicShop(shop) {
  return { id: shop.id, name: shop.name, email: shop.email, status: shop.status,
    phoneNumber: shop.phoneNumber || '', createdAt: shop.createdAt, setupId: shop.setupId || null,
    founding: !!shop.founding, accountState: shop.account?.passwordHash ? 'active' : 'invited' };
}
function issueInvite(shop) {
  const token = crypto.randomBytes(32).toString('base64url');
  shop.account = { version: (shop.account?.version || 0) + 1, passwordHash: null,
    invite: { hash: digest(token), expiresAt: Date.now() + DAY } };
  directory().sessions = directory().sessions.filter(session => session.shopId !== shop.id);
  return token;
}
async function create({ name, email, values = {}, setupId = null }) {
  healthy();
  name = typeof name === 'string' ? name.trim() : '';
  email = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!name || name.length > 80 || !validEmail(email)) throw error('Enter a business name and valid owner email.');
  const existing = all().find(shop => shop.email === email);
  if (existing && existing.status !== 'provisioning') throw error('A vendor with this email already exists.', 409);
  if (provisioning.has(email)) throw error('This vendor is already being provisioned. Please retry later.',409);
  if (!existing && all().length >= 500) throw error('Vendor capacity reached. Contact the platform administrator.', 409);
  const limit = Number(process.env.FOUNDING_SHOPS_LIMIT?.trim() || 10);
  const legacyFounders = (root.db.billing?.shops || []).filter(s => s.founding && !(s.status === 'canceled' && !s.everPaid)).length;
  const founding = legacyFounders + all().filter(s => s.founding).length < (Number.isFinite(limit) && limit >= 0 ? Math.round(limit) : 10);
  const shop = existing || { id: crypto.randomBytes(16).toString('hex'), name, email, status: 'provisioning', phoneNumber: null,
    createdAt: new Date().toISOString(), setupId, founding, account: { version: 0 } };
  // Reserve the email and founding allocation synchronously. A failed provisioning
  // can be retried by its administrator without making a second identity/store.
  provisioning.add(email);
  if (!existing) directory().shops.push(shop);
  shop.name = name;
  if (setupId) shop.setupId = setupId;
  try {
    const child = await scopedStore(shop);
    await context.run({ id: shop.id, shop, store: child }, async () => {
      require('./config').apply({ ...values, BUSINESS_NAME: name });
      await persist(child);
    });
    shop.status = 'active';
    const token = issueInvite(shop);
    await persist(); return { shop: publicShop(shop), token };
  } catch (e) {
    // An unsuccessful provisioning attempt is never an active identity.
    shop.status = 'provisioning'; shop.account = { version: 1, passwordHash: null };
    throw e;
  } finally { provisioning.delete(email); }
}
async function invite(id) {
  healthy(); const shop = get(id);
  if (!shop || shop.status !== 'active') throw error('Activate the vendor before issuing an invitation.', 409);
  const token = issueInvite(shop); await persist(); return { shop: publicShop(shop), token };
}
async function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function passwordMatches(password, encoded) {
  const parts = typeof encoded === 'string' ? encoded.split(':') : [];
  const valid = parts.length === 3 && parts[0] === 'scrypt' && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{128}$/.test(parts[2]);
  const key = await scrypt(password, valid ? parts[1] : 'buzzcall-invalid-account', 64);
  const expected = valid ? Buffer.from(parts[2], 'hex') : Buffer.alloc(64);
  return crypto.timingSafeEqual(key, expected) && valid;
}
async function activate(token, password, passwordConfirm) {
  healthy();
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw error('Invitation is invalid or expired.');
  if (typeof password !== 'string' || password.length < 16 || password.length > 128 || password !== passwordConfirm) {
    throw error('Use a 16–128 character password and enter it twice.');
  }
  const hash = digest(token);
  const shop = all().find(s => s.status === 'active' && s.account?.invite?.hash === hash && s.account.invite.expiresAt > Date.now());
  if (!shop) throw error('Invitation is invalid or expired.');
  const version = shop.account.version;
  const encoded = await passwordHash(password);
  if (shop.status !== 'active' || shop.account.version !== version || shop.account.invite?.hash !== hash || shop.account.invite.expiresAt <= Date.now()) {
    throw error('Invitation is invalid or expired.');
  }
  shop.account.passwordHash = encoded; delete shop.account.invite;
  shop.account.version++; await persist(); return publicShop(shop);
}
async function login(email, password) {
  healthy();
  email = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (typeof password !== 'string' || password.length > 128 || !validEmail(email)) throw error('Email or password is incorrect.', 401);
  const shop = all().find(s => s.email === email && s.status === 'active');
  const encoded = shop?.account?.passwordHash;
  if (!await passwordMatches(password, encoded) || !shop || shop.status !== 'active' || shop.account.passwordHash !== encoded) {
    throw error('Email or password is incorrect.', 401);
  }
  const now = Date.now();
  directory().sessions = directory().sessions.filter(s => s.expiresAt > now && get(s.shopId)?.status === 'active');
  const own = directory().sessions.filter(s => s.shopId === shop.id);
  if (own.length >= 10) {
    const oldest = own.sort((a,b) => a.expiresAt - b.expiresAt)[0];
    directory().sessions = directory().sessions.filter(s => s !== oldest);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  directory().sessions.push({ hash: digest(token), shopId: shop.id, version: shop.account.version, expiresAt: now + SESSION_MS });
  await persist(); return { token, shop: publicShop(shop) };
}
const COOKIE = 'buzzcall_vendor';
function cookieToken(req) {
  const matches = String(req.headers.cookie || '').split(';').map(p => p.trim()).filter(p => p.startsWith(COOKIE + '='));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function authenticate(req) {
  healthy(); const token = cookieToken(req);
  if (!token) return null;
  const session = directory().sessions.find(s => s.hash === digest(token) && s.expiresAt > Date.now());
  const shop = session && get(session.shopId);
  return shop && shop.status === 'active' && shop.account?.passwordHash && session.version === shop.account.version ? shop : null;
}
function setCookie(res, token = '') {
  const secure = require('./security').isProduction() ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${token}; Path=/vendor; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_MS / 1000 : 0}${secure}`);
}
async function logout(req) {
  const token = cookieToken(req);
  if (token) { directory().sessions = directory().sessions.filter(s => s.hash !== digest(token)); await persist(); }
}
async function setStatus(id, status) {
  healthy(); const shop = get(id);
  if (!shop || !['active','suspended'].includes(status) || shop.status === 'provisioning') throw error('Invalid vendor status.');
  shop.status = status;
  shop.account.version++;
  directory().sessions = directory().sessions.filter(s => s.shopId !== id);
  await persist(); return publicShop(shop);
}
async function assignPhone(id, phone) {
  healthy(); const shop = get(id);
  if (!shop) throw error('Vendor not found', 404);
  if (typeof phone !== 'string' || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone.trim())) throw error('Use a US/Canada phone number in +1 format.');
  phone = phone.trim();
  if (phone === process.env.TWILIO_PHONE_NUMBER || all().some(s => s.id !== id && s.phoneNumber === phone)) throw error('This phone number is already assigned.', 409);
  if (shop.retiredPhones?.includes(phone)) throw error('A retired line cannot be reassigned automatically.', 409);
  // Never automatically recycle phone identities: old callbacks and opt-outs may still refer to them.
  if (all().some(s => s.retiredPhones?.includes(phone))) throw error('This number was used by another line. Manual migration is required.', 409);
  if (shop.phoneNumber && shop.phoneNumber !== phone) (shop.retiredPhones ||= []).push(shop.phoneNumber);
  shop.phoneNumber = phone; await persist(); return publicShop(shop);
}
// Per-vendor outbound text limits (platform admin only). null/'' = platform default; 0 = this vendor's limit off.
async function setSmsCaps(id, { hour, day } = {}) {
  healthy(); const shop = get(id);
  if (!shop) throw error('Vendor not found', 404);
  const parse = (v, max) => {
    if (v === undefined || v === null || String(v).trim() === '') return undefined;
    const n = Number(String(v).trim());
    if (!Number.isInteger(n) || n < 0 || n > max) throw error(`Texting limits must be whole numbers from 0 to ${max}.`);
    return n;
  };
  const caps = { hour: parse(hour, 10000), day: parse(day, 100000) };
  for (const k of Object.keys(caps)) if (caps[k] === undefined) delete caps[k];
  if (Object.keys(caps).length) shop.smsCaps = caps; else delete shop.smsCaps;
  await persist(); return { ...publicShop(shop), smsCaps: shop.smsCaps || {} };
}
// Inbound call routing is assigned by platform admin, not by a caller-provided shop ID.
async function twilioShop(body, callback = false) {
  if (!all().length) return { legacy: true };
  const { From, To, CallSid } = body || {};
  if (callback) {
    const call = directory().calls.find(c => c.id === CallSid && c.from === From && c.expiresAt > Date.now());
    if (!call) return null;
    if (call.shopId === 'legacy') return { legacy: true };
    const shop = get(call.shopId);
    return shop?.status === 'active' && shop.phoneNumber === call.to ? { shop } : null;
  }
  const matches = all().filter(s => s.phoneNumber && s.phoneNumber === To);
  const legacy = process.env.TWILIO_PHONE_NUMBER && To === process.env.TWILIO_PHONE_NUMBER;
  if (matches.length + (legacy ? 1 : 0) !== 1 || matches[0] && matches[0].status !== 'active') return null;
  const shop = matches[0];
  if (CallSid) {
    if (typeof CallSid !== 'string' || CallSid.length > 80) return null;
    const prior = directory().calls.find(c => c.id === CallSid);
    const owner = shop?.id || 'legacy';
    if (prior && (prior.shopId !== owner || prior.from !== From || prior.to !== To)) return null;
    directory().calls = directory().calls.filter(c => c.expiresAt > Date.now());
    if (!prior) {
      if (directory().calls.length >= 10000) throw error('Call routing capacity reached.', 503);
      directory().calls.push({ id: CallSid, shopId: owner, from: From, to: To, expiresAt: Date.now() + DAY });
      await persist();
    }
  }
  return shop ? { shop } : { legacy: true };
}
async function candidates() {
  const out = [{ id: 'legacy', shop: null, store: root }];
  for (const shop of all().filter(s => s.status !== 'provisioning')) out.push({ id: shop.id, shop, store: await scopedStore(shop) });
  return out;
}
async function stripeShop(event, connected = false) {
  if (!all().length) return { legacy: true };
  const object = event.data?.object || {};
  const tags = [object.metadata?.shopId, object.subscription_details?.metadata?.shopId, object.parent?.subscription_details?.metadata?.shopId].filter(Boolean);
  if (new Set(tags).size > 1) return null;
  const tagged = tags[0];
  const list = await candidates();
  if (!connected && ['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type) && object.mode === 'payment') {
    const id = object.metadata?.bookingId || object.client_reference_id;
    const booking = id && root.findBooking(id);
    if (tagged || object.metadata?.bookingId && object.client_reference_id && object.metadata.bookingId !== object.client_reference_id) return null;
    return booking && !booking.connectAccount && booking.stripeSessionId === object.id ? {legacy:true} : null;
  }
  let matches;
  if (connected) {
    matches = list.filter(c => (c.store.getOverride().stripeConnect?.accountId || (c.id === 'legacy' ? process.env.STRIPE_CONNECT_ACCOUNT_ID : null)) === event.account && !!event.account);
  } else {
    const subscription = typeof object.subscription === 'string' ? object.subscription : object.subscription?.id;
    const customer = typeof object.customer === 'string' ? object.customer : object.customer?.id;
    matches = list.filter(c => {
      const bill = c.store.db.billing || {};
      return !!(bill.subs?.[object.id] || bill.subs?.[subscription] || bill.pendingCheckouts?.[object.id] ||
        bill.mock?.sessions?.[object.id] || customer && Object.values(bill.subs || {}).some(s => s.customer === customer));
    });
    if (tagged && !matches.length && ['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted',
      'customer.subscription.trial_will_end','checkout.session.completed','invoice.paid','invoice.payment_failed'].includes(event.type)) {
      matches = list.filter(c => c.id === tagged);
    }
    // An initial invoice can precede the checkout/subscription events. Retry while
    // checkout ownership is still being established instead of acknowledging loss.
    if (!tagged && !matches.length && ['invoice.paid','invoice.payment_failed','customer.subscription.created','customer.subscription.updated'].includes(event.type) &&
      list.some(c => Object.values(c.store.db.billing?.pendingCheckouts || {}).some(p => p.status === 'open' && Date.parse(p.expiresAt) > Date.now()) || c.store.db.billing?.checkoutAttempt)) return {retry:true};
  }
  if (matches.length !== 1 || tagged && matches[0].id !== tagged) return null;
  return matches[0].shop ? { shop: matches[0].shop } : { legacy: true };
}
async function bookingShop(id) {
  if (!all().length) return { legacy: true };
  const matches = (await candidates()).filter(c => c.store.findBooking(id));
  return matches.length === 1 ? matches[0].shop ? { shop: matches[0].shop } : { legacy: true } : null;
}
async function close({ strict = false } = {}) {
  let failed = false;
  for (const promise of stores.values()) {
    try { const child = await promise; await child.close(); healthy(child); } catch { failed = true; }
  }
  stores.clear();
  if (tenantPool) { await tenantPool.end(); tenantPool = null; }
  if (strict && failed) throw error('Vendor storage could not be flushed.',503);
}
module.exports = { root, all, get, create, invite, activate, login, authenticate, logout, setCookie, setStatus, assignPhone, setSmsCaps,
  run, scopedStore, publicShop, persist, flush, healthy, twilioShop, stripeShop, bookingShop, close, error, SESSION_MS };
