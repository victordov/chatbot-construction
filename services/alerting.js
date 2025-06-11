/**
 * Alerting Service for Chatbot Application
 *
 * This service sets up alert triggers based on metrics and sends notifications
 * when thresholds are exceeded.
 */

const nodemailer = require('nodemailer');
const { ALERT_THRESHOLDS } = require('./monitoring');
const { logger } = require('./logging');

class AlertService {
  constructor(options = {}) {
    this.enabled = options.enabled || process.env.ALERTS_ENABLED === 'true';
    this.emailEnabled = options.emailEnabled || process.env.EMAIL_ALERTS_ENABLED === 'true';
    this.recipients = options.recipients || process.env.ALERT_RECIPIENTS?.split(',') || [];
    this.checkInterval = options.checkInterval || parseInt(process.env.ALERT_CHECK_INTERVAL || '60000');
    this.alertingState = new Map();

    // Configure email transport if both alerts and email alerts are enabled
    if (this.enabled && this.emailEnabled && process.env.SMTP_HOST) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD
        }
      });
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

    // Set up webhook handler for external alerts
    this.setupWebhookHandler();
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
      // This would typically fetch metrics from Prometheus or other sources
      // For now, we'll simulate some checks

      // Example: Check response time
      const avgResponseTime = await this.getAverageResponseTime();
      if (avgResponseTime > ALERT_THRESHOLDS.high_response_time) {
        this.triggerAlert('high_response_time', {
          title: 'High Response Time Detected',
          message: `Average response time (${avgResponseTime}ms) exceeds threshold (${ALERT_THRESHOLDS.high_response_time}ms)`,
          severity: 'warning',
          metrics: { avgResponseTime }
        });
      } else {
        this.resolveAlert('high_response_time');
      }

      // Example: Check error rate
      const errorRate = await this.getErrorRate();
      if (errorRate > ALERT_THRESHOLDS.high_error_rate) {
        this.triggerAlert('high_error_rate', {
          title: 'High Error Rate Detected',
          message: `Error rate (${(errorRate * 100).toFixed(2)}%) exceeds threshold (${(ALERT_THRESHOLDS.high_error_rate * 100).toFixed(2)}%)`,
          severity: 'critical',
          metrics: { errorRate }
        });
      } else {
        this.resolveAlert('high_error_rate');
      }

      // More checks would be added here for memory usage, CPU, disk space, etc.

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
   * Set up webhook handler for external alerts
   */
  setupWebhookHandler() {
    // This would be implemented in the express app
    // Example: app.post('/api/alerts/webhook', (req, res) => this.handleWebhook(req, res));
  }

  /**
   * Handle incoming webhook alerts
   */
  handleWebhook(req, res) {
    const { alertId, title, message, severity, metrics } = req.body;

    if (!alertId || !title || !message) {
      return res.status(400).json({ error: 'Missing required alert data' });
    }

    this.triggerAlert(alertId, { title, message, severity: severity || 'warning', metrics });

    res.status(200).json({ success: true });
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
   * Mock method to get average response time
   * In a real implementation, this would query Prometheus or other metrics sources
   */
  async getAverageResponseTime() {
    // Simulate a fluctuating response time
    return Math.random() * 3000; // 0-3000ms
  }

  /**
   * Mock method to get error rate
   * In a real implementation, this would query Prometheus or other metrics sources
   */
  async getErrorRate() {
    // Simulate a fluctuating error rate
    return Math.random() * 0.1; // 0-10%
  }
}

module.exports = AlertService;
