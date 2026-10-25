'use strict';
// Transactional email through Resend's HTTP API (https://api.resend.com/emails).
// - RESEND_API_KEY missing: a masked "email skipped" line is logged and nothing is sent. Forms never fail because of email.
// - Sends are fire-and-forget (queue() never throws or blocks the request) with a timeout (EMAIL_TIMEOUT_MS, default 8000).
// - Logs never contain the API key or a full address (maskEmail), and never the message body.
// - Per-recipient throttle: at most one message of a kind per address per 24h (EMAIL_RECIPIENT_WINDOW_HOURS), persisted
//   as SHA-256 hashes in the platform store so restarts don't reset it; admin alerts are additionally capped per hour
//   (ADMIN_ALERT_MAX_PER_HOUR, default 30). The public forms keep their own per-IP rate limits on top.
// - Bodies sent to the person who submitted a form never include other text they typed, so a form can't be used to
//   send someone an arbitrary message.
const crypto = require('crypto');
const store = require('./store');
const shopContext = require('./shopContext');
const { limiter, num } = require('./security');

const RESEND_URL = 'https://api.resend.com/emails';
const SETUP_URL = 'https://trybuzzcall.com/setup';
const DEFAULT_FROM = 'BuzzCall <hello@trybuzzcall.com>';
const DEFAULT_ADMIN = 'kojo@bytspot.com';
const validEmail = (v) => typeof v === 'string' && v.length <= 254 && /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/.test(v);
const from = () => (process.env.EMAIL_FROM || '').trim() || DEFAULT_FROM;
const adminTo = () => { const a = (process.env.ADMIN_ALERT_EMAIL || '').trim().toLowerCase(); return validEmail(a) ? a : DEFAULT_ADMIN; };
const windowMs = () => num(process.env.EMAIL_RECIPIENT_WINDOW_HOURS, 24) * 3600000;
const timeoutMs = () => (Number(process.env.EMAIL_TIMEOUT_MS) > 0 ? Number(process.env.EMAIL_TIMEOUT_MS) : 8000);

// "kojo@bytspot.com" -> "k***@b***.com"
function maskEmail(value) {
  const s = String(value || ''), at = s.lastIndexOf('@');
  if (at < 1) return '***';
  const domain = s.slice(at + 1), dot = domain.lastIndexOf('.');
  return `${s[0]}***@${domain[0] || ''}***${dot > 0 ? domain.slice(dot) : ''}`;
}
const oneLine = (v, max = 120) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, max);

let fetchImpl = (...args) => fetch(...args);
const setFetch = (fn) => { fetchImpl = fn || ((...args) => fetch(...args)); };
const inFlight = new Set();
let adminHourly = null, adminHourlyMax = null;
const adminLimiter = () => {
  const max = num(process.env.ADMIN_ALERT_MAX_PER_HOUR, 30);
  if (!adminHourly || adminHourlyMax !== max) { adminHourly = limiter({ windowMs: 3600000, max }); adminHourlyMax = max; }
  return adminHourly;
};

// Persisted per-recipient throttle in the platform (root) store.
function claim(kind, address) {
  const root = store.root, now = Date.now(), win = windowMs();
  const log = (root.db.emailThrottle ||= {});
  for (const [k, at] of Object.entries(log)) if (now - at > win) delete log[k];
  const key = crypto.createHash('sha256').update(`${kind}:${address}`).digest('hex');
  if (log[key] && now - log[key] <= win) return false;
  const keys = Object.keys(log);
  if (keys.length >= 20000) delete log[keys.sort((a, b) => log[a] - log[b])[0]];
  log[key] = now; root.save();
  return true;
}

