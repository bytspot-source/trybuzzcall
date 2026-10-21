// Conversation. home_services: name -> need -> slot (if BOOKING_ENABLED) or callback window.
// braiders (VERTICAL=braiders): name -> service from SERVICES menu (+ size/length) -> preferred day -> start time or callback.
// OpenAI phrasing if key set, else templates.
const biz = () => process.env.BUSINESS_NAME || 'our team';
const booking = require('./booking');
const isBraiders = () => booking.vertical() === 'braiders';
const vertical = () => (isBraiders() ? 'braiders' : (process.env.BUSINESS_VERTICAL || 'plumber').toLowerCase());

const TEMPLATES = {
  plumber: {
    first: () => `Hi, this is ${biz()}. Sorry we missed your call! We're likely on a job. What's your name? Reply STOP to opt out, HELP for help. Msg & data rates may apply.`,
    need: (n) => `Thanks ${n}! What's going on - leak, clog, water heater, something else? Any active flooding?`,
    window: () => `Got it. When's a good time for a callback today (e.g. "now", "after 3pm")?`,
    done: (n, w) => `Thanks ${n}, we'll call you back ${w}. If water is actively leaking, shut off your main valve.`,
  },
  hvac: {
    first: () => `Hi, this is ${biz()}. Sorry we missed your call! What's your name? Reply STOP to opt out, HELP for help. Msg & data rates may apply.`,
    need: (n) => `Thanks ${n}! What's happening - no cooling, no heat, noise, maintenance? Anyone vulnerable in the home?`,
    window: () => `Got it. When's a good time for a callback (e.g. "now", "after 3pm")?`,
    done: (n, w) => `Thanks ${n}, a tech will call you back ${w}. Stay safe!`,
  },
  braiders: {
    first: () => `Hi, this is ${biz()}! Sorry I missed your call - I'm probably in the middle of a client's hair. I can get you booked by text. What's your name? Reply STOP to opt out, HELP for help. Msg & data rates may apply.`,
    need: (n) => `Nice to meet you, ${n}! Which style are you looking for?\n${serviceMenu()}\nReply with the number. If you know the size and length you want (like "medium, mid-back"), add that too.`,
    day: (svc) => `Got it - ${svc}. What day works best for you? (e.g. "Saturday", "10/24", or "soonest")`,
    window: () => `No problem. When's a good time for me to call you back (e.g. "tonight after 7", "tomorrow morning")?`,
    done: (n, w) => `Thanks ${n}! I'll call you back ${w}.${linkLine()}`,
  },
};
const fmtMin = (m) => { const h = m / 60; return h >= 1 ? `~${Number.isInteger(h) ? h : h.toFixed(1)} hr${h === 1 ? '' : 's'}` : `~${m} min`; };
const serviceMenu = () => booking.cfg().services.map((s, i) => `${i + 1}) ${s.name} (${fmtMin(s.minutes)})`).join('\n');
const linkLine = () => (booking.cfg().bookingLink ? `\nYou can also book on my page anytime: ${booking.cfg().bookingLink}` : '');
const slotPrompt = (slots, lead) => {
  const list = slots.map((s, i) => `${i + 1}) ${s.label}`).join('\n');
  if (!isBraiders()) return `Got it. Next available times:\n${list}\nReply 1, 2 or 3 to book, or "callback" for a call instead.`;
  const pre = lead?.prefDay && !sameDay(new Date(slots[0].start), lead.prefDay) ? `I'm booked up that day, here are the closest openings` : `Here's what I have open`;
  return `${pre} for ${lead?.service || 'your appointment'}:\n${list}\nReply 1, 2 or 3 to book, or "call" if you'd rather I call you.${linkLine()}`;
};
const sameDay = (a, b) => a.toDateString() === new Date(b).toDateString();

