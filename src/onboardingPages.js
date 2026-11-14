'use strict';
// HTML for the self-serve checklist and the admin onboarding queue. Renders the masked EIN only.
const { esc, page, badge, icon } = require('./ui');
const { publicRegistration } = require('./onboardingStore');

const adminNav = [
  ['vendors', 'Vendors', 'overview', '/admin'],
  ['onboarding', 'Onboarding', 'checklist', '/admin/onboarding'],
  ['outcomes', 'Outcomes', 'checklist', '/admin/outcomes'],
  ['deposits', 'Deposits', 'card', '/admin/deposits'],
  ['legacy', 'Legacy workspace', 'database', '/admin/legacy'],
];
function shell(title, body) {
  return page({
    title, body, active: 'onboarding', nav: adminNav, basePath: '/admin', caption: 'PLATFORM ADMIN',
    breadcrumb: 'Platform admin', businessName: 'BuzzCall platform', identityCaption: 'Platform administrator',
    headerAction: { href: '/vendor/login', label: 'Vendor sign in', icon: 'external' }, script: false,
  });
}
const tone = (value) => ['approved', 'verified', 'purchased', 'manual', 'active', 'trialing'].includes(value) ? 'good'
  : ['rejected', 'failed'].includes(value) ? 'danger'
    : ['pending', 'in_review', 'queued', 'waiting_trial', 'pending_admin', 'purchasing'].includes(value) ? 'warning' : 'neutral';
