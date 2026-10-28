/**
 * Saved test questions: /api/bot/tests.
 *
 * A test is a question plus what a good answer looks like. These check the
 * verdicts (mentions, hands over, cites), that a run goes through the same
 * read-only path as "Test your bot" and leaves nothing behind but the result,
 * the 50-per-company cap, and that one tenant cannot see or touch another's.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Usage = require('../models/usage');
const TestCase = require('../models/test-case');
const AIService = require('../services/ai');
const testCases = require('../services/test-cases');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/bot', require('../routes/bot'));
  return app;
};

/**
 * An assistant that answers from a table, and reports the flags the reply
 * contract reads (lastFailed, lastUnanswered) the way the AI service does.
 */
function stubAssistant(answers) {
  return jest.spyOn(AIService, 'forCompany').mockImplementation(async () => ({
    openai: null,
    async generateResponse(message) {
      const answer = answers[message] || { text: 'I am not sure.', unanswered: true };
      this.lastPath = answer.path || 'assistant';
      this.lastSources = answer.sources || [];
      this.lastFailed = Boolean(answer.failed);
      this.lastUnanswered = Boolean(answer.unanswered);
      return answer.failed ? null : answer.text;
    }
  }));
}

describe('saved tests', () => {
  describe('verdicts', () => {
    const spec = (type, value = '') => ({ expect: { type, value } });

    test('contains: case and spacing do not matter', () => {
      expect(testCases.evaluate(spec('contains', '30  Days'), { text: 'Returns within 30 days of delivery.' }))
        .toMatchObject({ passed: true });
      expect(testCases.evaluate(spec('contains', '£25'), { text: 'Kettles cost £30.' }))
        .toEqual({ passed: false, reason: 'Does not mention "£25"' });
    });

    test('handover: handing over, or being unable to answer, passes; answering does not', () => {
      expect(testCases.evaluate(spec('handover'), { text: 'One moment.', escalate: { enabled: true } }).passed).toBe(true);
      expect(testCases.evaluate(spec('handover'), { text: null, failed: true }).passed).toBe(true);
      expect(testCases.evaluate(spec('handover'), { text: 'I do not know.', unanswered: true }).passed).toBe(true);
      expect(testCases.evaluate(spec('handover'), { text: 'Sure, here is how.' }))
        .toEqual({ passed: false, reason: 'Answered by itself instead of handing over' });
    });

    test('cites: a named source by title or address, or any source when none is named', () => {
      const sources = [{ title: 'Delivery policy', url: 'https://shop.test/delivery' }];
      expect(testCases.evaluate(spec('cites', 'delivery'), { text: 'x', sources }).passed).toBe(true);
      expect(testCases.evaluate(spec('cites', 'shop.test/delivery'), { text: 'x', sources }).passed).toBe(true);
      expect(testCases.evaluate(spec('cites', 'returns'), { text: 'x', sources }).passed).toBe(false);
      expect(testCases.evaluate(spec('cites'), { text: 'x', sources }).passed).toBe(true);
      expect(testCases.evaluate(spec('cites'), { text: 'x', sources: [] }).passed).toBe(false);
    });
  });

  describe('the endpoints', () => {
    let app;
    let company;
    let other;
    let adminToken;
    let operatorToken;
    let otherToken;

    const login = async username => (await request(app)
      .post('/api/auth/login')
      .send({ username, password: 'TestPassword123!' })).body.token;

    const call = (method, url, body, token = adminToken) =>
      request(app)[method](`/api/bot${url}`).set('x-auth-token', token).send(body);

    beforeAll(async () => {
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGODB_TEST_URI);
      }
      app = buildApp();
      company = await Company.create({ name: 'Tests Co' });
      other = await Company.create({ name: 'Tests Other' });

      await User.create([
        { username: 'tests-admin', email: 'admin@tests.test', password: 'TestPassword123!', role: 'company_admin', company: company._id, displayName: 'Admin' },
        { username: 'tests-op', email: 'op@tests.test', password: 'TestPassword123!', role: 'operator', company: company._id, displayName: 'Op' },
        { username: 'tests-other', email: 'other@tests.test', password: 'TestPassword123!', role: 'company_admin', company: other._id, displayName: 'Other' }
      ]);

      adminToken = await login('tests-admin');
      operatorToken = await login('tests-op');
      otherToken = await login('tests-other');
    });

    beforeEach(async () => {
      await TestCase.deleteMany({ company: { $in: [company._id, other._id] } });
    });

    afterEach(() => jest.restoreAllMocks());

    afterAll(async () => {
      await Promise.all([
        User.deleteMany({ email: /@tests\.test$/ }),
        Company.deleteMany({ _id: { $in: [company._id, other._id] } }),
        TestCase.deleteMany({ company: { $in: [company._id, other._id] } }),
        Usage.deleteMany({ company: { $in: [company._id, other._id] } })
      ]);
    });

    test('save, list, edit and delete a test', async () => {
      const created = await call('post', '/tests', {
        question: 'How much is a kettle?', expect: { type: 'contains', value: '£25' }
      });
      expect(created.status).toBe(201);
      expect(created.body.test).toMatchObject({
        question: 'How much is a kettle?', expect: { type: 'contains', value: '£25' }, lastRun: null
      });
      const id = created.body.test.id;

      const listed = await call('get', '/tests');
      expect(listed.body).toMatchObject({ limit: 50, tests: [{ id, question: 'How much is a kettle?' }] });

      await TestCase.updateOne({ _id: id }, { $set: { lastRun: { passed: true, answer: 'x', at: new Date() } } });
      const edited = await call('put', `/tests/${id}`, { question: 'Can I talk to someone?', expect: { type: 'handover', value: 'ignored' } });
      expect(edited.status).toBe(200);
      // A handover test has nothing to look for, and the old result was for another test.
      expect(edited.body.test).toMatchObject({ expect: { type: 'handover', value: '' }, lastRun: null });

      expect((await call('delete', `/tests/${id}`)).status).toBe(200);
      expect(await TestCase.countDocuments({ company: company._id })).toBe(0);
    });

    test('says what is wrong with a test that cannot work', async () => {
      expect((await call('post', '/tests', { question: '', expect: { type: 'contains', value: 'x' } })).status).toBe(400);
      expect((await call('post', '/tests', { question: 'Hi', expect: { type: 'vibes' } })).status).toBe(400);
      const noValue = await call('post', '/tests', { question: 'Hi', expect: { type: 'contains', value: ' ' } });
      expect(noValue.status).toBe(400);
      expect(noValue.body.error).toMatch(/mention/);
    });

    test('a company keeps at most 50', async () => {
      await TestCase.insertMany(Array.from({ length: 50 }, (_, index) => ({
        company: company._id, question: `Question ${index}`, expect: { type: 'handover' }
      })));

      const response = await call('post', '/tests', { question: 'One more', expect: { type: 'handover' } });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'TEST_LIMIT_REACHED', limit: 50 });
    });

    test('run all: each verdict recorded, nothing else left behind', async () => {
      stubAssistant({
        'How much is a kettle?': { text: 'Kettles are £25.', sources: [{ title: 'Pricing', url: null }] },
        'I want to cancel my contract': { text: 'I cannot help with that here.', unanswered: true },
        'Where are prices listed?': { text: 'On our pricing page.', sources: [{ title: 'Pricing', url: null }] },
        'Do you refund?': { text: 'We do exchanges only.' }
      });

      await TestCase.create([
        { company: company._id, question: 'How much is a kettle?', expect: { type: 'contains', value: '£25' } },
        { company: company._id, question: 'I want to cancel my contract', expect: { type: 'handover' } },
        { company: company._id, question: 'Where are prices listed?', expect: { type: 'cites', value: 'pricing' } },
        { company: company._id, question: 'Do you refund?', expect: { type: 'contains', value: 'refund' } }
      ]);

      const response = await call('post', '/tests/run', {});

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ total: 4, passed: 3, failed: 1 });
      const failing = response.body.results.find(result => !result.passed);
      expect(failing).toMatchObject({ question: 'Do you refund?', answer: 'We do exchanges only.', reason: 'Does not mention "refund"' });

      const stored = await TestCase.findOne({ company: company._id, question: 'How much is a kettle?' }).lean();
      expect(stored.lastRun).toMatchObject({ passed: true, answer: 'Kettles are £25.', path: 'assistant' });

      expect(await Conversation.countDocuments({ company: company._id })).toBe(0);
      expect(await Usage.countDocuments({ company: company._id })).toBe(0);
    });

    test('run one, by id', async () => {
      stubAssistant({ 'How much is a kettle?': { text: 'Kettles are £25.' } });
      const saved = await TestCase.create({ company: company._id, question: 'How much is a kettle?', expect: { type: 'contains', value: '£25' } });

      const response = await call('post', `/tests/${saved._id}/run`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: String(saved._id), passed: true });
    });

    test('a test the model failed on records the failure rather than throwing', async () => {
      stubAssistant({ 'Anything?': { failed: true } });
      const saved = await TestCase.create({ company: company._id, question: 'Anything?', expect: { type: 'contains', value: 'yes' } });

      const response = await call('post', `/tests/${saved._id}/run`);
      expect(response.body).toMatchObject({ passed: false, answer: '' });
    });

    test('one tenant cannot see, change, run or delete another\'s tests', async () => {
      const theirs = await TestCase.create({ company: other._id, question: 'Theirs', expect: { type: 'handover' } });

      expect((await call('get', '/tests')).body.tests).toEqual([]);
      expect((await call('put', `/tests/${theirs._id}`, { question: 'Mine now', expect: { type: 'handover' } })).status).toBe(404);
      expect((await call('post', `/tests/${theirs._id}/run`)).status).toBe(404);
      expect((await call('delete', `/tests/${theirs._id}`)).status).toBe(404);
      expect((await call('get', '/tests', undefined, otherToken)).body.tests).toHaveLength(1);
    });

    test('is for admins', async () => {
      expect((await call('get', '/tests', undefined, operatorToken)).status).toBe(403);
      expect((await call('post', '/tests/run', {}, operatorToken)).status).toBe(403);
    });
  });
});
