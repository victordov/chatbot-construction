/**
 * Alerting Service for Chatbot Application
 *
 * This service sets up alert triggers based on metrics and sends notifications
 * when thresholds are exceeded.
 */

const nodemailer = require('nodemailer');
const { ALERT_THRESHOLDS, register } = require('./monitoring');
const { logger } = require('./logging');

/**
 * A nodemailer transport from the SMTP_* environment, or null when SMTP_HOST is
 * not set.
 *
 * Shared with the password-reset email in routes/auth.js, so there is one
 * place that knows how this deployment sends mail rather than two
 * configurations that drift apart.
 */
function createSmtpTransport() {
  if (!process.env.SMTP_HOST) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    // Some relays take no credentials at all; passing an empty `auth` makes
    // nodemailer attempt a login and fail.
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined
  });
}

class AlertService {
  constructor(options = {}) {
    this.enabled = options.enabled || process.env.ALERTS_ENABLED === 'true';
    this.emailEnabled = options.emailEnabled || process.env.EMAIL_ALERTS_ENABLED === 'true';
    this.recipients = options.recipients || process.env.ALERT_RECIPIENTS?.split(',') || [];
    this.checkInterval = options.checkInterval || parseInt(process.env.ALERT_CHECK_INTERVAL || '60000');
    this.alertingState = new Map();

    // Cumulative HTTP counters as of the previous check, so each check can ask
    // "what happened since?" rather than "what has ever happened?".
    this.httpTotals = null;

    // Configure email transport if both alerts and email alerts are enabled
    if (this.enabled && this.emailEnabled) {
      this.transporter = createSmtpTransport();
    }
  }

  /**
   * Start monitoring and alerting service
   */
  start() {
    if (!this.enabled) {
      logger.info('Alerting service is disabled');
      return;
    }

    logger.info('Starting alerting service...');

    // Set up interval to check metrics and trigger alerts
    this.interval = setInterval(() => this.checkMetrics(), this.checkInterval);
  }

  /**
   * Stop the alerting service
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
    }

    logger.info('Alerting service stopped');
  }

  /**
   * Check metrics against thresholds and trigger alerts
   */
  async checkMetrics() {
    try {
      // Read once per check: the window is a delta against the previous
      // reading, so asking for it twice would leave the second caller looking
      // at an empty interval.
      const window = await this.readHttpWindow();

      if (!window) {
        // No traffic since the last check, or the first check after start.
        // Nothing is known, so nothing is claimed - in particular, existing
        // alerts are left alone rather than resolved on the strength of
        // silence.
        return;
      }

      const avgResponseTime = window.totalMs / window.requests;

      if (avgResponseTime > ALERT_THRESHOLDS.high_response_time) {
        this.triggerAlert('high_response_time', {
          title: 'High Response Time Detected',
          message: `Average response time (${Math.round(avgResponseTime)}ms across ` +
            `${window.requests} requests) exceeds threshold ` +
            `(${ALERT_THRESHOLDS.high_response_time}ms)`,
          severity: 'warning',
          metrics: { avgResponseTime, requests: window.requests }
        });
      } else {
        this.resolveAlert('high_response_time');
      }

      const errorRate = window.errors / window.requests;

      if (errorRate > ALERT_THRESHOLDS.high_error_rate) {
        this.triggerAlert('high_error_rate', {
          title: 'High Error Rate Detected',
          message: `Error rate (${(errorRate * 100).toFixed(2)}%, ` +
            `${window.errors} of ${window.requests} requests) exceeds threshold ` +
            `(${(ALERT_THRESHOLDS.high_error_rate * 100).toFixed(2)}%)`,
          severity: 'critical',
          metrics: { errorRate, errors: window.errors, requests: window.requests }
        });
      } else {
        this.resolveAlert('high_error_rate');
      }
    } catch (error) {
      logger.error('Error in alert metrics check:', { error });
    }
  }

  /**
   * Trigger an alert if not already active
   */
  triggerAlert(alertId, alertData) {
    const existingAlert = this.alertingState.get(alertId);

    // Only trigger if not already in alerting state or if needs escalation
    if (!existingAlert ||
        existingAlert.severity !== alertData.severity ||
        (Date.now() - existingAlert.lastNotification > this.getEscalationInterval(alertData.severity))) {

      logger.info(`🚨 ALERT: ${alertData.title}`);
      logger.info(alertData.message);

      // Send notification
      this.sendNotification(alertData);

      // Update alerting state
      this.alertingState.set(alertId, {
        ...alertData,
        active: true,
        triggeredAt: existingAlert?.triggeredAt || Date.now(),
        lastNotification: Date.now()
      });
    }
  }

