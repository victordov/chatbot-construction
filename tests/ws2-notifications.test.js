/**
 * Notifications: one way to raise one for a person, and a bell that pages.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Company = require('../models/company');
const User = require('../models/user');
const Notification = require('../models/notification');
const NotificationService = require('../services/notification');
const socketManager = require('../socketManager');

describe('Notifications (WS2)', () => {
  let app;
  let acme;
  let nina;
  let ninaToken;
  let emitted;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/notifications', require('../routes/notification'));

    acme = await Company.create({ name: 'WS2 Notify Acme' });
    nina = await User.create({
      username: 'ws2-notify-nina', email: 'nina@ws2notify.example',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });

    ninaToken = (await request(app)
      .post('/api/auth/login')
      .send({ username: 'ws2-notify-nina', password: 'TestPassword123!' })).body.token;
  });

  afterAll(async () => {
    await Notification.deleteMany({ userId: nina._id });
    await User.deleteMany({ email: /@ws2notify\.example$/ });
    await Company.deleteMany({ name: /^WS2 Notify / });
  });

  beforeEach(async () => {
    emitted = [];
    socketManager.setIo({
      to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) })
    });
    await Notification.deleteMany({ userId: nina._id });
  });

  describe('notifyUser', () => {
    test('stores it and pushes it to that person only', async () => {
      const notification = await NotificationService.notifyUser(nina._id, {
        type: 'chat_transferred',
        message: 'Al transferred a conversation to you',
        sessionId: 'ws2-notify-session'
      });

      expect(notification).toMatchObject({
        type: 'chat_transferred',
        sessionId: 'ws2-notify-session',
        link: '?section=active-chats&chat=ws2-notify-session',
        read: false
      });
      expect(await Notification.countDocuments({ userId: nina._id })).toBe(1);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ room: `user:${nina._id}`, event: 'notification-created' });
      expect(emitted[0].payload.notification.message).toBe('Al transferred a conversation to you');
    });

    test('a task notification links to the task', async () => {
      const taskId = new mongoose.Types.ObjectId();
      const notification = await NotificationService.notifyUser(nina._id, {
        type: 'task_assigned', message: 'You have a task', taskId
      });

      expect(notification.link).toBe(`?section=tasks&taskId=${taskId}`);
    });

    test('never throws, and says nothing when it could not store one', async () => {
      // A task notification without a task fails validation.
      await expect(NotificationService.notifyUser(nina._id, {
        type: 'task_assigned', message: 'No task'
      })).resolves.toBeNull();
      await expect(NotificationService.notifyUser(null, { type: 'chat_assigned', message: 'x' })).resolves.toBeNull();
      expect(emitted).toHaveLength(0);
    });

    test('is also on an instance, for callers holding one', async () => {
      const service = new NotificationService();
      await service.notifyUser(nina._id, { type: 'chat_assigned', message: 'A chat', sessionId: 's' });
      expect(await Notification.countDocuments({ userId: nina._id })).toBe(1);
    });
  });

  describe('the bell', () => {
    test('pages, newest first, with the unread count', async () => {
      const base = Date.now();
      await Notification.insertMany(Array.from({ length: 5 }, (_, index) => ({
        userId: nina._id,
        type: 'chat_assigned',
        message: `Chat ${index}`,
        sessionId: `s${index}`,
        read: index === 0,
        createdAt: new Date(base - index * 1000)
      })));

      const first = await request(app).get('/api/notifications?limit=3').set('x-auth-token', ninaToken);
      expect(first.status).toBe(200);
      expect(first.body.notifications.map(n => n.message)).toEqual(['Chat 0', 'Chat 1', 'Chat 2']);
      expect(first.body.hasMore).toBe(true);
      expect(first.body.unread).toBe(4);

      const before = first.body.notifications.at(-1).createdAt;
      const second = await request(app)
        .get('/api/notifications')
        .query({ limit: 3, before })
        .set('x-auth-token', ninaToken);
      expect(second.body.notifications.map(n => n.message)).toEqual(['Chat 3', 'Chat 4']);
      expect(second.body.hasMore).toBe(false);
    });

    test('a notification can be deleted', async () => {
      const notification = await NotificationService.notifyUser(nina._id, {
        type: 'chat_assigned', message: 'Delete me', sessionId: 's'
      });

      const response = await request(app)
        .delete(`/api/notifications/${notification._id}`)
        .set('x-auth-token', ninaToken);

      expect(response.status).toBe(200);
      expect(await Notification.countDocuments({ userId: nina._id })).toBe(0);
    });
  });
});
