'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pages = require('../src/workspacePages');
const admin = require('../src/adminPages');
const { page, esc } = require('../src/ui');

function model() {
  return {
    businessName: 'Own business', ownerEmail: 'owner@example.test',
    leads: [{ name: 'Own customer', phone: '+14045550101', need: 'Own repair', status: 'collecting', createdAt: '2026-10-01' }],
    bookings: [{ name: 'Own booking', phone: '+14045550101', service: 'Own service', status: 'confirmed', paid: true, amount: 25 }],
    alerts: [], waitlist: [{ email: 'platform-waitlist@example.test', at: '2026-10-01' }],
    pendingSetups: 9, setupHTML: '<div>PRIVATE_SETUP_APPROVAL</div>',
    storage: { backend: 'file', degraded: true, lastError: 'PRIVATE_DIAGNOSTIC', pathWarnings: ['PRIVATE_STORAGE_PATH'] },
    policy: { failClosed: true, why: 'PRIVATE_POLICY' }, paused: ['PRIVATE_PAUSED_CONVERSATION'], twilioLive: false, production: false,
    cfg: { booking: true, deposit: true, amount: 25, leadFee: 10, leadFeeWaived: false, vertical: 'plumber' },
    fees: { total: 10, collected: 0, due: 10, review: 0, count: 1, waived: 0 }, demoAllowed: true,
    connect: { mode: 'mock', label: 'Not connected', status: 'not_connected', requirementsDue: [] },
    billing: {
      access: { active: true, reason: 'Subscription active' }, invoices: [],
      subscription: { id: 'sub_own', status: 'active', plan: 'monthly', amount: 99, current_period_end: '2026-11-01', cancel_at_period_end: false },
      shops: [{ n: 'OTHER_VENDOR_PRIVATE', subscription: 'sub_other', plan: 'monthly', status: 'active', setup: { status: 'paid', amount: 10 } }],
      founding: { taken: 1, limit: 20 },
    },
  };
}
const shop = {
  id: 'shop-own', name: 'Own business', email: 'owner@example.test', status: 'active', phoneNumber: '+14045550101',
  createdAt: '2026-10-01', subscriptionStatus: 'trialing', bookingCount: 3, leadCount: 4, payoutStatus: 'pending',
};
const attack = '\"><img src=x onerror=alert(1)><script>alert(1)</script>&\'';
function safeHTML(html) {
  assert.ok(!html.includes(attack), 'Raw hostile input must not appear in HTML');
  assert.doesNotMatch(html, /<img\b|<script>alert|<svg onload|href="javascript:|action="javascript:/i);
}
function form(html, action) {
  return [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0]).find(value => value.includes(`action="${action}"`));
}

