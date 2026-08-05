/**
 * Environment loading and validation.
 *
 * Fails fast on misconfiguration rather than silently falling back to a
 * hard-coded development secret in production, which would let anyone forge a
 * valid JWT or session cookie.
 */

const dotenv = require('dotenv');

dotenv.config();

const DEV_FALLBACKS = {
  JWT_SECRET: 'chatbot-jwt-secret',
  SESSION_SECRET: 'chatbot-session-secret'
};

/**
 * @returns {{errors: string[], warnings: string[]}}
 */
function validate() {
  const errors = [];
  const warnings = [];
  const isProduction = process.env.NODE_ENV === 'production';

  const required = ['MONGODB_URI', 'JWT_SECRET', 'SESSION_SECRET'];

  required.forEach(name => {
    const value = process.env[name];

    if (!value) {
      if (isProduction) {
        errors.push(`${name} is required in production`);
      } else {
        warnings.push(`${name} is not set; using an insecure development default`);
      }
      return;
    }

    if (isProduction && DEV_FALLBACKS[name] === value) {
      errors.push(`${name} still uses the built-in development value`);
    }

    if (isProduction && name.endsWith('_SECRET') && value.length < 32) {
      errors.push(`${name} must be at least 32 characters in production`);
    }
  });

  if (isProduction && !process.env.ALLOWED_DOMAINS) {
    warnings.push('ALLOWED_DOMAINS is not set; only tenant-registered domains will be accepted');
  }

  if (!process.env.OPENAI_API_KEY) {
    warnings.push('OPENAI_API_KEY is not set; AI responses and suggestions will be disabled');
  }

  if (!process.env.GOOGLE_CLIENT_ID) {
    warnings.push('GOOGLE_CLIENT_ID is not set; Google knowledge import will be disabled');
  }

  return { errors, warnings };
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: parseInt(process.env.PORT, 10) || 3000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/chatbot',
  jwtSecret: process.env.JWT_SECRET || DEV_FALLBACKS.JWT_SECRET,
  sessionSecret: process.env.SESSION_SECRET || DEV_FALLBACKS.SESSION_SECRET,
  trustProxy: process.env.TRUST_PROXY || (process.env.NODE_ENV === 'production' ? 1 : false),
  validate
};

module.exports = config;