  /**
   * Resolve an alert if it's active
   */
  resolveAlert(alertId) {
    const existingAlert = this.alertingState.get(alertId);

    if (existingAlert && existingAlert.active) {
      logger.info(`✅ RESOLVED: ${existingAlert.title}`);

      // Send resolution notification
      this.sendNotification({
        title: `[RESOLVED] ${existingAlert.title}`,
        message: 'The alert condition has been resolved.',
        severity: 'info',
        resolved: true
      });

      // Update alerting state
      this.alertingState.set(alertId, {
        ...existingAlert,
        active: false,
        resolvedAt: Date.now()
      });
    }
  }

  /**
   * Send notification via configured channels
   */
  async sendNotification(alertData) {
    if (!this.enabled || this.recipients.length === 0) {
      return;
    }

    // Send email notification if email alerts are enabled
    if (this.emailEnabled && this.transporter) {
      try {
        const emoji = alertData.resolved ? '✅' :
          alertData.severity === 'critical' ? '🚨' :
            alertData.severity === 'warning' ? '⚠️' : 'ℹ️';

        await this.transporter.sendMail({
          from: process.env.ALERT_FROM_EMAIL || 'alerts@chatbot-application.com',
          to: this.recipients.join(','),
          subject: `${emoji} ${alertData.title}`,
          text: alertData.message,
          html: `<h2>${emoji} ${alertData.title}</h2>
                 <p>${alertData.message}</p>
                 ${alertData.metrics ? `<pre>${JSON.stringify(alertData.metrics, null, 2)}</pre>` : ''}`
        });

        logger.info('Alert notification email sent');
      } catch (error) {
        logger.error('Failed to send alert email:', { error });
      }
    } else if (!this.emailEnabled) {
      logger.info('Email alerts are disabled. Alert not sent via email.');
    }

    // Additional notification channels could be added here (Slack, SMS, etc.)
  }

  /**
   * Get escalation interval based on severity
   */
  getEscalationInterval(severity) {
    switch (severity) {
    case 'critical':
      return 15 * 60 * 1000; // 15 minutes
    case 'warning':
      return 60 * 60 * 1000; // 1 hour
    default:
      return 4 * 60 * 60 * 1000; // 4 hours
    }
  }

  /**
   * Read the HTTP request histogram, as counts since the last time we looked.
   *
   * The registry's counters run cumulatively from process start, so comparing
   * them against a threshold directly would mean one bad minute stayed in the
   * average for the life of the process, and a genuinely bad hour never moved
   * it. Taking the delta since the previous check makes both numbers describe
   * the window the alert is actually about.
   *
   * @returns {{requests: number, totalMs: number, errors: number}|null} null
   *          when no requests have been served since the last check, which is
   *          "nothing to say" rather than "everything is fine".
   */
  async readHttpWindow() {
    const metric = register.getSingleMetric('http_request_duration_ms');

    if (!metric) {
      return null;
    }

    let requests = 0;
    let totalMs = 0;
    let errors = 0;

    // `get()` resolves a promise in current prom-client, and reading it
    // synchronously silently produced `undefined` here.
    const { values } = await metric.get();

    (values || []).forEach(entry => {
      const status = Number(entry.labels?.status_code);

      if (entry.metricName === 'http_request_duration_ms_sum') {
        totalMs += entry.value;
      } else if (entry.metricName === 'http_request_duration_ms_count') {
        requests += entry.value;
        if (status >= 500) {
          errors += entry.value;
        }
      }
    });

    const previous = this.httpTotals;
    this.httpTotals = { requests, totalMs, errors };

    if (!previous) {
      // First check after start: establish the baseline rather than alerting on
      // everything that happened before the service was watching.
      return null;
    }

    const window = {
      requests: requests - previous.requests,
      totalMs: totalMs - previous.totalMs,
      errors: errors - previous.errors
    };

    // A negative delta means the registry was reset underneath us.
    if (window.requests <= 0) {
      return null;
    }

    return window;
  }
}

AlertService.createSmtpTransport = createSmtpTransport;

module.exports = AlertService;
