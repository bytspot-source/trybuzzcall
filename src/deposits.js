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
  return iso(appointmentMs(booking) + Math.max(cfg().releaseHours * HOUR, extendedHoldMs()));
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

let onAlert = async () => {};
const setAlert = (fn) => { onAlert = typeof fn === 'function' ? fn : async () => {}; };
async function alertAdmin(msg, subject) {
  console.error(`[deposits] ${sec.maskPhone(msg)}`);
  try { await onAlert(msg, subject); } catch (e) { console.error('[deposits] alert failed:', e.message); }
}

// livemode is stored on the row (from the Stripe event when we have one, otherwise from the key).
function stripeModeOf(payment = {}) {
  if (payment.livemode === true) return 'live';
  if (payment.livemode === false) return 'test';
  if (payment.stripeMode) return payment.stripeMode;
  return connect.mode();
}
function modeOk(d) {
  if (!d || d.archived) return false;
  if (!d.stripeMode) return connect.mode() !== 'live';
  return d.stripeMode === connect.mode();
}
// Payout account: charges enabled, and admin-approved when this app created the account.
function payoutAccount() {
  return typeof connect.payableAccount === 'function' ? connect.payableAccount() : connect.chargeAccount();
}
// First NEW_VENDOR_HOLD_JOBS (default 5) vendor-shop deposits wait NEW_VENDOR_HOLD_DAYS (default 7).
// The legacy single-shop line is not a marketplace vendor and keeps DEPOSIT_RELEASE_HOURS.
function extendedHoldMs() {
  if (!shopContext.current()) return 0;
  const days = num(process.env.NEW_VENDOR_HOLD_DAYS, 7);
  const jobs = Math.floor(num(process.env.NEW_VENDOR_HOLD_JOBS, 5));
  if (!(days > 0) || jobs <= 0) return 0;
  const done = bucket().deposits.filter((d) => d.status === 'released' && !d.archived).length;
  return done >= jobs ? 0 : days * DAY;
}
function velocityBlock() {
  const maxCount = num(process.env.DEPOSIT_DAILY_MAX_COUNT, 30);
  const maxDollars = num(process.env.DEPOSIT_DAILY_MAX_DOLLARS, 1500);
  if (!(maxCount > 0) && !(maxDollars > 0)) return null;
  const since = now() - DAY;
  const recent = bucket().deposits.filter((d) => !d.archived && Date.parse(d.createdAt) >= since);
  const pending = (store.db.bookings || []).filter((b) => b && !b.paid && b.stripeSessionId && Date.parse(b.createdAt) >= since);
  const count = recent.length + pending.length;
  const dollars = recent.reduce((s, d) => s + (d.amountCents || 0), 0) / 100
    + pending.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  if (maxCount > 0 && count >= maxCount) return 'count';
  if (maxDollars > 0 && dollars >= maxDollars) return 'amount';
  return null;
}
function indexPayment(d) {
  const root = store.root;
  const idx = (root.db.paymentIndex ||= {});
  const rec = { shopId: shopContext.shopId() || 'legacy', bookingId: d.bookingId, depositId: d.id, at: iso() };
  for (const id of [d.paymentIntentId, d.chargeId, d.stripeSessionId]) if (id) idx[String(id)] = rec;
  root.save();
}
function lookupPayment(object = {}) {
  const idx = store.root.db.paymentIndex || {};
  const ids = [object.id, object.charge, object.payment_intent, object.payment_intent?.id, object.charge?.id]
    .filter((id) => typeof id === 'string' && id);
  for (const id of ids) if (idx[id]) return idx[id];
  return null;
}
// Compare-and-set on the persisted status. Callers re-read after every await.
function casStatus(d, from, to) {
  const cur = find(d.id);
  if (!cur || !from.includes(cur.status)) return false;
  cur.statusBeforeLease = cur.status;
  cur.status = to;
  cur.updatedAt = iso();
  store.save();
  return true;
}
function still(d, status) {
  const cur = find(d.id);
  return !!(cur && cur.status === status);
}
// Exact YES / NO / NOSHOW. Trailing punctuation is fine. "No problem" and "no-show" are not NO.
function replyWord(body) {
  return String(body || '').trim().replace(/[.!?]+$/g, '').trim().toLowerCase();
}
function sessionProblem(session, booking) {
  if (!session || !booking) return 'unknown booking';
  const bookingId = session.metadata?.bookingId || booking.id;
  if (session.metadata?.bookingId && session.metadata.bookingId !== booking.id) return 'booking mismatch';
  if (session.client_reference_id && session.client_reference_id !== bookingId) return 'client_reference_id mismatch';
  if (!session.id || booking.stripeSessionId !== session.id) return 'session mismatch';
  const expected = Math.round(Number(booking.amount || 0) * 100);
  if (session.amount_total == null || Number(session.amount_total) !== expected) return 'amount mismatch';
  const currency = String(session.currency || '').toLowerCase();
  if (currency !== 'usd') return 'currency mismatch';
  return null;
}
function chargeFromSession(session = {}) {
  const pi = session.payment_intent;
  if (pi && typeof pi === 'object') {
    const latest = pi.latest_charge;
    const charge = latest && typeof latest === 'object' ? latest : null;
    return {
      paymentIntentId: pi.id || null,
      chargeId: typeof latest === 'string' ? latest : charge?.id || null,
      cardFingerprint: charge?.payment_method_details?.card?.fingerprint || pi.payment_method?.card?.fingerprint || null,
    };
  }
  return {
    paymentIntentId: typeof pi === 'string' ? pi : null,
    chargeId: typeof session.latest_charge === 'string' ? session.latest_charge : null,
    cardFingerprint: null,
  };
}

