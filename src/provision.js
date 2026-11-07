'use strict';
// Local US number purchase. Runs only when AUTO_PROVISION_NUMBERS is on (default off).
// Search order: the shop's area code, then the same state, then any US local.
// Idempotent: a shop that already has a number, or a Twilio number already named for that shop, is never bought again.
const vendors = require('./vendors');
const twilio = require('./twilioClient');
const { data, save, provisionEnabled, maxPerDay, balanceFloor, redact, regionOf } = require('./onboardingStore');

const DAY = 86400000;
const friendlyName = (shopId) => `buzzcall-${shopId}`;

function recentPurchases(now = Date.now()) {
  const list = data().purchases;
  const kept = list.filter((p) => p && p.at && now - Date.parse(p.at) < DAY);
  if (kept.length !== list.length) { data().purchases = kept; save(); }
  return kept;
}
function webhooks(base) {
  const root = String(base || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return {
    voiceUrl: `${root}/twilio/voice`, voiceMethod: 'POST',
    smsUrl: `${root}/twilio/sms`, smsMethod: 'POST',
  };
}
function flag(rec, name, on) {
  const flags = new Set(rec.flags || []);
  if (on) flags.add(name); else flags.delete(name);
  rec.flags = [...flags];
}
async function adopt(shopId, rec, phone, sid) {
  rec.number.phone = phone;
  rec.number.sid = sid || '';
  rec.number.status = 'purchased';
  rec.number.at = rec.number.at || new Date().toISOString();
  delete rec.number.lastError;
  flag(rec, 'provisioning_failure', false);
  flag(rec, 'cap_hit', false);
  flag(rec, 'low_balance', false);
  if (!data().purchases.some((p) => p.shopId === shopId)) data().purchases.push({ shopId, at: rec.number.at });
  save();
  const shop = vendors.get(shopId);
  if (shop && shop.phoneNumber !== phone) await vendors.assignPhone(shopId, phone);
  save();
  return { ok: true, phone, sid, reused: true };
}
async function search(client, query) {
  const list = await client.availablePhoneNumbers('US').local.list({
    smsEnabled: true, voiceEnabled: true, limit: 1, ...query,
  });
  return list && list[0] && list[0].phoneNumber || '';
}
async function findOwned(client, shopId) {
  const list = await client.incomingPhoneNumbers.list({ friendlyName: friendlyName(shopId), limit: 5 });
  return (list || []).find((n) => n && n.phoneNumber) || null;
}

// Adopts an existing number or buys one. Never calls Twilio when the flag is off.
async function ensureNumber(shopId, base) {
  const rec = data().shops[shopId];
  const shop = vendors.get(shopId);
  if (!rec || !shop) return { ok: false, error: 'Shop not found' };
  rec.number ||= { status: 'pending_admin' };
  if (rec.number.phone || shop.phoneNumber) {
    const phone = rec.number.phone || shop.phoneNumber;
    rec.number.phone = phone;
    rec.number.status = rec.number.status === 'manual' ? 'manual' : 'purchased';
    if (shop.phoneNumber !== phone) await vendors.assignPhone(shopId, phone);
    flag(rec, 'provisioning_failure', false);
    save();
    return { ok: true, phone, reused: true };
  }
  if (!provisionEnabled()) {
    rec.number.status = 'pending_admin';
    save();
    return { ok: true, status: 'pending_admin' };
  }
  if (rec.number.purchaseLock && Date.now() - rec.number.purchaseLock < 120000) return { ok: false, error: 'Purchase already in progress' };
  const client = twilio.getClient();
  if (!client) {
    rec.number.status = 'queued';
    rec.number.lastError = 'Twilio is not configured, so no number was bought.';
    flag(rec, 'provisioning_failure', true);
    save();
    return { ok: false, status: 'queued', reason: 'unconfigured' };
  }
  let owned = null;
  try { owned = await findOwned(client, shopId); } catch { owned = null; }
  if (owned && owned.phoneNumber) return adopt(shopId, rec, owned.phoneNumber, owned.sid);
  const bought = recentPurchases().length;
  const cap = maxPerDay();
  if (bought >= cap) {
    rec.number.status = 'queued';
    rec.number.lastError = `Daily number cap reached (${cap} per 24 hours).`;
    flag(rec, 'cap_hit', true);
    save();
    return { ok: false, status: 'queued', reason: 'cap' };
  }
  let balance = null;
  try {
    const bal = await client.balance.fetch();
    balance = Number(bal && bal.balance);
  } catch (e) {
    rec.number.status = 'failed';
    rec.number.lastError = `Could not read the Twilio balance (${redact(e && e.message)}).`;
    flag(rec, 'provisioning_failure', true);
    save();
    return { ok: false, status: 'failed' };
  }
  if (!Number.isFinite(balance) || balance < balanceFloor()) {
    rec.number.status = 'queued';
    rec.number.lastError = `Twilio balance is below the $${balanceFloor()} floor, so this number was not bought.`;
    flag(rec, 'low_balance', true);
    save();
    return { ok: false, status: 'queued', reason: 'balance' };
  }
  flag(rec, 'low_balance', false);
  flag(rec, 'cap_hit', false);
  rec.number.purchaseLock = Date.now();
  save();
  try {
    let owned = null;
    try { owned = await findOwned(client, shopId); } catch { owned = null; }
    let phone = owned && owned.phoneNumber;
    let sid = owned && owned.sid;
    if (!phone) {
      const area = /^\d{3}$/.test(rec.areaCode || '') ? rec.areaCode : '';
      const region = regionOf(rec.city);
      const tried = [];
      if (area) tried.push({ areaCode: Number(area) });
      if (region) tried.push({ inRegion: region });
      tried.push({});
      for (const query of tried) {
        phone = await search(client, query);
        if (phone) break;
      }
      if (!phone) {
        rec.number.status = 'failed';
        rec.number.lastError = 'No US local number was available.';
        flag(rec, 'provisioning_failure', true);
        return { ok: false, status: 'failed' };
      }
      const hooks = webhooks(base);
      const created = await client.incomingPhoneNumbers.create({
        phoneNumber: phone, friendlyName: friendlyName(shopId), ...hooks,
      });
      phone = created.phoneNumber || phone;
      sid = created.sid || '';
    }
    return adopt(shopId, rec, phone, sid);
  } catch (e) {
    if (!rec.number.phone) {
      rec.number.status = 'failed';
      rec.number.lastError = `Number purchase failed (${redact(e && e.message)}).`;
      flag(rec, 'provisioning_failure', true);
    }
    return { ok: false, status: rec.number.status };
  } finally {
    delete rec.number.purchaseLock;
    save();
  }
}

async function assignManual(shopId, phone) {
  const rec = data().shops[shopId];
  if (!rec) return { ok: false, error: 'Shop not found' };
  const shop = await vendors.assignPhone(shopId, phone);
  rec.number = { status: 'manual', phone: shop.phoneNumber, at: new Date().toISOString() };
  const flags = new Set(rec.flags || []);
  flags.delete('provisioning_failure'); flags.delete('cap_hit'); flags.delete('low_balance');
  rec.flags = [...flags];
  save();
  return { ok: true, phone: shop.phoneNumber };
}

module.exports = { ensureNumber, assignManual, webhooks, recentPurchases };
