'use strict';
// Provider-agnostic CAPTCHA hook for public forms. Off unless CAPTCHA_REQUIRED=1 AND a verifier is wired.
// The app does not talk to a captcha vendor itself: set a verifier with setVerifier
// (Turnstile, reCAPTCHA, hCaptcha, or a test double). Turning the flag on with no verifier
// does not block signups; it logs once and skips the check. Leave CAPTCHA_REQUIRED unset until that wiring exists.
const sec = require('./security');

const required = () => sec.on(process.env.CAPTCHA_REQUIRED);
let verifier = null;
const setVerifier = (fn) => { verifier = typeof fn === 'function' ? fn : null; };

let warned = false;
async function check(token, req) {
  if (!required()) return { ok: true, skipped: true };
  if (!verifier) {
    if (!warned) {
      warned = true;
      console.error('[captcha] CAPTCHA_REQUIRED is set but no verifier is configured. Signups are not blocked. Wire setVerifier before treating this flag as protection.');
    }
    return { ok: true, skipped: 'not_configured' };
  }
  const value = String(token || '').trim();
  if (!value || value.length > 4000) return { ok: false, error: 'Complete the captcha and submit again.' };
  let ok = false;
  try { ok = await verifier(value, req); } catch { ok = false; }
  return ok ? { ok: true } : { ok: false, error: 'Captcha check failed. Try again.' };
}

module.exports = { required, check, setVerifier };
