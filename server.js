const express = require('express');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const http = require('http');
const crypto = require('crypto');
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
const knowledgeRoutes = require('./routes/knowledge');
const contactRoutes = require('./routes/contacts');
const emailRoutes = require('./routes/email');
const {
  apiLimiter,
  chatLimiter,
  authLimiter,
  loginAddressLimiter,
  passwordResetLimiter
} = require('./middleware/rateLimiter');
const DataRetentionService = require('./services/dataRetention');
const { logger, httpLogger } = require('./services/logging');
const { metricsMiddleware } = require('./services/monitoring');
const AlertService = require('./services/alerting');
const BackupService = require('./services/backup');
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
  // Every script and stylesheet is served from here: the dashboard's
  // libraries are bundled into public/dist by scripts/build-client.js rather
  // than fetched from a CDN, so no third-party origin is allowed at all.
  // Bootstrap relies on inline styles. Script is never inline, so
  // 'unsafe-inline' is not in scriptSrc and an injected <script> tag has
  // nowhere to run.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ['\'self\''],
      scriptSrc: ['\'self\''],
      // Inline handler attributes are covered separately so they stay
      // blocked even though inline <style> is allowed.
      scriptSrcAttr: ['\'none\''],
      styleSrc: ['\'self\'', '\'unsafe-inline\''],
      imgSrc: ['\'self\'', 'data:', 'https:'],
      connectSrc: ['\'self\'', 'ws:', 'wss:'],
      fontSrc: ['\'self\'', 'data:'],
      objectSrc: ['\'none\''],
      frameAncestors: ['\'self\'']
    }
  },
  // The widget is embedded cross-origin by design.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
}));

