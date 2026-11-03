'use strict';
// A2P 10DLC voice consent. A missed call never starts texting on its own: the caller hears the opt-in script in a
// <Gather numDigits="1"> and only a press of 1 starts the text-back (POST /twilio/voice/consent, Twilio-signed).
// Every answer (1, another key, or no input) is logged per shop in db.voiceConsents with the time, CallSid, From,
// shop id, digits and the exact script played. Those records are consent evidence: retention never purges them
// (they are capped at MAX_RECORDS, newest kept).
// Shop name: no caller-facing text goes out without a real shop name (shopName() is '' when BUSINESS_NAME is unset or
// a placeholder); sms.js blocks the send and the platform administrator is alerted.
// Per-shop wording: VOICE_CONSENT_PROMPT (shop config key) replaces the default script. It must keep {shop}, "press 1",
// the frequency and rates disclosures and STOP/HELP, otherwise the default is used. VOICE_CONSENT_SPANISH=1 also reads
// the script in Spanish inside the same Gather (press 1 consents either way).
const env = require('./config').env;
const store = require('./store');
const shopContext = require('./shopContext');

const MAX_RECORDS = 10000;
const SUPPORT_PHONE = '(470) 482-8377';
const SUPPORT_EMAIL = 'hello@trybuzzcall.com';
const DEFAULT_PROMPT = "{shop} can't take your call right now. Press 1 and we'll text you at this number to get you booked. Message frequency varies, message and data rates may apply. Reply STOP to opt out or HELP for help.";
const SPANISH_PROMPT = '{shop} no puede atender su llamada en este momento. Oprima 1 y le enviaremos un mensaje de texto a este número para agendar su cita. La frecuencia de los mensajes varía y pueden aplicar tarifas de mensajes y datos. Responda STOP para cancelar o HELP para obtener ayuda.';
const NO_INPUT = "We didn't get a response, so we won't text you. Please call again later. Goodbye.";
const NO_INPUT_ES = 'No recibimos respuesta, así que no le enviaremos mensajes. Adiós.';
const DECLINED = "Okay, we won't text you. Please call again later. Goodbye.";
const DECLINED_ES = 'Está bien, no le enviaremos mensajes. Adiós.';

// Names that are not a business name (old fallbacks, form placeholders).
const PLACEHOLDER_NAMES = new Set(['our team', 'us', 'we', 'your business', 'business', 'business name', 'shop', 'shop name', '[shop name]', '[shop]', 'vendor', 'n/a', 'na', 'none', 'null', 'undefined']);
const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
function shopName() {
  const n = cleanName(env.BUSINESS_NAME);
  return n && /[\p{L}\p{N}]/u.test(n) && !PLACEHOLDER_NAMES.has(n.toLowerCase()) ? n : '';
}

const REQUIRED = [/\{shop\}/, /\bpress 1\b/i, /frequency varies/i, /rates may apply/i, /\bSTOP\b/, /\bHELP\b/];
function promptTemplate() {
  const custom = String(env.VOICE_CONSENT_PROMPT || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return custom && custom.length <= 600 && REQUIRED.every((re) => re.test(custom)) ? custom : DEFAULT_PROMPT;
}
const fill = (template, name) => template.split('{shop}').join(name);
const voicePrompt = (name = shopName()) => fill(promptTemplate(), name);
const spanishPrompt = (name = shopName()) => fill(SPANISH_PROMPT, name);
const spanish = () => /^(1|true|yes|on)$/i.test(String(env.VOICE_CONSENT_SPANISH || ''));
const xml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// TwiML body for a missed call: the opt-in script in a one-digit Gather. actionOnEmptyResult makes Twilio post the
// no-input outcome too, so it is logged (and answered with a goodbye, never a text).
function gatherTwiml(base) {
  const name = shopName();
  const es = spanish() ? `<Pause length="1"/><Say language="es-MX">${xml(spanishPrompt(name))}</Say>` : '';
  return `<Gather input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true" action="${xml(base)}/twilio/voice/consent" method="POST"><Say>${xml(voicePrompt(name))}</Say>${es}</Gather>`
    + `<Say>${xml(NO_INPUT)}</Say>${spanish() ? `<Say language="es-MX">${xml(NO_INPUT_ES)}</Say>` : ''}<Hangup/>`;
}
const goodbyeTwiml = (digits) => {
  const none = !digits;
  return `<Say>${xml(none ? NO_INPUT : DECLINED)}</Say>${spanish() ? `<Say language="es-MX">${xml(none ? NO_INPUT_ES : DECLINED_ES)}</Say>` : ''}<Hangup/>`;
};

// Consent log, in the current shop's store (legacy root or the vendor's namespaced store).
async function record({ callSid, from, digits }) {
  const d = String(digits ?? '').replace(/[^0-9*#]/g, '').slice(0, 4);
  const entry = {
    at: new Date().toISOString(),
    callSid: typeof callSid === 'string' && /^[A-Za-z0-9]{1,80}$/.test(callSid) ? callSid : null,
    from: /^\+[1-9]\d{7,14}$/.test(String(from || '')) ? String(from) : null,
    shopId: shopContext.shopId() || 'legacy',
    digits: d,
    consented: d === '1',
    prompt: voicePrompt(),
    ...(spanish() ? { promptEs: spanishPrompt() } : {}),
  };
  const list = (store.db.voiceConsents ||= []);
  list.unshift(entry);
  if (list.length > MAX_RECORDS) list.length = MAX_RECORDS;
  store.save();
  try { if (typeof store.flush === 'function') await Promise.race([store.flush(), new Promise((r) => setTimeout(r, 5000).unref())]); } catch {}
  return entry;
}

// Caller-facing keyword replies (src/server.js /twilio/sms).
const helpText = (name = shopName()) => `${name} missed-call text-back via BuzzCall. For help call ${SUPPORT_PHONE} or email ${SUPPORT_EMAIL}. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.`;
const startText = (name = shopName()) => `${name}: You're resubscribed to texts about your service request. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
const stopText = (name = shopName()) => `${name}: You're unsubscribed and won't get more texts from us. Reply START to resubscribe.`;
const stopTextEs = (name = shopName()) => `${name}: Se canceló su suscripción y no recibirá más mensajes. Responda START para volver a suscribirse.`;
// Custom texts (HELP_MESSAGE, INACTIVE_MESSAGE) must still name the shop.
const named = (msg, name = shopName()) => (String(msg).toLowerCase().includes(name.toLowerCase()) ? String(msg) : `${name}: ${msg}`);

module.exports = { shopName, voicePrompt, spanishPrompt, promptTemplate, gatherTwiml, goodbyeTwiml, record, helpText, startText, stopText, stopTextEs, named, xml,
  DEFAULT_PROMPT, SPANISH_PROMPT, SUPPORT_PHONE, SUPPORT_EMAIL, MAX_RECORDS };
