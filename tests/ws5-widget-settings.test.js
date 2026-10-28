/**
 * The widget settings screen and the install check.
 *
 * Covers what the dashboard saves (suggested questions, consent, the
 * proactive message, the privacy link), what the public config endpoint then
 * hands to anybody's browser, where the widget was last seen (recorded only
 * for the tenant's own domains, at most once a minute), "Check my site"
 * against a real page, and the audit trail for keys, domains and settings.
 */

const http = require('http');
const dns = require('dns');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Company = require('../models/company');
const User = require('../models/user');
const AuditLog = require('../models/audit-log');
const Subscription = require('../models/subscription');
const tenantService = require('../services/tenant');
const usageService = require('../services/usage');
const safeHttp = require('../services/safe-http');
const widgetInstall = require('../services/widget-install');

describe('Widget settings and install check', () => {
  let app;
  let company;
  let token;
  let server;
  let siteOrigin;

  const PAGES = {
    '/installed': key => `<html><body><h1>Shop</h1>
      <script src="https://chat.example/widget/js/widget-loader.js" data-widget-key="${key}"
        data-server-url="https://chat.example" defer></script></body></html>`,
    '/old-key': () => `<html><body>
      <script src="https://chat.example/widget/js/widget-loader.js" data-widget-key="wk_oldoldold"
        data-chatbot-name="Assistant" data-primary-color="#2196f3" data-position="right" defer></script></body></html>`,
    '/nothing': () => '<html><body><p>No chat here.</p></body></html>',
    '/gtm': () => '<html><head><script async src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script></head><body></body></html>'
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/companies', require('../routes/company'));
    app.use('/api/widget', require('../routes/widget'));

    // A stub customer site on loopback, which the address guard exists to
    // block - so the guard is replaced here rather than weakened, as the
    // action and connector suites do.
    process.env.ACTIONS_ALLOW_HTTP = 'true';
    safeHttp.__setLookupForTests((hostname, options, callback) => dns.lookup(hostname, options, callback));

    company = await Company.create({
      name: 'WS5 Widget Settings Co',
      website: 'https://shop.example',
      allowedDomains: ['https://shop.example']
    });

    await new Promise(resolve => {
      server = http.createServer((req, res) => {
        const page = PAGES[req.url];
        res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
        res.end(page ? page(company.widgetKey) : 'not found');
      });
      server.listen(0, '127.0.0.1', () => {
        siteOrigin = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    await User.create({
      username: 'ws5-widget-admin', email: 'admin@ws5widget.example',
      password: 'TestPassword123!', role: 'company_admin', company: company._id
    });
    token = (await request(app)
      .post('/api/auth/login')
      .send({ username: 'ws5-widget-admin', password: 'TestPassword123!' })).body.token;
  });

  afterAll(async () => {
    safeHttp.__setLookupForTests(null);
    delete process.env.ACTIONS_ALLOW_HTTP;
    await new Promise(resolve => server.close(resolve));
    await AuditLog.deleteMany({ company: company._id });
    await Subscription.deleteMany({ company: company._id });
    await User.deleteMany({ email: /@ws5widget\.example$/ });
    await Company.deleteMany({ name: 'WS5 Widget Settings Co' });
    await mongoose.connection.close();
  });

  beforeEach(() => {
    widgetInstall.resetThrottle();
    tenantService.invalidate();
  });

  const put = body => request(app).put('/api/companies/me/widget').set('x-auth-token', token).send(body);
  const publicConfig = async (headers = {}) => {
    tenantService.invalidate();
    const fresh = await Company.findById(company._id);
    let call = request(app).get('/api/widget/config').query({ key: fresh.widgetKey });
    Object.entries(headers).forEach(([name, value]) => {
      call = call.set(name, value);
    });
    return (await call).body;
  };

  describe('saving', () => {
    it('stores up to four suggested questions and serves them publicly', async () => {
      const response = await put({ widgetSettings: { suggestedQuestions: [' Do you ship abroad? ', '', 'Opening hours?'] } });
      expect(response.status).toBe(200);
      expect(response.body.widgetSettings.suggestedQuestions).toEqual(['Do you ship abroad?', 'Opening hours?']);

      expect((await publicConfig()).settings.suggestedQuestions).toEqual(['Do you ship abroad?', 'Opening hours?']);
    });

    it.each([
      [{ suggestedQuestions: ['1', '2', '3', '4', '5'] }, /at most four/],
      [{ suggestedQuestions: ['x'.repeat(121)] }, /120 characters/],
      [{ suggestedQuestions: 'not a list' }, /list/],
      [{ consentText: 'x'.repeat(301) }, /300 characters/],
      [{ privacyPolicyUrl: 'javascript:alert(1)' }, /http/],
      [{ proactive: { enabled: true, text: '' } }, /Write the proactive message/],
      [{ proactive: { enabled: true, text: 'Hi', delaySeconds: 3 } }, /5 to 120/],
      [{ proactive: { enabled: false, delaySeconds: 500 } }, /5 to 120/],
      [{ proactive: 'yes' }, /object/]
    ])('refuses %j and changes nothing', async (widgetSettings, message) => {
      const before = (await Company.findById(company._id)).widgetSettings.toObject();
      const response = await put({ widgetSettings: { ...widgetSettings, chatbotName: 'Should not save' } });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(message);
      const after = (await Company.findById(company._id)).widgetSettings.toObject();
      expect(after.chatbotName).toBe(before.chatbotName);
    });

    it('stores consent and serves it', async () => {
      const response = await put({ widgetSettings: { consentRequired: true, consentText: ' I agree to Bloom keeping this chat. ' } });
      expect(response.status).toBe(200);

      const config = await publicConfig();
      expect(config.settings.consentRequired).toBe(true);
      expect(config.settings.consentText).toBe('I agree to Bloom keeping this chat.');

      await put({ widgetSettings: { consentRequired: false, consentText: '' } });
      const cleared = await publicConfig();
      expect(cleared.settings.consentRequired).toBe(false);
      expect(cleared.settings.consentText).toBeNull();
    });

    it('stores a proactive message and serves it only while it is on', async () => {
      const response = await put({
        widgetSettings: { proactive: { enabled: true, text: 'Need a hand?', delaySeconds: 15, pathContains: '/pricing' } }
      });
      expect(response.status).toBe(200);
      expect((await publicConfig()).settings.proactive)
        .toEqual({ enabled: true, text: 'Need a hand?', delaySeconds: 15, pathContains: '/pricing' });

      await put({ widgetSettings: { proactive: { enabled: false, text: 'Need a hand?', delaySeconds: 15 } } });
      expect((await publicConfig()).settings.proactive).toBeNull();
    });

    it('links no privacy policy until the tenant sets theirs', async () => {
      await put({ widgetSettings: { privacyPolicyUrl: '' } });
      expect((await publicConfig()).settings.privacyPolicyUrl).toBeNull();

      await put({ widgetSettings: { privacyPolicyUrl: 'https://shop.example/privacy' } });
      expect((await publicConfig()).settings.privacyPolicyUrl).toBe('https://shop.example/privacy');
    });
  });

  describe('the public config', () => {
    it('asks for nothing before the chat unless the tenant says so', async () => {
      const unknown = (await request(app).get('/api/widget/config').query({ key: 'wk_nobody' })).body;
      expect(unknown.settings.requireName).toBe(false);
      expect(unknown.settings.requireEmail).toBe(false);
      expect(unknown.settings.privacyPolicyUrl).toBeNull();
      expect(unknown.settings.suggestedQuestions).toEqual([]);
    });

    it('names the business and says what the plan allows', async () => {
      const config = await publicConfig();
      expect(config.companyName).toBe('WS5 Widget Settings Co');
      expect(config.features).toEqual({ fileUploads: true });
    });

    it('leaves out uploads on a plan without them, without saying why', async () => {
      const spy = jest.spyOn(usageService, 'hasFeature').mockResolvedValue(false);
      try {
        const config = await publicConfig();
        expect(config.features).toEqual({ fileUploads: false });
        expect(JSON.stringify(config)).not.toMatch(/plan/i);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('where the widget was seen', () => {
    beforeEach(async () => {
      await Company.updateOne({ _id: company._id }, { $unset: { widgetSeen: 1 } });
    });

    it('records a page on an allowed domain, from Origin or Referer', async () => {
      await publicConfig({ Origin: 'https://shop.example' });
      let seen = (await Company.findById(company._id).lean()).widgetSeen;
      expect(seen.origin).toBe('https://shop.example');
      expect(seen.origins).toEqual(['https://shop.example']);
      expect(new Date(seen.at).getTime()).toBeGreaterThan(Date.now() - 10000);

      await Company.updateOne({ _id: company._id }, { $unset: { widgetSeen: 1 } });
      widgetInstall.resetThrottle();
      await publicConfig({ Referer: 'https://shop.example/basket?x=1' });
      seen = (await Company.findById(company._id).lean()).widgetSeen;
      expect(seen.origin).toBe('https://shop.example');
    });

    it('ignores a page that is not one of the tenant\'s domains', async () => {
      await publicConfig({ Origin: 'https://copycat.example' });
      await publicConfig();
      const stored = await Company.findById(company._id).lean();
      expect(stored.widgetSeen && stored.widgetSeen.at).toBeFalsy();
    });

    it('writes at most once a minute, then keeps the newest ten sites, newest first', async () => {
      const lean = { _id: company._id, allowedDomains: [] };
      const now = Date.now();
      const origins = Array.from({ length: 12 }, (_, index) => `https://site${index}.example`);
      lean.allowedDomains = origins;

      expect(await widgetInstall.recordSeen(lean, origins[0], { now })).toBe(true);
      expect(await widgetInstall.recordSeen(lean, origins[1], { now: now + 30 * 1000 })).toBe(false);

      // A second process, which has no throttle of its own, is held back by
      // the database instead.
      widgetInstall.resetThrottle();
      expect(await widgetInstall.recordSeen(lean, origins[1], { now: now + 40 * 1000 })).toBe(false);

      let at = now;
      for (const origin of origins.slice(1)) {
        at += 61 * 1000;
        expect(await widgetInstall.recordSeen(lean, origin, { now: at })).toBe(true);
      }
      at += 61 * 1000;
      expect(await widgetInstall.recordSeen(lean, origins[5], { now: at })).toBe(true);

      const seen = (await Company.findById(company._id).lean()).widgetSeen;
      expect(seen.origin).toBe(origins[5]);
      expect(seen.origins).toHaveLength(10);
      expect(seen.origins[0]).toBe(origins[5]);
      expect(seen.origins.filter(origin => origin === origins[5])).toHaveLength(1);
      expect(seen.origins).not.toContain(origins[0]);
    });

    it('shows on the settings screen', async () => {
      await publicConfig({ Origin: 'https://shop.example' });
      const response = await request(app).get('/api/companies/me/widget').set('x-auth-token', token);
      expect(response.status).toBe(200);
      expect(response.body.widgetSeen.origin).toBe('https://shop.example');
      expect(response.body.website).toBe('https://shop.example');
    });
  });

  describe('Check my site', () => {
    const check = url => request(app).post('/api/companies/me/widget/check').set('x-auth-token', token).send({ url });

    it('finds the snippet with this company\'s key', async () => {
      await put({ allowedDomains: ['https://shop.example', siteOrigin] });
      const response = await check(`${siteOrigin}/installed`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true, installed: true, loaderFound: true, keyFound: true, domainAllowed: true, legacyAttributes: []
      });
    });

    it('spots an old key, old attributes and a site missing from the allowed domains', async () => {
      await put({ allowedDomains: ['https://shop.example'] });
      const response = await check(`${siteOrigin}/old-key`);

      expect(response.body.installed).toBe(false);
      expect(response.body.loaderFound).toBe(true);
      expect(response.body.otherKeys).toEqual(['wk_oldoldold']);
      expect(response.body.legacyAttributes).toEqual(['data-chatbot-name', 'data-primary-color', 'data-position']);
      expect(response.body.domainAllowed).toBe(false);
    });

    it('says when the snippet is not there, and when a tag manager might hide it', async () => {
      expect((await check(`${siteOrigin}/nothing`)).body).toMatchObject({ ok: true, installed: false, loaderFound: false, tagManager: false });
      expect((await check(`${siteOrigin}/gtm`)).body).toMatchObject({ ok: true, installed: false, tagManager: true });
    });

    it('reports a page that cannot be loaded rather than failing', async () => {
      const response = await check(`${siteOrigin}/missing`);
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toMatch(/404/);
    });

    it('refuses to fetch a private address', async () => {
      const response = await check('http://169.254.169.254/latest/meta-data/');
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toMatch(/private or reserved/);
    });

    it('refuses something that is not a web address', async () => {
      const response = await check('javascript:alert(1)');
      expect(response.status).toBe(400);
    });
  });

  describe('the audit trail', () => {
    const entries = action => AuditLog.find({ company: company._id, action }).sort({ at: -1 }).lean();

    it('records a rotated key', async () => {
      const response = await request(app).post('/api/companies/me/widget/rotate-key').set('x-auth-token', token);
      expect(response.status).toBe(200);
      const [entry] = await entries('widget.key_rotated');
      expect(entry).toBeDefined();
      expect(entry.actor.username).toBe('ws5-widget-admin');
      expect(JSON.stringify(entry.details)).not.toContain(response.body.widgetKey);
    });

    it('records which domains were added and removed', async () => {
      await put({ allowedDomains: ['https://shop.example'] });
      await put({ allowedDomains: ['https://shop.example', 'https://www.shop.example'] });
      let [entry] = await entries('widget.domains_changed');
      expect(entry.details).toEqual({ added: ['https://www.shop.example'], removed: [] });

      await put({ allowedDomains: ['https://www.shop.example'] });
      [entry] = await entries('widget.domains_changed');
      expect(entry.details).toEqual({ added: [], removed: ['https://shop.example'] });
    });

    it('records which settings changed, and nothing when none did', async () => {
      await put({ widgetSettings: { chatbotName: 'Bea', primaryColor: '#2196f3' } });
      const before = (await entries('widget.settings_updated')).length;

      await put({ widgetSettings: { chatbotName: 'Bea' } });
      expect((await entries('widget.settings_updated')).length).toBe(before);

      await put({ widgetSettings: { chatbotName: 'Olive', primaryColor: '#000000' } });
      const [entry] = await entries('widget.settings_updated');
      expect(entry.details.changed).toEqual(['chatbotName', 'primaryColor']);
    });
  });
});

describe('reading a page for the snippet', () => {
  it('needs both the loader and the key', () => {
    const html = '<script src="/widget/js/widget-loader.js" data-widget-key="wk_mine"></script>';
    expect(widgetInstall.inspectHtml(html, 'wk_mine')).toMatchObject({ loaderFound: true, keyFound: true, otherKeys: [] });
    expect(widgetInstall.inspectHtml(html, 'wk_other')).toMatchObject({ loaderFound: true, keyFound: false, otherKeys: ['wk_mine'] });
  });

  it('accepts a bare domain as its https home page', () => {
    expect(widgetInstall.normaliseCheckUrl('shop.example')).toBe('https://shop.example/');
    expect(widgetInstall.normaliseCheckUrl('ftp://shop.example')).toBeNull();
    expect(widgetInstall.normaliseCheckUrl('')).toBeNull();
  });
});
