'use strict';
// Deposit protection via Stripe Connect (separate charges + transfers).
// Customer pays BuzzCall's platform account; the vendor share is transferred only after the appointment
// (DEPOSIT_RELEASE_HOURS, default 24). Destination charges transfer immediately, so they cannot hold funds
// until after the job — separate charges + transfers cleanly support delayed payout, refunds before transfer,
// and transfer reversals after release.
//
// Persist state in store.db.deposits (array) and store.db.vendorDebt ({ [accountId]: cents }).
// Mock mode (no STRIPE_SECRET_KEY): same state machine, fake ids, mock clock (offsetMs) for demo fast-forward.
// Statuses: held -> scheduled -> released | refunded; paused (customer NO, vendor did not check in) and disputed
// (customer NO after the vendor checked in: payout held for admin review). Dispute handling lives in src/disputes.js.
const crypto = require('crypto');
const store = require('./store');
const connect = require('./connect');
const shopTime = require('./shopTime');
const shopContext = require('./shopContext');
const env = require('./config').env;
const sec = require('./security');

const on = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const num = (v, d) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const DAY = 86400000;
const HOUR = 3600000;

const cfg = () => ({
  releaseHours: Math.max(0, num(process.env.DEPOSIT_RELEASE_HOURS, 24)),
  noshowHours: Math.max(0, num(process.env.NOSHOW_CHECK_HOURS, 12)),
  platformFeePct: Math.max(0, Math.min(100, num(process.env.DEPOSIT_PLATFORM_FEE_PCT, 0))),
  live: !!process.env.STRIPE_SECRET_KEY,
});

function bucket() {
  store.db.deposits = store.db.deposits || [];
  store.db.vendorDebt = store.db.vendorDebt || {};
  store.db.depositsMeta = store.db.depositsMeta || { offsetMs: 0, events: [] };
  return store.db;
}
const now = () => Date.now() + (cfg().live ? 0 : (bucket().depositsMeta.offsetMs || 0));
const iso = (ms = now()) => new Date(ms).toISOString();
const mid = (p) => `${p}_mock_${crypto.randomBytes(5).toString('hex')}`;
const money = (cents) => (Math.round(cents) / 100).toFixed(2);

function list() { return bucket().deposits.slice(); }
function find(id) { return bucket().deposits.find((d) => d.id === id) || null; }
function findByBooking(bookingId) { return bucket().deposits.find((d) => d.bookingId === bookingId) || null; }
function findByPaymentIntent(pi) {
  return bucket().deposits.find((d) => d.paymentIntentId === pi || d.stripeSessionId === pi) || null;
}
function vendorDebt(accountId) {
  if (!accountId) return 0;
  return Math.max(0, Math.round(bucket().vendorDebt[accountId] || 0));
}
function setVendorDebt(accountId, cents) {
  if (!accountId) return;
  const v = Math.max(0, Math.round(cents));
  if (v) bucket().vendorDebt[accountId] = v; else delete bucket().vendorDebt[accountId];
  store.save();
}
function addVendorDebt(accountId, cents) {
  if (!accountId || !(cents > 0)) return;
  setVendorDebt(accountId, vendorDebt(accountId) + cents);
}

function platformFeeCents(amountCents) {
  const pct = cfg().platformFeePct;
  if (!(pct > 0) || !(amountCents > 0)) return 0;
  return Math.min(amountCents - 1, Math.floor(amountCents * pct / 100));
}

// Appointment instant used for release / no-show scheduling: prefer slot end, else slot start.
function appointmentMs(booking) {
  if (!booking) return now();
  const end = booking.slotEnd ? Date.parse(booking.slotEnd) : NaN;
  const start = booking.slotStart ? Date.parse(booking.slotStart) : NaN;
  if (Number.isFinite(end)) return end;
  if (Number.isFinite(start)) return start;
  return now();
}

function releaseAtFor(booking) {
  return iso(appointmentMs(booking) + cfg().releaseHours * HOUR);
}
function noshowAtFor(booking) {
  return iso(appointmentMs(booking) + cfg().noshowHours * HOUR);
}

// Quiet hours: never send no-show checks between 21:00 and 08:00 shop-local. Push to 08:00 same/next morning.
function nextAllowedSend(atMs, zone = shopTime.timeZone()) {
  let t = atMs;
  for (let i = 0; i < 48; i++) {
    const p = shopTime.parts(t, zone);
    if (!p) return t;
    const mins = p.hour * 60 + p.minute;
    if (mins >= 8 * 60 && mins < 21 * 60) return t;
    // Before 8am -> today 8:00; at/after 9pm -> tomorrow 8:00.
    const day = mins < 8 * 60 ? p : shopTime.addDays(p, 1);
    const instant = shopTime.toInstant(day, 8 * 60, zone);
    if (instant) return instant.getTime();
    t += HOUR; // fallback if DST gap
  }
  return atMs;
}

