/**
 * Migration script to add company field to existing tasks
 * This script will find tasks created by users and assign them to the user's company
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Task = require('./models/task');
const User = require('./models/user');
const { logger } = require('./services/logging');

// Load environment variables
dotenv.config();

async function migrateTasksCompany() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chatbot', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    logger.info('Connected to MongoDB for task company migration');

    // Find all tasks without a company field
    const tasksWithoutCompany = await Task.find({
      $or: [
        { company: { $exists: false } },
        { company: null }
      ]
    }).populate('createdBy', 'company');

    logger.info(`Found ${tasksWithoutCompany.length} tasks without company assignment`);

    let migratedCount = 0;
    let errorCount = 0;

    for (const task of tasksWithoutCompany) {
      try {
        if (task.createdBy && task.createdBy.company) {
          // Update task with the creator's company
          await Task.findByIdAndUpdate(task._id, {
            company: task.createdBy.company
          });
          
          migratedCount++;
          logger.debug(`Updated task ${task._id} with company ${task.createdBy.company}`);
        } else {
          logger.warn(`Task ${task._id} has no valid company from creator ${task.createdBy?._id}`);
          errorCount++;
        }
      } catch (error) {
        logger.error(`Error updating task ${task._id}:`, error);
        errorCount++;
      }
    }

    logger.info(`Migration completed. Updated: ${migratedCount}, Errors: ${errorCount}`);

    // Verify migration
    const remainingTasksWithoutCompany = await Task.countDocuments({
      $or: [
        { company: { $exists: false } },
        { company: null }
      ]
    });

    logger.info(`Remaining tasks without company: ${remainingTasksWithoutCompany}`);

    process.exit(0);
  } catch (error) {
    logger.error('Error during task company migration:', error);
    process.exit(1);
  }
}

// Run migration if this script is executed directly
if (require.main === module) {
  migrateTasksCompany();
}

module.exports = migrateTasksCompany;
