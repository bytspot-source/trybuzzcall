'use strict';
const onboarding = require('./onboarding');
const pages = require('./onboardingPages');
const vendors = require('./vendors');
const sec = require('./security');

const COOKIE = 'buzzcall_onboard';
const json = (req) => req.is('application/json') || /application\/json/i.test(req.get('accept') || '');
function cookieToken(req) {
  const parts = String(req.headers.cookie || '').split(';').map((p) => p.trim()).filter((p) => p.startsWith(COOKIE + '='));
  if (parts.length !== 1) return '';
  const value = decodeURIComponent(parts[0].slice(COOKIE.length + 1));
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}
function setGrantCookie(res, token) {
  const secure = sec.isProduction() ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/onboarding; HttpOnly; SameSite=Lax; Max-Age=${30 * 60}${secure}`);
}
function clearGrantCookie(res) {
  const secure = sec.isProduction() ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=; Path=/onboarding; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}
function reply(req, res, result, destination) {
  if (!result.ok) {
    const status = result.status || 400;
    return json(req) ? res.status(status).json({ ok: false, error: result.error }) : res.status(status).type('html').send(pages.passwordPage().replace('<h1>Choose a password</h1>', `<h1>Choose a password</h1><p class="notice notice-error">${require('./ui').esc(result.error)}</p>`));
  }
  return json(req) ? res.json({ ok: true }) : res.redirect(303, destination);
}

function register(app, { requireAdmin, sameOrigin }) {
  const vendor = () => app.locals.requireVendor;
  app.post('/onboarding/verify', async (req, res) => {
    const result = await onboarding.verify({ setupId: String(req.body?.setupId || ''), code: req.body?.code, ip: sec.clientIp(req) });
    if (!result.ok) return json(req) ? res.status(result.status || 400).json({ ok: false, error: result.error }) : res.status(result.status || 400).type('text').send(result.error);
    setGrantCookie(res, result.grant);
    return json(req) ? res.json({ ok: true, next: '/onboarding/password' }) : res.redirect(303, '/onboarding/password');
  });
  app.post('/onboarding/resend', async (req, res) => {
    const setup = require('./store').root.findSetup(String(req.body?.setupId || ''));
    if (!setup) return res.status(404).json({ ok: false, error: 'Setup not found' });
    const result = await onboarding.sendCode({ setupId: setup.id, phone: setup.values?.ownerPhone, ip: sec.clientIp(req), businessName: setup.values?.businessName });
    if (!result.ok) return json(req) ? res.status(result.status || 400).json(result) : res.status(result.status || 400).type('text').send(result.error);
    return json(req) ? res.json({ ok: true }) : res.redirect(303, '/setup');
  });
  app.get('/onboarding/password', (req, res) => {
    if (!onboarding.grantFor(cookieToken(req))) return res.redirect(303, '/setup');
    res.type('html').send(pages.passwordPage());
  });
  app.post('/onboarding/password', sameOrigin, async (req, res) => {
    const result = await onboarding.setPassword(cookieToken(req), req.body?.password, req.body?.passwordConfirm);
    if (!result.ok) return reply(req, res, result);
    vendors.setCookie(res, result.session);
    clearGrantCookie(res);
    return json(req) ? res.json({ ok: true, next: '/vendor' }) : res.redirect(303, '/vendor');
  });

  const guard = (req, res, next) => vendor()(req, res, next);
  app.post('/vendor/onboarding/registration', guard, async (req, res) => {
    const result = await onboarding.saveRegistration(req.vendor.id, req.body, process.env.PUBLIC_BASE_URL || '');
    if (!result.ok) return json(req) ? res.status(result.status || 400).json(result) : res.status(result.status || 400).type('text').send(result.error);
    return json(req) ? res.json(result) : res.redirect(303, '/vendor');
  });
  app.post('/vendor/onboarding/otp', guard, async (req, res) => {
    try {
      const result = await require('./a2p').resendOtp(req.vendor.id);
      if (!result.ok) return res.status(409).type('text').send(result.error);
    } catch (e) { return res.status(502).type('text').send('Could not resend the verification text.'); }
    return res.redirect(303, '/vendor');
  });

  app.get('/admin/onboarding', requireAdmin, (req, res) => {
    res.type('html').send(pages.queuePage(onboarding.queue()));
  });
  app.post('/admin/onboarding/:id/retry', requireAdmin, async (req, res) => {
    await onboarding.advance(req.params.id, process.env.PUBLIC_BASE_URL || '');
    res.redirect(303, '/admin/onboarding');
  });
  app.post('/admin/onboarding/:id/suspend', requireAdmin, async (req, res) => {
    await vendors.setStatus(req.params.id, 'suspended');
    res.redirect(303, '/admin/onboarding');
  });
  app.post('/admin/onboarding/:id/provision', requireAdmin, async (req, res) => {
    if (!/^(1|true|yes|on)$/i.test(String(req.body?.confirm_phones || ''))) return res.status(409).type('text').send('Confirm the manual assignment.');
    try { await require('./provision').assignManual(req.params.id, String(req.body?.phoneNumber || '')); }
    catch (e) { return res.status(e.status || 400).type('text').send(e.message || 'Could not assign that number.'); }
    res.redirect(303, '/admin/onboarding');
  });
  app.post('/admin/onboarding/:id/allow-phone', requireAdmin, async (req, res) => {
    if (!/^(1|true|yes|on)$/i.test(String(req.body?.confirm || ''))) return res.status(409).type('text').send('Confirm the extra shop.');
    const rec = require('./onboardingStore').shopRecord(req.params.id);
    const result = onboarding.allowPhone(rec?.phone || req.body?.phone);
    if (!result.ok) return res.status(result.status || 400).type('text').send(result.error);
    res.redirect(303, '/admin/onboarding');
  });
  app.post('/admin/onboarding/:id/entity', requireAdmin, async (req, res) => {
    if (!/^(1|true|yes|on)$/i.test(String(req.body?.confirm || ''))) return res.status(409).type('text').send('Confirm the business type.');
    const result = await onboarding.setEntity(req.params.id, req.body, process.env.PUBLIC_BASE_URL || '');
    if (!result.ok) return res.status(result.status || 400).type('text').send(result.error);
    return json(req) ? res.json(result) : res.redirect(303, '/admin/onboarding');
  });
  app.post('/admin/onboarding/:id/registration', requireAdmin, async (req, res) => {
    const result = await onboarding.markRegistration(req.params.id, String(req.body?.status || ''), req.body?.reason);
    if (!result.ok) return res.status(result.status || 400).type('text').send(result.error);
    res.redirect(303, '/admin/onboarding');
  });
}
module.exports = { register, COOKIE };