function createHeld(booking, payment = {}) {
  bucket();
  let d = findByBooking(booking.id);
  if (d && ['held', 'scheduled', 'paused', 'disputed', 'released', 'refunded', 'releasing', 'refunding'].includes(d.status) && d.paid) return d;
  const amountCents = Math.round(Number(booking.amount || 0) * 100);
  const fee = platformFeeCents(amountCents);
  // Only an account that can actually be paid. Never the unverified env fallback id.
  const acct = payoutAccount();
  const stripeMode = stripeModeOf(payment);
  const livemode = payment.livemode === true || (payment.livemode !== false && stripeMode === 'live');
  const email = booking.email || payment.email || null;
  const cardFingerprint = payment.cardFingerprint || booking.cardFingerprint || null;
  if (!d) {
    d = {
      id: crypto.randomBytes(6).toString('hex'),
      bookingId: booking.id,
      phone: booking.phone,
      email,
      cardFingerprint,
      shopName: env.BUSINESS_NAME || 'Shop',
      amountCents,
      currency: 'usd',
      stripeMode,
      livemode: !!livemode,
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
      plannedTransferCents: null,
      paymentIntentId: payment.paymentIntentId || booking.stripePaymentIntentId || null,
      chargeId: payment.chargeId || booking.stripeChargeId || null,
      stripeSessionId: payment.sessionId || booking.stripeSessionId || null,
      transferId: null,
      refundId: null,
      transferReversalId: null,
      refundedCents: 0,
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
      stripeMode: d.stripeMode || stripeMode, livemode: d.livemode === true || !!livemode,
      email: d.email || email, cardFingerprint: d.cardFingerprint || cardFingerprint,
      releaseAt: d.releaseAt || releaseAtFor(booking),
      noshowCheckAt: d.noshowCheckAt || noshowAtFor(booking),
      connectAccountId: acct || null,
      payoutPendingConnect: !acct,
      paymentIntentId: payment.paymentIntentId || d.paymentIntentId,
      chargeId: payment.chargeId || d.chargeId,
      stripeSessionId: payment.sessionId || d.stripeSessionId,
      updatedAt: iso(),
    });
    if (d.connectAccountId && d.stripeMode && d.stripeMode !== stripeMode) d.connectAccountId = null;
  }
  if (d.status === 'held') d.status = 'scheduled';
  recordEvent('held', d.id, { bookingId: booking.id, amountCents, stripeMode: d.stripeMode });
  store.save();
  indexPayment(d);
  return d;
}

// After mock/live payment marks a booking paid.
function onBookingPaid(booking, payment) {
  if (!booking || !(Number(booking.amount) > 0)) return null;
  return createHeld(booking, payment || {});
}

