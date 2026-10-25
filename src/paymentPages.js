// Presentation only: routes remain responsible for authentication, Origin checks and state changes.
const { page, esc, icon, money, date, badge } = require('./ui');

const paymentPage = (title, businessName, body, mode = 'mock') => page({
  title, businessName, body, area: 'payment', mode, script: true,
});
const heading = (businessName, title, description) => `<div class="page-heading"><p class="eyebrow">${esc(businessName || 'Your business')}</p><h1>${esc(title)}</h1><p class="muted">${esc(description)}</p></div>`;
const line = (label, value) => `<div class="checkout-line"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;

function checkout({ session, cfg, id, businessName }) {
  if (session.completed) return paymentPage('Checkout simulation finished', businessName,
    `<section class="payment-card"><span class="result-icon">${icon('check')}</span>${heading(businessName, 'Checkout simulation finished', 'This demo checkout has already been completed. It is not a receipt for a real payment.')}<a class="button button-primary" href="/admin#payments">View payment workspace</a></section>`);
  const annual = session.plan === 'annual';
  const price = cfg.mock[annual ? 'annual' : 'monthly'];
  const trial = Number(cfg.trialDays) > 0;
  const pending = session.setup?.status === 'pending';
  const setupAmount = pending ? Number(cfg.mock.setup) : 0;
  const dueNow = trial ? 0 : Number(price) + setupAmount;
  const setupText = pending
    ? `${money(setupAmount)} · ${trial ? 'on the first simulated invoice after the trial, not today' : 'on the first simulated invoice today (no trial)'}`
    : session.setup?.status === 'waived' ? 'Waived' : 'No setup fee';
  const recurrence = annual ? 'year' : 'month';
  return paymentPage('Review your demo plan', businessName,
    `${heading(businessName, 'Review your demo plan', 'Preview the subscription schedule before completing this simulation.')}
<div class="payment-grid"><section class="payment-card"><p class="payment-kicker">BuzzCall subscription</p><h2>${annual ? 'Annual' : 'Monthly'} plan</h2><p class="payment-amount">${esc(money(price))}<span class="muted"> / ${recurrence}</span></p>
<p class="muted">Renews every ${recurrence} in the simulation unless canceled.</p>
${line('Trial', trial ? `${cfg.trialDays} days` : 'No trial')}${line('One-time setup', setupText)}
${session.setup?.reason ? `<p class="muted">Setup: ${esc(session.setup.reason === 'charged on first invoice after the trial' && !trial ? 'included at signup because no trial is configured' : session.setup.reason)}</p>` : ''}
</section><section class="payment-card payment-summary"><h2>Demo checkout summary</h2>${line('Simulated amount due today', money(dueNow))}
${trial ? `<p>Your ${esc(cfg.trialDays)}-day demo trial starts when you submit. The first simulated invoice after the trial is ${esc(money(Number(price) + setupAmount))}. Cancel during the trial and no simulated charge is due.</p>` : `<p>No trial is configured. Completing this demo records a simulated first invoice of ${esc(money(dueNow))}, including any pending setup fee.</p>`}
<p>Future simulated invoices are ${esc(money(price))} per ${recurrence}. No card or bank details are required.</p>
<form method="post" action="/billing/mock/checkout/${esc(encodeURIComponent(id))}/complete"><button class="button button-primary button-full" type="submit">${trial ? 'Start demo trial' : 'Complete demo checkout'}</button></form>
</section></div>`);
}

function deposit({ booking, businessName }) {
  const conflict = booking.status === 'paid_conflict';
  const paid = !!booking.paid;
  const held = !paid && booking.status === 'held' && Date.parse(booking.holdExpiresAt) > Date.now();
  const expired = booking.status === 'expired' || (!paid && booking.status === 'held' && Date.parse(booking.holdExpiresAt) <= Date.now());
  const confirmed = paid && booking.status === 'confirmed';
  const title = conflict ? 'This time needs follow-up' : confirmed ? 'Demo booking confirmed' : paid ? 'Demo payment recorded' : expired ? 'This hold has expired' : held ? 'Review your demo deposit' : 'This hold is unavailable';
  const description = conflict ? 'A simulated payment was recorded, but the time was not booked. Contact the business to arrange another time.'
    : confirmed ? 'The booking is confirmed in the simulation only. This is not a real payment receipt.'
      : paid ? 'A simulated payment is on record. Contact the business to confirm booking status.'
        : held ? 'Your time is held temporarily. Confirm below to simulate the deposit payment.'
          : 'Do not submit a payment for this hold. Contact the business to check availability and arrange a new time.';
  const status = conflict ? 'Follow-up needed' : confirmed ? 'Simulated confirmation' : paid ? 'Simulated payment' : held ? 'Held · awaiting demo payment' : expired ? 'Expired' : 'Unavailable';
  return paymentPage(title, businessName,
    `<section class="payment-card"><span class="result-icon">${icon(conflict || !held && !confirmed ? 'alert' : confirmed ? 'check' : 'calendar')}</span>
