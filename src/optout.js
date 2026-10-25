// Inbound SMS consent keywords. Twilio's default opt-out keywords (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, and
// the newer OPTOUT, REVOKE), opt-in keywords (START, UNSTOP, YES) and HELP/INFO.
//
// Who confirms an opt-out:
//   - 'optout': the message IS a Twilio keyword (whole message, case-insensitive, surrounding whitespace ignored, as
//     Twilio matches it). Twilio's opt-out handling blocks the number and sends the confirmation; we only record it.
//   - 'revoke': anything else we treat as an opt-out. Variants Twilio may not catch ("S T O P", "STOP 2", "Stop.",
//     "❌STOP❌", fullwidth "ＳＴＯＰ", "opt out") and plain-language revocations ("please stop texting me"; the FCC
//     requires honouring revocation "by any reasonable means"). The app sends exactly one confirmation. (If Twilio did
//     block the number after all, our confirmation is refused with 21610, so the person never gets two.)
// Text is NFKC-normalized first (fullwidth/compatibility letters fold to ASCII), and smart quotes become '.
// Short messages (5 words or fewer) with a stop-word anywhere ("please stop", "pls stop", "I said stop", "STOP STOP",
// "who is this? stop", "stop sending these") are opt-outs, UNLESS they also contain a clear job/scheduling word
// ("stop leak under sink", "Stop valve is broken", "stop by at 3", "stop, I meant Saturday"). A message that is only
// stop-words plus filler never hits that guard. Explicit phrases ("quit texting me", "wrong number", "lose my number",
// "stop sending these") always count. Longer messages with a stop-word and no job word -> 'maybe': the app pauses
// automated replies to that number and asks the owner to check, instead of guessing either way.
// Trade-off: a 5-word real opt-out that also names a job word ("stop texting about the leak" is still caught by the
// phrase rule, but e.g. "stop, leak fixed already" is not) goes to the bot; a job reply with no job word ("stop, it's
// fine now") is treated as an opt-out. We prefer erring toward opt-out for short texts, because texting someone who
// said stop is the costlier mistake, and keep the guard list to words that clearly describe the job or a time.
const OPT_OUT = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'];
const OPT_IN = ['START', 'UNSTOP', 'YES'];
const HELP = ['HELP', 'INFO'];

