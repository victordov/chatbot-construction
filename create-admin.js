/**
 * This script creates an initial admin user in the database
 * Run with: node create-admin.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/user');
const { logger } = require('./services/logging');

// Load environment variables
dotenv.config();

// Default admin credentials
const DEFAULT_ADMIN = {
  username: 'admin',
  password: 'Admin123!',
  email: 'admin@chatbot.com',
  role: 'admin'
};

async function createAdmin() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chatbot', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    logger.info('Connected to MongoDB');

    // Check if admin user already exists
    const existingAdmin = await User.findOne({ username: DEFAULT_ADMIN.username });

    if (existingAdmin) {
      logger.info('Admin user already exists');
      process.exit(0);
    }

    // Create admin user
    const admin = new User({
      username: DEFAULT_ADMIN.username,
      displayName: 'Admin',
      email: DEFAULT_ADMIN.email,
      password: DEFAULT_ADMIN.password,
      role: DEFAULT_ADMIN.role
    });

    await admin.save();

    logger.info('Admin user created successfully');
    logger.info(`Username: ${DEFAULT_ADMIN.username}`);
    logger.info(`Password: ${DEFAULT_ADMIN.password}`);
    logger.info('Please change this password after first login');

    process.exit(0);
  } catch (error) {
    logger.error('Error creating admin user:', { error });
    process.exit(1);
  }
}

createAdmin();
