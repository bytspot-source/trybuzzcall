'use strict';
// Optional Twilio Lookup line-type check. Off unless LOOKUP_REJECT_VOIP=1.
// When the flag is on, VoIP / non-fixed VoIP numbers are rejected. Tests inject a
// fake lookup; there is no network call unless a Twilio client is configured.
const sec = require('./security');

const enabled = () => sec.on(process.env.LOOKUP_REJECT_VOIP);
const VOIP = new Set(['voip', 'nonfixedvoip', 'fixedvoip', 'nonFixedVoip', 'fixedVoip']);
let impl = null;
const setLookup = (fn) => { impl = typeof fn === 'function' ? fn : null; };

function rejected(lineType) {
  return VOIP.has(String(lineType || '')) || VOIP.has(String(lineType || '').toLowerCase());
}

async function lineType(phone) {
  if (!enabled()) return { ok: true, skipped: true };
  if (impl) {
    const row = await impl(phone);
    const type = row && (row.lineType || row.type) || '';
    if (rejected(type)) return { ok: false, lineType: type, error: 'Use a mobile number. Internet (VoIP) numbers cannot be used here.' };
    return { ok: true, lineType: type || 'mobile' };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { ok: false, error: 'Number check is on but Twilio Lookup is not configured.' };
  try {
    const client = require('./twilioClient').getClient() || require('twilio')(sid, token);
    const row = await client.lookups.v2.phoneNumbers(phone).fetch({ fields: 'line_type_intelligence' });
    const type = row && row.lineTypeIntelligence && row.lineTypeIntelligence.type || '';
    if (rejected(type)) return { ok: false, lineType: type, error: 'Use a mobile number. Internet (VoIP) numbers cannot be used here.' };
    return { ok: true, lineType: type || 'unknown' };
  } catch (e) {
    console.error('[lookup] line-type check failed');
    return { ok: false, error: 'We could not confirm that number is a mobile line.' };
  }
}

module.exports = { enabled, lineType, setLookup, rejected };
