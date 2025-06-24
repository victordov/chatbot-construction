const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { logger } = require('./services/logging');
const User = require('./models/user'); // Add this line to import the User model

// Load environment variables
dotenv.config();

async function migrateAdminUsers() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chatbot', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    logger.info('Connected to MongoDB');

    // Find all users with role 'admin'
    const adminUsers = await User.find({ role: 'admin' });

    logger.info(`Found ${adminUsers.length} users with role 'admin'`);

    if (adminUsers.length === 0) {
      logger.info('No users with role "admin" found. No migration needed.');
      process.exit(0);
    }

    // Update all admin users to superadmin
    const updateResult = await User.updateMany(
      { role: 'admin' },
      { $set: { role: 'superadmin' } }
    );

    logger.info(`Updated ${updateResult.modifiedCount} users from 'admin' to 'superadmin'`);

    // Verify the update
    const remainingAdmins = await User.find({ role: 'admin' });
    if (remainingAdmins.length > 0) {
      logger.warn(`There are still ${remainingAdmins.length} users with role 'admin'. Migration may not have been complete.`);
    } else {
      logger.info('Migration completed successfully. All admin users have been updated to superadmin.');
    }

    process.exit(0);
  } catch (error) {
    logger.error('Error migrating admin users:', error);
    process.exit(1);
  }
}

migrateAdminUsers();
