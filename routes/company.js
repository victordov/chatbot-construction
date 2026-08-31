const express = require('express');
const Company = require('../models/company');
const User = require('../models/user');
const tenantService = require('../services/tenant');
const availabilityService = require('../services/availability');
const { auth, superadmin, admin, sameCompany } = require('../middleware/auth');
const { logger } = require('../services/logging');
const connectorService = require('../services/connector');
const capabilityContract = require('../config/capabilities');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const audit = require('../services/audit');
const DataRetentionService = require('../services/dataRetention');
const crypto = require('crypto');

const router = express.Router();

/**
 * A retention service configured exactly as the running sweep is, so what this
 * screen says the platform default is cannot drift from what the sweep does.
 */
function retentionService() {
  return new DataRetentionService({
    anonymizeAfterDays: process.env.RETENTION_ANONYMIZE_DAYS,
    deleteAfterDays: process.env.RETENTION_DELETE_DAYS || process.env.ARCHIVED_RETENTION_DAYS
  });
}

// Helper function to generate a random password
function generateRandomPassword(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
  let password = '';
  const randomBytes = crypto.randomBytes(length);

  for (let i = 0; i < length; i++) {
    const randomIndex = randomBytes[i] % chars.length;
    password += chars.charAt(randomIndex);
  }

  return password;
}

// Apply auth middleware to all routes
router.use(auth);

// Get all companies (superadmin only)
router.get('/', superadmin, async (req, res) => {
  try {
    const companies = await Company.find().sort({ name: 1 });
    res.json({ companies });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to retrieve companies' });
  }
});

/**
 * Widget configuration for the caller's own company.
 *
 * Company admins need to install and brand their widget without waiting on a
 * superadmin, so these routes are scoped to `req.user.company` rather than
 * taking an id.
 */
function requireOwnCompany(req, res, next) {
  if (req.user.role !== 'superadmin' && req.user.role !== 'company_admin') {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  if (!req.user.company) {
    return res.status(400).json({ error: 'Your account is not linked to a company' });
  }
  next();
}

router.get('/me/widget', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id)
      .select('name widgetKey allowedDomains widgetSettings');

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Older companies predate widgetKey; mint one on first read.
    if (!company.widgetKey) {
      await company.save();
    }

    res.json({
      widgetKey: company.widgetKey,
      allowedDomains: company.allowedDomains || [],
      widgetSettings: company.widgetSettings || {},
      companyName: company.name
    });
  } catch (error) {
    console.error('Error fetching widget config:', error);
    res.status(500).json({ error: 'Failed to load widget configuration' });
  }
});

router.put('/me/widget', requireOwnCompany, async (req, res) => {
  try {
    const { allowedDomains, widgetSettings } = req.body;
    const company = await Company.findById(req.user.company.id);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    if (Array.isArray(allowedDomains)) {
      const normalised = [];
      for (const raw of allowedDomains) {
        const value = String(raw || '').trim().toLowerCase().replace(/\/+$/, '');
        if (!value) {
          continue;
        }
        // A malformed origin would silently never match, so reject it loudly.
        try {
          const url = new URL(value);
          normalised.push(`${url.protocol}//${url.host}`);
        } catch {
          return res.status(400).json({
            error: `"${raw}" is not a valid origin. Include the scheme, e.g. https://example.com`
          });
        }
      }
      company.allowedDomains = [...new Set(normalised)];
    }

    if (widgetSettings && typeof widgetSettings === 'object') {
      const allowed = ['chatbotName', 'primaryColor', 'position', 'welcomeMessage', 'logoUrl'];
      company.widgetSettings = company.widgetSettings || {};
      allowed.forEach(key => {
        if (widgetSettings[key] !== undefined) {
          company.widgetSettings[key] = widgetSettings[key];
        }
      });
    }

    await company.save();
    tenantService.invalidate();

    res.json({
      success: true,
      allowedDomains: company.allowedDomains,
      widgetSettings: company.widgetSettings
    });
  } catch (error) {
    console.error('Error updating widget config:', error);
    res.status(500).json({ error: 'Failed to update widget configuration' });
  }
});

/**
 * When this company is open. Read and written by its own admins.
 */
