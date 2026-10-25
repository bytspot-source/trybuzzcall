// Separate platform controls and owner routes. No shop ID from a vendor request selects its data store.
const vendors = require('./vendors');
const store = require('./store');
const config = require('./config');
const context = require('./shopContext');
const billing = require('./billing');
const booking = require('./booking');
const connect = require('./connect');
const pages = require('./workspacePages');
const adminPages = require('./adminPages');
const paymentPages = require('./paymentPages');
const setupRules = require('./setupRules');
const sec = require('./security');
const trades = require('./trades');
const root = vendors.root;
const json = req => req.is('application/json') || /application\/json/i.test(req.get('accept') || '');
const bool = value => /^(1|true|yes|on)$/i.test(String(value || ''));
const plan = value => ['monthly','annual'].includes(value) ? value : null;
const editable = ['BUSINESS_NAME','BUSINESS_TYPE','BUSINESS_TRADE_LABEL','BUSINESS_FLOW','BUSINESS_CITY','BUSINESS_TZ','BUSINESS_DAYS','BUSINESS_HOURS','SERVICES','BOOKING_ENABLED',
  'DEPOSIT_ENABLED','DEPOSIT_AMOUNT','SLOT_MINUTES','HOLD_MINUTES','BOOKING_LEAD_MINUTES','BOOKING_LINK'];