function hasSmsConsent(phone) {
  if (!phone || store.isOptedOut(phone)) return false;
  const consents = store.db.voiceConsents || [];
  if (consents.some((c) => c && c.from === phone && c.consented)) return true;
  // Text-started leads (already exchanging SMS) count as consented for check-in purposes.
  const leads = store.db.leads || [];
  return leads.some((l) => l && l.phone === phone && (l.messages || []).some((m) => m.dir === 'out'));
}

function recordEvent(type, depositId, extra = {}) {
  const meta = bucket().depositsMeta;
  meta.events = meta.events || [];
  meta.events.unshift({ id: mid('evt'), type, depositId, at: iso(), ...extra });
  meta.events = meta.events.slice(0, 300);
}

function createHeld(booking, payment = {}) {
  bucket();
  let d = findByBooking(booking.id);
  if (d && ['held', 'scheduled', 'paused', 'disputed', 'released', 'refunded'].includes(d.status) && d.paid) return d;
  const amountCents = Math.round(Number(booking.amount || 0) * 100);
  const fee = platformFeeCents(amountCents);
  const acct = connect.accountId();
  if (!d) {
    d = {
      id: crypto.randomBytes(6).toString('hex'),
      bookingId: booking.id,
      phone: booking.phone,
      shopName: env.BUSINESS_NAME || 'Shop',
      amountCents,
      currency: 'usd',
      status: 'held',
      paid: true,
      paidAt: booking.paidAt || iso(),
      releaseAt: releaseAtFor(booking),
      noshowCheckAt: noshowAtFor(booking),
      noshowSentAt: null,
      noshowReply: null,
      payoutPaused: false,
      connectAccountId: acct || null,
      payoutPendingConnect: !acct,
      platformFeeCents: fee,
      vendorAmountCents: Math.max(0, amountCents - fee),
      vendorDebtAppliedCents: 0,
      paymentIntentId: payment.paymentIntentId || booking.stripePaymentIntentId || null,
      chargeId: payment.chargeId || booking.stripeChargeId || null,
      stripeSessionId: payment.sessionId || booking.stripeSessionId || null,
      transferId: null,
      refundId: null,
      transferReversalId: null,
      releaseIdempotencyKey: `dep-release-${booking.id}`,
      refundIdempotencyKey: `dep-refund-${booking.id}`,
      createdAt: iso(),
      updatedAt: iso(),
    };
    if (booking.vendorCheckIn) d.vendorCheckIn = booking.vendorCheckIn;
    bucket().deposits.unshift(d);
  } else {
    Object.assign(d, {
      paid: true, status: 'held', paidAt: booking.paidAt || iso(),
      amountCents, platformFeeCents: fee, vendorAmountCents: Math.max(0, amountCents - fee),
      releaseAt: d.releaseAt || releaseAtFor(booking),
      noshowCheckAt: d.noshowCheckAt || noshowAtFor(booking),
      connectAccountId: acct || d.connectAccountId || null,
      payoutPendingConnect: !(acct || d.connectAccountId),
      paymentIntentId: payment.paymentIntentId || d.paymentIntentId,
      chargeId: payment.chargeId || d.chargeId,
      stripeSessionId: payment.sessionId || d.stripeSessionId,
      updatedAt: iso(),
    });
  }
  // Immediately mark scheduled if release time is already known (held until releaseAt).
  if (d.status === 'held') d.status = 'scheduled';
  recordEvent('held', d.id, { bookingId: booking.id, amountCents });
  store.save();
  return d;
}

// After mock/live payment marks a booking paid.
function onBookingPaid(booking, payment) {
  if (!booking || !(Number(booking.amount) > 0)) return null;
  return createHeld(booking, payment || {});
}