router.get('/me/hours', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id).select('businessHours').lean();
    const availability = await availabilityService.status(req.user.company.id);

    res.json({
      businessHours: company?.businessHours || { enabled: false, timezone: 'UTC', days: [] },
      // What a visitor would see right now, so an admin can sanity-check the
      // schedule they just entered against reality.
      current: availability
    });
  } catch (error) {
    console.error('Error loading business hours:', error);
    res.status(500).json({ error: 'Failed to load business hours' });
  }
});

router.put('/me/hours', requireOwnCompany, async (req, res) => {
  try {
    const { enabled, timezone, days, offlineMessage } = req.body;
    const company = await Company.findById(req.user.company.id);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    if (timezone) {
      // Reject an unknown zone rather than storing it and silently falling
      // back to UTC every time the schedule is evaluated.
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date());
      } catch {
        return res.status(400).json({ error: `"${timezone}" is not a recognised timezone` });
      }
    }

    const cleanDays = Array.isArray(days)
      ? days
        .filter(day => Number.isInteger(day.day) && day.day >= 0 && day.day <= 6)
        .map(day => {
          const opensAt = Number(day.opensAt);
          const closesAt = Number(day.closesAt);
          return {
            day: day.day,
            closed: Boolean(day.closed),
            opensAt: Number.isFinite(opensAt) ? Math.max(0, Math.min(1440, opensAt)) : 0,
            closesAt: Number.isFinite(closesAt) ? Math.max(0, Math.min(1440, closesAt)) : 1440
          };
        })
      : [];

    const backwards = cleanDays.find(day => !day.closed && day.closesAt <= day.opensAt);
    if (backwards) {
      return res.status(400).json({
        error: 'Closing time must be after opening time. Overnight hours are not supported yet.'
      });
    }

    company.businessHours = {
      enabled: Boolean(enabled),
      timezone: timezone || 'UTC',
      days: cleanDays,
      offlineMessage: offlineMessage !== undefined
        ? String(offlineMessage).trim()
        : company.businessHours?.offlineMessage
    };

    await company.save();
    availabilityService.invalidate(req.user.company.id);

    res.json({
      success: true,
      businessHours: company.businessHours,
      current: await availabilityService.status(req.user.company.id)
    });
  } catch (error) {
    console.error('Error saving business hours:', error);
    res.status(500).json({ error: 'Failed to save business hours' });
  }
});

/**
 * Email channel settings, including the inbound webhook URL a tenant points
 * their mail provider at.
 */
/**
 * How long this company keeps its conversations.
 *
 * A tenant's own obligations are not the platform's, so the policy belongs to
 * them; the platform's numbers are only what applies until they choose. The
 * counts come back with it because "delete after 30 days" means nothing to
 * somebody who cannot see that it would drop four thousand conversations
 * tonight.
 */
router.get('/me/retention', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id).select('dataRetention').lean();

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const service = retentionService();
    const policy = service.policyFor(company);
    const preview = await service.preview(req.user.company.id, policy);

    res.json({
      dataRetention: company.dataRetention || {},
      effective: policy,
      platformDefaults: service.defaults,
      impact: { toDelete: preview.toDelete, toAnonymize: preview.toAnonymize }
    });
  } catch (error) {
    logger.error('Error loading retention policy', { error: error.message });
    res.status(500).json({ error: 'Failed to load retention policy' });
  }
});

