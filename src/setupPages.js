// Server-rendered pages for the setup form (no-JS form posts) and the admin 'Shop setups' section.
const rules = require('./setupRules');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const VERT = { braiders: 'Braider', plumber: 'Plumbing', hvac: 'HVAC' };

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | BuzzCall</title><meta name="robots" content="noindex"><meta name="theme-color" content="#142b32">
<link rel="stylesheet" href="/home.css"><link rel="stylesheet" href="/setup.css"></head><body class="setup-page">
<header class="header"><div class="container header-inner"><a class="logo" href="/" aria-label="BuzzCall home"><span class="logo-mark" aria-hidden="true">⚡</span>buzzcall<span class="logo-period">.</span></a></div></header>
<main class="container setup-main setup-result">${body}</main></body></html>`;
}

const issueList = (items) => `<ul class="issue-list">${items.map((i) => `<li class="issue issue-${esc(i.level)}">${esc(i.message)}</li>`).join('')}</ul>`;

function thanksHtml(values) {
  return shell('Thanks', `<section class="setup-card thanks-card"><p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> Setup received</p>
<h1>Thanks${values.businessName ? `, ${esc(values.businessName)}` : ''}!</h1>
<p>We'll review your setup and text you within 1 business day${values.ownerPhone ? ` at ${esc(values.ownerPhone)}` : ''}. Nothing changes on your line until we check it with you.</p>
<p><a class="text-link" href="/">Back to BuzzCall <span aria-hidden="true">↗</span></a></p></section>`);
}

function errorsHtml(errors) {
  return shell('A couple things to fix', `<section class="setup-card"><h1>A couple things to fix</h1>${issueList(errors)}
<p>Use your browser's back button to fix these. Your answers are still there.</p></section>`);
}

// Re-posts every submitted field as hidden inputs plus confirm=1.
function confirmHtml(warnings, body) {
  const hidden = Object.entries(body || {}).filter(([k]) => k !== 'confirm' && /^[\w.[\]-]{1,40}$/.test(k))
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `<input type="hidden" name="${esc(k)}" value="${esc(typeof x === 'object' ? '' : x)}">`)).join('');
  return shell('Looks off, are you sure?', `<section class="setup-card"><h1>Looks off, are you sure?</h1>
<p>A few answers look unusual. They might be right, so it's your call.</p>${issueList(warnings)}
<form method="post" action="/setup">${hidden}<input type="hidden" name="confirm" value="1">
<button class="button button-yellow" type="submit">Yes, that's right. Send it</button></form>
<p>Want to change something? Use your browser's back button. Your answers are still there.</p></section>`);
}

function summary(v) {
  const svc = v.vertical === 'braiders' ? (v.services || []).map((s) => `${esc(s.name)} (${esc(rules.fmtDur(s.minutes))})`).join(', ') : '';
  return `<dl class="kv">
<dt>Business</dt><dd>${esc(v.businessName)} · ${esc(v.city)} · ${esc(VERT[v.vertical] || v.vertical)}</dd>
<dt>Phones</dt><dd>alert ${esc(v.ownerPhone)} · ring first ${esc(v.forwardPhone || '(none)')}${v.forwardPhone ? ` for ${esc(v.ringSeconds)}s` : ''}</dd>
<dt>Hours</dt><dd>${esc((v.days || []).map((d) => DAY[d]).join(', '))} ${esc(v.open)}-${esc(v.close)} (${esc(v.tz)})</dd>
${svc ? `<dt>Services</dt><dd>${svc}</dd>` : ''}
<dt>Booking</dt><dd>${v.booking ? `offer times${v.vertical !== 'braiders' ? `, ${esc(v.slotMinutes)} min windows` : ''}, ${esc(v.leadMinutes)} min notice` : 'callback only'}</dd>
<dt>Deposit</dt><dd>${v.deposit ? `$${esc(v.depositAmount)}, hold ${esc(v.holdMinutes)} min` : 'off'}</dd>
${v.bookingLink ? `<dt>Link</dt><dd>${esc(v.bookingLink)}</dd>` : ''}
<dt>Contact</dt><dd>${esc(v.email)}${v.consent ? ' · agreed to Terms/SMS consent' : ''}</dd></dl>`;
}

// Admin: submissions (with live re-check), Apply buttons, and the current effective config.
function adminSetupsHtml(setups, effective, override, cfg) {
  const rows = (setups || []).slice(0, 100).map((s) => {
    const { issues } = rules.validate(s.values);
    const errs = issues.filter((i) => i.level === 'error').length;
    return `<article class="setup-row"><h3>${esc(s.values.businessName || '(no name)')} <small>${esc(s.createdAt)} · <b>${esc(s.status)}</b>${s.appliedAt ? ` (applied ${esc(s.appliedAt)})` : ''} · id ${esc(s.id)}</small></h3>
${summary(s.values)}${issues.length ? `<p><b>Issues (${issues.length}):</b></p>${issueList(issues)}` : '<p>No issues.</p>'}
<form method="post" action="/admin/setups/${esc(s.id)}/apply" onsubmit="return confirm('Apply this setup to the live line? It overrides the env settings.')"><button${errs ? ' disabled title="Has errors"' : ''}>Apply to this line</button></form></article>`;
  }).join('');
  const conf = effective.map((e) => `<tr><td>${esc(e.key)}</td><td>${esc(e.value)}</td><td>${esc(e.source)}</td></tr>`).join('');
  const ov = override && override.values ? `<p>Override from setup <b>${esc(override.setupId || '?')}</b>, applied ${esc(override.appliedAt)}. <form method="post" action="/admin/config/reset" style="display:inline" onsubmit="return confirm('Clear the override and go back to env settings?')"><button>Clear override (back to env)</button></form></p>` : '<p>No override applied: using env settings and defaults.</p>';
  const days = (cfg.days || []).map((d) => DAY[d]).join(', ');
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `<h1 id="setups">Shop setups (${(setups || []).length})</h1><style>.setup-row{border:1px solid #ccc;padding:.5rem 1rem;margin:.5rem 0}.kv{display:grid;grid-template-columns:auto 1fr;gap:.2rem 1rem;margin:.3rem 0}.kv dt{font-weight:bold}.kv dd{margin:0}.issue-error{color:#a22b22}.issue-warning{color:#8a5a00}</style>
${rows || '<p>No setups submitted yet.</p>'}
<h2>Current effective config</h2>${ov}
<p>Running as: <b>${esc(cfg.vertical)}</b> · ${esc(days)} ${esc(hm(cfg.open))}-${esc(hm(cfg.close))} · booking ${cfg.booking ? 'on' : 'off'} · deposit ${cfg.deposit ? `$${esc(cfg.amount)} (hold ${esc(cfg.holdMin)} min)` : 'off'}${cfg.braiders ? ` · services ${esc(cfg.services.map((s) => `${s.name} ${s.minutes}m`).join(', '))}` : ` · ${esc(cfg.slotMin)} min slots`}</p>
<table><tr><th>Key</th><th>Value</th><th>Source (override &gt; env &gt; default)</th></tr>${conf}</table>`;
}

module.exports = { thanksHtml, errorsHtml, confirmHtml, adminSetupsHtml, esc };
