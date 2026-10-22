'use strict';

// Static documentation regressions only: not legal or runtime compliance tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = [
  'README.md',
  'public/sms-consent.html',
  'public/terms.html',
  'public/privacy.html',
  'docs/PILOT_CHECKLIST.md',
  'docs/SMS_OPERATIONS.md',
];
const raw = Object.fromEntries(files.map(file => [file, readFileSync(path.join(root, file), 'utf8')]));
const text = Object.fromEntries(files.map(file => [file, raw[file]
  .replace(/<[^>]*>/g, ' ')
  .replace(/[`*]/g, '')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim()]));
const publicPages = files.filter(file => file.startsWith('public/'));
const operationalDocs = ['README.md', 'docs/PILOT_CHECKLIST.md', 'docs/SMS_OPERATIONS.md'];

function includesAll(file, phrases) {
  for (const phrase of phrases) {
    assert.ok(text[file].includes(phrase), `${file} should retain: ${phrase}`);
  }
}

test('documents reject missed-call consent and retain the two separate purposes', () => {
  for (const file of files) {
    includesAll(file, ['A missed call is not SMS consent', 'customer_service', 'owner_alerts']);
    assert.match(text[file], /Home Services/, file);
    assert.match(text[file], /Braiders/, file);
    assert.match(text[file], /not a compliance certification/, file);
  }
});

test('documents name the events that must not automatically create permission', () => {
  for (const file of files) {
    assert.match(text[file], /missed calls, inbound messages, START, payments?, waitlist signup, (?:(?:and|or) )?merely providing a (?:phone )?number/i, file);
    assert.match(text[file], /no automatic grants|do not (?:automatically )?(?:grant|create)|never create grants/i, file);
  }
});

test('public legal pages retain their titles, draft status, and existing legal URLs', () => {
  const titles = {
    'public/sms-consent.html': 'How Text Consent Works | BuzzCall | TryBuzzCall',
    'public/terms.html': 'Terms of Service & SMS Terms | BuzzCall | TryBuzzCall',
    'public/privacy.html': 'Privacy Policy | BuzzCall | TryBuzzCall',
  };
  for (const file of publicPages) {
    assert.ok(raw[file].includes(`<title>${titles[file]}</title>`), file);
    assert.match(text[file], /plain-English draft and is pending review by legal counsel/, file);
    assert.match(text[file], /It is not legal advice/, file);
    for (const url of ['privacy.html', 'terms.html', 'sms-consent.html']) {
      assert.ok(raw[file].includes(`href="${url}"`), `${file}: ${url}`);
    }
  }
  assert.ok(raw['public/terms.html'].includes('id="sms"'));
});

test('public pages retain nonmarketing, frequency, rates, choice, and help disclosures', () => {
  for (const file of publicPages) {
    assert.match(text[file], /nonmarketing/i, file);
    assert.match(text[file], /Message frequency varies/i, file);
    assert.match(text[file], /Message and data rates may apply/i, file);
    assert.match(text[file], /Consent (?:to receive texts )?is not a condition of (?:any )?purchase/i, file);
    assert.match(text[file], /\bSTOP\b/, file);
    assert.match(text[file], /\bHELP\b/, file);
  }
});

test('old implicit-opt-in, delivery, and automatic-deletion claims stay removed', () => {
  const misleadingClaims = [
    /Opt-in: the customer starts the conversation/i,
    /Customers can also opt in by texting/i,
    /by calling a participating business and leaving the call unanswered/i,
    /opt in to booking alerts by giving us/i,
    /We just sent you a text/i,
    /Reply START to resubscribe/i,
    /Twilio's default Advanced Opt-Out/i,
    /deleted or de-identified within 90 days/i,
    /will text when the tech is on the way/i,
  ];
  for (const file of files) {
    for (const claim of misleadingClaims) assert.doesNotMatch(text[file], claim, file);
  }
});

test('opt-out and provider replies are distinct from fresh application permission', () => {
  for (const file of files) {
    assert.match(text[file], /START only clears a delivery block(?:; it| and) never restores grants/, file);
    assert.match(text[file], /fresh (?:written )?evidence/, file);
    assert.match(text[file], /all purposes/, file);
    assert.match(text[file], /natural-language/i, file);
    assert.match(text[file], /OptOutType/, file);
    assert.match(text[file], /duplicate/, file);
  }
  for (const file of [...publicPages, 'docs/SMS_OPERATIONS.md']) {
    includesAll(file, ['STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
    assert.match(text[file], /Advanced Opt-Out[^.]*disabled by default/, file);
  }
});

test('operations document the authenticated JSON-only operator workflow', () => {
  includesAll('docs/SMS_OPERATIONS.md', [
    'GET /api/consent', 'POST /api/consent', 'Basic admin authentication',
    'JSON only', 'Content-Type: application/json', 'Origin', 'same-origin',
    'action', 'grant', 'revoke', 'phone', 'purpose', 'consentedAt',
    'ISO timestamp', 'disclosureVersion', 'evidenceRef',
    'Business and sender are taken from configuration',
    'actual written evidence', 'not a URL or token',
  ]);
});

test('operational docs retain default-off configuration and restricted webhook demo mode', () => {
  for (const file of operationalDocs) {
    includesAll(file, [
      'SMS_ENABLED', 'SMS_CONSENT_BUSINESS_ID', 'TWILIO_PHONE_NUMBER', 'E.164',
      'SKIP_TWILIO_VALIDATION', 'ALLOW_UNSIGNED_TWILIO_WEBHOOKS=1',
      'NODE_ENV', 'production', 'no live credentials',
    ]);
    assert.match(text[file], /SMS_ENABLED (?:defaults off|off)/, file);
    assert.match(text[file], /signature/i, file);
    assert.match(text[file], /account/i, file);
    assert.match(text[file], /routing/i, file);
  }
});

test('privacy describes permission metadata, protected persistence, and manual retention', () => {
  includesAll('public/privacy.html', [
    'timestamps', 'source', 'disclosure version', 'evidence reference',
    'revocation', 'actual written opt-in evidence', 'separate secured storage',
    'DATA_DIR', 'Render', 'persistent disk', 'no automatic retention-based deletion',
    'ending an account does not automatically erase', 'manually',
  ]);
  assert.doesNotMatch(text['public/privacy.html'], /within 90 days/);
});

test('pilot checklist retains external review and negative-path acceptance checks', () => {
  includesAll('docs/PILOT_CHECKLIST.md', [
    'actual customer', 'brand/campaign approval', 'sending-number association',
    'unconsented', 'STOPALL', 'OPTOUT', 'future booking/deposit confirmations',
    'Restart', 'Render', 'persistent disk', 'reviewed approval',
    'written evidence', 'no longer text by default',
  ]);
  assert.match(text['docs/PILOT_CHECKLIST.md'], /No deployment, number purchase, carrier submission, or fee is authorized/);
});

test('operations require reviewed crash recovery and authenticated payment events', () => {
  for (const file of operationalDocs) {
    includesAll(file, ['smsSessionClean', 'suppression_history_reviewed', 'SMS_ENABLED=0', 'STRIPE_WEBHOOK_SECRET']);
  }
  includesAll('docs/SMS_OPERATIONS.md', ['recoveryRequired', 'persistenceFailed', 'one process per data directory']);
  assert.match(text['docs/SMS_OPERATIONS.md'], /Recovery is rejected while SMS_ENABLED=1/);
  assert.match(text['docs/SMS_OPERATIONS.md'], /grants no permission and clears no recipient-level revocation/);
  const landing = readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(landing, /A missed call is not SMS consent/);
  assert.match(landing, /Owners need separate permission for alerts/);
});

test('provider source links remain available without treating them as customer approval', () => {
  const sources = [
    'https://www.twilio.com/en-us/legal/messaging-policy',
    'https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv',
    'https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart',
    'https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out',
  ];
  for (const file of ['README.md', 'public/sms-consent.html', 'public/terms.html', 'docs/SMS_OPERATIONS.md']) {
    for (const url of sources) assert.ok(raw[file].includes(url), `${file}: ${url}`);
    assert.match(text[file], /April 13, 2026/, file);
  }
});