router.put('/me/retention', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // `null` means "follow the platform default" and 0 means "never". Both are
    // choices, and conflating them would make one of them unsayable.
    const parse = (value, label) => {
      if (value === null || value === undefined || value === '') {
        return null;
      }
      const days = Number(value);
      if (!Number.isInteger(days) || days < 0) {
        throw new Error(`${label} must be a whole number of days, or 0 for never`);
      }
      if (days > 3650) {
        throw new Error(`${label} cannot be more than 3650 days`);
      }
      return days;
    };

    let anonymizeAfterDays;
    let deleteAfterDays;

    try {
      anonymizeAfterDays = parse(req.body.anonymizeAfterDays, 'Anonymise after');
      deleteAfterDays = parse(req.body.deleteAfterDays, 'Delete after');
    } catch (validationError) {
      return res.status(400).json({ error: validationError.message });
    }

    if (anonymizeAfterDays > 0 && deleteAfterDays > 0 && deleteAfterDays < anonymizeAfterDays) {
      return res.status(400).json({
        error: 'Conversations cannot be deleted before they are anonymised. '
          + 'Either raise the deletion window or lower the anonymisation one.'
      });
    }

    const previous = company.dataRetention ? company.dataRetention.toObject() : {};

    company.dataRetention = {
      anonymizeAfterDays,
      deleteAfterDays,
      updatedAt: new Date(),
      updatedBy: req.user.displayName || req.user.username
    };

    await company.save();

    // Shortening a retention window destroys data on a schedule. Who chose it
    // and when is exactly the sort of thing somebody has to answer for later.
    await audit.record({
      action: 'company.retention_changed',
      req,
      target: { type: 'company', id: String(company._id), label: company.name },
      details: {
        from: { anonymizeAfterDays: previous.anonymizeAfterDays, deleteAfterDays: previous.deleteAfterDays },
        to: { anonymizeAfterDays, deleteAfterDays }
      }
    });

    const service = retentionService();
    const policy = service.policyFor(company);
    const preview = await service.preview(company._id, policy);

    res.json({
      success: true,
      dataRetention: company.dataRetention,
      effective: policy,
      impact: { toDelete: preview.toDelete, toAnonymize: preview.toAnonymize }
    });
  } catch (error) {
    logger.error('Error saving retention policy', { error: error.message });
    res.status(500).json({ error: 'Failed to save retention policy' });
  }
});

/**
 * The tenant's own systems, through the connector SDK.
 */
router.get('/me/connector', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id)
      .select('+connector.secret').lean();

    const connector = company?.connector || {};

    res.json({
      connector: {
        enabled: Boolean(connector.enabled),
        url: connector.url || '',
        // Whether one exists, never the value. It was shown once when it was
        // generated; showing it again only widens who can read it.
        hasSecret: Boolean(connector.secret),
        capabilities: connector.capabilities || [],
        sdkVersion: connector.sdkVersion,
        lastCheckedAt: connector.lastCheckedAt,
        lastError: connector.lastError
      },
      // The contract, so the dashboard does not carry its own copy that can
      // drift from what the platform actually accepts.
      contract: capabilityContract.CAPABILITIES
    });
  } catch (error) {
    logger.error('Failed to load connector settings', { error: error.message });
    res.status(500).json({ error: 'Failed to load the connector settings' });
  }
});

router.put('/me/connector', requireOwnCompany, admin, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id).select('+connector.secret');

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    company.connector = company.connector || {};
    let freshSecret = null;

    if (req.body.url !== undefined) {
      const url = String(req.body.url).trim();

      if (url) {
        // The same address check as everywhere else we fetch a URL somebody
        // typed: a connector pointed at the metadata service would be an SSRF
        // hole with a friendlier name.
        const check = safeHttp.validateUrl(url);
        if (!check.valid) {
          return res.status(400).json({
            error: connectorService.explainAddress(check.error, url)
          });
        }
      }

      // Changing where we call means the old answers are meaningless.
      if (url !== company.connector.url) {
        company.connector.capabilities = [];
        company.connector.lastCheckedAt = undefined;
        company.connector.lastError = undefined;
        connectorService.clearCache(company._id);
      }

      company.connector.url = url;
    }

    if (req.body.enabled !== undefined) {
      company.connector.enabled = Boolean(req.body.enabled);
    }

    // Minted here rather than accepted: a secret the caller chose is one they
    // may have reused, and this one is ours to guarantee the strength of.
    if (req.body.rotateSecret || (!company.connector.secret && company.connector.url)) {
      freshSecret = connectorService.generateSecret();
      company.connector.secret = secrets.encrypt(freshSecret);
      connectorService.clearCache(company._id);
    }

    await company.save();

    audit.record({
      req,
      action: 'connector.updated',
      target: { type: 'company', id: String(company._id), label: company.name },
      details: { url: company.connector.url, enabled: company.connector.enabled }
    });

    res.json({
      connector: {
        enabled: Boolean(company.connector.enabled),
        url: company.connector.url || '',
        hasSecret: Boolean(company.connector.secret),
        capabilities: company.connector.capabilities || []
      },
      secret: freshSecret,
      secretNotice: freshSecret
        ? 'Copy this into your connector now — it is not shown again.'
        : undefined
    });
  } catch (error) {
    logger.error('Failed to save connector settings', { error: error.message });
    res.status(500).json({ error: 'Failed to save the connector settings' });
  }
});

