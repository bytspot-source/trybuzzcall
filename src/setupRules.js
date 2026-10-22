// Shop-owner setup form: normalize + "balance checks". Shared by the browser (/setup-rules.js) and the server
// (POST /setup, admin apply). Every rule returns { field, level: 'error' | 'warning', message } in plain words.
// Errors block submit. Warnings need the owner to confirm ("Looks off, are you sure?").
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SetupRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var US_TIMEZONES = [
    ['America/New_York', 'Eastern (New York, Atlanta, Miami)'],
    ['America/Chicago', 'Central (Chicago, Dallas, Houston)'],
    ['America/Denver', 'Mountain (Denver, Salt Lake City)'],
    ['America/Phoenix', 'Arizona (no daylight saving)'],
    ['America/Los_Angeles', 'Pacific (Los Angeles, Seattle)'],
    ['America/Anchorage', 'Alaska'],
    ['Pacific/Honolulu', 'Hawaii'],
    ['America/Puerto_Rico', 'Puerto Rico'],
  ];
  var DEFAULT_SERVICES = [
    { name: 'Knotless braids', minutes: 360 }, { name: 'Box braids', minutes: 300 },
    { name: 'Locs retwist', minutes: 120 }, { name: 'Twists', minutes: 180 },
  ];
  var DEFAULTS = {
    braiders: { days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '19:00', depositAmount: 50 },
    home: { days: [1, 2, 3, 4, 5], open: '08:00', close: '17:00', depositAmount: 49 },
    ringSeconds: 20, slotMinutes: 120, leadMinutes: 60, holdMinutes: 30, tz: 'America/New_York',
  };
  var STATE_CODES = ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY').split(' ');
  var STATE_NAMES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'district of columbia', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'puerto rico', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming'];
  var MAX_SERVICES = 20;

  function first(v) { return Array.isArray(v) ? v[0] : v; }
  function str(v, max) { v = first(v); return v == null ? '' : String(v).trim().slice(0, max || 200); }
  function bool(v) { v = first(v); return v === true || /^(1|true|yes|on|times)$/i.test(String(v == null ? '' : v).trim()); }
  // '' -> null (not answered); garbage -> NaN (answered, not a number)
  function num(v) { v = first(v); if (v == null || String(v).trim() === '') return null; var n = Number(String(v).trim().replace(/^\$/, '')); return isFinite(n) ? n : NaN; }
  function list(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }

  // 10-digit US number (optional leading 1 / +1). Area code and exchange can't start with 0 or 1.
  function phoneE164(v) {
    var d = String(v == null ? '' : v).replace(/[\s().\-+]/g, '');
    if (!/^\d+$/.test(d)) return null;
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length !== 10 || !/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
    return '+1' + d;
  }
  function hasState(city) {
    var c = String(city || '').trim().replace(/\s+\d{5}(-\d{4})?$/, '').replace(/[.,\s]+$/, '');
    var m = c.match(/[\s,]([A-Za-z]{2})$/);
    if (m && STATE_CODES.indexOf(m[1].toUpperCase()) >= 0) return true;
    var low = c.toLowerCase();
    return STATE_NAMES.some(function (s) { return low.length > s.length && low.slice(-s.length) === s && /[\s,]/.test(low[low.length - s.length - 1]); });
  }
  function toMin(t) { var m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function fmtDur(min) {
    var h = Math.floor(min / 60), m = Math.round(min % 60);
    if (!h) return m + ' min';
    return h + ' hr' + (h === 1 ? '' : 's') + (m ? ' ' + m + ' min' : '');
  }
  function fmtMoney(n) { return '$' + (Number.isInteger(n) ? n : n.toFixed(2)); }
  function vertical(v) {
    v = str(v).toLowerCase();
    if (/^braid/.test(v)) return 'braiders';
    if (/^plumb/.test(v)) return 'plumber';
    if (v === 'hvac') return 'hvac';
    return '';
  }

  // Accepts JSON from the page ({ services: [{ name, hours, minutes }] }), form posts (service_name[] ...)
  // or an already-normalized object (idempotent).
  function normalize(raw) {
    raw = raw || {};
    var v = {
      businessName: str(raw.businessName, 80), city: str(raw.city, 80), vertical: vertical(raw.vertical),
      ownerPhone: str(raw.ownerPhone, 30), forwardPhone: str(raw.forwardPhone, 30), ringSeconds: num(raw.ringSeconds),
      days: [], open: str(raw.open, 5), close: str(raw.close, 5), tz: str(raw.tz, 40),
      services: [], booking: raw.booking === undefined ? true : bool(raw.booking),
      slotMinutes: num(raw.slotMinutes), leadMinutes: num(raw.leadMinutes),
      deposit: bool(raw.deposit), depositAmount: num(raw.depositAmount), holdMinutes: num(raw.holdMinutes),
      bookingLink: str(raw.bookingLink, 300), email: str(raw.email, 254).toLowerCase(), consent: bool(raw.consent),
      confirm: bool(raw.confirm),
    };
    if (v.ringSeconds === null) v.ringSeconds = DEFAULTS.ringSeconds;
    var days = typeof raw.days === 'string' ? raw.days.split(',') : list(raw.days);
    days.forEach(function (d) { var n = Number(String(d).trim()); if (String(d).trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 6 && v.days.indexOf(n) < 0) v.days.push(n); });
    v.days.sort();
    var rows = Array.isArray(raw.services) ? raw.services
      : list(raw.service_name).map(function (n, i) { return { name: n, hours: list(raw.service_hours)[i], minutes: list(raw.service_minutes)[i] }; });
    rows.slice(0, 50).forEach(function (r, i) {
      r = r || {};
      var name = str(r.name, 60), h = num(r.hours), m = num(r.minutes);
      if (!name && !h && !m) return; // blank row
      var total = (isNaN(h) ? NaN : (h || 0) * 60) + (isNaN(m) ? NaN : (m || 0));
      v.services.push({ name: name, minutes: isNaN(total) ? 0 : Math.round(total), row: r.row != null && isFinite(Number(r.row)) ? Number(r.row) : i });
    });
    if (v.ownerPhone && phoneE164(v.ownerPhone)) v.ownerPhone = phoneE164(v.ownerPhone);
    if (v.forwardPhone && phoneE164(v.forwardPhone)) v.forwardPhone = phoneE164(v.forwardPhone);
    return v;
  }

  function check(raw) {
    var v = normalize(raw), out = [];
    var err = function (field, message) { out.push({ field: field, level: 'error', message: message }); };
    var warn = function (field, message) { out.push({ field: field, level: 'warning', message: message }); };
    var braid = v.vertical === 'braiders';

    // Your business
    if (!v.businessName) err('businessName', 'Tell us your business name, the way callers know you.');
    if (!v.city) err('city', 'Add the city and state you work in, like "Atlanta, GA".');
    else if (!hasState(v.city)) warn('city', 'Add your state too, like "' + v.city.replace(/[,\s]+$/, '') + ', GA", so your texts sound local. Is "' + v.city + '" right as is?');
    if (!v.vertical) err('vertical', 'Pick what kind of business you run: Braider, Plumbing or HVAC.');

    // Phones
    var owner = phoneE164(v.ownerPhone), fwd = phoneE164(v.forwardPhone);
    if (!v.ownerPhone) err('ownerPhone', 'Add the cell phone where we should text your alerts.');
    else if (!owner) err('ownerPhone', 'Your alert cell doesn\'t look like a 10-digit US number. Try something like (404) 555-0100.');
    if (!v.forwardPhone) warn('forwardPhone', 'With no ring-first phone, your phone never rings: every call goes straight to a text back. Is that what you want?');
    else if (!fwd) err('forwardPhone', 'Your ring-first phone doesn\'t look like a 10-digit US number. Try something like (404) 555-0100.');
    if (owner && fwd && owner === fwd) warn('forwardPhone', 'Your alert cell and ring-first phone are the same number, so that one phone gets both the call and the buzz (the text alert). Is that ok?');
    if (v.forwardPhone) {
      if (isNaN(v.ringSeconds) || v.ringSeconds <= 0) err('ringSeconds', 'Ring time should be a number of seconds, like 20.');
      else if (v.ringSeconds < 10) warn('ringSeconds', 'Ringing for only ' + v.ringSeconds + ' seconds hangs up before most people can answer. Are you sure?');
      else if (v.ringSeconds > 40) warn('ringSeconds', 'Ringing for ' + v.ringSeconds + ' seconds is long. Many callers hang up or hit voicemail before we can text them back. Are you sure?');
    }

    // Hours
    if (!v.days.length) err('days', 'Pick at least one day you\'re open.');
    var o = toMin(v.open), c = toMin(v.close), win = null;
    if (o === null) err('open', 'Pick the time you open.');
    if (c === null) err('close', 'Pick the time you close.');
    if (o !== null && c !== null) {
      if (c <= o) err('close', 'Your closing time needs to be after your opening time.');
      else {
        win = c - o;
        if (win < 120) warn('close', 'You\'re open only ' + fmtDur(win) + ' a day. That leaves very few times to offer callers. Is that right?');
        else if (win > 960) warn('close', 'You\'re open ' + fmtDur(win) + ' a day. That\'s a long day. Is that right?');
      }
    }
    if (!v.tz) err('tz', 'Pick your time zone.');
    else if (!US_TIMEZONES.some(function (z) { return z[0] === v.tz; })) err('tz', 'Pick a US time zone from the list.');

    // Services (braiders)
    if (braid) {
      if (!v.services.length) err('services', 'Add at least one style you offer, with about how long it takes.');
      if (v.services.length > MAX_SERVICES) err('services', 'That\'s a lot of styles. Please keep it to ' + MAX_SERVICES + ' or fewer so the text menu stays short.');
      var seen = {};
      v.services.forEach(function (s) {
        var f = 'services.' + s.row, label = s.name || 'This style';
        if (!s.name) err(f + '.name', 'Give this style a name, like "Knotless braids".');
        else {
          var key = s.name.toLowerCase();
          if (seen[key]) warn(f + '.name', '"' + s.name + '" is on your list twice. Is that on purpose?');
          seen[key] = true;
        }
        if (!s.minutes || s.minutes <= 0) err(f + '.duration', 'How long does ' + label + ' take? Add the hours and minutes.');
        else if (s.minutes > 720) err(f + '.duration', label + ' is set to ' + fmtDur(s.minutes) + '. That\'s over 12 hours, please check the hours.');
        else if (win !== null && s.minutes > win) err(f + '.duration', label + ' takes ' + fmtDur(s.minutes) + ', but you\'re only open ' + fmtDur(win) + ' a day, so it can never be booked. Shorten it or open longer.');
        else if (s.minutes > 540) warn(f + '.duration', label + ' takes ' + fmtDur(s.minutes) + '. That\'s over 9 hours. Is that right?');
      });
    }

    // Booking
    if (v.booking && !braid && v.vertical) {
      if (v.slotMinutes === null || isNaN(v.slotMinutes) || v.slotMinutes <= 0) err('slotMinutes', 'Pick how long each appointment window is.');
      else if (win !== null && v.slotMinutes > win) err('slotMinutes', 'Each appointment window is ' + fmtDur(v.slotMinutes) + ', but you\'re only open ' + fmtDur(win) + ' a day, so no times can be offered.');
    }
    if (v.booking) {
      if (v.leadMinutes === null) v.leadMinutes = DEFAULTS.leadMinutes;
      if (isNaN(v.leadMinutes) || v.leadMinutes < 0) err('leadMinutes', 'Minimum notice should be a number of minutes, like 60.');
    }

    // Deposit
    if (v.deposit) {
      if (v.depositAmount === null || isNaN(v.depositAmount) || v.depositAmount <= 0) err('depositAmount', 'Add a deposit amount, like $50, or turn deposits off.');
      else if (v.depositAmount > 200) warn('depositAmount', 'A ' + fmtMoney(v.depositAmount) + ' deposit is high and may scare callers off. Are you sure?');
      else if (v.depositAmount < 10) warn('depositAmount', 'A ' + fmtMoney(v.depositAmount) + ' deposit is very small, and card fees take a bite out of it. Are you sure?');
      if (!v.booking) warn('deposit', 'Deposits only apply to booked times. With "callback only", no one will be asked for a deposit. Is that ok?');
      if (v.holdMinutes === null || isNaN(v.holdMinutes) || v.holdMinutes <= 0) err('holdMinutes', 'Add how many minutes to hold a time while the caller pays, like 30.');
      else if (v.holdMinutes < 5) warn('holdMinutes', 'Holding a time for only ' + v.holdMinutes + ' minutes gives callers very little time to pay. Are you sure?');
      else if (v.holdMinutes > 60) warn('holdMinutes', 'Holding a time for ' + v.holdMinutes + ' minutes keeps it blocked a long while if they never pay. Are you sure?');
    }

    // Booking link (braiders)
    if (braid && v.bookingLink) {
      var ok = false;
      try { var u = new URL(v.bookingLink); ok = u.protocol === 'https:' && /\.[a-z]{2,}$/i.test(u.hostname) && !/\s/.test(v.bookingLink); } catch (e) { ok = false; }
      if (!ok) err('bookingLink', 'Your booking link needs to be a full web address that starts with https://, like https://booksy.com/your-page.');
    }

    // Contact + consent
    if (!v.email) err('email', 'Add an email so we can reach you about your setup.');
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) err('email', 'That email doesn\'t look quite right. Check for typos.');
    if (!v.consent) err('consent', 'Please check the box to agree to the Terms and the SMS consent rules.');
    return out;
  }

  function validate(raw) {
    var values = normalize(raw), issues = check(values);
    if (values.booking && values.leadMinutes === null) values.leadMinutes = DEFAULTS.leadMinutes;
    return {
      values: values, issues: issues,
      errors: issues.filter(function (i) { return i.level === 'error'; }),
      warnings: issues.filter(function (i) { return i.level === 'warning'; }),
    };
  }

  // Submission values -> config override (same keys/formats as the env vars booking.js/agent.js/server.js read).
  function toEnv(raw) {
    var v = normalize(raw), braid = v.vertical === 'braiders', d = braid ? DEFAULTS.braiders : DEFAULTS.home;
    var e = {
      BUSINESS_NAME: v.businessName, BUSINESS_CITY: v.city,
      VERTICAL: braid ? 'braiders' : 'home_services', BUSINESS_VERTICAL: braid ? 'braiders' : (v.vertical || 'plumber'),
      OWNER_PHONE: phoneE164(v.ownerPhone) || '', FORWARD_TO_PHONE: phoneE164(v.forwardPhone) || '',
      RING_TIMEOUT_SECONDS: String(isNaN(v.ringSeconds) ? DEFAULTS.ringSeconds : v.ringSeconds),
      BUSINESS_TZ: v.tz || DEFAULTS.tz,
      BUSINESS_DAYS: (v.days.length ? v.days : d.days).join(','),
      BUSINESS_HOURS: (v.open || d.open) + '-' + (v.close || d.close),
      BOOKING_ENABLED: v.booking ? '1' : '0',
      BOOKING_LEAD_MINUTES: String(v.leadMinutes == null || isNaN(v.leadMinutes) ? DEFAULTS.leadMinutes : v.leadMinutes),
      DEPOSIT_ENABLED: v.deposit ? '1' : '0',
      DEPOSIT_AMOUNT: String(v.depositAmount == null || isNaN(v.depositAmount) ? d.depositAmount : v.depositAmount),
      HOLD_MINUTES: String(v.holdMinutes == null || isNaN(v.holdMinutes) ? DEFAULTS.holdMinutes : v.holdMinutes),
      BOOKING_LINK: braid ? v.bookingLink : '',
    };
    // SERVICES is "Name:minutes,..." so commas can't live inside a style name.
    if (braid) e.SERVICES = v.services.filter(function (s) { return s.name && s.minutes > 0; }).map(function (s) { return s.name.replace(/,/g, ' /') + ':' + s.minutes; }).join(',');
    else e.SLOT_MINUTES = String(v.slotMinutes == null || isNaN(v.slotMinutes) ? DEFAULTS.slotMinutes : v.slotMinutes);
    return e;
  }

  return { US_TIMEZONES: US_TIMEZONES, DEFAULT_SERVICES: DEFAULT_SERVICES, DEFAULTS: DEFAULTS, normalize: normalize, check: check, validate: validate, toEnv: toEnv, phoneE164: phoneE164, hasState: hasState, fmtDur: fmtDur };
}));
