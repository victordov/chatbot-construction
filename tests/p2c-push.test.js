/**
 * Push notifications on an operator's own devices (P2C).
 *
 * The web-push library is mocked: nothing here reaches a real push service.
 * VAPID keys are a real pair from scripts/generate-vapid-keys.js, set and
 * cleared per test, because "no keys, no push" is one of the rules.
 */

jest.mock('web-push', () => ({ sendNotification: jest.fn() }));

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const webPush = require('web-push');

const Company = require('../models/company');
const User = require('../models/user');
const Conversation = require('../models/conversation');
const Notification = require('../models/notification');
const PushSubscription = require('../models/push-subscription');
const RevokedToken = require('../models/revoked-token');
const push = require('../services/push');
const NotificationService = require('../services/notification');
const lifecycle = require('../services/conversation-lifecycle');
const socketManager = require('../socketManager');
const eventually = require('./eventually');
const { generate } = require('../scripts/generate-vapid-keys');

const KEYS = generate();
const OTHER_KEYS = generate();
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

function pushOn() {
  process.env.VAPID_PUBLIC_KEY = KEYS.publicKey;
  process.env.VAPID_PRIVATE_KEY = KEYS.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:ops@p2c.example';
}

function pushOff() {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
}

let counter = 0;
/** A subscription as a browser serialises it, on a push service's host. */
function browserSubscription() {
  counter += 1;
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/p2c-${Date.now()}-${counter}`,
    expirationTime: null,
    keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'abcdefghijklmnopqrstuv' }
  };
}

/** A device stored directly, for the service tests. */
function device(user, overrides = {}) {
  const { endpoint, keys } = browserSubscription();
  return PushSubscription.create({
    user: user._id,
    company: user.company,
    endpoint,
    keys,
    vapidKey: KEYS.publicKey,
    tokenVersion: user.tokenVersion || 0,
    label: 'Test phone',
    ...overrides
  });
}

/** What the mocked library was asked to send, decoded. */
function sentMessages() {
  return webPush.sendNotification.mock.calls.map(([subscription, payload, options]) => ({
    endpoint: subscription.endpoint,
    message: JSON.parse(payload),
    options
  }));
}

describe('Push notifications (P2C)', () => {
  let app;
  let acme;
  let rival;
  let nina;
  let ola;
  let admin;
  let away;
  let other;
  let ninaToken;
  let olaToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/push', require('../routes/push'));

    acme = await Company.create({ name: 'P2C Push Acme' });
    rival = await Company.create({ name: 'P2C Push Rival' });

    const make = (username, company, extra = {}) => User.create({
      username,
      email: `${username}@p2cpush.example`,
      password: 'TestPassword123!',
      role: 'operator',
      company: company._id,
      ...extra
    });
    nina = await make('p2c-push-nina', acme, { displayName: 'Nina' });
    ola = await make('p2c-push-ola', acme, { displayName: 'Ola' });
    admin = await make('p2c-push-admin', acme, { role: 'company_admin' });
    away = await make('p2c-push-away', acme, { acceptingChats: false });
    other = await make('p2c-push-other', rival);

    ninaToken = await login('p2c-push-nina');
    olaToken = await login('p2c-push-ola');
  });

  afterAll(async () => {
    pushOff();
    const users = await User.find({ email: /@p2cpush\.example$/ }).select('_id');
    await PushSubscription.deleteMany({ user: { $in: users.map(user => user._id) } });
    await Notification.deleteMany({ userId: { $in: users.map(user => user._id) } });
    await Conversation.deleteMany({ sessionId: /^p2c-push-/ });
    await User.deleteMany({ email: /@p2cpush\.example$/ });
    await Company.deleteMany({ name: /^P2C Push / });
  });

  beforeEach(async () => {
    pushOn();
    webPush.sendNotification.mockReset();
    webPush.sendNotification.mockResolvedValue({ statusCode: 201 });
    socketManager.setIo({ to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) });
    await PushSubscription.deleteMany({});
  });

  // ---------------------------------------------------------------- routes

  describe('the API', () => {
    test('needs a signed-in member of staff', async () => {
      expect((await request(app).get('/api/push/key')).status).toBe(401);
      expect((await request(app).post('/api/push/subscribe').send({})).status).toBe(401);
      expect((await request(app).post('/api/push/test')).status).toBe(401);
    });

    test('the key says whether push is set up', async () => {
      const on = await request(app).get('/api/push/key').set('x-auth-token', ninaToken);
      expect(on.body).toEqual({ enabled: true, publicKey: KEYS.publicKey });

      pushOff();
      const off = await request(app).get('/api/push/key').set('x-auth-token', ninaToken);
      expect(off.body).toEqual({ enabled: false, publicKey: null });
    });

    test('subscribing stores this device for this person, with previews off', async () => {
      const subscription = browserSubscription();
      const response = await request(app)
        .post('/api/push/subscribe')
        .set('x-auth-token', ninaToken)
        .set('User-Agent', ANDROID_CHROME)
        .send({ subscription, level: 'important' });

      expect(response.status).toBe(201);
      expect(response.body.device).toMatchObject({ label: 'Chrome on Android', level: 'important', previews: false });
      // The list never hands back where or how to send to a device.
      expect(JSON.stringify(response.body)).not.toContain(subscription.endpoint);
      expect(JSON.stringify(response.body)).not.toContain(subscription.keys.auth);

      const stored = await PushSubscription.findOne({ endpoint: subscription.endpoint }).lean();
      expect(String(stored.user)).toBe(String(nina._id));
      expect(String(stored.company)).toBe(String(acme._id));
      expect(stored.keys).toEqual(subscription.keys);
      expect(stored.vapidKey).toBe(KEYS.publicKey);
      expect(stored.jti).toBeTruthy();

      // Turning previews on is an update of the same device.
      const again = await request(app)
        .post('/api/push/subscribe')
        .set('x-auth-token', ninaToken)
        .send({ subscription, previews: true });
      expect(again.status).toBe(200);
      expect(again.body.device).toMatchObject({ previews: true, level: 'important' });
      expect(await PushSubscription.countDocuments({ user: nina._id })).toBe(1);
    });

    test('without VAPID keys nothing is stored and the dashboard is told why', async () => {
      pushOff();
      const response = await request(app)
        .post('/api/push/subscribe')
        .set('x-auth-token', ninaToken)
        .send({ subscription: browserSubscription() });

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('PUSH_NOT_CONFIGURED');
      expect(await PushSubscription.countDocuments({})).toBe(0);
    });

    test('refuses a push address this server should not call', async () => {
      const keys = browserSubscription().keys;
      for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/push', 'https://169.254.169.254/latest', 'not a url']) {
        const response = await request(app)
          .post('/api/push/subscribe')
          .set('x-auth-token', ninaToken)
          .send({ subscription: { endpoint, keys } });
        expect(response.status).toBe(400);
      }

      const noKeys = await request(app)
        .post('/api/push/subscribe')
        .set('x-auth-token', ninaToken)
        .send({ subscription: { endpoint: browserSubscription().endpoint } });
      expect(noKeys.status).toBe(400);
      expect(await PushSubscription.countDocuments({})).toBe(0);
    });

    test('a check-in never creates a device, and a device changes hands with the person signed in', async () => {
      const subscription = browserSubscription();

      const unknown = await request(app)
        .post('/api/push/subscribe')
        .set('x-auth-token', ninaToken)
        .send({ subscription, refresh: true });
      expect(unknown.status).toBe(200);
      expect(unknown.body.device).toBeNull();
      expect(await PushSubscription.countDocuments({})).toBe(0);

      // Ola turned notifications on in this browser; then Nina signs in on it.
      await request(app).post('/api/push/subscribe').set('x-auth-token', olaToken).send({ subscription, previews: true });
      const taken = await request(app)
        .post('/api/push/subscribe')
        .set('x-auth-token', ninaToken)
        .send({ subscription, refresh: true });
      expect(taken.body.device).toBeNull();
      expect(await PushSubscription.countDocuments({ endpoint: subscription.endpoint })).toBe(0);
    });

    test('turning notifications on takes a device over, with the defaults', async () => {
      const subscription = browserSubscription();
      await request(app).post('/api/push/subscribe').set('x-auth-token', olaToken).send({ subscription, previews: true });

      const response = await request(app)
        .post('/api/push/subscribe')
        .set('x-auth-token', ninaToken)
        .send({ subscription });

      expect(response.status).toBe(201);
      expect(response.body.device.previews).toBe(false);
      const stored = await PushSubscription.findOne({ endpoint: subscription.endpoint }).lean();
      expect(String(stored.user)).toBe(String(nina._id));
    });

    test('a check-in from a browser subscribed under an older key is asked to subscribe again', async () => {
      const subscription = browserSubscription();
      await request(app).post('/api/push/subscribe').set('x-auth-token', ninaToken).send({ subscription, previews: true });

      const response = await request(app)
        .post('/api/push/subscribe')
        .set('x-auth-token', ninaToken)
        .send({ subscription, applicationServerKey: OTHER_KEYS.publicKey, refresh: true });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ resubscribe: true, publicKey: KEYS.publicKey, device: { previews: true } });
    });

    test('lists only my devices, and I can remove only mine', async () => {
      const mine = browserSubscription();
      const theirs = browserSubscription();
      await request(app).post('/api/push/subscribe').set('x-auth-token', ninaToken).send({ subscription: mine });
      await request(app).post('/api/push/subscribe').set('x-auth-token', olaToken).send({ subscription: theirs });

      const list = await request(app).get('/api/push/devices').set('x-auth-token', ninaToken);
      expect(list.status).toBe(200);
      expect(list.body.devices).toHaveLength(1);
      expect(list.body.devices[0]).not.toHaveProperty('endpoint');

      const olaDevice = await PushSubscription.findOne({ endpoint: theirs.endpoint });
      const refused = await request(app)
        .delete('/api/push/subscribe')
        .set('x-auth-token', ninaToken)
        .send({ id: String(olaDevice._id) });
      expect(refused.body.removed).toBe(false);
      expect(await PushSubscription.countDocuments({ endpoint: theirs.endpoint })).toBe(1);

      const removed = await request(app)
        .delete('/api/push/subscribe')
        .set('x-auth-token', ninaToken)
        .send({ endpoint: mine.endpoint });
      expect(removed.body.removed).toBe(true);
      expect(await PushSubscription.countDocuments({ user: nina._id })).toBe(0);

      const byId = await request(app)
        .delete('/api/push/subscribe')
        .set('x-auth-token', olaToken)
        .send({ id: String(olaDevice._id) });
      expect(byId.body.removed).toBe(true);
    });

    test('a test reaches my device and is shown even with the dashboard in front', async () => {
      const subscription = browserSubscription();
      await request(app).post('/api/push/subscribe').set('x-auth-token', ninaToken).send({ subscription });

      const response = await request(app).post('/api/push/test').set('x-auth-token', ninaToken).send({});
      expect(response.status).toBe(200);
      expect(response.body.sent).toBe(1);

      const [sent] = sentMessages();
      expect(sent.endpoint).toBe(subscription.endpoint);
      expect(sent.message).toMatchObject({ kind: 'test', always: true, url: '/admin/?section=profile' });
      expect(sent.options.vapidDetails).toEqual({
        publicKey: KEYS.publicKey,
        privateKey: KEYS.privateKey,
        subject: 'mailto:ops@p2c.example'
      });
    });

    test('a test says so when there is nothing to send to, or push is off', async () => {
      const none = await request(app).post('/api/push/test').set('x-auth-token', ninaToken).send({});
      expect(none.status).toBe(404);

      pushOff();
      const off = await request(app).post('/api/push/test').set('x-auth-token', ninaToken).send({});
      expect(off.status).toBe(503);
      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------- sending

  describe('sending', () => {
    test('a device the push service says is gone is removed; a failing one is kept', async () => {
      const gone = await device(nina);
      const expired = await device(nina);
      const flaky = await device(nina);
      const fine = await device(nina);

      webPush.sendNotification.mockImplementation(async subscription => {
        if (subscription.endpoint === gone.endpoint) {
          throw Object.assign(new Error('Gone'), { statusCode: 410 });
        }
        if (subscription.endpoint === expired.endpoint) {
          throw Object.assign(new Error('Not found'), { statusCode: 404 });
        }
        if (subscription.endpoint === flaky.endpoint) {
          throw Object.assign(new Error('Server error'), { statusCode: 500 });
        }
        return { statusCode: 201 };
      });

      const result = await push.sendToUser(nina._id, { kind: 'handoff', title: 'Bea asked for a person', tag: 'handoff:s1' });

      expect(result).toEqual({ sent: 1, removed: 2, failed: 1 });
      const left = await PushSubscription.find({ user: nina._id }).lean();
      expect(left.map(item => item.endpoint).sort()).toEqual([flaky.endpoint, fine.endpoint].sort());
      expect(left.find(item => item.endpoint === fine.endpoint).lastSentAt).toBeTruthy();
    });

    test('nothing is sent without VAPID keys', async () => {
      await device(nina);
      pushOff();

      expect(await push.sendToUser(nina._id, { kind: 'test', title: 'Hello' })).toMatchObject({ sent: 0 });
      expect(await push.sendToOperators(acme._id, { kind: 'handoff', title: 'Hello' })).toMatchObject({ sent: 0 });
      await NotificationService.notifyUser(nina._id, { type: 'chat_assigned', message: 'A chat', sessionId: 'p2c-push-off' });
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });

    test('malformed keys count as not set', async () => {
      process.env.VAPID_PUBLIC_KEY = 'not-a-key';
      expect(push.isConfigured()).toBe(false);
      expect(push.publicKey()).toBeNull();
    });

    test('a preview goes only to devices whose owner asked for previews', async () => {
      const quiet = await device(nina);
      const chatty = await device(nina, { previews: true });

      await push.notificationEvent(nina._id, {
        _id: new mongoose.Types.ObjectId(),
        type: 'chat_transferred',
        message: 'Al transferred a conversation to you: Bea wants a refund',
        sessionId: 'p2c-push-s1',
        link: '?section=active-chats&chat=p2c-push-s1'
      });

      const sent = sentMessages();
      expect(sent).toHaveLength(2);
      const to = endpoint => sent.find(item => item.endpoint === endpoint);

      expect(to(quiet.endpoint).message.body).not.toContain('refund');
      expect(to(chatty.endpoint).message.body).toContain('Bea wants a refund');
      sent.forEach(({ message, options }) => {
        expect(message).toMatchObject({
          title: 'A conversation was transferred to you',
          url: '/admin/?section=active-chats&chat=p2c-push-s1',
          // The dashboard's own key for the same alert, so repeats collapse.
          tag: 'transfer:p2c-push-s1'
        });
        expect(options.urgency).toBe('high');
        expect(options.topic.length).toBeLessThanOrEqual(32);
        expect(options.TTL).toBe(3600);
      });
    });

    test("each device's setting decides what it is told about", async () => {
      const everything = await device(nina, { level: 'all' });
      const needed = await device(nina, { level: 'important' });
      await device(nina, { level: 'none' });

      await push.sendToUser(nina._id, { kind: 'new-chat', title: 'New chat' });
      expect(sentMessages().map(item => item.endpoint)).toEqual([everything.endpoint]);

      webPush.sendNotification.mockClear();
      await push.sendToUser(nina._id, { kind: 'handoff', title: 'Bea asked for a person' });
      expect(sentMessages().map(item => item.endpoint).sort()).toEqual([everything.endpoint, needed.endpoint].sort());

      webPush.sendNotification.mockClear();
      await push.sendToUser(nina._id, push.testPayload());
      expect(sentMessages()).toHaveLength(3);
    });

    test('a device whose session ended hears nothing more', async () => {
      // Signed out of that browser: its token id is revoked.
      const signedOut = await device(nina, { jti: 'p2c-push-revoked-jti' });
      await RevokedToken.create({ _id: 'p2c-push-revoked-jti', user: nina._id, expiresAt: new Date(Date.now() + 3600000) });
      // Subscribed under keys the deployment has since replaced.
      const oldKey = await device(nina, { vapidKey: OTHER_KEYS.publicKey });
      const current = await device(nina, { jti: 'p2c-push-live-jti' });

      await push.sendToUser(nina._id, { kind: 'handoff', title: 'Bea asked for a person' });
      expect(sentMessages().map(item => item.endpoint)).toEqual([current.endpoint]);
      expect(await PushSubscription.countDocuments({ _id: { $in: [signedOut._id, oldKey._id] } })).toBe(0);

      // "Sign out everywhere" moves the token version on.
      await User.updateOne({ _id: nina._id }, { $inc: { tokenVersion: 1 } });
      webPush.sendNotification.mockClear();
      await push.sendToUser(nina._id, { kind: 'handoff', title: 'Bea asked for a person' });
      expect(webPush.sendNotification).not.toHaveBeenCalled();
      expect(await PushSubscription.countDocuments({ user: nina._id })).toBe(0);

      await User.updateOne({ _id: nina._id }, { $inc: { tokenVersion: -1 } });
      await RevokedToken.deleteOne({ _id: 'p2c-push-revoked-jti' });
    });

    test('somebody removed from the team is not told, and their devices go', async () => {
      const gone = await User.create({
        username: 'p2c-push-gone', email: 'p2c-push-gone@p2cpush.example', password: 'TestPassword123!',
        role: 'operator', company: acme._id, isActive: false
      });
      await device(gone);

      expect(await push.sendToUser(gone._id, { kind: 'test', title: 'Hello' })).toMatchObject({ sent: 0 });
      expect(webPush.sendNotification).not.toHaveBeenCalled();
      expect(await PushSubscription.countDocuments({ user: gone._id })).toBe(0);
    });

    test("a team push reaches the company's people taking chats, and nobody else", async () => {
      const ninaPhone = await device(nina);
      const adminPhone = await device(admin);
      const awayPhone = await device(away);
      await device(other);

      await push.sendToOperators(acme._id, { kind: 'handoff', title: 'Bea asked for a person' });
      expect(sentMessages().map(item => item.endpoint).sort()).toEqual([ninaPhone.endpoint, adminPhone.endpoint].sort());

      webPush.sendNotification.mockClear();
      await push.sendToOperators(acme._id, { kind: 'handoff', title: 'Bea asked for a person' }, { onlyAvailable: false });
      expect(sentMessages().map(item => item.endpoint)).toContain(awayPhone.endpoint);
      expect(sentMessages()).toHaveLength(3);
    });

    test('nothing is pushed about conversations outside business hours', async () => {
      const closed = await Company.create({
        name: 'P2C Push Closed',
        businessHours: { enabled: true, timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, closed: true })) }
      });
      const night = await User.create({
        username: 'p2c-push-night', email: 'p2c-push-night@p2cpush.example', password: 'TestPassword123!',
        role: 'operator', company: closed._id
      });
      await device(night);

      const result = await push.conversationEvent('handoff', { sessionId: 'p2c-push-night', company: closed._id });
      expect(result).toMatchObject({ sent: 0, closed: true });
      expect(webPush.sendNotification).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------- hooks

  describe('what raises a push', () => {
    test('a chat assigned to somebody reaches their phone, through notifyUser', async () => {
      const phone = await device(nina, { level: 'important' });

      await NotificationService.notifyUser(nina._id, {
        type: 'chat_assigned',
        message: 'A conversation was assigned to you',
        sessionId: 'p2c-push-assigned'
      });

      const sent = await eventually(() => sentMessages().length > 0 && sentMessages());
      expect(sent).toHaveLength(1);
      expect(sent[0].endpoint).toBe(phone.endpoint);
      expect(sent[0].message).toMatchObject({
        title: 'A conversation was assigned to you',
        tag: 'assignment:p2c-push-assigned',
        url: '/admin/?section=active-chats&chat=p2c-push-assigned'
      });
    });

    test('a low rating and a usage warning respect "only when I\'m needed"', async () => {
      await device(nina, { level: 'important' });
      const spy = jest.spyOn(push, 'notificationEvent');

      await NotificationService.notifyUser(nina._id, { type: 'low_rating', message: 'Rated 1/5', sessionId: 'p2c-push-rated' });
      await NotificationService.notifyUser(nina._id, { type: 'usage_warning', message: 'Conversations: 90%' });

      expect(spy).toHaveBeenCalledTimes(2);
      await Promise.all(spy.mock.results.map(result => result.value));
      expect(webPush.sendNotification).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    test('a new chat and a handoff reach the operators, once each', async () => {
      const everything = await device(nina, { level: 'all', previews: true });
      const needed = await device(ola, { level: 'important' });
      const spy = jest.spyOn(push, 'conversationEvent');

      const conversation = await Conversation.create({
        sessionId: `p2c-push-chat-${Date.now()}`,
        company: acme._id,
        metadata: { name: 'Bea' },
        messages: [{ sender: 'user', content: 'Do you deliver on Sundays?', timestamp: new Date() }]
      });
      const emit = { visitor: jest.fn(), operators: jest.fn() };

      await lifecycle.announceStart(conversation, { preview: 'Do you deliver on Sundays?', emit });
      const started = await eventually(() => sentMessages().length > 0 && sentMessages());
      expect(started).toHaveLength(1);
      expect(started[0].endpoint).toBe(everything.endpoint);
      expect(started[0].message).toMatchObject({
        title: 'New chat from Bea',
        body: 'Do you deliver on Sundays?',
        tag: `new-chat:${conversation.sessionId}`,
        url: `/admin/?section=active-chats&chat=${conversation.sessionId}`
      });

      webPush.sendNotification.mockClear();
      await lifecycle.handOver(conversation, 'visitor_request', { emit });
      const handed = await eventually(() => sentMessages().length >= 2 && sentMessages());
      expect(handed.map(item => item.endpoint).sort()).toEqual([everything.endpoint, needed.endpoint].sort());
      handed.forEach(({ message, options }) => {
        expect(message.title).toBe('Bea asked for a person');
        expect(message.tag).toBe(`handoff:${conversation.sessionId}`);
        expect(options.urgency).toBe('high');
      });
      // Without previews, nothing the visitor wrote.
      expect(handed.find(item => item.endpoint === needed.endpoint).message.body).not.toContain('Sundays');

      // Still waiting: the visitor writing again does not alert anyone twice.
      await lifecycle.handOver(conversation, 'visitor_request', { emit });
      expect(spy.mock.calls.map(call => call[0])).toEqual(['new-chat', 'handoff']);
      spy.mockRestore();
    });
  });
});
