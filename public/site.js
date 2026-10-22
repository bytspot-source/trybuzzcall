(() => {
  'use strict';

  const form = document.getElementById('waitlist-form');
  const email = document.getElementById('waitlist-email');
  const waitlistStatus = document.getElementById('waitlist-status');
  const checkoutStatus = document.getElementById('checkout-status');
  const submit = form.querySelector('button[type="submit"]');
  const checkoutButtons = [...document.querySelectorAll('[data-checkout]')];
  let joining = false;
  let checkingOut = false;

  function status(element, message, state = '') {
    element.textContent = message;
    element.dataset.state = state;
  }

  async function post(url, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json();
      return { response, data };
    } finally {
      clearTimeout(timeout);
    }
  }

  // Only hand off to our local demo checkout or the existing Stripe integration.
  function checkoutUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value, window.location.origin);
      if (url.username || url.password) return null;
      const stripe = url.origin === 'https://checkout.stripe.com';
      const mock = url.origin === window.location.origin && url.pathname.startsWith('/billing/mock/checkout/');
      return stripe || mock ? url.href : null;
    } catch {
      return null;
    }
  }

  email.addEventListener('input', () => {
    email.removeAttribute('aria-invalid');
    if (!joining) status(waitlistStatus, '');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (joining) return;
    email.value = email.value.trim();
    if (!form.reportValidity()) return;
    joining = true;
    submit.disabled = true;
    email.readOnly = true;
    form.setAttribute('aria-busy', 'true');
    email.removeAttribute('aria-invalid');
    status(waitlistStatus, 'Adding you to the list…');
    try {
      const { response, data } = await post('/api/waitlist', { email: email.value });
      if (response.ok && data.ok === true) {
        form.reset();
        status(waitlistStatus, "You're on the list! We'll be in touch about your shop.", 'success');
      } else if (response.status === 400) {
        email.setAttribute('aria-invalid', 'true');
        status(waitlistStatus, 'Please check your email address and try again.', 'error');
        email.focus();
      } else {
        throw new Error('Waitlist unavailable');
      }
    } catch {
      status(waitlistStatus, "We couldn't save your email. Please try again, or email hello@trybuzzcall.com.", 'error');
    } finally {
      joining = false;
      submit.disabled = false;
      email.readOnly = false;
      form.removeAttribute('aria-busy');
    }
  });

  checkoutButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      if (checkingOut) return;
      checkingOut = true;
      checkoutButtons.forEach((item) => { item.disabled = true; });
      button.setAttribute('aria-busy', 'true');
      status(checkoutStatus, 'Opening secure checkout…');
      try {
        const { response, data } = await post('/api/checkout', { plan: button.dataset.checkout });
        const url = response.ok && checkoutUrl(data.url);
        if (!url) throw new Error('Checkout unavailable');
        window.location.assign(url);
        status(checkoutStatus, 'Checkout is ready. If it does not open, please try again.');
      } catch {
        status(checkoutStatus, "Checkout isn't available right now. Please try again or join the pilot list below.", 'error');
      } finally {
        checkingOut = false;
        checkoutButtons.forEach((item) => { item.disabled = false; });
        button.removeAttribute('aria-busy');
      }
    });
    button.disabled = false;
  });
  submit.disabled = false;
})();
