const express = require('express');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const http = require('http');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
// connect-mongo v6 ships an ES module; under CommonJS the store is on `.default`.
const MongoStore = require('connect-mongo').default || require('connect-mongo');
const { v4: uuidv4 } = require('uuid');

const config = require('./config/env');
const setupWebSockets = require('./websockets');
const socketManager = require('./socketManager');
const tenantService = require('./services/tenant');
const assetManifest = require('./services/asset-manifest');
const sessionRoutes = require('./routes/session');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const gdprRoutes = require('./routes/gdpr');
const operationsRoutes = require('./routes/operations');
const taskRoutes = require('./routes/task');
const googleRoutes = require('./routes/google');
const companyRoutes = require('./routes/company');
const notificationRoutes = require('./routes/notification');
const workflowRoutes = require('./routes/workflow');
const workflowExecutionRoutes = require('./routes/workflow-execution');
const widgetRoutes = require('./routes/widget');
const uploadRoutes = require('./routes/upload');
const billingRoutes = require('./routes/billing');
const templateRoutes = require('./routes/templates');
const { apiLimiter, chatLimiter, authLimiter } = require('./middleware/rateLimiter');
const DataRetentionService = require('./services/dataRetention');
const { logger, httpLogger } = require('./services/logging');
const { metricsMiddleware } = require('./services/monitoring');
const AlertService = require('./services/alerting');
const BackupService = require('./services/backup');
const WidgetUpdateService = require('./services/widgetUpdate');
const schedulerService = require('./services/scheduler');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const { errors: configErrors, warnings: configWarnings } = config.validate();
configWarnings.forEach(warning => logger.warn(`Config: ${warning}`));
if (configErrors.length > 0) {
  configErrors.forEach(error => logger.error(`Config: ${error}`));
  throw new Error(`Refusing to start with an insecure configuration:\n  - ${configErrors.join('\n  - ')}`);
}

const app = express();
const PORT = config.port;
const server = http.createServer(app);

