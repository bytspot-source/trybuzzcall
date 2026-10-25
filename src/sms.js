// Sends SMS via Twilio if configured; otherwise log-only (console + data/sms.log).
// sendSms NEVER throws: it resolves { ok, sid?, skipped?, code?, error? } so one failed send (Twilio outage, 21610
// "unsubscribed recipient", a bad number) can't take the process down.
// Before every send: the persisted opt-out list (store.optOuts), the production placeholder-owner guard, and the
// caps on caller-facing texts: per shop (OUTBOUND_SHOP_MAX_PER_HOUR/DAY, see SHOP_CAPS) and platform-wide OUTBOUND_MAX_PER_HOUR (default 200) and OUTBOUND_MAX_PER_DAY (default 500, rolling
// 24h window); 0 = off; owner alerts don't count. The daily cap bounds a slow SMS-pumping drip that stays under the
// hourly cap (200/h would otherwise allow 4,800/day). 500/day is ~10x a busy single-location shop's real volume
// (~20-40 missed calls/day x a few texts each) while capping worst-case spend at roughly $4-5/day in US SMS fees.
// Logs: stdout gets metadata only (masked number, kind, length, result), never the body. data/sms.log is the local
// demo "outbox" and keeps bodies outside production (the demo scripts read it); in production it is metadata only
// unless SMS_LOG_BODIES=1. Phone numbers are masked in production unless LOG_FULL_PHONES=1.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { maskPhone, isProduction, PLACEHOLDER_PHONE, limiter, num, on } = require('./security');
const shopContext = require('./shopContext');
const env = require('./config').env;
const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok } = process.env;
let client = sid && tok ? require('twilio')(sid, tok) : null;
let injectedClient = false;
const OPTED_OUT_CODES = new Set([21610]); // Twilio: "Attempt to send to unsubscribed recipient"

const CAPS = {
  hour: { windowMs: 3600000, env: 'OUTBOUND_MAX_PER_HOUR', def: 200, lim: null, key: null, alerted: 0 },
  day: { windowMs: 86400000, env: 'OUTBOUND_MAX_PER_DAY', def: 500, lim: null, key: null, alerted: 0 },
};
// Per-shop caps (each vendor, and the legacy single shop, separately): OUTBOUND_SHOP_MAX_PER_HOUR (default 100) and
// OUTBOUND_SHOP_MAX_PER_DAY (default 300); 0 = off. A platform administrator can set a per-vendor limit (shop.smsCaps).
// The platform-wide CAPS above stay on top as the total, so one busy or abused line cannot use up every shop's texts.
const SHOP_CAPS = {
  hour: { windowMs: 3600000, env: 'OUTBOUND_SHOP_MAX_PER_HOUR', def: 100 },
  day: { windowMs: 86400000, env: 'OUTBOUND_SHOP_MAX_PER_DAY', def: 300 },
};
const shopLimits = new Map(); // `${shopId}|${per}` -> { lim, max, alerted }
const capMax = (c) => num(process.env[c.env], c.def);
const capLim = (c) => { const max = capMax(c); if (!c.lim || c.key !== max) { c.lim = limiter({ windowMs: c.windowMs, max }); c.key = max; } return c.lim; };
function shopMax(per, shop) {
  const own = shop && shop.smsCaps ? shop.smsCaps[per] : undefined;
  return Number.isInteger(own) && own >= 0 ? own : num(process.env[SHOP_CAPS[per].env], SHOP_CAPS[per].def);
}
// Each shop/window keeps its own count; changing the shop's limit (admin override or env) keeps the sends already
// counted in the current window, so lowering a limit takes effect immediately.
function shopLimit(id, per, max) {
  const key = `${id}|${per}`;
  let e = shopLimits.get(key);
  if (!e) { e = { n: 0, reset: 0, max, alerted: 0 }; shopLimits.set(key, e); }
  e.max = max;
  const now = Date.now();
  if (e.reset <= now) { e.n = 0; e.reset = now + SHOP_CAPS[per].windowMs; }
  e.lim = { blocked: () => e.n >= e.max, hit: () => { e.n++; } };
  return e;
}
// Returns null after counting the send against every active cap, or the blocking cap { scope, per, max, entry }.
function capCheck(shop) {
  const id = shop ? shop.id : 'legacy';
  const own = ['hour', 'day'].map((per) => ({ per, max: shopMax(per, shop) })).filter((x) => x.max > 0)
    .map((x) => ({ ...x, entry: shopLimit(id, x.per, x.max) }));
  const platform = Object.entries(CAPS).filter(([, c]) => capMax(c) > 0);
  for (const x of own) if (x.entry.lim.blocked(id)) return { scope: 'shop', per: x.per, max: x.max, entry: x.entry, windowMs: SHOP_CAPS[x.per].windowMs };
  for (const [per, c] of platform) if (capLim(c).blocked('all')) return { scope: 'platform', per, max: capMax(c), entry: c, windowMs: c.windowMs };
  for (const x of own) x.entry.lim.hit(id);
  for (const [, c] of platform) capLim(c).hit('all');
  return null;
}
let onCap = async () => {};
const setCapAlert = (fn) => { onCap = fn || (async () => {}); };
let warnedPlaceholder = false;

