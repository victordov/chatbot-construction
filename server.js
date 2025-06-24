const express = require('express');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const http = require('http');
const dotenv = require('dotenv');
const setupWebSockets = require('./websockets');
const socketManager = require('./socketManager');
const sessionRoutes = require('./routes/session');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const gdprRoutes = require('./routes/gdpr');
const operationsRoutes = require('./routes/operations');
const taskRoutes = require('./routes/task');
const googleRoutes = require('./routes/google');
const companyRoutes = require('./routes/company');
// eslint-disable-next-line no-unused-vars
const { apiLimiter, chatLimiter } = require('./middleware/rateLimiter');
const DataRetentionService = require('./services/dataRetention');
const { logger, httpLogger } = require('./services/logging');
const { metricsMiddleware } = require('./services/monitoring');
const AlertService = require('./services/alerting');
const BackupService = require('./services/backup');
const WidgetUpdateService = require('./services/widgetUpdate');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);

// Database connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chatbot', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  logger.info('Connected to MongoDB');
}).catch(err => {
  logger.error('MongoDB connection error:', err);
});

app.use(express.json());

// Add HTTP request logging
app.use(httpLogger);

// Add Prometheus metrics middleware
app.use(metricsMiddleware);

// Create and serve static files
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}
app.use(express.static(publicDir));


// Domain whitelisting middleware
const allowedDomains = process.env.ALLOWED_DOMAINS
  ? process.env.ALLOWED_DOMAINS.split(',')
  : [
    'http://localhost:3000',
    'http://localhost:5500', // For local testing
    'http://127.0.0.1:5500' // For local testing
    // 'https://your-production-domain.com',
  ];

// CORS middleware for widget
app.use((req, res, next) => {
  const origin = req.get('Origin') || req.get('Referer');

  if (origin) {
    // Check if the origin is in our allowed domains list
    const isAllowed = allowedDomains.some(domain => origin.startsWith(domain));

    // Only set the specific origin that matches, never use a wildcard for production
    if (isAllowed) {
      // Set CORS headers with the specific origin
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      res.header('Access-Control-Allow-Credentials', 'true');

      // Set strict CORS policies
      res.header('Access-Control-Max-Age', '86400'); // 24 hours
      res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); // 1 year
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('X-Frame-Options', 'DENY');

      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
    } else {
      // If origin is not allowed, return 403 Forbidden
      return res.status(403).json({
        error: 'Access from this domain is not allowed.',
        message: 'Please contact the administrator to add your domain to the allowed list.'
      });
    }
  }

  next();
});

// Add session middleware globally
app.use(session({
  secret: process.env.SESSION_SECRET || 'chatbot-session-secret',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));
// Ensure every request has a sessionId
app.use((req, res, next) => {
  if (!req.session.sessionId) {
    req.session.sessionId = uuidv4();
  }
  next();
});

// Basic chat endpoint
app.post('/api/chat', (req, res) => {
  // Placeholder: echo back the message
  const { message } = req.body;
  logger.info('Will send back  to the client:'+ message);
  res.json({ reply: `You said: ${message}` });
});


// Register routes
app.use('/api/session', sessionRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/gdpr', gdprRoutes);
app.use('/api/operations', operationsRoutes);
app.use('/api/google', googleRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/companies', companyRoutes);

app.get('/', (req, res) => {
  res.send('Chatbot server is running.');
});

// Initialize WebSockets
const io = setupWebSockets(server);
// Set the io instance in the socketManager
socketManager.setIo(io);

// Initialize data retention service
const dataRetention = new DataRetentionService({
  activeRetention: process.env.ACTIVE_RETENTION_DAYS || 180,
  archivedRetention: process.env.ARCHIVED_RETENTION_DAYS || 365
});
dataRetention.start();

// Initialize alerting service
const alertService = new AlertService({
  enabled: process.env.ALERTS_ENABLED === 'true',
  emailEnabled: process.env.EMAIL_ALERTS_ENABLED === 'true',
  recipients: process.env.ALERT_RECIPIENTS?.split(',') || []
});
alertService.start();

// Initialize backup service
const backupService = new BackupService({
  mongoUri: process.env.MONGODB_URI,
  retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30')
});
backupService.start();

// Initialize widget update service
const widgetUpdateService = new WidgetUpdateService({
  currentVersion: process.env.WIDGET_VERSION || '1.0.0'
});
widgetUpdateService.start();

// Start the server
server.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
});
