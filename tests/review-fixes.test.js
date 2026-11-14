'use strict';
// 2026-10-25 review fixes: caller names (H2), mobile leads table (M2), local times / formatted phones (L1).
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.TZ = 'UTC';
process.env.BUSINESS_TZ = 'America/New_York';
const { extractName } = require('../src/agent');
const { formatPhone, labelCells } = require('../src/ui');
const admin = require('../src/adminPages');

test('extractName keeps names and never saves a request sentence as a name', () => {
  for (const [text, name] of [["Hi I want knotless braids, I'm Keisha", 'Keisha'], ['This is Dana Lee', 'Dana Lee'], ['my name is maria', 'maria'],
    ['Keisha', 'Keisha'], ['Me llamo Ana', 'Ana'], ['Tom', 'Tom']]) assert.equal(extractName(text), name, text);
  for (const text of ['Hi I want knotless braids', 'Hello', 'How much for a cut?', 'I need a plumber asap', 'Can I book tomorrow', '']) {
    assert.equal(extractName(text), null, text);
  }
});

test('formatPhone and labelCells', () => {
  assert.equal(formatPhone('+14045550101'), '(404) 555-0101');
  assert.equal(formatPhone('+442079460123'), '+442079460123');
  assert.equal(labelCells('<tr><td>a</td><td class="x">b</td></tr>', ['One', 'Two']), '<tr><td data-label="One">a</td><td data-label="Two" class="x">b</td></tr>');
});

function model(leads, optedOut) {
  return {
    businessName: 'Own business', ownerEmail: 'owner@example.test', leads, bookings: [], alerts: [], waitlist: [], pendingSetups: 0, setupHTML: '',
    storage: { backend: 'file' }, policy: { failClosed: false, why: '' }, paused: [], twilioLive: false, production: false,
    cfg: { booking: true, deposit: false, amount: 0, leadFee: 0, leadFeeWaived: true, vertical: 'plumber' },
    fees: { total: 0, collected: 0, due: 0, review: 0, count: 0, waived: 0 }, demoAllowed: true,
    connect: { mode: 'mock', label: 'Not connected', status: 'not_connected', requirementsDue: [] },
    billing: { access: { active: true }, invoices: [], subscription: null, shops: [], founding: { taken: 0, limit: 0 } },
    optedOut,
  };
}

test('leads: opted-out callers are clearly marked, cells are labeled for stacked mobile cards, times and phones are local', () => {
  const leads = [
    { id: 'l1', name: null, intro: 'Hi I want knotless braids', phone: '+14045550101', status: 'collecting', step: 'name', createdAt: '2026-10-25T17:05:00Z', messages: [] },
    { id: 'l2', name: 'Dana', phone: '+14045550102', need: 'Leak', status: 'collecting', step: 'need', createdAt: '2026-10-25T17:10:00Z', messages: [] },
  ];
  const html = admin.renderVendor(model(leads, (phone) => phone === '+14045550101'));
  const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
  const opted = rows.find((r) => r.includes('(404) 555-0101'));
  assert.ok(opted, 'Formatted phone');
  assert.match(opted, /is-opted-out/);
  assert.match(opted, /Opted out/);
  assert.doesNotMatch(opted, /Waiting for details|Collecting details/);
  assert.match(opted, /data-label="Status"/);
  assert.match(opted, /data-label="Received"/);
  assert.match(opted, /1:05\s?PM EDT|1:05\s?PM/, 'Received time is shown in the shop time zone');
  assert.ok(!html.includes('>Hi I want knotless braids<'), 'Intro text is not shown as the name');
  const normal = rows.find((r) => r.includes('(404) 555-0102'));
  assert.doesNotMatch(normal, /Opted out/);
  assert.match(html, /data-table--stack/);
  assert.match(html, /nav-scroll-hint/);
});