const SERVICE_RE = /^.{1,100}:\d+$/;
const validServices = value => !value.split(',').some(s => !SERVICE_RE.test(s.trim()) || +s.split(':').at(-1) < 15 || +s.split(':').at(-1) > 720);
// Business type from the shared trade catalog (src/trades.js). It selects the caller conversation (braider vs plumber...).
// Returns the config values that pin the trade, so a vendor never falls back to the default plumbing texts.
function tradeValues({ businessType, tradeName = '', flow = '' } = {}) {
  const key = trades.keyOf(typeof businessType === 'string' ? businessType : '');
  if (!key) throw vendors.error('Choose a business type from the list.');
  const label = typeof tradeName === 'string' ? tradeName.trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 60) : '';
  if (key === 'other' && !label) throw vendors.error('For "Other", enter the kind of business, such as "dog walker".');
  const chosenFlow = key === 'other' ? (trades.flowOf(flow) || 'appointments') : '';
  const t = trades.get(key, { flow: chosenFlow, label });
  return { BUSINESS_TYPE: key, BUSINESS_FLOW: t.flow, BUSINESS_TRADE_LABEL: key === 'other' ? label : '',
    VERTICAL: key === 'braiders' ? 'braiders' : t.flow === 'appointments' ? 'appointments' : 'home_services' };
}
function createValues(body) {
  const values = tradeValues({ businessType: body.businessType, tradeName: body.tradeName, flow: body.flow });
  const services = typeof body.services === 'string' ? body.services.trim().replace(/\s*\n\s*/g, ',').replace(/,+/g, ',').replace(/^,|,$/g, '') : '';
  if (values.BUSINESS_FLOW === 'appointments') {
    const t = trades.get(values.BUSINESS_TYPE, { flow: values.BUSINESS_FLOW, label: values.BUSINESS_TRADE_LABEL });
    const chosen = services || trades.servicesString(t);
    if (chosen.length > 2000 || !validServices(chosen)) throw vendors.error('Services must use name:minutes, with durations from 15 to 720 minutes (for example "Knotless braids:360").');
    values.SERVICES = chosen;
  }
  return values;
}
function settingsValues() {
  const c = booking.cfg(), hm = n => `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`;
  return { BUSINESS_NAME: context.current().shop.name, BUSINESS_TYPE: c.trade, BUSINESS_TRADE_LABEL: '', BUSINESS_TZ: 'America/New_York', BUSINESS_DAYS: c.days.join(','),
    BUSINESS_HOURS: `${hm(c.open)}-${hm(c.close)}`, SLOT_MINUTES: c.slotMin, HOLD_MINUTES: c.holdMin,
    BOOKING_LEAD_MINUTES: c.leadMin, DEPOSIT_AMOUNT: c.amount, SERVICES: c.services.map(s => `${s.name}:${s.minutes}`).join(','),
    ...store.getOverride().values };
}
function validateSettings(body) {
  const values = { ...store.getOverride().values };
  for (const key of Object.keys(body)) if (!editable.includes(key)) throw vendors.error('This setting cannot be changed from the vendor dashboard.');
  for (const key of editable) {
    if (body[key] === undefined) continue;
    if (!['string','number'].includes(typeof body[key])) throw vendors.error('Invalid setting value.');
    const value = String(body[key]).trim();
    if (value.length > (key === 'SERVICES' ? 2000 : 300)) throw vendors.error('A setting is too long.');
    values[key] = value;
  }
  if (!values.BUSINESS_NAME || values.BUSINESS_NAME.length > 80) throw vendors.error('Enter a business name of at most 80 characters.');
  if (values.BUSINESS_TZ) { try { new Intl.DateTimeFormat('en-US', { timeZone: values.BUSINESS_TZ }).format(); } catch { throw vendors.error('Enter a valid IANA time zone.'); } }
  if (values.BUSINESS_DAYS && !/^[0-6](,[0-6])*$/.test(values.BUSINESS_DAYS)) throw vendors.error('Open days must be numbers 0–6 separated by commas.');
  if (values.BUSINESS_HOURS) {
    const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(values.BUSINESS_HOURS);
    if (!match || +match[1] > 23 || +match[3] > 23 || +match[2] > 59 || +match[4] > 59 || +match[1]*60 + +match[2] >= +match[3]*60 + +match[4]) {
      throw vendors.error('Use opening and closing times such as 09:00-17:00; closing must be later.');
    }
  }
  for (const [key,min,max] of [['SLOT_MINUTES',15,720],['HOLD_MINUTES',1,1440],['BOOKING_LEAD_MINUTES',0,10080],['DEPOSIT_AMOUNT',0,10000]]) {
    if (values[key] === '' || values[key] === undefined) continue;
    const number = Number(values[key]);
    if (!Number.isFinite(number) || number < min || number > max || key !== 'DEPOSIT_AMOUNT' && !Number.isInteger(number)) throw vendors.error(`Invalid ${key.toLowerCase().replaceAll('_',' ')}.`);
  }
  if (values.SERVICES && !validServices(values.SERVICES)) throw vendors.error('Services must use name:minutes, with durations from 15 to 720 minutes.');
  if (values.BUSINESS_TYPE !== undefined && values.BUSINESS_TYPE !== '') Object.assign(values, tradeValues({ businessType: values.BUSINESS_TYPE, tradeName: values.BUSINESS_TRADE_LABEL, flow: values.BUSINESS_FLOW }));
  if (values.BOOKING_LINK) { try { const url = new URL(values.BOOKING_LINK); if (url.protocol !== 'https:' || url.username || url.password) throw Error(); } catch { throw vendors.error('Booking links must use HTTPS without embedded credentials.'); } }
  for (const key of ['BOOKING_ENABLED','DEPOSIT_ENABLED']) if (values[key] !== undefined && !['0','1'].includes(values[key])) throw vendors.error('Booking and deposit settings must be on or off.');
  if (values.DEPOSIT_ENABLED === '1' && (values.BOOKING_ENABLED !== '1' || !(Number(values.DEPOSIT_AMOUNT) > 0))) throw vendors.error('Enable booking and set a positive deposit amount first.');
  return values;
}
function register(app, { requireAdmin, BASE, sameOrigin }) {
  // Sign-in throttles. Failures are counted per account+IP (VENDOR_LOGIN_MAX_FAILS, default 10 / 15 min), per account
  // across all IPs (VENDOR_ACCOUNT_MAX_FAILS, default 100 / 15 min: slows distributed guessing of one account without
  // letting a few IPs lock its owner out) and per IP (VENDOR_IP_MAX_FAILS, default 30 / 10 min). The global limit
  // (VENDOR_GLOBAL_MAX_ATTEMPTS, default 5000 / 10 min) is only a backstop, so a few IPs cannot lock every vendor out.
  const limit = (name, def) => Math.max(1, sec.num(process.env[name], def));
  const pairFails = sec.limiter({ windowMs: 900000, max: limit('VENDOR_LOGIN_MAX_FAILS', 10) });
  const accountFails = sec.limiter({ windowMs: 900000, max: limit('VENDOR_ACCOUNT_MAX_FAILS', 100) });
  const ipFails = sec.limiter({ windowMs: 600000, max: limit('VENDOR_IP_MAX_FAILS', 30) });
  const globalAttempts = sec.limiter({ windowMs: 600000, max: limit('VENDOR_GLOBAL_MAX_ATTEMPTS', 5000) });
  let deriving = 0;
  app.locals.resetVendorLimits = () => { pairFails.reset(); accountFails.reset(); ipFails.reset(); globalAttempts.reset(); };
  const safe = fn => async (req,res,next) => {
    try { await fn(req,res,next); }
    catch (e) {
      const status = e.status >= 400 && e.status <= 599 ? e.status : 500;
      const message = status >= 500 ? 'The workspace is temporarily unavailable. Please try again later.' : e.message;
      if (res.headersSent) return next(e);
      return json(req) ? res.status(status).json({ error: message }) : res.status(status).type('html').send(pages.message({ title: 'Unable to complete this request', message, status }));
    }
  };
  const requireVendor = safe(async (req,res,next) => {
    const shop = vendors.authenticate(req);
    if (!shop) return json(req) ? res.status(401).json({ error: 'Vendor sign-in required.' }) : res.redirect(303, '/vendor/login');
    req.vendor = vendors.publicShop(shop);
    return vendors.run(shop.id, () => next());
  });
  const reply = (req,res,data,destination='/vendor#payments') => json(req) ? res.json(data) : res.redirect(303,destination);
  const show = (res,html) => res.type('html').send(html);
  // The account key is the submitted email (login) or a hash of the activation code (activation); never logged.
  const accountKey = req => {
    if (req.path === '/vendor/login') return 'e:' + String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
    return 't:' + require('crypto').createHash('sha256').update(String(req.body?.token || '')).digest('hex').slice(0, 32);
  };
  const tooMany = res => res.status(429).set('Retry-After', '600').send('Too many attempts. Try again later.');
  const authAttempt = fn => safe(async (req,res) => {
    const ip = sec.clientIp(req), account = accountKey(req), pair = `${account}|${ip}`;
    if (ipFails.blocked(ip) || pairFails.blocked(pair) || accountFails.blocked(account) || globalAttempts.blocked('all') || deriving >= 8) return tooMany(res);
    globalAttempts.hit('all'); deriving++;
    try { await fn(req,res); }
    catch (e) {
      if (e && (e.status === 400 || e.status === 401)) { ipFails.hit(ip); pairFails.hit(pair); accountFails.hit(account); }
      throw e;
    } finally { deriving--; }
    // A successful sign-in clears this browser's failures for the account.
    pairFails.reset(pair);
  });
  // Cookie-based actions require the browser's actual origin, including protocol, not only a matching hostname.
  app.use('/vendor', (req,res,next) => {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
    let expected;
    try { expected = process.env.PUBLIC_BASE_URL ? new URL(BASE).origin : `${req.protocol}://${req.get('host')}`; } catch { return res.status(503).send('Site origin is not configured'); }
    const supplied = req.get('origin') || req.get('referer');
    try { if (new URL(supplied).origin !== expected) throw Error(); } catch { return res.status(403).send('cross-origin request refused'); }
    return sameOrigin(req,res,next);
  });
  app.get('/vendor/login', (req,res) => show(res,pages.auth({kind:'login'})));
  app.get('/vendor/activate', (req,res) => show(res,pages.auth({kind:'activate'})));
  app.post('/vendor/activate', authAttempt(async (req,res) => {
    await vendors.activate(req.body.token,req.body.password,req.body.passwordConfirm);
    reply(req,res,{ok:true},'/vendor/login');
  }));
  app.post('/vendor/login', authAttempt(async (req,res) => {
    const result = await vendors.login(req.body.email,req.body.password);
    vendors.setCookie(res,result.token); reply(req,res,{ok:true},'/vendor');
  }));
  app.post('/vendor/logout', safe(async (req,res) => { await vendors.logout(req); vendors.setCookie(res); reply(req,res,{ok:true},'/vendor/login'); }));
  app.get('/vendor', requireVendor, safe(async (req,res) => {
    show(res, adminPages.renderVendor({ businessName: config.env.BUSINESS_NAME || req.vendor.name, ownerEmail: req.vendor.email,
      shop:req.vendor, leads:store.db.leads, calls:store.db.calls || [], bookings:store.db.bookings, alerts:store.db.alerts,
      billing:billing.summary(),connect:connect.summary(),cfg:booking.cfg(),fees:booking.leadFeeTotals(), demoAllowed:sec.demoAllowed(), optedOut:phone=>store.isOptedOut(phone) }));
  }));
  app.get('/vendor/settings', requireVendor, safe(async (req,res) => show(res,pages.settings({shop:req.vendor,values:settingsValues()}))));
  app.post('/vendor/settings', requireVendor, safe(async (req,res) => {
    const values = validateSettings(req.body);
    config.apply(values); await vendors.persist(context.current().store);
    vendors.get(req.vendor.id).name = values.BUSINESS_NAME; await vendors.persist();
    reply(req,res,{ok:true},'/vendor/settings');
  }));
  app.get('/vendor/billing/return', (req,res) => show(res,paymentPages.returnPage({kind:'subscription',outcome:req.query.status === 'success' ? 'success' : 'cancel',businessName:'Your business',mode:connect.mode()}).replaceAll('href="/billing/portal"','href="/vendor/billing/portal"').replaceAll('href="/admin#payments"','href="/vendor#payments"')));
  app.get('/vendor/billing/status', requireVendor, safe(async (req,res) => res.json(billing.summary())));
  app.post('/vendor/billing/checkout', requireVendor, safe(async (req,res) => {
    if (!plan(req.body.plan)) throw vendors.error('Select monthly or annual billing.');
    if (booking.cfg().trade === 'braiders') throw vendors.error('Braider pilot terms and pricing must be confirmed with BuzzCall before a subscription can start.',409);
    if (connect.mode() === 'mock' && !sec.demoAllowed()) throw vendors.error('Payments are not configured.',503);
    const result = await billing.createCheckout({plan:req.body.plan,email:req.vendor.email,BASE,setupWaived:false});
    if (json(req)) return res.json(result);
    res.redirect(303,result.url);
  }));
  app.post('/vendor/billing/preview',requireVendor,safe(async(req,res)=>{
    if (!plan(req.body.plan)) throw vendors.error('Select monthly or annual billing.');
    res.json(await billing.previewChange(req.body.plan,req.body.sub));
  }));
  app.post('/vendor/billing/change-plan',requireVendor,safe(async(req,res)=>{
    if (!plan(req.body.plan)) throw vendors.error('Select monthly or annual billing.');
    reply(req,res,await billing.changePlan(req.body.plan,req.body.proration_date,req.body.sub));
  }));
  for (const [action,cancel] of [['cancel',true],['resume',false]]) app.post(`/vendor/billing/${action}`,requireVendor,safe(async(req,res)=>reply(req,res,await billing.setCancel(cancel,req.body.sub))));
  app.get('/vendor/billing/portal',requireVendor,safe(async(req,res)=>res.redirect(303,await billing.portalUrl(BASE))));
  const mockOnly = (req,res,next) => connect.mode() === 'mock' && sec.demoAllowed() ? next() : res.status(404).send('Simulation unavailable');
  app.get('/vendor/billing/mock/checkout/:id',requireVendor,mockOnly,safe(async(req,res)=>{
    const session = billing.mockSessionInfo(req.params.id); if (!session) throw vendors.error('Checkout not found',404);
    const html = paymentPages.checkout({session,cfg:billing.cfg(),id:req.params.id,businessName:config.env.BUSINESS_NAME});
    show(res,html.replaceAll('/billing/mock/checkout/','/vendor/billing/mock/checkout/').replaceAll('href="/billing/portal"','href="/vendor/billing/portal"'));
  }));
  app.post('/vendor/billing/mock/checkout/:id/complete',requireVendor,mockOnly,safe(async(req,res)=>{
    const subscription = await billing.mockCompleteCheckout(req.params.id,BASE);
    reply(req,res,{ok:true,subscription},`/vendor/billing/mock/checkout/${encodeURIComponent(req.params.id)}`);
  }));
  app.get('/vendor/billing/mock/portal',requireVendor,mockOnly,safe(async(req,res)=>show(res,adminPages.billingPortal({billing:billing.summary(),businessName:config.env.BUSINESS_NAME,vendor:true,ownerEmail:req.vendor.email}))));
  app.post('/vendor/billing/mock/update-card',requireVendor,mockOnly,safe(async(req,res)=>reply(req,res,await billing.mockUpdateCard(BASE,req.body.sub))));
  const onboard = safe(async(req,res)=>{
    const result = await connect.onboard(BASE,{name:config.env.BUSINESS_NAME,email:req.vendor.email});
    await vendors.persist(context.current().store);
    return json(req) ? res.json({ok:true,...result}) : res.redirect(303,result.url);
  });
  app.post('/vendor/connect/onboard',requireVendor,(req,res,next)=>connect.mode() !== 'mock' || sec.demoAllowed() ? next() : res.status(503).send('Payments are not configured'),onboard);
  app.get('/vendor/connect/refresh',requireVendor,safe(async(req,res,next)=>{
    if (!connect.accountId() || connect.mode() === 'mock') return res.redirect(303,'/vendor#payments');
    return onboard(req,res,next);
  }));
  app.get('/vendor/connect/return',requireVendor,safe(async(req,res)=>{await connect.refresh();reply(req,res,connect.summary());}));
  app.post('/vendor/connect/sync',requireVendor,safe(async(req,res)=>{await connect.refresh();reply(req,res,connect.summary());}));
  app.get('/vendor/connect/status',requireVendor,safe(async(req,res)=>res.json(connect.summary())));
  app.get('/vendor/connect/mock',requireVendor,mockOnly,safe(async(req,res)=>show(res,paymentPages.connectOnboarding({connect:connect.summary(),businessName:config.env.BUSINESS_NAME}).replaceAll('/admin/connect/','/vendor/connect/').replaceAll('/admin#connect','/vendor#payments'))));
  app.post('/vendor/connect/mock/complete',requireVendor,mockOnly,safe(async(req,res)=>{
    const state = connect.mockComplete(); if (!state) throw vendors.error('Start onboarding first.',409);
    await vendors.persist(context.current().store);reply(req,res,connect.summary());
  }));
  async function summary(shop) {
    if (shop.status === 'provisioning') return {...vendors.publicShop(shop),subscriptionStatus:'Not provisioned',leadCount:0,bookingCount:0,payoutStatus:'Not connected'};
    return vendors.run(shop.id,()=>({...vendors.publicShop(shop),subscriptionStatus:billing.summary().subscription?.status || 'No subscription',
      leadCount:store.db.leads.length,bookingCount:store.db.bookings.length,payoutStatus:connect.summary().label}),{suspended:true});
  }
  app.get('/admin',requireAdmin,safe(async(req,res)=>{
    const shops = await Promise.all(vendors.all().map(summary));
    show(res,pages.platform({shops,setups:root.db.setups,storage:root.status(),legacyName:config.env.BUSINESS_NAME,
      legacyBilling:billing.summary(),mode:connect.mode()}));
  }));
  app.post('/admin/vendors',requireAdmin,safe(async(req,res)=>{
    const result = await vendors.create({name:req.body.name,email:req.body.email,values:createValues(req.body)});
    show(res,pages.invitation(result));
  }));
  app.post('/admin/vendors/approve',requireAdmin,safe(async(req,res)=>{
    if (!bool(req.body.confirm_setup)) throw vendors.error('Review and confirm the submitted business settings before approval.',409);
    const request = root.findSetup(req.body.setupId);
    if (!request || request.status !== 'pending') throw vendors.error('Pending setup not found.',404);
    const validated = setupRules.validate(request.values);
    if (validated.errors.length) throw vendors.error('The setup needs corrections before approval.',422);
    const result = await vendors.create({name:validated.values.businessName,email:validated.values.email,values:setupRules.toEnv(validated.values),setupId:request.id});
    request.status = 'approved'; request.vendorId = result.shop.id; request.approvedAt = new Date().toISOString();
    await vendors.persist();show(res,pages.invitation(result));
  }));
  app.get('/admin/vendors/:id',requireAdmin,safe(async(req,res)=>{
    const shop = vendors.get(req.params.id); if (!shop) throw vendors.error('Vendor not found',404);
    const stats = await summary(shop), child = await vendors.scopedStore(shop);
    const sms = require('./sms');
    show(res,pages.vendorDetail({shop:{...vendors.publicShop(shop),subscriptionStatus:stats.subscriptionStatus,payoutStatus:stats.payoutStatus},stats,settings:child.getOverride().values || {},
      smsCaps:shop.smsCaps || {},capDefaults:{hour:sms.shopMax('hour',null),day:sms.shopMax('day',null)}}));
  }));
  app.post('/admin/vendors/:id/invite',requireAdmin,safe(async(req,res)=>show(res,pages.invitation(await vendors.invite(req.params.id)))));
  app.post('/admin/vendors/:id/status',requireAdmin,safe(async(req,res)=>reply(req,res,await vendors.setStatus(req.params.id,req.body.status),`/admin/vendors/${encodeURIComponent(req.params.id)}`)));
  app.post('/admin/vendors/:id/phone',requireAdmin,safe(async(req,res)=>{
    if (!bool(req.body.confirm_phones)) throw vendors.error('Confirm the phone routing change before saving.',409);
    reply(req,res,await vendors.assignPhone(req.params.id,req.body.phoneNumber),`/admin/vendors/${encodeURIComponent(req.params.id)}`);
  }));
  app.post('/admin/vendors/:id/sms-caps',requireAdmin,safe(async(req,res)=>{
    if (!bool(req.body.confirm_caps)) throw vendors.error('Confirm the texting volume change before saving.',409);
    reply(req,res,await vendors.setSmsCaps(req.params.id,{hour:req.body.hour,day:req.body.day}),`/admin/vendors/${encodeURIComponent(req.params.id)}`);
  }));
  app.post('/admin/vendors/:id/contacts',requireAdmin,safe(async(req,res)=>{
    if (!bool(req.body.confirm_phones)) throw vendors.error('Confirm the phone routing change before saving.',409);
    const phoneKeys = ['OWNER_PHONE','FORWARD_TO_PHONE'];
    for (const key of phoneKeys) if (typeof req.body[key] !== 'string' || req.body[key] && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(req.body[key])) throw vendors.error('Use +1 phone numbers, or leave the forwarding number blank.');
    if (!req.body.OWNER_PHONE) throw vendors.error('An owner alert phone is required.');
    await vendors.run(req.params.id,async()=>{
      config.apply({...store.getOverride().values, ...Object.fromEntries(phoneKeys.map(key=>[key,req.body[key]]))});
      await vendors.persist(context.current().store);
    },{suspended:true});
    reply(req,res,{ok:true},`/admin/vendors/${encodeURIComponent(req.params.id)}`);
  }));
  app.locals.requireVendor = requireVendor;
}
module.exports = {register,validateSettings,settingsValues};
