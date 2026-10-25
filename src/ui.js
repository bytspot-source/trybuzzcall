// Shared, dependency-free presentation helpers. Values are escaped at the HTML boundary.
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const paths = {
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  phone: '<path d="M8 3H4a1 1 0 0 0-1 1c0 9 8 17 17 17a1 1 0 0 0 1-1v-4l-5-2-2 2a14 14 0 0 1-6-6l2-2-2-5Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-14 4h2m6 0h2"/>',
  card: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 10h20M6 15h4"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  checklist: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 9 1 1 2-2m-3 7 1 1 2-2m3-5h2m-2 6h2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  inbox: '<path d="m3 4-1 10v6h20v-6L21 4H3Zm-1 10h6l2 3h4l2-3h6"/>',
  alert: '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v1"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3v.1"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
function icon(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.overview}</svg>`;
}
function money(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value)) : 'Not available';
}
function date(value, options = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  try { return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...options }).format(new Date(value)); }
  catch { return new Date(value).toISOString().slice(0, 10); }
}
function badge(label, tone = 'neutral') {
  const safeTone = ['neutral', 'good', 'warning', 'danger', 'info'].includes(tone) ? tone : 'neutral';
  return `<span class="badge badge-${safeTone}"><span class="badge-dot" aria-hidden="true"></span>${esc(label)}</span>`;
}
function empty(title, description, symbol = 'inbox') {
  return `<div class="empty-state"><span class="empty-icon">${icon(symbol)}</span><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
}
function stripeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['invoice.stripe.com', 'pay.stripe.com', 'billing.stripe.com', 'checkout.stripe.com', 'dashboard.stripe.com'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}
function brand(href = '/') {
  return `<a class="brand" href="${esc(href)}" aria-label="BuzzCall home"><span class="brand-symbol">${icon('bolt')}</span><span>buzzcall<span class="brand-period">.</span></span></a>`;
}
function modeNotice(mode) {
  if (mode === 'mock') return `<aside class="mode-notice" aria-label="Payment environment">${icon('shield')}<div><strong>Demo payments</strong><span>Payments and payouts are simulated. No real money moves.</span></div></aside>`;
  if (mode === 'test') return `<aside class="mode-notice" aria-label="Payment environment">${icon('shield')}<div><strong>Stripe test mode</strong><span>Test payments only. No real money moves.</span></div></aside>`;
  if (mode === 'unconfigured') return `<aside class="mode-notice" aria-label="Payment environment">${icon('alert')}<div><strong>Payments are not configured</strong><span>Connect a payment provider before accepting real payments. Demo checkout is disabled.</span></div></aside>`;
  return '';
}
const navigation = [
  ['overview', 'Overview', 'overview'], ['leads', 'Leads', 'phone'], ['bookings', 'Bookings', 'calendar'],
  ['payments', 'Payments', 'card'], ['operations', 'Operations', 'settings'], ['setups', 'Shop setup', 'checklist'],
];
// Shell links are local paths, never script URLs or protocol-relative destinations.
const localPath = (value, fallback = '/') => typeof value === 'string' && /^\/(?!\/)/.test(value) && !/[\\\s]/.test(value) ? value : fallback;
function page({ title, body, area = 'workspace', businessName = 'Your business', active = 'overview', mode = 'live', script = true,
  nav: items = navigation, basePath = '/admin', caption = 'YOUR WORKSPACE', breadcrumb = 'Workspace',
  identityCaption = 'Owner workspace', ownerEmail = '', headerAction = undefined, logout = null }) {
  const workspace = area === 'workspace';
  const base = localPath(basePath, '/admin');
  const nav = items.map(([id, label, symbol, href]) => `<a class="nav-link${active === id ? ' is-active' : ''}" href="${esc(href ? localPath(href) : `${base}#${encodeURIComponent(id)}`)}"${href ? '' : ` data-nav="${esc(id)}"`}${active === id ? ' aria-current="page"' : ''}>${icon(symbol)}<span>${esc(label)}</span></a>`).join('');
  const action = headerAction === undefined ? (workspace ? '<a class="button button-small button-outline" href="/setup">' + icon('checklist') + '<span>Submit shop setup</span></a>' : '<a class="support-link" href="mailto:hello@trybuzzcall.com">' + icon('help') + '<span>Need help?</span></a>')
    : headerAction ? `<a class="button button-small button-outline" href="${esc(localPath(headerAction.href))}">${icon(headerAction.icon || 'arrow')}<span>${esc(headerAction.label)}</span></a>` : '';
  const signout = logout ? `<form method="post" action="${esc(localPath(logout.action))}" class="workspace-logout"><button class="button button-small button-outline" type="submit">${esc(logout.label || 'Log out')}</button></form>` : '';
  const shell = workspace ? `<div class="app-shell"><aside class="sidebar">${brand(base)}<p class="sidebar-caption">${esc(caption)}</p><nav class="workspace-nav" aria-label="Workspace">${nav}</nav><div class="sidebar-bottom"><a class="nav-link" href="mailto:hello@trybuzzcall.com">${icon('help')}<span>Get support</span></a><a class="nav-link" href="/">${icon('external')}<span>View website</span></a><div class="business-identity"><span class="business-avatar" aria-hidden="true">${esc(businessName.trim().charAt(0).toUpperCase() || 'B')}</span><div><strong>${esc(businessName)}</strong><span>${esc(identityCaption)}</span>${ownerEmail ? `<span>${esc(ownerEmail)}</span>` : ''}</div></div>${signout}</div></aside><div class="workspace"><header class="workspace-header"><div class="breadcrumb">${esc(breadcrumb)} <span aria-hidden="true">/</span> <strong data-page-name>${esc(title)}</strong></div>${action}</header><main class="workspace-main" id="main">${modeNotice(mode)}${body}</main><footer class="workspace-footer"><span>BuzzCall · built for your working day.</span><span>Need a hand? <a href="mailto:hello@trybuzzcall.com">Contact support</a></span></footer></div></div>`
    : `<header class="payment-header">${brand()}${action}</header><main id="main" class="payment-main">${modeNotice(mode)}${body}</main><footer class="payment-footer"><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a><a href="/refunds.html">Refund policy</a><span>© ${new Date().getFullYear()} TryBuzzCall LLC</span></footer>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#142b32"><title>${esc(title)} | BuzzCall</title><link rel="stylesheet" href="/dashboard.css">${script ? '<script src="/dashboard.js" defer></script>' : ''}</head><body class="${workspace ? 'workspace-page' : 'payment-page'}"><a class="skip-link" href="#main">Skip to content</a>${shell}<dialog class="confirmation-dialog" id="confirm-dialog" aria-labelledby="confirm-title"><form method="dialog"><span class="dialog-symbol">${icon('shield')}</span><h2 id="confirm-title">Confirm this change</h2><p id="confirm-description"></p><div class="dialog-actions"><button class="button button-outline" value="cancel">Keep current settings</button><button class="button button-primary" value="confirm">Confirm change</button></div></form></dialog></body></html>`;
}
module.exports = { esc, icon, money, date, badge, empty, stripeLink, brand, modeNotice, page };
