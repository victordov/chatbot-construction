/**
 * Service for scheduling background tasks
 */

const cron = require('node-cron');
const NotificationService = require('./notification');
const { logger } = require('./logging');
const socketManager = require('../socketManager');

class SchedulerService {
  constructor() {
    this.notificationService = new NotificationService();
    this.initialized = false;
  }

  /**
   * Initialize the scheduler
   */
  initialize() {
    if (this.initialized) {
      return;
    }

    // Schedule task to check deadlines daily at midnight
    cron.schedule('0 0 * * *', async () => {
      try {
        logger.info('Running scheduled task: Check task deadlines');
        const notifications = await this.notificationService.checkTaskDeadlines();
        
        // Emit WebSocket events for new notifications
        if (notifications.length > 0) {
          try {
            const io = socketManager.getIo();
            for (const notification of notifications) {
              io.emit('notification-created', { notification });
            }
            logger.info(`Created ${notifications.length} deadline notifications`);
          } catch (socketError) {
            logger.error('Error emitting notification-created events', { error: socketError });
          }
        }
      } catch (error) {
        logger.error('Error in scheduled task: Check task deadlines', { error });
      }
    });

    // Schedule task to check deadlines every hour during working hours (8 AM to 6 PM)
    cron.schedule('0 8-18 * * *', async () => {
      try {
        logger.info('Running hourly task: Check task deadlines');
        const notifications = await this.notificationService.checkTaskDeadlines();
        
        // Emit WebSocket events for new notifications
        if (notifications.length > 0) {
          try {
            const io = socketManager.getIo();
            for (const notification of notifications) {
              io.emit('notification-created', { notification });
            }
            logger.info(`Created ${notifications.length} deadline notifications`);
          } catch (socketError) {
            logger.error('Error emitting notification-created events', { error: socketError });
          }
        }
      } catch (error) {
        logger.error('Error in hourly task: Check task deadlines', { error });
      }
    });

    this.initialized = true;
    logger.info('Scheduler service initialized');
  }
}

// Create singleton instance
const schedulerService = new SchedulerService();

module.exports = schedulerService;