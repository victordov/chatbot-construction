/**
 * Mocks for MongoDB and MongoMemoryServer
 * This file provides a more comprehensive mocking solution for MongoDB-related tests
 */

const { EventEmitter } = require('events');

// Create a more comprehensive mock mongoose
const mockMongoose = {
  connection: null,
  connections: [],
  models: {},
  modelSchemas: {},

  // Mock Schema constructor
  Schema: function(definition, options = {}) {
    this.definition = definition;
    this.options = options;
    this.paths = {};
    this.methods = {};
    this.statics = {};
    this.virtuals = {};

    // Add paths based on the definition
    Object.keys(definition).forEach(path => {
      this.paths[path] = definition[path];
    });

    // Common schema methods
    this.index = jest.fn().mockReturnThis();
    this.pre = jest.fn().mockReturnThis();
    this.post = jest.fn().mockReturnThis();
    this.virtual = jest.fn().mockReturnThis();
    this.set = jest.fn().mockReturnThis();
    this.method = jest.fn().mockImplementation(function(obj) {
      Object.assign(this.methods, obj);
      return this;
    });
    this.static = jest.fn().mockImplementation(function(obj) {
      Object.assign(this.statics, obj);
      return this;
    });

    return this;
  },

  // Mock model constructor
  model: jest.fn().mockImplementation(function(name, schema) {
    // If model already exists, return it
    if (this.models[name]) {
      return this.models[name];
    }

    // Create a mock model constructor
    const Model = function(data) {
      Object.assign(this, data);

      // Add instance methods
      this.save = jest.fn().mockResolvedValue(this);
      this.remove = jest.fn().mockResolvedValue({ deleted: true });
      this.delete = jest.fn().mockResolvedValue({ deleted: true });

      // Add schema methods
      if (schema && schema.methods) {
        Object.keys(schema.methods).forEach(method => {
          this[method] = schema.methods[method].bind(this);
        });
      }
    };

    // Add static methods
    Model.find = jest.fn().mockResolvedValue([]);
    Model.findById = jest.fn().mockResolvedValue(null);
    Model.findOne = jest.fn().mockResolvedValue(null);
    Model.findByIdAndUpdate = jest.fn().mockResolvedValue(null);
    Model.findByIdAndDelete = jest.fn().mockResolvedValue(null);
    Model.create = jest.fn().mockImplementation(async (data) => {
      const instance = new Model(data);
      instance._id = data._id || 'mock-id-' + Math.random().toString(36).substring(2, 9);
      return instance;
    });
    Model.deleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });
    Model.deleteOne = jest.fn().mockResolvedValue({ deletedCount: 0 });
    Model.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    Model.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    Model.countDocuments = jest.fn().mockResolvedValue(0);
    Model.prototype.populate = jest.fn().mockReturnThis();

    // Add schema statics
    if (schema && schema.statics) {
      Object.keys(schema.statics).forEach(method => {
        Model[method] = schema.statics[method];
      });
    }

    this.models[name] = Model;
    return Model;
  }),

  // Other mongoose utilities
  Types: {
    ObjectId: jest.fn().mockImplementation((id) => id || 'mock-object-id'),
    String: String,
    Number: Number,
    Boolean: Boolean,
    Array: Array,
    Mixed: 'mixed',
    Date: Date
  }
};

// Mock MongoMemoryServer class with more robust implementation
class MockMongoMemoryServer {
  constructor(options = {}) {
    this.uri = options.uri || 'mongodb://localhost:27017/test-db';
    this.isRunning = false;
    this.instance = null;
    this.instanceInfo = {
      port: 27017,
      ip: '127.0.0.1',
      dbName: 'test-db',
      dbPath: '/tmp/mongo-mem',
      uri: this.uri
    };
  }

  // Methods required by the real MongoMemoryServer
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

  async ensureInstance() {
    if (!this.instance) {
      this.instance = { ...this.instanceInfo };
    }
    return this.instance;
  }

  // Static factory method used in tests
  static async create(options = {}) {
    const server = new MockMongoMemoryServer(options);
    await server.start();
    return server;
  }
}

// Enhanced mock mongoose connection with event emitter
class MockMongooseConnection extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // Connected
    this.models = {};
    this.collections = {};
    this.db = {
      collection: (
        // eslint-disable-next-line no-unused-vars
        name) => ({
        find: () => ({
          toArray: async () => []
        }),
        findOne: async () => null,
        insertOne: async () => ({ insertedId: 'mock-id' }),
        updateOne: async () => ({ modifiedCount: 1 }),
        deleteOne: async () => ({ deletedCount: 1 }),
        countDocuments: async () => 0
      })
    };
  }

  // Methods commonly used in tests
  async close() {
    this.readyState = 0;
    this.emit('close');
    return true;
  }
}

// Enhanced connect method that immediately resolves
mockMongoose.connect = jest.fn().mockImplementation(async (
  // eslint-disable-next-line no-unused-vars
  uri,
  // eslint-disable-next-line no-unused-vars
  options) => {
  mockMongoose.connection = new MockMongooseConnection();
  mockMongoose.connections = [mockMongoose.connection];
  mockMongoose.connection.emit('connected');
  return mockMongoose.connection;
});

// Export mocks
module.exports = {
  MockMongoMemoryServer,
  mongoose: mockMongoose
};
