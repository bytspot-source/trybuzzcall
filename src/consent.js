'use strict';
// Caller-facing SMS wording shared by the server, the public per-shop SMS page and A2P registration.
// Permission itself is NOT here: written permission is recorded by an operator through the authenticated API and
// checked in src/smsPermission.js. A missed call, a key press, an inbound text or START never creates permission.
// Shop name: no caller-facing text goes out without a real shop name (shopName() is '' when BUSINESS_NAME is unset or
// a placeholder); sms.js blocks the send and the platform administrator is alerted.
const env = require('./config').env;

const SUPPORT_PHONE = '(470) 482-8377';
const SUPPORT_EMAIL = 'hello@trybuzzcall.com';

// Names that are not a business name (old fallbacks, form placeholders).
const PLACEHOLDER_NAMES = new Set(['our team', 'us', 'we', 'your business', 'business', 'business name', 'shop', 'shop name', '[shop name]', '[shop]', 'vendor', 'n/a', 'na', 'none', 'null', 'undefined']);
const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
function shopName() {
  const n = cleanName(env.BUSINESS_NAME);
  return n && /[\p{L}\p{N}]/u.test(n) && !PLACEHOLDER_NAMES.has(n.toLowerCase()) ? n : '';
}
const xml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// How a recipient opts in (public SMS page, A2P campaign message flow).
const optInSummary = (name = shopName()) => `${name} texts only people who gave ${name} written permission first, on ${name}'s own sign-up form outside of text messages (paper or online). ${name} or BuzzCall records that permission before any text is sent. Calling, texting or replying START does not sign anyone up, and permission is not a condition of purchase.`;

// Caller-facing keyword replies (src/server.js /twilio/sms). Every one still passes the central permission gate.
const helpText = (name = shopName()) => `${name} missed-call text-back via BuzzCall. For help call ${SUPPORT_PHONE} or email ${SUPPORT_EMAIL}. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.`;
const startText = (name = shopName()) => `${name}: This number can receive texts again, but ${name} texts you only after you give new written permission. Reply HELP for help, STOP to opt out.`;
const stopText = (name = shopName()) => `${name}: You're unsubscribed and won't get more texts from us.`;
const stopTextEs = (name = shopName()) => `${name}: Se canceló su suscripción y no recibirá más mensajes.`;
// Custom texts (HELP_MESSAGE, INACTIVE_MESSAGE) must still name the shop.
const named = (msg, name = shopName()) => (String(msg).toLowerCase().includes(name.toLowerCase()) ? String(msg) : `${name}: ${msg}`);

module.exports = { shopName, optInSummary, helpText, startText, stopText, stopTextEs, named, xml, SUPPORT_PHONE, SUPPORT_EMAIL };
