// Server-rendered pages for the setup form (no-JS form posts) and the admin 'Shop setups' section.
const rules = require('./setupRules');
const ui = require('./ui');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FLOW = { appointments: 'clients pick a service and time', jobs: 'customers describe a job' };
// "Nail tech / nail salon", or "Other: Piano lessons (clients pick a service and time)".
function tradeText(v) {
  const t = rules.tradeOf(v);
  if (!t) return v.vertical || '(no business type)';
  return t.key === 'other' ? `Other: ${v.tradeName || '(no trade name)'} (${FLOW[v.flow] || 'no booking style picked'})` : `${t.label} (${FLOW[t.flow]})`;
}

function shell(title, body) {
  return ui.page({ title, body, area: 'payment', mode: 'live', script: true });
}

const issueList = (items) => `<ul class="issue-list">${items.map((i) => `<li class="issue issue-${esc(i.level)}">${esc(i.message)}</li>`).join('')}</ul>`;

function thanksHtml(values) {
  return shell('Thanks', `<section class="payment-card"><span class="result-icon">${ui.icon('check')}</span><p class="eyebrow">Setup received</p>
<h1>Thanks${values.businessName ? `, ${esc(values.businessName)}` : ''}!</h1>
<p>We'll review your setup and text you within 1 business day${values.ownerPhone ? ` at ${esc(values.ownerPhone)}` : ''}. Nothing changes on your line until we check it with you.</p>
<div class="action-row"><a class="button button-outline" href="/">Back to BuzzCall ${ui.icon('arrow')}</a></div></section>`);
}

function errorsHtml(errors) {
  return shell('A couple things to fix', `<section class="payment-card"><span class="result-icon">${ui.icon('alert')}</span><p class="eyebrow">Review your setup</p><h1>A couple things to fix</h1>${issueList(errors)}
<p>Use your browser's back button to fix these. Your answers are still there.</p></section>`);
}

// Re-posts every submitted field as hidden inputs plus confirm=1.
function confirmHtml(warnings, body) {
  const hidden = Object.entries(body || {}).filter(([k]) => k !== 'confirm' && /^[\w.[\]-]{1,40}$/.test(k))
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `<input type="hidden" name="${esc(k)}" value="${esc(typeof x === 'object' ? '' : x)}">`)).join('');
  return shell('Looks off, are you sure?', `<section class="payment-card"><span class="result-icon">${ui.icon('checklist')}</span><p class="eyebrow">One more check</p><h1>Looks off, are you sure?</h1>
<p class="notice notice-warning">A few answers look unusual. They might be right, so it's your call.</p>${issueList(warnings)}
<form method="post" action="/setup">${hidden}<input type="hidden" name="confirm" value="1">
<button class="button button-primary button-full" type="submit">Yes, that's right. Send it</button></form>
<p>Want to change something? Use your browser's back button. Your answers are still there.</p></section>`);
}

function summary(v) {
  const appts = v.flow === 'appointments';
  const svc = appts ? (v.services || []).map((s) => `${esc(s.name)} (${esc(rules.fmtDur(s.minutes))})`).join(', ') : '';
  return `<dl class="detail-list">
<dt>Business</dt><dd>${esc(v.businessName)} · ${esc(v.city)} · ${esc(tradeText(v))}</dd>
<dt>Phones</dt><dd>alert ${esc(v.ownerPhone)} · ring first ${esc(v.forwardPhone || '(none)')}${v.forwardPhone ? ` for ${esc(v.ringSeconds)}s` : ''}</dd>
<dt>Hours</dt><dd>${esc((v.days || []).map((d) => DAY[d]).join(', '))} ${esc(v.open)}-${esc(v.close)} (${esc(v.tz)})</dd>
${svc ? `<dt>Services</dt><dd>${svc}</dd>` : ''}
<dt>Booking</dt><dd>${v.booking ? `offer times${v.flow === 'jobs' ? `, ${esc(v.slotMinutes)} min windows` : ''}, ${esc(v.leadMinutes)} min notice` : 'callback only'}</dd>
<dt>Deposit</dt><dd>${v.deposit ? `$${esc(v.depositAmount)}, hold ${esc(v.holdMinutes)} min` : 'off'}</dd>
${v.bookingLink ? `<dt>Link</dt><dd>${esc(v.bookingLink)}</dd>` : ''}
<dt>Contact</dt><dd>${esc(v.email)}${v.consent ? ' · agreed to Terms/SMS consent' : ''}</dd></dl>`;
}

