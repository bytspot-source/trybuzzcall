'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');

// Minimal DOM doubles exercise behavior without a browser or an added dependency.
class Element {
  constructor({ text = '', dataset = {}, value = '' } = {}) {
    this.textContent = text; this.dataset = dataset; this.value = value;
    this.hidden = false; this.disabled = false; this.attributes = new Map();
    this.queries = new Map(); this.listeners = new Map(); this.focused = false;
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  querySelector(selector) { const value = this.queries.get(selector); return Array.isArray(value) ? value[0] || null : value || null; }
  querySelectorAll(selector) { const value = this.queries.get(selector); return value ? Array.isArray(value) ? value : [value] : []; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, fn, options = {}) { const rows = this.listeners.get(name) || []; rows.push({ fn, once: options.once }); this.listeners.set(name, rows); }
  async fire(name, fields = {}) {
    const event = { ...fields, preventDefault() { this.defaultPrevented = true; } };
    for (const row of [...(this.listeners.get(name) || [])]) {
      if (row.once) this.listeners.set(name, (this.listeners.get(name) || []).filter(r => r !== row));
      await row.fn(event);
    }
    return event;
  }
  focus() { this.focused = true; }
  matches(selector) { return selector === '[data-page]' && !!this.dataset.page; }
  closest() { return this.parent || null; }
  scrollIntoView() { this.scrolled = true; }
}
function apiForm(overrides = {}) {
  const form = new Element({ dataset: { return: '/admin#payments', ...overrides } });
  form.action = 'https://shop.example/api/billing/cancel';
  form.setAttribute('data-api-form', '');
  form.fields = { plan: 'annual', sub: 'sub_test_owner' };
  form.button = new Element(); form.output = new Element();
  form.queries.set('button', [form.button]);
  form.queries.set('button[type="submit"], button', form.button);
  form.queries.set('.form-feedback', form.output);
  return form;
}
function planForm() {
  const form = apiForm();
  form.removeAttribute('data-api-form'); form.action = 'https://shop.example/api/billing/preview';
  form.subscription = new Element({ value: 'sub_test_owner' });
  form.queries.set('[name="sub"]', form.subscription);
  form.plan = new Element({ value: 'annual' }); form.confirm = new Element(); form.dismiss = new Element();
  form.preview = new Element(); form.preview.hidden = true;
  form.description = new Element(); form.amount = new Element();
  form.preview.queries.set('[data-preview-description]', form.description);
  form.preview.queries.set('[data-preview-amount]', form.amount);
  for (const [selector, element] of [['.plan-preview', form.preview], ['[name="plan"]', form.plan],
    ['[data-confirm-plan]', form.confirm], ['[data-dismiss-plan]', form.dismiss]]) form.queries.set(selector, element);
  form.queries.set('button', [form.button, form.confirm, form.dismiss]);
  return form;
}
function response(status = 200, body = { ok: true }, contentType = 'application/json') {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => contentType }, json: async () => body };
}
function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function boot({ forms = [], plans = [], pages = [], nav = [], filters = [], hash = '', pathname = '/admin', ids = {}, dialog = null, fetch } = {}) {
  const doc = new Element(), calls = [], destinations = [], timers = new Map(), events = new Map();
  let reloads = 0, timerId = 0;
  const crumb = new Element();
  doc.queries.set('[data-page]', pages); doc.queries.set('[data-nav]', nav);
  doc.queries.set('[data-page-name]', crumb); doc.queries.set('[data-filter-table]', filters);
  doc.queries.set('form[data-confirm], form[data-api-form]', forms);
  doc.queries.set('[data-plan-form]', plans);
  const hiddenControl = new Element(); hiddenControl.hidden = true;
  doc.queries.set('[data-js-only]', [hiddenControl]);
  doc.getElementById = id => id === 'confirm-dialog' ? dialog : ids[id] || pages.find(p => p.dataset.page === id) || null;
  const location = { origin: 'https://shop.example', pathname, search: '', hash,
    assign: value => destinations.push(value), reload: () => { reloads++; } };
  const win = {
    location, history: { replaceState: (_, __, value) => destinations.push(value) },
    addEventListener: (name, callback) => events.set(name, callback), scrollTo() {}, confirm: () => true,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { calls.push({ url, options }); return fetch ? fetch(url, options) : response(); },
  };
  class Data { constructor(form) { this.form = form; } forEach(fn) { Object.entries(this.form.fields || {}).forEach(([k,v]) => fn(v,k)); } }
  vm.runInNewContext(source, { document: doc, window: win, URL, AbortController, FormData: Data, Intl, TypeError }, { filename: 'dashboard.js' });
  return { win, calls, destinations, timers, crumb, hiddenControl, hashchange: () => events.get('hashchange')(), reloads: () => reloads };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('workspace navigation restores nested payout links and handles invalid fragments without selector injection', () => {
  const overview = new Element({ dataset: { page: 'overview', label: 'Overview' } });
  const payments = new Element({ dataset: { page: 'payments', label: 'Payments' } });
  overview.queries.set('h1', new Element()); payments.queries.set('h1', new Element());
  const connect = new Element(); connect.parent = payments;
  const nav = ['overview','payments'].map(id => new Element({ dataset: { nav: id } }));
  const app = boot({ pages: [overview,payments], nav, hash: '#connect', ids: { connect } });
  assert.equal(overview.hidden, true); assert.equal(payments.hidden, false);
  assert.equal(app.crumb.textContent, 'Payments');
  assert.equal(nav[1].getAttribute('aria-current'), 'page');
  assert.equal(nav[1].getAttribute('href'), '#payments');
  app.win.location.hash = '#%E0%A4'; app.hashchange();
  assert.equal(overview.hidden, false); assert.equal(payments.hidden, true);
  assert.equal(overview.querySelector('h1').focused, true);
  assert.equal(app.hiddenControl.hidden, false);
  app.win.location.hash = '#payments'; app.hashchange();
  app.win.location.hash = '#main'; app.hashchange();
  assert.equal(payments.hidden, false, 'Skip to content must preserve the current section');
  assert.equal(overview.hidden, true);
  assert.equal(payments.querySelector('h1').focused, true);
});

test('search combines text and status filters, reports no matches, and restores original counts', async () => {
  const container = new Element(), search = new Element(), select = new Element({ value: 'all' });
  const rows = [new Element({ text: 'Dana +14045550101 Water heater', dataset: { state: 'done' } }),
    new Element({ text: 'Alex +14045550102 AC service', dataset: { state: 'collecting' } })];
  const count = new Element({ text: '2 shown · 2 total' }), empty = new Element();
  for (const [selector, element] of [['[data-search]',search], ['[data-status-filter]',select], ['[data-filter-row]',rows],
    ['[data-filter-count]',count], ['[data-filter-empty]',empty]]) container.queries.set(selector,element);
  boot({ filters: [container] });
  search.value = '  WATER  '; await search.fire('input');
  assert.equal(rows[0].hidden,false); assert.equal(rows[1].hidden,true); assert.equal(count.textContent,'1 of 2 shown');
  select.value = 'collecting'; await select.fire('change');
  assert.equal(rows[0].hidden,true); assert.equal(empty.hidden,false);
  select.value = 'all'; search.value = ''; await search.fire('input');
  assert.equal(count.textContent,'2 shown · 2 total'); assert.equal(empty.hidden,true);
});

test('billing writes are single-flight, same-origin, and refresh stale values after success', async () => {
  const form = apiForm(), pending = deferred();
  const app = boot({ forms: [form], fetch: () => pending.promise });
  const submission = form.fire('submit', { submitter: form.button });
  await settle(); await form.fire('submit');
  assert.equal(app.calls.length,1); assert.equal(form.button.disabled,true);
  assert.equal(app.calls[0].options.credentials,'same-origin');
  assert.equal(app.calls[0].options.redirect,'error');
  assert.deepEqual(JSON.parse(app.calls[0].options.body),{ plan:'annual', sub:'sub_test_owner' });
  pending.resolve(response()); await submission;
  assert.equal(app.reloads(),1); assert.deepEqual(app.destinations,['/admin#payments']);
  assert.equal(form.button.disabled,false); assert.equal(app.timers.size,0);
});

test('payment failures remain visible and do not redirect or claim success', async (t) => {
  for (const [code,type,message] of [[401,'application/json',/sign-in/], [403,'text/plain',/refused/],
    [429,'text/plain',/Too many/], [500,'application/json',/could not be confirmed/], [200,'text/html',/could not read/]]) {
    await t.test(String(code)+' '+type, async () => {
      const form = apiForm(); const app = boot({ forms:[form], fetch:async()=>response(code,{error:'provider detail'},type) });
      await form.fire('submit');
      assert.match(form.output.textContent,message); assert.equal(form.output.getAttribute('role'),'alert');
      assert.equal(app.destinations.length,0); assert.equal(form.button.disabled,false);
    });
  }
});

test('malformed successful JSON cannot be reported as a saved billing change', async () => {
  for (const value of [null, 'paid', []]) {
    const form=apiForm(),app=boot({forms:[form],fetch:async()=>response(200,value)});
    await form.fire('submit');
    assert.equal(app.destinations.length,0);
    assert.match(form.output.textContent,/could not confirm the result/);
  }
});

test('unconfirmed actions and cross-origin form destinations cannot send credentials', async () => {
  const form = apiForm({ confirm:'Cancel renewal?' });
  const app = boot({ forms:[form] }); app.win.confirm=()=>false;
  await form.fire('submit'); assert.equal(app.calls.length,0);
  app.win.confirm=()=>true; form.action='https://attacker.example/write';
  await form.fire('submit'); assert.equal(app.calls.length,0);
  assert.match(form.output.textContent,/must stay on/);
});

test('confirmation dialog requires an affirmative result and restores focus', async () => {
  const form = apiForm({ confirm:'Cancel renewal at period end?' });
  const dialog = new Element(), description = new Element();
  dialog.queries.set('#confirm-description', description);
  dialog.showModal=()=>{ dialog.shown=true; };
  const app=boot({ forms:[form],dialog });
  const pending=form.fire('submit',{submitter:form.button}); await settle();
  assert.equal(dialog.shown,true); assert.equal(description.textContent,form.dataset.confirm);
  assert.equal(app.calls.length,0); dialog.returnValue='cancel'; await dialog.fire('close'); await pending;
  assert.equal(app.calls.length,0); assert.equal(form.button.focused,true);
  const second=form.fire('submit',{submitter:form.button}); await settle();
  dialog.returnValue='confirm'; await dialog.fire('close'); await second;
  assert.equal(app.calls.length,1);
});

test('unknown outcome timeout warns to check status and does not automatically repeat a charge', async () => {
  const form=apiForm();
  const app=boot({ forms:[form],fetch:(_,options)=>new Promise((_,reject)=>
    options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})))) });
  const pending=form.fire('submit'); await settle();
  [...app.timers.values()][0](); await pending;
  assert.match(form.output.textContent,/may have completed/); assert.equal(app.calls.length,1);
  assert.equal(app.destinations.length,0); assert.equal(form.button.disabled,false);
});

