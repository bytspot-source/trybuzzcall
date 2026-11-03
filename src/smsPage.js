'use strict';
// Public per-shop SMS program page for A2P 10DLC review: GET /s/<slug>/sms.
// Slug = the shop's name, lowercased, non-alphanumerics -> '-'. The legacy single-shop line (root BUSINESS_NAME) claims
// a slug first, then vendor lines in creation order; a later line with the same slug gets '-<first 6 of its id>'.
// Only public fields are rendered: display name, the BuzzCall number, the voice opt-in script and sample texts. Never
// the owner phone, owner email or any setting. Every value is HTML-escaped.
const vendors = require('./vendors');
const consent = require('./consent');
const agent = require('./agent');
const shopContext = require('./shopContext');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function slugify(name) {
  return String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
}
const fmtPhone = (p) => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(p || '')); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : ''; };

// [{ slug, shop|null, number }] for every line that can have a public page.
function entries() {
  const out = [], taken = new Set();
  const add = (base, suffix, item) => {
    let slug = base || `shop-${suffix}`;
    if (taken.has(slug)) slug = `${base || 'shop'}-${suffix}`;
    if (taken.has(slug)) return;
    taken.add(slug); out.push({ ...item, slug });
  };
  const list = vendors.all();
  const legacyName = shopContext.run(null, () => consent.shopName());
  const legacyNumber = process.env.TWILIO_PHONE_NUMBER || '';
  if (legacyName && (!list.length || legacyNumber)) add(slugify(legacyName), 'legacy', { shop: null, number: legacyNumber });
  for (const shop of [...list].filter((s) => s.status === 'active').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    add(slugify(shop.name), shop.id.slice(0, 6), { shop, number: shop.phoneNumber || '' });
  }
  return out;
}
async function find(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  return entries().find((e) => e.slug === slug) || null;
}
const urlFor = (slug) => `/s/${encodeURIComponent(slug)}/sms`;

// Rendered inside the shop's context (config.env reads that shop's settings).
function render({ number }) {
  const name = consent.shopName();
  if (!name) return null;
  const phone = fmtPhone(number);
  let first;
  try { first = agent.firstMessage(); } catch { first = `Hi, this is ${name}. Sorry we missed your call! What's your name? Reply STOP to opt out, HELP for help. Msg & data rates may apply.`; }
  const bubble = (dir, text) => `<div class="bubble ${dir}">${esc(text)}</div>`;
  const spanish = /^(1|true|yes|on)$/i.test(String(require('./config').env.VOICE_CONSENT_SPANISH || ''));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} text messages | BuzzCall</title>
<meta name="description" content="${esc(`How ${name} texts callers who ask for a text back, powered by BuzzCall.`)}">
<link rel="stylesheet" href="/styles.css"></head><body>
<header class="site-header"><div class="wrap"><a class="brand" href="/">Try<span>BuzzCall</span></a>
<nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/sms-consent">SMS Consent</a></nav></div></header>
<main class="doc"><div class="wrap">
<h1>${esc(name)}: text messages</h1>
<p><b>${esc(name)}</b> uses BuzzCall missed-call text-back. When a call to ${esc(name)} is missed, the caller can choose to get a text to book or arrange a callback.</p>
<ul>
<li><b>Business:</b> ${esc(name)}</li>
<li><b>Texts come from:</b> ${phone ? `<a href="tel:${esc(number)}">${esc(phone)}</a>` : 'number being assigned'}</li>
<li><b>Powered by:</b> BuzzCall (TryBuzzCall LLC)</li>
</ul>

<h2>How callers opt in</h2>
<p>Nobody is texted just for calling. When the call is missed, the caller hears this message and is texted only if they press 1:</p>
<blockquote class="step"><i>"${esc(consent.voicePrompt(name))}"</i></blockquote>
${spanish ? `<p>Callers also hear it in Spanish:</p><blockquote class="step" lang="es"><i>"${esc(consent.spanishPrompt(name))}"</i></blockquote>` : ''}
<p>If the caller presses any other key or nothing, they hear a goodbye and get no text. Each answer is logged with the time and call ID.</p>

<h2>Sample messages</h2>
<div class="phone"><div class="lbl">Caller's phone</div>
${bubble('out', first)}
${bubble('in', 'HELP')}
${bubble('out', consent.helpText(name))}
${bubble('in', 'STOP')}
${bubble('out', consent.stopText(name))}
${bubble('in', 'START')}
${bubble('out', consent.startText(name))}
</div>

<h2>Program details</h2>
<ul>
<li><b>Message types:</b> replies about the caller's own service request: booking options, confirmations and callbacks. No marketing.</li>
<li><b>Message frequency varies.</b> <b>Message and data rates may apply.</b></li>
<li><b>Reply STOP to opt out, HELP for help.</b> Reply START to resubscribe. Carriers are not liable for delayed or undelivered messages.</li>
<li>Consent to receive texts is not a condition of purchase.</li>
<li>Mobile numbers and SMS opt-in data are not shared with or sold to third parties or affiliates for marketing purposes.</li>
<li>Help: ${esc(consent.SUPPORT_PHONE)} · <a href="mailto:${esc(consent.SUPPORT_EMAIL)}">${esc(consent.SUPPORT_EMAIL)}</a></li>
</ul>
<p>See the <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms</a> (including the <a href="/terms#sms">SMS Terms</a>).</p>
</div></main>
<footer class="site-footer"><div class="wrap">
<nav aria-label="Legal"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/sms-consent">SMS Consent</a></nav>
<p style="margin:.6rem 0 0"><small style="color:#9fb3cf">${esc(name)} text messages are powered by BuzzCall (TryBuzzCall LLC).</small></p>
</div></footer></body></html>`;
}
module.exports = { slugify, entries, find, render, urlFor, esc };
