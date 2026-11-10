'use strict';
// No-show dispute protection for vendors (works with src/deposits.js).
//
// 1) Vendor "I'm here" check-in: a per-booking button in the vendor portal, or a signed one-tap link in the vendor's
//    booking buzz. Records time, IP and (only when the vendor's browser allows it) lat/lng/accuracy. Accepted only
//    inside a window around the appointment start (CHECKIN_WINDOW_BEFORE_HOURS default 2, CHECKIN_WINDOW_AFTER_HOURS
//    default 6). Links are HMAC-SHA256 signed (DISPUTE_TOKEN_SECRET, else a random secret persisted in the platform
//    store), expire, and name exactly one booking in one shop.
// 2) Customer NO after a check-in does NOT pause the payout: the deposit goes to 'disputed' (payout held for admin
//    review, the check-in shown first). NO without a check-in keeps the existing 'paused' behaviour.
// 3) On any NO the vendor (the shop's OWNER_PHONE) is texted a reply-with-proof request. A text or MMS reply from that
//    phone, or the portal / signed link page, attaches evidence (Twilio MediaUrl references are stored, never
//    downloaded; portal photos are client-compressed and stored small, capped per deposit and per shop).
// 4) Once the vendor checked in or sent proof, the customer gets one follow-up ("... Reply KEEP ...", quiet hours
//    9pm-8am shop time and opt-outs respected). No KEEP within DISPUTE_AUTO_RELEASE_HOURS (default 48) => the payout
//    is released automatically only when the vendor checked in inside the window AND sent a photo that was not
//    reused from another deposit. Text-only evidence waits in the admin review queue. KEEP keeps it for admin
//    review. KEEP is only read while a follow-up is pending for that number. An opted-out customer is never
//    texted; the dispute then waits for the admin (no auto-release).
// 5) Repeat claims: NO claims are counted per customer across all shops in the platform store, keyed by a salted
//    hash of the phone, and also by email and card fingerprint when we have them (no raw values in the index).
//    NOSHOW_FLAG_THRESHOLD (default 2) claims within NOSHOW_FLAG_WINDOW_DAYS (default 90) flags the claim and the
//    customer. The admin can store a "require full prepay" flag; booking.hold enforces it.
const crypto = require('crypto');
const store = require('./store');
const shopContext = require('./shopContext');
const shopTime = require('./shopTime');
const env = require('./config').env;
const sec = require('./security');

const HOUR = 3600000, DAY = 86400000;
const PROOF_LINK_DAYS = 7;
const MAX_EVIDENCE = 20, MAX_PHOTOS_PER_DEPOSIT = 3, MAX_PHOTOS_PER_SHOP = 40, MAX_PHOTO_BYTES = 700 * 1024;
const num = (v, d) => sec.num(v, d);
const cfg = () => ({
  beforeHours: num(process.env.CHECKIN_WINDOW_BEFORE_HOURS, 2),
  afterHours: num(process.env.CHECKIN_WINDOW_AFTER_HOURS, 6),
  autoReleaseHours: num(process.env.DISPUTE_AUTO_RELEASE_HOURS, 48),
  flagThreshold: Math.max(1, Math.floor(num(process.env.NOSHOW_FLAG_THRESHOLD, 2))),
  flagWindowDays: Math.max(1, num(process.env.NOSHOW_FLAG_WINDOW_DAYS, 90)),
});
const deposits = () => require('./deposits');
const now = () => deposits().now();
const iso = (ms = now()) => new Date(ms).toISOString();
const rid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const shopName = (d) => (d && d.shopName) || env.BUSINESS_NAME || 'The shop';
const timeOf = (v) => { try { return `${shopTime.dayLabel(v)} ${shopTime.timeLabel(v)}`; } catch { return String(v || ''); } };
const outcome = (fn, ...a) => { try { const o = require('./outcomes'); if (o[fn]) o[fn](...a); } catch {} };
const letters = (body) => require('./optout').letters(body);