test('vendor dashboard reuses own customer and billing panes without platform data or controls', () => {
  const source = model(), before = structuredClone(source);
  const html = admin.renderVendor(source);
  for (const text of ['Own customer', 'Own booking', 'Own service', 'sub_own', 'owner@example.test', 'VENDOR WORKSPACE']) assert.ok(html.includes(text), text);
  for (const text of ['OTHER_VENDOR_PRIVATE', 'sub_other', 'PRIVATE_SETUP_APPROVAL', 'PRIVATE_DIAGNOSTIC', 'PRIVATE_STORAGE_PATH',
    'PRIVATE_POLICY', 'PRIVATE_PAUSED_CONVERSATION', 'platform-waitlist@example.test', 'Operations', 'Storage &amp; reliability',
    'Subscription records', 'Founding shops', 'Pilot interest', 'Shop setup', 'Setup requests', 'Twilio credentials']) assert.ok(!html.includes(text), text);
  assert.doesNotMatch(html, /(?:href|action|data-return)="(?:\/admin|\/api\/billing|\/billing\/|\/setup)/);
  assert.match(html, /href="\/vendor\/settings"/);
  assert.match(html, /<form method="post" action="\/vendor\/logout"/);
  assert.match(html, /data-page="leads"/);
  assert.match(html, /data-page="bookings"/);
  assert.match(html, /data-page="payments"/);
  assert.doesNotMatch(html, /data-page="(?:operations|setups)"/);
  assert.deepEqual(source, before, 'Rendering does not mutate the caller model');
});

test('vendor rendering does not read platform collections or diagnostics', () => {
  const source = model();
  for (const key of ['waitlist', 'setupHTML', 'pendingSetups', 'storage', 'policy', 'paused', 'alerts']) {
    Object.defineProperty(source, key, { get() { throw new Error(`Unexpected platform read: ${key}`); } });
  }
  Object.defineProperty(source.billing, 'shops', { get() { throw new Error('Unexpected cross-shop billing read'); } });
  assert.doesNotThrow(() => admin.renderVendor(source));
});

test('vendor billing and payout actions are scoped for cancellation, renewal, preview and synchronization', () => {
  const source = model();
  let html = admin.renderVendor(source);
  for (const endpoint of ['/vendor/billing/cancel', '/vendor/billing/preview', '/vendor/connect/onboard']) assert.ok(form(html, endpoint), endpoint);
  assert.match(html, /href="\/vendor\/billing\/portal"/);
  assert.match(html, /data-change-action="\/vendor\/billing\/change-plan"/);
  assert.match(html, /data-return="\/vendor#payments"/);
  source.billing.subscription.cancel_at_period_end = true;
  source.connect = { ...source.connect, mode: 'test', accountId: 'acct_own' };
  html = admin.renderVendor(source);
  assert.ok(form(html, '/vendor/billing/resume'));
  assert.ok(form(html, '/vendor/connect/sync'));
  const portal = admin.billingPortal({ ...source, vendor: true });
  assert.ok(form(portal, '/vendor/billing/mock/update-card'));
  assert.ok(form(portal, '/vendor/billing/resume'));
  assert.match(portal, /href="\/vendor#payments"/);
  assert.match(portal, /data-change-action="\/vendor\/billing\/change-plan"/);
  assert.match(portal, /owner@example.test/);
  assert.doesNotMatch(portal, /(?:href|action|data-return)="(?:\/admin|\/api\/billing|\/billing\/|\/setup)/);
});

test('legacy admin render and default shell remain available with their original routes', () => {
  const html = admin.render(model());
  for (const text of ['Operations', 'Shop setup', 'Pilot interest', 'PRIVATE_SETUP_APPROVAL', 'PRIVATE_DIAGNOSTIC', 'OTHER_VENDOR_PRIVATE']) assert.ok(html.includes(text), text);
  assert.ok(form(html, '/api/billing/cancel'));
  assert.match(html, /href="\/billing\/portal"/);
  assert.match(html, /href="\/admin#overview" data-nav="overview"/);
  assert.match(html, /href="\/setup"/);
  const portal = admin.billingPortal(model());
  assert.ok(form(portal, '/billing/mock/update-card'));
  assert.match(portal, /href="\/admin#payments"/);
  const shell = page({ title: 'Overview', body: '<p>Body</p>' });
  assert.match(shell, /YOUR WORKSPACE/);
  assert.match(shell, /Owner workspace/);
  assert.doesNotMatch(shell, /vendor\/logout/);
});

test('custom shell escapes text and keeps direct settings navigation separate from tab switching', () => {
  const html = page({ title: attack, body: '', businessName: attack, caption: attack, breadcrumb: attack, ownerEmail: attack,
    nav: [['settings', attack, 'settings', '/vendor/settings']], basePath: '/vendor', identityCaption: attack,
    headerAction: { href: 'javascript:alert(1)', label: attack }, logout: { action: '//attacker.example/logout', label: attack } });
  safeHTML(html);
  assert.match(html, /href="\/vendor\/settings"/);
  assert.doesNotMatch(html, /data-nav="settings"/);
  assert.match(html, /<form method="post" action="\/"/);
});

test('platform roster shows actual counts and only explicitly selected registry and setup fields', () => {
  const html = pages.platform({ shops: [shop, { ...shop, id: 'shop-two', status: 'suspended', bookingCount: 5, leadCount: 7, privateField: 'INTERNAL_MARKER' }],
    setups: [{ id: 'setup-one', status: 'pending', values: { businessName: 'Pending business', email: 'pending@example.test', secret: 'INTERNAL_MARKER' } },
      { id: 'setup-applied', status: 'applied', values: { businessName: 'DO_NOT_SHOW_APPLIED' } }],
    storage: { backend: 'postgres', degraded: true, lastError: 'INTERNAL_MARKER', pathWarnings: ['Platform storage-path warning'] }, legacyName: 'Old business' });
  assert.match(html, /<title>Platform admin \| BuzzCall<\/title>/);
  for (const value of ['Vendor roster', 'owner@example.test', 'trialing', '(404) 555-0101', 'pending', 'Degraded', 'Postgres'.toLowerCase(), 'Pending business', 'Old business']) assert.ok(html.includes(value), value);
  for (const value of [2, 1, 8, 11]) assert.ok(html.includes(`<strong class="metric-value">${value}</strong>`));
  assert.match(html, /href="\/admin\/vendors\/shop-own"/);
  const approval = form(html, '/admin/vendors/approve');
  assert.match(approval, /method="post"/);
  assert.match(approval, /type="hidden" name="setupId" value="setup-one"/);
  const create = form(html, '/admin/vendors');
  assert.match(create, /name="name"/); assert.match(create, /name="email" type="email"/);
  assert.match(html, /href="\/admin\/legacy"/);
  assert.match(html, /not assigned to any vendor/);
  assert.match(html, /Platform storage-path warning/);
  assert.doesNotMatch(html, /INTERNAL_MARKER|DO_NOT_SHOW_APPLIED|Own customer|data-page="leads"/);
});

test('empty and incomplete platform data never invents businesses, usage or successful service checks', () => {
  const empty = pages.platform();
  assert.match(empty, /No vendors yet/); assert.match(empty, /No pending setups/);
  assert.match(empty, /Not reported/);
  assert.doesNotMatch(empty, /Own business|Provider configured|Postgres connected/);
  const incomplete = pages.platform({ shops: [{ id: 'missing-stats', name: 'Uncounted' }] });
  assert.match(incomplete, /<strong class="metric-value">Not available<\/strong>/);
  assert.match(incomplete, /Not recorded/);
});

test('vendor detail exposes administrator-only status, invite reset and confirmed phone contracts', () => {
  const html = pages.vendorDetail({ shop: { ...shop, privateField: 'INTERNAL_MARKER' }, stats: { bookingCount: 6, leadCount: 9 }, settings: { BUSINESS_CITY: 'Atlanta, GA', PROVIDER_SECRET: 'INTERNAL_MARKER' } });
  const status = form(html, '/admin/vendors/shop-own/status');
  assert.match(status, /method="post"/);
  assert.match(status, /name="status" required/);
  assert.match(status, /value="active" selected/); assert.match(status, /value="suspended"/);
  const suspended = pages.vendorDetail({ shop: { ...shop, status: 'suspended' } });
  assert.match(suspended, /value="suspended" selected/);
  const invite = form(html, '/admin/vendors/shop-own/invite');
  assert.match(invite, /revoke existing sessions/);
  const phone = form(html, '/admin/vendors/shop-own/phone');
  assert.match(phone, /name="phoneNumber" type="tel"/);
  assert.match(phone, /type="checkbox" name="confirm_phones" value="1" required/);
  assert.match(html, /Server validation/);
  assert.doesNotMatch(html, /INTERNAL_MARKER|email (?:has been |was )?sent/i);
});

test('vendor authentication uses native POST forms, pasted codes and bounded passwords without inline scripts', () => {
  const login = pages.auth({ kind: 'login', error: 'Could not sign in.' });
  const loginForm = form(login, '/vendor/login');
  assert.match(loginForm, /method="post"/);
  assert.match(loginForm, /name="email" type="email"/);
  assert.match(loginForm, /name="password" type="password" value="" required/);
  assert.match(loginForm, /minlength="16" maxlength="128" autocomplete="current-password"/);
  assert.match(login, /role="alert"/); assert.match(login, /aria-describedby="form-error"/);
  assert.match(login, /Platform admin · separate access/);
  const activate = pages.auth({ kind: 'activate', message: 'Paste your code.' });
  const activationForm = form(activate, '/vendor/activate');
  for (const name of ['token', 'password', 'passwordConfirm']) assert.ok(activationForm.includes(`name="${name}"`));
  assert.equal((activationForm.match(/minlength="16" maxlength="128"/g) || []).length, 2);
  assert.match(activate, /Do not put it in a URL/);
  assert.match(activate, /role="status"/);
  assert.doesNotMatch(login + activate, /<script|\son\w+=|[?&]token=/);
});

test('private invitation shows an escaped one-use code in text only and never claims email delivery', () => {
  // Hostile test text is a fixture, not a live activation credential.
  const html = pages.invitation({ shop, token: attack });
  assert.match(html, /Private · platform administrator only/);
  assert.match(html, /expires in 24 hours/);
  assert.match(html, /used only once/);
  assert.ok(html.includes(`<code>${esc(attack)}</code>`));
  assert.match(html, /href="\/vendor\/activate"/);
  assert.doesNotMatch(html, /[?&]token=|<script|email (?:has been |was )sent/i);
  safeHTML(html);
});

test('vendor settings posts only allowed settings and leaves phone routing read-only', () => {
  const values = { BUSINESS_NAME: 'Updated business', BUSINESS_CITY: 'Atlanta, GA', BUSINESS_TZ: 'America/New_York',
    BUSINESS_DAYS: '1,2,3,4,5', BUSINESS_HOURS: '09:00-17:00', SERVICES: 'Visit:60', BOOKING_ENABLED: '1', DEPOSIT_ENABLED: '0',
    DEPOSIT_AMOUNT: '25', SLOT_MINUTES: '60', HOLD_MINUTES: '15', BOOKING_LEAD_MINUTES: '30', BOOKING_LINK: 'https://booking.example.test',
    OWNER_PHONE: '+14045550102', FORWARD_TO_PHONE: '+14045550103', STRIPE_SECRET_KEY: 'INTERNAL_MARKER', PRICE_MONTHLY: 'INTERNAL_MARKER' };
  const html = pages.settings({ shop, values, error: { field: 'BUSINESS_CITY', message: 'Check the city.' } });
  const settings = form(html, '/vendor/settings');
  const names = [...settings.matchAll(/name="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(names.sort(), [...Object.keys(values).filter(name => !['OWNER_PHONE', 'FORWARD_TO_PHONE', 'STRIPE_SECRET_KEY', 'PRICE_MONTHLY'].includes(name)), 'BUSINESS_TYPE', 'BUSINESS_TRADE_LABEL'].sort());
  assert.match(html, /name="OWNER_PHONE"[^>]+readonly disabled/);
  assert.match(html, /name="FORWARD_TO_PHONE"[^>]+readonly disabled/);
  assert.match(html, /name="BUSINESS_CITY"[^>]+aria-invalid="true"/);
  assert.match(html, /<select[^>]+name="BOOKING_ENABLED"[^>]*><option value="0">Off<\/option><option value="1" selected>/);
  assert.match(html, /<select[^>]+name="DEPOSIT_ENABLED"[^>]*><option value="0" selected>/);
  assert.match(html, /owner@example.test/);
  assert.ok(form(html, '/vendor/logout'));
  assert.doesNotMatch(html, /INTERNAL_MARKER|STRIPE_SECRET_KEY|PRICE_MONTHLY|(?:href|action)="\/admin/);
});

test('all new templates escape hostile text and URL identifiers at the HTML boundary', () => {
  const hostileShop = Object.fromEntries(Object.keys(shop).map(key => [key, attack]));
  const cases = [
    pages.platform({ shops: [hostileShop], setups: [{ id: attack, status: 'pending', values: { businessName: attack, email: attack } }], storage: { backend: attack }, legacyName: attack, legacyBilling: { subscription: { status: attack } }, mode: attack }),
    pages.vendorDetail({ shop: hostileShop, settings: { BUSINESS_CITY: attack, BUSINESS_TZ: attack } }),
    pages.auth({ kind: 'login', error: attack, message: attack }),
    pages.auth({ kind: 'activate', error: attack, message: attack }),
    pages.invitation({ shop: hostileShop, token: attack }),
    pages.settings({ shop: hostileShop, values: { BUSINESS_NAME: attack, BUSINESS_CITY: attack, SERVICES: attack, BOOKING_LINK: attack, OWNER_PHONE: attack, FORWARD_TO_PHONE: attack }, error: attack, message: attack }),
    pages.message({ title: attack, message: attack, status: attack }),
  ];
  for (const html of cases) { safeHTML(html); assert.ok(html.includes(esc(attack))); }
  const source = model();
  source.businessName = source.ownerEmail = attack;
  source.leads[0].name = source.leads[0].need = source.leads[0].phone = attack;
  source.bookings[0].name = source.bookings[0].service = source.bookings[0].status = attack;
  source.billing.subscription.id = attack;
  source.billing.invoices = [{ id: attack, reason: attack, status: attack, url: 'javascript:alert(1)' }];
  source.connect.label = source.connect.accountId = attack;
  source.connect.requirementsDue = [attack];
  const vendor = admin.renderVendor(source), portal = admin.billingPortal({ ...source, vendor: true });
  safeHTML(vendor); safeHTML(portal);
  assert.ok(vendor.includes(esc(attack))); assert.ok(portal.includes(esc(attack)));
});
