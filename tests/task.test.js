/**
 * Tasks: the service, the routes, comments, follow-ups and activity.
 *
 * A 1,300-line UI, a service and a router, with no direct tests at all. What is
 * covered here first is tenancy - a task carries a customer's name, email and
 * phone number, so a task board that leaks across companies leaks exactly the
 * data a support desk exists to protect.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const TaskService = require('../services/task');
const Task = require('../models/task');
const Comment = require('../models/comment');
const Activity = require('../models/activity');
const Company = require('../models/company');
const User = require('../models/user');
const Conversation = require('../models/conversation');

const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

describe('Tasks', () => {
  let app;
  let service;
  let acme;
  let globex;
  let acmeAdmin;
  let acmeOperator;
  let globexOperator;
  let acmeToken;
  let globexToken;
  let superToken;

  const createTask = (company, createdBy, overrides = {}) => Task.create({
    title: 'Task Call the customer back',
    description: 'They asked about their order',
    dueDate: tomorrow(),
    company: company._id,
    createdBy: createdBy._id,
    contactInfo: { name: 'Bea', email: 'bea@example.com', phone: '07700 900123' },
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

    service = new TaskService();

    acme = await Company.create({ name: 'Acme Tasks' });
    globex = await Company.create({ name: 'Globex Tasks' });

    acmeAdmin = await User.create({
      username: 'acme-task-admin', email: 'admin@tasks.example',
      password: 'TestPassword123!', role: 'company_admin', displayName: 'Ada', company: acme._id
    });
    acmeOperator = await User.create({
      username: 'acme-task-op', email: 'op@tasks.example',
      password: 'TestPassword123!', role: 'operator', displayName: 'Ola', company: acme._id
    });
    globexOperator = await User.create({
      username: 'globex-task-op', email: 'globex@tasks.example',
      password: 'TestPassword123!', role: 'operator', displayName: 'Gus', company: globex._id
    });
    await User.create({
      username: 'task-super', email: 'super@tasks.example',
      password: 'TestPassword123!', role: 'superadmin'
    });

    const login = async (username) => (await request(app)
      .post('/api/auth/login')
      .send({ username, password: 'TestPassword123!' })).body.token;

    acmeToken = await login('acme-task-admin');
    globexToken = await login('globex-task-op');
    superToken = await login('task-super');
  });

  afterEach(async () => {
    await Task.deleteMany({ title: /^Task |^Follow-up/ });
    await Comment.deleteMany({});
    await Activity.deleteMany({});
    await Conversation.deleteMany({ sessionId: /^task-/ });
  });

  afterAll(async () => {
    await User.deleteMany({ email: /@tasks\.example$/ });
    await Company.deleteMany({ name: /Tasks$/ });
    await mongoose.connection.close();
  });

  describe('creating', () => {
    it('stamps the caller\'s company, so the board it appears on is theirs', async () => {
      const response = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', acmeToken)
        .send({ title: 'Task Ring back', description: 'About the refund', dueDate: tomorrow() });

      expect(response.status).toBe(201);

      const stored = await Task.findById(response.body.task._id);
      expect(String(stored.company)).toBe(String(acme._id));
      expect(stored.status).toBe('open');
    });

    it('cannot be pinned to another tenant\'s conversation', async () => {
      // A task links back from the conversation it names, so an id from
      // another company would attach this company's task to their transcript
      // - and, once linked, expose it to whoever opens that chat.
      const theirs = await Conversation.create({
        sessionId: 'task-globex-session', company: globex._id, messages: []
      });

      const bySession = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', acmeToken)
        .send({
          title: 'Task Sneak', description: 'Linked across tenants',
          dueDate: tomorrow(), conversationId: 'task-globex-session'
        });
      expect(bySession.status).toBe(404);

      const byId = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', acmeToken)
        .send({
          title: 'Task Sneak', description: 'Linked across tenants',
          dueDate: tomorrow(), conversationId: String(theirs._id)
        });
      expect(byId.status).toBe(404);

      expect(await Task.findOne({ title: 'Task Sneak' })).toBeNull();
      expect((await Conversation.findById(theirs._id)).tasks).toHaveLength(0);
    });

    it('cannot be assigned to somebody at another tenant', async () => {
      const response = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', acmeToken)
        .send({
          title: 'Task Misdirected', description: 'For the wrong desk',
          dueDate: tomorrow(), assignee: String(globexOperator._id)
        });

      expect(response.status).toBe(404);
      expect(await Task.findOne({ title: 'Task Misdirected' })).toBeNull();
    });

    it('cannot be made a follow-up of another tenant\'s task', async () => {
      const theirs = await createTask(globex, globexOperator, { title: 'Task Globex parent' });
      const mine = await createTask(acme, acmeAdmin, { title: 'Task Acme child' });

      const response = await request(app)
        .put(`/api/tasks/${mine._id}`)
        .set('x-auth-token', acmeToken)
        .send({ parentTaskId: String(theirs._id) });

      expect(response.status).toBe(404);
      expect((await Task.findById(mine._id)).parentTaskId).toBeUndefined();
    });

    it('refuses a task with no due date rather than creating one nobody chases', async () => {
      const response = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', acmeToken)
        .send({ title: 'Task Vague', description: 'Someday' });

      expect(response.status).toBe(400);
    });

    it('links a task raised from a chat by its session id', async () => {
      const conversation = await Conversation.create({
        sessionId: 'task-linked-session', company: acme._id, messages: []
      });

      const response = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', acmeToken)
        .send({
          title: 'Task From a chat',
          description: 'Raised mid-conversation',
          dueDate: tomorrow(),
          conversationId: 'task-linked-session'
        });

      expect(String(response.body.task.conversationId)).toBe(String(conversation._id));
      // The conversation knows about it too, so an operator opening the chat
      // sees that somebody is already on it.
      expect((await Conversation.findById(conversation._id)).tasks.map(String))
        .toContain(String(response.body.task._id));
    });

    it('records who raised it', async () => {
      const response = await request(app)
        .post('/api/tasks')
        .set('x-auth-token', acmeToken)
        .send({ title: 'Task Audited', description: 'x', dueDate: tomorrow() });

      const activities = await Activity.find({ taskId: response.body.task._id });
      expect(activities.map(a => a.type)).toContain('task_created');
    });
  });

  describe('reading', () => {
    it('shows a company only its own tasks', async () => {
      await createTask(acme, acmeAdmin);
      await createTask(globex, globexOperator, { title: 'Task Globex private' });

      const response = await request(app).get('/api/tasks').set('x-auth-token', acmeToken);

      expect(response.body.tasks.map(t => t.title)).not.toContain('Task Globex private');
      expect(response.body.tasks).toHaveLength(1);
    });

    it('answers 404, not 500, for another company\'s task', async () => {
      const task = await createTask(acme, acmeAdmin);

      const response = await request(app)
        .get(`/api/tasks/${task._id}`)
        .set('x-auth-token', globexToken);

      // A probe for a neighbour's task and a typo have to be indistinguishable,
      // and a 500 says "this id exists but something went wrong".
      expect(response.status).toBe(404);
    });

    it('lets a superadmin see across tenants, because somebody has to', async () => {
      await createTask(acme, acmeAdmin);
      await createTask(globex, globexOperator, { title: 'Task Globex private' });

      const response = await request(app).get('/api/tasks').set('x-auth-token', superToken);

      expect(response.body.tasks.length).toBeGreaterThanOrEqual(2);
    });

    it('marks which tasks have follow-ups without a query per row', async () => {
      const parent = await createTask(acme, acmeAdmin);
      await createTask(acme, acmeAdmin, { title: 'Follow-up chase', parentTaskId: parent._id });

      const tasks = await service.getTasks({}, String(acme._id), 'company_admin');
      const listed = tasks.find(task => String(task._id) === String(parent._id));

      expect(listed.hasFollowUps).toBe(true);
    });

    it('treats a regex in a search as text, not as a pattern', async () => {
      await createTask(acme, acmeAdmin, { title: 'Task .*' });
      await createTask(acme, acmeAdmin, { title: 'Task ordinary' });

      const results = await service.searchTasks('.*', String(acme._id), 'company_admin');

      expect(results.map(t => t.title)).toEqual(['Task .*']);
    });

    it('shows nothing to an account with no company rather than everything', async () => {
      await createTask(acme, acmeAdmin);

      // Failing open here is the classic multi-tenant accident: an operator
      // whose company is missing would otherwise read every tenant's tasks.
      const tasks = await service.getTasks({}, null, 'operator');

      expect(tasks).toHaveLength(0);
    });
  });

  describe('updating', () => {
    it('timestamps completion and records the change', async () => {
      const task = await createTask(acme, acmeAdmin);

      const response = await request(app)
        .put(`/api/tasks/${task._id}`)
        .set('x-auth-token', acmeToken)
        .send({ status: 'completed' });

      expect(response.status).toBe(200);

      const stored = await Task.findById(task._id);
      expect(stored.completedAt).toBeInstanceOf(Date);

      const actions = (await Activity.find({ taskId: task._id })).map(a => a.type);
      expect(actions).toEqual(expect.arrayContaining(['status_changed', 'task_completed']));
    });

    it('will not let another company touch a task', async () => {
      const task = await createTask(acme, acmeAdmin);

      const response = await request(app)
        .put(`/api/tasks/${task._id}`)
        .set('x-auth-token', globexToken)
        .send({ title: 'Task Renamed by a stranger' });

      expect(response.status).toBe(404);
      expect((await Task.findById(task._id)).title).toBe('Task Call the customer back');
    });

    it('refuses to hand work to somebody at another company', async () => {
      const task = await createTask(acme, acmeAdmin);

      const response = await request(app)
        .post(`/api/tasks/${task._id}/assign`)
        .set('x-auth-token', acmeToken)
        .send({ userId: String(globexOperator._id), userName: 'Gus' });

      // The task carries a customer's phone number; assigning it out of the
      // tenant hands that over with it.
      expect(response.status).toBe(404);
      expect((await Task.findById(task._id)).assignee).toBeUndefined();
    });

    it('assigns within the company', async () => {
      const task = await createTask(acme, acmeAdmin);

      const response = await request(app)
        .post(`/api/tasks/${task._id}/assign`)
        .set('x-auth-token', acmeToken)
        .send({ userId: String(acmeOperator._id), userName: 'Ola' });

      expect(response.status).toBe(200);
      expect(String((await Task.findById(task._id)).assignee)).toBe(String(acmeOperator._id));
    });
  });

  describe('deleting', () => {
    it('removes the task and unlinks it from its conversation', async () => {
      const conversation = await Conversation.create({
        sessionId: 'task-delete-session', company: acme._id, messages: []
      });
      const task = await createTask(acme, acmeAdmin, { conversationId: conversation._id });
      await Conversation.findByIdAndUpdate(conversation._id, { $push: { tasks: task._id } });

      const response = await request(app)
        .delete(`/api/tasks/${task._id}`)
        .set('x-auth-token', acmeToken);

      expect(response.status).toBe(200);
      expect(await Task.findById(task._id)).toBeNull();
      expect((await Conversation.findById(conversation._id)).tasks).toHaveLength(0);
    });

    it('records who deleted it, which is the trace most worth having', async () => {
      const task = await createTask(acme, acmeAdmin);

      await request(app).delete(`/api/tasks/${task._id}`).set('x-auth-token', acmeToken);

      const activity = await Activity.findOne({ taskId: task._id, type: 'task_deleted' });
      expect(activity).not.toBeNull();
      expect(activity.userName).toBe('Ada');
    });

    it('will not delete another company\'s task', async () => {
      const task = await createTask(acme, acmeAdmin);

      const response = await request(app)
        .delete(`/api/tasks/${task._id}`)
        .set('x-auth-token', globexToken);

      expect(response.status).toBe(404);
      expect(await Task.findById(task._id)).not.toBeNull();
    });
  });

  describe('comments', () => {
    it('records the author\'s display name, not their username', async () => {
      const task = await createTask(acme, acmeAdmin);

      const response = await request(app)
        .post(`/api/tasks/${task._id}/comments`)
        .set('x-auth-token', acmeToken)
        .send({ content: 'Left a voicemail' });

      expect(response.status).toBe(201);
      expect(response.body.comment.authorName).toBe('Ada');
    });

    it('are closed to another company, thread and all', async () => {
      const task = await createTask(acme, acmeAdmin);
      await request(app)
        .post(`/api/tasks/${task._id}/comments`)
        .set('x-auth-token', acmeToken)
        .send({ content: 'Customer said their card was declined' });

      const read = await request(app)
        .get(`/api/tasks/${task._id}/comments`)
        .set('x-auth-token', globexToken);
      const write = await request(app)
        .post(`/api/tasks/${task._id}/comments`)
        .set('x-auth-token', globexToken)
        .send({ content: 'hello' });

      expect(read.status).toBe(404);
      expect(write.status).toBe(404);
    });

    it('refuses an empty comment', async () => {
      const task = await createTask(acme, acmeAdmin);

      const response = await request(app)
        .post(`/api/tasks/${task._id}/comments`)
        .set('x-auth-token', acmeToken)
        .send({ content: '' });

      expect(response.status).toBe(400);
    });
  });

  describe('follow-ups', () => {
    it('inherits the parent\'s company, conversation and contact', async () => {
      const conversation = await Conversation.create({
        sessionId: 'task-followup-session', company: acme._id, messages: []
      });
      const parent = await createTask(acme, acmeAdmin, { conversationId: conversation._id });

      const response = await request(app)
        .post(`/api/tasks/${parent._id}/follow-ups`)
        .set('x-auth-token', acmeToken)
        .send({ title: 'Follow-up ring again', description: 'No answer', dueDate: tomorrow() });

      expect(response.status).toBe(201);

      const stored = await Task.findById(response.body.task._id);
      expect(String(stored.company)).toBe(String(acme._id));
      expect(String(stored.conversationId)).toBe(String(conversation._id));
      expect(stored.contactInfo.email).toBe('bea@example.com');
    });

    it('cannot be hung off another company\'s task', async () => {
      const parent = await createTask(acme, acmeAdmin);

      const response = await request(app)
        .post(`/api/tasks/${parent._id}/follow-ups`)
        .set('x-auth-token', globexToken)
        .send({ title: 'Follow-up from a stranger', description: 'x', dueDate: tomorrow() });

      // A follow-up inherits its parent's company, so allowing this would let
      // one tenant write a task into another tenant's board - and read the
      // parent's contact details on the way, since they are inherited too.
      expect(response.status).toBe(404);
      expect(await Task.findOne({ title: 'Follow-up from a stranger' })).toBeNull();
    });

    it('says a missing parent is missing rather than failing', async () => {
      const response = await request(app)
        .post(`/api/tasks/${new mongoose.Types.ObjectId()}/follow-ups`)
        .set('x-auth-token', acmeToken)
        .send({ title: 'Follow-up orphan', description: 'x', dueDate: tomorrow() });

      expect(response.status).toBe(404);
    });

    it('lists a parent\'s follow-ups', async () => {
      const parent = await createTask(acme, acmeAdmin);
      await createTask(acme, acmeAdmin, { title: 'Follow-up one', parentTaskId: parent._id });

      const response = await request(app)
        .get(`/api/tasks/${parent._id}/follow-ups`)
        .set('x-auth-token', acmeToken);

      expect(response.body.tasks).toHaveLength(1);
    });
  });

  describe('access', () => {
    it('is closed to a request with no token', async () => {
      const response = await request(app).get('/api/tasks');
      expect(response.status).toBe(401);
    });
  });
});
