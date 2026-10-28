/**
 * Service for scheduling background tasks
 */

const cron = require('node-cron');
const NotificationService = require('./notification');
const webhookService = require('./webhooks');
const TenantBackupService = require('./tenant-backup');
const knowledgeCrawler = require('./knowledge-crawler');
const usageAlerts = require('./usage-alerts');
const resolutions = require('./resolutions');
const sweeps = require('./conversation-sweeps');
const booking = require('./booking');
const Company = require('../models/company');
const { logger } = require('./logging');
const socketManager = require('../socketManager');

class SchedulerService {
  constructor() {
    this.notificationService = new NotificationService();
    this.tenantBackupService = new TenantBackupService();
    this.initialized = false;
    this.jobs = [];
  }

  /**
   * Back up every active tenant, one at a time.
   *
   * Sequential on purpose: this runs against the same database serving
   * conversations, and a backup job that makes the product slow at 2am is a
   * backup job somebody switches off.
   *
   * One tenant failing must not cost the others their backup — the night a
   * backup matters is the night one tenant's data is in a state nothing else
   * expected.
   */
  async runTenantBackups() {
    try {
      const companies = await Company.find({ isActive: true }).select('_id name').lean();
      let succeeded = 0;

      for (const company of companies) {
        try {
          await this.tenantBackupService.backupCompany(company._id);
          succeeded += 1;
        } catch (error) {
          logger.error('Tenant backup failed', { company: company.name, error: error.message });
        }
      }

      const { removed } = this.tenantBackupService.cleanup();
      logger.info('Tenant backups complete', { succeeded, of: companies.length, expired: removed });
    } catch (error) {
      logger.error('Tenant backup sweep failed', { error: error.message });
    }
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

    // With several instances exactly one should run these, or N replicas
    // retry every webhook and back every tenant up N times a night. server.js
    // checks the same flag before calling this; the check is repeated here so
    // the service enforces it whoever calls initialize().
    if (process.env.SCHEDULER_ENABLED === 'false') {
      logger.info('Scheduler service not started (SCHEDULER_ENABLED=false)');
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

    // Knowledge sources and sites set to refresh weekly. Each run takes a few
    // of whatever is due, so a tenant with a large site cannot hold up the
    // others and the hour after a deploy is not one long crawl.
    this.jobs.push(cron.schedule('15 * * * *', () => {
      knowledgeCrawler.recrawlDue().catch(error =>
        logger.error('Knowledge refresh sweep failed', { error: error.message }));
    }));

    // Usage warnings at 80% and 100% of a plan's limits. Each is claimed
    // atomically per meter and period, so an hourly check sends one email,
    // not one an hour.
    this.jobs.push(cron.schedule('45 * * * *', () => {
      usageAlerts.runAll().catch(error =>
        logger.error('Usage warning sweep failed', { error: error.message }));
    }));

    // Appointment reminders, about a day ahead. Each booking is claimed
    // before its email goes, so running often never sends two.
    this.jobs.push(cron.schedule('*/15 * * * *', () => {
      booking.sendDueReminders().catch(error =>
        logger.error('Booking reminder sweep failed', { error: error.message }));
    }));

    // Somebody has waited too long for a person: tell the team again, once.
    this.jobs.push(cron.schedule('* * * * *', () => {
      sweeps.escalateLongWaits().catch(error =>
        logger.error('Long-wait escalation failed', { error: error.message }));
    }));

    // Web chats nobody has written in for a day are ended, so they leave the
    // queue and count as finished in reports.
    this.jobs.push(cron.schedule('5 * * * *', () => {
      sweeps.closeIdleConversations().catch(error =>
        logger.error('Idle conversation sweep failed', { error: error.message }));
    }));

    // Resolutions for per-resolution pricing: counted nightly (a conversation
    // only counts once it ended or sat idle for a day, so it cannot still
    // turn into a handover), then reported to Stripe as that day's difference.
    this.jobs.push(cron.schedule('15 1 * * *', () => {
      resolutions.recordResolutions().catch(error =>
        logger.error('Resolution count failed', { error: error.message }));
    }));
    this.jobs.push(cron.schedule('30 1 * * *', () => {
      resolutions.reportResolutionsToStripe().catch(error =>
        logger.error('Resolution report to Stripe failed', { error: error.message }));
    }));

    // Nightly per-tenant backups. Opt-in, because writing every tenant's
    // documents to local disk is a decision about where data lives, and
    // whoever operates this has to make it rather than inherit it.
    if (process.env.TENANT_BACKUPS_ENABLED === 'true') {
      this.jobs.push(cron.schedule('30 2 * * *', () => this.runTenantBackups()));
      logger.info('Nightly per-tenant backups scheduled');
    }

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
