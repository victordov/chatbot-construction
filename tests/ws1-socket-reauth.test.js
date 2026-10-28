/**
 * A connection stays authorised only as long as the person behind it is.
 *
 * Sockets were authenticated once, when they connected, and a dashboard stays
 * connected for a whole shift: an operator removed from the team kept
 * receiving the tenant's conversations until they closed the tab. And a
 * visitor's resume trusted the session token alone, so the next person on a
 * shared computer could read the previous one's verified conversation.
 */

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' })
}));

jest.mock('../services/ai', () => ({
  forCompany: jest.fn().mockResolvedValue({ generateOperatorSuggestion: jest.fn().mockResolvedValue('draft') })
}));

const crypto = require('crypto');
const mongoose = require('mongoose');
const { createHarness, waitFor, pause } = require('./ws1-socket-harness');
const socketManager = require('../socketManager');
const Company = require('../models/company');
const User = require('../models/user');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');

describe('WS1: connections that outlive the authority they were opened with', () => {
  const harness = createHarness();
  let company;
  let identitySecret;
  let previousInterval;

  const makeOperator = name => User.create({
    username: `${name}-ws1-reauth`, email: `${name}@reauth-ws1.example`, password: 'TestPassword123!',
    role: 'operator', displayName: name, company: company._id
  });

  const sign = externalId => crypto.createHmac('sha256', identitySecret).update(externalId).digest('hex');

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    company = await Company.create({ name: 'Reauth WS1 Sockets' });
    identitySecret = (await Company.findById(company._id).select('+identitySecret')).identitySecret;

    previousInterval = process.env.SOCKET_REAUTH_MS;
    process.env.SOCKET_REAUTH_MS = '50';

    await harness.start();
  });

  afterEach(async () => {
    harness.closeAll();
    await Company.updateOne({ _id: company._id }, { $set: { isActive: true } });
    await pause(30);
  });

  afterAll(async () => {
    await harness.stop();
    if (previousInterval === undefined) {
      delete process.env.SOCKET_REAUTH_MS;
    } else {
      process.env.SOCKET_REAUTH_MS = previousInterval;
    }
    await Conversation.deleteMany({ sessionId: /^ws1-/ });
    await Contact.deleteMany({ company: company._id });
    await User.deleteMany({ email: /@reauth-ws1\.example$/ });
    await Company.deleteMany({ name: /^Reauth WS1/ });
    await mongoose.connection.close();
  });

  describe('an operator\'s socket', () => {
    it('is closed at once by disconnectUser, every tab of it, and told why', async () => {
      const user = await makeOperator('dee');
      const first = await harness.connectOperator(user);
      const second = await harness.connectOperator(user);
      const told = waitFor(first, 'session-expired');
      const closed = [waitFor(first, 'disconnect'), waitFor(second, 'disconnect')];

      expect(socketManager.disconnectUser(String(user._id), 'deactivated')).toBe(true);

      expect(await told).toEqual({ reason: 'deactivated' });
      await Promise.all(closed);
      expect(first.connected || second.connected).toBe(false);
    });

    it('is closed on its next event once the person has been deactivated', async () => {
      const user = await makeOperator('eve');
      const socket = await harness.connectOperator(user);
      await User.updateOne({ _id: user._id }, { $set: { isActive: false } });
      await pause(80);

      const told = waitFor(socket, 'session-expired');
      const closed = waitFor(socket, 'disconnect');
      socket.emit('heartbeat', {});

      expect(await told).toEqual({ reason: 'deactivated' });
      await closed;
    });

    it('is closed once their password has changed under it', async () => {
      const user = await makeOperator('fay');
      const socket = await harness.connectOperator(user, { tv: 0 });
      await User.updateOne({ _id: user._id }, { $set: { tokenVersion: 1 } });
      await pause(80);

      const told = waitFor(socket, 'session-expired');
      socket.emit('heartbeat', {});

      expect(await told).toEqual({ reason: 'signed-out' });
    });

    it('is closed once the company is suspended, and cannot reconnect while it is', async () => {
      const user = await makeOperator('gus');
      const socket = await harness.connectOperator(user);
      await Company.updateOne({ _id: company._id }, { $set: { isActive: false } });
      await pause(80);

      const told = waitFor(socket, 'session-expired');
      socket.emit('heartbeat', {});
      expect(await told).toEqual({ reason: 'company-inactive' });

      const again = harness.connect({ auth: { token: harness.tokenFor(user) } });
      expect((await waitFor(again, 'connect_error')).message).toMatch(/Authentication failed/);
    });

    it('carries on as normal while nothing has changed', async () => {
      const user = await makeOperator('hal');
      const socket = await harness.connectOperator(user);
      await pause(80);

      socket.emit('heartbeat', { timestamp: 'still-here' });

      expect((await waitFor(socket, 'heartbeat-ack')).received).toBe('still-here');
      expect(socket.connected).toBe(true);
    });
  });

  describe('a visitor resuming a verified person\'s conversation', () => {
    const verifiedConversation = async (externalId) => {
      const contact = await Contact.create({
        company: company._id, externalId, identityLevel: 'verified', sessionIds: []
      });
      const visitor = await harness.connectVisitor(company.widgetKey, {
        auth: { externalId, userHash: sign(externalId) }
      });
      const sessionId = `ws1-verified-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const session = await harness.resume(visitor, sessionId);
      harness.say(visitor, 'My account question');
      await waitFor(visitor, 'bot-message');
      await Conversation.updateOne({ sessionId }, { $set: { contact: contact._id } });
      visitor.close();
      return { sessionId, sessionToken: session.sessionToken };
    };

    it('is refused when the browser now presents a different verified person', async () => {
      const { sessionId, sessionToken } = await verifiedConversation('user-41');

      const nextUser = await harness.connectVisitor(company.widgetKey, {
        auth: { externalId: 'user-42', userHash: sign('user-42') }
      });
      const attempt = await harness.resume(nextUser, sessionId, sessionToken);

      expect(attempt.rejected).toBe(true);
    });

    it('is allowed for the same verified person, and for a browser that presents nobody', async () => {
      const { sessionId, sessionToken } = await verifiedConversation('user-51');

      const samePerson = await harness.connectVisitor(company.widgetKey, {
        auth: { externalId: 'user-51', userHash: sign('user-51') }
      });
      expect((await harness.resume(samePerson, sessionId, sessionToken)).rejected).toBe(false);

      const anonymous = await harness.connectVisitor(company.widgetKey);
      expect((await harness.resume(anonymous, sessionId, sessionToken)).rejected).toBe(false);
    });

    it('is not refused because of a different identity nobody signed', async () => {
      const { sessionId, sessionToken } = await verifiedConversation('user-61');

      const claimed = await harness.connectVisitor(company.widgetKey, {
        auth: { externalId: 'user-62', userHash: 'not-a-signature' }
      });
      expect((await harness.resume(claimed, sessionId, sessionToken)).rejected).toBe(false);
    });
  });
});
