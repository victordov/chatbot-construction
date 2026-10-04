/**
 * The widget's language and logo settings.
 *
 * Both are drawn on the tenant's own website, so both are validated on the
 * way in (a language the widget speaks, an https logo) and again on the way
 * out of the public config endpoint, which anybody can call.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Company = require('../models/company');
const User = require('../models/user');
const tenantService = require('../services/tenant');

describe('Widget language and logo settings', () => {
  let app;
  let acme;
  let adminToken;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/companies', require('../routes/company'));
    app.use('/api/widget', require('../routes/widget'));

    acme = await Company.create({ name: 'Widget Config Co' });
    await User.create({
      username: 'widget-config-admin', email: 'admin@widgetconfig.example',
      password: 'TestPassword123!', role: 'company_admin', company: acme._id
    });

    adminToken = (await request(app)
      .post('/api/auth/login')
      .send({ username: 'widget-config-admin', password: 'TestPassword123!' })).body.token;
  });

  afterAll(async () => {
    await User.deleteMany({ email: /@widgetconfig\.example$/ });
    await Company.deleteMany({ name: 'Widget Config Co' });
    await mongoose.connection.close();
  });

  const put = widgetSettings => request(app)
    .put('/api/companies/me/widget')
    .set('x-auth-token', adminToken)
    .send({ widgetSettings });

  const publicConfig = async () => {
    tenantService.invalidate();
    const company = await Company.findById(acme._id);
    return (await request(app).get('/api/widget/config').query({ key: company.widgetKey })).body;
  };

  it('defaults to auto and offers the list of languages', async () => {
    const response = await request(app).get('/api/companies/me/widget').set('x-auth-token', adminToken);

    expect(response.status).toBe(200);
    expect(response.body.widgetSettings.language).toBe('auto');
    expect(response.body.languages).toEqual(['auto', 'en', 'es', 'fr', 'de', 'it', 'pt', 'ro', 'ru', 'uk', 'pl', 'nl']);

    const config = await publicConfig();
    expect(config.recognised).toBe(true);
    expect(config.settings.language).toBe('auto');
    expect(config.settings.logoUrl).toBeNull();
  });

  it('stores a language the widget speaks and serves it publicly', async () => {
    const response = await put({ language: 'ro' });
    expect(response.status).toBe(200);
    expect(response.body.widgetSettings.language).toBe('ro');

    expect((await publicConfig()).settings.language).toBe('ro');
  });

  it('refuses a language the widget does not speak, and changes nothing', async () => {
    await put({ language: 'de' });
    const response = await put({ language: 'klingon', chatbotName: 'Should not save' });

    expect(response.status).toBe(400);
    const company = await Company.findById(acme._id);
    expect(company.widgetSettings.language).toBe('de');
    expect(company.widgetSettings.chatbotName).not.toBe('Should not save');
  });

  it('stores an https logo and serves it publicly', async () => {
    const response = await put({ logoUrl: 'https://cdn.example.com/acme.png' });
    expect(response.status).toBe(200);

    expect((await publicConfig()).settings.logoUrl).toBe('https://cdn.example.com/acme.png');
  });

  it.each([
    'http://cdn.example.com/acme.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'not a url'
  ])('refuses %s as a logo', async logoUrl => {
    const response = await put({ logoUrl });
    expect(response.status).toBe(400);
  });

  it('removes the logo when given an empty value', async () => {
    await put({ logoUrl: 'https://cdn.example.com/acme.png' });
    const response = await put({ logoUrl: '' });
    expect(response.status).toBe(200);

    const company = await Company.findById(acme._id);
    expect(company.widgetSettings.logoUrl).toBeUndefined();
    expect((await publicConfig()).settings.logoUrl).toBeNull();
  });

  it('never serves an unsafe logo that predates validation', async () => {
    await Company.updateOne({ _id: acme._id }, { $set: { 'widgetSettings.logoUrl': 'javascript:alert(1)' } });
    expect((await publicConfig()).settings.logoUrl).toBeNull();
  });

  it('serves the defaults for an unknown widget key', async () => {
    const response = await request(app).get('/api/widget/config').query({ key: 'wk_nobody' });
    expect(response.body.recognised).toBe(false);
    expect(response.body.settings.language).toBe('auto');
  });
});
