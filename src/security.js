// Small security helpers shared by server.js / sms.js / agent.js. No dependencies.
const crypto = require('crypto');

const on = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
// Render sets NODE_ENV=production at runtime for Node services.
const isProduction = () => process.env.NODE_ENV === 'production';
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
// True-Client-IP (set/overwritten at the edge) as the real client address, so in production that header wins.
// CLIENT_IP_HEADER overrides the header name ('none' = only req.ip, which honours the 'trust proxy' setting).
function clientIp(req) {
  const name = (process.env.CLIENT_IP_HEADER || (isProduction() ? 'true-client-ip' : 'none')).toLowerCase();
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

module.exports = { clientIp, on, num, isProduction, demoAllowed, safeEqual, limiter, rateLimit, maskPhone, securityHeaders };
