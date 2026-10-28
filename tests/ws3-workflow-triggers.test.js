/**
 * Which live workflow answers a message.
 *
 * A published workflow used to answer every message the bot got, so
 * publishing "where is my order?" stopped the bot answering anything else from
 * the knowledge base. Each workflow now has a trigger, and these pin down the
 * order they are tried in and when a conversation stays in one.
 */

const mongoose = require('mongoose');

const Company = require('../models/company');
const Workflow = require('../models/workflow');
const WorkflowVersion = require('../models/workflow-version');
const User = require('../models/user');
const runtimeRegistry = require('../services/runtime-registry');
const reply = require('../services/reply');
const workflowService = require('../services/workflow');
const { getIntentClassifier, IntentClassifier } = require('../services/intent-classifier');

const persona = () => ({
  id: 'p1', type: 'persona', position: { x: 0, y: 0 }, data: { type: 'persona', prompt: 'You are the Wst bot.' }
});

const replyGraph = text => ({
  nodes: [persona(),
    { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start' } },
    { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { type: 'response', template: text } }],
  edges: [{ id: 'e1', source: 's1', target: 'r1' }]
});

const askGraph = (question, variable, then) => ({
  nodes: [persona(),
    { id: 'a1', type: 'ask', position: { x: 0, y: 0 }, data: { type: 'ask', question, variable, validate: 'any' } },
    { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { type: 'response', template: then } }],
  edges: [{ id: 'e1', source: 'a1', target: 'r1', sourceHandle: 'next' }]
});

describe('choosing a workflow by trigger (WS3)', () => {
  let company;
  let admin;

  const publish = async (name, graph, trigger) => {
    const compiled = await workflowService.compileWorkflow(graph, String(company._id));
    const clean = workflowService.cleanTrigger(trigger);
    return Workflow.create({
      name, ...graph, trigger: clean, liveTrigger: clean, liveVersion: 1, compiledChain: compiled,
      company: company._id, createdBy: admin._id, status: 'published', publishedAt: new Date()
    });
  };

  const conversation = () => ({
    _id: new mongoose.Types.ObjectId(), company: company._id, sessionId: 'wst', workflowState: {}
  });

  const cleanUp = async () => {
    const companies = await Company.find({ name: /^Wst / }).select('_id');
    const ids = companies.map(c => c._id);
    const workflows = await Workflow.find({ company: { $in: ids } }).select('_id');
    await WorkflowVersion.deleteMany({ workflowId: { $in: workflows.map(w => w._id) } });
    await Workflow.deleteMany({ company: { $in: ids } });
    await User.deleteMany({ email: /@wst\.example$/ });
    await Company.deleteMany({ _id: { $in: ids } });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    await cleanUp();
    company = await Company.create({ name: 'Wst Shop' });
    admin = await User.create({
      username: 'wst-admin', email: 'admin@wst.example', password: 'TestPassword123!',
      role: 'company_admin', displayName: 'Wst Admin', company: company._id
    });
  });

  afterAll(async () => {
    runtimeRegistry.reset();
    await cleanUp();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    runtimeRegistry.reset();
    await Workflow.deleteMany({ company: company._id });
  });

  test('keywords match whole words, ignoring case; other messages go to the assistant', async () => {
    await publish('Wst refunds', replyGraph('Refund flow'), { type: 'keywords', keywords: ['refund', 'money back'] });

    expect((await reply.generate({ conversation: conversation(), message: 'I want a REFUND please' })).text).toBe('Refund flow');
    expect((await reply.generate({ conversation: conversation(), message: 'can I have my money back?' })).text).toBe('Refund flow');

    // "refunded" is not the word "refund", and opening hours are not refunds.
    const other = await reply.generate({ conversation: conversation(), message: 'I was refunded, thanks' });
    expect(other.source).toBe('assistant');
    expect((await reply.generate({ conversation: conversation(), message: 'what are your hours?' })).source).toBe('assistant');

    expect(reply.matchesKeywords('Where is my order #123?', ['order'])).toBe(true);
    expect(reply.matchesKeywords('reordered', ['order'])).toBe(false);
  });

  test('intent workflows are decided in one classifier call with every description', async () => {
    await publish('Wst orders', replyGraph('Order flow'), { type: 'intent', description: 'where is my order' });
    await publish('Wst booking', replyGraph('Booking flow'), { type: 'intent', description: 'book, change or cancel an appointment' });

    const pick = jest.spyOn(getIntentClassifier(), 'pickWorkflow')
      .mockResolvedValueOnce({ index: 1, via: 'model' })
      .mockResolvedValueOnce({ index: null, via: 'model' });

    expect((await reply.generate({ conversation: conversation(), message: 'can I move my appointment?' })).text)
      .toBe('Booking flow');
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick.mock.calls[0][1]).toEqual(['where is my order', 'book, change or cancel an appointment']);

    // None fits: the assistant answers.
    expect((await reply.generate({ conversation: conversation(), message: 'do you sell gift cards?' })).source)
      .toBe('assistant');
  });

  test('keywords win before any classifier call, and the always workflow catches the rest', async () => {
    await publish('Wst desk', replyGraph('Front desk'), { type: 'always' });
    await publish('Wst orders', replyGraph('Order flow'), { type: 'intent', description: 'where is my order' });
    await publish('Wst refunds', replyGraph('Refund flow'), { type: 'keywords', keywords: ['refund'] });

    const pick = jest.spyOn(getIntentClassifier(), 'pickWorkflow').mockResolvedValue({ index: null, via: 'model' });

    expect((await reply.generate({ conversation: conversation(), message: 'refund' })).text).toBe('Refund flow');
    expect(pick).not.toHaveBeenCalled();

    expect((await reply.generate({ conversation: conversation(), message: 'hello' })).text).toBe('Front desk');
    expect(pick).toHaveBeenCalledTimes(1);
  });

  test('a conversation part-way through a workflow stays in it, whatever the message says', async () => {
    const orders = await publish('Wst ask', askGraph('What is your order number?', 'order_id', 'Looking up {{order_id}}.'),
      { type: 'keywords', keywords: ['order'] });
    await publish('Wst refunds', replyGraph('Refund flow'), { type: 'keywords', keywords: ['refund'] });

    const convo = conversation();
    expect((await reply.generate({ conversation: convo, message: 'where is my order' })).text).toBe('What is your order number?');
    expect(String(convo.workflowState.workflowId)).toBe(String(orders._id));

    // "refund" would trigger the other workflow, but this is the answer.
    expect((await reply.generate({ conversation: convo, message: 'refund-123' })).text).toBe('Looking up refund-123.');
    expect(convo.workflowState.awaiting).toBeNull();
  });

  test('a workflow that finished does not hold the conversation', async () => {
    await publish('Wst ask', askGraph('Order number?', 'order_id', 'Thanks.'), { type: 'keywords', keywords: ['order'] });

    const convo = conversation();
    await reply.generate({ conversation: convo, message: 'my order' });
    await reply.generate({ conversation: convo, message: 'A-1' });
    expect(convo.workflowState.awaiting).toBeNull();

    // Finished: the next unrelated message goes to the assistant, not back
    // into the order flow.
    expect((await reply.generate({ conversation: convo, message: 'what are your hours?' })).source).toBe('assistant');
  });

  test('a workflow reporting a failed step falls back to the assistant and clears the state', async () => {
    await publish('Wst desk', askGraph('Order?', 'order_id', 'Thanks.'), { type: 'always' });
    const convo = conversation();
    await reply.generate({ conversation: convo, message: 'hi' });
    expect(convo.workflowState.awaiting).not.toBeNull();

    jest.spyOn(runtimeRegistry.getRuntimeService().compiler, 'executeWorkflow')
      .mockResolvedValueOnce({ success: false, error: 'The model could not be reached', response: null });

    const result = await reply.generate({ conversation: convo, message: 'A-1' });
    expect(result.source).toBe('assistant');
    expect(convo.workflowState.awaiting).toBeNull();
  });

  describe('the classifier', () => {
    test('asks a chat model once, and reads its number', async () => {
      const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: '2' } }] });
      const classifier = new IntentClassifier({ openai: { chat: { completions: { create } } } });

      const result = await classifier.pickWorkflow('my parcel never came', ['book an appointment', 'where is my order']);
      expect(result).toEqual({ index: 1, via: 'model' });
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].messages[0].content).toMatch(/1\. book an appointment\n2\. where is my order/);
    });

    test('"0" means none, and a failing model falls back to comparing phrases without throwing', async () => {
      const none = new IntentClassifier({
        openai: { chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content: '0' } }] }) } } }
      });
      expect(await none.pickWorkflow('hello', ['where is my order'])).toEqual({ index: null, via: 'model' });

      const broken = new IntentClassifier({
        openai: { chat: { completions: { create: jest.fn().mockRejectedValue(new Error('timeout')) } } }
      });
      const result = await broken.pickWorkflow('where is my order', ['where is my order', 'make a complaint']);
      expect(result.via).toBe('embeddings');
      expect(result.index).toBe(0);
    });
  });
});
