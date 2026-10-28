/**
 * A widget answers only on its own tenant's domains.
 *
 * The domain check used to accept any origin that any tenant had registered.
 * Somebody could list their own site under a (free) account of their own and
 * then embed every other tenant's widget on it: the conversations billed to
 * the victim, the victim's name on the chat, a convincing support desk on a
 * site the victim never heard of.
 */

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' })
}));

jest.mock('../services/ai', () => ({
  forCompany: jest.fn().mockResolvedValue({ generateOperatorSuggestion: jest.fn().mockResolvedValue('draft') })
}));

const mongoose = require('mongoose');
const { createHarness, waitFor, pause, eventually, freshSessionId } = require('./ws1-socket-harness');
const tenantService = require('../services/tenant');
const Company = require('../models/company');
const Conversation = require('../models/conversation');

describe('WS1: the widget domain check is per tenant', () => {
  const harness = createHarness();
  let acme;
  let mallory;
  const saved = {};

  const withEnv = async (values, run) => {
    const previous = {};
    Object.entries(values).forEach(([key, value]) => {
      previous[key] = process.env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    try {
      return await run();
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    }
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    acme = await Company.create({ name: 'Acme WS1 Origin', allowedDomains: ['https://acme-origin.test'] });
    // The attacker's own tenant, with their own site registered.
    mallory = await Company.create({ name: 'Mallory WS1 Origin', allowedDomains: ['https://mallory-origin.test'] });
    tenantService.invalidate();

    saved.ALLOWED_DOMAINS = process.env.ALLOWED_DOMAINS;
    saved.PUBLIC_URL = process.env.PUBLIC_URL;
    delete process.env.ALLOWED_DOMAINS;
    delete process.env.PUBLIC_URL;

    await harness.start();
  });

  afterEach(async () => {
    harness.closeAll();
    await pause(30);
  });

  afterAll(async () => {
    await harness.stop();
    Object.entries(saved).forEach(([key, value]) => {
      if (value !== undefined) {
        process.env[key] = value;
      }
    });
    await Conversation.deleteMany({ sessionId: /^ws1-/ });
    await Company.deleteMany({ name: /WS1 Origin$/ });
    tenantService.invalidate();
    await mongoose.connection.close();
  });

  describe('isOriginAllowed', () => {
    it('allows a tenant\'s widget on that tenant\'s own domain', async () => {
      expect(await tenantService.isOriginAllowed('https://acme-origin.test', { widgetKey: acme.widgetKey })).toBe(true);
      expect(await tenantService.isOriginAllowed('https://acme-origin.test/pricing', { companyId: String(acme._id) })).toBe(true);
    });

    it('refuses a tenant\'s widget on a domain another tenant registered', async () => {
      expect(await tenantService.isOriginAllowed('https://mallory-origin.test', { widgetKey: acme.widgetKey })).toBe(false);
      expect(await tenantService.isOriginAllowed('https://mallory-origin.test', { companyId: String(acme._id) })).toBe(false);
    });

    it('refuses an unknown or rotated key, and a malformed company id, outright', async () => {
      expect(await tenantService.isOriginAllowed('https://acme-origin.test', { widgetKey: 'wk_not_real' })).toBe(false);
      expect(await tenantService.isOriginAllowed('https://acme-origin.test', { companyId: 'not-an-id' })).toBe(false);
    });

    it('without a tenant, answers only whether some tenant registered the origin', async () => {
      expect(await tenantService.isOriginAllowed('https://mallory-origin.test')).toBe(true);
      expect(await tenantService.isOriginAllowed('https://nobody-origin.test')).toBe(false);
    });

    it('always allows the platform\'s own origins', async () => {
      await withEnv({ ALLOWED_DOMAINS: 'https://partner.test, https://other.test', PUBLIC_URL: 'https://chat.platform.test' }, async () => {
        expect(await tenantService.isOriginAllowed('https://other.test', { widgetKey: acme.widgetKey })).toBe(true);
        expect(await tenantService.isOriginAllowed('https://chat.platform.test', { widgetKey: acme.widgetKey })).toBe(true);
      });
    });

    it('allows localhost only outside production', async () => {
      expect(await tenantService.isOriginAllowed('http://localhost:5500', { widgetKey: acme.widgetKey })).toBe(true);
      expect(await tenantService.isOriginAllowed('http://127.0.0.1:8080', { widgetKey: acme.widgetKey })).toBe(true);

      await withEnv({ NODE_ENV: 'production' }, async () => {
        expect(await tenantService.isOriginAllowed('http://localhost:5500', { widgetKey: acme.widgetKey })).toBe(false);
        expect(await tenantService.isOriginAllowed('http://localhost:3000')).toBe(false);
      });
    });

    it('sees a change to a tenant\'s domains once the cache is cleared', async () => {
      await Company.updateOne({ _id: acme._id }, { $push: { allowedDomains: 'https://shop.acme-origin.test' } });
      tenantService.invalidate();

      expect(await tenantService.isOriginAllowed('https://shop.acme-origin.test', { widgetKey: acme.widgetKey })).toBe(true);
    });
  });

  describe('a widget connection', () => {
    const connectFrom = (origin, widgetKey) => harness.connect({
      auth: { widgetKey },
      query: { widgetKey },
      extraHeaders: { origin }
    });

    it('from the tenant\'s own domain gets in and can chat', async () => {
      const socket = connectFrom('https://acme-origin.test', acme.widgetKey);
      await waitFor(socket, 'connect');

      const sessionId = freshSessionId('origin-ok');
      const session = await harness.resume(socket, sessionId);
      harness.say(socket, 'hello');
      await waitFor(socket, 'bot-message');

      expect(session.rejected).toBe(false);
      const conversation = await eventually(() => Conversation.findOne({ sessionId }));
      expect(String(conversation.company)).toBe(String(acme._id));
    });

    it('using one tenant\'s key from a domain another tenant registered is refused', async () => {
      const socket = connectFrom('https://mallory-origin.test', acme.widgetKey);

      const error = await waitFor(socket, 'connect_error');
      expect(error.message).toMatch(/not allowed/);
      expect(socket.connected).toBe(false);
    });

    it('a key named only in an event cannot move a connection to another tenant', async () => {
      // Connected as Mallory's widget on Mallory's site - allowed - and then
      // claiming Acme's key in the payload, which the handshake never saw.
      const socket = connectFrom('https://mallory-origin.test', mallory.widgetKey);
      await waitFor(socket, 'connect');

      const sessionId = freshSessionId('origin-swap');
      await harness.resume(socket, sessionId, undefined, { widgetKey: acme.widgetKey });
      harness.say(socket, 'hello');
      await waitFor(socket, 'bot-message');

      const conversation = await eventually(() => Conversation.findOne({ sessionId }));
      expect(String(conversation.company)).toBe(String(mallory._id));
    });

    it('a client that sends no Origin is not a browser page, and is let in', async () => {
      const socket = await harness.connectVisitor(acme.widgetKey);
      expect(socket.connected).toBe(true);
    });
  });
});
