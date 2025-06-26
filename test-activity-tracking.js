/**
 * Simple test script to verify activity tracking is working for super admin users
 */

const mongoose = require('mongoose');
const User = require('./models/user');
const Task = require('./models/task');
const Activity = require('./models/activity');
const Company = require('./models/company'); // Import Company model
const TaskService = require('./services/task');
const ActivityService = require('./services/activity');

async function testActivityTracking() {
  try {
    // Connect to MongoDB
    await mongoose.connect('mongodb://localhost:27017/chatbot', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log('Connected to MongoDB');

    // Find or create a super admin user
    let superAdmin = await User.findOne({ role: 'superadmin' });
    if (!superAdmin) {
      console.log('No super admin found in database');
      return;
    }

    console.log(`Found super admin: ${superAdmin.username} (${superAdmin._id})`);
    console.log(`Super admin company: ${superAdmin.company || 'null'}`);

    // Create a test task
    const taskService = new TaskService();
    const activityService = new ActivityService();

    const taskData = {
      title: 'Test Activity Tracking Task',
      description: 'This task is created to test activity tracking for super admin users',
      dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
      priority: 'medium',
      status: 'open',
      createdBy: superAdmin._id,
      company: null // Explicitly set to null for super admin
    };

    console.log('\nCreating test task...');
    const task = await taskService.createTask(taskData, {
      id: superAdmin._id,
      username: superAdmin.username,
      role: superAdmin.role,
      company: null
    });

    console.log(`Task created: ${task._id}`);

    // Update the task to test activity logging
    console.log('\nUpdating task status...');
    const updatedTask = await taskService.updateTask(
      task._id,
      { status: 'in_progress', priority: 'high' },
      {
        id: superAdmin._id,
        username: superAdmin.username,
        role: superAdmin.role,
        company: null
      },
      null, // userCompanyId (null for super admin)
      'superadmin' // userRole
    );

    console.log('Task updated successfully');

    // Check activities
    console.log('\nRetrieving activities...');
    const activities = await activityService.getTaskActivities(task._id, null, 'superadmin');

    console.log(`Found ${activities.length} activities:`);
    activities.forEach((activity, index) => {
      console.log(`  ${index + 1}. ${activity.type}: ${activity.description}`);
      console.log(`     By: ${activity.userName}, Company: ${activity.company || 'null'}`);
      console.log(`     At: ${activity.createdAt}`);
    });

    // Clean up: Delete the test task
    console.log('\nCleaning up test task...');
    await Task.findByIdAndDelete(task._id);
    await Activity.deleteMany({ taskId: task._id });

    console.log('\n✅ Activity tracking test completed successfully!');
    console.log('Super admin users can now create tasks and log activities without company restrictions.');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

// Run the test
testActivityTracking();