async function releaseDeposit(d, { force = false, by = 'admin' } = {}) {
  if (!d || d.status === 'refunded') return { ok: false, reason: 'refunded' };
  if (d.status === 'released' && d.transferId) return { ok: true, already: true, deposit: d };
  if ((d.status === 'paused' || d.status === 'disputed') && !force) return { ok: false, reason: d.status };
  if (!force && Date.parse(d.releaseAt) > now()) return { ok: false, reason: 'too_early' };
  if (force && (d.status === 'paused' || d.status === 'disputed' || d.payoutPaused)) {
    // An explicit release (admin, or dispute auto-release) lifts the hold even if the payout must wait for Connect.
    d.payoutPaused = false;
    if (d.dispute) require('./disputes').markResolved(d, 'vendor', by);
  }

  const acct = d.connectAccountId || connect.accountId();
  if (!acct) {
    d.payoutPendingConnect = true;
    d.status = 'scheduled';
    d.updatedAt = iso();
    store.save();
    return { ok: false, reason: 'not_connected' };
  }
  d.connectAccountId = acct;

  let payoutCents = Math.max(0, d.vendorAmountCents || 0);
  const debt = vendorDebt(acct);
  const applied = Math.min(debt, payoutCents);
  payoutCents -= applied;
  d.vendorDebtAppliedCents = (d.vendorDebtAppliedCents || 0) + applied;
  if (applied) setVendorDebt(acct, debt - applied);

  if (payoutCents <= 0) {
    d.status = 'released';
    d.releasedAt = iso();
    d.transferId = d.transferId || `zero_${d.id}`;
    d.updatedAt = iso();
    recordEvent('released_zero', d.id, { appliedDebt: applied });
    store.save();
    return { ok: true, deposit: d, zero: true };
  }

  if (cfg().live) {
    const transfer = await connect.stripe().transfers.create({
      amount: payoutCents,
      currency: d.currency || 'usd',
      destination: acct,
      ...(d.chargeId ? { source_transaction: d.chargeId } : {}),
      transfer_group: d.bookingId,
      metadata: { depositId: d.id, bookingId: d.bookingId, platformFeeCents: String(d.platformFeeCents || 0) },
    }, { idempotencyKey: d.releaseIdempotencyKey });
    d.transferId = transfer.id;
  } else {
    d.transferId = d.transferId || mid('tr');
  }
  d.status = 'released';
  d.releasedAt = iso();
  d.payoutPaused = false;
  d.updatedAt = iso();
  recordEvent('released', d.id, { transferId: d.transferId, payoutCents, appliedDebt: applied });
  store.save();
  return { ok: true, deposit: d };
}

async function refundDeposit(d, { reason = 'admin' } = {}) {
  if (!d) return { ok: false, reason: 'not_found' };
  if (d.status === 'refunded') return { ok: true, already: true, deposit: d };
  if (d.dispute && !d.dispute.resolution) require('./disputes').markResolved(d, 'customer', reason);

  // After transfer: reverse transfer first (or record vendor_debt if reverse fails / short balance).
  if (d.transferId && d.status === 'released' && !String(d.transferId).startsWith('zero_')) {
    if (cfg().live) {
      try {
        const rev = await connect.stripe().transfers.createReversal(d.transferId, {
          metadata: { depositId: d.id, reason },
        }, { idempotencyKey: `${d.refundIdempotencyKey}-rev` });
        d.transferReversalId = rev.id;
      } catch (e) {
        console.error('[deposits] transfer reversal failed; recording vendor_debt:', e.message);
        addVendorDebt(d.connectAccountId, d.vendorAmountCents - (d.vendorDebtAppliedCents || 0));
        d.vendorDebtRecordedCents = d.vendorAmountCents - (d.vendorDebtAppliedCents || 0);
      }
    } else {
      d.transferReversalId = mid('trr');
    }
  } else if (d.status === 'released' && String(d.transferId || '').startsWith('zero_') && (d.vendorDebtAppliedCents || 0) > 0) {
    // Zero-payout release that cleared debt: restore the debt when refunding.
    addVendorDebt(d.connectAccountId, d.vendorDebtAppliedCents);
  }

  if (cfg().live) {
    const pi = d.paymentIntentId;
    if (pi) {
      const refund = await connect.stripe().refunds.create({
        payment_intent: pi,
        metadata: { depositId: d.id, bookingId: d.bookingId, reason },
      }, { idempotencyKey: d.refundIdempotencyKey });
      d.refundId = refund.id;
    } else if (d.chargeId) {
      const refund = await connect.stripe().refunds.create({
        charge: d.chargeId,
        metadata: { depositId: d.id, bookingId: d.bookingId, reason },
      }, { idempotencyKey: d.refundIdempotencyKey });
      d.refundId = refund.id;
    } else {
      d.refundId = mid('re'); // session-only edge case
    }
  } else {
    d.refundId = d.refundId || mid('re');
  }

  d.status = 'refunded';
  d.refundedAt = iso();
  d.payoutPaused = false;
  d.updatedAt = iso();
  recordEvent('refunded', d.id, { reason, refundId: d.refundId });
  store.save();
  try {
    const outcomes = require('./outcomes');
    if (outcomes.refunded) outcomes.refunded(d);
  } catch {}
  return { ok: true, deposit: d };
}

