# Operations and Deployment Guide

This document provides an overview of the operations and deployment infrastructure for the Chatbot Application.

## Table of Contents

1. [Monitoring and Alerting](#monitoring-and-alerting)
2. [Logging Infrastructure](#logging-infrastructure)
3. [Backup and Disaster Recovery](#backup-and-disaster-recovery)
4. [Widget Update Mechanism](#widget-update-mechanism)
5. [Load Testing](#load-testing)

## Monitoring and Alerting

The application includes a comprehensive monitoring and alerting system based on Prometheus metrics.

### Metrics Collection

The monitoring service collects various metrics:

- HTTP request durations
- Chat response times
- WebSocket connection counts
- Chat message counts
- Active session counts
- File upload statistics
- Rate limiter hits

These metrics are exposed via the `/metrics` endpoint in Prometheus format, which can be scraped by a Prometheus server.

### Alert Thresholds

The system monitors for the following conditions:

- High response time (> 2000ms)
- High error rate (> 5%)
- High memory usage (> 90%)
- High CPU usage (> 80%)
- Low disk space (< 10%)
- Too many concurrent connections (> 1000)

### Alert Notifications

When thresholds are exceeded, alerts are sent via:

- Email (configured via SMTP settings in .env)
- Additional channels can be added (Slack, SMS, etc.)

### Setup Instructions

1. Install Prometheus and Grafana
2. Configure Prometheus to scrape the `/metrics` endpoint
3. Import the provided Grafana dashboards
4. Configure alert notification channels

### Environment Variables

```
ALERTS_ENABLED=true
ALERT_RECIPIENTS=admin@example.com,ops@example.com
ALERT_CHECK_INTERVAL=60000
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=alerts@example.com
SMTP_PASSWORD=your-smtp-password
```

## Logging Infrastructure

The application uses a centralized logging system based on Winston.

### Log Levels

- **error**: System errors requiring immediate attention
- **warn**: Warning conditions
- **info**: Informational messages
- **http**: HTTP request logging
- **debug**: Detailed debug information

### Log Storage

Logs are stored in the `logs` directory with the following files:

- `error-YYYY-MM-DD.log`: Contains only error-level logs
- `combined-YYYY-MM-DD.log`: Contains all logs

Logs are automatically rotated daily and compressed after 14 days.

### HTTP Request Logging

All HTTP requests are logged with:

- Method and URL
- Status code
- Response time
- Client IP and user agent
- Referrer

### Environment Variables

```
LOG_LEVEL=info
```

## Backup and Disaster Recovery

The application includes an automated backup and disaster recovery system.

### Backup Schedule

Backups are performed daily by default and include:

- MongoDB database (using mongodump)
- Configuration files (.env, package.json, etc.)

### Backup Retention

Backups are retained for 30 days by default, with older backups automatically pruned.

### Restoration Process

To restore from a backup:

1. Stop the application
2. Run the restoration command: `node scripts/restore.js --timestamp=BACKUP_TIMESTAMP`
3. Restart the application

### Environment Variables

```
MONGODB_URI=mongodb://localhost:27017/chatbot
BACKUP_RETENTION_DAYS=30
BACKUP_INTERVAL_HOURS=24
```

## Widget Update Mechanism

The widget update service manages versioning and deployment of client-side widgets.

### Version Management

- Each widget version is archived with a checksum
- Version history is maintained
- Automatic version incrementation for changes

### Deployment Process

To deploy a specific widget version:

1. Access the admin dashboard
2. Navigate to the Widget Management section
3. Select the desired version
4. Click "Deploy"

### Rollback Process

If issues are detected with a new widget version:

1. Access the admin dashboard
2. Navigate to the Widget Management section
3. Select the previous stable version
4. Click "Deploy"

### Environment Variables

```
WIDGET_VERSION=1.0.0
```

## Load Testing

The application includes a load testing script to simulate high traffic scenarios.

### Running Load Tests

```
node scripts/load-test.js [users] [duration] [rampUp]
```

Parameters:
- `users`: Number of concurrent users (default: 100)
- `duration`: Test duration in seconds (default: 60)
- `rampUp`: Ramp-up period in seconds (default: 10)

### Test Scenarios

The load test includes several scenarios:

- Chat API calls
- Session API calls
- Static page requests
- WebSocket connections

### Test Results

Results are saved to the `load-test-results` directory and include:

- Request counts and rates
- Error rates
- Latency statistics
- Status code distribution

### Interpreting Results

Look for:
- Request throughput (requests per second)
- Error rate (should be < 1%)
- Response latency (p95 should be < 500ms)
- CPU and memory usage during tests