test('plan preview never charges; explicit confirmation uses the reviewed plan and proration timestamp', async () => {
  const form=planForm();
  const app=boot({ plans:[form],fetch:async url=>url.endsWith('/preview')
    ?response(200,{amount_due:42.5,proration_date:123456,note:'Provider estimate <not HTML>'}):response() });
  await form.fire('submit');
  assert.equal(app.calls.length,1); assert.equal(form.preview.hidden,false);
  assert.equal(form.description.textContent,'Provider estimate <not HTML>');
  assert.match(form.amount.textContent,/\$42.50/); assert.equal(app.destinations.length,0);
  await form.confirm.fire('click');
  assert.equal(app.calls.length,2);
  assert.deepEqual(JSON.parse(app.calls[0].options.body),{plan:'annual',sub:'sub_test_owner'});
  assert.deepEqual(JSON.parse(app.calls[1].options.body),{plan:'annual',sub:'sub_test_owner',proration_date:123456});
  assert.equal(app.reloads(),1);
});

test('changed plan invalidates both pending and displayed quotes', async () => {
  const form=planForm(), pending=deferred();
  const app=boot({ plans:[form], fetch:()=>pending.promise });
  const submit=form.fire('submit'); await settle();
  form.plan.value='monthly'; await form.plan.fire('change');
  pending.resolve(response(200,{amount_due_now:0,note:'Trial'})); await submit;
  assert.equal(form.preview.hidden,true); await form.confirm.fire('click'); assert.equal(app.calls.length,1);
  const next=planForm(); const app2=boot({ plans:[next],fetch:async()=>response(200,{amount_due_now:0}) });
  await next.fire('submit'); assert.equal(next.preview.hidden,false);
  next.plan.value='monthly'; await next.plan.fire('change'); await next.confirm.fire('click');
  assert.equal(app2.calls.length,1); assert.equal(next.preview.hidden,true);
});

