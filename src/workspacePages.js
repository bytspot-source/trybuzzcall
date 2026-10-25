'use strict';
// Pure HTML renderers. Authentication, tenant selection, validation and writes belong to the routes.
const { esc, page, badge, date, empty, icon } = require('./ui');

const adminShell = {
  basePath: '/admin', caption: 'PLATFORM ADMIN', breadcrumb: 'Platform admin',
  businessName: 'BuzzCall platform', identityCaption: 'Platform administrator',
  nav: [['vendors', 'Vendors', 'overview', '/admin'], ['legacy', 'Legacy workspace', 'database', '/admin/legacy']],
  active: 'vendors', headerAction: { href: '/vendor/login', label: 'Vendor sign in', icon: 'external' },
};
const vendorShell = {
  basePath: '/vendor', caption: 'VENDOR WORKSPACE', breadcrumb: 'Vendor workspace', identityCaption: 'Vendor owner',
  nav: [['overview', 'Overview', 'overview', '/vendor'], ['leads', 'Leads', 'phone', '/vendor#leads'],
    ['bookings', 'Bookings', 'calendar', '/vendor#bookings'], ['payments', 'Payments', 'card', '/vendor#payments'],
    ['settings', 'Settings', 'settings', '/vendor/settings']],
  active: 'settings', headerAction: { href: '/vendor', label: 'Your workspace' }, logout: { action: '/vendor/logout' },
};
function heading(kicker, title, description) {
  return `<div class="page-heading"><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="page-description">${esc(description)}</p></div></div>`;
}
function panel(title, body) {
  return `<section class="panel"><div class="panel-header"><h2>${esc(title)}</h2></div><div class="panel-body">${body}</div></section>`;
}
function count(value) {
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value);
  return numeric && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}