/**
 * Ask the connector what it implements.
 *
 * Run on demand rather than on a schedule: a tenant knows when they have
 * deployed something new, and polling somebody else's server for a change that
 * happens twice a year is rude.
 */
router.post('/me/connector/check', requireOwnCompany, admin, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id);

    if (!company?.connector?.url) {
      return res.status(400).json({ error: 'Set the connector URL first' });
    }

    const result = await connectorService.discover(company.connector.url);

    company.connector.lastCheckedAt = new Date();
    company.connector.lastError = result.ok ? undefined : result.error;

    if (result.ok) {
      company.connector.capabilities = result.capabilities;
      company.connector.sdkVersion = result.version;
    }

    await company.save();
    connectorService.clearCache(company._id);

    res.json({
      ok: result.ok,
      error: result.error,
      capabilities: result.capabilities || [],
      unknown: result.unknown || [],
      signed: result.signed,
      version: result.version,
      // Said plainly: a connector without a secret will serve a tenant's
      // product data to anyone who finds the URL.
      warning: result.ok && !result.signed
        ? 'Your connector reports that it has no signing secret, so it cannot tell our requests from anyone else\'s. Set CHATBOT_CONNECTOR_SECRET and redeploy.'
        : undefined
    });
  } catch (error) {
    logger.error('Connector check failed', { error: error.message });
    res.status(500).json({ error: 'Failed to reach the connector' });
  }
});

/**
 * How conversations reach an operator.
 */
router.get('/me/routing', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id).select('routing').lean();

    res.json({
      routing: company?.routing || { autoAssign: false, maxConcurrent: 3, assignOnStart: false }
    });
  } catch (error) {
    logger.error('Failed to load routing settings', { error: error.message });
    res.status(500).json({ error: 'Failed to load the routing settings' });
  }
});

router.put('/me/routing', requireOwnCompany, admin, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    company.routing = company.routing || {};

    if (req.body.autoAssign !== undefined) {
      company.routing.autoAssign = Boolean(req.body.autoAssign);
    }

    if (req.body.assignOnStart !== undefined) {
      company.routing.assignOnStart = Boolean(req.body.assignOnStart);
    }

    if (req.body.maxConcurrent !== undefined) {
      const max = parseInt(req.body.maxConcurrent, 10);
      // The cap is the point of the feature, so it is validated rather than
      // clamped silently: an admin who typed 100 needs to know it was refused.
      if (Number.isNaN(max) || max < 1 || max > 20) {
        return res.status(400).json({ error: 'Choose a limit between 1 and 20 conversations' });
      }
      company.routing.maxConcurrent = max;
    }

    await company.save();

    logger.info('Routing settings updated', {
      companyId: String(company._id),
      by: req.user.username,
      autoAssign: company.routing.autoAssign
    });

    res.json({ routing: company.routing });
  } catch (error) {
    logger.error('Failed to update routing settings', { error: error.message });
    res.status(500).json({ error: 'Failed to save the routing settings' });
  }
});

router.get('/me/email', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id)
      .select('+emailChannel.inboundSecret')
      .lean();

    const settings = company?.emailChannel || {};
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

    res.json({
      enabled: Boolean(settings.enabled),
      inboundAddress: settings.inboundAddress || '',
      fromName: settings.fromName || '',
      fromAddress: settings.fromAddress || '',
      signature: settings.signature || '',
      // Built here rather than in the browser so it always matches what the
      // route actually expects.
      inboundUrl: settings.enabled && settings.inboundSecret
        ? `${base}/api/email/inbound/${company._id}/generic?secret=${settings.inboundSecret}`
        : null,
      smtpConfigured: Boolean(process.env.EMAIL_HOST)
    });
  } catch (error) {
    console.error('Error loading email settings:', error);
    res.status(500).json({ error: 'Failed to load email settings' });
  }
});

