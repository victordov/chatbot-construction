/**
 * The assistant offers email verification when, and only when, proving an
 * email would unlock something the visitor could then ask for.
 */

const mongoose = require('mongoose');

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const assistantTools = require('../services/assistant-tools');
const verification = require('../services/visitor-verification');
const usageService = require('../services/usage');

describe('offering email verification', () => {
  let company;
  const client = { chat: { completions: { create: jest.fn() } } };

  const conversation = () => ({ _id: new mongoose.Types.ObjectId(), company: company._id, sessionId: `vo-${Date.now()}` });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    company = await Company.create({ name: 'Verify Offer Co' });
  });

  beforeEach(() => {
    jest.spyOn(usageService, 'hasFeature').mockResolvedValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await Conversation.deleteMany({ company: company._id });
    await Company.deleteOne({ _id: company._id });
  });

  test('is a tool when verifying would unlock an action, and calling it puts the button in the reply', async () => {
    jest.spyOn(verification, 'wouldUnlock').mockResolvedValue(true);

    const session = await assistantTools.prepare({ conversation: conversation(), companyId: company._id, client, message: 'where is my booking?' });

    expect(session).not.toBeNull();
    const names = session.definitions().map(definition => definition.function.name);
    expect(names).toContain('verify_visitor_email');

    const text = await session.handle({ function: { name: 'verify_visitor_email', arguments: '{}' } });
    expect(text).toMatch(/button to verify their email/);
    const { choices, toolCalls } = session.outcome();
    expect(choices).toEqual([verification.verifyEmailChoice()]);
    expect(toolCalls).toEqual([expect.objectContaining({ name: 'verify_visitor_email', status: 'ok' })]);
  });

  test('is not offered when nothing would be unlocked', async () => {
    jest.spyOn(verification, 'wouldUnlock').mockResolvedValue(false);

    const session = await assistantTools.prepare({ conversation: conversation(), companyId: company._id, client, message: 'hello' });

    const names = session ? session.definitions().map(definition => definition.function.name) : [];
    expect(names).not.toContain('verify_visitor_email');
  });

  test('is not offered in a test run', async () => {
    const unlock = jest.spyOn(verification, 'wouldUnlock').mockResolvedValue(true);

    const session = await assistantTools.prepare({
      conversation: conversation(), companyId: company._id, client, message: 'where is my booking?', simulate: true
    });

    const names = session ? session.definitions().map(definition => definition.function.name) : [];
    expect(names).not.toContain('verify_visitor_email');
    expect(unlock).not.toHaveBeenCalled();
  });
});
