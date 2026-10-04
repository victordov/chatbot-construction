/**
 * Monitoring Service for Chatbot Application
 *
 * This service sets up Prometheus metrics collection for the application
 * and provides an endpoint for scraping metrics.
 */

const promClient = require('prom-client');
const promBundle = require('express-prom-bundle');

// Create a Registry to register the metrics
const register = new promClient.Registry();

// Custom metrics
const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [1, 5, 15, 50, 100, 200, 500, 1000, 2000, 5000]
});

const totalChatMessages = new promClient.Counter({
  name: 'chat_messages_total',
  help: 'Total number of chat messages processed',
  labelNames: ['status', 'type']
});

// Register metrics
register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(totalChatMessages);

// Middleware for Express
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  includeUp: true,
  customLabels: {
    application: 'chatbot-application'
  },
  promClient: {
    collectDefaultMetrics: {
      register
    }
  },
  metricsPath: '/metrics'
});

// Setup alerting thresholds
const ALERT_THRESHOLDS = {
  high_response_time: 2000, // ms
  high_error_rate: 0.05, // 5%
  high_memory_usage: 0.9, // 90%
  high_cpu_usage: 0.8, // 80%
  low_disk_space: 0.1, // 10%
  concurrent_connections: 1000
};

// Helper functions for tracking metrics
function trackChatMessage(status, type) {
  totalChatMessages.inc({ status, type });
}

// Export metrics registry and helper functions
module.exports = {
  register,
  metricsMiddleware,
  metrics: {
    trackChatMessage
  },
  ALERT_THRESHOLDS
};
