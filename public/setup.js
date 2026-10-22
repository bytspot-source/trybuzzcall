// /setup: live balance checks (shared rules in /setup-rules.js = src/setupRules.js), conditional fields, submit flow.
(function () {
  'use strict';
  var R = window.SetupRules;
  var form = document.getElementById('setup-form');
  if (!R || !form) return;
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var summary = $('#setup-summary'), confirmBox = $('#setup-confirm'), status = $('#setup-status');
  var rows = $('#service-rows'), addBtn = $('#add-service'), submitBtn = $('#setup-submit');
  var touched = {}, dirty = {}, attempted = false, busy = false, nextRow = $$('.service-row', rows).length;

  function radio(name) { var x = $('input[name="' + name + '"]:checked', form); return x ? x.value : ''; }
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function collect() {
    return {
      businessName: val('businessName'), city: val('city'), businessType: val('businessType'), tradeName: val('tradeName'), flow: radio('flow'),
      ownerPhone: val('ownerPhone'), forwardPhone: val('forwardPhone'), ringSeconds: val('ringSeconds'),
      days: $$('input[name="days"]:checked', form).map(function (x) { return x.value; }),
      open: val('open'), close: val('close'), tz: val('tz'),
      services: $$('.service-row', rows).map(function (r) {
        return { row: Number(r.dataset.row), name: $('input[name="service_name"]', r).value, hours: $('input[name="service_hours"]', r).value, minutes: $('select[name="service_minutes"]', r).value };
      }),
      booking: radio('booking') || 'times', slotMinutes: val('slotMinutes'), leadMinutes: val('leadMinutes'),
      deposit: $('#deposit').checked, depositAmount: val('depositAmount'), holdMinutes: val('holdMinutes'),
      bookingLink: val('bookingLink'), email: val('email'), consent: $('#consent').checked, website: val('website'),
    };
  }

  // ---- conditional sections (by business type -> flow: appointments shows services, jobs shows window length) ----
  function cap(x) { return x.charAt(0).toUpperCase() + x.slice(1); }
  function current() {
    var key = val('businessType'), t = key ? R.trades.get(key, { flow: radio('flow'), label: val('tradeName') }) : null;
    return { key: key, trade: t, flow: !t ? '' : key === 'other' ? (radio('flow') || '') : t.flow };
  }
  function sync() {
    var c = current(), word = (c.trade && c.trade.serviceWord) || 'service';
    $$('[data-show="appointments"]').forEach(function (el) { el.hidden = c.flow !== 'appointments'; });
    $$('[data-show="jobs"]').forEach(function (el) { el.hidden = c.flow !== 'jobs'; });
    $$('[data-show="other"]').forEach(function (el) { el.hidden = c.key !== 'other'; });
    $$('[data-show-booking]').forEach(function (el) { el.hidden = radio('booking') === 'callback'; });
    $$('[data-show-deposit]').forEach(function (el) { el.hidden = !$('#deposit').checked; });
    $$('[data-word]', form).forEach(function (el) { el.textContent = word; });
    $$('[data-word-cap]', form).forEach(function (el) { el.textContent = cap(word); });
    $$('.row-remove', rows).forEach(function (b) { b.setAttribute('aria-label', 'Remove this ' + word); });
    addBtn.textContent = '+ Add another ' + word;
    $('#services-tag').textContent = c.trade ? (c.key === 'other' ? (val('tradeName') || 'Your menu') : c.trade.short) : 'Your menu';
    var n = 0; $$('.setup-card legend .step-no', form).forEach(function (s) { if (!s.closest('fieldset').hidden) s.textContent = ++n; });
    addBtn.hidden = false;
  }
  function servicesEdited() { return touched.services || Object.keys(dirty).some(function (k) { return /^services/.test(k); }); }
  // Picking a trade prefills its usual days, hours, deposit, window length and service menu, unless the owner already edited them.
  function applyDefaults() {
    var c = current(); if (!c.trade) return;
    var d = R.tradeDefaults(c.key, c.flow || 'appointments'); if (!d) return;
    if (!dirty.days) $$('input[name="days"]', form).forEach(function (x) { x.checked = d.days.indexOf(Number(x.value)) >= 0; });
    if (!dirty.open) $('#open').value = d.open;
    if (!dirty.close) $('#close').value = d.close;
    if (!dirty.depositAmount) $('#depositAmount').value = d.depositAmount;
    if (!dirty.slotMinutes && $('#slotMinutes option[value="' + d.slotMinutes + '"]')) $('#slotMinutes').value = String(d.slotMinutes);
    if (c.flow === 'appointments' && !servicesEdited()) {
      rows.innerHTML = ''; nextRow = 0;
      (d.services.length ? d.services : [{ name: '', minutes: 0 }]).forEach(function (x) { addRow(x.name, x.minutes); });
    }
  }

  // ---- services rows ----
  function addRow(name, minutes) {
    var i = nextRow++, h = minutes ? Math.floor(minutes / 60) : '', m = minutes ? minutes % 60 : 0;
    var el = document.createElement('div');
    el.className = 'service-row'; el.dataset.row = i; el.dataset.field = 'services.' + i;
    el.innerHTML = '<div class="field" data-field="services.' + i + '.name"><label for="svc-name-' + i + '" data-word-cap>Service</label><input id="svc-name-' + i + '" name="service_name" maxlength="60"></div>'
      + '<div class="field svc-dur" data-field="services.' + i + '.duration"><span class="label" id="svc-dur-' + i + '">How long?</span><div class="dur"><input id="svc-h-' + i + '" name="service_hours" type="number" inputmode="numeric" min="0" max="16" aria-labelledby="svc-dur-' + i + ' svc-hl-' + i + '"><span id="svc-hl-' + i + '">hr</span><select name="service_minutes" aria-label="minutes"><option value="0">0</option><option value="15">15</option><option value="30">30</option><option value="45">45</option></select><span>min</span></div></div>'
      + '<button type="button" class="row-remove" aria-label="Remove this service">×</button>';
    var t = current().trade, ex = t && t.services[0] ? t.services[0].name : 'Standard appointment';
    $('input[name="service_name"]', el).value = name || '';
    $('input[name="service_name"]', el).placeholder = 'e.g. ' + ex;
    $('input[name="service_hours"]', el).value = h;
    $('select[name="service_minutes"]', el).value = String(m - (m % 15));
    rows.appendChild(el);
    return el;
  }
  addBtn.addEventListener('click', function () { var el = addRow(); touched.services = true; $('input', el).focus(); check(); });
  rows.addEventListener('click', function (e) {
    var b = e.target.closest('.row-remove'); if (!b) return;
    var row = b.closest('.service-row'), next = row.nextElementSibling || row.previousElementSibling;
    row.remove(); touched.services = true;
    (next ? $('input', next) : addBtn).focus(); check();
  });

  // ---- messages ----
  function fieldEl(name) {
    var el = form.querySelector('[data-field="' + name + '"]');
    while (!el && name.indexOf('.') > 0) { name = name.slice(0, name.lastIndexOf('.')); el = form.querySelector('[data-field="' + name + '"]'); }
    return el;
  }
  function rootOf(name) { return name.split('.').slice(0, 2).join('.'); }
  function isShown(issue) { return attempted || touched[issue.field] || touched[rootOf(issue.field)] || touched[issue.field.split('.')[0]]; }
  function focusable(el) { return el && ($$('input:not([type=hidden]), select, textarea', el).filter(function (x) { return !x.closest('[hidden]'); })[0] || el); }
  function goTo(el) { if (!el) return; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); var f = focusable(el); if (f.focus) f.focus({ preventScroll: true }); }

  function render(issues) {
    $$('.field-msg', form).forEach(function (m) { m.remove(); });
    $$('.has-error, .has-warning', form).forEach(function (f) { f.classList.remove('has-error', 'has-warning'); });
    $$('[aria-invalid]', form).forEach(function (x) { x.removeAttribute('aria-invalid'); x.removeAttribute('aria-describedby'); });
    issues.forEach(function (it, k) {
      if (!isShown(it)) return;
      var el = fieldEl(it.field); if (!el || el.closest('[hidden]')) return;
      var p = document.createElement('p');
      p.className = 'field-msg is-' + it.level; p.id = 'msg-' + k; p.textContent = it.message;
      (el.parentNode.classList.contains('service-row') ? el.parentNode : el).appendChild(p); el.classList.add(it.level === 'error' ? 'has-error' : 'has-warning');
      var input = focusable(el);
      if (input && input.setAttribute) { if (it.level === 'error') input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', p.id); }
    });
  }
  function order(issues) {
    var all = $$('[data-field]', form);
    var pos = function (i) { var el = fieldEl(i.field); var n = all.indexOf(el); return n < 0 ? 999 : n; };
    return issues.slice().sort(function (a, b) { return pos(a) - pos(b); });
  }
  function showSummary(errors) {
    if (!errors.length) { summary.hidden = true; summary.innerHTML = ''; return; }
    summary.innerHTML = '<h2>A couple things to fix</h2><ul></ul>';
    var ul = $('ul', summary);
    errors.forEach(function (it) {
      var li = document.createElement('li'), a = document.createElement('a');
      a.href = '#'; a.textContent = it.message;
      a.addEventListener('click', function (e) { e.preventDefault(); goTo(fieldEl(it.field)); });
      li.appendChild(a); ul.appendChild(li);
    });
    summary.hidden = false;
  }
  function showConfirm(warnings) {
    confirmBox.innerHTML = '<h2>Looks off, are you sure?</h2><p class="hint">These might be right. It\'s your call.</p><ul></ul><div class="confirm-actions"><button type="button" class="button button-yellow" data-act="yes">Yes, that\'s right. Send it</button><button type="button" class="button button-ghost" data-act="fix">Let me fix it</button></div>';
    var ul = $('ul', confirmBox);
    warnings.forEach(function (w) { var li = document.createElement('li'); li.textContent = w.message; ul.appendChild(li); });
    confirmBox.hidden = false;
    $('[data-act="yes"]', confirmBox).addEventListener('click', function () { send(true); });
    $('[data-act="fix"]', confirmBox).addEventListener('click', function () { confirmBox.hidden = true; goTo(fieldEl(warnings[0].field)); });
    confirmBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('[data-act="yes"]', confirmBox).focus({ preventScroll: true });
  }

  var last = { errors: [], warnings: [] };
  function check() {
    sync();
    var res = R.validate(collect());
    last = { errors: order(res.errors), warnings: order(res.warnings) };
    render(order(res.issues));
    if (attempted) showSummary(last.errors);
    if (!confirmBox.hidden && (last.errors.length || !last.warnings.length)) confirmBox.hidden = true;
    return last;
  }

  function setStatus(msg, state) { status.textContent = msg || ''; if (state) status.dataset.state = state; else delete status.dataset.state; }
  function send(confirmed) {
    if (busy) return;
    busy = true; submitBtn.disabled = true; setStatus('Sending…');
    var body = collect(); if (confirmed) body.confirm = 1;
    fetch('/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (x) {
        if (x.status === 200 && x.j.ok) {
          form.hidden = true; summary.hidden = true;
          var t = $('#setup-thanks'); t.hidden = false; t.focus(); window.scrollTo(0, 0); return;
        }
        if (x.status === 422) { attempted = true; render(order(x.j.issues || x.j.errors || [])); showSummary(order(x.j.errors || [])); summary.focus(); goTo(fieldEl((order(x.j.errors || [])[0] || {}).field || 'businessName')); setStatus(''); return; }
        if (x.status === 409) { showConfirm(order(x.j.warnings || [])); setStatus(''); return; }
        setStatus('Something went wrong sending your setup. Please try again, or call (470) 482-8377.', 'error');
      })
      .catch(function () { setStatus('We couldn\'t reach BuzzCall. Check your connection and try again.', 'error'); })
      .then(function () { busy = false; submitBtn.disabled = false; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    attempted = true;
    var r = check();
    if (r.errors.length) { confirmBox.hidden = true; summary.focus({ preventScroll: true }); goTo(fieldEl(r.errors[0].field)); setStatus(''); return; }
    if (r.warnings.length) { showConfirm(r.warnings); return; }
    send(false);
  });
  form.addEventListener('input', function (e) { var f = e.target.closest('[data-field]'); if (f) dirty[f.dataset.field] = true; check(); });
  form.addEventListener('change', function (e) {
    var f = e.target.closest('[data-field]'); if (f) { touched[f.dataset.field] = true; dirty[f.dataset.field] = true; }
    if (e.target.name === 'businessType' || e.target.name === 'flow') applyDefaults();
    check();
  });
  form.addEventListener('focusout', function (e) { var f = e.target.closest('[data-field]'); if (f && e.target.value) touched[f.dataset.field] = true; check(); });

  // Optional prefill from the link (?businessName=...&businessType=nails, or the old ?vertical=braiders), and ?check=1.
  var q = new URLSearchParams(location.search);
  var LEGACY = { braiders: 'braiders', plumber: 'plumbing', hvac: 'hvac' };
  q.forEach(function (value, key) {
    if (key === 'vertical' || key === 'businessType') {
      var k = R.trades.keyOf(LEGACY[value] || value), sel = $('#businessType');
      if (k && $('option[value="' + k + '"]', sel)) { sel.value = k; applyDefaults(); }
      return;
    }
    if (key === 'booking' || key === 'flow') { var r = $('input[name="' + key + '"][value="' + CSS.escape(value) + '"]', form); if (r) { r.checked = true; if (key === 'flow') applyDefaults(); } return; }
    if (key === 'days') { var ds = value.split(','); $$('input[name="days"]', form).forEach(function (x) { x.checked = ds.indexOf(x.value) >= 0; }); dirty.days = true; return; }
    if (key === 'deposit' || key === 'consent') { $('#' + key).checked = /^(1|true|on|yes)$/i.test(value); return; }
    var el = document.getElementById(key);
    if (el && el.form === form && key !== 'website' && el.type !== 'checkbox') { el.value = value; dirty[key] = true; }
  });
  sync();
  if (q.get('check') === '1') { attempted = true; var r0 = check(); if (r0.errors.length) showSummary(r0.errors); else if (r0.warnings.length) showConfirm(r0.warnings); }
  else check();
}());