test('a quote stays bound to its reviewed subscription, not a different current primary', async () => {
  const form=planForm(),app=boot({plans:[form],fetch:async()=>response(200,{amount_due_now:10})});
  await form.fire('submit');
  form.subscription.value='sub_different_checkout';
  await form.confirm.fire('click');
  assert.equal(app.calls.length,1, 'A changed subscription requires a new preview');
});

test('unchanged or invalid price estimates cannot enable a plan change', async () => {
  for (const data of [{unchanged:true},{amount_due:'not a number'},{amount_due:null}]) {
    const form=planForm(),app=boot({plans:[form],fetch:async()=>response(200,data)});
    await form.fire('submit'); await form.confirm.fire('click');
    assert.equal(form.preview.hidden,true); assert.equal(app.calls.length,1);
  }
});

test('failed plan change discards the quote and requires a new preview', async () => {
  const form=planForm(),app=boot({ plans:[form],fetch:async url=>url.endsWith('/preview')
    ?response(200,{amount_due_now:588}):response(502,{error:'provider unavailable'}) });
  await form.fire('submit'); await form.confirm.fire('click'); await form.confirm.fire('click');
  assert.equal(app.calls.length,2); assert.equal(form.preview.hidden,true);
  assert.equal(app.destinations.length,0); assert.match(form.output.textContent,/check its status/);
});