function writeLog(logPath, to, body, kind, result) {
  const ts = new Date().toISOString();
  const meta = `[${ts}] SMS -> ${maskPhone(to)} (${kind}, ${String(body || '').length} chars): ${result}`;
  console.log(meta);
  const prod = isProduction();
  const full = !prod || on(process.env.LOG_FULL_PHONES);
  const bodies = !prod || on(process.env.SMS_LOG_BODIES);
  const line = bodies ? `[${ts}] SMS -> ${to}: ${body}` : `[${ts}] SMS -> ${to} (${kind}, ${String(body || '').length} chars): ${result}`;
  try { fs.appendFileSync(logPath, (full ? line : maskPhone(line)) + '\n', { mode: 0o600 }); } catch (e) { console.error('sms.log write failed:', e.message); }
}

// opts.kind: 'caller' (default; counts toward the hourly/daily caps) | 'owner' (alerts to the shop owner)
// opts.force: send even to an opted-out number (only for the one confirmation of a plain-language opt-out, and HELP).
async function sendSms(to, body, opts = {}) {
  const kind = opts.kind || 'caller';
  try {
    // Capture operation-local resources before awaiting the shared provider client.
    const context = shopContext.current();
    const actualStore = context ? context.store : store.root;
    const from = env.TWILIO_PHONE_NUMBER;
    const logPath = path.join(actualStore.dataDir(), 'sms.log');
    if (context?.shop.status === 'suspended') return { ok: false, skipped: 'vendor_suspended' };
    if (context && (!from || !/^\+[1-9]\d{7,14}$/.test(from))) return { ok: false, skipped: 'no_sender' };
    if (!to) return { ok: false, skipped: 'no_recipient' };
    if (to === PLACEHOLDER_PHONE && isProduction()) {
      if (!warnedPlaceholder) { console.error(`[security] OWNER_PHONE is not set (placeholder ${PLACEHOLDER_PHONE}): owner alerts are NOT being sent. Set OWNER_PHONE.`); warnedPlaceholder = true; }
      return { ok: false, skipped: 'placeholder_owner' };
    }
    if (!opts.force && actualStore.isOptedOut(to)) { console.log(`[sms] skipped ${maskPhone(to)}: opted out`); return { ok: false, skipped: 'opted_out' }; }
    if (kind === 'caller' && !opts.force && actualStore.isPaused && actualStore.isPaused(to)) { console.log(`[sms] skipped ${maskPhone(to)}: automated texts paused (possible opt-out)`); return { ok: false, skipped: 'paused' }; }
    if (kind === 'caller') {
      const blocked = capCheck(context ? context.shop : null);
      if (blocked) {
        const { scope, per, max, entry } = blocked;
        console.error(`[security] outbound SMS ${scope} cap reached (${max}/${per}${context ? `, vendor ${context.id.slice(0, 8)}` : ''}): not texting ${maskPhone(to)}`);
        if (Date.now() - entry.alerted > blocked.windowMs) {
          entry.alerted = Date.now();
          const info = { scope, per, max, shopId: context ? context.id : null, shopName: context ? context.shop.name : null };
          Promise.resolve().then(() => onCap(info)).catch((e) => console.error('cap alert failed:', e.message));
        }
        return { ok: false, skipped: `${scope === 'shop' ? 'shop_' : ''}${per === 'day' ? 'cap_day' : 'cap'}` };
      }
    }
    if (!client || (!from && !injectedClient)) { writeLog(logPath, to, body, kind, 'log-only'); return { ok: true, logOnly: true }; }
    try {
      const m = await client.messages.create({ to, from, body });
      writeLog(logPath, to, body, kind, `sent ${m && m.sid ? m.sid : ''}`.trim());
      return { ok: true, sid: m && m.sid };
    } catch (e) {
      const code = Number(e && e.code) || null;
      writeLog(logPath, to, body, kind, `FAILED ${code || ''} ${e && e.message ? e.message : e}`.trim());
      if (OPTED_OUT_CODES.has(code)) await actualStore.optOut(to, `twilio_${code}`);
      return { ok: false, code, error: e && e.message };
    }
  } catch (e) { // never throw to callers
    console.error('sendSms error:', e && e.message);
    return { ok: false, error: e && e.message };
  }
}
// Tests inject a fake Twilio client (never hits the network).
const setClient = (c) => { client = c; injectedClient = !!c; };
const resetCap = () => { for (const c of Object.values(CAPS)) { c.lim = null; c.key = null; c.alerted = 0; } shopLimits.clear(); };
module.exports = { sendSms, live: !!client, setClient, setCapAlert, resetCap, shopMax, OPTED_OUT_CODES };
