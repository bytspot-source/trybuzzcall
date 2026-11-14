'use strict';
// Config precedence: stored override (data/config.json) > env > code default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzzcall-config-'));
// Isolated env for this process: modules read DATA_DIR at require time.
for (const k of ['VERTICAL', 'BUSINESS_VERTICAL', 'BUSINESS_HOURS', 'BUSINESS_DAYS', 'DEPOSIT_AMOUNT', 'SERVICES', 'BOOKING_ENABLED', 'OPENAI_API_KEY', 'BUSINESS_TZ']) delete process.env[k];
Object.assign(process.env, { DATA_DIR: dir, BUSINESS_NAME: 'Env Plumbing', HOLD_MINUTES: '45', BOOKING_LINK: 'https://env.example/book', STRIPE_SECRET_KEY: '' });
const config = require('../src/config');
const booking = require('../src/booking');
const agent = require('../src/agent');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('without an override: env wins over defaults, defaults fill the rest', () => {
  config.clear();
  const c = booking.cfg();
  assert.equal(c.vertical, 'home_services');           // default
  assert.equal(c.amount, 49);                          // default (home services)
  assert.equal(c.holdMin, 45);                         // env
  assert.match(agent.firstMessage(), /Env Plumbing/);  // env
  assert.equal(config.effective().find((e) => e.key === 'BUSINESS_NAME').source, 'env');
  assert.equal(config.effective().find((e) => e.key === 'DEPOSIT_AMOUNT').source, 'default');
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});

test('override beats env and defaults; keys it lacks still fall back to env/default', () => {
  config.apply({ BUSINESS_NAME: 'Crown Braids', VERTICAL: 'braiders', DEPOSIT_AMOUNT: '75', SERVICES: 'Knotless:360', BOOKING_LINK: '' }, { setupId: 'abc' });
  const c = booking.cfg();
  assert.equal(c.vertical, 'braiders');
  assert.equal(c.amount, 75);
  assert.deepEqual(c.services, [{ name: 'Knotless', minutes: 360 }]);
  assert.equal(c.bookingLink, null, 'empty override string beats a set env var');
  assert.equal(c.holdMin, 45, 'not in override -> env');
  assert.equal(c.open, 9 * 60, 'not in override or env -> braider default');
  assert.match(agent.firstMessage(), /Crown Braids/);
  assert.equal(agent.isBraiders(), true);
  assert.equal(config.effective().find((e) => e.key === 'BUSINESS_NAME').source, 'override');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.setupId, 'abc');
  assert.equal(saved.values.VERTICAL, 'braiders');
});

test('override cannot set keys outside the shop-config allowlist (secrets pass through to env)', () => {
  config.apply({ STRIPE_SECRET_KEY: 'sk_live_nope', ADMIN_PASSWORD: 'x', BUSINESS_NAME: 'Crown' });
  assert.equal(config.env.STRIPE_SECRET_KEY, '');
  assert.equal(config.env.ADMIN_PASSWORD, process.env.ADMIN_PASSWORD);
  assert.equal(config.override().values.STRIPE_SECRET_KEY, undefined);
});

test('override applies BUSINESS_TZ to process.env.TZ and clearing restores env behavior', () => {
  config.apply({ BUSINESS_TZ: 'America/Chicago' });
  assert.equal(process.env.TZ, 'America/Chicago');
  config.clear();
  assert.equal(booking.cfg().vertical, 'home_services');
  assert.match(agent.firstMessage(), /Env Plumbing/);
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});

test('a stored override is read at startup by a fresh process', () => {
  config.apply({ VERTICAL: 'braiders', BUSINESS_NAME: 'Fresh Start Braids' });
  const out = execFileSync(process.execPath, ['-e', "const b=require('./src/booking');const a=require('./src/agent');console.log(JSON.stringify({v:b.cfg().vertical,m:a.firstMessage()}))"],
    { cwd: path.resolve(__dirname, '..'), env: { PATH: process.env.PATH, DATA_DIR: dir, BUSINESS_NAME: 'Env Plumbing', VERTICAL: 'home_services', DOTENV_CONFIG_PATH: '/nonexistent' } }).toString();
  const r = JSON.parse(out);
  assert.equal(r.v, 'braiders');
  assert.match(r.m, /Fresh Start Braids/);
  config.clear();
});
