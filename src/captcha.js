'use strict';
// Provider-agnostic CAPTCHA hook for public forms. Off unless CAPTCHA_REQUIRED=1.
// The app does not talk to a captcha vendor itself: set a verifier with setVerifier
// (Turnstile, reCAPTCHA, hCaptcha, or a test double). With the flag on and no verifier,
// submissions are refused.
const sec = require('./security');

const required = () => sec.on(process.env.CAPTCHA_REQUIRED);
let verifier = null;
const setVerifier = (fn) => { verifier = typeof fn === 'function' ? fn : null; };

async function check(token, req) {
  if (!required()) return { ok: true, skipped: true };
  const value = String(token || '').trim();
  if (!value || value.length > 4000) return { ok: false, error: 'Complete the captcha and submit again.' };
  if (!verifier) return { ok: false, error: 'Captcha is required but not configured.' };
  let ok = false;
  try { ok = await verifier(value, req); } catch { ok = false; }
  return ok ? { ok: true } : { ok: false, error: 'Captcha check failed. Try again.' };
}

module.exports = { required, check, setVerifier };
