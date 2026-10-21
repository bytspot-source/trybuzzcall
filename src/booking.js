// Optional booking + deposit. Slots computed in server-local time (set BUSINESS_TZ, applied as TZ at startup).
const crypto = require('crypto');
const store = require('./store');
const env = process.env;
const on = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
// Vertical: 'home_services' (plumber/HVAC, default) or 'braiders' (service menu, variable-length appointments).
const vertical = () => {
  const v = String(env.VERTICAL || '').trim().toLowerCase();
  if (/^braid/.test(v) || (!v && /^braid/i.test(env.BUSINESS_VERTICAL || ''))) return 'braiders';
  return 'home_services';
};
const DEFAULT_SERVICES = 'Knotless braids:360,Box braids:300,Locs retwist:120,Twists:180';
// SERVICES="Name:minutes,Name:minutes" -> [{ name, minutes }]
function parseServices(str) {
  return String(str || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.lastIndexOf(':');
    const name = (i > 0 ? x.slice(0, i) : x).trim(), minutes = Number(i > 0 ? x.slice(i + 1) : NaN);
    return { name, minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 120 };
  }).filter((s) => s.name);
}
const num = (v, d) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const cfg = () => {
  const braid = vertical() === 'braiders';
  const [o, c] = (env.BUSINESS_HOURS || (braid ? '09:00-19:00' : '08:00-17:00')).split('-');
  const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };
  const slotMin = Number(env.SLOT_MINUTES || 120);
  return {
    vertical: vertical(), braiders: braid,
    booking: on(env.BOOKING_ENABLED), deposit: on(env.DEPOSIT_ENABLED),
    slotMin, open: hm(o), close: hm(c),
    // Start-time grid: home_services = SLOT_MINUTES blocks; braiders = SLOT_STEP_MINUTES (default 60) start times.
    stepMin: braid ? Number(env.SLOT_STEP_MINUTES || 60) : slotMin,
    services: braid ? parseServices(env.SERVICES || DEFAULT_SERVICES) : [],
    bookingLink: (env.BOOKING_LINK || '').trim() || null,
    days: (env.BUSINESS_DAYS || (braid ? '1,2,3,4,5,6' : '1,2,3,4,5')).split(',').map(Number),
    leadMin: Number(env.BOOKING_LEAD_MINUTES || 60), holdMin: Number(env.HOLD_MINUTES || 30),
    amount: num(env.DEPOSIT_AMOUNT, braid ? 50 : 49),
    // Per-paid-lead fee (USD) charged to the shop only when a caller books AND pays the deposit.
    leadFee: num(env.LEAD_FEE, braid ? 5 : 12),
    leadFeeWaived: on(env.LEAD_FEE_WAIVED), // e.g. during the free pilot: fee is recorded as 'waived', nothing charged
    connectAccount: (env.STRIPE_CONNECT_ACCOUNT_ID || '').trim() || null, // shop's Stripe Connect account (acct_...)
  };
};

function expireHolds() {
  const now = Date.now(); let n = 0;
  for (const b of store.db.bookings) if (b.status === 'held' && Date.parse(b.holdExpiresAt) < now) { b.status = 'expired'; n++; }
  if (n) store.save();
  return n;
}
// A slot is taken if it overlaps any held (unexpired) or confirmed booking. Old bookings without slotEnd
// are treated as SLOT_MINUTES long. For home_services (fixed grid) this is the same as "same start".
const endOf = (b) => (b.slotEnd ? Date.parse(b.slotEnd) : Date.parse(b.slotStart) + cfg().slotMin * 60000);
const overlaps = (b, start, end) => Date.parse(b.slotStart) < end && start < endOf(b);
const isTaken = (start, end, exceptId) => {
  expireHolds();
  const s = Date.parse(start), e = end ? Date.parse(end) : s + cfg().slotMin * 60000;
  return store.db.bookings.some((b) => b.id !== exceptId && ['held', 'confirmed'].includes(b.status) && overlaps(b, s, e));
};

// Next `count` open start times. opts.minutes = appointment length (default SLOT_MINUTES);
// opts.from = Date: don't offer anything before that day (e.g. the caller's preferred day).
function nextSlots(count = 3, opts = {}) {
  const c = cfg(), out = [];
  const dur = opts.minutes || c.slotMin, step = opts.minutes ? c.stepMin : c.slotMin;
  const t = new Date(Date.now() + c.leadMin * 60000);
  const d = new Date(opts.from && opts.from > t ? opts.from : t); d.setHours(0, 0, 0, 0);
  for (let day = 0; day < 21 && out.length < count; day++, d.setDate(d.getDate() + 1)) {
    if (!c.days.includes(d.getDay())) continue;
    for (let m = c.open; m + dur <= c.close && out.length < count; m += step) {
      const s = new Date(d); s.setMinutes(m);
      const e = new Date(s.getTime() + dur * 60000);
      if (s < t || isTaken(s.toISOString(), e.toISOString())) continue;
      out.push({ start: s.toISOString(), end: e.toISOString(), minutes: dur, label: label(s, dur) });
    }
  }
  return out;
}
const tm = (x) => x.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayLabel = (s) => s.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
function label(s, dur) {
  const e = new Date(s.getTime() + (dur || cfg().slotMin) * 60000);
  if (cfg().braiders) return `${dayLabel(s)}, ${tm(s)} (done ~${tm(e)})`;
  return `${dayLabel(s)} ${tm(s)}-${tm(e)}`;
}

