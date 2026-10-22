// Trades catalog: every kind of local business BuzzCall can run for, shared by the server (agent/booking/setup rules)
// and the browser (/trades.js on the setup form). Two text flows:
//   'appointments': name -> pick a service from the menu (+ notes) -> preferred day -> start times or callback -> deposit
//   'jobs':         name -> describe the need -> next open windows or callback -> deposit
// Wording fields are plain text dropped into agent.js templates. Braiders, plumbing and HVAC keep their original texts.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BuzzTrades = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var GROUPS = [
    ['beauty', 'Beauty & personal care'],
    ['home', 'Home services'],
    ['other', 'Other services'],
  ];
  var BASE_URGENT = 'emergency|asap|urgent';
  // services: [name, minutes]; hours 'HH:MM-HH:MM'; days 0=Sun..6=Sat.
  var TRADES = {
    // ---- Beauty & personal care (appointments) ----
    braiders: { label: 'Hair braider / loc stylist', short: 'Braider', group: 'beauty', flow: 'appointments', voice: 'I', noun: 'client', pro: 'stylist', promptLabel: 'hair braiding stylist',
      busy: "I'm probably in the middle of a client's hair", serviceWord: 'style', ask: 'Which style are you looking for?',
      notes: 'If you know the size and length you want (like "medium, mid-back"), add that too.',
      services: [['Knotless braids', 360], ['Box braids', 300], ['Locs retwist', 120], ['Twists', 180]], days: [1, 2, 3, 4, 5, 6], hours: '09:00-19:00', deposit: 50 },
    nails: { label: 'Nail tech / nail salon', short: 'Nail tech', group: 'beauty', flow: 'appointments', voice: 'I', noun: 'client', pro: 'nail tech', promptLabel: 'nail tech',
      busy: "I'm probably with a client", serviceWord: 'service', ask: 'Which service are you looking for?',
      notes: 'Add the shape, length or design you have in mind too (like "almond, medium, french tip").',
      services: [['Gel manicure', 60], ['Acrylic full set', 90], ['Acrylic fill', 60], ['Spa pedicure', 60]], days: [2, 3, 4, 5, 6], hours: '10:00-19:00', deposit: 20, step: 30 },
    lashes_brows: { label: 'Lash & brow artist', short: 'Lash & brow artist', group: 'beauty', flow: 'appointments', voice: 'I', noun: 'client', pro: 'lash artist', promptLabel: 'lash and brow artist',
      busy: "I'm probably mid-set with a client", serviceWord: 'service', ask: 'Which service are you looking for?',
      notes: 'Add the look you want too (like "wispy hybrid" or "natural brows").',
      services: [['Classic lash full set', 120], ['Lash fill', 60], ['Brow lamination', 60], ['Brow wax & tint', 30]], days: [2, 3, 4, 5, 6], hours: '10:00-19:00', deposit: 25, step: 30 },
    barber: { label: 'Barber', short: 'Barber', group: 'beauty', flow: 'appointments', voice: 'I', noun: 'client', pro: 'barber', promptLabel: 'barber',
      busy: "I've probably got someone in the chair", serviceWord: 'service', ask: 'What are you coming in for?',
      notes: 'Add any details too (like "low taper, beard lineup").',
      services: [['Haircut', 45], ['Haircut & beard', 60], ['Beard trim', 30], ['Kids cut', 30]], days: [2, 3, 4, 5, 6], hours: '09:00-19:00', deposit: 10, step: 30 },
    hair_salon: { label: 'Hair stylist / salon', short: 'Hair stylist', group: 'beauty', flow: 'appointments', voice: 'I', noun: 'client', pro: 'stylist', promptLabel: 'hair stylist',
      busy: "I'm probably with a client", serviceWord: 'service', ask: 'Which service are you looking for?',
      notes: 'Add your hair length or the look you want too (like "shoulder length, honey blonde").',
      services: [['Silk press', 120], ['Cut & style', 60], ['Color', 150], ['Sew-in', 180]], days: [2, 3, 4, 5, 6], hours: '09:00-19:00', deposit: 40 },
    makeup: { label: 'Makeup artist', short: 'Makeup artist', group: 'beauty', flow: 'appointments', voice: 'I', noun: 'client', pro: 'makeup artist', promptLabel: 'makeup artist',
      busy: "I'm probably in the middle of a client's makeup", serviceWord: 'look', ask: 'Which look are you booking?',
      notes: 'Add the occasion and where you need me too (like "wedding, my studio").',
      services: [['Soft glam', 60], ['Full glam', 90], ['Bridal makeup', 120]], days: [2, 3, 4, 5, 6, 0], hours: '08:00-18:00', deposit: 50 },
    esthetician: { label: 'Esthetician / skin care', short: 'Esthetician', group: 'beauty', flow: 'appointments', voice: 'I', noun: 'client', pro: 'esthetician', promptLabel: 'esthetician',
      busy: "I'm probably with a client", serviceWord: 'service', ask: 'Which service are you looking for?',
      notes: 'Add anything I should know too (like "first facial, sensitive skin").',
      services: [['Signature facial', 60], ['Dermaplaning', 45], ['Brow wax', 30], ['Body wax', 45]], days: [2, 3, 4, 5, 6], hours: '10:00-18:00', deposit: 25, step: 30 },
    massage: { label: 'Massage therapist', short: 'Massage therapist', group: 'beauty', flow: 'appointments', voice: 'I', noun: 'client', pro: 'massage therapist', promptLabel: 'massage therapist',
      busy: "I'm probably in a session with a client", serviceWord: 'session', ask: 'Which session would you like?',
      notes: 'Add any focus areas too (like "deep tissue, lower back").',
      services: [['60-min massage', 60], ['90-min massage', 90], ['Deep tissue (60 min)', 60]], days: [1, 2, 3, 4, 5, 6], hours: '10:00-19:00', deposit: 25 },

    // ---- Home services (jobs) ----
    plumbing: { label: 'Plumbing', short: 'Plumbing', group: 'home', flow: 'jobs', voice: 'we', noun: 'customer', promptLabel: 'plumber',
      busy: "We're likely on a job", need: "What's going on - leak, clog, water heater, something else? Any active flooding?",
      windowQ: 'When\'s a good time for a callback today (e.g. "now", "after 3pm")?', doneWho: 'we', doneTail: 'If water is actively leaking, shut off your main valve.',
      onTheWay: 'when the tech is on the way', urgent: 'flood|burst|gas|no heat|smoke|sewage|' + BASE_URGENT,
      days: [1, 2, 3, 4, 5], hours: '08:00-17:00', deposit: 49, slotMinutes: 120 },
    hvac: { label: 'HVAC (heating & cooling)', short: 'HVAC', group: 'home', flow: 'jobs', voice: 'we', noun: 'customer', promptLabel: 'hvac',
      busy: '', need: "What's happening - no cooling, no heat, noise, maintenance? Anyone vulnerable in the home?",
      doneWho: 'a tech', doneTail: 'Stay safe!', onTheWay: 'when the tech is on the way', urgent: 'flood|burst|gas|no heat|smoke|sewage|' + BASE_URGENT,
      days: [1, 2, 3, 4, 5], hours: '08:00-17:00', deposit: 49, slotMinutes: 120 },
    electrical: { label: 'Electrician', short: 'Electrician', group: 'home', flow: 'jobs', voice: 'we', noun: 'customer', promptLabel: 'electrician',
      busy: "We're likely on a job", need: "What do you need - outlet or switch, lighting, panel, EV charger, something else? Anything sparking or without power?",
      doneWho: 'we', doneTail: 'If anything is sparking, smoking or smells like burning, stay clear of it.', onTheWay: 'when the electrician is on the way',
      urgent: 'spark|smok|burning|no power|outage|shock|' + BASE_URGENT, days: [1, 2, 3, 4, 5], hours: '08:00-17:00', deposit: 49, slotMinutes: 120 },
    handyman: { label: 'Handyman', short: 'Handyman', group: 'home', flow: 'jobs', voice: 'we', noun: 'customer', promptLabel: 'handyman',
      busy: "We're likely on a job", need: 'What can we help with - repairs, mounting, assembly, drywall, something else? A quick description helps us plan.',
      doneWho: 'we', doneTail: '', onTheWay: 'when your handyman is on the way', urgent: "leak|flood|locked out|won'?t (lock|close)|broken (door|window|lock)|" + BASE_URGENT,
      days: [1, 2, 3, 4, 5, 6], hours: '08:00-18:00', deposit: 40, slotMinutes: 120 },
    cleaning: { label: 'House cleaning', short: 'Cleaning', group: 'home', flow: 'jobs', voice: 'we', noun: 'customer', promptLabel: 'house cleaning',
      busy: "We're probably mid-clean at a client's home", need: 'What kind of clean do you need - regular, deep clean, move-in/out? About how many bedrooms and baths?',
      doneWho: 'we', doneTail: '', onTheWay: 'when the cleaning crew is on the way', urgent: 'move.?out (today|tomorrow)|' + BASE_URGENT,
      days: [1, 2, 3, 4, 5, 6], hours: '08:00-17:00', deposit: 40, slotMinutes: 180 },
    landscaping: { label: 'Landscaping & lawn care', short: 'Landscaping', group: 'home', flow: 'jobs', voice: 'we', noun: 'customer', promptLabel: 'landscaping',
      busy: "We're probably out on a job", need: 'What do you need - mowing, cleanup, planting, tree work, something else? Roughly how big is the yard?',
      doneWho: 'we', doneTail: '', onTheWay: 'when the crew is on the way', urgent: 'tree (down|fell|fallen)|fallen tree|flood|' + BASE_URGENT,
      days: [1, 2, 3, 4, 5, 6], hours: '07:00-17:00', deposit: 40, slotMinutes: 120 },

    // ---- Other services ----
    pet_grooming: { label: 'Pet groomer', short: 'Pet groomer', group: 'other', flow: 'appointments', voice: 'I', noun: 'pet', pro: 'groomer', promptLabel: 'pet groomer',
      busy: "I'm probably mid-groom with a furry client", serviceWord: 'service', ask: 'What does your pet need?',
      notes: 'Add your pet\'s name, breed and size too (like "Max, doodle, 40 lbs").', dayWho: 'you and your pet',
      services: [['Full groom', 120], ['Bath & brush', 60], ['Nail trim', 30]], days: [2, 3, 4, 5, 6], hours: '08:00-17:00', deposit: 20, step: 30 },
    mobile_detailing: { label: 'Mobile detailing', short: 'Mobile detailer', group: 'other', flow: 'jobs', voice: 'we', noun: 'customer', promptLabel: 'mobile auto detailing',
      busy: "We're probably mid-detail on a car", need: 'What are you looking for - interior, exterior or a full detail? What kind of vehicle, and where is it parked (area or zip)?',
      doneWho: 'we', doneTail: '', onTheWay: 'when the detailer is on the way', urgent: BASE_URGENT,
      days: [1, 2, 3, 4, 5, 6], hours: '08:00-18:00', deposit: 30, slotMinutes: 180 },
    tutoring: { label: 'Tutor / lessons', short: 'Tutor', group: 'other', flow: 'appointments', voice: 'I', noun: 'student', pro: 'tutor', promptLabel: 'tutor',
      busy: "I'm probably in a session with a student", serviceWord: 'session', ask: 'What kind of session are you looking for?',
      notes: 'Add the subject and grade level too (like "algebra, 9th grade").',
      services: [['1-hour session', 60], ['90-min session', 90], ['Test prep (2 hrs)', 120]], days: [1, 2, 3, 4, 5], hours: '15:00-20:00', deposit: 25, step: 30 },
    photography: { label: 'Photographer', short: 'Photographer', group: 'other', flow: 'appointments', voice: 'I', noun: 'client', pro: 'photographer', promptLabel: 'photographer',
      busy: "I'm probably on a shoot", serviceWord: 'session', ask: 'Which session are you interested in?',
      notes: 'Add the occasion and location idea too (like "family photos, at a park").',
      services: [['Mini session', 30], ['Portrait session', 60], ['Event coverage', 240]], days: [1, 2, 3, 4, 5, 6], hours: '09:00-18:00', deposit: 75 },
    catering_bakery: { label: 'Caterer / home baker', short: 'Caterer / baker', group: 'other', flow: 'jobs', voice: 'we', noun: 'customer', promptLabel: 'catering and home bakery',
      busy: "We're probably in the kitchen", need: 'What are you looking for - a custom cake, treats, catering for an event? What date, and about how many people?',
      doneWho: 'we', doneTail: '', onTheWay: 'to confirm your order details', urgent: 'last.?minute|' + BASE_URGENT,
      days: [1, 2, 3, 4, 5, 6], hours: '09:00-17:00', deposit: 50, slotMinutes: 30 },
    other: { label: 'Other', short: 'Other', group: 'other', flow: '', voice: 'I', noun: 'client', pro: 'pro', promptLabel: '',
      busy: '', serviceWord: 'service', ask: 'Which service are you looking for?', notes: 'Add any details that help too.',
      need: 'What do you need help with? A few details help us call you back ready.', doneWho: 'we', doneTail: '', onTheWay: 'when we are on the way', urgent: BASE_URGENT,
      services: [['Standard appointment', 60]], days: [1, 2, 3, 4, 5], hours: '09:00-17:00', deposit: 25, slotMinutes: 120 },
  };
  // Legacy / loose names -> trade key.
  var ALIASES = { braider: 'braiders', braids: 'braiders', braid: 'braiders', locs: 'braiders', plumber: 'plumbing', plumbers: 'plumbing', home_services: 'plumbing',
    electrician: 'electrical', electric: 'electrical', nail: 'nails', nail_tech: 'nails', lashes: 'lashes_brows', lash: 'lashes_brows', brows: 'lashes_brows',
    barbers: 'barber', barbershop: 'barber', salon: 'hair_salon', hair: 'hair_salon', mua: 'makeup', skin: 'esthetician', skincare: 'esthetician',
    groomer: 'pet_grooming', pet: 'pet_grooming', dog_grooming: 'pet_grooming', tutor: 'tutoring', lessons: 'tutoring', photographer: 'photography',
    catering: 'catering_bakery', bakery: 'catering_bakery', baker: 'catering_bakery', cleaner: 'cleaning', cleaners: 'cleaning', maid: 'cleaning',
    lawn: 'landscaping', landscaper: 'landscaping', detailing: 'mobile_detailing', detailer: 'mobile_detailing', other_appointments: 'other', other_jobs: 'other' };
  var KEYS = Object.keys(TRADES);

  function keyOf(v) {
    var k = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s&/-]+/g, '_').replace(/[^a-z_]/g, '');
    if (TRADES[k]) return k;
    if (ALIASES[k]) return ALIASES[k];
    return '';
  }
  function flowOf(v) { v = String(v == null ? '' : v).trim().toLowerCase(); return /^(job|jobs|describe)/.test(v) ? 'jobs' : /^(appointments?|services?|pick)/.test(v) ? 'appointments' : ''; }
  function copy(o) { var r = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = Array.isArray(o[k]) ? o[k].slice() : o[k]; return r; }

  // Full trade object for a key. 'other' takes its flow and label from opts ({ flow, label }); other_jobs/other_appointments
  // pick the flow by name. Unknown keys -> null.
  function get(key, opts) {
    opts = opts || {};
    var raw = String(key == null ? '' : key).trim().toLowerCase(), k = keyOf(raw);
    if (!k) return null;
    var t = copy(TRADES[k]); t.key = k;
    if (k === 'other') {
      t.flow = flowOf(opts.flow) || (raw === 'other_jobs' ? 'jobs' : 'appointments');
      var label = String(opts.label || '').trim().slice(0, 60);
      t.custom = label;
      t.label = label || 'local business';
      t.short = label || 'Other';
      t.promptLabel = label || (t.flow === 'jobs' ? 'local service' : 'local appointment-based');
      if (t.flow === 'jobs') { t.voice = 'we'; t.noun = 'customer'; t.busy = "We're likely with a customer"; }
      else t.busy = "I'm probably with a client";
    }
    t.services = (t.services || []).map(function (s) { return { name: s[0], minutes: s[1] }; });
    if (t.flow === 'appointments') { t.slotMinutes = t.slotMinutes || 120; } else { t.services = []; }
    t.urgentRe = t.flow === 'jobs' ? new RegExp(t.urgent || BASE_URGENT, 'i') : null;
    return t;
  }
  function list() { return KEYS.map(function (k) { return get(k); }); }
  function grouped() { return GROUPS.map(function (g) { return { key: g[0], label: g[1], trades: KEYS.filter(function (k) { return TRADES[k].group === g[0]; }).map(function (k) { return get(k); }) }; }); }
  function servicesString(t) { return (t.services || []).map(function (s) { return s.name + ':' + s.minutes; }).join(','); }

  return { GROUPS: GROUPS, KEYS: KEYS, get: get, keyOf: keyOf, flowOf: flowOf, list: list, grouped: grouped, servicesString: servicesString };
}));
