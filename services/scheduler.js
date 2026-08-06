/**
 * Service for scheduling background tasks
 */

const cron = require('node-cron');
const NotificationService = require('./notification');
const webhookService = require('./webhooks');
const { logger } = require('./logging');
const socketManager = require('../socketManager');

class SchedulerService {
  constructor() {
    this.notificationService = new NotificationService();
    this.initialized = false;
    this.jobs = [];
  }

  /**
   * Run the deadline sweep and push the resulting notifications to their
   * recipients.
   */
  async runDeadlineCheck(label) {
    try {
      logger.info(`Running scheduled task: ${label}`);
      const notifications = await this.notificationService.checkTaskDeadlines();

      if (!notifications.length) {
        return;
      }

      // Deliver to the assignee's own room instead of io.emit, which broadcast
      // every notification (including task titles) to every connected client,
      // widget visitors included.
      let delivered = 0;
      for (const notification of notifications) {
        if (!notification.userId) {
          continue;
        }
        if (socketManager.emitToSession(`user:${notification.userId}`, 'notification-created', { notification })) {
          delivered += 1;
        }
      }

      logger.info(`Created ${notifications.length} deadline notifications (${delivered} delivered live)`);
    } catch (error) {
      logger.error(`Error in scheduled task: ${label}`, { error });
    }
  }

  /**
   * Initialize the scheduler
   */
  initialize() {
    if (this.initialized) {
      return;
    }

    // Webhook retries. Pending deliveries are rows with a time on them rather
    // than timers in memory, so a deploy does not lose them — and a deploy is
    // exactly when endpoints are most likely to have been failing.
    this.jobs.push(cron.schedule('* * * * *', () => {
      webhookService.processPending().catch(error =>
        logger.error('Webhook sweep failed', { error: error.message }));
    }));

    // Daily sweep at midnight catches tasks that became overdue overnight.
    this.jobs.push(cron.schedule('0 0 * * *', () => this.runDeadlineCheck('daily deadline check')));

    // Hourly sweep during working hours keeps due-today reminders timely.
    this.jobs.push(cron.schedule('0 8-18 * * *', () => this.runDeadlineCheck('hourly deadline check')));

    this.initialized = true;
    logger.info('Scheduler service initialized');
  }

  /**
   * Stop all cron jobs so the process can exit cleanly on SIGTERM.
   */
  stop() {
    this.jobs.forEach(job => {
      if (job && typeof job.stop === 'function') {
        job.stop();
      }
    });
    this.jobs = [];
    this.initialized = false;
  }
}

// Create singleton instance
const schedulerService = new SchedulerService();

module.exports = schedulerService;