async function deliver({ to, subject, text, kind }) {
  const key = process.env.RESEND_API_KEY || '';
  if (!key) { console.log(`[email] skipped (RESEND_API_KEY not set): ${kind} to ${maskEmail(to)}`); return { ok: false, skipped: 'not_configured' }; }
  try {
    const r = await fetchImpl(RESEND_URL, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs()),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from(), to: [to], subject, text }),
    });
    if (!r || !r.ok) { console.error(`[email] ${kind} to ${maskEmail(to)} failed: HTTP ${r ? r.status : 'none'}`); return { ok: false, status: r ? r.status : null }; }
    console.log(`[email] ${kind} sent to ${maskEmail(to)}`);
    return { ok: true };
  } catch (e) {
    console.error(`[email] ${kind} to ${maskEmail(to)} failed: ${e && e.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
    return { ok: false, error: 'failed' };
  }
}

// Fire-and-forget. Always runs outside any vendor context (platform mail), never throws.
function queue(message) {
  const p = Promise.resolve().then(() => shopContext.run(null, () => deliver(message))).catch(() => ({ ok: false }));
  inFlight.add(p); p.finally(() => inFlight.delete(p));
  return p;
}
const settle = () => Promise.all([...inFlight]);

const BUSINESS_LABELS = { home_services: 'Home services', braiders: 'Braiders', other: 'Other local business' };
const label = (type) => {
  if (BUSINESS_LABELS[type]) return BUSINESS_LABELS[type];
  try { const t = require('./trades').get(type); if (t) return t.label; } catch { /* ignore */ }
  return 'Not specified';
};

const COPY = {
  waitlist: {
    subject: "You're on the BuzzCall pilot list",
    text: () => `Hi there,

Thanks for joining the BuzzCall pilot list. BuzzCall texts your missed callers back right away, collects what they need and helps them book, so a missed call doesn't become a lost customer.

When you're ready, tell us about your business here:
${SETUP_URL}

We review every setup and confirm the details and terms with you before anything goes live. Just reply to this email if you have questions.

The BuzzCall team
hello@trybuzzcall.com`,
  },
  setup: {
    subject: 'We got your BuzzCall setup',
    text: () => `Hi there,

Thanks for sending your BuzzCall setup. We got it, and we'll review it and confirm the details with you before your line goes live. Nothing is sent to your customers until then.

If something changes in the meantime, you can send an updated setup here:
${SETUP_URL}

Questions? Just reply to this email.

The BuzzCall team
hello@trybuzzcall.com`,
  },
};

// Signup notifications: a welcome to the person (once per address per window) and an alert to the platform admin.
function signup(kind, { email, businessType, businessName } = {}) {
  try {
    const address = String(email || '').trim().toLowerCase();
    if (!COPY[kind] || !validEmail(address)) return;
    const at = new Date().toISOString();
    if (claim(`welcome-${kind}`, address)) queue({ to: address, subject: COPY[kind].subject, text: COPY[kind].text(), kind: `${kind} welcome` });
    else console.log(`[email] ${kind} welcome to ${maskEmail(address)} skipped: already sent recently`);
    if (claim(`admin-${kind}`, address)) {
      const lines = [`New ${kind === 'setup' ? 'setup submission' : 'pilot list signup'}`, `Email: ${address}`, `Business type: ${label(businessType)}`];
      if (businessName) lines.push(`Business name: ${oneLine(businessName, 80)}`);
      lines.push(`Time: ${at}`);
      if (kind === 'setup') lines.push('Review it in the platform admin (/admin) before approving.');
      adminAlert(`BuzzCall: new ${kind === 'setup' ? 'setup' : 'pilot signup'} (${label(businessType)})`, lines.join('\n'));
    }
  } catch (e) { console.error('[email] signup notification error'); }
}

function adminAlert(subject, text) {
  try {
    if (!adminLimiter().hit('admin').ok) { console.log('[email] admin alert skipped: hourly limit reached'); return null; }
    return queue({ to: adminTo(), subject: oneLine(subject, 150), text: String(text || '').slice(0, 4000), kind: 'admin alert' });
  } catch { return null; }
}
const reset = () => { inFlight.clear(); adminHourly = null; if (store.root.db.emailThrottle) store.root.db.emailThrottle = {}; };

module.exports = { signup, adminAlert, maskEmail, setFetch, settle, reset, RESEND_URL, SETUP_URL, DEFAULT_FROM, DEFAULT_ADMIN };
