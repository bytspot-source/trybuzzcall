'use strict';
// Views for no-show disputes: the vendor check-in page, the vendor proof page (signed link and portal), and the
// admin dispute block shown inside the Deposits view. Every value is escaped at the HTML boundary.
const { esc, badge, page, icon } = require('./ui');
const shopTime = require('./shopTime');

const when = (v) => {
  if (!v || !Number.isFinite(Date.parse(v))) return 'Not recorded';
  try { return new Date(v).toLocaleString('en-US', { timeZone: shopTime.timeZone(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
  catch { return new Date(v).toISOString(); }
};
const SOURCE = { mms: 'MMS reply', sms: 'Text reply', portal: 'Vendor portal', link: 'Proof link' };
const shell = (title, body, { businessName = 'BuzzCall', mode = 'live' } = {}) =>
  page({ title, body: `${body}<script src="/dispute.js" defer></script>`, area: 'payment', businessName, mode, script: false, headerAction: null });

const REASONS = {
  too_early: 'Check-in opens a little before the appointment. Try again closer to the start time.',
  too_late: 'The check-in window for this appointment has closed.',
  not_confirmed: 'This booking is not confirmed, so it cannot be checked in.',
  not_found: 'This booking was not found.',
  no_time: 'This booking has no appointment time recorded.',
  expired: 'This link has expired.',
};
// state: { booking, result?, error?, windowState, opensAt, closesAt, action }
function checkinPage({ booking: b, shopName, action, result, error, windowState: ws, opensAt, closesAt, mode }) {
  const appt = b ? `${b.service || b.need || 'Appointment'}${b.slotLabel ? ` · ${b.slotLabel}` : ''}` : '';
  let body;
  if (result && result.ok) {
    const c = result.checkIn;
    body = `<h1>${result.already ? 'Already checked in' : "You're checked in"}</h1><p>${esc(appt)}</p><p>${badge(`Checked in ${when(c.at)}`, 'good')}</p><p class="muted">${c.geo ? 'Your location was saved with the check-in.' : 'No location was shared. That is fine; the time is recorded.'} If a customer later says you didn't show, this check-in helps settle it.</p>`;
  } else if (error) {
    body = `<h1>Check-in not recorded</h1><p>${esc(REASONS[error] || 'This check-in could not be recorded.')}</p>${b ? `<p class="muted">${esc(appt)}</p>` : ''}${ws === 'early' && opensAt ? `<p class="muted">Check-in opens ${esc(when(opensAt))}.</p>` : ''}`;
  } else {
    body = `<h1>Tap when you arrive</h1><p><strong>${esc(shopName || '')}</strong></p><p>${esc(appt)}</p>`
      + `<form method="post" action="${esc(action)}" data-checkin-form><input type="hidden" name="lat"><input type="hidden" name="lng"><input type="hidden" name="accuracy">`
      + `<button class="button button-primary" type="submit">${icon('check')} I'm here</button></form>`
      + `<p class="muted">Your browser may ask to share your location. Sharing is optional. Check-in is open ${esc(when(opensAt))} to ${esc(when(closesAt))}.</p>`;
  }
  return shell('Check in', `<section class="payment-card">${body}</section>`, { businessName: shopName, mode });
}

function evidenceList(d, { photoUrl } = {}) {
  const ev = (d && d.dispute && d.dispute.evidence) || [];
  if (!ev.length) return '<p class="muted">No proof submitted yet.</p>';
  return `<ul class="evidence-list">${ev.map((e) => `<li><strong>${esc(SOURCE[e.source] || e.source)}</strong> · ${esc(when(e.at))}${e.text ? `<br>${esc(e.text)}` : ''}${(e.media || []).map((m, i) => `<br><a class="text-action" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">MMS photo ${i + 1}${m.contentType ? ` (${esc(m.contentType)})` : ''}</a>`).join('')}${e.photoId && photoUrl ? `<br><a class="text-action" href="${esc(photoUrl(e.photoId))}" target="_blank" rel="noopener noreferrer">Uploaded photo</a>` : e.photoId ? '<br>Photo uploaded' : ''}</li>`).join('')}</ul>`;
}
// Vendor proof form (signed link or portal).
function proofPage({ deposit: d, booking: b, shopName, action, message, error, open, mode, backHref, evidenceHref, photoUrl }) {
  const appt = b ? `${b.service || b.need || 'Appointment'}${b.slotLabel ? ` · ${b.slotLabel}` : ''}` : `Booking ${d ? d.bookingId : ''}`;
  const checked = d && d.vendorCheckIn ? `<p>${badge(`You checked in ${when(d.vendorCheckIn.at)}`, 'good')}</p>` : '';
  const form = open
    ? `<form method="post" action="${esc(action)}" data-proof-form><label class="field">What happened?<textarea name="note" rows="4" maxlength="1000" placeholder="For example: arrived 9:05, customer didn't answer the door, photo of the front gate attached."></textarea></label>`
      + `<label class="field">Photo (optional)<input type="file" accept="image/*" data-photo></label><input type="hidden" name="photo"><p class="muted" data-photo-status></p>`
      + `<button class="button button-primary" type="submit">Send proof</button></form><p class="muted">You can also reply to BuzzCall's text with a photo or details.</p>`
    : '<p class="muted">This claim is closed, so no more proof is needed.</p>';
  const body = `<section class="payment-card"><h1>Respond to a no-show claim</h1><p><strong>${esc(shopName || '')}</strong></p><p>${esc(appt)}</p><p>The customer replied that you didn't show. Send a photo or a short note (for example, arrival time, a photo of the job or the address, a text thread). BuzzCall reviews both sides before any refund.</p>${checked}`
    + `${message ? `<p class="notice">${esc(message)}</p>` : ''}${error ? `<p class="notice notice-warning">${esc(error)}</p>` : ''}${form}<h2>Proof on file</h2>${evidenceList(d, { photoUrl })}`
    + (evidenceHref ? `<p><a class="button button-outline" href="${esc(evidenceHref)}">Download evidence</a></p><p class="muted">If the customer disputes the charge with their bank, Stripe asks you to respond in your Stripe Dashboard. Attach this summary (check-in time, location and timeline) and your photos.</p>` : '')
    + `${backHref ? `<p><a class="text-action" href="${esc(backHref)}">Back to your workspace</a></p>` : ''}</section>`;
  return shell('No-show claim', body, { businessName: shopName, mode });
}

// Admin: dispute block inside the Deposits table (Booking cell). qs = '?shop=...' or ''.
function adminDispute(d, { qs = '', base = '/admin/deposits' } = {}) {
  if (!d.dispute && !d.vendorCheckIn && !(d.timeline || []).length) return '';
  const x = d.dispute || {};
  const flags = [];
  if (d.vendorCheckIn) flags.push(badge(`Vendor checked in ${when(d.vendorCheckIn.at)}${d.vendorCheckIn.geo ? ' · location' : ''}`, 'good'));
  if (x.repeatClaim) flags.push(badge(`Repeat claimer: ${x.repeatClaim.count} claims`, 'danger'));
  if (x.customerReply === 'keep') flags.push(badge('Customer replied KEEP', 'warning'));
  if (x.followupSkipped) flags.push(badge(`Follow-up not sent (${x.followupSkipped.replace(/_/g, ' ')})`, 'warning'));
  if (x.resolution) flags.push(badge(`Resolved for ${x.resolution}`, x.resolution === 'vendor' ? 'good' : 'neutral'));
  const geo = d.vendorCheckIn && d.vendorCheckIn.geo;
  const map = geo ? ` <a class="text-action" href="https://www.google.com/maps?q=${encodeURIComponent(`${geo.lat},${geo.lng}`)}" target="_blank" rel="noopener noreferrer">map</a>` : '';
  const rows = (d.timeline || []).map((t) => `<li><span class="mono">${esc(when(t.at))}</span> · ${esc(t.text)}${t.type === 'checkin' ? map : ''}</li>`).join('');
  const photoUrl = (pid) => `${base}/${encodeURIComponent(d.id)}/photo/${encodeURIComponent(pid)}${qs}`;
  const flag = d.customerFlag;
  const prepay = flag ? `<form method="post" action="${base}/${esc(encodeURIComponent(d.id))}/prepay${esc(qs)}" style="display:inline"><input type="hidden" name="on" value="${flag.requirePrepay ? '0' : '1'}"><button class="button button-outline" type="submit">${flag.requirePrepay ? 'Stop requiring full prepay' : 'Require full prepay for this customer'}</button></form>` : '';
  return `<details class="dispute"${d.status === 'disputed' || (x.openedAt && !x.resolution) ? ' open' : ''}><summary>Dispute timeline</summary><div>${flags.join(' ')}</div><ol class="dispute-timeline">${rows}</ol>`
    + (x.openedAt ? `<h4>Vendor proof</h4>${evidenceList(d, { photoUrl })}` : '')
    + (flag ? `<p class="muted">Customer flagged: ${esc(flag.count)} no-show claim(s) in the window${flag.requirePrepay ? '; full prepay required (stored flag)' : ''}.</p>${prepay}` : '')
    + (x.openedAt ? ` <a class="text-action" href="${base}/${esc(encodeURIComponent(d.id))}/evidence.txt${esc(qs)}">Download evidence summary (for Stripe disputes)</a>` : '')
    + '</details>';
}
module.exports = { checkinPage, proofPage, adminDispute, evidenceList, REASONS, when };
