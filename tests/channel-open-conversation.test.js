/**
 * One open conversation per messaging-app customer, even when two instances
 * receive that customer's messages at the same moment.
 */

const mongoose = require('mongoose');

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const lifecycle = require('../services/conversation-lifecycle');
const inbound = require('../services/channels/inbound');

describe('one open conversation per app customer', () => {
  let company;
  const account = () => ({ _id: new mongoose.Types.ObjectId(), company: company._id });
  const event = { provider: 'whatsapp', userId: '447700900123', phone: '+447700900123', profileName: 'Jamie', timestamp: new Date() };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    await Conversation.createIndexes();
    company = await Company.create({ name: 'One Open Co' });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Conversation.deleteMany({ company: company._id });
  });

  afterAll(async () => {
    await Company.deleteOne({ _id: company._id });
  });

  test('the database refuses a second open conversation for the same customer', async () => {
    const external = { provider: 'whatsapp', userId: '447700900123' };
    await Conversation.create({ sessionId: 'oo-1', company: company._id, channel: 'whatsapp', status: 'active', external });

    await expect(Conversation.create({ sessionId: 'oo-2', company: company._id, channel: 'whatsapp', status: 'active', external }))
      .rejects.toMatchObject({ code: 11000 });

    // Ended ones do not count: a customer writing again later starts afresh.
    await Conversation.updateOne({ sessionId: 'oo-1' }, { status: 'ended' });
    await expect(Conversation.create({ sessionId: 'oo-3', company: company._id, channel: 'whatsapp', status: 'active', external }))
      .resolves.toBeTruthy();
  });

  test('losing that race joins the conversation the other instance started', async () => {
    const winner = await Conversation.create({
      sessionId: 'oo-winner', company: company._id, channel: 'whatsapp', status: 'active',
      external: { provider: 'whatsapp', userId: event.userId }
    });
    // As if this instance looked a moment before the winner wrote: the
    // lookup misses, the create collides.
    const findOne = Conversation.findOne.bind(Conversation);
    let first = true;
    jest.spyOn(Conversation, 'findOne').mockImplementation((...args) => {
      if (first && args[0] && args[0].status === 'active') {
        first = false;
        return { sort: () => Promise.resolve(null) };
      }
      return findOne(...args);
    });
    jest.spyOn(lifecycle, 'createConversation').mockResolvedValue({ duplicate: true });

    const result = await inbound.openConversationFor(account(), event);

    expect(result.created).toBe(false);
    expect(String(result.conversation._id)).toBe(String(winner._id));
  });
});