// Admin: submissions (with live re-check), Apply buttons, and the current effective config.
function adminSetupsHtml(setups, effective, override, cfg) {
  const rows = (setups || []).slice(0, 100).map((s) => {
    const { issues } = rules.validate(s.values);
    const errs = issues.filter((i) => i.level === 'error').length;
    return `<article class="setup-row panel"><div class="panel-header"><div><h3>${esc(s.values.businessName || '(no name)')}</h3><p class="muted">Submitted ${esc(s.createdAt)}${s.appliedAt ? ` · applied ${esc(s.appliedAt)}` : ''} · id ${esc(s.id)}</p></div>${ui.badge(s.status, s.status === 'applied' ? 'good' : s.status === 'pending' ? 'warning' : 'neutral')}</div>
<div class="panel-body"><p>${esc(tradeText(s.values))} · ${esc(s.values.city)}</p><details><summary>Review submitted setup</summary>${summary(s.values)}</details>
${issues.length ? `<p><strong>Issues (${issues.length}):</strong></p>${issueList(issues)}` : '<p class="muted">No issues.</p>'}
<form method="post" action="/admin/setups/${esc(encodeURIComponent(s.id))}/apply" data-confirm="${esc('Apply this setup to the live line? It overrides the env settings.')}"><button class="button button-primary" type="submit"${errs ? ' disabled title="Has errors"' : ''}>Apply to this line</button></form></div></article>`;
  }).join('');
  const conf = effective.map((e) => `<tr><td>${esc(e.key)}</td><td>${esc(e.value)}</td><td>${esc(e.source)}</td></tr>`).join('');
  const ov = override && override.values ? `<div class="notice"><p>Override from setup <b>${esc(override.setupId || '?')}</b>, applied ${esc(override.appliedAt)}.</p><form method="post" action="/admin/config/reset" data-confirm="${esc('Clear the override and go back to env settings?')}"><button class="button button-danger" type="submit">Clear override (back to env)</button></form></div>` : '<p class="muted">No override applied: using env settings and defaults.</p>';
  const days = (cfg.days || []).map((d) => DAY[d]).join(', ');
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `<div class="page-heading"><p class="eyebrow">Line configuration</p><h2 id="setup-requests">Shop setups (${(setups || []).length})</h2><p class="muted">Review submissions before changing the live line. Applying a setup overrides environment settings.</p></div>
${rows || `<section class="panel">${ui.empty('No setups submitted yet.', 'New shop submissions will appear here for review.', 'checklist')}</section>`}
<section class="panel"><div class="panel-header"><h2>Current effective config</h2></div><div class="panel-body">${ov}
<p>Running as: <b>${esc(cfg.tradeLabel || cfg.vertical)}</b> (${esc(cfg.trade)}, ${esc(cfg.flow)} flow) · ${esc(days)} ${esc(hm(cfg.open))}-${esc(hm(cfg.close))} · booking ${cfg.booking ? 'on' : 'off'} · deposit ${cfg.deposit ? `$${esc(cfg.amount)} (hold ${esc(cfg.holdMin)} min)` : 'off'}${cfg.appointments ? ` · services ${esc(cfg.services.map((s) => `${s.name} ${s.minutes}m`).join(', '))}` : ` · ${esc(cfg.slotMin)} min slots`}</p>
<details><summary>View raw non-secret configuration</summary><div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Key</th><th scope="col">Value</th><th scope="col">Source (override &gt; env &gt; default)</th></tr></thead><tbody>${conf}</tbody></table></div></details></div></section>`;
}

module.exports = { thanksHtml, errorsHtml, confirmHtml, adminSetupsHtml, esc };