app.use(compression());
app.use(express.json({
  limit: '1mb',
  // Stripe signs the bytes it sent, so a body that has been parsed and
  // re-serialised can never be verified. Kept for that one path rather than
  // for every request, since holding a copy of every body is a memory cost
  // paid on the hot path for the benefit of one endpoint.
  verify: (req, res, buffer) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/billing/webhook')) {
      req.rawBody = buffer;
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(httpLogger);

/**
 * Guard for the Prometheus endpoint.
 *
 * `/metrics` lists every route with its request counts, error rates and
 * process details - a map of the deployment. It answers to a bearer token
 * from METRICS_TOKEN, and in production refuses to exist without one: an
 * unset variable must fail closed, not open a public dashboard.
 *
 * A factory rather than a bare middleware so the production rule can be
 * tested without booting the process in production mode.
 */
function metricsGuard({ token = process.env.METRICS_TOKEN, isProduction = config.isProduction } = {}) {
  const expected = token ? crypto.createHash('sha256').update(token).digest() : null;

  return (req, res, next) => {
    if (!expected) {
      if (isProduction) {
        // Indistinguishable from a route that does not exist.
        return res.status(404).json({ error: 'Not found' });
      }
      return next();
    }

    const header = req.get('authorization') || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    // Both sides hashed to the same length so the comparison is constant-time
    // whatever the length of what was sent.
    const given = crypto.createHash('sha256').update(presented).digest();

    if (!presented || !crypto.timingSafeEqual(expected, given)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return next();
  };
}

app.use('/metrics', metricsGuard());
app.use(metricsMiddleware);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

async function corsPolicy(req, res, next) {
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

  // A monitoring probe that happens to send an Origin header must still be
  // able to ask whether the process is alive. These answer no tenant data.
  if (req.path === '/health' || req.path === '/ready') {
    return next();
  }

  try {
    // Tenant domains live in the database, so onboarding a customer no longer
    // requires editing ALLOWED_DOMAINS and redeploying.
    let allowed = await tenantService.isOriginAllowed(origin);

    // A valid widget key is the higher-confidence signal - it is the thing the
    // tenant deliberately pasted onto their page, whereas the domain list is
    // something they have to remember to fill in separately. Without this, a
    // correct install on an unregistered domain got a hard 403 whose helpful
    // message the browser never showed, because a 403 carries no
    // Access-Control-Allow-Origin header and the fetch fails as a generic CORS
    // error. That is the "the widget just doesn't load" ticket.
    //
    // But a widget key is public - it is in the page source of every site
    // that embeds the widget - so it proves which tenant a page belongs to
    // and nothing about the page itself. An origin let in on the strength of
    // a key gets the widget's own anonymous traffic through and no more: no
    // cookies, no Authorization header. Only an origin the tenant registered
    // (or ALLOWED_DOMAINS names) is trusted with credentials, since that is
    // the list a stolen key cannot add itself to.
    let credentialed = allowed;
    if (!allowed && typeof req.query.key === 'string' && req.query.key) {
      allowed = Boolean(await tenantService.resolveCompanyId({ widgetKey: req.query.key }));
      credentialed = false;
    }

    if (!allowed) {
      logger.warn('Blocked cross-origin request', { origin, path: req.path });
      return res.status(403).json({
        error: 'Access from this domain is not allowed.',
        message: 'Please register this domain for your company in the admin dashboard.'
      });
    }

    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    // The API has PUT, PATCH and DELETE routes throughout; advertising only
    // GET and POST fails the preflight for every one of them.
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-auth-token');
    if (credentialed) {
      res.header('Access-Control-Allow-Credentials', 'true');
    }
    res.header('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    next();
  } catch (error) {
    next(error);
  }
}

app.use(corsPolicy);

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

// The public read API. Versioned, and mounted ahead of the general limiter
// because it has its own: a key on an enterprise plan syncing a warehouse
// should not be held to the per-address allowance meant for traffic that has
// not said who it is.
app.use('/api/v1', require('./routes/public-api'));

// Rate limiters were defined but never applied, leaving login open to
// unlimited brute force and the chat endpoint open to flooding.
// Per account first, then the per-address ceiling over all accounts: the
// first catches somebody hammering one login, the second somebody spraying a
// password across many.
app.use('/api/auth/login', authLimiter, loginAddressLimiter);
// Reset requests always succeed from the outside, so they get a limiter that
// counts every request rather than only failures.
app.use('/api/auth/forgot-password', passwordResetLimiter);
app.use('/api/auth/reset-password', passwordResetLimiter);
app.use('/api/chat', chatLimiter);
app.use('/api', apiLimiter);

app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/gdpr', gdprRoutes);
app.use('/api/operations', operationsRoutes);
app.use('/api/google', googleRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/workflow-execution', workflowExecutionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/widget', widgetRoutes);
app.use('/api/upload', ensureSessionId, uploadRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/knowledge', knowledgeRoutes);
// Ask the live bot a question from the dashboard, without a conversation.
app.use('/api/bot', require('./routes/bot'));
app.use('/api/contacts', contactRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/api-keys', require('./routes/api-keys'));

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

  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600
    ? err.status
    : 500;

  // In production the message is generic unless the error was built to be
  // shown (body-parser's "request entity too large", for instance, sets
  // `expose`). Anything else - a mongoose message quoting a field name, a
  // path from a failed require - stays in the log.
  const shown = !config.isProduction || (status < 500 && err.expose === true);

  res.status(status).json({
    error: shown ? err.message : (status < 500 ? 'Bad request' : 'Internal server error')
  });
});

// ---------------------------------------------------------------------------
// Realtime + background services
// ---------------------------------------------------------------------------

const io = setupWebSockets(server);
socketManager.setIo(io);
workflowExecutionRoutes.initializeServices(socketManager);

// Platform defaults only: a company's own policy overrides these, and the
// default of both is "never". Deleting a tenant's history because nobody set
// an environment variable is not a decision the platform should make for them.
// `ARCHIVED_RETENTION_DAYS` is honoured so deployments that had set it keep
// the behaviour they had.
const dataRetention = new DataRetentionService({
  anonymizeAfterDays: process.env.RETENTION_ANONYMIZE_DAYS,
  deleteAfterDays: process.env.RETENTION_DELETE_DAYS || process.env.ARCHIVED_RETENTION_DAYS
});

const alertService = new AlertService({
  enabled: process.env.ALERTS_ENABLED === 'true',
  emailEnabled: process.env.EMAIL_ALERTS_ENABLED === 'true',
  recipients: process.env.ALERT_RECIPIENTS?.split(',') || []
});

const backupService = new BackupService({
  mongoUri: config.mongoUri,
  retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10)
});

// Every job below writes to the shared database or sends mail, so with several
// instances behind a load balancer each one would sweep, back up and alert on
// its own: N backups a night and N copies of every alert email.
// SCHEDULER_ENABLED (default true) picks the instance that runs them; with more
// than one instance, set it to true on exactly one.
//
// Alerting is gated with the rest because it only *reads* the Prometheus
// registry and emails when a threshold is crossed. The metrics themselves are
// collected by `metricsMiddleware` (services/monitoring.js) on every instance
// regardless, so /metrics keeps working where this is false.
const schedulerEnabled = process.env.SCHEDULER_ENABLED !== 'false';

if (schedulerEnabled) {
  dataRetention.start();
  alertService.start();
  backupService.start();
  schedulerService.initialize();
} else {
  logger.info('SCHEDULER_ENABLED=false: retention, alerting, backups and cron jobs are left to another instance');
}

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

    [dataRetention, alertService, backupService, schedulerService]
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

// `corsPolicy` and `metricsGuard` are exported so their rules can be tested
// against a bare express app rather than the whole process.
module.exports = { app, server, corsPolicy, metricsGuard };