test('untrusted return destinations are never followed', async () => {
  const form=apiForm({return:'https://attacker.example/'});const app=boot({forms:[form]});
  await form.fire('submit'); assert.deepEqual(app.destinations,['/admin#payments']);
});

test('vendor plan changes use the form endpoint and refresh the vendor workspace', async () => {
  const form = planForm();
  form.action = 'https://shop.example/vendor/billing/preview';
  form.dataset.changeAction = '/vendor/billing/change-plan';
  form.dataset.return = '/vendor#payments';
  const app = boot({ plans: [form], pathname: '/vendor', fetch: async () => response(200, { amount_due_now: 20 }) });
  await form.fire('submit'); await form.confirm.fire('click');
  assert.deepEqual(app.calls.map(call => call.url), ['https://shop.example/vendor/billing/preview', 'https://shop.example/vendor/billing/change-plan']);
  assert.deepEqual(app.destinations, ['/vendor#payments']);
  assert.equal(app.reloads(), 1);
});

test('vendor billing return destinations are allowlisted and invalid destinations stay in vendor scope', async () => {
  for (const destination of [undefined, 'https://attacker.example/', '//attacker.example/vendor', 'http://[invalid', '/vendor/settings', '/vendor/billing/mock/portal/extra']) {
    const form = apiForm({ return: destination });
    form.action = 'https://shop.example/vendor/billing/cancel';
    const app = boot({ forms: [form], pathname: '/vendor/billing/mock/portal' });
    await form.fire('submit');
    const target = app.destinations[0];
    assert.equal(new URL(target, 'https://shop.example').pathname, '/vendor');
    assert.equal(new URL(target, 'https://shop.example').hash, '#payments');
    assert.equal(app.calls.length, 1);
  }
  const form = apiForm({ return: '/vendor/billing/mock/portal' });
  const app = boot({ forms: [form], pathname: '/vendor' });
  await form.fire('submit');
  assert.deepEqual(app.destinations, ['https://shop.example/vendor/billing/mock/portal']);
  assert.equal(app.reloads(), 0);
  const same = apiForm({ return: '/vendor/billing/mock/portal' });
  const portal = boot({ forms: [same], pathname: '/vendor/billing/mock/portal' });
  await same.fire('submit');
  assert.equal(portal.reloads(), 1);
  const unsafe = apiForm({ return: '//attacker.example/vendor' });
  const fallback = boot({ forms: [unsafe], pathname: '/vendor' });
  await unsafe.fire('submit');
  assert.deepEqual(fallback.destinations, ['/vendor#payments']);
  assert.equal(fallback.reloads(), 1, 'Even fallback fragments must refresh stale billing values');
});

test('a cross-origin plan change action is refused without sending credentials', async () => {
  const form = planForm();
  form.dataset.changeAction = 'https://attacker.example/charge';
  const app = boot({ plans: [form], fetch: async () => response(200, { amount_due_now: 20 }) });
  await form.fire('submit'); await form.confirm.fire('click');
  assert.equal(app.calls.length, 1);
  assert.match(form.output.textContent, /must stay on/);
  assert.equal(app.destinations.length, 0);
});

test('a missing plan return uses the current vendor scope rather than legacy admin', async () => {
  const form = planForm();
  delete form.dataset.return;
  form.dataset.changeAction = '/vendor/billing/change-plan';
  const app = boot({ plans: [form], pathname: '/vendor', fetch: async () => response(200, { amount_due_now: 0 }) });
  await form.fire('submit'); await form.confirm.fire('click');
  assert.deepEqual(app.destinations, ['/vendor#payments']);
  assert.equal(app.reloads(), 1);
});
