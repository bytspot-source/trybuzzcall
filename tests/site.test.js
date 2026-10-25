'use strict';

const assert = require('node:assert/strict');
const { readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const publicDir = path.resolve(__dirname, '../public');
const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const script = new vm.Script(readFileSync(path.join(publicDir, 'site.js'), 'utf8'), {
  filename: path.join(publicDir, 'site.js'),
});
const origin = 'https://landing.example.test';
const mockCheckout = '/billing/mock/checkout/test-session';
const stripeCheckout = 'https://checkout.stripe.com/c/pay/test-session';

// These helpers inspect this page's static markup, not arbitrary HTML or rendering.
function attributes(source) {
  return Object.fromEntries(Array.from(source.matchAll(
    /([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
  ), ([, name, doubleQuoted, singleQuoted, unquoted]) => [
    name.toLowerCase(), doubleQuoted ?? singleQuoted ?? unquoted ?? '',
  ]));
}

function tags(source, name) {
  const markup = source.replace(/<!--[\s\S]*?-->/g, '');
  return Array.from(markup.matchAll(/<([a-z][\w:-]*)\b([^<>]*)>/gi),
    ([, tag, attrs]) => ({ tag: tag.toLowerCase(), attrs: attributes(attrs) }))
    .filter((element) => !name || element.tag === name);
}

function blocks(source, name) {
  const pattern = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}\\s*>`, 'gi');
  return Array.from(source.matchAll(pattern), ([, attrs, content]) => ({
    attrs: attributes(attrs), content,
  }));
}

function text(source) {
  return source.replace(/<[^>]*>/g, '').trim();
}

const elements = tags(html);
function byId(id) {
  const matches = elements.filter((element) => element.attrs.id === id);
  assert.equal(matches.length, 1, `Expected exactly one #${id}`);
  return matches[0];
}

function describedBy(element, ...ids) {
  const references = (element.attrs['aria-describedby'] || '').split(/\s+/);
  for (const id of ids) {
    assert.ok(references.includes(id), `Expected aria-describedby to include ${id}`);
    byId(id);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

// Only the DOM APIs consumed by site.js are doubled. Constraint validation is
// controlled explicitly: these tests do not claim to implement browser rules.
class ElementDouble {
  constructor(attrs = {}) {
    this.attrs = new Map(Object.entries(attrs));
    this.listeners = new Map();
    this.dataset = Object.fromEntries(Object.entries(attrs)
      .filter(([name]) => name.startsWith('data-'))
      .map(([name, value]) => [name.slice(5), value]));
    this.disabled = Object.hasOwn(attrs, 'disabled');
    this.readOnly = false;
    this.value = '';
    this.textContent = '';
    this.focusCount = 0;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  // Returning a promise lets tests await async event handlers without sleeps.
  // Synthetic dispatch deliberately reaches handlers even on disabled controls,
  // so duplicate-request guards are tested independently of native click behavior.
  async dispatch(type) {
    const event = {
      type,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    await Promise.all((this.listeners.get(type) || []).map((listener) => listener(event)));
    return event;
  }

  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  focus() { this.focusCount += 1; }
}

class TimerDouble {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.cleared = [];
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.pending.set(id, { callback, delay });
    return id;
  }

  clearTimeout(id) {
    this.cleared.push(id);
    this.pending.delete(id);
  }

  fire(id) {
    const timer = this.pending.get(id);
    assert.ok(timer, `Timer ${id} must be pending`);
    this.pending.delete(id);
    timer.callback();
  }
}

function harness(t, fetchImpl = async () => jsonResponse({ ok: true })) {
  const nodes = Object.fromEntries([
    'waitlist-form', 'waitlist-email', 'waitlist-business', 'waitlist-status', 'checkout-status',
  ].map((id) => [id, new ElementDouble(byId(id).attrs)]));
  const form = nodes['waitlist-form'];
  const email = nodes['waitlist-email'];
  const business = nodes['waitlist-business'];
  // Most interaction tests model a visitor who has already chosen Home Services.
  business.value = 'home_services';
  const formMarkup = blocks(html, 'form').find(({ attrs }) => attrs.id === 'waitlist-form');
  const submitTag = tags(formMarkup.content, 'button').find(({ attrs }) => attrs.type === 'submit');
  assert.ok(submitTag, 'Waitlist submit button must exist');
  const submit = new ElementDouble(submitTag.attrs);
  const checkoutButtons = elements.filter(({ attrs }) => Object.hasOwn(attrs, 'data-checkout'))
    .map(({ attrs }) => new ElementDouble(attrs));
  const audienceLinks = elements.filter(({ attrs }) => Object.hasOwn(attrs, 'data-audience'))
    .map(({ attrs }) => new ElementDouble(attrs));
  form.valid = true;
  form.validityChecks = 0;
  form.resetCount = 0;
  form.reportValidity = () => { form.validityChecks += 1; return form.valid && business.value !== ''; };
  form.reset = () => { form.resetCount += 1; email.value = ''; business.value = ''; };
  form.querySelector = (selector) => {
    assert.equal(selector, 'button[type="submit"]');
    return submit;
  };
  const requests = [];
  const redirects = [];
  const timers = new TimerDouble();
  script.runInNewContext({
    document: {
      getElementById: (id) => nodes[id] ?? null,
      querySelectorAll(selector) {
        if (selector === '[data-checkout]') return checkoutButtons;
        if (selector === '[data-audience]') return audienceLinks;
        assert.fail(`Unexpected selector: ${selector}`);
      },
    },
    window: { location: { origin, assign: (url) => redirects.push(url) } },
    URL,
    AbortController,
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    fetch(url, options) {
      requests.push({ url, options });
      return fetchImpl(url, options);
    },
  });
  t.after(() => {
    assert.equal(timers.pending.size, 0, 'Every completed request must release its timer');
    assert.equal(timers.cleared.length, requests.length, 'Every request must clear its timeout');
  });
  return {
    form, email, business, submit, checkoutButtons, audienceLinks, requests, redirects, timers,
    waitlistStatus: nodes['waitlist-status'],
    checkoutStatus: nodes['checkout-status'],
    checkout: (plan) => checkoutButtons.find((button) => button.dataset.checkout === plan),
  };
}

function assertPost(request, url, body) {
  assert.equal(request.url, url);
  assert.equal(request.options.method, 'POST');
  // Headers originate in the VM, so compare a host-realm copy.
  assert.deepEqual({ ...request.options.headers }, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(request.options.body), body);
  assert.ok(request.options.signal instanceof AbortSignal);
}

function assertWaitlistControls(h, busy) {
  assert.equal(h.submit.disabled, busy);
  assert.equal(h.email.readOnly, busy);
  assert.equal(h.business.disabled, busy);
  assert.equal(h.form.getAttribute('aria-busy'), busy ? 'true' : null);
}

function assertCheckoutControls(h, busy, activePlan) {
  for (const button of h.checkoutButtons) {
    assert.equal(button.disabled, busy);
    assert.equal(button.getAttribute('aria-busy'),
      busy && button.dataset.checkout === activePlan ? 'true' : null);
  }
}

function assertWaitlistError(h) {
  assert.equal(h.waitlistStatus.dataset.state, 'error');
  assert.match(h.waitlistStatus.textContent, /try again/i);
  assert.match(h.waitlistStatus.textContent, /hello@trybuzzcall\.com/);
  assertWaitlistControls(h, false);
  assert.equal(h.form.resetCount, 0);
}

function assertCheckoutError(h) {
  assert.equal(h.checkoutStatus.dataset.state, 'error');
  assert.match(h.checkoutStatus.textContent, /try again/i);
  assert.equal(h.redirects.length, 0);
  assertCheckoutControls(h, false);
}

test('startup enables the initially disabled waitlist and checkout controls', (t) => {
  const h = harness(t);
  assertWaitlistControls(h, false);
  assertCheckoutControls(h, false);
  assert.equal(h.requests.length, 0);
});

test('waitlist submits a trimmed email, shows pending state, and resets on success', async (t) => {
  const pending = deferred();
  const h = harness(t, () => pending.promise);
  h.email.value = '  shop@example.test  ';
  h.email.setAttribute('aria-invalid', 'true');
  const submission = h.form.dispatch('submit');
  assertWaitlistControls(h, true);
  assertCheckoutControls(h, false);
  assert.equal(h.form.validityChecks, 1);
  assert.equal(h.email.getAttribute('aria-invalid'), null);
  assert.match(h.waitlistStatus.textContent, /adding/i);
  assert.equal(h.waitlistStatus.dataset.state, '');
  assert.equal(h.requests.length, 1);
  assertPost(h.requests[0], '/api/waitlist', { email: 'shop@example.test', businessType: 'home_services' });
  assert.equal(h.form.resetCount, 0);

  pending.resolve(jsonResponse({ ok: true }));
  assert.equal((await submission).defaultPrevented, true);
  assert.equal(h.form.resetCount, 1);
  assert.equal(h.email.value, '');
  assert.equal(h.waitlistStatus.dataset.state, 'success');
  assert.match(h.waitlistStatus.textContent, /on the Home Services pilot list/i);
  assert.equal(h.business.value, '');
  assertWaitlistControls(h, false);
  assert.equal(h.requests[0].options.signal.aborted, false);
  await h.email.dispatch('input');
  assert.equal(h.waitlistStatus.textContent, '');
  assert.equal(h.waitlistStatus.dataset.state, '');
});

test('failed native validity prevents a request without locking controls', async (t) => {
  const h = harness(t);
  h.form.valid = false;
  h.email.value = '   ';
  const event = await h.form.dispatch('submit');
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.form.validityChecks, 1);
  assert.equal(h.email.value, '');
  assert.equal(h.requests.length, 0);
  assert.equal(h.form.resetCount, 0);
  assertWaitlistControls(h, false);
});

test('a 400 waitlist response marks and focuses the email; input clears the error and retry works', async (t) => {
  let attempts = 0;
  const h = harness(t, () => ++attempts === 1
    ? jsonResponse({ ok: false }, 400) : jsonResponse({ ok: true }));
  h.email.value = 'shop@example.test';
  await h.form.dispatch('submit');
  assert.equal(h.email.value, 'shop@example.test');
  assert.equal(h.email.getAttribute('aria-invalid'), 'true');
  assert.equal(h.email.focusCount, 1);
  assert.equal(h.form.resetCount, 0);
  assert.equal(h.waitlistStatus.dataset.state, 'error');
  assert.match(h.waitlistStatus.textContent, /check your email/i);
  assertWaitlistControls(h, false);

  await h.email.dispatch('input');
  assert.equal(h.email.getAttribute('aria-invalid'), null);
  assert.equal(h.waitlistStatus.textContent, '');
  assert.equal(h.waitlistStatus.dataset.state, '');
  await h.form.dispatch('submit');
  assert.equal(h.requests.length, 2);
  assert.equal(h.waitlistStatus.dataset.state, 'success');
  assert.equal(h.form.resetCount, 1);
});

test('an empty business choice fails validation without submitting or locking controls', async (t) => {
  const h = harness(t);
  h.email.value = 'studio@example.test';
  h.business.value = '';
  await h.form.dispatch('submit');
  assert.equal(h.requests.length, 0);
  assertWaitlistControls(h, false);
});

test('audience links preselect the matching pilot without preventing anchor navigation', async (t) => {
  const h = harness(t);
  h.email.value = 'owner@example.test';
  assert.ok(h.audienceLinks.length >= 2);
  for (const link of h.audienceLinks) {
    h.business.setAttribute('aria-invalid', 'true');
    h.waitlistStatus.textContent = 'Old message';
    const event = await link.dispatch('click');
    assert.equal(event.defaultPrevented, false);
    assert.equal(link.getAttribute('href'), '#waitlist');
    assert.equal(h.business.value, link.dataset.audience);
    assert.equal(h.business.getAttribute('aria-invalid'), null);
    assert.equal(h.waitlistStatus.textContent, '');
    assert.equal(h.email.value, 'owner@example.test');
  }
  assert.equal(h.requests.length, 0);
});

test('unsupported audience links are ignored rather than selecting an unoffered niche', async (t) => {
  const h = harness(t);
  h.audienceLinks[0].dataset.audience = 'nails';
  await h.audienceLinks[0].dispatch('click');
  assert.equal(h.business.value, 'home_services');
  assert.equal(h.requests.length, 0);
});

test('braider inquiry sends its segment, keeps it stable during submission and never starts checkout', async (t) => {
  const pending = deferred();
  const h = harness(t, () => pending.promise);
  h.email.value = 'braider@example.test';
  const braiderLink = h.audienceLinks.find((link) => link.dataset.audience === 'braiders');
  await braiderLink.dispatch('click');
  const request = h.form.dispatch('submit');
  assertWaitlistControls(h, true);
  const pendingStatus = h.waitlistStatus.textContent;
  const homeLink = h.audienceLinks.find((link) => link.dataset.audience === 'home_services');
  await homeLink.dispatch('click');
  assert.equal(h.business.value, 'braiders');
  assert.equal(h.waitlistStatus.textContent, pendingStatus);
  assert.equal(h.requests.length, 1);
  assertPost(h.requests[0], '/api/waitlist', { email: 'braider@example.test', businessType: 'braiders' });
  pending.resolve(jsonResponse({ ok: true }));
  await request;
  assert.match(h.waitlistStatus.textContent, /Braiders pilot list/);
  assert.equal(h.email.value, '');
  assert.equal(h.business.value, '');
  assert.equal(h.form.resetCount, 1);
  assert.equal(h.redirects.length, 0);
  assertWaitlistControls(h, false);
});

test('invalid business response focuses its field and permits correction and retry', async (t) => {
  let attempts = 0;
  const h = harness(t, () => ++attempts === 1
    ? jsonResponse({ error: 'invalid business type' }, 400) : jsonResponse({ ok: true }));
  h.email.value = 'studio@example.test';
  await h.form.dispatch('submit');
  assert.equal(h.business.getAttribute('aria-invalid'), 'true');
  assert.equal(h.business.focusCount, 1);
  assert.equal(h.email.getAttribute('aria-invalid'), null);
  assert.equal(h.email.focusCount, 0);
  assert.match(h.waitlistStatus.textContent, /choose a business type/);
  assert.equal(h.email.value, 'studio@example.test');
  assertWaitlistControls(h, false);
  h.business.value = 'braiders';
  await h.business.dispatch('change');
  assert.equal(h.business.getAttribute('aria-invalid'), null);
  assert.equal(h.waitlistStatus.textContent, '');
  await h.form.dispatch('submit');
  assert.equal(h.requests.length, 2);
  assertPost(h.requests[1], '/api/waitlist', { email: 'studio@example.test', businessType: 'braiders' });
  assert.match(h.waitlistStatus.textContent, /Braiders pilot list/);
  assertWaitlistControls(h, false);
});

const transportFailures = [
  ['network rejection', async () => { throw new TypeError('Simulated network failure'); }],
  ['HTTP 503 despite a success-shaped body', () => jsonResponse({ ok: true, url: mockCheckout }, 503)],
  ['malformed JSON', () => ({
    ...jsonResponse({}),
    json: async () => { throw new SyntaxError('Simulated malformed JSON'); },
  })],
];

for (const [name, fail] of [
  ...transportFailures,
  ['missing success flag', () => jsonResponse({})],
  ['false success flag', () => jsonResponse({ ok: false })],
  ['non-boolean success flag', () => jsonResponse({ ok: 'true' })],
  ['null JSON body', () => jsonResponse(null)],
]) {
  test(`waitlist recovers from ${name} and permits retry`, async (t) => {
    let attempts = 0;
    const h = harness(t, (...args) => ++attempts === 1 ? fail(...args) : jsonResponse({ ok: true }));
    h.email.value = 'shop@example.test';
    await h.form.dispatch('submit');
    assertWaitlistError(h);
    assert.equal(h.email.value, 'shop@example.test');
    assert.equal(h.email.getAttribute('aria-invalid'), null);
    assert.equal(h.timers.pending.size, 0);
    await h.form.dispatch('submit');
    assert.equal(h.requests.length, 2);
    assert.equal(h.waitlistStatus.dataset.state, 'success');
    assert.equal(h.form.resetCount, 1);
    assertWaitlistControls(h, false);
  });
}

test('duplicate waitlist submissions are suppressed until the first request settles', async (t) => {
  const pending = deferred();
  const h = harness(t, () => pending.promise);
  h.email.value = 'shop@example.test';
  const first = h.form.dispatch('submit');
  const pendingMessage = h.waitlistStatus.textContent;
  const second = await h.form.dispatch('submit');
  assert.equal(second.defaultPrevented, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.form.validityChecks, 1);
  assertWaitlistControls(h, true);
  await h.email.dispatch('input');
  assert.equal(h.waitlistStatus.textContent, pendingMessage, 'Input must not erase a pending status');
  pending.resolve(jsonResponse({ ok: true }));
  await first;
  assert.equal(h.form.resetCount, 1);
  assertWaitlistControls(h, false);
  h.email.value = 'another-shop@example.test';
  h.business.value = 'home_services';
  await h.form.dispatch('submit');
  assert.equal(h.requests.length, 2);
  assertPost(h.requests[1], '/api/waitlist', { email: 'another-shop@example.test', businessType: 'home_services' });
});

test('approval-based checkout sends the owner to the fixed vendor sign-in route', async (t) => {
  const h = harness(t, () => jsonResponse({ error: 'Sign in', next: 'https://untrusted.example/' }, 401));
  await h.checkout('monthly').dispatch('click');
  assert.deepEqual(h.redirects, ['/vendor/login']);
  assert.match(h.checkoutStatus.textContent, /approved vendor account/);
  assertCheckoutControls(h, false);
});

for (const [plan, destination, label] of [
  ['monthly', mockCheckout, 'relative local mock'],
  ['annual', stripeCheckout, 'Stripe'],
  ['annual', `${origin}${mockCheckout}?plan=annual`, 'absolute local mock'],
]) {
  test(`${plan} checkout sends its plan and redirects to ${label}`, async (t) => {
    const pending = deferred();
    const h = harness(t, () => pending.promise);
    const checkout = h.checkout(plan).dispatch('click');
    assert.equal(h.requests.length, 1);
    assertPost(h.requests[0], '/api/checkout', { plan });
    assertCheckoutControls(h, true, plan);
    assertWaitlistControls(h, false);
    assert.match(h.checkoutStatus.textContent, /opening secure checkout/i);
    assert.equal(h.checkoutStatus.dataset.state, '');
    pending.resolve(jsonResponse({ url: destination }));
    await checkout;
    assert.deepEqual(h.redirects, [new URL(destination, origin).href]);
    assert.match(h.checkoutStatus.textContent, /checkout is ready/i);
    assert.equal(h.checkoutStatus.dataset.state, '');
    assertCheckoutControls(h, false);
    assert.equal(h.requests[0].options.signal.aborted, false);
  });
}

for (const [name, fail] of [
  ...transportFailures,
  ['HTTP 400 with a trusted URL', () => jsonResponse({ url: mockCheckout }, 400)],
  ['null JSON body', () => jsonResponse(null)],
]) {
  test(`checkout recovers from ${name} and permits another plan`, async (t) => {
    let attempts = 0;
    const h = harness(t, (...args) => ++attempts === 1 ? fail(...args) : jsonResponse({ url: mockCheckout }));
    await h.checkout('monthly').dispatch('click');
    assertCheckoutError(h);
    assert.equal(h.timers.pending.size, 0);
    await h.checkout('annual').dispatch('click');
    assert.equal(h.requests.length, 2);
    assertPost(h.requests[1], '/api/checkout', { plan: 'annual' });
    assert.deepEqual(h.redirects, [`${origin}${mockCheckout}`]);
    assert.equal(h.checkoutStatus.dataset.state, '');
    assertCheckoutControls(h, false);
  });
}

const rejectedRedirects = [
  ['missing URL', undefined],
  ['null URL', null],
  ['numeric URL', 42],
  ['object URL', { href: stripeCheckout }],
  ['empty URL', ''],
  ['whitespace URL', '   '],
  ['unrelated relative path', 'not-a-checkout-url'],
  ['malformed URL', 'https://[invalid'],
  ['external origin', 'https://untrusted.example/billing/mock/checkout/session'],
  ['protocol-relative external origin', '//untrusted.example/checkout'],
  ['Stripe lookalike origin', 'https://checkout.stripe.com.untrusted.example/pay'],
  ['Stripe over HTTP', 'http://checkout.stripe.com/pay'],
  ['Stripe on another port', 'https://checkout.stripe.com:444/pay'],
  ['URL with user information', 'https://example-user@checkout.stripe.com/pay'],
  ['URL with a synthetic password', 'https://:example-password@checkout.stripe.com/pay'],
  ['script URL', 'javascript:alert(1)'],
  ['data URL', 'data:text/html,not-a-checkout'],
  ['unrelated same-origin URL', `${origin}/account`],
  ['incomplete local checkout prefix', '/billing/mock/checkout'],
  ['lookalike local checkout prefix', '/billing/mock/checkout-other/session'],
  ['path traversal outside checkout', '/billing/mock/checkout/../account'],
];

for (const [name, url] of rejectedRedirects) {
  test(`checkout rejects ${name} without navigating and can retry`, async (t) => {
    let attempts = 0;
    const h = harness(t, () => jsonResponse({ url: ++attempts === 1 ? url : stripeCheckout }));
    await h.checkout('monthly').dispatch('click');
    assertCheckoutError(h);
    assert.equal(h.timers.pending.size, 0);
    await h.checkout('monthly').dispatch('click');
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.redirects, [stripeCheckout]);
    assert.equal(h.checkoutStatus.dataset.state, '');
    assertCheckoutControls(h, false);
  });
}

test('checkout suppresses repeated clicks on either plan and unlocks both controls', async (t) => {
  const pending = deferred();
  const h = harness(t, () => pending.promise);
  const first = h.checkout('monthly').dispatch('click');
  await h.checkout('monthly').dispatch('click');
  await h.checkout('annual').dispatch('click');
  assert.equal(h.requests.length, 1);
  assertCheckoutControls(h, true, 'monthly');
  pending.resolve(jsonResponse({ url: mockCheckout }));
  await first;
  assertCheckoutControls(h, false);
  assert.equal(h.redirects.length, 1);
  await h.checkout('annual').dispatch('click');
  assert.equal(h.requests.length, 2);
  assertPost(h.requests[1], '/api/checkout', { plan: 'annual' });
  assert.equal(h.redirects.length, 2);
});

for (const flow of ['waitlist', 'checkout']) {
  for (const phase of ['fetch', 'JSON body']) {
    test(`${flow} aborts a stalled ${phase} at 12 seconds, recovers, and retries`, async (t) => {
      const bodyStarted = deferred();
      let attempts = 0;
      const success = flow === 'waitlist' ? { ok: true } : { url: mockCheckout };
      const h = harness(t, (_url, { signal }) => {
        if (++attempts > 1) return jsonResponse(success);
        const stalled = () => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('Simulated request abort');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
          bodyStarted.resolve();
        });
        return phase === 'fetch' ? stalled() : { ...jsonResponse({}), json: stalled };
      });
      h.email.value = 'shop@example.test';
      const start = () => flow === 'waitlist'
        ? h.form.dispatch('submit') : h.checkout('monthly').dispatch('click');
      const pending = start();
      await bodyStarted.promise;
      assert.equal(h.timers.pending.size, 1);
      const [[timerId, timer]] = h.timers.pending;
      assert.equal(timer.delay, 12000);
      assert.equal(h.requests[0].options.signal.aborted, false);
      h.timers.fire(timerId);
      assert.equal(h.requests[0].options.signal.aborted, true);
      await pending;
      if (flow === 'waitlist') {
        assertWaitlistError(h);
        assert.equal(h.email.value, 'shop@example.test');
      } else {
        assertCheckoutError(h);
      }
      assert.ok(h.timers.cleared.includes(timerId));
      await start();
      assert.equal(h.requests.length, 2);
      assert.equal(h.requests[1].options.signal.aborted, false);
      assertWaitlistControls(h, false);
      assertCheckoutControls(h, false);
      if (flow === 'waitlist') {
        assert.equal(h.waitlistStatus.dataset.state, 'success');
        assert.equal(h.form.resetCount, 1);
      } else {
        assert.deepEqual(h.redirects, [`${origin}${mockCheckout}`]);
        assert.equal(h.checkoutStatus.dataset.state, '');
      }
    });
  }
}

test('markup has unique expected IDs and a labelled native email form', () => {
  const ids = elements.filter(({ attrs }) => attrs.id).map(({ attrs }) => attrs.id);
  assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
  for (const id of [
    'main', 'for-your-business', 'home-services', 'braiders', 'how-it-works', 'pricing', 'faq', 'waitlist', 'waitlist-form',
    'home-services-pricing', 'braider-pricing', 'waitlist-business',
    'waitlist-email', 'waitlist-status', 'waitlist-privacy', 'checkout-status', 'checkout-terms',
  ]) byId(id);
  assert.equal(byId('main').tag, 'main');
  const form = byId('waitlist-form');
  assert.equal(form.tag, 'form');
  assert.equal(byId(form.attrs['aria-labelledby']).tag, 'h2');
  assert.equal(Object.hasOwn(form.attrs, 'novalidate'), false);
  const email = byId('waitlist-email');
  assert.equal(email.tag, 'input');
  assert.equal(email.attrs.type, 'email');
  assert.equal(email.attrs.name, 'email');
  assert.equal(email.attrs.autocomplete, 'email');
  assert.ok(Object.hasOwn(email.attrs, 'required'));
  const label = blocks(html, 'label').find(({ attrs }) => attrs.for === 'waitlist-email');
  assert.ok(label && text(label.content), 'Email must have a visible label');
  describedBy(email, 'waitlist-privacy', 'waitlist-status');
  const formMarkup = blocks(html, 'form').find(({ attrs }) => attrs.id === 'waitlist-form');
  const submit = tags(formMarkup.content, 'button').filter(({ attrs }) => attrs.type === 'submit');
  assert.equal(submit.length, 1);
  assert.ok(Object.hasOwn(submit[0].attrs, 'disabled'), 'Submission must wait for JS initialization');
});

test('both status messages are accessible live regions and both checkout actions are labelled', () => {
  for (const id of ['waitlist-status', 'checkout-status']) {
    const { attrs } = byId(id);
    assert.equal(attrs.role, 'status');
    assert.equal(attrs['aria-live'], 'polite');
    assert.equal(attrs['aria-atomic'], 'true');
  }
  const buttons = blocks(html, 'button').filter(({ attrs }) => Object.hasOwn(attrs, 'data-checkout'));
  assert.deepEqual(buttons.map(({ attrs }) => attrs['data-checkout']).sort(), ['annual', 'monthly']);
  for (const button of buttons) {
    assert.equal(button.attrs.type, 'button');
    assert.ok(Object.hasOwn(button.attrs, 'disabled'), 'Checkout must wait for JS initialization');
    assert.ok(text(button.content), 'Checkout must have a text label');
    describedBy(button, 'checkout-status', 'checkout-terms');
  }
});

test('business select has a visible label, an empty initial choice and only supported audiences', () => {
  const business = byId('waitlist-business');
  assert.equal(business.tag, 'select');
  assert.equal(business.attrs.name, 'businessType');
  assert.ok(Object.hasOwn(business.attrs, 'required'));
  describedBy(business, 'waitlist-privacy', 'waitlist-status');
  const label = blocks(html, 'label').find(({ attrs }) => attrs.for === 'waitlist-business');
  assert.ok(label && text(label.content));
  const select = blocks(html, 'select').find(({ attrs }) => attrs.id === 'waitlist-business');
  assert.deepEqual(tags(select.content, 'option').map(({ attrs }) => attrs.value), ['', 'home_services', 'braiders', 'other']);
  assert.ok(tags(select.content, 'option').every(({ attrs }) => !Object.hasOwn(attrs, 'selected')));
});

test('audiences have separate examples and only Home Services offers checkout', () => {
  const articles = blocks(html, 'article');
  for (const id of ['home-services', 'braiders']) {
    const audience = articles.find(({ attrs }) => attrs.id === id);
    assert.ok(audience);
    const examples = blocks(audience.content, 'figure');
    assert.equal(examples.length, 1);
    assert.match(text(examples[0].content), /illustrative.*after SMS consent/i);
    assert.ok(tags(audience.content, 'a').some(({ attrs }) => attrs['data-audience'] === (id === 'braiders' ? 'braiders' : 'home_services')));
  }
  const homePricing = articles.find(({ attrs }) => attrs.id === 'home-services-pricing');
  const braiderPricing = articles.find(({ attrs }) => attrs.id === 'braider-pricing');
  assert.match(text(homePricing.content), /\$49/);
  assert.match(text(homePricing.content), /Per-booking fee: waived for founding shops \(pilot\)/);
  assert.doesNotMatch(text(homePricing.content), /\$12/);
  assert.equal(tags(homePricing.content, 'button').filter(({ attrs }) => attrs['data-checkout']).length, 2);
  assert.equal(tags(braiderPricing.content, 'button').length, 0);
  assert.match(text(braiderPricing.content), /Home Services rates do not automatically apply/);
  assert.match(text(braiderPricing.content), /No card or payment/);
  assert.match(text(braiderPricing.content), /\$49\s*\/\s*month/);
  assert.match(text(braiderPricing.content), /First 10 founding studios: \$99 setup waived/);
  assert.match(text(braiderPricing.content), /Typically \$50, set by your studio/);
  assert.match(text(braiderPricing.content), /confirmed before activation/);
  assert.match(text(braiderPricing.content), /estimate/i);
  for (const { content } of blocks(homePricing.content, 'button')) assert.match(text(content), /Home Services/);
  assert.doesNotMatch(text(html), /Weekly recap|1–5 trucks/);
  assert.match(text(html), /not a live sync/);
});

test('positioning: any appointment-based local business, home services then braiders featured, plus an Also built for grid', () => {
  const all = text(html);
  assert.match(text(blocks(html, 'title')[0].content), /local businesses that book by phone/i);
  const meta = (name) => tags(html, 'meta').find(({ attrs }) => attrs.name === name || attrs.property === name).attrs.content;
  for (const m of ['description', 'og:description', 'twitter:description']) {
    assert.match(meta(m), /any appointment-based local business/i, m);
    assert.match(meta(m), /home services/i, m);
    assert.match(meta(m), /braiders/i, m);
  }
  assert.match(all, /Built in Atlanta/);
  assert.ok(html.indexOf('id="home-services"') < html.indexOf('id="braiders"'), 'Home Services card comes first');
  assert.ok(html.indexOf('id="braiders"') < html.indexOf('id="also-built-for"'), 'Also built for sits below the featured cards');
  assert.equal(byId('also-built-for').tag, 'section');
  assert.equal(byId(byId('also-built-for').attrs['aria-labelledby']).tag, 'h3');
  const start = html.indexOf('id="also-built-for"');
  const also = { content: html.slice(start, html.indexOf('</section>', start)) }; // nested section: slice to its own end
  const trades = blocks(also.content, 'li').map(({ content }) => text(content));
  assert.ok(trades.length >= 12, `at least 12 trades, got ${trades.length}`);
  for (const t of ['Nail techs', 'Lash &amp; brow artists', 'Barbers', 'House cleaners', 'Handymen', 'Pet groomers', 'Mobile detailers', 'Tutors', 'Photographers', 'Caterers &amp; home bakers', 'Electricians', 'Landscapers']) {
    assert.ok(trades.some((x) => x.includes(t)), t);
  }
  assert.ok(tags(also.content, 'a').some(({ attrs }) => attrs['data-audience'] === 'other'));
  assert.doesNotMatch(all, /Two focused pilots|two focused pilots|aren't part of this initial offer/);
  const faq = blocks(html, 'details').map(({ content }) => text(content)).find((x) => /Who is it for\?/.test(x));
  assert.ok(faq, 'FAQ: Who is it for?');
  assert.match(faq, /Any appointment-based local business/);
  assert.match(faq, /featured/);
  const other = byId('other-trades-pricing');
  assert.ok(other);
  const otherText = text(blocks(html, 'p').find(({ attrs }) => attrs.id === 'other-trades-pricing').content);
  assert.match(otherText, /from \$49\/month/);
  assert.match(otherText, /first 10 founding/);
  assert.match(otherText, /confirmed before activation/);
});

test('noscript offers usable email and phone contact fallbacks', () => {
  const fallback = blocks(html, 'noscript');
  assert.equal(fallback.length, 1);
  assert.match(text(fallback[0].content), /javascript/i);
  const links = tags(fallback[0].content, 'a').map(({ attrs }) => attrs.href);
  assert.ok(links.includes('mailto:hello@trybuzzcall.com'));
  assert.ok(links.includes('tel:+14704828377'));
});

test('FAQ uses native details and summaries with question and answer text', () => {
  const faq = blocks(html, 'section').find(({ attrs }) => attrs.id === 'faq');
  assert.ok(faq, 'FAQ section must exist');
  assert.equal(byId(faq.attrs['aria-labelledby']).tag, 'h2');
  const questions = blocks(faq.content, 'details');
  assert.ok(questions.length > 0, 'FAQ must contain native disclosure elements');
  for (const question of questions) {
    assert.match(question.content, /^\s*<summary\b/i, 'Summary must be the first child');
    const summaries = blocks(question.content, 'summary');
    assert.equal(summaries.length, 1);
    assert.ok(text(summaries[0].content), 'Each FAQ needs a question');
    const answers = blocks(question.content, 'p');
    assert.ok(answers.some(({ content }) => text(content)), 'Each FAQ needs an answer');
  }
});

test('deferred frontend script, stylesheet, and all local asset/link targets exist', () => {
  const scripts = tags(html, 'script');
  const frontend = scripts.filter(({ attrs }) => attrs.src
    && new URL(attrs.src, origin).pathname === '/site.js');
  assert.equal(frontend.length, 1);
  assert.ok(Object.hasOwn(frontend[0].attrs, 'defer'));
  assert.ok(tags(html, 'link').some(({ attrs }) => attrs.rel === 'stylesheet'
    && new URL(attrs.href, origin).pathname === '/home.css'));

  let checked = 0;
  for (const { attrs } of elements) {
    for (const reference of [attrs.src, attrs.href, attrs.poster].filter(Boolean)) {
      const url = new URL(reference, `${origin}/`);
      if (url.origin !== origin) continue; // Mail, phone, and external URLs are not local files.
      // This server-rendered sign-in route is exercised by site-http and vendor-http, not served from public/.
      if (url.pathname === '/vendor/login') continue;
      if (url.pathname === '/' && url.hash) {
        byId(decodeURIComponent(url.hash.slice(1)));
        continue;
      }
      const target = path.resolve(publicDir, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      const relative = path.relative(publicDir, target);
      assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `Local reference must remain in public/: ${reference}`);
      assert.ok(statSync(target).isFile(), `Missing local target: ${reference}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'At least the script and stylesheet must be checked');
});
