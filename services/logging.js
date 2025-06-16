/**
 * Logging Service for Chatbot Application
 *
 * This service sets up centralized logging for the application
 * using Winston with file rotation and console output.
 */

const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log levels and colors
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4
};

// eslint-disable-next-line no-unused-vars
const logColors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white'
};

// Create formatters
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}${info.meta ? ' ' + JSON.stringify(info.meta) : ''}`
  )
);

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.json()
);

// Create file transports with rotation
const errorFileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logsDir, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  level: 'error',
  format: fileFormat
});

const combinedFileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logsDir, 'combined-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  format: fileFormat
});

// Create console transport
const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug'
});

// Create logger
const logger = winston.createLogger({
  levels: logLevels,
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    errorFileTransport,
    combinedFileTransport,
    consoleTransport
  ],
  exitOnError: false
});

// Add request logger for HTTP requests
const httpLogger = (req, res, next) => {
  const start = Date.now();

  // Process the request
  res.on('finish', () => {
    const duration = Date.now() - start;
    const message = `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`;

    // Determine log level based on status code
    const level = res.statusCode >= 500 ? 'error' :
      res.statusCode >= 400 ? 'warn' : 'http';

    logger.log(level, message, {
      meta: {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        statusCode: res.statusCode,
        userAgent: req.get('user-agent'),
        referrer: req.get('referer'),
        responseTime: duration
      }
    });
  });

  next();
};

// Export logger and middleware
module.exports = {
  logger,
  httpLogger,

  // Shorthand logging methods
  error: (message, meta) => logger.error(message, { meta }),
  warn: (message, meta) => logger.warn(message, { meta }),
  info: (message, meta) => logger.info(message, { meta }),
  http: (message, meta) => logger.http(message, { meta }),
  debug: (message, meta) => logger.debug(message, { meta }),

  // Stream for Morgan integration if needed
  stream: {
    write: (message) => {
      logger.http(message.trim());
    }
  }
};