router.put('/me/email', requireOwnCompany, async (req, res) => {
  try {
    const { enabled, inboundAddress, fromName, fromAddress, signature } = req.body;
    const company = await Company.findById(req.user.company.id).select('+emailChannel.inboundSecret');

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const isEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value));

    if (inboundAddress && !isEmail(inboundAddress)) {
      return res.status(400).json({ error: 'Inbound address must be a valid email address' });
    }
    if (fromAddress && !isEmail(fromAddress)) {
      return res.status(400).json({ error: 'From address must be a valid email address' });
    }

    if (enabled && !inboundAddress) {
      return res.status(400).json({
        error: 'An inbound address is required before the email channel can be turned on'
      });
    }

    company.emailChannel = {
      ...(company.emailChannel ? company.emailChannel.toObject() : {}),
      enabled: Boolean(enabled),
      inboundAddress: inboundAddress ? String(inboundAddress).trim().toLowerCase() : undefined,
      fromName: fromName ? String(fromName).trim() : undefined,
      fromAddress: fromAddress ? String(fromAddress).trim().toLowerCase() : undefined,
      signature: signature !== undefined ? String(signature).trim() : company.emailChannel?.signature
    };

    // The pre-save hook mints the inbound secret the first time the channel is
    // switched on.
    await company.save();

    const refreshed = await Company.findById(company._id).select('+emailChannel.inboundSecret').lean();
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

    res.json({
      success: true,
      inboundUrl: refreshed.emailChannel.enabled && refreshed.emailChannel.inboundSecret
        ? `${base}/api/email/inbound/${company._id}/generic?secret=${refreshed.emailChannel.inboundSecret}`
        : null
    });
  } catch (error) {
    console.error('Error saving email settings:', error);
    res.status(500).json({ error: 'Failed to save email settings' });
  }
});

router.post('/me/widget/rotate-key', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    company.rotateWidgetKey();
    await company.save();
    tenantService.invalidate();

    res.json({ success: true, widgetKey: company.widgetKey });
  } catch (error) {
    console.error('Error rotating widget key:', error);
    res.status(500).json({ error: 'Failed to rotate widget key' });
  }
});

// Get company by ID (superadmin or same company)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const company = await Company.findById(id);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Check if user has access to this company
    if (req.user.role !== 'superadmin' &&
        (!req.user.company || req.user.company.id.toString() !== id)) {
      return res.status(403).json({ error: 'Access denied: You can only view your own company' });
    }

    res.json({ company });
  } catch (error) {
    console.error('Error fetching company:', error);
    res.status(500).json({ error: 'Failed to retrieve company' });
  }
});

// Create new company (superadmin only)
router.post('/', superadmin, async (req, res) => {
  try {
    const { name, description, website, adminUsername, adminEmail, adminPassword } = req.body;

    // Check if company with this name already exists
    const existingCompany = await Company.findOne({ name });
    if (existingCompany) {
      return res.status(400).json({ error: 'Company with this name already exists' });
    }

    // Create new company
    const company = new Company({
      name,
      description,
      website,
      createdBy: req.user.id
    });

    await company.save();

    // Create company admin user
    const username = adminUsername || `admin_${name.toLowerCase().replace(/\s+/g, '_')}`;
    const email = adminEmail || `admin@${name.toLowerCase().replace(/\s+/g, '')}.com`;
    const password = adminPassword || generateRandomPassword();

    // Check if user already exists
    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      // If user exists, we'll still return success for the company creation
      // but include a warning about the admin user
      return res.status(201).json({
        message: 'Company created successfully, but admin user could not be created (username or email already exists)',
        company,
        warning: 'Admin user could not be created because the username or email already exists'
      });
    }

    // Create the company admin user
    const adminUser = new User({
      username,
      email,
      password,
      role: 'company_admin',
      displayName: `${name} Admin`,
      company: company._id,
      isActive: true,
      createdBy: req.user.id
    });

    await adminUser.save();

    res.status(201).json({
      message: 'Company created successfully with admin user',
      company,
      admin: {
        id: adminUser._id,
        username: adminUser.username,
        email: adminUser.email,
        password: adminPassword ? undefined : password // Only return password if it was auto-generated
      }
    });
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

// Update company (superadmin or company admin of the same company)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, website, isActive } = req.body;

    // Find company
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Check if user has access to update this company
    if (req.user.role !== 'superadmin' &&
        (!req.user.company || req.user.company.id.toString() !== id || req.user.role !== 'company_admin')) {
      return res.status(403).json({ error: 'Access denied: Only superadmins or company admins can update their own company' });
    }

    // Check if company with this name already exists (if name is being changed)
    if (name && name !== company.name) {
      const existingCompany = await Company.findOne({ name });
      if (existingCompany) {
        return res.status(400).json({ error: 'Company with this name already exists' });
      }
    }

    // Update company fields
    if (name) {
      company.name = name;
    }
    if (description !== undefined) {
      company.description = description;
    }
    if (website !== undefined) {
      company.website = website;
    }

    // Only superadmin can change active status
    if (isActive !== undefined && req.user.role === 'superadmin') {
      company.isActive = isActive;
    }

    await company.save();

    res.json({
      message: 'Company updated successfully',
      company
    });
  } catch (error) {
    console.error('Error updating company:', error);
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// Delete company (superadmin only)
router.delete('/:id', superadmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Check if company has users
    const usersCount = await User.countDocuments({ company: id });
    if (usersCount > 0) {
      return res.status(400).json({
        error: 'Cannot delete company with users. Please delete or reassign users first.',
        usersCount
      });
    }

    // Delete company
    await Company.findByIdAndDelete(id);

    res.json({
      message: 'Company deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting company:', error);
    res.status(500).json({ error: 'Failed to delete company' });
  }
});

// Get company users (superadmin or company admin of the same company)
router.get('/:id/users', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Check if user has access to this company
    if (req.user.role !== 'superadmin' &&
        (!req.user.company || req.user.company.id.toString() !== id)) {
      return res.status(403).json({ error: 'Access denied: You can only view users from your own company' });
    }

    // Get users for this company
    const users = await User.find(
      { company: id },
      { _id: 1, username: 1, displayName: 1, email: 1, role: 1, isActive: 1, lastLogin: 1 }
    );

    res.json({ users });
  } catch (error) {
    console.error('Error fetching company users:', error);
    res.status(500).json({ error: 'Failed to retrieve company users' });
  }
});