// ---------- signed links ----------
function secret() {
  const s = String(process.env.DISPUTE_TOKEN_SECRET || '');
  if (s) return s;
  const root = store.root;
  if (!root.db.disputeTokenSecret) { root.db.disputeTokenSecret = crypto.randomBytes(32).toString('hex'); root.save(); }
  return root.db.disputeTokenSecret;
}
const mac = (body) => crypto.createHmac('sha256', secret()).update(`buzz-dispute-v1.${body}`).digest('base64url');
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body)}`;
}
// Signature + shape only. Expiry is checked by the caller inside the shop context (the demo clock is per shop).
function readToken(token, kind) {
  if (typeof token !== 'string' || token.length > 600 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [body, sig] = token.split('.');
  if (!sec.safeEqual(sig, mac(body))) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || typeof p !== 'object' || p.k !== kind || typeof p.b !== 'string' || !Number.isFinite(p.e)) return null;
  if (typeof p.s !== 'string') return null;
  return p;
}
const expired = (p) => !(p && p.e > now());
function appointmentStart(b) {
  const s = Date.parse(b && b.slotStart);
  return Number.isFinite(s) ? s : null;
}
function appointmentEnd(b) {
  const e = Date.parse(b && b.slotEnd);
  return Number.isFinite(e) ? e : appointmentStart(b);
}
function checkinToken(b) {
  const start = appointmentStart(b);
  const exp = (start ?? now()) + cfg().afterHours * HOUR;
  return sign({ k: 'ci', s: shopContext.shopId() || '', b: b.id, e: exp });
}
const linkBase = (base) => String(base || '').replace(/\/+$/, '');
const checkinLink = (base, b) => `${linkBase(base)}/v/checkin/${checkinToken(b)}`;
function proofToken(d) {
  return sign({ k: 'pf', s: shopContext.shopId() || '', b: d.bookingId, d: d.id, e: now() + PROOF_LINK_DAYS * DAY });
}
const proofLink = (base, d) => `${linkBase(base)}/v/proof/${proofToken(d)}`;

// ---------- check-in ----------
function windowFor(b) {
  const start = appointmentStart(b);
  if (start == null) return null;
  return { opensAt: start - cfg().beforeHours * HOUR, closesAt: start + cfg().afterHours * HOUR };
}
// 'open' | 'early' | 'late' | 'unknown'
function windowState(b, at = now()) {
  const w = windowFor(b);
  if (!w) return 'unknown';
  return at < w.opensAt ? 'early' : at > w.closesAt ? 'late' : 'open';
}
const checkable = (b) => !!b && b.status === 'confirmed';
function geo({ lat, lng, accuracy } = {}) {
  const la = Number(lat), lo = Number(lng), ac = Number(accuracy);
  if (lat === undefined || lat === '' || lng === undefined || lng === '' || !Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180 || (la === 0 && lo === 0)) return null;
  return { lat: Math.round(la * 1e5) / 1e5, lng: Math.round(lo * 1e5) / 1e5,
    accuracy: Number.isFinite(ac) && ac >= 0 && ac <= 1e6 ? Math.round(ac) : null };
}
function timeline(d, type, text, at = iso()) {
  if (!d) return;
  d.disputeTimeline = d.disputeTimeline || [];
  d.disputeTimeline.push({ at, type, text: String(text || '').slice(0, 400) });
  if (d.disputeTimeline.length > 60) d.disputeTimeline.splice(0, d.disputeTimeline.length - 60);
}
// Runs in the booking's shop context. Returns { ok, already?, checkIn } or { ok:false, reason }.
function checkIn(b, { lat, lng, accuracy, ip, source = 'portal' } = {}) {
  if (!b) return { ok: false, reason: 'not_found' };
  if (b.vendorCheckIn) return { ok: true, already: true, checkIn: b.vendorCheckIn };
  if (!checkable(b)) return { ok: false, reason: 'not_confirmed' };
  const state = windowState(b);
  if (state !== 'open') return { ok: false, reason: state === 'early' ? 'too_early' : state === 'late' ? 'too_late' : 'no_time' };
  const c = { at: iso(), source: ['portal', 'link'].includes(source) ? source : 'portal', ip: String(ip || '').slice(0, 64) || null, geo: geo({ lat, lng, accuracy }) };
  if (!c.geo) c.gpsFlag = 'no_gps';
  else if (c.geo.accuracy == null || c.geo.accuracy > 200) c.gpsFlag = 'weak_gps';
  b.vendorCheckIn = c;
  const d = deposits().findByBooking(b.id);
  if (d) {
    d.vendorCheckIn = c;
    const gpsNote = c.gpsFlag === 'no_gps' ? ' (no GPS)' : c.gpsFlag === 'weak_gps' ? ' (GPS accuracy over 200 m)' : '';
    timeline(d, 'checkin', `Vendor checked in${c.geo ? ` at ${c.geo.lat},${c.geo.lng} (±${c.geo.accuracy ?? '?'} m)` : ' (no location shared)'}${gpsNote} via ${c.source}`, c.at);
    // A check-in that lands after a NO (still inside the window) counts as the vendor contesting the claim.
    if (d.dispute && !d.dispute.resolution) { d.dispute.vendorCheckedIn = true; queueFollowup(d); }
    d.updatedAt = iso();
  }
  store.save();
  outcome('vendorCheckedIn', b);
  return { ok: true, checkIn: c };
}

// ---------- repeat-claim flag (platform store, salted hash keys) ----------
function claimKey(phone) {
  try { return require('./outcomes').saltedHash('noshow-claim', phone); } catch { return null; }
}
function identityKey(kind, value) {
  if (!value) return null;
  try { return require('./outcomes').saltedHash(`noshow-${kind}`, String(value).trim().toLowerCase()); } catch { return null; }
}
function identityKeys(phone, { email, fingerprint } = {}) {
  return [...new Set([claimKey(phone), identityKey('email', email), identityKey('fp', fingerprint)].filter(Boolean))];
}
function recordClaim(phone, depositId, extra = {}) {
  const keys = identityKeys(phone, extra);
  if (!keys.length) return { count: 0, threshold: cfg().flagThreshold, flagged: false };
  const root = store.root, c = cfg(), at = Date.now();
  const idx = (root.db.noshowClaims ||= {});
  const shopId = shopContext.shopId() || 'legacy';
  let count = 0;
  for (const k of keys) {
    const list = (idx[k] || []).filter((x) => at - Date.parse(x.at) < c.flagWindowDays * DAY);
    if (!list.some((x) => x.depositId === depositId && x.shopId === shopId)) list.push({ at: new Date(at).toISOString(), shopId, depositId });
    idx[k] = list.slice(-50);
    count = Math.max(count, list.length);
  }
  const flagged = count >= c.flagThreshold;
  const flags = (root.db.flaggedCustomers ||= {});
  const alreadyPrepay = keys.some((k) => flags[k] && flags[k].requirePrepay);
  if (flagged || alreadyPrepay) {
    for (const k of keys) {
      const prev = flags[k] || {};
      flags[k] = { flaggedAt: prev.flaggedAt || new Date(at).toISOString(), count, lastClaimAt: new Date(at).toISOString(),
        phoneMasked: sec.maskPhone(phone), requirePrepay: !!(prev.requirePrepay || alreadyPrepay), requirePrepayAt: prev.requirePrepayAt || null };
    }
  }
  root.save();
  return { count, threshold: c.flagThreshold, flagged };
}
function flagFor(phone, extra = {}) {
  const flags = store.root.db.flaggedCustomers || {};
  let best = null;
  for (const k of identityKeys(phone, extra)) {
    const f = flags[k];
    if (f && (!best || (f.count || 0) > (best.count || 0))) best = f;
  }
  return best ? { ...best } : null;
}
function prepayFor(phone, extra = {}) {
  const f = flagFor(phone, extra);
  return f && f.requirePrepay ? f : null;
}
function setRequirePrepay(phone, on, extra = {}) {
  const keys = identityKeys(phone, extra);
  const flags = (store.root.db.flaggedCustomers ||= {});
  if (!keys.some((k) => flags[k])) return null;
  let result = null;
  for (const k of keys) {
    if (!flags[k] && !on) continue;
    const prev = flags[k] || { flaggedAt: new Date().toISOString(), count: 0, phoneMasked: sec.maskPhone(phone) };
    flags[k] = { ...prev, requirePrepay: !!on, requirePrepayAt: on ? new Date().toISOString() : null };
    result = flags[k];
  }
  store.root.save();
  return result ? { ...result } : null;
}

// ---------- customer NO ----------
// Called by deposits.handleNoshowReply on a NO. Returns the texts for server.js to send.
function openOnNo(d, { base = '' } = {}) {
  const dep = deposits();
  const b = store.findBooking(d.bookingId) || null;
  const checkInRec = d.vendorCheckIn || (b && b.vendorCheckIn) || null;
  if (checkInRec && !d.vendorCheckIn) d.vendorCheckIn = checkInRec;
  const at = iso();
  if (checkInRec) {
    // Vendor checked in: hold for admin review instead of a plain pause.
    if (!['refunded', 'released'].includes(d.status)) {
      d.status = 'disputed';
      d.payoutPaused = true;
      d.noshowReply = 'no';
      d.disputedAt = at;
      d.updatedAt = at;
    }
    outcome('noShowReported', d);
    outcome('disputed', d);
  } else {
    dep.pauseForNoshow(d);
  }
  const repeat = recordClaim(d.phone, d.id, { email: d.email, fingerprint: d.cardFingerprint });
  d.dispute = {
    openedAt: at, vendorCheckedIn: !!checkInRec, proofRequestedAt: at, evidence: [], photos: [],
    followupDueAt: null, followupSentAt: null, followupSkipped: null, autoReleaseAt: null,
    customerReply: null, customerReplyAt: null, resolution: null, resolvedAt: null, resolvedBy: null,
    repeatClaim: repeat.flagged ? { count: repeat.count, threshold: repeat.threshold } : null,
  };
  timeline(d, 'customer_no', `Customer replied NO (says the vendor did not show)${repeat.flagged ? `. Repeat claimer: ${repeat.count} claims in ${cfg().flagWindowDays} days` : ''}`, at);
  if (checkInRec) queueFollowup(d);
  const name = (b && b.name) || 'A customer';
  const when = (b && b.slotLabel) || timeOf(b && b.slotStart);
  const link = proofLink(base, d);
  const held = ['paused', 'disputed'].includes(d.status);
  const suffix = !held ? ' BuzzCall will review it.' : checkInRec ? ` You checked in at ${timeOf(checkInRec.at)}, so your payout is on hold for review, not cancelled.` : ' Your payout is paused until this is reviewed.';
  const vendorText = `BuzzCall: ${name} says you didn't show for ${when}. Reply with a photo or details, or open ${link} to respond.${suffix}`;
  timeline(d, 'vendor_notified', 'Vendor texted a reply-with-proof request', at);
  const shop = shopName(d);
  const sid = shopContext.shopId();
  const review = `${linkBase(base)}/admin/deposits${sid ? `?shop=${encodeURIComponent(sid)}` : ''}`;
  const adminAlert = `BUZZ ${shop}: NO-SHOW claim, booking ${d.bookingId} ($${dep.money(d.amountCents)}). `
    + (checkInRec ? `VENDOR CHECKED IN ${timeOf(checkInRec.at)}${checkInRec.geo ? ' with location' : ''}: payout held as DISPUTED for your review. ` : 'Vendor did not check in: payout PAUSED. ')
    + (repeat.flagged ? `REPEAT CLAIMER: ${repeat.count} no-show claims in ${cfg().flagWindowDays} days. ` : '')
    + `Customer: ${sec.maskPhone(d.phone)}. Review: ${review}`;
  d.updatedAt = at;
  store.save();
  return {
    deposit: d, answer: 'no',
    reply: checkInRec ? "Thanks for letting us know. We're holding the payment while we review your claim and will follow up." : "Thanks, we've paused the payment and will follow up within 1 business day.",
    vendorText, adminAlert, disputed: !!checkInRec, repeatClaim: d.dispute.repeatClaim,
  };
}

