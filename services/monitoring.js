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

const chatResponseTime = new promClient.Histogram({
  name: 'chat_response_time_ms',
  help: 'Response time of chat messages in ms',
  labelNames: ['status'],
  buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
});

const concurrentWebsocketConnections = new promClient.Gauge({
  name: 'websocket_connections_current',
  help: 'Number of currently active WebSocket connections'
});

const totalChatMessages = new promClient.Counter({
  name: 'chat_messages_total',
  help: 'Total number of chat messages processed',
  labelNames: ['status', 'type']
});

const activeSessionsGauge = new promClient.Gauge({
  name: 'active_sessions_current',
  help: 'Number of currently active chat sessions'
});

const fileUploadsCounter = new promClient.Counter({
  name: 'file_uploads_total',
  help: 'Total number of file uploads',
  labelNames: ['status', 'file_type']
});

const rateLimit = new promClient.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['endpoint']
});

// Register metrics
register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(chatResponseTime);
register.registerMetric(concurrentWebsocketConnections);
register.registerMetric(totalChatMessages);
register.registerMetric(activeSessionsGauge);
register.registerMetric(fileUploadsCounter);
register.registerMetric(rateLimit);

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

function startChatResponseTimer() {
  return chatResponseTime.startTimer();
}

function incrementWebSocketConnections() {
  concurrentWebsocketConnections.inc();
}

function decrementWebSocketConnections() {
  concurrentWebsocketConnections.dec();
}

function setActiveSessions(count) {
  activeSessionsGauge.set(count);
}

function trackFileUpload(status, fileType) {
  fileUploadsCounter.inc({ status, fileType });
}

function trackRateLimitHit(endpoint) {
  rateLimit.inc({ endpoint });
}

// Export metrics registry and helper functions
module.exports = {
  register,
  metricsMiddleware,
  metrics: {
    trackChatMessage,
    startChatResponseTimer,
    incrementWebSocketConnections,
    decrementWebSocketConnections,
    setActiveSessions,
    trackFileUpload,
    trackRateLimitHit
  },
  ALERT_THRESHOLDS
};
