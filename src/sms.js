// Sends SMS via Twilio if configured; otherwise logs to console + data/sms.log.
const fs = require('fs');
const path = require('path');
const LOG = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data'), 'sms.log');
const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_PHONE_NUMBER: from } = process.env;
const client = sid && tok && from ? require('twilio')(sid, tok) : null;

async function sendSms(to, body) {
  const line = `[${new Date().toISOString()}] SMS -> ${to}: ${body}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
  if (client) await client.messages.create({ to, from, body });
}
module.exports = { sendSms, live: !!client };
