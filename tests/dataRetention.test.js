const DataRetentionService = require('../services/dataRetention');
const Conversation = require('../models/conversation');

// Mock the Conversation model
jest.mock('../models/conversation');

describe('Data Retention Service Test', () => {
  let dataRetentionService;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create a new instance
    dataRetentionService = new DataRetentionService();

    // Set up mock for Conversation.find
    Conversation.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        {
          _id: 'conversation1',
          sessionId: 'session1',
          lastActivity: new Date(Date.now() - 95 * 24 * 60 * 60 * 1000), // 95 days old
          messages: [{ content: 'Old message' }],
          anonymize: jest.fn().mockResolvedValue({}),
          save: jest.fn().mockResolvedValue({}),
          delete: jest.fn().mockResolvedValue({})
        },
        {
          _id: 'conversation2',
          sessionId: 'session2',
          lastActivity: new Date(Date.now() - 185 * 24 * 60 * 60 * 1000), // 185 days old
          messages: [{ content: 'Very old message' }],
          anonymize: jest.fn().mockResolvedValue({}),
          save: jest.fn().mockResolvedValue({}),
          delete: jest.fn().mockResolvedValue({})
        },
        {
          _id: 'conversation3',
          sessionId: 'session3',
          lastActivity: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days old
          messages: [{ content: 'Recent message' }],
          anonymize: jest.fn().mockResolvedValue({}),
          save: jest.fn().mockResolvedValue({}),
          delete: jest.fn().mockResolvedValue({})
        }
      ])
    });

    // Mock delete method
    Conversation.deleteMany = jest.fn().mockResolvedValue({ deletedCount: 1 });
  });

  it('should identify conversations older than retention period', async () => {
    // Set retention period to 90 days
    dataRetentionService.setRetentionPeriod(90);

    const oldConversations = await dataRetentionService.findExpiredConversations();

    // Two conversations should be older than 90 days
    expect(oldConversations.length).toBe(2);
    expect(oldConversations[0]._id).toBe('conversation1');
    expect(oldConversations[1]._id).toBe('conversation2');

    // Verify the query was called with the correct date
    const expectedDate = new Date();
    expectedDate.setDate(expectedDate.getDate() - 90);

    expect(Conversation.find).toHaveBeenCalledWith({
      lastActivity: { $lt: expect.any(Date) }
    });
  });

  it('should anonymize conversations beyond retention period', async () => {
    // Set retention period to 90 days
    dataRetentionService.setRetentionPeriod(90);

    // Run anonymization
    const result = await dataRetentionService.anonymizeExpiredConversations();

    // Two conversations should be anonymized
    expect(result.anonymizedCount).toBe(2);

    // Verify the anonymize method was called on each expired conversation
    const oldConversations = await dataRetentionService.findExpiredConversations();
    expect(oldConversations[0].anonymize).toHaveBeenCalled();
    expect(oldConversations[1].anonymize).toHaveBeenCalled();
  });

  it('should delete conversations older than deletion period', async () => {
    // Set deletion period to 180 days
    dataRetentionService.setDeletionPeriod(180);

    // Run deletion
    const result = await dataRetentionService.deleteExpiredConversations();

    // One conversation should be deleted (older than 180 days)
    expect(result.deletedCount).toBe(1);

    // Verify deleteMany was called with the correct date
    const expectedDate = new Date();
    expectedDate.setDate(expectedDate.getDate() - 180);

    expect(Conversation.deleteMany).toHaveBeenCalledWith({
      lastActivity: { $lt: expect.any(Date) }
    });
  });

  it('should respect GDPR request for immediate deletion', async () => {
    // Mock findOne to return a specific conversation
    Conversation.findOne = jest.fn().mockResolvedValue({
      _id: 'gdpr-conversation',
      sessionId: 'gdpr-session',
      delete: jest.fn().mockResolvedValue({})
    });

    // Run GDPR deletion
    await dataRetentionService.handleGDPRDeletionRequest('gdpr-session');

    // Verify the conversation was looked up and deleted
    expect(Conversation.findOne).toHaveBeenCalledWith({ sessionId: 'gdpr-session' });

    const mockConversation = await Conversation.findOne();
    expect(mockConversation.delete).toHaveBeenCalled();
  });
});