${heading(businessName, title, description)}${badge(status, conflict || !held && !confirmed ? 'warning' : confirmed ? 'good' : 'neutral')}
<div class="payment-summary"><p class="payment-kicker">Simulated deposit</p><p class="payment-amount">${esc(money(booking.amount))}</p>
<dl class="detail-list">${booking.service ? `<dt>Service</dt><dd>${esc(booking.service)}</dd>` : ''}<dt>Time</dt><dd>${esc(booking.slotLabel || 'Not recorded')}</dd>
${held ? `<dt>Hold expires (UTC)</dt><dd>${esc(date(booking.holdExpiresAt, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }))}</dd>` : ''}</dl></div>
${held ? `<form method="post" action="/pay/mock/${esc(encodeURIComponent(booking.id))}"><button class="button button-primary button-full" type="submit">Confirm demo payment</button></form><p class="muted">Availability is checked again when you submit. No payment details are needed.</p>` : `<div class="notice ${confirmed ? 'notice-good' : 'notice-warning'}">${esc(description)}</div>`}
</section>`);
}

function connectOnboarding({ connect, businessName }) {
  return paymentPage('Deposit account simulation', businessName,
    `<section class="payment-card"><span class="result-icon">${icon('shield')}</span>${heading(businessName, 'Deposit account simulation', 'Preview the account onboarding flow without connecting a real Stripe account.')}
<p>This is a local simulation, not Stripe onboarding. Do not enter banking, identity or payment details here.</p>
${connect.accountId ? `<dl class="detail-list"><dt>Demo account</dt><dd>${esc(connect.accountId)}</dd><dt>Simulation status</dt><dd>${esc(connect.label || connect.status || 'Pending')}</dd></dl>
<p class="notice">Completing this step updates the demo account only. Real deposits require a separately connected Stripe account with verified payment readiness.</p>
<form method="post" action="/admin/connect/mock/complete"><button class="button button-primary button-full" type="submit">Complete demo onboarding</button></form>` : `<div class="notice notice-warning">No demo account exists yet. Start onboarding from the deposit account section of your workspace.</div>`}
<div class="action-row"><a class="button button-outline" href="/admin#connect">Back to deposit settings</a></div></section>`);
}

function phoneConfirmation({ setupId, businessName, changes }) {
  const labels = { OWNER_PHONE: 'Lead alerts go to', FORWARD_TO_PHONE: 'Calls ring first at' };
  return paymentPage('Confirm phone number change', businessName,
    `<section class="payment-card"><span class="result-icon">${icon('phone')}</span>${heading(businessName, 'Confirm phone number change', 'Review where calls and lead alerts will go before applying this setup.')}
<p>Applying setup <strong>${esc(setupId)}</strong> changes:</p>
${changes.map((change) => `<section class="panel"><div class="panel-header"><h2>${esc(Object.hasOwn(labels, change.key) ? labels[change.key] : change.key)}</h2></div><dl class="panel-body detail-list"><dt>Current number</dt><dd>${esc(change.from || '(none)')}</dd><dt>New number</dt><dd>${esc(change.to || '(none)')}</dd></dl></section>`).join('')}
<p class="notice notice-warning">Only continue if you recognise these numbers. Anyone can submit the public setup form. Applying this setup changes the live line.</p>
<form method="post" action="/admin/setups/${esc(encodeURIComponent(setupId))}/apply"><input type="hidden" name="confirm_phones" value="1">
<label class="checkbox-field"><input type="checkbox" name="confirm_owner" value="1" required> These are the shop's own numbers, and I recognise and approve these changes.</label>
<div class="action-row"><button class="button button-primary" type="submit">Apply with these numbers</button><a class="button button-outline" href="/admin#setups">Cancel</a></div></form></section>`, 'live');
}

function returnPage({ kind, outcome, businessName, mode = 'live' }) {
  const depositReturn = kind === 'deposit';
  const success = outcome === 'success';
  const title = success ? 'Checkout return received' : 'You left checkout';
  const subject = depositReturn ? 'deposit' : 'subscription';
  return paymentPage(title, businessName,
    `<section class="payment-card"><span class="result-icon">${icon(success ? 'clock' : 'close')}</span>${heading(businessName, title, `About your ${subject} checkout`)}
${success ? `<div class="notice"><strong>Confirmation comes separately.</strong><p>This return page does not verify payment, a booking or subscription activation. The payment provider must finish processing; confirmation follows separately after the payment status has been verified.</p></div><p>${depositReturn ? 'Wait for confirmation from the business before treating a time as booked. Contact the business if you need to check payment or booking status.' : 'Check for a separate subscription confirmation. Contact the business if you need to check payment or subscription status.'}</p>` : `<div class="notice notice-warning"><strong>This is not a payment confirmation.</strong><p>Leaving checkout does not establish whether a payment was processed. Contact the business for payment${depositReturn ? ' or booking' : ' or subscription'} status before trying again.</p></div>`}
<a class="button button-outline" href="/">Back to BuzzCall</a></section>`, mode);
}

module.exports = { checkout, deposit, connectOnboarding, phoneConfirmation, returnPage };