function restoreLease(d) {
  if (d.status === 'releasing' || d.status === 'refunding') d.status = d.statusBeforeLease || 'scheduled';
  d.updatedAt = iso();
  store.save();
}
async function releaseDeposit(d, { force = false, by = 'admin' } = {}) {
  if (!d || d.archived) return { ok: false, reason: d && d.archived ? 'archived' : 'not_found' };
  if (d.status === 'refunded' || d.status === 'refunding') return { ok: false, reason: d.status === 'refunding' ? 'refunding' : 'refunded' };
  if (d.status === 'released' && d.transferId) return { ok: true, already: true, deposit: d };
  if (d.status === 'releasing') return { ok: false, reason: 'releasing' };
  if ((d.status === 'paused' || d.status === 'disputed') && !force) return { ok: false, reason: d.status };
  if (!force && Date.parse(d.releaseAt) > now()) return { ok: false, reason: 'too_early' };
  if (!modeOk(d)) return { ok: false, reason: 'mode_mismatch' };
  const prior = d.status;
  if (!casStatus(d, [prior], 'releasing')) return { ok: false, reason: 'busy' };

  const abort = async (reason) => {
    if (d.refundRequested) {
      d.refundRequested = false;
      d.status = prior === 'released' ? 'scheduled' : prior;
      store.save();
      return refundDeposit(d, { reason: 'admin_during_release' });
    }
    restoreLease(d);
    if (prior === 'paused' || prior === 'disputed') d.payoutPaused = true;
    store.save();
    return { ok: false, reason };
  };

  // Let a concurrent refund set refundRequested before any money moves.
  await Promise.resolve();
  if (!still(d, 'releasing')) return { ok: false, reason: 'aborted' };
  if (d.refundRequested) return abort('refund_requested');

  const acct = payoutAccount();
  // No payable account (charges off, unverified env fallback, or a new account waiting on admin approval).
  // Do not copy an account id onto the deposit from the environment.
  if (!acct || (d.connectAccountId && d.connectAccountId !== acct)) {
    d.payoutPendingConnect = true;
    return abort('not_connected');
  }
  d.connectAccountId = acct;

  let payoutCents = Math.max(0, (d.vendorAmountCents || 0) - (d.refundedCents ? Math.round((d.refundedCents * (d.vendorAmountCents || 0)) / (d.amountCents || 1)) : 0));
  const debt = vendorDebt(acct);
  const applied = Math.min(debt, payoutCents);
  payoutCents -= applied;
  // Persist the plan BEFORE the first attempt. The key includes the amount so a later
  // different amount cannot reuse dep-release-<booking>.
  d.plannedTransferCents = payoutCents;
  d.plannedDebtCents = applied;
  d.releaseIdempotencyKey = `dep-release-${d.bookingId}-${payoutCents}`;
  d.updatedAt = iso();
  store.save();

  if (payoutCents <= 0) {
    if (d.refundRequested || !still(d, 'releasing')) return abort('aborted');
    if (applied) {
      setVendorDebt(acct, vendorDebt(acct) - Math.min(applied, vendorDebt(acct)));
      d.vendorDebtAppliedCents = (d.vendorDebtAppliedCents || 0) + applied;
    }
    d.status = 'released';
    d.releasedAt = iso();
    d.transferId = d.transferId || `zero_${d.id}`;
    d.payoutPaused = false;
    d.updatedAt = iso();
    if (d.dispute) require('./disputes').markResolved(d, 'vendor', by);
    recordEvent('released_zero', d.id, { appliedDebt: applied });
    store.save();
    return { ok: true, deposit: d, zero: true };
  }

  if (cfg().live) {
    if (!d.chargeId) return abort('missing_charge');
    let transfer;
    try {
      transfer = await connect.stripe().transfers.create({
        amount: payoutCents,
        currency: d.currency || 'usd',
        destination: acct,
        source_transaction: d.chargeId,
        transfer_group: d.bookingId,
        metadata: { depositId: d.id, bookingId: d.bookingId, platformFeeCents: String(d.platformFeeCents || 0) },
      }, { idempotencyKey: d.releaseIdempotencyKey });
    } catch (e) {
      console.error('[deposits] transfer failed:', e.message);
      return abort('transfer_failed');
    }
    if (d.refundRequested || !still(d, 'releasing')) {
      try {
        const rev = await connect.stripe().transfers.createReversal(transfer.id, { metadata: { depositId: d.id, reason: 'aborted' } },
          { idempotencyKey: `${d.releaseIdempotencyKey}-abort` });
        d.transferReversalId = rev.id;
      } catch (e) {
        console.error('[deposits] abort reversal failed; recording vendor_debt:', e.message);
        addVendorDebt(acct, payoutCents);
      }
      d.transferId = transfer.id;
      if (d.refundRequested) {
        d.refundRequested = false;
        d.status = 'released';
        store.save();
        return refundDeposit(d, { reason: 'admin_during_release' });
      }
      return abort('aborted');
    }
    d.transferId = transfer.id;
  } else {
    if (d.refundRequested || !still(d, 'releasing')) return abort('aborted');
    d.transferId = d.transferId || mid('tr');
  }
  if (applied) {
    const debtNow = vendorDebt(acct);
    const take = Math.min(applied, debtNow);
    if (take) setVendorDebt(acct, debtNow - take);
    d.vendorDebtAppliedCents = (d.vendorDebtAppliedCents || 0) + take;
  }
  d.status = 'released';
  d.releasedAt = iso();
  d.payoutPaused = false;
  d.updatedAt = iso();
  if (force && d.dispute) require('./disputes').markResolved(d, 'vendor', by);
  recordEvent('released', d.id, { transferId: d.transferId, payoutCents, appliedDebt: applied, by });
  store.save();
  return { ok: true, deposit: d };
}

