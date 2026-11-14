(() => {
  'use strict';

  const form = document.getElementById('waitlist-form');
  const email = document.getElementById('waitlist-email');
  const business = document.getElementById('waitlist-business');
  const waitlistStatus = document.getElementById('waitlist-status');
  const submit = form.querySelector('button[type="submit"]');
  let joining = false;

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

  business.addEventListener('change', () => {
    business.removeAttribute('aria-invalid');
    if (!joining) status(waitlistStatus, '');
  });

  document.querySelectorAll('[data-audience]').forEach((link) => {
    link.addEventListener('click', () => {
      if (joining || !['home_services', 'braiders', 'other'].includes(link.dataset.audience)) return;
      business.value = link.dataset.audience;
      business.removeAttribute('aria-invalid');
      status(waitlistStatus, '');
    });
  });

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
    business.disabled = true;
    form.setAttribute('aria-busy', 'true');
    email.removeAttribute('aria-invalid');
    business.removeAttribute('aria-invalid');
    const businessType = business.value;
    const pilotName = { braiders: 'Braiders', other: 'BuzzCall' }[businessType] || 'Home Services';
    status(waitlistStatus, 'Adding you to the list…');
    try {
      const { response, data } = await post('/api/waitlist', { email: email.value, businessType });
      if (response.ok && data.ok === true) {
        form.reset();
        status(waitlistStatus, `You're on the ${pilotName} pilot list! We'll follow up about fit and terms.`, 'success');
      } else if (response.status === 400) {
        const invalidBusiness = data?.error === 'invalid business type';
        const field = invalidBusiness ? business : email;
        field.disabled = false;
        field.setAttribute('aria-invalid', 'true');
        status(waitlistStatus, invalidBusiness ? 'Please choose a business type and try again.' : 'Please check your email address and try again.', 'error');
        field.focus();
      } else {
        throw new Error('Waitlist unavailable');
      }
    } catch {
      status(waitlistStatus, "We couldn't save your email. Please try again, or email hello@trybuzzcall.com.", 'error');
    } finally {
      joining = false;
      submit.disabled = false;
      email.readOnly = false;
      business.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });

  // Signup is through /setup (plain links); there is no public checkout on this page.
  submit.disabled = false;
})();