const normalize = (t) => String(t ?? '').normalize('NFKC').replace(/[\u2018\u2019\u02BC`´]/g, "'").replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
// Letters only, uppercased: "S T O P" / "STOP 2" / "❌STOP❌" / "opt-out" -> STOP / STOP / STOP / OPTOUT.
const letters = (t) => normalize(t).toUpperCase().replace(/[^A-Z]/g, '');
// Exactly what Twilio matches: the raw message is the keyword (no NFKC, no punctuation), whitespace trimmed.
const exactKeyword = (t) => String(t ?? '').trim().toUpperCase();

const END = String.raw`[\s.!,;:)\-]*(?:please|pls|plz|thanks?|thank\s+you|now)?[\s.!,;:)\-]*$`;
const TEXTS = String.raw`(?:texts?|txts?|messages?|msgs?|sms|texting|messaging|notifications?|reminders?|list|text\s+list|mailing\s+list)`;
const PHRASES = [
  // "stop texting me", "please stop messaging this number", "stop sending me texts"
  /\bstop\s+(?:texting|txting|messaging|contacting|sending\s+(?:me\s+)?(?:texts?|messages?))\b/i,
  // "no more texts", "stop the texts", "stop all these messages"
  new RegExp(String.raw`\b(?:no\s+more|stop\s+(?:the|these|all|your|all\s+(?:the|these|your)))\s+(?:texts?|txts?|messages?|msgs?|sms)\b`, 'i'),
  // "don't text me", "do not message this number", "never text me again"
  /\b(?:don'?t|do\s+not|never)\s+(?:text|txt|message|msg|contact|sms)\s+(?:me|this\s+number)\b/i,
  // "unsubscribe me", "leave me alone"
  /\b(?:unsubscribe\s+me|leave\s+me\s+alone)\b/i,
  // Whole-message opt-out phrasing only: "opt out", "please opt me out", "I want to opt out of these texts",
  // "remove me from your list", "take me off the list", "remove me". Not "opt out of the 3pm slot".
  new RegExp(String.raw`^\W*(?:please\s+)?(?:i\s+(?:want|wish|would\s+like|'d\s+like)\s+to\s+)?(?:opt\s*-?\s*(?:me\s+)?out|remove\s+me|take\s+me\s+off|unsubscribe)(?:\s+(?:of|from|off)?\s*(?:all\s+|these\s+|your\s+|the\s+|this\s+|my\s+)*${TEXTS})?${END}`, 'i'),
  // Bare stop with a softener: "stop please", "STOP IT", "stop now pls". Not "stop leak under sink" / "stop by at 3".
  new RegExp(String.raw`^\W*stop(?:\s+(?:it|that|this|now|please|pls|plz))?${END}`, 'i'),
];

// Always an opt-out, anywhere in a message of any length.
const STRONG = [
  /\b(?:quit|stop)\s+(?:\w+\s+){0,2}?(?:texting|txting|messaging|contacting|calling|sending\s+(?:me\s+)?(?:these|this|texts?|messages?|msgs?|them))\b/i,
  /\bwrong\s+(?:number|#|person)\b/i,
  /\blose\s+(?:my|this)\s+(?:number|#)\b/i,
  /\b(?:delete|erase)\s+(?:my|this)\s+(?:number|#)\b/i,
];

// ---- Spanish (matched on lowercase text with accents stripped) ----
// Whole message only (optionally with "por favor"/"ya"/"gracias"): basta, alto, cancelar, baja, pare, parar, detener.
// "para" counts ONLY as the entire message ("para el martes" = "for Tuesday").
const deaccent = (t) => normalize(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const ES_WHOLE = new Set(['basta', 'alto', 'cancelar', 'cancela', 'cancelen', 'baja', 'pare', 'paren', 'parar', 'detener', 'detente', 'deten']);
const ES_FILLER = new Set(['por', 'favor', 'porfa', 'porfavor', 'ya', 'gracias', 'ok', 'y']);
const ES_PHRASES = [
  /\bno\s+(?:me|nos)\s+(?:escrib(?:an|as|a|ir)|mand(?:en|es|e)|envi(?:en|es|e)|text(?:een|ees|ee)|contact(?:en|es|e)|llam(?:en|es|e)|moleste[ns]?)\b/,
  /\bdej(?:a|en|e)\s+de\s+(?:escribir|mandar|enviar|textear|molestar|llamar)\w*/,
  /\b(?:dar(?:me|nos)?|den(?:me|nos)?|dame|denos|quiero\s+darme)\s+de\s+baja\b/,
  /\bnumero\s+equivocado\b|\bse\s+equivoc(?:o|aron)\s+de\s+numero\b/,
  /\bno\s+(?:quiero|deseo)\s+(?:recibir\s+)?(?:mas\s+)?(?:mensajes|textos|sms)\b|\bno\s+mas\s+(?:mensajes|textos|sms)\b|\bya\s+no\s+(?:me\s+)?(?:escriban|manden|envien)\b/,
  /\bborr(?:en|a|e)\s+mi\s+numero\b/,
  /\bno\s+estoy\s+interesad[oa]\b|\bno\s+me\s+interesa\b/,
];
function spanishOptOut(raw) {
  const t = deaccent(raw);
  const w = t.match(/[a-z]+/g) || [];
  if (w.length === 1 && w[0] === 'para') return true;
  const core = w.filter((x) => !ES_FILLER.has(x));
  if (core.length === 1 && ES_WHOLE.has(core[0])) return true;
  return ES_PHRASES.some((re) => re.test(t));
}

// ---- English "stop" anywhere ----
// Stop tokens: stop/stopall/unsubscribe/optout, stretched or obfuscated spellings (stoooop, STOPP, st0p, stahp), 🛑.
// For each command occurrence of stop (not "won't stop", "to stop", "make it stop", which describe the problem):
//  - its own sentence/clause ("STOP! not today", "stop. over it", "... no. stop") or repeated -> opt-out, even if a
//    job word appears elsewhere; unless it is a correction ("stop, I meant Saturday", "stop, sorry, wait").
//  - followed directly by a job noun or "by" ("stop leak under sink", "Stop valve is broken", "stop by tomorrow",
//    "stop the leak") -> normal reply.
//  - otherwise: job noun or time present -> normal reply; else 5 words or fewer -> opt-out; longer -> 'maybe'.
const JOB_NOUNS = new Set(`leak leaks leaking leaky valve valves drip drips dripping water drain drains clog clogged toilet toilets
sink sinks faucet faucets pipe pipes tap taps cock heater hvac ac furnace thermostat breaker outlet wire wiring light lights
gas smell noise running flooding flood roof gutter shower tub hose sump pump meter bleeding braids hair appointment appt
tech technician plumber electrician`.split(/\s+/));
const DESCRIPTIVE = new Set('to wont doesnt didnt cant cannot never not it will would could should gonna wanna make made can isnt aint'.split(' '));
const CORRECTION = /^\s*[,.;:!\-]*\s*(?:i\s+meant|i\s+mean|sorry|wait|actually|no\s+wait|correction|scratch\s+that)\b/;
const REFUSALS = /\b(?:not\s+interested|no\s+longer\s+interested|go\s+away)\b/;
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)\b|\b\d{1,2}:\d{2}\b|\b(?:at|after|before|around|until)\s+\d/i;
const STOP_TOKENS = new Set(['stop', 'stopall', 'unsubscribe', 'optout', 'stahp', 'stopal']);
const prep = (raw) => normalize(raw).replace(/\u{1F6D1}/gu, ' stop ').toLowerCase().replace(/[’']/g, '');
const words = (t) => prep(t).match(/[a-z]+/g) || [];
const isStopToken = (tok) => STOP_TOKENS.has(tok) || STOP_TOKENS.has(tok.replace(/0/g, 'o').replace(/([a-z])\1+/g, '$1'));
function stopOccurrences(t) {
  const out = [], re = /[a-z0-9]+/g;
  let m, prev = null;
  while ((m = re.exec(t))) {
    const tok = m[0];
    if (/[a-z]/.test(tok) && isStopToken(tok)) {
      const rest = t.slice(m.index + tok.length);
      const next = (/^\s+(?:(?:the|my|this|that|a|an|your|our)\s+)?([a-z]+)/.exec(rest) || [])[1];
      out.push({
        descriptive: !!prev && DESCRIPTIVE.has(prev),
        standalone: /^\s*(?:$|[^a-z0-9\s])/.test(rest),
        correction: CORRECTION.test(rest),
        directJob: !!next && (next === 'by' || JOB_NOUNS.has(next)),
      });
    }
    prev = tok;
  }
  return out;
}
const hasJobWord = (w, t) => w.some((x) => JOB_NOUNS.has(x)) || TIME_RE.test(t);

// -> 'optout' (exact Twilio keyword) | 'revoke' (any other opt-out; app confirms once) | 'optin' | 'help'
//    | 'maybe' (longer message mentioning stop, no job word: pause the bot, ask the owner) | null
function classify(text) {
  const raw = String(text ?? '');
  const exact = exactKeyword(raw);
  if (OPT_OUT.includes(exact)) return 'optout';
  const k = letters(raw);
  if (OPT_OUT.includes(k)) return 'revoke';
  if (OPT_IN.includes(k)) return 'optin';
  if (HELP.includes(k)) return 'help';
  const n = normalize(raw);
  if (STRONG.some((re) => re.test(n)) || PHRASES.some((re) => re.test(n))) return 'revoke';
  if (spanishOptOut(raw)) return 'revoke';
  const t = prep(raw), w = words(raw), job = hasJobWord(w, t);
  const occ = stopOccurrences(t).filter((o) => !o.descriptive);
  if (!occ.length) {
    if (REFUSALS.test(t) && !job) return w.length <= 5 ? 'revoke' : 'maybe';
    // descriptive-only mentions ("wont stop") with no job context still count in short messages
    if (stopOccurrences(t).length && !job) return w.length <= 5 ? 'revoke' : 'maybe';
    return null;
  }
  const commands = occ.filter((o) => !o.correction);
  if (commands.some((o) => o.standalone) || commands.length >= 2) return 'revoke';
  if (!commands.length) return null; // "stop, I meant Saturday"
  if (commands[0].directJob || job) return null;
  return w.length <= 5 ? 'revoke' : 'maybe';
}
// 'es' when the message is a Spanish opt-out (the confirmation is then bilingual).
const language = (text) => (spanishOptOut(String(text ?? '')) ? 'es' : 'en');
module.exports = { classify, language, letters, normalize, words, OPT_OUT, OPT_IN, HELP };
