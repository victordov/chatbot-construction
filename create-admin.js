/**
 * This script creates an initial admin user in the database
 * Run with: node create-admin.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/user');

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

    console.log('Connected to MongoDB');

    // Check if admin user already exists
    const existingAdmin = await User.findOne({ username: DEFAULT_ADMIN.username });

    if (existingAdmin) {
      console.log('Admin user already exists');
      process.exit(0);
    }

    // Create admin user
    const admin = new User({
      username: DEFAULT_ADMIN.username,
      email: DEFAULT_ADMIN.email,
      password: DEFAULT_ADMIN.password,
      role: DEFAULT_ADMIN.role
    });

    await admin.save();

    console.log('Admin user created successfully');
    console.log(`Username: ${DEFAULT_ADMIN.username}`);
    console.log(`Password: ${DEFAULT_ADMIN.password}`);
    console.log('Please change this password after first login');

    process.exit(0);
  } catch (error) {
    console.error('Error creating admin user:', error);
    process.exit(1);
  }
}

createAdmin();
