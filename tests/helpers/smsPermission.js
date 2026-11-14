'use strict';
// Test-only helpers. Grants go through the real src/smsPermission.js grant (the same code as POST /api/consent);
// production checks are never relaxed for tests.
const SMS_TEST_ENV = { SMS_ENABLED: '1', SMS_CONSENT_BUSINESS_ID: 'test-shop', ALLOW_UNSIGNED_TWILIO_WEBHOOKS: '1' };
// Turns on the gate inputs for an in-process test server (local unsigned webhooks, a legacy business id and sender).
function enableSms(extra = {}) {
  Object.assign(process.env, SMS_TEST_ENV, extra);
  if (!process.env.TWILIO_PHONE_NUMBER) process.env.TWILIO_PHONE_NUMBER = '+14705559999';
}
async function grantSms(phone, purpose = 'customer_service', { shopId } = {}) {
  const smsPermission = require('../../src/smsPermission');
  const input = { phone, purpose, consentedAt: new Date().toISOString(), disclosureVersion: 'test-written-v1', evidenceRef: 'test-form/1' };
  if (!shopId) return require('../../src/shopContext').run(null, () => smsPermission.grant(input));
  return require('../../src/vendors').run(shopId, () => smsPermission.grant(input), { suspended: true });
}
module.exports = { SMS_TEST_ENV, enableSms, grantSms };
