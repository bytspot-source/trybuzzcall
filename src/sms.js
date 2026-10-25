// Sends SMS via Twilio if configured; otherwise logs to console + data/sms.log.
const fs = require('fs');
const path = require('path');
const LOG = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data'), 'sms.log');
const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_PHONE_NUMBER: from } = process.env;
const client = sid && tok && from ? require('twilio')(sid, tok) : null;

const { maskPhone, isProduction } = require('./security');

// stdout (Render logs) always masks phone numbers. data/sms.log keeps full numbers for local demos/scripts, and is
// masked too in production (LOG_FULL_PHONES=1 opts out).
async function sendSms(to, body) {
  const line = `[${new Date().toISOString()}] SMS -> ${to}: ${body}`;
  console.log(maskPhone(line));
  const full = !isProduction() || /^(1|true|yes)$/i.test(process.env.LOG_FULL_PHONES || '');
  try { fs.appendFileSync(LOG, (full ? line : maskPhone(line)) + '\n'); } catch (e) { console.error('sms.log write failed:', e.message); }
  if (client) await client.messages.create({ to, from, body });
}
module.exports = { sendSms, live: !!client };