function countText(value) { return count(value) ?? 'Not recorded'; }
function metric(label, value, note) {
  return `<article class="metric-card"><div class="metric-top">${esc(label)}</div><strong class="metric-value">${esc(value)}</strong><p>${esc(note)}</p></article>`;
}
function details(rows) {
  return `<dl class="detail-list">${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value ?? 'Not recorded')}</dd>`).join('')}</dl>`;
}
function table(headers, rows, label) {
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(label)}"><table class="data-table"><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
// Do not serialize arbitrary registry records: hashes, provider credentials and internal fields never reach HTML.
function publicShop(shop = {}) {
  return Object.fromEntries(['id', 'name', 'email', 'status', 'phoneNumber', 'createdAt', 'subscriptionStatus', 'bookingCount', 'leadCount', 'payoutStatus'].map(key => [key, shop[key]]));
}
function vendorPath(id) { return `/admin/vendors/${encodeURIComponent(String(id ?? ''))}`; }
function notices(error, message) {
  const text = error && (typeof error === 'string' ? error : error.message || 'Please review the form and try again.');
  return `${text ? `<div class="notice notice-error" id="form-error" role="alert">${esc(text)}</div>` : ''}${message ? `<div class="notice notice-good" role="status">${esc(message)}</div>` : ''}`;
}
function errorAttrs(error, name, hintId = '') {
  const descriptions = [error ? 'form-error' : '', hintId].filter(Boolean).join(' ');
  return `${descriptions ? ` aria-describedby="${esc(descriptions)}"` : ''}${error && error.field === name ? ' aria-invalid="true"' : ''}`;
}
function input(name, label, value = '', { type = 'text', required = false, readonly = false, hint = '', attrs = '', error } = {}) {
  const id = `field-${name}`;
  return `<label class="field" for="${esc(id)}">${esc(label)}<input id="${esc(id)}" name="${esc(name)}" type="${esc(type)}" value="${esc(value)}"${required ? ' required' : ''}${readonly ? ' readonly disabled' : ''}${errorAttrs(error, name, hint ? `${id}-hint` : '')}${attrs}>${hint ? `<small id="${esc(id)}-hint">${esc(hint)}</small>` : ''}</label>`;
}
function platform({ shops = [], setups = [], storage = {}, legacyName, legacyBilling, mode = 'live' } = {}) {
  const roster = shops.map(publicShop);
  const pending = setups.filter(setup => setup.status === 'pending');
  const total = key => roster.every(shop => count(shop[key]) !== null) ? roster.reduce((sum, shop) => sum + count(shop[key]), 0) : 'Not available';
  const cards = `<div class="metric-grid">${metric('Vendors', roster.length, 'Registered vendor records')}${metric('Active vendors', roster.filter(shop => shop.status === 'active').length, 'Status is active; not a delivery guarantee')}${metric('Bookings', total('bookingCount'), 'Recorded across the vendor roster')}${metric('Leads', total('leadCount'), 'Recorded across the vendor roster')}</div>`;
  const rows = roster.map(shop => `<tr><td><a class="text-action" href="${esc(vendorPath(shop.id))}">${esc(shop.name || 'Unnamed vendor')} ${icon('arrow')}</a><small class="cell-detail">${esc(shop.id)}</small></td><td>${esc(shop.email || 'Not recorded')}</td><td>${badge(shop.status || 'Not recorded')}</td><td>${esc(shop.phoneNumber || 'Not assigned')}</td><td>${esc(date(shop.createdAt))}</td><td>${esc(shop.subscriptionStatus || 'Not recorded')}</td><td>${esc(countText(shop.bookingCount))}</td><td>${esc(countText(shop.leadCount))}</td><td>${esc(shop.payoutStatus || 'Not recorded')}</td></tr>`).join('');
  const vendors = `<section class="panel"><div class="panel-header"><h2>Vendor roster</h2><span class="count-label">${roster.length} vendors</span></div>${rows ? table(['Vendor', 'Owner email', 'Status', 'Assigned phone', 'Created', 'Subscription', 'Bookings', 'Leads', 'Payouts'], rows, 'Vendor roster') : empty('No vendors yet', 'Create a vendor or approve a pending setup. No sample businesses are shown.')}</section>`;
  const requests = pending.length ? pending.map(setup => `<article class="workspace-request"><h3>${esc(setup.values?.businessName || 'Unnamed business')}</h3><p>${esc(setup.values?.email || 'Email not recorded')}</p>${badge(setup.status)}<details><summary>Review submitted business settings</summary>${details([['Owner alert phone',setup.values?.ownerPhone],['Forward calls to',setup.values?.forwardPhone],['City',setup.values?.city],['Trade',setup.values?.businessType],['Time zone',setup.values?.tz],['Open days',(setup.values?.days || []).join(', ')],['Hours',`${setup.values?.open || ''}–${setup.values?.close || ''}`],['Booking',setup.values?.booking ? 'On' : 'Off'],['Deposit',setup.values?.deposit ? setup.values.depositAmount : 'Off'],['Services',(setup.values?.services || []).map(s => `${s.name}: ${s.minutes} minutes`).join(', ')]])}</details><form method="post" action="/admin/vendors/approve"><input type="hidden" name="setupId" value="${esc(setup.id)}"><label class="checkbox-field"><input type="checkbox" name="confirm_setup" value="1" required><span>I have reviewed these settings and confirmed the owner's email.</span></label><button class="button button-primary" type="submit">Approve vendor setup</button></form></article>`).join('') : empty('No pending setups', 'Submitted setups awaiting approval will appear here.');
  const health = storage.degraded ? 'Degraded' : storage.fallback ? 'Fallback storage' : storage.backend ? 'No storage failure reported' : 'Not reported';
  const body = heading('Platform administration', 'Platform admin', 'Manage vendor access and assignments. Customer work stays inside each vendor workspace.') + cards + vendors +
    `<div class="grid-two">${panel('Pending setups', `<p>${pending.length} awaiting approval</p>${requests}`)}${panel('Create vendor', `<form method="post" action="/admin/vendors">${input('name', 'Business name', '', { required: true, attrs: ' maxlength="80"' })}${input('email', 'Owner email', '', { type: 'email', required: true, attrs: ' maxlength="254" autocomplete="email"' })}<button class="button button-primary" type="submit">Create vendor</button></form>`)}</div>` +
    panel('Platform service health', `${badge(health, storage.degraded || storage.fallback ? 'warning' : 'neutral')}${details([['Storage backend', storage.backend || 'Not reported'], ['Payment environment', mode]])}${storage.pathWarnings?.length ? `<p class="notice notice-warning"><b>path warning</b>: ${storage.pathWarnings.map(esc).join('; ')}</p>` : ''}<p class="muted">Platform storage status only. This does not verify vendor phone delivery or payout readiness.</p>`) +
    panel('Legacy workspace', `<p>${esc(legacyName || 'Legacy business records')} are separate from the vendor roster and are not assigned to any vendor.</p>${legacyBilling?.subscription?.status ? `<p>Legacy subscription: ${esc(legacyBilling.subscription.status)}</p>` : ''}<a class="text-action" href="/admin/legacy">Open legacy workspace ${icon('arrow')}</a>`);
  return page({ ...adminShell, title: 'Platform admin', body, mode, script: false });
}
function vendorDetail({ shop = {}, stats = {}, settings = {} } = {}) {
  const vendor = publicShop(shop), path = vendorPath(vendor.id);
  const body = heading('Platform administration · vendor record', vendor.name || 'Vendor details', 'Manage this vendor’s access and assigned phone. These controls are restricted to platform administrators.') +
    panel('Vendor record', details([['Vendor ID', vendor.id], ['Owner email', vendor.email], ['Status', vendor.status], ['Assigned phone', vendor.phoneNumber || 'Not assigned'], ['Created', date(vendor.createdAt)],
      ['Subscription', vendor.subscriptionStatus], ['Bookings', countText(stats.bookingCount ?? vendor.bookingCount)], ['Leads', countText(stats.leadCount ?? vendor.leadCount)], ['Payouts', vendor.payoutStatus],
      ['City', settings.BUSINESS_CITY], ['Time zone', settings.BUSINESS_TZ]])) +
    `<div class="grid-two">${panel('Vendor access', `<form method="post" action="${esc(path)}/status"><label class="field" for="vendor-status">Access status<select id="vendor-status" name="status" required><option value="active"${vendor.status === 'active' ? ' selected' : ''}>Active</option><option value="suspended"${vendor.status === 'suspended' ? ' selected' : ''}>Suspended</option></select></label><button class="button button-primary" type="submit">Update access status</button></form>`)}${panel('Invitation or password reset', `<p>Generate a one-use activation code to share privately with the owner. This action revokes existing vendor sessions. No email is sent by this page.</p><form method="post" action="${esc(path)}/invite"><button class="button button-danger" type="submit">Create activation code and revoke existing sessions</button></form>`)}</div>` +
    panel('Phone assignment', `<p>Phone routing changes require administrator review and confirmation. Server validation must also approve the assignment.</p><form method="post" action="${esc(path)}/phone">${input('phoneNumber', 'Assigned phone number', vendor.phoneNumber || '', { type: 'tel', hint: 'International format, including the + country code.' })}<label class="checkbox-field"><input type="checkbox" name="confirm_phones" value="1" required><span>I have reviewed and confirm this phone assignment.</span></label><button class="button button-primary" type="submit">Save phone assignment</button></form>`) +
    panel('Owner contact and call forwarding', `<p>These destinations belong only to this vendor. Confirm them with the owner before saving.</p><form method="post" action="${esc(path)}/contacts">${input('OWNER_PHONE','Owner alert phone',settings.OWNER_PHONE || '',{type:'tel',required:true})}${input('FORWARD_TO_PHONE','Forward calls to (optional)',settings.FORWARD_TO_PHONE || '',{type:'tel'})}<label class="checkbox-field"><input type="checkbox" name="confirm_phones" value="1" required><span>I have confirmed these destinations with this vendor.</span></label><button class="button button-primary" type="submit">Save contact routing</button></form>`);
  return page({ ...adminShell, title: 'Vendor details', body, script: false });
}
function auth({ kind = 'login', error, message } = {}) {
  const activate = kind === 'activate', title = activate ? 'Activate vendor access' : 'Vendor sign in';
  const password = input('password', activate ? 'New password' : 'Password', '', { type: 'password', required: true, error,
    attrs: ` minlength="16" maxlength="128" autocomplete="${activate ? 'new-password' : 'current-password'}"`, hint: 'Use 16–128 characters.' });
  const fields = activate ? input('token', 'One-use activation code', '', { required: true, error, attrs: ' autocomplete="off" spellcheck="false"', hint: 'Paste the code shared privately by your platform administrator. Do not put it in a URL.' }) + password + input('passwordConfirm', 'Confirm new password', '', { type: 'password', required: true, error, attrs: ' minlength="16" maxlength="128" autocomplete="new-password"' })
    : input('email', 'Owner email', '', { type: 'email', required: true, error, attrs: ' maxlength="254" autocomplete="username"' }) + password;
  const body = `<div class="workspace-auth">${heading('Vendor access · not platform administration', title, activate ? 'Set a password for your own business workspace.' : 'Sign in to see only your business’s leads, bookings and payments.')}${notices(error, message)}${panel(title, `<form method="post" action="/vendor/${activate ? 'activate' : 'login'}"${error ? ' aria-describedby="form-error"' : ''}>${fields}<button class="button button-primary" type="submit">${activate ? 'Activate access' : 'Sign in'}</button></form><a class="text-action" href="/vendor/${activate ? 'login' : 'activate'}">${activate ? 'Already activated? Sign in' : 'Have an activation code?'}</a>`)}</div>`;
  return page({ title, body, area: 'payment', script: false, headerAction: { href: '/admin', label: 'Platform admin · separate access', icon: 'shield' } });
}
function invitation({ shop = {}, token = '' } = {}) {
  // Private admin response only: routes must prohibit caching/logging this response and its token.
  const vendor = publicShop(shop);
  const body = heading('Private · platform administrator only', 'Vendor activation code', 'Share this code privately with the intended owner. It is not an email delivery confirmation.') +
    panel('One-use activation code', `<p>Business: <strong>${esc(vendor.name || 'Vendor')}</strong></p><p>Owner email: ${esc(vendor.email)}</p><p>This code expires in 24 hours and can be used only once. Treat it like a password; do not include it in logs, public messages, screenshots or URLs.</p><pre class="activation-code" aria-label="One-use activation code"><code>${esc(token)}</code></pre><ol><li>Send the code privately to the intended owner.</li><li>Ask them to open <a href="/vendor/activate">Vendor activation</a> and paste the code into the form.</li><li>They choose a new password to access their own workspace.</li></ol><a class="text-action" href="${esc(vendorPath(vendor.id))}">Back to vendor record ${icon('arrow')}</a>`);
  return page({ ...adminShell, title: 'Private vendor invitation', body, script: false });
}
const settingsFields = [
  ['BUSINESS_NAME', 'Business name', 'text', 'The name your customers know.'],
  ['BUSINESS_CITY', 'City and state', 'text', 'Include your state.'],
  ['BUSINESS_TZ', 'Time zone', 'text', 'Use an IANA time zone, such as America/New_York.'],
  ['BUSINESS_DAYS', 'Open days', 'text', 'Comma-separated day numbers: 0 is Sunday, 6 is Saturday.'],
  ['BUSINESS_HOURS', 'Business hours', 'text', '24-hour opening and closing times, for example 09:00-17:00.'],
  ['SERVICES', 'Services and durations', 'textarea', 'Comma-separated service:minutes entries. Do not include prices.'],
  ['BOOKING_ENABLED', 'Offer appointment times', 'boolean'], ['DEPOSIT_ENABLED', 'Collect booking deposits', 'boolean'],
  ['DEPOSIT_AMOUNT', 'Deposit amount (USD)', 'number'], ['SLOT_MINUTES', 'Appointment window (minutes)', 'number'],
  ['HOLD_MINUTES', 'Unpaid hold duration (minutes)', 'number'], ['BOOKING_LEAD_MINUTES', 'Minimum booking notice (minutes)', 'number'],
  ['BOOKING_LINK', 'External booking link', 'url', 'Use a full https:// address, or leave blank.'],
];
function settings({ shop = {}, values = {}, error, message } = {}) {
  const vendor = publicShop(shop);
  const fields = settingsFields.map(([name, label, type, hint]) => {
    const value = values[name] ?? (name === 'BUSINESS_NAME' ? vendor.name || '' : '');
    if (type === 'boolean') {
      const enabled = /^(1|true|on|yes)$/i.test(String(value));
      return `<label class="field" for="field-${name}">${esc(label)}<select id="field-${name}" name="${name}"${errorAttrs(error, name)}><option value="0"${enabled ? '' : ' selected'}>Off</option><option value="1"${enabled ? ' selected' : ''}>On</option></select></label>`;
    }
    if (type === 'textarea') return `<label class="field" for="field-${name}">${esc(label)}<textarea id="field-${name}" name="${name}"${errorAttrs(error, name, 'services-hint')}>${esc(value)}</textarea><small id="services-hint">${esc(hint)}</small></label>`;
    return input(name, label, value, { type, hint, error, required: name === 'BUSINESS_NAME', attrs: type === 'number' ? ` min="0" step="${name === 'DEPOSIT_AMOUNT' ? '0.01' : '1'}"` : '' });
  }).join('');
  const body = heading('Vendor workspace · your business only', 'Your settings', 'Update your business details and booking preferences. Phone routing is managed by a platform administrator.') + notices(error, message) +
    panel('Business and booking settings', `<form method="post" action="/vendor/settings"${error ? ' aria-describedby="form-error"' : ''}><div class="workspace-form-grid">${fields}</div><button class="button button-primary" type="submit">Save your settings</button></form>`) +
    panel('Phone routing · read only', `${details([['Assigned business line', vendor.phoneNumber || 'Not assigned']])}${input('OWNER_PHONE', 'Owner alert phone', values.OWNER_PHONE || '', { type: 'tel', readonly: true })}${input('FORWARD_TO_PHONE', 'Forward calls to', values.FORWARD_TO_PHONE || '', { type: 'tel', readonly: true })}<p class="muted">Contact your platform administrator to request phone changes. These fields cannot be changed here.</p>`);
  return page({ ...vendorShell, title: 'Your settings', body, businessName: vendor.name || 'Your business', ownerEmail: vendor.email, script: false });
}
function message({ title = 'Workspace notice', message: text = 'Please try again or contact support.', status } = {}) {
  return page({ title, area: 'payment', script: false, body: `<section class="result-card">${heading('BuzzCall workspace', title, text)}${status != null ? `<p class="muted">Status: ${esc(status)}</p>` : ''}<div class="action-row"><a class="button button-primary" href="/vendor/login">Vendor sign in</a><a class="button button-outline" href="/admin">Platform admin · separate access</a></div></section>` });
}
module.exports = { platform, vendorDetail, auth, invitation, settings, message };