// Braiders: pick a service by number or by name; anything else in the reply is kept as size/length notes.
function pickService(text) {
  const list = booking.cfg().services;
  const n = text.match(/^\s*#?(\d{1,2})\b/);
  let svc = n ? list[Number(n[1]) - 1] : null;
  if (!svc) {
    const low = text.toLowerCase();
    svc = list.find((s) => low.includes(s.name.toLowerCase()))
      || list.find((s) => { const w = s.name.toLowerCase().split(/\s+/)[0].replace(/s$/, ''); return w.length >= 3 && new RegExp(`\\b${w}`).test(low); });
  }
  if (!svc) return null;
  let rest = n ? text.replace(n[0], '') : text;
  if (!n) for (const w of svc.name.toLowerCase().split(/\s+/)) rest = rest.replace(new RegExp(`\\b${w.replace(/s$/, '')}s?\\b`, 'i'), '');
  const details = rest.replace(/\b(please|pls|plz|thanks|thank you|i want|i'?d like|looking for)\b/gi, '').replace(/\s{2,}/g, ' ').replace(/^[\s,.:;-]+|[\s,.;-]+$/g, '').trim();
  return { svc, details };
}
// Preferred day: today/tomorrow, weekday name, M/D, "Oct 24"; "soonest"/"any"/unknown = null (earliest open).
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseDay(text, now = new Date()) {
  const t = text.toLowerCase(), d = new Date(now); d.setHours(0, 0, 0, 0);
  if (/\btoday\b|\btonight\b/.test(t)) return d;
  if (/\btomorrow\b|\btmrw\b/.test(t)) { d.setDate(d.getDate() + 1); return d; }
  const md = t.match(/\b(\d{1,2})\/(\d{1,2})\b/) || (() => { const m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/); return m ? [m[0], MONTHS.indexOf(m[1]) + 1, m[2]] : null; })();
  if (md) { const x = new Date(d.getFullYear(), Number(md[1]) - 1, Number(md[2])); if (x < d) x.setFullYear(x.getFullYear() + 1); return x; }
  const w = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
  if (w) { const add = (DAYS.indexOf(w[1]) - d.getDay() + 7) % 7; d.setDate(d.getDate() + add); return d; }
  return null;
}
const URGENT = /flood|burst|gas|no heat|smoke|sewage|emergency|asap|urgent/i;

async function polish(fallback, context) {
  if (!process.env.OPENAI_API_KEY) return fallback;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini', max_tokens: 120,
        messages: [
          { role: 'system', content: isBraiders()
            ? `You text missed callers for ${biz()}, a hair braiding stylist in Atlanta, writing as the stylist ("I"). Rewrite the draft as one warm, plain SMS under 300 chars. Keep the same question/intent and any numbered list or link exactly. No prices, no urgency, no promises.`
            : `You text missed callers for ${biz()}, a Georgia ${vertical()} business. Rewrite the draft as one friendly SMS under 300 chars. Keep the same question/intent. No prices, no promises of arrival times.` },
          { role: 'user', content: `Context: ${context}\nDraft: ${fallback}` },
        ],
      }),
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || fallback;
  } catch { return fallback; }
}