// Behind a load balancer, express needs to trust X-Forwarded-* so that secure
// cookies and per-IP rate limiting work against the real client address.
if (config.trustProxy) {
  app.set('trust proxy', config.trustProxy);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

mongoose.connect(config.mongoUri, {
  serverSelectionTimeoutMS: 10000,
  maxPoolSize: parseInt(process.env.MONGO_POOL_SIZE, 10) || 20
}).then(() => {
  logger.info('Connected to MongoDB');
}).catch(err => {
  logger.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));

// ---------------------------------------------------------------------------
// Core middleware
// ---------------------------------------------------------------------------

app.use(helmet({
  // The admin dashboard and widget load Bootstrap/Chart.js/socket.io from CDNs
  // and use inline styles, so CSP is configured rather than left at helmet's
  // defaults (which would block them outright).
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ['\'self\''],
      scriptSrc: ['\'self\'', '\'unsafe-inline\'', 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      styleSrc: ['\'self\'', '\'unsafe-inline\'', 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      imgSrc: ['\'self\'', 'data:', 'https:'],
      connectSrc: ['\'self\'', 'ws:', 'wss:'],
      fontSrc: ['\'self\'', 'data:', 'https://cdn.jsdelivr.net'],
      objectSrc: ['\'none\''],
      frameAncestors: ['\'self\'']
    }
  },
  // The widget is embedded cross-origin by design.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
}));

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(httpLogger);
app.use(metricsMiddleware);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

app.use(async (req, res, next) => {
  const origin = req.get('Origin');

  // Direct navigation sends no Origin at all.
  if (!origin) {
    return next();
  }

  // Browsers also send Origin on same-origin POST/PUT/DELETE, so the admin
  // dashboard's own requests arrive with one. Those are never cross-origin and
  // must not depend on the server's URL being in an allowlist.
  const selfOrigin = `${req.protocol}://${req.get('host')}`;
  if (origin === selfOrigin) {
    return next();
  }

  try {
    // Tenant domains live in the database, so onboarding a customer no longer
    // requires editing ALLOWED_DOMAINS and redeploying.
    const allowed = await tenantService.isOriginAllowed(origin);

    if (!allowed) {
      logger.warn('Blocked cross-origin request', { origin, path: req.path });
      return res.status(403).json({
        error: 'Access from this domain is not allowed.',
        message: 'Please register this domain for your company in the admin dashboard.'
      });
    }

    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-auth-token');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    next();
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  // Only persist sessions that actually hold something. The previous `true`
  // wrote a session document for every bot and preflight request.
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: config.mongoUri,
    ttl: 24 * 60 * 60,
    touchAfter: 3600,
    collectionName: 'sessions'
  }),
  cookie: {
    httpOnly: true,
    secure: config.isProduction,
    // The widget runs inside a third-party page, so the cookie must be
    // cross-site capable in production (which requires Secure).
    sameSite: config.isProduction ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Ensure every chat request has a sessionId
app.use('/api/session', ensureSessionId);
app.use('/api/chat', ensureSessionId);
app.use('/api/gdpr/consent', ensureSessionId);

function ensureSessionId(req, res, next) {
  if (req.session && !req.session.sessionId) {
    req.session.sessionId = uuidv4();
  }
  next();
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}

// Content-hashed widget assets. Built once at startup; see
// services/asset-manifest.js for why the loader itself is not hashed.
assetManifest.build();

/**
 * Serve `widget/js/widget.<hash>.js` from `widget/js/widget.js`.
 *
 * Any hash resolves to the current file, so a page that loaded just before a
 * deploy still gets a working widget instead of a 404 mid-conversation.
 */
app.get(/^\/widget\/.+\.[a-f0-9]{8}\.(js|css)$/, (req, res, next) => {
  const resolved = assetManifest.resolveHashedPath(req.path);

  if (!resolved) {
    return next();
  }

  // The URL changes whenever the content does, so this can be cached hard.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(publicDir, resolved), error => {
    if (error) {
      next(error);
    }
  });
});

app.use(express.static(publicDir, {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    // Vendored libraries are pinned to a version by their filename, so they
    // are safe to cache hard.
    if (filePath.includes(`${path.sep}lib${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return;
    }

    // Everything else uses `no-cache`: it still revalidates cheaply via ETag
    // and returns a 304, but guarantees a deploy reaches users on their next
    // request. This covers the widget loader, whose URL is pasted into
    // customer sites and can never change, and the dashboard.
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

// Liveness: the process is up. Must not touch dependencies.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: the process can serve traffic (i.e. the database is reachable).
app.get('/ready', (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? 'ready' : 'not-ready',
    database: dbReady ? 'connected' : 'disconnected'
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Rate limiters were defined but never applied, leaving login open to
// unlimited brute force and the chat endpoint open to flooding.
app.use('/api/auth/login', authLimiter);
app.use('/api/chat', chatLimiter);
app.use('/api', apiLimiter);

app.use('/api/session', sessionRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/gdpr', gdprRoutes);
app.use('/api/operations', operationsRoutes);
app.use('/api/google', googleRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/workflow-execution', workflowExecutionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/widget', widgetRoutes);
app.use('/api/upload', ensureSessionId, uploadRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/templates', templateRoutes);

app.get('/', (req, res) => {
  res.redirect('/admin/');
});

// 404 for unmatched API routes (otherwise they fall through to the SPA/static
// handler and return HTML to a client expecting JSON).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// Central error handler. Without this, a thrown error in any handler produced
// an HTML stack trace, leaking file paths to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled request error', {
    error: err.message,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method
  });

  if (res.headersSent) {
    return;
  }

  res.status(err.status || 500).json({
    error: config.isProduction ? 'Internal server error' : err.message
  });
});

// ---------------------------------------------------------------------------
// Realtime + background services
// ---------------------------------------------------------------------------

const io = setupWebSockets(server);
socketManager.setIo(io);
workflowExecutionRoutes.initializeServices(socketManager);

const dataRetention = new DataRetentionService({
  activeRetention: process.env.ACTIVE_RETENTION_DAYS || 180,
  archivedRetention: process.env.ARCHIVED_RETENTION_DAYS || 365
});
dataRetention.start();

const alertService = new AlertService({
  enabled: process.env.ALERTS_ENABLED === 'true',
  emailEnabled: process.env.EMAIL_ALERTS_ENABLED === 'true',
  recipients: process.env.ALERT_RECIPIENTS?.split(',') || []
});
alertService.start();

const backupService = new BackupService({
  mongoUri: config.mongoUri,
  retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10)
});
backupService.start();

const widgetUpdateService = new WidgetUpdateService({
  currentVersion: process.env.WIDGET_VERSION || '1.0.0'
});
widgetUpdateService.start();

schedulerService.initialize();

// ---------------------------------------------------------------------------
// Startup and graceful shutdown
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT} (${config.env})`);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully`);

  // Stop accepting new work, then drain.
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 15000);
  forceExit.unref();

  try {
    io.close();
    await new Promise(resolve => server.close(resolve));

    [dataRetention, alertService, backupService, widgetUpdateService, schedulerService]
      .forEach(service => {
        if (service && typeof service.stop === 'function') {
          try {
            service.stop();
          } catch (error) {
            logger.warn('Error stopping background service', { error: error.message });
          }
        }
      });

    await mongoose.connection.close(false);
    logger.info('Shutdown complete');
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', reason => {
  logger.error('Unhandled promise rejection', { reason: reason?.message || reason, stack: reason?.stack });
});

process.on('uncaughtException', error => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  shutdown('uncaughtException');
});

module.exports = { app, server };
