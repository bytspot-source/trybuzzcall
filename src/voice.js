'use strict';
// TwiML <Say> voices. VOICE_NAME (English) and VOICE_NAME_ES (Spanish, used with language="es-MX") pick a Twilio TTS
// voice in Twilio's `{Provider}.{Voice}` <Say> format, e.g. Polly.Joanna-Neural or Google.en-US-Chirp3-HD-Aoede
// (list: https://www.twilio.com/docs/voice/twiml/say/text-speech). Unset or invalid values fall back to the defaults;
// 'basic' omits the voice attribute (Twilio's account default voice, the old behavior).
// Cost (https://www.twilio.com/en-us/voice/pricing/us): Neural $0.0032 / 100 chars, Generative $0.0130 / 100 chars.
const env = require('./config').env;

const DEFAULT_VOICE = 'Polly.Joanna-Neural'; // en-US female, Neural tier (GA; Generative voices are Public Beta)
const DEFAULT_VOICE_ES = 'Polly.Mia-Neural'; // es-MX female, Neural tier
const VALID = /^(Polly|Google)\.[A-Za-z0-9-]{1,60}$/;

function pick(value, fallback) {
  const v = String(value ?? '').trim();
  if (!v) return fallback;
  if (v.toLowerCase() === 'basic') return '';
  return VALID.test(v) ? v : fallback;
}
const voiceName = () => pick(env.VOICE_NAME, DEFAULT_VOICE);
const voiceNameEs = () => pick(env.VOICE_NAME_ES, DEFAULT_VOICE_ES);

const xml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// <Say> with the configured voice; lang 'es' (or 'es-MX') uses the Spanish voice and language="es-MX".
function say(text, lang) {
  const es = lang && /^es/i.test(lang);
  const v = es ? voiceNameEs() : voiceName();
  const attrs = (es ? ' language="es-MX"' : '') + (v ? ` voice="${xml(v)}"` : '');
  return `<Say${attrs}>${xml(text)}</Say>`;
}

module.exports = { say, voiceName, voiceNameEs, DEFAULT_VOICE, DEFAULT_VOICE_ES, VALID };