// Get company admin (superadmin only)
router.get('/:id/admin', superadmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Find the company admin
    const admin = await User.findOne({
      company: id,
      role: 'company_admin'
    });

    if (!admin) {
      return res.status(404).json({ error: 'Company admin not found' });
    }

    res.json({
      admin: {
        id: admin._id,
        username: admin.username,
        displayName: admin.displayName,
        email: admin.email,
        isActive: admin.isActive,
        lastLogin: admin.lastLogin
      }
    });
  } catch (error) {
    console.error('Error fetching company admin:', error);
    res.status(500).json({ error: 'Failed to retrieve company admin' });
  }
});

// Edit company admin (superadmin only)
router.put('/:id/admin', superadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, email, displayName, password } = req.body;

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Find the company admin
    const admin = await User.findOne({
      company: id,
      role: 'company_admin'
    });

    if (!admin) {
      return res.status(404).json({ error: 'Company admin not found' });
    }

    // Check if username or email is already taken by another user
    if (username !== admin.username || email !== admin.email) {
      const existingUser = await User.findOne({
        $and: [
          { _id: { $ne: admin._id } },
          { $or: [{ username }, { email }] }
        ]
      });

      if (existingUser) {
        if (existingUser.username === username) {
          return res.status(400).json({ error: 'Username is already taken' });
        }
        if (existingUser.email === email) {
          return res.status(400).json({ error: 'Email is already taken' });
        }
      }
    }

    // Update admin details
    if (username) {
      admin.username = username;
    }
    if (email) {
      admin.email = email;
    }
    if (displayName) {
      admin.displayName = displayName;
    }
    if (password) {
      admin.password = password;
    }

    await admin.save();

    res.json({
      success: true,
      message: 'Company admin updated successfully',
      admin: {
        id: admin._id,
        username: admin.username,
        displayName: admin.displayName,
        email: admin.email
      }
    });
  } catch (error) {
    console.error('Error updating company admin:', error);
    res.status(500).json({ error: 'Failed to update company admin' });
  }
});

// Reset company admin password (superadmin only)
router.post('/:id/admin/reset-password', superadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { password, generateRandom } = req.body;

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Find the company admin
    const admin = await User.findOne({
      company: id,
      role: 'company_admin'
    });

    if (!admin) {
      return res.status(404).json({ error: 'Company admin not found' });
    }

    // Generate random password or use provided password
    let newPassword;
    if (generateRandom) {
      newPassword = generateRandomPassword();
    } else if (password) {
      newPassword = password;
    } else {
      return res.status(400).json({ error: 'Either password or generateRandom must be provided' });
    }

    // Update password
    admin.password = newPassword;
    await admin.save();

    res.json({
      success: true,
      message: 'Company admin password reset successfully',
      admin: {
        id: admin._id,
        username: admin.username,
        email: admin.email
      },
      // Only return the password if it was randomly generated
      password: generateRandom ? newPassword : undefined
    });
  } catch (error) {
    console.error('Error resetting company admin password:', error);
    res.status(500).json({ error: 'Failed to reset company admin password' });
  }
});

