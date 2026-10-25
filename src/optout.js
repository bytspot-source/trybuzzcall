// Inbound SMS consent keywords. Twilio's default opt-out keywords (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, and
// the newer OPTOUT, REVOKE) and opt-in keywords (START, UNSTOP, YES), plus HELP/INFO. Matching is case- and
// punctuation-insensitive on the whole message, like Twilio's. Plain-language revocations ("please stop texting me")
// are also honoured: the FCC requires honouring revocation "by any reasonable means".
const OPT_OUT = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'];
const OPT_IN = ['START', 'UNSTOP', 'YES'];
const HELP = ['HELP', 'INFO'];
const norm = (t) => String(t || '').toUpperCase().replace(/[^A-Z]/g, '');
const PHRASES = [
  /\bstop\s+(texting|messaging|sending|contacting|txting|texts?|messages?)\b/i,
  /\b(no\s+more|stop\s+(the|these|all|your))\s+(texts?|messages?|sms|txts?)\b/i,
  /\b(don'?t|do\s+not|never)\s+(text|txt|message|contact|sms)\s+(me|this\s+number)\b/i,
  /\b(opt\s*-?\s*(me\s+)?out|unsubscribe\s+me|remove\s+me|take\s+me\s+off|leave\s+me\s+alone)\b/i,
  /^\s*stop\b(?!\s+(by|in|over|at)\b)/i, // "Stop.", "stop please", "STOP!!" (not "stop by tomorrow")
];
// -> 'optout' | 'optin' | 'help' | 'revoke' (plain-language opt-out) | null
function classify(text) {
  const k = norm(text);
  if (OPT_OUT.includes(k)) return 'optout';
  if (OPT_IN.includes(k)) return 'optin';
  if (HELP.includes(k)) return 'help';
  if (PHRASES.some((re) => re.test(String(text || '')))) return 'revoke';
  return null;
}
module.exports = { classify, OPT_OUT, OPT_IN, HELP };
