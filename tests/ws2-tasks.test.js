/**
 * Tasks: reassignment, follow-ups that know their parent, comments that can be
 * edited and deleted, admins as assignees, paging, and filters that combine.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Task = require('../models/task');
const Comment = require('../models/comment');
const Activity = require('../models/activity');
const Company = require('../models/company');
const User = require('../models/user');
const Notification = require('../models/notification');
const webhookService = require('../services/webhooks');
const socketManager = require('../socketManager');

const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

/** Notifications are written after the response goes; wait for one to land. */
const eventually = async (find, timeout = 2000) => {
  const until = Date.now() + timeout;
  let found = await find();
  while (!found && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 50));
    found = await find();
  }
  return found;
};

describe('Tasks (WS2)', () => {
  let app;
  let acme;
  let globex;
  let ada;
  let ola;
  let otto;
  let gus;
  let adaToken;
  let olaToken;
  let ottoToken;
  let dispatch;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  const createTask = (overrides = {}) => Task.create({
    title: 'Ring the customer',
    description: 'About the order',
    dueDate: tomorrow(),
    company: acme._id,
    createdBy: ada._id,
    ...overrides
  });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/tasks', require('../routes/task'));

    acme = await Company.create({ name: 'WS2 Tasks Acme' });
    globex = await Company.create({ name: 'WS2 Tasks Globex' });

    ada = await User.create({
      username: 'ws2-task-ada', email: 'ada@ws2tasks.example', displayName: 'Ada',
      password: 'TestPassword123!', role: 'company_admin', company: acme._id
    });
    ola = await User.create({
      username: 'ws2-task-ola', email: 'ola@ws2tasks.example', displayName: 'Ola',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });
    otto = await User.create({
      username: 'ws2-task-otto', email: 'otto@ws2tasks.example', displayName: 'Otto',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });
    gus = await User.create({
      username: 'ws2-task-gus', email: 'gus@ws2tasks.example',
      password: 'TestPassword123!', role: 'operator', company: globex._id
    });

    adaToken = await login('ws2-task-ada');
    olaToken = await login('ws2-task-ola');
    ottoToken = await login('ws2-task-otto');
  });

  afterAll(async () => {
    const tasks = await Task.find({ company: { $in: [acme._id, globex._id] } }).select('_id');
    await Comment.deleteMany({ taskId: { $in: tasks.map(task => task._id) } });
    await Activity.deleteMany({ taskId: { $in: tasks.map(task => task._id) } });
    await Task.deleteMany({ company: { $in: [acme._id, globex._id] } });
    await Notification.deleteMany({ userId: { $in: [ada._id, ola._id, otto._id, gus._id] } });
    await User.deleteMany({ email: /@ws2tasks\.example$/ });
    await Company.deleteMany({ name: /^WS2 Tasks / });
  });

  beforeEach(async () => {
    socketManager.setIo({ to: () => ({ emit: () => {} }) });
    dispatch = jest.spyOn(webhookService, 'dispatch').mockResolvedValue();
    await Task.deleteMany({ company: { $in: [acme._id, globex._id] } });
    await Notification.deleteMany({ userId: { $in: [ada._id, ola._id, otto._id] } });
  });

  afterEach(() => dispatch.mockRestore());

  describe('creating', () => {
    test('links a follow-up to its parent', async () => {
      const parent = await createTask();

      const response = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', olaToken)
        .send({ title: 'Ring again', description: 'No answer', dueDate: '2030-01-15', parentTaskId: String(parent._id) });

      expect(response.status).toBe(201);
      const stored = await Task.findById(response.body.task._id);
      expect(String(stored.parentTaskId)).toBe(String(parent._id));
      expect(await Activity.findOne({ taskId: parent._id, type: 'follow_up_created' })).not.toBeNull();
    });

    test('refuses a parent from another company', async () => {
      const foreign = await Task.create({
        title: 'Globex task', description: 'x', dueDate: tomorrow(), company: globex._id, createdBy: gus._id
      });

      const response = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', olaToken)
        .send({ title: 'Sneaky', description: 'x', dueDate: '2030-01-15', parentTaskId: String(foreign._id) });

      expect(response.status).toBe(404);
      expect(await Task.findOne({ title: 'Sneaky' })).toBeNull();
    });

    test('a bare date is that calendar day everywhere', async () => {
      const response = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', olaToken)
        .send({ title: 'Dated', description: 'x', dueDate: '2030-01-15' });

      expect(new Date(response.body.task.dueDate).toISOString()).toBe('2030-01-15T12:00:00.000Z');
    });

    test('an admin can be given a task, and is told', async () => {
      const response = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', olaToken)
        .send({ title: 'For the admin', description: 'x', dueDate: '2030-01-15', assignee: String(ada._id) });

      expect(response.status).toBe(201);
      const notification = await eventually(() => Notification.findOne({ userId: ada._id, type: 'task_assigned' }));
      expect(notification).not.toBeNull();
      expect(String(notification.taskId)).toBe(response.body.task._id);
      expect(notification.message).toMatch(/Ola created a task for you/);
    });

    test('creating a task for yourself does not notify you', async () => {
      await request(app)
        .post('/api/tasks')
        .set('x-auth-token', olaToken)
        .send({ title: 'Mine', description: 'x', dueDate: '2030-01-15', assignee: String(ola._id) });

      await new Promise(resolve => setTimeout(resolve, 300));
      expect(await Notification.countDocuments({ userId: ola._id })).toBe(0);
    });

    test('fires task.created for a task a person raised', async () => {
      const response = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', olaToken)
        .send({ title: 'Webhooked', description: 'x', dueDate: '2030-01-15' });

      expect(dispatch).toHaveBeenCalledWith(
        expect.anything(),
        'task.created',
        expect.objectContaining({ taskId: response.body.task._id, raisedBy: 'operator' })
      );
    });

    test('fires task.created for a follow-up too', async () => {
      const parent = await createTask();

      await request(app)
        .post(`/api/tasks/${parent._id}/follow-ups`)
        .set('x-auth-token', olaToken)
        .send({ title: 'Follow', description: 'x', dueDate: '2030-01-15' })
        .expect(201);

      expect(dispatch.mock.calls.map(call => call[1])).toContain('task.created');
    });
  });

  describe('reassigning', () => {
    test('actually changes the assignee, and tells the new one', async () => {
      const task = await createTask({ assignee: ola._id, assigneeName: 'Ola' });

      const response = await request(app)
        .put(`/api/tasks/${task._id}`)
        .set('x-auth-token', olaToken)
        .send({ assignee: String(otto._id) });

      expect(response.status).toBe(200);
      const stored = await Task.findById(task._id);
      expect(String(stored.assignee)).toBe(String(otto._id));
      expect(stored.assigneeName).toBe('Otto');
      expect(await eventually(() => Notification.findOne({ userId: otto._id, type: 'task_assigned' }))).not.toBeNull();
      expect(await Activity.findOne({ taskId: task._id, type: 'task_assigned' })).not.toBeNull();
    });

    test('an empty assignee means nobody', async () => {
      const task = await createTask({ assignee: ola._id, assigneeName: 'Ola' });

      await request(app)
        .put(`/api/tasks/${task._id}`)
        .set('x-auth-token', olaToken)
        .send({ assignee: '' })
        .expect(200);

      const stored = await Task.findById(task._id);
      expect(stored.assignee).toBeNull();
      expect(stored.assigneeName).toBeNull();
    });

    test('leaving the assignee out leaves it alone', async () => {
      const task = await createTask({ assignee: ola._id, assigneeName: 'Ola' });

      await request(app)
        .put(`/api/tasks/${task._id}`)
        .set('x-auth-token', olaToken)
        .send({ title: 'Renamed' })
        .expect(200);

      expect(String((await Task.findById(task._id)).assignee)).toBe(String(ola._id));
    });

    test('refuses somebody at another company', async () => {
      const task = await createTask({ assignee: ola._id });

      const response = await request(app)
        .put(`/api/tasks/${task._id}`)
        .set('x-auth-token', olaToken)
        .send({ assignee: String(gus._id) });

      expect(response.status).toBe(404);
      expect(String((await Task.findById(task._id)).assignee)).toBe(String(ola._id));
    });
  });

  describe('listing', () => {
    test('the assignee list has admins and operators of the company only', async () => {
      const response = await request(app).get('/api/tasks/assignees').set('x-auth-token', olaToken);

      expect(response.status).toBe(200);
      const names = response.body.assignees.map(person => person.username);
      expect(names).toEqual(expect.arrayContaining(['ws2-task-ada', 'ws2-task-ola', 'ws2-task-otto']));
      expect(names).not.toContain('ws2-task-gus');
    });

    test('pages instead of stopping silently', async () => {
      await Task.insertMany(Array.from({ length: 7 }, (_, index) => ({
        title: `Paged ${index}`, description: 'x', dueDate: tomorrow(), company: acme._id
      })));

      const first = await request(app).get('/api/tasks?limit=5&page=1').set('x-auth-token', olaToken);
      const second = await request(app).get('/api/tasks?limit=5&page=2').set('x-auth-token', olaToken);

      expect(first.body.tasks).toHaveLength(5);
      expect(second.body.tasks).toHaveLength(2);
      expect(first.body.pagination).toMatchObject({ total: 7, totalPages: 2, page: 1 });
    });

    test('search keeps the other filters', async () => {
      await createTask({ title: 'Refund Ola open', assignee: ola._id });
      await createTask({ title: 'Refund Ola done', assignee: ola._id, status: 'completed' });
      await createTask({ title: 'Refund Otto open', assignee: otto._id });

      const response = await request(app)
        .get('/api/tasks')
        .query({ search: 'refund', status: 'open', assignee: 'me' })
        .set('x-auth-token', olaToken);

      expect(response.body.tasks.map(task => task.title)).toEqual(['Refund Ola open']);
    });

    test('unassigned and overdue views', async () => {
      const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await createTask({ title: 'Nobody has it' });
      await createTask({ title: 'Late', assignee: ola._id, dueDate: yesterday });
      await createTask({ title: 'Late but done', assignee: ola._id, dueDate: yesterday, status: 'completed' });
      await Task.create({
        title: 'From the bot', description: 'x', dueDate: tomorrow(), company: acme._id, createdByBot: true
      });

      const unassigned = await request(app).get('/api/tasks?assignee=unassigned').set('x-auth-token', olaToken);
      const overdue = await request(app).get('/api/tasks?overdue=true').set('x-auth-token', olaToken);

      expect(unassigned.body.tasks.map(task => task.title).sort()).toEqual(['From the bot', 'Nobody has it']);
      expect(unassigned.body.tasks.find(task => task.title === 'From the bot').createdByBot).toBe(true);
      expect(overdue.body.tasks.map(task => task.title)).toEqual(['Late']);
    });
  });

  describe('activity', () => {
    test('a company user can read their own task\'s history', async () => {
      const task = await createTask();
      await request(app)
        .put(`/api/tasks/${task._id}`)
        .set('x-auth-token', olaToken)
        .send({ status: 'in_progress' })
        .expect(200);

      const response = await request(app)
        .get(`/api/tasks/${task._id}/activities`)
        .set('x-auth-token', olaToken);

      // It answered "access denied" to everybody but a superadmin.
      expect(response.status).toBe(200);
      expect(response.body.activities.map(activity => activity.type)).toContain('status_changed');
    });
  });

  describe('comments', () => {
    let task;
    let commentId;

    beforeEach(async () => {
      task = await createTask();
      const response = await request(app)
        .post(`/api/tasks/${task._id}/comments`)
        .set('x-auth-token', olaToken)
        .send({ content: 'Left a voicemail' });
      commentId = response.body.comment._id;
    });

    test('the author can edit theirs', async () => {
      const response = await request(app)
        .put(`/api/tasks/${task._id}/comments/${commentId}`)
        .set('x-auth-token', olaToken)
        .send({ content: 'Left two voicemails' });

      expect(response.status).toBe(200);
      expect(response.body.comment).toMatchObject({ content: 'Left two voicemails', isEdited: true });
    });

    test('a colleague cannot edit or delete it', async () => {
      const edit = await request(app)
        .put(`/api/tasks/${task._id}/comments/${commentId}`)
        .set('x-auth-token', ottoToken)
        .send({ content: 'Not mine' });
      const remove = await request(app)
        .delete(`/api/tasks/${task._id}/comments/${commentId}`)
        .set('x-auth-token', ottoToken);

      expect(edit.status).toBe(403);
      expect(remove.status).toBe(403);
    });

    test('the author can delete theirs, and an admin can tidy up', async () => {
      const own = await request(app)
        .delete(`/api/tasks/${task._id}/comments/${commentId}`)
        .set('x-auth-token', olaToken);
      expect(own.status).toBe(200);

      const another = await request(app)
        .post(`/api/tasks/${task._id}/comments`)
        .set('x-auth-token', olaToken)
        .send({ content: 'Second' });
      const byAdmin = await request(app)
        .delete(`/api/tasks/${task._id}/comments/${another.body.comment._id}`)
        .set('x-auth-token', adaToken);

      expect(byAdmin.status).toBe(200);
      expect(await Comment.countDocuments({ taskId: task._id })).toBe(0);
    });

    test('a comment cannot be reached through a different task', async () => {
      const other = await createTask({ title: 'Other' });

      const response = await request(app)
        .put(`/api/tasks/${other._id}/comments/${commentId}`)
        .set('x-auth-token', olaToken)
        .send({ content: 'Moved?' });

      expect(response.status).toBe(404);
    });

    test('an unknown comment is a 404, not a 500', async () => {
      const response = await request(app)
        .delete(`/api/tasks/${task._id}/comments/${new mongoose.Types.ObjectId()}`)
        .set('x-auth-token', olaToken);

      expect(response.status).toBe(404);
    });
  });
});
