/**
 * Tenant scoping in the service layer, and the notification fan-out.
 *
 * Two classes of bug are pinned here, both of which shipped:
 *
 *  - Scoping that failed *open*. The service layer wrote its own filter as
 *    `if (role !== 'superadmin' && companyId) { query.company = companyId }`,
 *    so a user whose company id was missing got no filter and read every
 *    tenant's documents. `companyScope` fails closed instead.
 *
 *  - Notifications sent with a bare `io.emit`, which is not a room: it reaches
 *    every socket on the platform, including website visitors with the widget
 *    open, carrying the whole notification document.
 */

const mongoose = require('mongoose');

const { companyScope } = require('../utils/query');
const TaskService = require('../services/task');
const Task = require('../models/task');
const socketManager = require('../socketManager');

// Listing a task populates its assignee, author and company, so those schemas
// have to be registered before the query runs.
require('../models/user');
require('../models/company');

describe('companyScope', () => {
  it('lets a superadmin see everything', () => {
    expect(companyScope('company-1', 'superadmin')).toEqual({});
    expect(companyScope(null, 'superadmin')).toEqual({});
  });

  it('restricts anybody else to their own company', () => {
    expect(companyScope('company-1', 'operator')).toEqual({ company: 'company-1' });
    expect(companyScope('company-1', 'company_admin')).toEqual({ company: 'company-1' });
  });

  it('shows nothing to a non-superadmin with no company', () => {
    const scope = companyScope(null, 'operator');

    // Matching an impossible condition rather than returning `{}`, which would
    // have been every tenant's documents.
    expect(scope).toEqual({ company: null, _id: { $exists: false } });
    expect(scope.company).toBeNull();
  });

  it('shows nothing when the role is unknown and there is no company', () => {
    expect(companyScope(undefined, undefined)).toEqual({
      company: null,
      _id: { $exists: false }
    });
  });
});

describe('a companyless user cannot read another tenant\'s tasks', () => {
  const service = new TaskService();
  const acme = new mongoose.Types.ObjectId();
  const globex = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
  });

  beforeEach(async () => {
    // Scoped to this suite's two companies: suites share one database and run
    // concurrently, so a blanket `deleteMany({})` deletes another suite's
    // fixtures out from under it.
    await Task.deleteMany({ company: { $in: [acme, globex] } });
    const dueDate = new Date('2026-12-01T09:00:00Z');

    await Task.create([
      { title: 'Acme task', description: 'theirs', dueDate, company: acme },
      { title: 'Globex task', description: 'not theirs', dueDate, company: globex }
    ]);
  });

  afterAll(async () => {
    await Task.deleteMany({ company: { $in: [acme, globex] } });
  });

  it('returns nothing rather than everything', async () => {
    const tasks = await service.getTasks({}, null, 'operator');

    expect(tasks).toHaveLength(0);
  });

  it('still scopes correctly for a user who does have a company', async () => {
    const tasks = await service.getTasks({}, acme, 'operator');

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Acme task');
  });

  it('still lets a superadmin see every tenant', async () => {
    const tasks = await service.getTasks({}, null, 'superadmin');

    expect(tasks).toHaveLength(2);
  });

  it('will not fetch another tenant\'s task by id', async () => {
    const globexTask = await Task.findOne({ company: globex });

    await expect(
      service.getTaskById(globexTask._id, acme, 'operator')
    ).rejects.toThrow(/not found/i);
  });
});

describe('notifications go to one person', () => {
  afterEach(() => {
    socketManager.setIo(undefined);
  });

  it('emits into that user\'s own room', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    socketManager.setIo({ to, emit: jest.fn() });

    const sent = socketManager.emitToUser('user-1', 'notification-created', { notification: {} });

    expect(sent).toBe(true);
    expect(to).toHaveBeenCalledWith('user:user-1');
    expect(emit).toHaveBeenCalledWith('notification-created', { notification: {} });
  });

  it('never touches the platform-wide broadcast', () => {
    const broadcast = jest.fn();
    const emit = jest.fn();
    socketManager.setIo({ to: jest.fn().mockReturnValue({ emit }), emit: broadcast });

    socketManager.emitToUser('user-1', 'notification-updated', {});

    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does nothing without a recipient rather than falling back to everyone', () => {
    const broadcast = jest.fn();
    socketManager.setIo({ to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: broadcast });

    expect(socketManager.emitToUser(null, 'notification-created', {})).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('reports failure rather than throwing when sockets are not up', () => {
    socketManager.setIo(undefined);

    expect(socketManager.emitToUser('user-1', 'notification-created', {})).toBe(false);
  });
});