function flagLabel(flag) {
  return {
    duplicate_phone: 'Duplicate phone', duplicate_email: 'Duplicate email', name_mismatch: 'Name mismatch',
    provisioning_failure: 'Provisioning failure', rejected_registration: 'Rejected registration',
    low_balance: 'Low balance', cap_hit: 'Cap hit', needs_business_type: 'Needs business type',
  }[flag] || flag;
}
const ENTITY_OPTIONS = [['llc', 'LLC'], ['corporation', 'Corporation'], ['partnership', 'Partnership'], ['sole_proprietor', 'Sole proprietor'], ['nonprofit', 'Nonprofit']];
function entitySelect(selected) {
  const options = ENTITY_OPTIONS.map(([value, label]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  return `<label class="field">Business type<select name="entity" required><option value=""${selected ? '' : ' selected'} disabled>Choose a business type</option>${options}</select><small>LLC, corporation, partnership, and nonprofit need an EIN. Sole proprietor does not.</small></label>`;
}
function ten(phone) {
  const m = /^\+1(\d{10})$/.exec(String(phone || ''));
  return m ? m[1] : '';
}
function forwarding(phone) {
  const n = ten(phone);
  if (!n) return '';
  const shown = `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  return `<section class="panel"><div class="panel-header"><h2>Forward missed calls</h2></div><div class="panel-body">
<p>Keep the number your customers already call, and send unanswered calls to <strong>${esc(shown)}</strong>. These are the usual no-answer codes. Dial them from the shop phone, then call yourself once to confirm. Carriers sometimes change them.</p>
<ul>
<li><strong>Verizon:</strong> dial <span class="mono">*71${esc(n)}</span> and send. Cancel with *73.</li>
<li><strong>AT&amp;T:</strong> dial <span class="mono">*61*${esc(n)}*11*20#</span> and send. Cancel with #61#.</li>
<li><strong>T-Mobile:</strong> dial <span class="mono">**61*1${esc(n)}#</span> and send. Cancel with ##61#.</li>
</ul>
<p>Or list <strong>${esc(shown)}</strong> as the phone on your Google Business Profile so new customers call this line directly.</p>
</div></section>`;
}

function passwordPage() {
  return page({
    title: 'Choose a password', area: 'payment', script: false,
    body: `<section class="payment-card"><p class="eyebrow">Shop setup</p><h1>Choose a password</h1>
<p>This signs you in to your BuzzCall shop. Use 16 to 128 characters.</p>
<form method="post" action="/onboarding/password"><label class="field">Password<input name="password" type="password" required minlength="16" maxlength="128" autocomplete="new-password"></label>
<label class="field">Confirm password<input name="passwordConfirm" type="password" required minlength="16" maxlength="128" autocomplete="new-password"></label>
<button class="button button-primary" type="submit">Save password and continue</button></form></section>`,
  });
}
function checklist(model) {
  if (!model) return '';
  const trialOn = model.trial === 'trialing' || model.trial === 'active';
  const steps = [
    ['Alert cell', 'verified', 'Verified'],
    ['Free trial', model.trial, model.trial === 'not_started' ? 'Not started' : model.trial],
    ['Local number', model.number, model.number],
    ['Text registration', model.registration, model.registration],
  ];
  const items = steps.map(([label, value, text]) => `<li>${esc(label)} ${badge(text.replaceAll('_', ' '), tone(value))}</li>`).join('');
  const trial = trialOn
    ? `<p>Your ${esc(model.trial === 'trialing' ? `${model.trialDays}-day trial` : 'subscription')} is on${model.price ? ` (${esc(model.price)} after the trial)` : ''}.</p>`
    : `<p>Start the ${esc(String(model.trialDays))}-day free trial with a card. The monthly plan is ${esc(model.price || 'billed by Stripe')}. The number and carrier registration wait until this trial starts. Checkout is the same billing page every shop uses.</p>
<form method="post" action="/vendor/billing/checkout"><input type="hidden" name="plan" value="monthly"><button class="button button-primary" type="submit">Start the ${esc(String(model.trialDays))}-day trial</button></form>`;
  const numberNote = {
    pending_admin: 'An admin will assign your local number.',
    waiting_trial: 'A local number is bought after the trial starts, matching your area code when one is available.',
    queued: model.numberError || 'The number is queued. Nothing was bought.',
    failed: model.numberError || 'The number could not be bought.',
    purchased: 'Your BuzzCall number is ready.',
    manual: 'Your number was assigned by BuzzCall.',
  }[model.number] || '';
  const reg = model.registrationForm || {};
  const locked = trialOn ? '' : '<p>You can fill this in now. It is submitted after the trial starts.</p>';
  const regStatus = `<p>Status: ${badge(String(model.registration || '').replaceAll('_', ' '), tone(model.registration))}${model.registrationError ? ` ${esc(model.registrationError)}` : ''}</p>`;
  const held = model.registration === 'approved' ? '<p>Customer text-backs are on.</p>' : '<p>Until carrier registration is approved, missed-call buzzes still come to you, and customer text-backs wait.</p>';
  const form = model.manualRegistration === false ? '' : `<form method="post" action="/vendor/onboarding/registration">${locked}
${entitySelect(reg.entity)}
<label class="field">Legal name<input name="legalName" required maxlength="120" value="${esc(reg.legalName || '')}" autocomplete="organization"></label>
<label class="field">EIN <span class="unit-label">(required except sole proprietor)</span><input name="ein" inputmode="numeric" autocomplete="off" maxlength="11" value="" placeholder="${reg.einMasked ? esc(reg.einMasked) : 'XX-XXXXXXX'}"></label>
<p class="muted">${reg.einOnFile ? `An EIN ending ${esc(reg.einMasked)} is saved. Leave this blank to keep it.` : 'Leave this blank only for a sole proprietor. Every other business type needs a 9-digit EIN.'}</p>
<label class="field">Street<input name="street" required maxlength="120" value="${esc(reg.street || '')}" autocomplete="address-line1"></label>
<label class="field">City<input name="city" required maxlength="80" value="${esc(reg.city || '')}" autocomplete="address-level2"></label>
<label class="field">State<input name="region" required maxlength="2" value="${esc(reg.region || '')}" autocomplete="address-level1"></label>
<label class="field">Postal code<input name="postalCode" required maxlength="10" value="${esc(reg.postalCode || '')}" autocomplete="postal-code"></label>
<label class="field">Website<input name="website" type="url" required maxlength="300" value="${esc(reg.website || '')}" placeholder="https://"></label>
<label class="field">Contact name<input name="contactName" required maxlength="80" value="${esc(reg.contactName || '')}" autocomplete="name"></label>
<label class="field">Contact email<input name="contactEmail" type="email" required maxlength="254" value="${esc(reg.contactEmail || '')}" autocomplete="email"></label>
<label class="field">Contact cell<input name="contactPhone" type="tel" required maxlength="20" value="${esc(reg.contactPhone || '')}" autocomplete="tel"></label>
<button class="button button-primary" type="submit">Save registration</button></form>`;
  const otp = model.flow === 'sole_proprietor' && model.registration !== 'approved' && model.registration !== 'pending_admin' && model.registration !== 'not_started'
    ? `<form method="post" action="/vendor/onboarding/otp"><p>The carrier texts a one-time code to your contact cell. Reply to that text. You can ask for it again if it expired.</p><button class="button button-outline" type="submit">Resend verification text</button></form>` : '';
  return `<section class="panel" id="onboarding"><div class="panel-header"><h2>Finish setting up ${esc(model.businessName || 'your shop')}</h2></div><div class="panel-body">
<ol class="next-steps">${items}</ol>
<h3>1. Trial</h3>${trial}
<h3>2. Number</h3><p>${esc(numberNote)}</p>${model.line ? `<p>Your line: <strong class="mono">${esc(model.line)}</strong></p>` : ''}
<h3>3. Carrier registration</h3>${regStatus}${held}${form}${otp}
</div></section>${forwarding(model.line)}`;
}

function queuePage(rows) {
  const body = rows.length ? rows.map((row) => {
    const shop = row.kind === 'shop';
    const flags = (row.flags || []).map((flag) => badge(flagLabel(flag), 'warning')).join(' ');
    const actions = shop ? `<form method="post" action="/admin/onboarding/${esc(row.id)}/retry"><button class="button button-outline" type="submit">Retry</button></form>
<form method="post" action="/admin/onboarding/${esc(row.id)}/suspend"><button class="button button-danger" type="submit">Suspend</button></form>
<form method="post" action="/admin/onboarding/${esc(row.id)}/provision"><label class="field">Assign a number<input name="phoneNumber" placeholder="+14045550199" required></label><label class="checkbox-field"><input type="checkbox" name="confirm_phones" value="1" required><span>I am assigning this number myself. Do not buy one.</span></label><button class="button button-primary" type="submit">Provision manually</button></form>
${row.manualRegistration ? `<form method="post" action="/admin/onboarding/${esc(row.id)}/registration"><label class="field">Record the carrier result<select name="status"><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label><label class="field">Reason<input name="reason" maxlength="300"></label><button class="button button-outline" type="submit">Save registration result</button></form>` : ''}
${shop && row.manualRegistration && row.registrationForm ? `<form method="post" action="/admin/onboarding/${esc(row.id)}/entity">${entitySelect(row.registrationForm.entity)}<label class="field">EIN, if this type needs one<input name="ein" inputmode="numeric" autocomplete="off" maxlength="11" value="" placeholder="${esc(row.registrationForm.einMasked || '9 digits')}"></label><label class="checkbox-field"><input type="checkbox" name="confirm" value="1" required><span>I am correcting this business type.</span></label><button class="button button-outline" type="submit">Save business type</button></form>` : ''}
<form method="post" action="/admin/onboarding/${esc(row.id)}/allow-phone"><label class="checkbox-field"><input type="checkbox" name="confirm" value="1" required><span>Allow another shop on ${esc(row.phone || 'this cell')}.</span></label><button class="button button-outline" type="submit">Allow another shop</button></form>` : '';
    return `<article class="panel"><div class="panel-header"><h2>${esc(row.name || 'Shop')}</h2>${badge(row.status || 'pending')}</div><div class="panel-body">
<dl class="detail-list"><dt>Email</dt><dd>${esc(row.email || '')}</dd><dt>Alert cell</dt><dd>${esc(row.phone || '')}</dd>
<dt>Verified</dt><dd>${badge(row.verified, tone(row.verified))}</dd><dt>Trial</dt><dd>${badge(row.trial, tone(row.trial))}</dd>
<dt>Number</dt><dd>${badge(String(row.number || '').replaceAll('_', ' '), tone(row.number))}${row.line ? ` ${esc(row.line)}` : ''}${row.numberError ? `<br>${esc(row.numberError)}` : ''}</dd>
<dt>Business type</dt><dd>${esc((ENTITY_OPTIONS.find(([value]) => value === row.registrationForm?.entity) || [])[1] || 'Not set')}</dd>
<dt>Registration</dt><dd>${badge(String(row.registration || '').replaceAll('_', ' '), tone(row.registration))}${row.registrationError ? `<br>${esc(row.registrationError)}` : ''}${row.registrationForm?.einMasked ? `<br>EIN ${esc(row.registrationForm.einMasked)}` : ''}</dd>
<dt>Attention</dt><dd>${flags || 'None'}</dd></dl>${actions}${shop ? `<p><a class="text-action" href="/admin/vendors/${esc(row.id)}">Open vendor ${icon('arrow')}</a></p>` : ''}</div></article>`;
  }).join('') : '<p>No shops are in onboarding.</p>';
  return shell('Onboarding', `<div class="page-heading"><p class="eyebrow">Platform administration</p><h1>Onboarding</h1><p>New self-serve shops, what is done, and what needs a person.</p></div>${body}`);
}

module.exports = { passwordPage, checklist, queuePage, forwarding, publicRegistration };