async function refundDeposit(d, { reason = 'admin', amountCents = null } = {}) {
  if (!d) return { ok: false, reason: 'not_found' };
  if (d.archived) return { ok: false, reason: 'archived' };
  if (d.status === 'refunded') return { ok: true, already: true, deposit: d };
  if (d.status === 'releasing') {
    d.refundRequested = true;
    d.updatedAt = iso();
    store.save();
    return { ok: false, reason: 'release_in_progress', queued: true, deposit: d };
  }
  if (d.status === 'refunding') return { ok: false, reason: 'refunding' };
  if (!modeOk(d) && d.stripeMode && d.stripeMode !== connect.mode()) return { ok: false, reason: 'mode_mismatch' };
  const prior = d.status;
  if (!casStatus(d, [prior], 'refunding')) return { ok: false, reason: 'busy' };
  if (d.dispute && !d.dispute.resolution) require('./disputes').markResolved(d, 'customer', reason);

  const total = d.amountCents || 0;
  const already = d.refundedCents || 0;
  const requested = amountCents == null ? Math.max(0, total - already) : Math.max(0, Math.round(amountCents));
  const refundCents = Math.min(requested, Math.max(0, total - already));
  const partial = total > 0 && already + refundCents < total;

  await Promise.resolve();
  if (!still(d, 'refunding')) return { ok: false, reason: 'aborted' };

  if (d.transferId && prior === 'released' && !String(d.transferId).startsWith('zero_')) {
    const vendorShare = Math.max(0, (d.vendorAmountCents || 0) - (d.vendorDebtAppliedCents || 0) - (d.reversedCents || 0));
    const portion = total > 0 ? Math.min(vendorShare, Math.round(refundCents * (d.vendorAmountCents || 0) / total)) : vendorShare;
    if (portion > 0) {
      if (cfg().live) {
        try {
          const rev = await connect.stripe().transfers.createReversal(d.transferId, {
            amount: portion, metadata: { depositId: d.id, reason },
          }, { idempotencyKey: `${d.refundIdempotencyKey}-rev-${already + refundCents}` });
          d.transferReversalId = rev.id;
          d.reversedCents = (d.reversedCents || 0) + portion;
        } catch (e) {
          console.error('[deposits] transfer reversal failed; recording vendor_debt:', e.message);
          addVendorDebt(d.connectAccountId, portion);
          d.vendorDebtRecordedCents = (d.vendorDebtRecordedCents || 0) + portion;
        }
      } else {
        d.transferReversalId = d.transferReversalId || mid('trr');
        d.reversedCents = (d.reversedCents || 0) + portion;
      }
    }
  } else if (prior === 'released' && String(d.transferId || '').startsWith('zero_') && (d.vendorDebtAppliedCents || 0) > 0) {
    const portion = total > 0 ? Math.round(refundCents * d.vendorDebtAppliedCents / total) : d.vendorDebtAppliedCents;
    if (portion > 0) addVendorDebt(d.connectAccountId, portion);
  }
  if (!still(d, 'refunding')) return { ok: false, reason: 'aborted' };

  if (refundCents > 0) {
    if (cfg().live) {
      const body = { amount: refundCents, metadata: { depositId: d.id, bookingId: d.bookingId, reason } };
      const key = { idempotencyKey: `${d.refundIdempotencyKey}-${already + refundCents}` };
      if (d.paymentIntentId) d.refundId = (await connect.stripe().refunds.create({ ...body, payment_intent: d.paymentIntentId }, key)).id;
      else if (d.chargeId) d.refundId = (await connect.stripe().refunds.create({ ...body, charge: d.chargeId }, key)).id;
      else d.refundId = d.refundId || mid('re');
    } else {
      d.refundId = d.refundId || mid('re');
    }
  }
  d.refundedCents = already + refundCents;
  if (partial) {
    d.status = prior === 'refunding' ? 'scheduled' : prior;
    if (d.status === 'releasing') d.status = 'scheduled';
    d.partialRefund = true;
    d.updatedAt = iso();
    recordEvent('partial_refund', d.id, { reason, refundedCents: d.refundedCents });
    store.save();
    return { ok: true, deposit: d, partial: true };
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
  const word = replyWord(body);
  if (word === 'yes' || letters === 'YES') {
    d.noshowReply = 'yes';
    d.updatedAt = iso();
    recordEvent('noshow_yes', d.id);
    store.save();
    return { deposit: d, answer: 'yes', reply: null };
  }
  // Exact NO or NOSHOW only. "No problem", "No worries" and "no-show" stay in the conversation.
  if (word === 'no' || word === 'noshow') {
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
    const text = `Did ${shop} show up for your appointment? Reply YES or NO. Reply NOSHOW to confirm they did not.`;
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
    if (d.archived || !modeOk(d)) continue;
    if (!['held', 'scheduled'].includes(d.status)) continue;
    if (d.payoutPaused) continue;
    if (Date.parse(d.releaseAt) > now()) continue;
    out.push(await releaseDeposit(d));
  }
  return out;
}

// Cutover: archive test/mock deposit rows so they can never be released on a live key.
function archiveNonLive({ reason = 'non_live_cutover' } = {}) {
  let archived = 0;
  for (const d of bucket().deposits) {
    if (d.archived) continue;
    if (d.stripeMode === 'live' && d.livemode === true) continue;
    d.archived = true;
    d.archivedAt = iso();
    d.archivedReason = reason;
    d.updatedAt = iso();
    archived++;
  }
  if (archived) store.save();
  recordEvent('archive_non_live', null, { archived });
  store.save();
  return { archived };
}

function attachPayable() {
  const id = payoutAccount();
  if (!id) return 0;
  let n = 0;
  for (const d of bucket().deposits) {
    if (d.archived || !modeOk(d)) continue;
    if (!['held', 'scheduled', 'paused', 'disputed'].includes(d.status)) continue;
    if (d.connectAccountId && d.connectAccountId !== id) continue;
    if (!d.connectAccountId || d.payoutPendingConnect) {
      d.connectAccountId = id;
      d.payoutPendingConnect = false;
      d.updatedAt = iso();
      n++;
    }
  }
  if (n) store.save();
  return n;
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

async function applyExternalRefund(d, refundedCents, { reason = 'webhook' } = {}) {
  if (!d) return false;
  if (d.stripeMode && d.stripeMode !== connect.mode()) {
    recordEvent('refund_mode_mismatch', d.id, { stripeMode: d.stripeMode, keyMode: connect.mode() });
    store.save();
    return false;
  }
  const next = Math.max(d.refundedCents || 0, Math.round(Number(refundedCents) || 0));
  const delta = next - (d.refundedCents || 0);
  if (delta <= 0) return true;
  const total = d.amountCents || next;
  const full = next >= total;
  if (d.status === 'released' && delta > 0) {
    const portion = total > 0 ? Math.round(delta * (d.vendorAmountCents || 0) / total) : delta;
    if (d.transferId && !String(d.transferId).startsWith('zero_') && portion > 0) {
      if (cfg().live) {
        try {
          const rev = await connect.stripe().transfers.createReversal(d.transferId, {
            amount: portion, metadata: { depositId: d.id, reason },
          }, { idempotencyKey: `${d.refundIdempotencyKey || `dep-refund-${d.bookingId}`}-wh-${next}` });
          d.transferReversalId = rev.id;
          d.reversedCents = (d.reversedCents || 0) + portion;
        } catch (e) {
          console.error('[deposits] webhook reversal failed; recording vendor_debt:', e.message);
          addVendorDebt(d.connectAccountId, portion);
        }
      } else {
        d.transferReversalId = d.transferReversalId || mid('trr');
        d.reversedCents = (d.reversedCents || 0) + portion;
      }
    } else if (String(d.transferId || '').startsWith('zero_') && portion > 0) {
      addVendorDebt(d.connectAccountId, Math.min(portion, d.vendorDebtAppliedCents || portion));
    }
  }
  d.refundedCents = next;
  if (full) {
    d.status = 'refunded';
    d.refundedAt = iso();
    d.payoutPaused = false;
    recordEvent('refunded_webhook', d.id, { refundedCents: next });
  } else {
    d.partialRefund = true;
    recordEvent('partial_refund', d.id, { refundedCents: next });
  }
  d.updatedAt = iso();
  store.save();
  return true;
}

async function onCardDispute(d, dispute, { closed = false } = {}) {
  if (!d || !dispute) return false;
  d.cardDispute = {
    id: dispute.id || null, amount: dispute.amount || null, currency: dispute.currency || d.currency,
    reason: dispute.reason || null, status: dispute.status || (closed ? 'closed' : 'needs_response'),
    closed: !!closed, at: iso(),
  };
  const shop = d.shopName || env.BUSINESS_NAME || 'Shop';
  if (!closed && d.status !== 'refunded') {
    if (d.status !== 'released') {
      if (!['releasing', 'refunding'].includes(d.status)) {
        d.status = 'disputed';
        d.payoutPaused = true;
        d.disputedAt = d.disputedAt || iso();
      } else d.refundRequested = true;
    } else {
      const portion = dispute.amount || d.vendorAmountCents || d.amountCents;
      if (d.transferId && !String(d.transferId).startsWith('zero_')) {
        if (cfg().live) {
          try {
            const rev = await connect.stripe().transfers.createReversal(d.transferId, {
              amount: Math.min(portion, d.vendorAmountCents || portion),
              metadata: { depositId: d.id, reason: 'dispute' },
            }, { idempotencyKey: `${d.refundIdempotencyKey}-dispute-${dispute.id || d.id}` });
            d.transferReversalId = rev.id;
          } catch (e) {
            addVendorDebt(d.connectAccountId, Math.min(portion, d.vendorAmountCents || portion));
          }
        } else {
          d.transferReversalId = d.transferReversalId || mid('trr');
        }
      } else addVendorDebt(d.connectAccountId, Math.min(portion, d.vendorAmountCents || portion));
      d.payoutPaused = true;
    }
    const booking = store.findBooking(d.bookingId);
    let text = '';
    try { text = require('./disputes').evidenceText(d, booking, { shop }); } catch { text = `Deposit ${d.id} booking ${d.bookingId}`; }
    d.cardDispute.evidencePrepared = true;
    if (cfg().live && dispute.id && connect.stripe().disputes?.update) {
      try {
        await connect.stripe().disputes.update(dispute.id, { evidence: { uncategorized_text: String(text).slice(0, 150000) }, submit: false });
        d.cardDispute.evidenceAttached = true;
      } catch (e) {
        console.error('[deposits] dispute evidence failed:', e.message);
        d.cardDispute.evidenceAttached = false;
      }
    }
    await alertAdmin(`BUZZ ${shop}: card dispute ${dispute.id || ''} on booking ${d.bookingId} ($${(d.amountCents / 100).toFixed(2)}). ${d.status === 'released' ? 'Transfer reversed or vendor debt recorded.' : 'Payout paused.'} Customer ${sec.maskPhone(d.phone || '')}.`, 'BuzzCall: card dispute');
  } else {
    await alertAdmin(`BUZZ ${shop}: card dispute ${dispute.id || ''} ${dispute.status || 'closed'} on booking ${d.bookingId}.`, 'BuzzCall: dispute closed');
  }
  d.updatedAt = iso();
  recordEvent(closed ? 'dispute_closed' : 'dispute_created', d.id, { disputeId: dispute.id, status: dispute.status });
  store.save();
  return true;
}

async function handleWebhookEvent(event) {
  if (!event || !event.type) return false;
  const o = event.data?.object || {};
  if (process.env.STRIPE_SECRET_KEY && typeof event.livemode === 'boolean' && !!event.livemode !== (connect.mode() === 'live')) {
    return false;
  }
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (o.mode && o.mode !== 'payment') return false;
      return true; // server.js validates the session and calls onPaid
    }
    case 'charge.refunded': {
      const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
      const d = findByPaymentIntent(pi) || bucket().deposits.find((x) => x.chargeId === o.id);
      if (!d) return false;
      const refunded = o.amount_refunded != null ? o.amount_refunded : (o.refunded ? (d.amountCents || o.amount) : 0);
      await applyExternalRefund(d, refunded, { reason: 'charge.refunded' });
      return true;
    }
    case 'charge.refund.updated': {
      if (o.status && o.status !== 'succeeded') {
        recordEvent('refund_updated', null, { refundId: o.id, status: o.status });
        store.save();
        await alertAdmin(`BUZZ refund ${o.id || ''} is ${o.status}.`, 'BuzzCall: refund update');
        return true;
      }
      const chargeId = typeof o.charge === 'string' ? o.charge : o.charge?.id;
      const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
      const d = findByPaymentIntent(pi) || bucket().deposits.find((x) => x.chargeId === chargeId);
      if (!d) return false;
      const next = (d.refundedCents || 0) + (Number(o.amount) || 0);
      await applyExternalRefund(d, next, { reason: 'charge.refund.updated' });
      return true;
    }
    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      const chargeId = typeof o.charge === 'string' ? o.charge : o.charge?.id;
      const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
      const d = findByPaymentIntent(pi) || bucket().deposits.find((x) => x.chargeId === chargeId);
      if (!d) return false;
      await onCardDispute(d, o, { closed: event.type === 'charge.dispute.closed' });
      return true;
    }
    case 'radar.early_fraud_warning.created': {
      const chargeId = typeof o.charge === 'string' ? o.charge : o.charge?.id;
      const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
      const d = findByPaymentIntent(pi) || bucket().deposits.find((x) => x.chargeId === chargeId);
      if (!d) return false;
      d.fraudWarning = { id: o.id || null, fraudType: o.fraud_type || null, actionable: o.actionable !== false, at: iso() };
      d.payoutPaused = true;
      d.updatedAt = iso();
      store.save();
      await alertAdmin(`BUZZ early fraud warning ${o.id || ''} on booking ${d.bookingId}. Deposit refund started and payout held. Customer ${sec.maskPhone(d.phone || '')}.`, 'BuzzCall: fraud warning');
      if (d.status !== 'refunded') await refundDeposit(d, { reason: 'early_fraud_warning' });
      return true;
    }
    case 'payout.failed': {
      recordEvent('payout_failed', null, { payoutId: o.id || null, failureCode: o.failure_code || null });
      store.save();
      await alertAdmin(`BUZZ payout failed ${o.id || ''} (${o.failure_code || 'no code'}). Check Stripe before retrying vendor payouts.`, 'BuzzCall: payout failed');
      return true;
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
      // Attach only when the account is actually payable (charges on, and admin-approved
      // if this app created it). Never stamp an unverified env fallback onto a deposit.
      attachPayable();
      return true;
    default:
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
    return { ...d, booking, customerFlag: d.dispute || d.noshowReply === 'no' || d.cardDispute ? disputes.flagFor(d.phone, { email: d.email, fingerprint: d.cardFingerprint }) : null,
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
    newVendorHoldDays: shopContext.current() ? num(process.env.NEW_VENDOR_HOLD_DAYS, 7) : 0,
    newVendorHoldJobs: Math.floor(num(process.env.NEW_VENDOR_HOLD_JOBS, 5)),
    cardDisputes: rows.filter((d) => d.cardDispute && !d.cardDispute.closed).length,
    fraudWarnings: rows.filter((d) => d.fraudWarning).length,
    deposits: view,
  };
}

module.exports = {
  cfg, now, list, find, findByBooking, findByPaymentIntent, vendorDebt, setVendorDebt, addVendorDebt,
  platformFeeCents, appointmentMs, releaseAtFor, noshowAtFor, nextAllowedSend, hasSmsConsent,
  createHeld, onBookingPaid, releaseDeposit, refundDeposit, pauseForNoshow,
  pendingNoshow, handleNoshowReply, sendDueNoshowChecks, processDueReleases, tick, mockAdvance,
  handleWebhookEvent, summary, money, sessionProblem, chargeFromSession, stripeModeOf, modeOk,
  velocityBlock, archiveNonLive, attachPayable, lookupPayment, indexPayment, replyWord, setAlert,
};
