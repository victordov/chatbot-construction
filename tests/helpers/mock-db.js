/**
 * MongoDB Mocking Helper
 * This file provides mock implementations for MongoDB functions to avoid
 * needing a real MongoDB connection during tests.
 */

// Import the enhanced mock mongoose from mock-mongodb.js
const { mongoose } = require('./mock-mongodb');

// Export the mongoose mock
module.exports = {
  mongoose
};

// Create a document instance factory
const createModelInstance = (data = {}) => {
  return {
    ...data,
    _id: data._id || 'mock-id-' + Math.random().toString(36).substr(2, 9),
    save: jest.fn().mockResolvedValue(true),
    toObject: jest.fn().mockReturnValue(data),
    toJSON: jest.fn().mockReturnValue(data)
  };
};

// Define mock model functions
const mockModelFunctions = {
  find: jest.fn().mockReturnThis(),
  findOne: jest.fn().mockReturnThis(),
  findById: jest.fn().mockReturnThis(),
  findByIdAndUpdate: jest.fn().mockReturnThis(),
  findByIdAndDelete: jest.fn().mockReturnThis(),
  findOneAndUpdate: jest.fn().mockReturnThis(),
  findOneAndDelete: jest.fn().mockReturnThis(),
  updateOne: jest.fn().mockResolvedValue({ nModified: 1 }),
  updateMany: jest.fn().mockResolvedValue({ nModified: 1 }),
  deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
  deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
  countDocuments: jest.fn().mockResolvedValue(0),
  populate: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([])
};

// Mock implementation for mongoose.model
mongoose.model = jest.fn().mockImplementation((modelName) => {
  const modelFunctions = { ...mockModelFunctions };

  // Add custom behavior for create to return proper model instances
  modelFunctions.create = jest.fn().mockImplementation((data) => {
    if (Array.isArray(data)) {
      return Promise.resolve(data.map(item => createModelInstance({ ...item, modelName })));
    }
    return Promise.resolve(createModelInstance({ ...data, modelName }));
  });

  // Make static functions also available as properties for instances
  const modelObj = {
    ...modelFunctions,
    modelName
  };

  // Add this helper for setting up test data
  modelObj.mockData = (data) => {
    if (Array.isArray(data)) {
      modelFunctions.find.mockResolvedValue(data.map(d => createModelInstance(d)));
      modelFunctions.exec.mockResolvedValue(data.map(d => createModelInstance(d)));
    } else if (data) {
      modelFunctions.findOne.mockResolvedValue(createModelInstance(data));
      modelFunctions.findById.mockResolvedValue(createModelInstance(data));
    }
  };

  return modelObj;
});

// Mock Schema
mongoose.Schema = jest.fn().mockImplementation(() => ({
  pre: jest.fn().mockReturnThis(),
  methods: {},
  statics: {},
  virtual: jest.fn().mockReturnThis(),
  get: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  index: jest.fn().mockReturnThis()
}));

// Mock connect function
mongoose.connect = jest.fn().mockResolvedValue({
  connection: {
    on: jest.fn(),
    once: jest.fn(),
    close: jest.fn().mockResolvedValue(true)
  }
});

// Mock disconnect
mongoose.disconnect = jest.fn().mockResolvedValue(true);

// Mock connection
mongoose.connection = {
  on: jest.fn(),
  once: jest.fn(),
  close: jest.fn().mockResolvedValue(true),
  db: {
    collection: jest.fn().mockReturnValue({
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([])
      }),
      insertOne: jest.fn().mockResolvedValue({ insertedId: 'mock-id' }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 })
    })
  }
};

// Mock MongoMemoryServer
class MockMongoMemoryServer {
  constructor() {
    this.uri = 'mongodb://localhost:27017/test-db';
    this.isRunning = true;
  }

  async start() {
    this.isRunning = true;
    return this.uri;
  }

  async stop() {
    this.isRunning = false;
    return true;
  }

  getUri() {
    return this.uri;
  }

  // Add these methods to support more common use cases
  async ensureInstance() {
    return this;
  }

  static async create(
    // eslint-disable-next-line no-unused-vars
    options = {}
  ) {
    return new MockMongoMemoryServer();
  }
}

// Helper to set up mock return values for specific model methods
const setupModelMock = (modelName, methodName, returnValue) => {
  const model = mongoose.model(modelName);
  model[methodName].mockResolvedValue(returnValue);
  return model[methodName];
};

module.exports = {
  mongoose,
  setupModelMock,
  createModelInstance,
  MockMongoMemoryServer
};