// Edit company user (superadmin only)
router.put('/:id/users/:userId', superadmin, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const { username, name, displayName, email, role, password } = req.body;

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Find the user
    const user = await User.findOne({
      _id: userId,
      company: id
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found in this company' });
    }

    // Validate input
    if (!username || !email) {
      return res.status(400).json({ error: 'Username and email are required' });
    }

    // Check if username or email is already taken by another user
    if (username !== user.username || email !== user.email) {
      const existingUser = await User.findOne({
        $and: [
          { _id: { $ne: userId } },
          { $or: [{ username }, { email }] }
        ]
      });

      if (existingUser) {
        if (existingUser.username === username) {
          return res.status(400).json({ error: 'Username is already taken' });
        }
        if (existingUser.email === email) {
          return res.status(400).json({ error: 'Email is already taken' });
        }
      }
    }

    // Validate role
    if (role && !['company_admin', 'operator'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be company_admin or operator' });
    }

    // Update user details
    user.username = username;
    if (name !== undefined) {
      user.name = name;
    }
    if (displayName !== undefined) {
      user.displayName = displayName;
    }
    user.email = email;
    if (role) {
      user.role = role;
    }
    if (password) {
      user.password = password;
    }

    await user.save();

    res.json({
      success: true,
      message: 'User updated successfully',
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Error updating company user:', error);
    res.status(500).json({ error: 'Failed to update company user' });
  }
});

// Create company user (superadmin only)
router.post('/:id/users', superadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, name, displayName, email, role, password } = req.body;

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Validate input
    if (!username || !email || !password || !role) {
      return res.status(400).json({ error: 'Username, email, password, and role are required' });
    }

    // Validate role
    if (!['company_admin', 'operator'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be company_admin or operator' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ username }, { email }]
    });

    if (existingUser) {
      if (existingUser.username === username) {
        return res.status(400).json({ error: 'Username is already taken' });
      }
      if (existingUser.email === email) {
        return res.status(400).json({ error: 'Email is already taken' });
      }
    }

    // Create new user
    const user = new User({
      username,
      name,
      displayName,
      email,
      password,
      role,
      company: id,
      isActive: true,
      createdBy: req.user.id
    });

    await user.save();

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Error creating company user:', error);
    res.status(500).json({ error: 'Failed to create company user' });
  }
});

// Reset company user password (superadmin only)
router.post('/:id/users/:userId/reset-password', superadmin, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const { password, generateRandom } = req.body;

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Find the user
    const user = await User.findOne({
      _id: userId,
      company: id
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found in this company' });
    }

    // Generate random password or use provided password
    let newPassword;
    if (generateRandom) {
      newPassword = generateRandomPassword();
    } else if (password) {
      newPassword = password;
    } else {
      return res.status(400).json({ error: 'Either password or generateRandom must be provided' });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'User password reset successfully',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role
      },
      // Only return the password if it was randomly generated
      password: generateRandom ? newPassword : undefined
    });
  } catch (error) {
    console.error('Error resetting user password:', error);
    res.status(500).json({ error: 'Failed to reset user password' });
  }
});

// Get company user (superadmin only)
router.get('/:id/users/:userId', superadmin, async (req, res) => {
  try {
    const { id, userId } = req.params;

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Find the user
    const user = await User.findOne({
      _id: userId,
      company: id
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found in this company' });
    }

    res.json({
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.error('Error fetching company user:', error);
    res.status(500).json({ error: 'Failed to retrieve company user' });
  }
});

// Update company user status (superadmin only)
router.patch('/:id/users/:userId/status', superadmin, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const { isActive } = req.body;

    // Validate input
    if (isActive === undefined) {
      return res.status(400).json({ error: 'isActive status is required' });
    }

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Find the user
    const user = await User.findOne({
      _id: userId,
      company: id
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found in this company' });
    }

    // Update user status
    user.isActive = isActive;
    await user.save();

    res.json({
      success: true,
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Error updating user status:', error);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

module.exports = router;
