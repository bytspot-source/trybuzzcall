// All sends, including simulations, require explicit scoped written permission.
const fs = require('fs');
const path = require('path');
const consent = require('./consent');
let pendingSends = 0;

function live() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN &&
    consent.validPhone(process.env.TWILIO_PHONE_NUMBER));
}
function businessName() {
  const value = process.env.BUSINESS_NAME;
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120 &&
    !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
}
function canSend(to, purpose = 'customer_service') {
  if (process.env.SMS_ENABLED !== '1') return { allowed: false, reason: 'sms_disabled' };
  const permission = consent.check(to, purpose);
  if (!permission.allowed) return permission;
  // Required in log-only mode too, so simulations have the same disclosures as live sends.
  if (!businessName()) return { allowed: false, reason: 'business_name_required' };
  return permission;
}
function providerBlocked(to) {
  try { consent.revoke(to, { method: 'provider_21610', providerBlocked: true }); }
  catch { /* Consent latches persistence failures closed; never expose provider error details. */ }
  return { sent: false, reason: 'provider_blocked' };
}
async function deliverSms(to, body, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { sent: false, reason: 'invalid_options' };
  }
  const { purpose = 'customer_service' } = options;
  let permission = canSend(to, purpose);
  if (!permission.allowed) return { sent: false, reason: permission.reason };
  if (typeof body !== 'string' || !body.trim()) return { sent: false, reason: 'invalid_body' };
  const config = consent.configuration();
  const message = `${body}\n\n${businessName()}: Reply STOP to opt out or HELP for help. Message frequency varies. Message and data rates may apply.`;
  if (live()) {
    try {
      // Lazy construction avoids even loading the provider SDK for denied sends.
      const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      // Recheck at the actual handoff, not when a reply was scheduled/generated.
      permission = canSend(to, purpose);
      if (!permission.allowed) return { sent: false, reason: permission.reason };
      const current = consent.configuration();
      if (!current || current.businessId !== config.businessId || current.sender !== config.sender || !live()) {
        return { sent: false, reason: 'configuration_changed' };
      }
      const accepted = await client.messages.create({ to, from: config.sender, body: message });
      if (accepted && (accepted.errorCode === 21610 || accepted.errorCode === '21610')) return providerBlocked(to);
      if (!accepted || typeof accepted.sid !== 'string' || !accepted.sid || accepted.errorCode ||
          ['failed', 'undelivered', 'canceled'].includes(accepted.status)) {
        return { sent: false, reason: 'provider_failed' };
      }
      // Live message bodies and recipients never go to sms.log or stdout.
      console.log('SMS accepted (live)');
      return { sent: true, mode: 'live' };
    } catch (error) {
      if (error && (error.code === 21610 || error.code === '21610')) return providerBlocked(to);
      return { sent: false, reason: 'provider_failed' };
    }
  }
  // An incomplete credential pair is a configuration error, not a successful simulation.
  if (process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_AUTH_TOKEN) {
    return { sent: false, reason: 'provider_not_configured' };
  }
  permission = canSend(to, purpose);
  if (!permission.allowed) return { sent: false, reason: permission.reason };
  try {
    const directory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
    fs.appendFileSync(path.join(directory, 'sms.log'),
      `[${new Date().toISOString()}] SMS (${purpose}) -> ${to}: ${message}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    return { sent: false, reason: 'log_failed' };
  }
  console.log('SMS simulated (log-only)');
  return { sent: true, mode: 'log-only' };
}
async function sendSms(to, body, options = {}) {
  pendingSends++;
  try { return await deliverSms(to, body, options); }
  finally { pendingSends--; }
}
// HTTP clients can disconnect before the provider answers. Such work must prevent a clean exit.
function hasPendingSends() { return pendingSends > 0; }
module.exports = { sendSms, canSend, hasPendingSends, get live() { return live(); } };
