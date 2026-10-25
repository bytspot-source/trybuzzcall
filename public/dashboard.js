/* Progressive enhancement only. Authentication and all write checks remain on the server. */
(function () {
  'use strict';
  const doc = document;
  const all = (selector, root = doc) => Array.from(root.querySelectorAll(selector));
  const pages = all('[data-page]');
  const links = all('[data-nav]');
  function showPage(moveFocus) {
    if (!pages.length) return;
    let id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { id = ''; }
    if (id === 'main' && moveFocus) {
      const current = pages.find(page => !page.hidden) || pages[0];
      const heading = current.querySelector('h1');
      if (heading) heading.focus();
      return;
    }
    const target = doc.getElementById(id || 'overview');
    const selected = target && (target.matches('[data-page]') ? target : target.closest('[data-page]')) || pages[0];
    pages.forEach(page => { page.hidden = page !== selected; });
    links.forEach(link => {
      const active = link.dataset.nav === selected.dataset.page;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    const crumb = doc.querySelector('[data-page-name]');
    if (crumb) crumb.textContent = selected.dataset.label;
    if (moveFocus) {
      const heading = selected.querySelector('h1');
      if (target && target !== selected) target.scrollIntoView({ block: 'start' });
      else if (heading) { heading.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
    }
  }
  // A standalone billing page uses workspace navigation but contains no switchable panels.
  if (pages.length) {
    showPage(false);
    window.addEventListener('hashchange', () => showPage(true));
    links.forEach(link => { link.setAttribute('href', '#' + link.dataset.nav); });
  }
  all('[data-js-only]').forEach(element => { element.hidden = false; });
  all('[data-filter-table]').forEach(container => {
    const rows = all('[data-filter-row]', container);
    const search = container.querySelector('[data-search]');
    const select = container.querySelector('[data-status-filter]');
    const count = container.querySelector('[data-filter-count]');
    const empty = container.querySelector('[data-filter-empty]');
    const originalCount = count && count.textContent;
    function filter() {
      const query = (search ? search.value : '').trim().toLocaleLowerCase();
      const state = select ? select.value : 'all';
      let visible = 0;
      rows.forEach(row => {
        const match = (state === 'all' || row.dataset.state === state) && row.textContent.toLocaleLowerCase().includes(query);
        row.hidden = !match;
        if (match) visible++;
      });
      if (count) count.textContent = query || state !== 'all' ? `${visible} of ${rows.length} shown` : originalCount;
      if (empty) empty.hidden = !rows.length || visible > 0;
    }
    if (search) search.addEventListener('input', filter);
    if (select) select.addEventListener('change', filter);
  });

  const confirmation = doc.getElementById('confirm-dialog');
  let confirming = false;
  function ask(message, returnFocus) {
    if (confirming) return Promise.resolve(false);
    if (!confirmation || typeof confirmation.showModal !== 'function') return Promise.resolve(window.confirm(message));
    confirming = true;
    confirmation.querySelector('#confirm-description').textContent = message;
    confirmation.returnValue = 'cancel';
    return new Promise(resolve => {
      confirmation.addEventListener('close', () => {
        confirming = false;
        if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
        resolve(confirmation.returnValue === 'confirm');
      }, { once: true });
      confirmation.showModal();
    });
  }
  function feedback(form, message, error) {
    const output = form.querySelector('.form-feedback');
    if (!output) return;
    output.textContent = message;
    output.classList.toggle('is-error', !!error);
    output.setAttribute('role', error ? 'alert' : 'status');
  }
  function busy(form, pending) {
    form.setAttribute('aria-busy', String(pending));
    all('button', form).forEach(button => { button.disabled = pending; });
  }
  async function post(url, body) {
    const endpoint = new URL(url, window.location.origin);
    // All enhancement requests are same-origin. Never send cached credentials to a supplied URL.
    if (endpoint.origin !== window.location.origin) throw new Error('This action must stay on your BuzzCall site.');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await window.fetch(endpoint.href, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      if (response.status === 401) throw new Error('Your sign-in is required. Reload this page and sign in again.');
      if (response.status === 403) throw new Error('The request was refused. Reload this page before trying again.');
      if (response.status === 429) throw new Error('Too many attempts. Wait before trying again.');
      const type = response.headers.get('content-type') || '';
      if (!type.includes('application/json')) throw new Error('We could not read the result. Refresh to check the current state before trying again.');
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('We could not confirm the result. Refresh to check the current state before trying again.');
      }
      if (!response.ok) throw new Error(response.status >= 500 ? 'The action could not be confirmed. Refresh to check its status before trying again.' :
        typeof data.error === 'string' ? data.error : 'The action could not be completed.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The request timed out. It may have completed; refresh to check before trying again.');
      if (error instanceof TypeError) throw new Error('Connection interrupted. Refresh to check the current state before trying again.');
      throw error;
    } finally { window.clearTimeout(timer); }
  }
  function formBody(form) {
    const result = {};
    new FormData(form).forEach((value, key) => { result[key] = value; });
    return result;
  }
  function returnTo(path) {
    const fallback = /^\/vendor(?:\/|$)/.test(window.location.pathname) ? '/vendor#payments' : '/admin#payments';
    let url;
    try { url = new URL(path || fallback, window.location.origin); }
    catch { url = new URL(fallback, window.location.origin); }
    if (url.origin !== window.location.origin || url.username || url.password || !['/admin', '/billing/mock/portal', '/vendor', '/vendor/billing/mock/portal'].includes(url.pathname)) {
      url = new URL(fallback, window.location.origin);
    }
    // A fragment-only assign would leave stale billing values in the DOM.
    if (url.pathname === window.location.pathname && url.search === window.location.search) {
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      window.location.reload();
    } else window.location.assign(url.href);
  }
  const submitting = new WeakSet();
  const confirmed = new WeakSet();
  all('form[data-confirm], form[data-api-form]').forEach(form => {
    form.addEventListener('submit', async event => {
      if (confirmed.has(form)) { confirmed.delete(form); return; }
      event.preventDefault();
      if (submitting.has(form)) return;
      submitting.add(form);
      const submitter = event.submitter || form.querySelector('button[type="submit"], button');
      try {
        if (form.dataset.confirm && !await ask(form.dataset.confirm, submitter)) return;
        if (!form.hasAttribute('data-api-form')) {
          confirmed.add(form);
          form.requestSubmit(submitter || undefined);
          return;
        }
        busy(form, true); feedback(form, 'Saving your change…', false);
        await post(form.action, formBody(form));
        feedback(form, 'Saved. Refreshing your workspace…', false);
        returnTo(form.dataset.return);
      } catch (error) { feedback(form, error.message, true); }
      finally { submitting.delete(form); busy(form, false); }
    });
  });

  all('[data-plan-form]').forEach(form => {
    const panel = form.querySelector('.plan-preview');
    const plan = form.querySelector('[name="plan"]');
    const subscription = form.querySelector('[name="sub"]');
    const confirm = form.querySelector('[data-confirm-plan]');
    const dismiss = form.querySelector('[data-dismiss-plan]');
    let quote = null;
    let pending = false;
    function clear() { quote = null; panel.hidden = true; feedback(form, '', false); }
    plan.addEventListener('change', clear);
    dismiss.addEventListener('click', clear);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending) return;
      clear(); pending = true; busy(form, true);
      const selected = plan.value;
      const sub = subscription && subscription.value;
      feedback(form, 'Fetching your plan estimate…', false);
      try {
        if (!sub) throw new Error('Reload your workspace to identify the subscription before changing plans.');
        const result = await post(form.action, { plan: selected, sub });
        // Ignore a response if the selection changed while the estimate was loading.
        if (plan.value !== selected || subscription.value !== sub) { feedback(form, 'Your selection changed. Preview this plan again.', false); return; }
        if (result.unchanged) { feedback(form, 'You are already on this billing interval.', false); return; }
        const amount = result.amount_due_now ?? result.amount_due;
        if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('A valid estimate was not returned. Use Manage billing or contact support.');
        quote = { plan: selected, sub, ...(result.proration_date ? { proration_date: result.proration_date } : {}) };
        panel.querySelector('[data-preview-description]').textContent = typeof result.note === 'string' ? result.note : `Change to ${selected} billing.`;
        panel.querySelector('[data-preview-amount]').textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount) + ' estimated amount due';
        panel.hidden = false; feedback(form, 'Review the estimate before confirming.', false);
      } catch (error) { feedback(form, error.message, true); }
      finally { pending = false; busy(form, false); }
    });
    confirm.addEventListener('click', async () => {
      if (pending || !quote || quote.plan !== plan.value || quote.sub !== subscription.value) return;
      pending = true; busy(form, true);
      feedback(form, 'Applying your plan change…', false);
      try {
        await post(form.dataset.changeAction || '/api/billing/change-plan', quote);
        quote = null;
        returnTo(form.dataset.return);
      } catch (error) {
        // A new preview is required after an uncertain write; never replay a stale quote.
        quote = null; panel.hidden = true;
        feedback(form, error.message, true);
      } finally { pending = false; busy(form, false); }
    });
  });
})();