function pauseForNoshow(d) {
  if (!d || d.status === 'refunded' || d.status === 'released') return d;
  d.status = 'paused';
  d.payoutPaused = true;
  d.noshowReply = 'no';
  d.pausedAt = iso();
  d.updatedAt = iso();
  recordEvent('paused_noshow', d.id);
  store.save();
  try {
    const outcomes = require('./outcomes');
    if (outcomes.noShowReported) outcomes.noShowReported(d);
  } catch {}
  return d;
}

// Pending no-show answer for this phone (at most one active check).
function pendingNoshow(phone) {
  if (!phone) return null;
  return bucket().deposits.find((d) => d.phone === phone && d.noshowSentAt && !d.noshowReply
    && ['scheduled', 'held', 'paused', 'disputed'].includes(d.status)) || null;
}

// YES/NO reply handler. Returns null if this number has no pending check (so SMS conversation continues).
// A NO opens a dispute (src/disputes.js): 'disputed' when the vendor checked in, else 'paused' as before. The result
// carries the customer reply, the vendor's reply-with-proof text (vendorText) and the admin buzz (adminAlert).
function handleNoshowReply(phone, body, { base = '' } = {}) {
  const d = pendingNoshow(phone);
  if (!d) return null;
  const letters = require('./optout').letters(body);
  if (letters === 'YES' || /^YES\b/i.test(String(body || '').trim())) {
    d.noshowReply = 'yes';
    d.updatedAt = iso();
    recordEvent('noshow_yes', d.id);
    store.save();
    return { deposit: d, answer: 'yes', reply: null };
  }
  if (letters === 'NO' || /^NO\b/i.test(String(body || '').trim())) {
    return require('./disputes').openOnNo(d, { base });
  }
  return null; // not a clear YES/NO — leave for normal conversation (check stays pending)
}

async function sendDueNoshowChecks({ sendSms } = {}) {
  const results = [];
  const zone = shopTime.timeZone();
  for (const d of bucket().deposits) {
    if (d.noshowSentAt || d.noshowReply) continue;
    if (!['held', 'scheduled', 'paused', 'disputed'].includes(d.status) && d.status !== 'released') continue;
    if (d.status === 'refunded') continue;
    const due = Date.parse(d.noshowCheckAt || 0);
    if (!Number.isFinite(due) || due > now()) continue;
    const sendAt = nextAllowedSend(Math.max(due, now()), zone);
    if (sendAt > now() + 1000) {
      // Quiet hours: push the check time forward and wait.
      d.noshowCheckAt = iso(sendAt);
      d.updatedAt = iso();
      continue;
    }
    if (!hasSmsConsent(d.phone)) {
      d.noshowSentAt = iso(); // mark attempted so we never spam; skipped due to consent/opt-out
      d.noshowSkipped = store.isOptedOut(d.phone) ? 'opted_out' : 'no_consent';
      d.updatedAt = iso();
      recordEvent('noshow_skipped', d.id, { reason: d.noshowSkipped });
      continue;
    }
    const shop = d.shopName || env.BUSINESS_NAME || 'the shop';
    const text = `Did ${shop} show up for your appointment? Reply YES or NO.`;
    if (typeof sendSms === 'function') {
      try { await sendSms(d.phone, text); } catch (e) { console.error('[deposits] noshow sms failed:', e.message); continue; }
    }
    d.noshowSentAt = iso();
    d.updatedAt = iso();
    recordEvent('noshow_sent', d.id);
    results.push(d);
  }
  store.save();
  return results;
}

async function processDueReleases() {
  const out = [];
  for (const d of bucket().deposits) {
    if (!['held', 'scheduled'].includes(d.status)) continue;
    if (d.payoutPaused) continue;
    if (Date.parse(d.releaseAt) > now()) continue;
    out.push(await releaseDeposit(d));
  }
  return out;
}

// Combined tick: safe across restarts (state is persisted; Stripe calls use idempotency keys).
async function tick({ sendSms } = {}) {
  const noshows = await sendDueNoshowChecks({ sendSms });
  const disputes = await require('./disputes').tick({ sendSms });
  const releases = await processDueReleases();
  return { noshows: noshows.length, releases: releases.filter((r) => r.ok && !r.already).length + disputes.autoReleased,
    followups: disputes.followups, autoReleased: disputes.autoReleased };
}