// ---------- vendor evidence ----------
const isOpen = (d) => !!(d && d.dispute && !d.dispute.resolution && ['paused', 'disputed'].includes(d.status));
function openDisputes() { return deposits().list().filter(isOpen); }
function queueFollowup(d) {
  const x = d.dispute;
  if (!x || x.followupSentAt || x.followupDueAt || x.customerReply || x.resolution) return;
  x.followupDueAt = iso();
}
function cleanText(t, max = 1000) {
  return String(t ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
const MEDIA_RE = /^https:\/\/[A-Za-z0-9.-]+\.twilio\.com\/[^\s"'<>]{1,400}$/;
function mediaFrom(body = {}) {
  const n = Math.min(10, Math.max(0, parseInt(body.NumMedia, 10) || 0));
  const out = [];
  for (let i = 0; i < n; i++) {
    const url = String(body[`MediaUrl${i}`] || '');
    if (!MEDIA_RE.test(url)) continue;
    out.push({ url, contentType: String(body[`MediaContentType${i}`] || '').slice(0, 60) || null });
  }
  return out;
}
// Decodes a client-compressed data URL. Only JPEG/PNG/WebP (checked by magic bytes), at most MAX_PHOTO_BYTES.
function decodePhoto(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return { error: 'Photos must be JPEG, PNG or WebP.' };
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_PHOTO_BYTES) return { error: 'That photo is too large. Try a smaller one.' };
  const type = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF ? 'image/jpeg'
    : buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) ? 'image/png'
      : buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null;
  if (!type) return { error: 'Photos must be JPEG, PNG or WebP.' };
  return { type, data: buf.toString('base64'), bytes: buf.length };
}
function photoBucket() {
  const p = store.db.disputePhotos;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : (store.db.disputePhotos = {});
}
function photoHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
// Returns true when this exact photo (bytes or MMS url) was already used on another deposit.
function notePhotoHash(hash, depositId) {
  if (!hash) return false;
  const root = store.root;
  const idx = (root.db.photoHashes ||= {});
  const prev = idx[hash];
  const shopId = shopContext.shopId() || 'legacy';
  const reused = !!(prev && (prev.depositId !== depositId || prev.shopId !== shopId));
  if (!prev) idx[hash] = { depositId, shopId, at: iso() };
  root.save();
  return reused;
}
function storePhoto(d, photo) {
  const bucket = photoBucket();
  const id = rid('ph');
  const hash = photoHash(Buffer.from(photo.data, 'base64'));
  bucket[id] = { depositId: d.id, type: photo.type, data: photo.data, bytes: photo.bytes, at: iso(), hash };
  const ids = Object.keys(bucket);
  if (ids.length > MAX_PHOTOS_PER_SHOP) {
    ids.sort((a, b) => String(bucket[a].at).localeCompare(String(bucket[b].at)));
    for (const k of ids.slice(0, ids.length - MAX_PHOTOS_PER_SHOP)) delete bucket[k];
  }
  return id;
}
function getPhoto(d, id) {
  const p = typeof id === 'string' && photoBucket()[id];
  return p && d && p.depositId === d.id ? p : null;
}
// source: 'mms' | 'sms' | 'portal' | 'link'
function addEvidence(d, { source, text, media = [], photo = null } = {}) {
  if (!isOpen(d)) return { ok: false, reason: 'closed' };
  const x = d.dispute;
  x.evidence = x.evidence || [];
  if (x.evidence.length >= MAX_EVIDENCE) return { ok: false, reason: 'limit' };
  const note = cleanText(text);
  let photoId = null;
  let photoReused = false;
  if (photo) {
    const own = (x.evidence || []).filter((e) => e.photoId).length;
    if (own >= MAX_PHOTOS_PER_DEPOSIT) return { ok: false, reason: 'photo_limit' };
    photoId = storePhoto(d, photo);
    const stored = photoBucket()[photoId];
    photoReused = !!(stored && notePhotoHash(stored.hash, d.id));
  }
  const mediaReuse = [];
  for (const m of media) {
    const reused = notePhotoHash(photoHash(m.url), d.id);
    mediaReuse.push(reused);
    if (reused) photoReused = true;
  }
  if (!note && !media.length && !photoId) return { ok: false, reason: 'empty' };
  const e = { id: rid('ev'), at: iso(), source, text: note || null, media: media.slice(0, 10), photoId, photoReused: photoReused || undefined };
  x.evidence.push(e);
  const parts = [note ? `"${note.slice(0, 160)}"` : '', media.length ? `${media.length} MMS photo(s)` : '', photoId ? '1 uploaded photo' : ''].filter(Boolean).join(', ');
  if (photoReused) {
    d.photoReuse = true;
    timeline(d, 'photo_reuse', 'Photo matches one already used on another deposit', e.at);
  }
  timeline(d, 'vendor_proof', `Vendor sent proof via ${source}: ${parts}`, e.at);
  if (!x.disputedOutcome) { x.disputedOutcome = true; outcome('disputed', d); }
  queueFollowup(d);
  d.updatedAt = iso();
  store.save();
  return { ok: true, evidence: e };
}
// An inbound text from this shop's OWNER_PHONE while a dispute is open is taken as proof. Returns null otherwise so
// the message continues through the normal flow.
function handleVendorMessage(from, body, reqBody = {}, { base = '' } = {}) {
  const ownerPhone = env.OWNER_PHONE;
  if (!from || !ownerPhone || from !== ownerPhone) return null;
  const open = openDisputes().sort((a, b) => String(b.dispute.openedAt).localeCompare(String(a.dispute.openedAt)));
  if (!open.length) return null;
  const d = open[0];
  const media = mediaFrom(reqBody);
  const r = addEvidence(d, { source: media.length ? 'mms' : 'sms', text: body, media });
  if (!r.ok) {
    if (r.reason === 'limit') return { deposit: d, reply: 'BuzzCall: this claim already has the maximum amount of proof. We will review it.' };
    return null;
  }
  const b = store.findBooking(d.bookingId);
  const when = (b && b.slotLabel) || 'the appointment';
  const sid = shopContext.shopId();
  return {
    deposit: d,
    reply: `BuzzCall: got it, your proof for ${when} is attached to the claim. We'll check with the customer and follow up.`,
    adminAlert: `BUZZ ${shopName(d)}: vendor sent proof (${media.length ? `${media.length} photo(s)` : 'text'}) for no-show claim on booking ${d.bookingId}. Review: ${linkBase(base)}/admin/deposits${sid ? `?shop=${encodeURIComponent(sid)}` : ''}`,
  };
}

// ---------- customer follow-up, KEEP, auto-release ----------
function pendingKeep(phone) {
  if (!phone) return null;
  return deposits().list().find((d) => isOpen(d) && d.phone === phone && d.dispute.followupSentAt && !d.dispute.customerReply) || null;
}
function handleKeep(phone, body, { base = '' } = {}) {
  const d = pendingKeep(phone);
  if (!d) return null;
  const l = letters(body);
  if (l !== 'KEEP' && !/^keep\b/i.test(String(body || '').trim())) return null;
  const at = iso();
  d.dispute.customerReply = 'keep';
  d.dispute.customerReplyAt = at;
  d.dispute.autoReleaseAt = null;
  timeline(d, 'customer_keep', 'Customer replied KEEP: claim stays open for admin review', at);
  d.updatedAt = at;
  store.save();
  const sid = shopContext.shopId();
  return {
    deposit: d,
    reply: "Thanks, your claim stays open. We'll review it and follow up within 1 business day.",
    adminAlert: `BUZZ ${shopName(d)}: customer replied KEEP on no-show claim for booking ${d.bookingId}. It needs your decision (Refund or Release). Review: ${linkBase(base)}/admin/deposits${sid ? `?shop=${encodeURIComponent(sid)}` : ''}`,
  };
}
function followupText(d) {
  const shop = shopName(d), h = cfg().autoReleaseHours;
  const hasProof = (d.dispute.evidence || []).length > 0;
  return hasProof
    ? `${shop} says they were there and sent proof. Reply KEEP to keep your claim, or we'll release payment in ${h} hours.`
    : `${shop} says they were there (they checked in at ${timeOf(d.vendorCheckIn && d.vendorCheckIn.at)}). Reply KEEP to keep your claim, or we'll release payment in ${h} hours.`;
}
async function tick({ sendSms } = {}) {
  const dep = deposits();
  let sent = 0, released = 0;
  for (const d of dep.list()) {
    if (!isOpen(d)) continue;
    const x = d.dispute;
    // 1) Follow-up text to the customer.
    if (x.followupDueAt && !x.followupSentAt && !x.followupSkipped && !x.customerReply) {
      const due = Date.parse(x.followupDueAt);
      if (Number.isFinite(due) && due <= now()) {
        const sendAt = dep.nextAllowedSend(Math.max(due, now()));
        if (sendAt > now() + 1000) { x.followupDueAt = iso(sendAt); d.updatedAt = iso(); continue; }
        if (store.isOptedOut(d.phone) || (store.isPaused && store.isPaused(d.phone))) {
          x.followupSkipped = store.isOptedOut(d.phone) ? 'opted_out' : 'paused';
          timeline(d, 'followup_skipped', `Follow-up not sent (customer ${x.followupSkipped === 'opted_out' ? 'opted out of texts' : 'texts paused'}); waits for admin review, no auto-release`);
          d.updatedAt = iso();
          continue;
        }
        let r;
        if (typeof sendSms === 'function') {
          try { r = await sendSms(d.phone, followupText(d)); } catch (e) { console.error('[disputes] follow-up sms failed:', e.message); continue; }
        }
        if (r && r.ok === false && r.skipped) {
          x.followupSkipped = r.skipped;
          timeline(d, 'followup_skipped', `Follow-up not sent (${r.skipped}); waits for admin review`);
          d.updatedAt = iso();
          continue;
        }
        x.followupSentAt = iso();
        x.autoReleaseAt = iso(now() + cfg().autoReleaseHours * HOUR);
        timeline(d, 'followup_sent', `Customer asked to reply KEEP within ${cfg().autoReleaseHours}h or payment is released`);
        d.updatedAt = iso();
        sent++;
        continue;
      }
    }
    // 2) Auto-release after no reply, only with an in-window check-in AND a photo that is not reused.
    if (x.followupSentAt && !x.customerReply && x.autoReleaseAt && Date.parse(x.autoReleaseAt) <= now()) {
      const checkInRec = d.vendorCheckIn || (store.findBooking(d.bookingId) || {}).vendorCheckIn;
      const freshPhoto = (x.evidence || []).some((e) => (e.photoId || (e.media || []).length) && !e.photoReused);
      if (!checkInRec || !freshPhoto) {
        x.adminReview = true;
        x.adminReviewReason = !checkInRec ? 'no_checkin' : 'no_photo';
        x.autoReleaseAt = null;
        timeline(d, 'admin_review', !checkInRec ? 'No in-window check-in: held for admin review (not auto-released)' : 'No new photo: text-only evidence held for admin review');
        d.updatedAt = iso();
        continue;
      }
      timeline(d, 'no_reply', `No KEEP reply within ${cfg().autoReleaseHours}h`);
      const r = await dep.releaseDeposit(d, { force: true, by: 'auto' });
      if (r.ok || r.reason === 'not_connected') released++;
    }
  }
  store.save();
  return { followups: sent, autoReleased: released };
}

// Called by deposits on release / refund.
function markResolved(d, side, by = 'admin') {
  if (!d || !d.dispute || d.dispute.resolution) return;
  const at = iso();
  d.dispute.resolution = side;
  d.dispute.resolvedAt = at;
  d.dispute.resolvedBy = by;
  d.dispute.autoReleaseAt = null;
  timeline(d, side === 'vendor' ? 'resolved_vendor' : 'resolved_customer',
    side === 'vendor' ? `Resolved for the vendor: payout released (${by === 'auto' ? 'automatically, no customer reply' : 'by admin'})` : `Resolved for the customer: deposit refunded (${by})`, at);
  outcome('disputeResolved', d, side);
}

// ---------- admin views ----------
const SOURCE = { mms: 'MMS reply', sms: 'text reply', portal: 'vendor portal', link: 'proof link' };
function fullTimeline(d, b) {
  const rows = [];
  if (b && b.createdAt) rows.push({ at: b.createdAt, type: 'booking', text: `Booked ${b.service || b.need || 'appointment'} for ${b.slotLabel || timeOf(b.slotStart)}` });
  if (d.paidAt) rows.push({ at: d.paidAt, type: 'paid', text: `Deposit $${deposits().money(d.amountCents || 0)} paid and held` });
  for (const t of d.disputeTimeline || []) rows.push(t);
  if (d.vendorCheckIn && !(d.disputeTimeline || []).some((t) => t.type === 'checkin')) {
    const c = d.vendorCheckIn;
    rows.push({ at: c.at, type: 'checkin', text: `Vendor checked in${c.geo ? ` at ${c.geo.lat},${c.geo.lng} (±${c.geo.accuracy ?? '?'} m)` : ' (no location shared)'} via ${c.source}` });
  }
  if (d.dispute && d.dispute.followupSentAt && !d.dispute.customerReply && !d.dispute.resolution && d.dispute.autoReleaseAt) {
    rows.push({ at: d.dispute.autoReleaseAt, type: 'pending', text: 'Scheduled: auto-release if the customer does not reply KEEP' });
  }
  return rows.sort((a, c) => String(a.at).localeCompare(String(c.at)));
}
// Plain-text summary for a Stripe dispute response or the admin's records.
function evidenceText(d, b, { shop = shopName(d), zone = shopTime.timeZone() } = {}) {
  const fmt = (v) => { try { return new Date(v).toLocaleString('en-US', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' }); } catch { return String(v); } };
  const lines = [
    `BuzzCall no-show claim evidence`,
    `Shop: ${shop}`,
    `Booking: ${d.bookingId}`,
    b ? `Appointment: ${b.service || b.need || 'Service visit'}, ${b.slotLabel || fmt(b.slotStart)}` : null,
    `Deposit: $${deposits().money(d.amountCents || 0)} (status: ${d.status})`,
    d.paymentIntentId ? `Payment: ${d.paymentIntentId}` : null,
    '',
    'Vendor check-in:',
    d.vendorCheckIn ? `  ${fmt(d.vendorCheckIn.at)} via ${d.vendorCheckIn.source}${d.vendorCheckIn.geo ? `, location ${d.vendorCheckIn.geo.lat}, ${d.vendorCheckIn.geo.lng} (accuracy ${d.vendorCheckIn.geo.accuracy ?? 'unknown'} m)` : ', no location shared'}${d.vendorCheckIn.ip ? `, IP ${d.vendorCheckIn.ip}` : ''}` : '  none recorded',
    '',
    'Vendor evidence:',
  ];
  const ev = (d.dispute && d.dispute.evidence) || [];
  if (!ev.length) lines.push('  none submitted');
  for (const e of ev) {
    lines.push(`  ${fmt(e.at)} (${SOURCE[e.source] || e.source})${e.text ? `: ${e.text}` : ''}`);
    for (const m of e.media || []) lines.push(`    photo: ${m.url}${m.contentType ? ` (${m.contentType})` : ''}`);
    if (e.photoId) lines.push(`    photo uploaded in BuzzCall (id ${e.photoId})`);
  }
  lines.push('', 'Timeline:');
  for (const t of fullTimeline(d, b)) lines.push(`  ${fmt(t.at)}  ${t.text}`);
  if (d.dispute && d.dispute.resolution) lines.push('', `Resolution: ${d.dispute.resolution === 'vendor' ? 'payout released to the vendor' : 'deposit refunded to the customer'} (${d.dispute.resolvedBy}) on ${fmt(d.dispute.resolvedAt)}`);
  return lines.filter((l) => l !== null).join('\n') + '\n';
}

module.exports = {
  cfg, sign, readToken, expired, checkinToken, checkinLink, proofToken, proofLink, windowFor, windowState, checkable, geo, checkIn,
  claimKey, recordClaim, flagFor, prepayFor, setRequirePrepay, openOnNo, isOpen, openDisputes, mediaFrom, decodePhoto, getPhoto, addEvidence,
  handleVendorMessage, pendingKeep, handleKeep, followupText, tick, markResolved, fullTimeline, evidenceText, timeline,
  MAX_PHOTO_BYTES, PROOF_LINK_DAYS,
};