// Returns { reply, completed, booking? }
async function handleReply(lead, text) {
  const t = TEMPLATES[vertical()] || TEMPLATES.plumber;
  const clean = text.trim().slice(0, 300);
  if (lead.step === 'name') {
    lead.name = clean.replace(/^((hi|hey|hello|yes|yeah|this is|it'?s|i'?m|im|my name is|name'?s)\b[\s,!.:-]*)+/i, '').split(/[,.!]/)[0].trim() || clean;
    lead.step = 'need';
    return { reply: await polish(t.need(lead.name), clean) };
  }
  if (isBraiders() && lead.step === 'need') {
    const p = pickService(clean);
    if (!p) return { reply: `Sorry, which style? Reply with a number:\n${serviceMenu()}` };
    lead.service = p.svc.name; lead.serviceMinutes = p.svc.minutes; lead.details = p.details || null;
    lead.need = p.details ? `${p.svc.name} (${p.details})` : p.svc.name; lead.urgent = false;
    if (booking.cfg().booking) { lead.step = 'day'; return { reply: await polish(t.day(p.svc.name), clean) }; }
    lead.step = 'window';
    return { reply: await polish(t.window(), clean) };
  }
  if (lead.step === 'day') {
    if (/^\s*(call|call ?back|call me)\s*$/i.test(clean)) { lead.step = 'window'; return { reply: await polish(t.window(), clean) }; }
    const pref = parseDay(clean); lead.prefDay = pref ? pref.toISOString() : null; lead.prefDayText = clean;
    const slots = booking.nextSlots(3, { minutes: lead.serviceMinutes, from: pref });
    if (slots.length) { lead.offered = slots; lead.step = 'slot'; return { reply: slotPrompt(slots, lead) }; }
    lead.step = 'window';
    return { reply: `I don't have an opening that fits ${lead.service} in the next few weeks. ${t.window()}${linkLine()}` };
  }
  if (lead.step === 'need') {
    lead.need = clean; lead.urgent = URGENT.test(clean);
    if (booking.cfg().booking) {
      const slots = booking.nextSlots(3);
      if (slots.length) {
        lead.offered = slots; lead.step = 'slot';
        return { reply: slotPrompt(slots) };
      }
    }
    lead.step = 'window';
    return { reply: await polish(t.window(), clean) };
  }
  if (lead.step === 'slot') {
    if (/call\s*-?\s*back/i.test(clean) || (isBraiders() && /^\s*call( me)?\s*$/i.test(clean))) { lead.step = 'window'; return { reply: await polish(t.window(), clean) }; }
    const n = parseInt(clean.match(/[1-3]/)?.[0], 10);
    const slot = lead.offered?.[n - 1];
    if (!slot) return { reply: `Please reply 1, 2 or 3 to pick a time, or "${isBraiders() ? 'call' : 'callback'}" for a call instead.` };
    const b = booking.hold(lead, slot);
    if (!b) {
      const slots = booking.nextSlots(3, isBraiders() ? { minutes: lead.serviceMinutes, from: lead.prefDay ? new Date(lead.prefDay) : null } : {}); lead.offered = slots;
      if (!slots.length) { lead.step = 'window'; return { reply: `Sorry, that time was just taken. ${t.window()}` }; }
      return { reply: `Sorry, that time was just taken. ${slotPrompt(slots, lead)}` };
    }
    lead.bookingId = b.id; lead.window = `booked ${slot.label}`; lead.step = 'done'; lead.status = 'done';
    return { booking: b, completed: true, reply: null }; // server sends deposit/confirmation text
  }
  if (lead.step === 'window') {
    lead.window = clean; lead.step = 'done'; lead.status = 'done';
    return { reply: await polish(t.done(lead.name, clean), clean), completed: true };
  }
  return { reply: isBraiders() ? `Thanks! I have your info and will get back to you soon.` : `Thanks! ${biz()} has your info and will call you back.` };
}

// Booking/deposit texts (sent by server.js). Braiders get stylist wording; home_services keep the original text.
const texts = {
  held: (name, b, holdMin, url) => isBraiders()
    ? `Thanks ${name}! I'm holding ${b.service ? b.service + ', ' : ''}${b.slotLabel} for you for ${holdMin} min. A $${b.amount} deposit (goes toward your service) locks it in: ${url}`
    : `Thanks ${name}! We're holding ${b.slotLabel} for you for ${holdMin} min. A $${b.amount} deposit (applied to your bill) confirms it: ${url}`,
  heldNoLink: (name, b) => isBraiders()
    ? `Thanks ${name}! I'm holding ${b.slotLabel} for you. I'll text you a deposit link shortly to lock it in.`
    : `Thanks ${name}! We're holding ${b.slotLabel} for you. We'll text you a deposit link shortly to confirm.`,
  bookedNoDeposit: (name, b) => isBraiders()
    ? `You're booked, ${name}: ${b.service ? b.service + ', ' : ''}${b.slotLabel}. See you then!`
    : `You're booked, ${name}: ${b.slotLabel}. ${process.env.BUSINESS_NAME || 'We'} will text when the tech is on the way.`,
  paid: (b) => isBraiders()
    ? `Deposit received - you're booked, ${b.name}! ${b.service ? b.service + ', ' : ''}${b.slotLabel}. Your $${b.amount} goes toward your service. See you then!`
    : `Deposit received - you're confirmed for ${b.slotLabel}, ${b.name}! ${process.env.BUSINESS_NAME || 'We'} will text when the tech is on the way.`,
  paidConflict: (b) => isBraiders()
    ? `Thanks ${b.name}, I got your deposit, but your hold on ${b.slotLabel} had run out and that time was taken. I'll reach out to find you a new time.`
    : `Thanks ${b.name}, we got your deposit but your hold on ${b.slotLabel} had expired and the slot was taken. We'll call you to reschedule.`,
};

const firstMessage = () => (TEMPLATES[vertical()] || TEMPLATES.plumber).first();
module.exports = { handleReply, firstMessage, texts, isBraiders, parseDay, pickService };