// Returns booking or null if slot was taken in the meantime (double-booking guard).
function hold(lead, slot) {
  const c = cfg();
  const end = slot.end || new Date(Date.parse(slot.start) + c.slotMin * 60000).toISOString();
  if (isTaken(slot.start, end)) return null;
  const b = { id: crypto.randomBytes(6).toString('hex'), leadId: lead.id, phone: lead.phone, name: lead.name, need: lead.need,
    ...(lead.service ? { service: lead.service, details: lead.details || null } : {}),
    slotStart: slot.start, slotEnd: end, slotLabel: slot.label, status: c.deposit ? 'held' : 'confirmed', paid: false,
    amount: c.deposit ? c.amount : 0, holdExpiresAt: new Date(Date.now() + c.holdMin * 60000).toISOString(),
    createdAt: new Date().toISOString() };
  store.db.bookings.unshift(b); store.save(); return b;
}

// Stripe Connect destination charge: the deposit goes to the shop's connected account and the
// per-paid-lead fee is kept by the platform as the application fee. Fee is capped at the deposit.
function connectParams(b) {
  const c = cfg();
  if (!c.connectAccount) return {};
  const feeCents = c.leadFeeWaived ? 0 : Math.min(Math.round(c.leadFee * 100), Math.round(b.amount * 100));
  b.connectAccount = c.connectAccount; b.applicationFeeCents = feeCents;
  return { payment_intent_data: { transfer_data: { destination: c.connectAccount },
    ...(feeCents > 0 ? { application_fee_amount: feeCents } : {}), metadata: { bookingId: b.id } } };
}

// Records the lead fee on a paid booking (once). Status:
//   'collected' = taken as Stripe Connect application fee; 'due' = to be invoiced monthly;
//   'waived' = LEAD_FEE_WAIVED (pilot); 'review' = paid but slot lost (refund deposit and fee).
function recordLeadFee(b, conflict) {
  if (b.lead_fee_status) return b;
  const c = cfg();
  const viaConnect = !!b.connectAccount;
  const fee = viaConnect && b.applicationFeeCents != null ? b.applicationFeeCents / 100 : c.leadFee;
  b.lead_fee = c.leadFeeWaived ? 0 : fee;
  b.lead_fee_status = c.leadFeeWaived ? 'waived' : conflict ? 'review' : viaConnect ? 'collected' : 'due';
  b.lead_fee_at = new Date().toISOString();
  return b;
}

function leadFeeTotals() {
  const t = { due: 0, collected: 0, waived: 0, review: 0, count: 0 };
  for (const b of store.db.bookings || []) {
    if (!b.lead_fee_status) continue;
    t.count++;
    if (b.lead_fee_status === 'waived') t.waived += cfg().leadFee; else t[b.lead_fee_status] = (t[b.lead_fee_status] || 0) + (b.lead_fee || 0);
  }
  t.total = t.due + t.collected;
  return t;
}

async function depositLink(b, BASE) {
  if (env.STRIPE_SECRET_KEY) {
    const stripe = require('stripe')(env.STRIPE_SECRET_KEY);
    const s = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(b.amount * 100),
        product_data: { name: b.service ? `Deposit: ${b.service} with ${env.BUSINESS_NAME || 'your stylist'}, ${b.slotLabel}` : `Deposit: ${env.BUSINESS_NAME || 'service'} visit ${b.slotLabel}` } } }],
      metadata: { bookingId: b.id }, client_reference_id: b.id,
      expires_at: Math.floor(Date.now() / 1000) + Math.max(cfg().holdMin, 30) * 60, // Stripe min 30 min
      success_url: `${BASE}/?deposit=success`, cancel_url: `${BASE}/?deposit=cancel`,
      ...connectParams(b),
    });
    b.stripeSessionId = s.id; b.payUrl = s.url;
  } else b.payUrl = `${BASE}/pay/mock/${b.id}`;
  store.save(); return b.payUrl;
}

// Marks paid+confirmed. Returns {booking, changed}. Refuses if hold expired and slot taken by someone else.
function markPaid(id) {
  const b = store.db.bookings.find((x) => x.id === id);
  if (!b) return { booking: null };
  if (b.paid) return { booking: b, changed: false };
  if (b.status === 'expired' || (b.status === 'held' && Date.parse(b.holdExpiresAt) < Date.now())) {
    const clash = isTaken(b.slotStart, new Date(endOf(b)).toISOString(), b.id);
    if (clash) { b.paid = true; b.status = 'paid_conflict'; recordLeadFee(b, true); store.save(); return { booking: b, changed: true, conflict: true }; }
  }
  b.paid = true; b.status = 'confirmed'; b.paidAt = new Date().toISOString(); recordLeadFee(b); store.save();
  return { booking: b, changed: true };
}

module.exports = { cfg, vertical, parseServices, nextSlots, hold, depositLink, markPaid, expireHolds, leadFeeTotals, connectParams };
