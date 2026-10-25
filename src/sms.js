// Sends SMS via Twilio if configured; otherwise log-only (console + data/sms.log).
// sendSms NEVER throws: it resolves { ok, sid?, skipped?, code?, error? } so one failed send (Twilio outage, 21610
// "unsubscribed recipient", a bad number) can't take the process down.
// Before every send: the persisted opt-out list (store.optOuts), the production placeholder-owner guard, and the
// hourly cap on caller-facing texts (OUTBOUND_MAX_PER_HOUR, default 200; 0 = off; owner alerts don't count).
// Logs: stdout gets metadata only (masked number, kind, length, result), never the body. data/sms.log is the local
// demo "outbox" and keeps bodies outside production (the demo scripts read it); in production it is metadata only
// unless SMS_LOG_BODIES=1. Phone numbers are masked in production unless LOG_FULL_PHONES=1.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { maskPhone, isProduction, PLACEHOLDER_PHONE, limiter, num, on } = require('./security');
const LOG = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data'), 'sms.log');
const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_PHONE_NUMBER: from } = process.env;
let client = sid && tok && from ? require('twilio')(sid, tok) : null;
const OPTED_OUT_CODES = new Set([21610]); // Twilio: "Attempt to send to unsubscribed recipient"

const capWindowMs = 3600000;
let cap = null, capKey = null, capAlerted = 0;
const capLimit = () => num(process.env.OUTBOUND_MAX_PER_HOUR, 200);
function capHit() {
  const max = capLimit();
  if (!max) return { ok: true };
  if (!cap || capKey !== max) { cap = limiter({ windowMs: capWindowMs, max }); capKey = max; }
  return cap.hit('all');
}
let onCap = async () => {};
const setCapAlert = (fn) => { onCap = fn || (async () => {}); };
let warnedPlaceholder = false;

function writeLog(to, body, kind, result) {
  const ts = new Date().toISOString();
  const meta = `[${ts}] SMS -> ${maskPhone(to)} (${kind}, ${String(body || '').length} chars): ${result}`;
  console.log(meta);
  const prod = isProduction();
  const full = !prod || on(process.env.LOG_FULL_PHONES);
  const bodies = !prod || on(process.env.SMS_LOG_BODIES);
  const line = bodies ? `[${ts}] SMS -> ${to}: ${body}` : `[${ts}] SMS -> ${to} (${kind}, ${String(body || '').length} chars): ${result}`;
  try { fs.appendFileSync(LOG, (full ? line : maskPhone(line)) + '\n'); } catch (e) { console.error('sms.log write failed:', e.message); }
}

// opts.kind: 'caller' (default; counts toward the hourly cap) | 'owner' (alerts to the shop owner)
// opts.force: send even to an opted-out number (only for the one confirmation of a plain-language opt-out, and HELP).
async function sendSms(to, body, opts = {}) {
  const kind = opts.kind || 'caller';
  try {
    if (!to) return { ok: false, skipped: 'no_recipient' };
    if (to === PLACEHOLDER_PHONE && isProduction()) {
      if (!warnedPlaceholder) { console.error(`[security] OWNER_PHONE is not set (placeholder ${PLACEHOLDER_PHONE}): owner alerts are NOT being sent. Set OWNER_PHONE.`); warnedPlaceholder = true; }
      return { ok: false, skipped: 'placeholder_owner' };
    }
    if (!opts.force && store.isOptedOut(to)) { console.log(`[sms] skipped ${maskPhone(to)}: opted out`); return { ok: false, skipped: 'opted_out' }; }
    if (kind === 'caller') {
      const c = capHit();
      if (!c.ok) {
        console.error(`[security] outbound SMS cap reached (${capLimit()}/hour): not texting ${maskPhone(to)}`);
        if (Date.now() - capAlerted > capWindowMs) {
          capAlerted = Date.now();
          Promise.resolve().then(() => onCap(capLimit())).catch((e) => console.error('cap alert failed:', e.message));
        }
        return { ok: false, skipped: 'cap' };
      }
    }
    if (!client) { writeLog(to, body, kind, 'log-only'); return { ok: true, logOnly: true }; }
    try {
      const m = await client.messages.create({ to, from, body });
      writeLog(to, body, kind, `sent ${m && m.sid ? m.sid : ''}`.trim());
      return { ok: true, sid: m && m.sid };
    } catch (e) {
      const code = Number(e && e.code) || null;
      writeLog(to, body, kind, `FAILED ${code || ''} ${e && e.message ? e.message : e}`.trim());
      if (OPTED_OUT_CODES.has(code)) store.optOut(to, `twilio_${code}`);
      return { ok: false, code, error: e && e.message };
    }
  } catch (e) { // never throw to callers
    console.error('sendSms error:', e && e.message);
    return { ok: false, error: e && e.message };
  }
}
// Tests inject a fake Twilio client (never hits the network).
const setClient = (c) => { client = c; };
const resetCap = () => { cap = null; capAlerted = 0; };
module.exports = { sendSms, live: !!client, setClient, setCapAlert, resetCap, OPTED_OUT_CODES };
