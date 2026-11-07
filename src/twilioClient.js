'use strict';
// Shared Twilio REST client for paid operations (number purchase, A2P registration).
// Nothing here places a call. Callers must check AUTO_PROVISION_NUMBERS / AUTO_A2P first.
// Tests inject a fake via setClient so the real SDK is never constructed and never billed.
let injected = null;
let live = null;

function setClient(client) {
  injected = client || null;
  live = null;
}
function getClient() {
  if (injected) return injected;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  if (!live) live = require('twilio')(sid, token);
  return live;
}
module.exports = { setClient, getClient };
