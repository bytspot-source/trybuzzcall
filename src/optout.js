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
// Phrase rules are deliberately narrow so job descriptions don't count: "stop leak under sink", "Stop valve is broken",
// "stop, I meant Saturday", "opt out of the 3pm slot" are ordinary replies.
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

// -> 'optout' (exact Twilio keyword) | 'revoke' (any other opt-out; app confirms once) | 'optin' | 'help' | null
function classify(text) {
  const raw = String(text ?? '');
  const exact = exactKeyword(raw);
  if (OPT_OUT.includes(exact)) return 'optout';
  const k = letters(raw);
  if (OPT_OUT.includes(k)) return 'revoke';
  if (OPT_IN.includes(k)) return 'optin';
  if (HELP.includes(k)) return 'help';
  const t = normalize(raw);
  if (PHRASES.some((re) => re.test(t))) return 'revoke';
  return null;
}
module.exports = { classify, letters, normalize, OPT_OUT, OPT_IN, HELP };