// Demo/mock: advance the deposits clock (and optionally process due work).
async function mockAdvance(hours, { sendSms } = {}) {
  if (cfg().live) throw Object.assign(new Error('demo advance only in mock mode'), { status: 404 });
  if (!sec.demoAllowed()) throw Object.assign(new Error('demo advance disabled'), { status: 403 });
  bucket().depositsMeta.offsetMs = (bucket().depositsMeta.offsetMs || 0) + Math.max(0, Number(hours) || 0) * HOUR;
  store.save();
  const result = await tick({ sendSms });
  return { now: iso(), offsetMs: bucket().depositsMeta.offsetMs, ...result };
}

function attachReadyAccount() {
  const ready = connect.chargeAccount();
  if (!ready) return true;
  let changed = false;
  for (const d of bucket().deposits) {
    if (d.payoutPendingConnect && !d.connectAccountId && ['held', 'scheduled', 'paused', 'disputed'].includes(d.status)) {
      d.connectAccountId = ready;
      d.payoutPendingConnect = false;
      d.updatedAt = iso();
      changed = true;
    }
  }
  if (changed) store.save();
  return true;
}
async function handleWebhookEvent(event) {
  if (!event || !event.type) return false;
  const o = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (o.mode && o.mode !== 'payment') return false;
      return true; // server.js still calls onPaid; deposit row created there
    }
    case 'charge.refunded': {
      const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
      const d = findByPaymentIntent(pi) || bucket().deposits.find((x) => x.chargeId === o.id);
      if (d && d.status !== 'refunded') {
        d.status = 'refunded';
        d.refundedAt = iso();
        d.refundId = d.refundId || (o.refunds?.data?.[0]?.id) || null;
        d.updatedAt = iso();
        recordEvent('refunded_webhook', d.id);
        store.save();
      }
      return !!d;
    }
    case 'transfer.created':
    case 'transfer.updated':
    case 'transfer.reversed': {
      const d = bucket().deposits.find((x) => x.transferId === o.id
        || (o.metadata && o.metadata.depositId && x.id === o.metadata.depositId));
      if (!d) return false;
      if (event.type === 'transfer.reversed' || o.reversed) {
        d.transferReversalId = d.transferReversalId || o.reversals?.data?.[0]?.id || 'reversed';
      }
      d.updatedAt = iso();
      store.save();
      return true;
    }
    case 'account.updated':
      connect.applyAccount(o);
      return attachReadyAccount();
    default:
      if (connect.isV2AccountEvent(event.type)) {
        // Thin events carry the account id, not its capabilities. Fetch the current v2 account.
        if (!(o && o.id && (o.object === 'v2.core.account' || o.configuration))) await connect.refresh();
        else connect.applyAccount(o);
        return attachReadyAccount();
      }
      return false;
  }
}

function summary() {
  const rows = list();
  const counts = { held: 0, scheduled: 0, paused: 0, disputed: 0, released: 0, refunded: 0 };
  for (const d of rows) counts[d.status] = (counts[d.status] || 0) + 1;
  const disputes = require('./disputes');
  // Read-only view rows: booking context + repeat-claim flag for the admin timeline (records are not mutated).
  const view = rows.slice(0, 100).map((d) => {
    const b = store.findBooking(d.bookingId);
    const booking = b ? { name: b.name || null, service: b.service || b.need || null, slotLabel: b.slotLabel || null, slotStart: b.slotStart || null, createdAt: b.createdAt || null } : null;
    return { ...d, booking, customerFlag: d.dispute || d.noshowReply === 'no' ? disputes.flagFor(d.phone) : null,
      timeline: d.dispute || d.vendorCheckIn ? disputes.fullTimeline(d, b) : [] };
  });
  return {
    mode: cfg().live ? (connect.mode() === 'live' ? 'live' : 'test') : 'mock',
    now: iso(),
    counts,
    releaseHours: cfg().releaseHours,
    noshowHours: cfg().noshowHours,
    platformFeePct: cfg().platformFeePct,
    vendorDebt: { ...bucket().vendorDebt },
    autoReleaseHours: disputes.cfg().autoReleaseHours,
    deposits: view,
  };
}

module.exports = {
  cfg, now, list, find, findByBooking, vendorDebt, setVendorDebt, addVendorDebt,
  platformFeeCents, appointmentMs, releaseAtFor, noshowAtFor, nextAllowedSend, hasSmsConsent,
  createHeld, onBookingPaid, releaseDeposit, refundDeposit, pauseForNoshow,
  pendingNoshow, handleNoshowReply, sendDueNoshowChecks, processDueReleases, tick, mockAdvance,
  handleWebhookEvent, summary, money,
};
