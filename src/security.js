// Small security helpers shared by server.js / sms.js / agent.js. No dependencies.
const crypto = require('crypto');

const on = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
// Production = NODE_ENV=production, or running on Render (RENDER is set by Render on every service, Docker included),
// or, when NODE_ENV isn't set at all, an https PUBLIC_BASE_URL. An explicit non-production NODE_ENV (test,
// development) off Render stays non-production so local runs and tests keep demo behaviour.
const onRender = () => !!String(process.env.RENDER || '').trim();
function modeInfo() {
  const e = process.env, reasons = [];
  if (e.NODE_ENV === 'production') reasons.push('NODE_ENV=production');
  if (onRender()) reasons.push('RENDER');
  if (!e.NODE_ENV && /^https:\/\//i.test(e.PUBLIC_BASE_URL || '')) reasons.push('https PUBLIC_BASE_URL');
  return { production: reasons.length > 0, reasons };
}
const isProduction = () => modeInfo().production;
// Mock/demo behaviour (unsigned mock webhooks, unvalidated Twilio posts without a Twilio token, mock pay/checkout pages)
// is always available outside production; in production it needs an explicit DEMO_MODE=1.
const demoAllowed = () => !isProduction() || on(process.env.DEMO_MODE);

// Constant-time string compare (hash first so different lengths don't leak through timingSafeEqual's length check).
function safeEqual(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(h(a), h(b)) && String(a ?? '').length === String(b ?? '').length;
}

// Fixed-window in-memory counter keyed by string. hit(key) -> { ok, remaining, retryAfterSec }.
// Single-instance app (one Render web service), so in-memory is enough; resets on restart.
function limiter({ windowMs, max, maxKeys = 10000 }) {
  const hits = new Map();
  const prune = (now) => { for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); };
  const get = (key, now = Date.now()) => {
    let e = hits.get(key);
    if (!e || e.reset <= now) {
      if (hits.size >= maxKeys) prune(now);
      e = { n: 0, reset: now + windowMs }; hits.set(key, e);
    }
    return e;
  };
  return {
    hit(key) { const now = Date.now(), e = get(key, now); e.n++; return { ok: e.n <= max, retryAfterSec: Math.ceil((e.reset - now) / 1000) }; },
    blocked(key) { const now = Date.now(), e = hits.get(key); return !!e && e.reset > now && e.n >= max ? Math.ceil((e.reset - now) / 1000) : 0; },
    reset(key) { if (key === undefined) hits.clear(); else hits.delete(key); },
  };
}
// Client IP for rate limits. On Render, traffic passes Cloudflare + Render proxies (several hops), and Render documents
// True-Client-IP (set/overwritten at the edge) as the real client address.
// CLIENT_IP_HEADER overrides the header name ('none' = only req.ip, which honours the 'trust proxy' setting).
// The header is only trusted on Render (RENDER set) unless CLIENT_IP_HEADER names one explicitly; anywhere else a client
// could send it and dodge the per-IP limits.
function clientIp(req) {
  const name = (process.env.CLIENT_IP_HEADER || (onRender() ? 'true-client-ip' : 'none')).toLowerCase();
  const h = name !== 'none' ? String(req.headers[name] || '').split(',')[0].trim() : '';
  return h || req.ip || 'unknown';
}
const num = (v, d) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

// Express middleware: max requests per client IP per window (429 + Retry-After over the limit).
function rateLimit({ windowMs, max, message = 'Too many requests, please try again later.' }) {
  const l = limiter({ windowMs, max });
  const mw = (req, res, next) => {
    const r = l.hit(clientIp(req));
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfterSec));
    return req.is('application/json') || /application\/json/.test(req.get('accept') || '')
      ? res.status(429).json({ error: message }) : res.status(429).type('text').send(message);
  };
  mw.reset = () => l.reset();
  return mw;
}

// "+14705550123" -> "+1******0123" (keeps the last 4 digits); applied to every E.164-looking number in a string.
const maskPhone = (s) => String(s ?? '').replace(/\+\d{7,15}/g, (p) => p.slice(0, 2) + '*'.repeat(Math.max(0, p.length - 6)) + p.slice(-4));

// Conservative headers (helmet-equivalent subset that cannot break the inline-free static site, Stripe redirects or admin).
function securityHeaders(base) {
  const https = /^https:\/\//i.test(base || '') && isProduction();
  return (req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    });
    if (https) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}

// Textable caller numbers: US (50 states + DC) and Canada only. E.164 +1 NPA NXX XXXX where the area code is an
// in-service US/CA geographic code (src/areaCodes.js, from NANPA) and the exchange is valid. That rejects the
// anonymous/restricted placeholders Twilio sends (+266696687, +7378742833, 'anonymous'), international numbers, the
// other NANP countries (Jamaica 876, Dominican Republic 809/829/849, Bahamas 242, ...), US territories, toll-free
// and premium 900, plus the 976 premium exchange and N11 service exchanges (211/411/911...): SMS pumping / toll fraud.
// TEXT_EXTRA_AREA_CODES="787,939" adds codes (a new overlay, or territories if the shop really serves them).
const AREA_CODES = require('./areaCodes');
// Never textable, even if listed in TEXT_EXTRA_AREA_CODES: premium 900, toll-free (in use and reserved), and the
// non-geographic service codes (5XX personal communications, 600/622 Canada non-geographic, 700, 710 US government).
const PREMIUM_AREA_CODES = new Set(['900']);
const TOLL_FREE_AREA_CODES = new Set('800 833 844 855 866 877 888 822 880 881 882 883 884 885 886 887 889'.split(' '));
const NON_GEOGRAPHIC_AREA_CODES = new Set('500 521 522 523 524 525 526 527 528 529 532 533 535 538 542 543 544 545 546 547 549 550 552 553 554 556 566 569 577 588 589 600 622 633 644 655 677 688 700 710'.split(' '));
const extraAreaCodes = () => new Set(String(process.env.TEXT_EXTRA_AREA_CODES || '').split(/[\s,]+/).filter((x) => /^[2-9]\d{2}$/.test(x)));
function nanpReason(p) {
  const m = /^\+1([2-9]\d{2})([2-9]\d{2})\d{4}$/.exec(String(p || ''));
  if (!m) return 'not a +1 number';
  const [, npa, nxx] = m;
  if (PREMIUM_AREA_CODES.has(npa)) return 'premium area code';
  if (TOLL_FREE_AREA_CODES.has(npa)) return 'toll-free area code';
  if (NON_GEOGRAPHIC_AREA_CODES.has(npa)) return 'non-geographic area code';
  if (!AREA_CODES.US.has(npa) && !AREA_CODES.CA.has(npa) && !extraAreaCodes().has(npa)) return AREA_CODES.NON_US_CA.has(npa) ? 'non-US/Canada NANP area code' : 'not a US/Canada area code';
  if (nxx === '976') return 'premium exchange 976';
  if (/^[2-9]11$/.test(nxx)) return 'service exchange';
  return null;
}
const isNanp = (p) => nanpReason(p) === null;
const PLACEHOLDER_PHONE = '+10000000000';
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { modeInfo, onRender, isNanp, nanpReason, PLACEHOLDER_PHONE, escapeRe, sleep, clientIp, on, num, isProduction, demoAllowed, safeEqual, limiter, rateLimit, maskPhone, securityHeaders };
