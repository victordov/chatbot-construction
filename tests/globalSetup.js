/**
 * Starts an in-memory MongoDB for the whole test run so the integration suites
 * do not depend on a developer having mongod installed and running locally.
 *
 * Set MONGODB_TEST_URI yourself to run the suite against a real server instead.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');

module.exports = async function globalSetup() {
  if (process.env.MONGODB_TEST_URI) {
    return;
  }

  try {
    const mongo = await MongoMemoryServer.create();
    // Stash the instance so globalTeardown can stop it.
    global.__MONGO_SERVER__ = mongo;
    process.env.MONGODB_TEST_URI = mongo.getUri();
    process.env.MONGODB_URI = mongo.getUri();
  } catch (error) {
    // Downloading the mongod binary can fail in offline CI. Fall back to a
    // local server rather than failing the whole run at setup time.
    // eslint-disable-next-line no-console
    console.warn('Could not start in-memory MongoDB, falling back to localhost:', error.message);
    process.env.MONGODB_TEST_URI = 'mongodb://localhost:27017/chatbot_test';
  }
};
