const express = require('express');
const mongoose = require('mongoose');
const Company = require('../models/company');
const User = require('../models/user');
const tenantService = require('../services/tenant');
const availabilityService = require('../services/availability');
const { auth, superadmin, admin, sameCompany, requireString } = require('../middleware/auth');
const { enforceLimit } = require('../middleware/quota');
const { logger } = require('../services/logging');
const connectorService = require('../services/connector');
const capabilityContract = require('../config/capabilities');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const audit = require('../services/audit');
const DataRetentionService = require('../services/dataRetention');
const crypto = require('crypto');
const { WIDGET_LANGUAGE_SETTINGS, isWidgetLanguage, isSafeLogoUrl } = require('../config/widget-languages');

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

// The floor for any password set through these routes. Generated passwords
// are longer than this, and a superadmin typing one in gets no exemption.
const MIN_PASSWORD_LENGTH = 8;

/**
 * The reason a supplied password cannot be used, or null. A request field
 * that is not a string is never a password - it is a query operator, or a
 * client bug - and is refused on the same terms as a short one.
 */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
  }
  return null;
}

/**
 * Set a new password on a user. The token version moves with it, so every
 * session the old password opened is over.
 */
function setPassword(user, password) {
  user.password = password;
  user.tokenVersion = (user.tokenVersion || 0) + 1;
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

/**
 * A company that signed itself up confirms its admin's address before adding
 * the websites its widget may run on. Registered ahead of the widget settings
 * route rather than inside it: it only answers when it refuses, and otherwise
 * hands the request on untouched.
 */
router.put('/me/widget', require('../middleware/auth').domainsNeedVerifiedEmail);

/**
 * Get all companies (superadmin only), with what the platform screen shows
 * beside each: plan and status, how it came to exist, whether the widget has
 * been seen on a real site, and when anything last happened. `?q=` searches
 * the name and website.
 */
router.get('/', superadmin, async (req, res) => {
  try {
    const { escapeRegex } = require('../utils/query');
    const Subscription = require('../models/subscription');
    const Conversation = require('../models/conversation');

    const filter = {};
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const term = new RegExp(escapeRegex(req.query.q.trim().slice(0, 100)), 'i');
      filter.$or = [{ name: term }, { website: term }];
    }

    const companies = await Company.find(filter).sort({ name: 1 }).lean();
    const ids = companies.map(company => company._id);

    const [subscriptions, activity] = await Promise.all([
      Subscription.find({ company: { $in: ids } }).lean(),
      Conversation.aggregate([
        { $match: { company: { $in: ids } } },
        { $group: { _id: '$company', lastActivity: { $max: '$lastActivity' } } }
      ])
    ]);

    const subscriptionOf = new Map(subscriptions.map(row => [String(row.company), row]));
    const lastActivityOf = new Map(activity.map(row => [String(row._id), row.lastActivity]));
    const now = new Date();

    res.json({
      companies: companies.map(company => {
        const subscription = subscriptionOf.get(String(company._id));
        const trialExpired = subscription && subscription.status === 'trialing'
          && subscription.trialEndsAt && new Date(subscription.trialEndsAt) < now;
        return {
          _id: company._id,
          name: company.name,
          description: company.description,
          website: company.website,
          isActive: company.isActive !== false,
          createdAt: company.createdAt,
          createdVia: company.createdVia || 'superadmin',
          planId: subscription ? subscription.planId : 'trial',
          status: subscription ? (trialExpired ? 'trial_expired' : subscription.status) : 'trialing',
          trialEndsAt: subscription ? subscription.trialEndsAt : undefined,
          installed: Boolean(company.widgetSeen && company.widgetSeen.at),
          widgetSeenAt: company.widgetSeen ? company.widgetSeen.at : undefined,
          widgetOrigin: company.widgetSeen ? company.widgetSeen.origin : undefined,
          lastActivity: lastActivityOf.get(String(company._id)) || null
        };
      })
    });
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
      .select('name website widgetKey allowedDomains widgetSettings widgetSeen');

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
      // Where the widget was last loaded from one of the allowed domains,
      // for "Seen on example.com, 4 minutes ago".
      widgetSeen: company.widgetSeen && company.widgetSeen.at ? company.widgetSeen : null,
      // The page "Check my site" offers first.
      website: company.website || null,
      // What the language picker may offer, so the dashboard does not keep
      // its own copy of the list.
      languages: WIDGET_LANGUAGE_SETTINGS,
      companyName: company.name
    });
  } catch (error) {
    console.error('Error fetching widget config:', error);
    res.status(500).json({ error: 'Failed to load widget configuration' });
  }
});

/**
 * The widget settings that are more than a scalar, checked and normalised,
 * or the reason they cannot be saved. Everything is checked before anything
 * is assigned, so a bad value refuses the whole save rather than half
 * applying it.
 *
 * @returns {{error?: string, values?: object}}
 */
function validateWidgetExtras(widgetSettings) {
  const values = {};

  if (widgetSettings.privacyPolicyUrl !== undefined) {
    const url = typeof widgetSettings.privacyPolicyUrl === 'string' ? widgetSettings.privacyPolicyUrl.trim() : '';
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
      return { error: 'privacyPolicyUrl must start with http:// or https://' };
    }
    values.privacyPolicyUrl = url || undefined;
  }

  if (widgetSettings.suggestedQuestions !== undefined) {
    if (!Array.isArray(widgetSettings.suggestedQuestions)) {
      return { error: 'suggestedQuestions must be a list' };
    }
    const questions = widgetSettings.suggestedQuestions
      .map(question => (typeof question === 'string' ? question.trim() : ''))
      .filter(Boolean);
    if (questions.length > 4) {
      return { error: 'Offer at most four suggested questions' };
    }
    if (questions.some(question => question.length > 120)) {
      return { error: 'Keep each suggested question to 120 characters' };
    }
    values.suggestedQuestions = questions;
  }

  if (widgetSettings.consentText !== undefined) {
    const text = typeof widgetSettings.consentText === 'string' ? widgetSettings.consentText.trim() : '';
    if (text.length > 300) {
      return { error: 'Keep the consent text to 300 characters' };
    }
    values.consentText = text || undefined;
  }

  if (widgetSettings.proactive !== undefined) {
    const proactive = widgetSettings.proactive;
    if (proactive === null) {
      values.proactive = { enabled: false };
    } else if (typeof proactive !== 'object' || Array.isArray(proactive)) {
      return { error: 'proactive must be an object' };
    } else {
      const enabled = proactive.enabled === true || proactive.enabled === 'true';
      const text = typeof proactive.text === 'string' ? proactive.text.trim() : '';
      const pathContains = typeof proactive.pathContains === 'string' ? proactive.pathContains.trim() : '';
      const delay = proactive.delaySeconds === undefined || proactive.delaySeconds === ''
        ? 20
        : Number(proactive.delaySeconds);

      if (!Number.isInteger(delay) || delay < 5 || delay > 120) {
        return { error: 'Show the proactive message after 5 to 120 seconds' };
      }
      if (text.length > 200) {
        return { error: 'Keep the proactive message to 200 characters' };
      }
      if (enabled && !text) {
        return { error: 'Write the proactive message before switching it on' };
      }
      if (pathContains.length > 200) {
        return { error: 'Keep the page filter to 200 characters' };
      }
      values.proactive = {
        enabled,
        text: text || undefined,
        delaySeconds: delay,
        pathContains: pathContains || undefined
      };
    }
  }

  return { values };
}

/** A plain copy of the stored widget settings, to compare before and after. */
function widgetSettingsSnapshot(company) {
  const settings = company.widgetSettings;
  return settings && typeof settings.toObject === 'function'
    ? settings.toObject()
    : JSON.parse(JSON.stringify(settings || {}));
}

router.put('/me/widget', requireOwnCompany, async (req, res) => {
  try {
    const { allowedDomains, widgetSettings } = req.body;
    const company = await Company.findById(req.user.company.id);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const domainsBefore = [...(company.allowedDomains || [])];
    const settingsBefore = widgetSettingsSnapshot(company);

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

      // A page with no widget key is matched to a tenant by its origin, so an
      // origin two tenants both claim would land one tenant's visitors with
      // the other. Only domains being added are checked: one already on the
      // list stays, whatever happened since.
      const added = normalised.filter(domain => !domainsBefore.includes(domain));
      if (added.length) {
        const taken = await Company.findOne({
          _id: { $ne: company._id },
          allowedDomains: { $in: added }
        }).select('allowedDomains').lean();
        if (taken) {
          const clash = added.find(domain => (taken.allowedDomains || []).includes(domain));
          return res.status(409).json({
            error: `${clash} is already registered to another account. If it is yours, contact support to move it.`,
            code: 'DOMAIN_TAKEN'
          });
        }
      }

      company.allowedDomains = [...new Set(normalised)];
    }

    if (widgetSettings && typeof widgetSettings === 'object') {
      // Checked before anything is assigned, so a bad value refuses the whole
      // save rather than half-applying it.
      if (widgetSettings.language !== undefined && !isWidgetLanguage(widgetSettings.language)) {
        return res.status(400).json({
          error: `language must be one of ${WIDGET_LANGUAGE_SETTINGS.join(', ')}`
        });
      }

      // The logo is drawn on the tenant's own website, so it has to be an
      // https image URL; an empty value removes it.
      const logoGiven = widgetSettings.logoUrl !== undefined;
      const logoUrl = typeof widgetSettings.logoUrl === 'string'
        ? widgetSettings.logoUrl.trim()
        : widgetSettings.logoUrl;
      const clearLogo = logoGiven && (logoUrl === '' || logoUrl === null);
      if (logoGiven && !clearLogo && !isSafeLogoUrl(logoUrl)) {
        return res.status(400).json({ error: 'logoUrl must be an https:// URL' });
      }

      const extras = validateWidgetExtras(widgetSettings);
      if (extras.error) {
        return res.status(400).json({ error: extras.error });
      }

      const allowed = ['chatbotName', 'primaryColor', 'position', 'welcomeMessage', 'language'];
      const booleans = ['requireName', 'requireEmail', 'requirePhone', 'consentRequired'];
      company.widgetSettings = company.widgetSettings || {};
      allowed.forEach(key => {
        if (widgetSettings[key] !== undefined) {
          company.widgetSettings[key] = widgetSettings[key];
        }
      });
      booleans.forEach(key => {
        if (widgetSettings[key] !== undefined) {
          company.widgetSettings[key] = widgetSettings[key] === true || widgetSettings[key] === 'true';
        }
      });
      Object.entries(extras.values).forEach(([key, value]) => {
        company.widgetSettings[key] = value;
      });
      if (logoGiven) {
        company.widgetSettings.logoUrl = clearLogo ? undefined : logoUrl;
      }
    }

    await company.save();
    tenantService.invalidate();

    // Recorded as what changed rather than as "settings saved": which domain
    // was added is the thing anyone reading the log later needs.
    const domainsAfter = company.allowedDomains || [];
    const added = domainsAfter.filter(domain => !domainsBefore.includes(domain));
    const removed = domainsBefore.filter(domain => !domainsAfter.includes(domain));
    if (added.length || removed.length) {
      await audit.record({
        action: 'widget.domains_changed',
        req,
        target: { type: 'company', id: String(company._id), label: company.name },
        details: { added, removed }
      });
    }

    const settingsAfter = widgetSettingsSnapshot(company);
    const changed = [...new Set([...Object.keys(settingsBefore), ...Object.keys(settingsAfter)])]
      .filter(key => key !== '_id' && JSON.stringify(settingsBefore[key]) !== JSON.stringify(settingsAfter[key]));
    if (changed.length) {
      await audit.record({
        action: 'widget.settings_updated',
        req,
        target: { type: 'company', id: String(company._id), label: company.name },
        details: { changed: changed.sort() }
      });
    }

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
 * "Check my site": fetch a page of the tenant's site and say whether the
 * widget is on it. The page comes through safe-http, because the URL is
 * whatever the admin typed.
 */
router.post('/me/widget/check', requireOwnCompany, async (req, res) => {
  // Required here rather than at the top: this file's header belongs to
  // several features, and this is the only route that needs it.
  const widgetInstall = require('../services/widget-install');

  try {
    const company = await Company.findById(req.user.company.id)
      .select('name website widgetKey allowedDomains widgetSeen')
      .lean();

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const url = typeof req.body.url === 'string' && req.body.url.trim()
      ? req.body.url
      : (company.allowedDomains && company.allowedDomains[0]) || company.website;

    if (!url || !widgetInstall.normaliseCheckUrl(url)) {
      return res.status(400).json({
        error: 'Enter the address of a page on your website, for example https://www.example.com'
      });
    }

    const result = await widgetInstall.checkSite(url, company);
    res.json({
      ...result,
      widgetSeen: company.widgetSeen && company.widgetSeen.at ? company.widgetSeen : null
    });
  } catch (error) {
    logger.error('Widget site check failed', { error: error.message });
    res.status(500).json({ error: 'Failed to check the site' });
  }
});

/**
 * How far this company has got with setting up, for the dashboard's checklist.
 *
 * A new tenant lands on an empty dashboard and has to discover for
 * themselves that the bot knows nothing until they import something, says
 * nothing in their voice until they write a persona, and talks to nobody until
 * the snippet is on their site. Each of those is one cheap count or flag, so
 * the dashboard can say what is left instead.
 *
 * Company admins read their own; a superadmin names the company with
 * `?companyId=`, as on the knowledge routes.
 */
router.get('/me/setup', async (req, res) => {
  try {
    let companyId;

    if (req.user.role === 'superadmin') {
      companyId = req.query.companyId || (req.user.company && req.user.company.id) || null;
      if (!companyId) {
        return res.status(400).json({ error: 'Name a company with ?companyId=' });
      }
      if (!mongoose.isValidObjectId(companyId)) {
        return res.status(400).json({ error: 'That is not a company id' });
      }
    } else if (req.user.role === 'company_admin') {
      if (!req.user.company) {
        return res.status(400).json({ error: 'Your account is not linked to a company' });
      }
      companyId = req.user.company.id;
    } else {
      return res.status(403).json({ error: 'Admin privileges required' });
    }

    const company = await Company.findById(companyId)
      .select('assistant.persona allowedDomains emailChannel.enabled businessHours.enabled widgetSeen onboarding')
      .lean();

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Required here rather than at the top: this is the only route in the
    // file that reads them.
    const KnowledgeChunk = require('../models/knowledge-chunk');
    const Conversation = require('../models/conversation');
    const Workflow = require('../models/workflow');
    const { engaged } = require('../services/analytics');

    const [knowledgeSources, knowledgeChunks, conversations, operators, published] = await Promise.all([
      KnowledgeChunk.distinct('sourceId', { company: companyId }).then(ids => ids.length),
      KnowledgeChunk.countDocuments({ company: companyId }),
      // Conversations somebody actually started: opening the widget and
      // closing it again used to count, and ticked "installed" on its own.
      Conversation.countDocuments(engaged({ company: new mongoose.Types.ObjectId(String(companyId)) })),
      // Everyone who can answer a chat: admins handle conversations too.
      User.countDocuments({
        company: companyId,
        role: { $in: ['operator', 'company_admin'] },
        isActive: { $ne: false }
      }),
      Workflow.findOne({ company: companyId, status: 'published' }).select('nodes').lean()
    ]);
    const personaSource = await require('../services/assistant-config').resolve(companyId)
      .then(resolved => resolved.source)
      .catch(() => 'default');

    const seen = company.widgetSeen || {};
    const botTestedAt = company.onboarding && company.onboarding.botTestedAt;

    res.json({
      knowledgeSources,
      knowledgeChunks,
      // Whatever persona the assistant actually answers with: one written
      // under Persona & replies, or the Persona step of the workflow that
      // answers every message. A Persona step in a workflow that only runs
      // for bookings does not make the bot speak for the business.
      persona: personaSource !== 'default',
      allowedDomains: company.allowedDomains || [],
      conversations,
      // The widget has loaded on a real page. Recorded when it fetches its
      // configuration; a conversation is the fallback for installs that
      // predate that record.
      widgetSeen: Boolean(seen.at) || conversations > 0,
      widgetSeenAt: seen.at || null,
      widgetOrigin: seen.origin || null,
      // Test your bot has been used at least once.
      botTested: Boolean(botTestedAt),
      botTestedAt: botTestedAt || null,
      operators,
      workflowPublished: Boolean(published),
      emailChannel: Boolean(company.emailChannel?.enabled),
      businessHours: Boolean(company.businessHours?.enabled)
    });
  } catch (error) {
    logger.error('Could not read setup status', { error: error.message });
    res.status(500).json({ error: 'Failed to read setup status' });
  }
});

/**
 * When this company is open. Read and written by its own admins.
 */
router.get('/me/hours', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id).select('businessHours').lean();
    const availability = await availabilityService.status(req.user.company.id);
    const hours = company?.businessHours || { enabled: false, timezone: 'UTC', days: [] };

    res.json({
      businessHours: { ...hours, closedDates: hours.closedDates || [] },
      // Whether anybody has ever saved a schedule. Until they have, the zone
      // is the schema's UTC rather than a choice, and the screen offers the
      // browser's own instead.
      saved: Boolean(hours.enabled || (hours.days || []).length || (hours.closedDates || []).length
        || (hours.timezone && hours.timezone !== 'UTC')),
      // What a visitor would see right now, so an admin can sanity-check the
      // schedule they just entered against reality.
      current: availability
    });
  } catch (error) {
    console.error('Error loading business hours:', error);
    res.status(500).json({ error: 'Failed to load business hours' });
  }
});

/** A real calendar date written as YYYY-MM-DD, or null. */
function calendarDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
}

router.put('/me/hours', requireOwnCompany, async (req, res) => {
  try {
    const { enabled, timezone, days, offlineMessage, closedDates } = req.body;
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

    // A closing time before the opening time is an overnight shift - open
    // Friday 22:00 to Saturday 06:00 - which a night desk needs. Only the
    // same time twice is meaningless.
    const empty = cleanDays.find(day => !day.closed && day.closesAt === day.opensAt);
    if (empty) {
      return res.status(400).json({
        error: 'Opening and closing times are the same. For a day open around the clock, use 00:00 to 24:00.'
      });
    }

    let cleanClosed = company.businessHours?.closedDates || [];
    if (closedDates !== undefined) {
      if (!Array.isArray(closedDates)) {
        return res.status(400).json({ error: 'Closed dates must be a list' });
      }
      const seen = new Map();
      for (const entry of closedDates) {
        const date = calendarDate(entry && typeof entry === 'object' ? entry.date : entry);
        if (!date) {
          return res.status(400).json({ error: `"${entry && entry.date !== undefined ? entry.date : entry}" is not a date. Use YYYY-MM-DD.` });
        }
        const label = entry && typeof entry === 'object' && entry.label
          ? String(entry.label).trim().slice(0, 80)
          : undefined;
        seen.set(date, { date, ...(label ? { label } : {}) });
      }
      if (seen.size > 100) {
        return res.status(400).json({ error: 'Keep the list of closed dates to 100 or fewer' });
      }
      cleanClosed = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
    }

    const previous = company.businessHours ? company.businessHours.toObject() : {};

    company.businessHours = {
      enabled: Boolean(enabled),
      timezone: timezone || 'UTC',
      days: cleanDays,
      offlineMessage: offlineMessage !== undefined
        ? String(offlineMessage).trim()
        : company.businessHours?.offlineMessage,
      closedDates: cleanClosed
    };

    await company.save();
    availabilityService.invalidate(req.user.company.id);

    // When a visitor is told "we are closed" is a promise made on the
    // company's behalf; who changed it is worth being able to find.
    audit.record({
      req,
      action: 'company.hours_changed',
      target: { type: 'company', id: String(company._id), label: company.name },
      details: {
        from: { enabled: previous.enabled, timezone: previous.timezone },
        to: { enabled: company.businessHours.enabled, timezone: company.businessHours.timezone },
        closedDates: cleanClosed.length
      }
    });

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

/**
 * A retention window as typed: `null` means "follow the platform default"
 * and 0 means "never". Both are choices, and conflating them would make one
 * of them unsayable.
 */
function parseRetentionDays(value, label) {
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
}

/**
 * What the values being typed would do tonight, before they are saved.
 *
 * The screen used to show the impact of the saved policy, so an admin typing
 * "7" saw the old, harmless numbers right up until they pressed Save.
 * `?anonymizeAfterDays=&deleteAfterDays=`, each empty for the platform default.
 */
router.get('/me/retention/preview', requireOwnCompany, async (req, res) => {
  try {
    let anonymizeAfterDays;
    let deleteAfterDays;

    try {
      anonymizeAfterDays = parseRetentionDays(req.query.anonymizeAfterDays, 'Anonymise after');
      deleteAfterDays = parseRetentionDays(req.query.deleteAfterDays, 'Delete after');
    } catch (validationError) {
      return res.status(400).json({ error: validationError.message });
    }

    const service = retentionService();
    const policy = service.policyFor({ dataRetention: { anonymizeAfterDays, deleteAfterDays } });
    const preview = await service.preview(req.user.company.id, policy);

    res.json({
      effective: policy,
      impact: { toDelete: preview.toDelete, toAnonymize: preview.toAnonymize }
    });
  } catch (error) {
    logger.error('Error previewing a retention policy', { error: error.message });
    res.status(500).json({ error: 'Failed to preview the retention policy' });
  }
});

router.put('/me/retention', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const parse = parseRetentionDays;

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
 * The connector SDK itself: its package name, version and guide, read from
 * sdk/ so the screen names the package that actually ships rather than a copy
 * of its name that can drift.
 */
router.get('/me/connector/sdk', requireOwnCompany, async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', 'sdk');

    const manifest = JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf8'));
    const readme = await fs.promises.readFile(path.join(root, 'README.md'), 'utf8').catch(() => '');

    res.json({
      packageName: manifest.name,
      version: manifest.version,
      description: manifest.description,
      install: `npm install ${manifest.name}`,
      readme
    });
  } catch (error) {
    logger.error('Could not read the connector SDK', { error: error.message });
    res.status(500).json({ error: 'Could not read the SDK details' });
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
    // A connected calendar answers the availability capabilities itself, so
    // the workflow editor must not call them "not implemented yet".
    const fromCalendar = await require('../services/booking').capabilitiesFor(req.user.company.id);

    res.json({
      connector: {
        enabled: Boolean(connector.enabled),
        url: connector.url || '',
        // Whether one exists, never the value. It was shown once when it was
        // generated; showing it again only widens who can read it.
        hasSecret: Boolean(connector.secret),
        capabilities: [...new Set([...(connector.capabilities || []), ...fromCalendar])],
        calendarCapabilities: fromCalendar,
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

      // Changing where we call means the old answers are meaningless, and so
      // is the old "it works": a new address is switched off until checked.
      if (url !== company.connector.url) {
        company.connector.capabilities = [];
        company.connector.lastCheckedAt = undefined;
        company.connector.lastError = undefined;
        company.connector.enabled = false;
        connectorService.clearCache(company._id);
      }

      company.connector.url = url;
    }

    if (req.body.enabled !== undefined) {
      const enabling = Boolean(req.body.enabled);
      // Switched on only once a Check has reached it. A connector the bot
      // cannot reach turns every catalogue question into an apology in front
      // of a customer, so the switch waits for proof that it answers.
      const checkedOk = Boolean(company.connector.url && company.connector.lastCheckedAt && !company.connector.lastError);
      if (enabling && !company.connector.enabled && !checkedOk) {
        return res.status(400).json({
          error: 'Press Check first. The bot can use your connector once it has answered.',
          code: 'CONNECTOR_NOT_CHECKED'
        });
      }
      company.connector.enabled = enabling;
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
      routing: company?.routing || { autoAssign: false, maxConcurrent: 3, assignOnStart: false, escalateAfterMinutes: 5 }
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

    if (req.body.escalateAfterMinutes !== undefined) {
      const minutes = parseInt(req.body.escalateAfterMinutes, 10);
      if (Number.isNaN(minutes) || minutes < 0 || minutes > 240) {
        return res.status(400).json({ error: 'Choose between 0 (off) and 240 minutes' });
      }
      company.routing.escalateAfterMinutes = minutes;
    }

    await company.save();

    logger.info('Routing settings updated', {
      companyId: String(company._id),
      by: req.user.username,
      autoAssign: company.routing.autoAssign
    });

    // Who changed how work is handed out is a question that comes up the day
    // somebody notices they are getting all of it.
    audit.record({
      req,
      action: 'company.routing_changed',
      target: { type: 'company', id: String(company._id), label: company.name },
      details: {
        autoAssign: company.routing.autoAssign,
        assignOnStart: company.routing.assignOnStart,
        maxConcurrent: company.routing.maxConcurrent,
        escalateAfterMinutes: company.routing.escalateAfterMinutes
      }
    });

    res.json({ routing: company.routing });
  } catch (error) {
    logger.error('Failed to update routing settings', { error: error.message });
    res.status(500).json({ error: 'Failed to save the routing settings' });
  }
});

// Required here, beside the handlers that use it, rather than with the
// imports at the top of the file.
const emailChannel = require('../services/email-channel');

/**
 * Where a provider should post inbound mail for this company.
 *
 * Built here rather than in the browser so it always matches what the route
 * actually expects. `url` carries the secret in the query string for
 * providers that can only be given a URL; `base` plus the `X-Inbound-Secret`
 * header is the better choice where a provider allows custom headers,
 * because a query string ends up in access logs.
 */
function inboundEndpoint(req, company) {
  const settings = company?.emailChannel || {};
  if (!settings.enabled || !settings.inboundSecret) {
    return { url: null, base: null, secret: null };
  }

  const root = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const base = `${root.replace(/\/$/, '')}/api/email/inbound/${company._id}/generic`;

  return { url: `${base}?secret=${settings.inboundSecret}`, base, secret: settings.inboundSecret };
}

router.get('/me/email', requireOwnCompany, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id)
      .select('+emailChannel.inboundSecret')
      .lean();

    const settings = company?.emailChannel || {};
    const endpoint = inboundEndpoint(req, company);
    const sender = emailChannel.senderFor(company, settings);

    res.json({
      enabled: Boolean(settings.enabled),
      inboundAddress: settings.inboundAddress || '',
      fromName: settings.fromName || '',
      fromAddress: settings.fromAddress || '',
      signature: settings.signature || '',
      inboundUrl: endpoint.url,
      inboundUrlBase: endpoint.base,
      inboundSecret: endpoint.secret,
      // "Is my forwarding working?", answered without sending a test email.
      lastInboundAt: settings.lastInboundAt || null,
      smtpConfigured: Boolean(process.env.EMAIL_HOST),
      // What a customer will see in their inbox, so nobody is surprised that
      // replies come from the platform's address rather than their own.
      sender: sender ? { from: sender.from, replyTo: sender.replyTo || null } : null
    });
  } catch (error) {
    logger.error('Failed to load email settings', { error: error.message });
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

    const previous = company.emailChannel ? company.emailChannel.toObject() : {};

    company.emailChannel = {
      ...previous,
      enabled: Boolean(enabled),
      inboundAddress: inboundAddress ? String(inboundAddress).trim().toLowerCase() : undefined,
      fromName: fromName ? String(fromName).trim() : undefined,
      fromAddress: fromAddress ? String(fromAddress).trim().toLowerCase() : undefined,
      signature: signature !== undefined ? String(signature).trim() : company.emailChannel?.signature
    };

    // The pre-save hook mints the inbound secret the first time the channel is
    // switched on.
    await company.save();

    // Who changed where customers' mail goes, and from what to what. The
    // inbound secret is not part of it.
    const summarise = settings => ({
      enabled: Boolean(settings.enabled),
      inboundAddress: settings.inboundAddress || null,
      fromName: settings.fromName || null,
      fromAddress: settings.fromAddress || null
    });
    audit.record({
      req,
      action: 'email.settings_updated',
      target: { type: 'company', id: String(company._id), label: company.name },
      details: { from: summarise(previous), to: summarise(company.emailChannel) }
    });

    const refreshed = await Company.findById(company._id).select('+emailChannel.inboundSecret').lean();
    const endpoint = inboundEndpoint(req, refreshed);

    res.json({
      success: true,
      inboundUrl: endpoint.url,
      inboundUrlBase: endpoint.base,
      inboundSecret: endpoint.secret
    });
  } catch (error) {
    logger.error('Failed to save email settings', { error: error.message });
    res.status(500).json({ error: 'Failed to save email settings' });
  }
});

/**
 * Send a test email to the signed-in admin, exactly the way replies go out.
 *
 * Works whether or not the channel is switched on: follow-ups to visitors who
 * left a chat are sent the same way, and an admin should be able to check the
 * sending side - and whether it lands in spam - before relying on either.
 */
router.post('/me/email/test', requireOwnCompany, async (req, res) => {
  try {
    const result = await emailChannel.sendTest(req.user.company.id, req.user.email);

    audit.record({
      req,
      action: 'email.test_sent',
      outcome: result.sent ? 'success' : 'failure',
      details: { to: req.user.email || null, reason: result.reason }
    });

    if (!result.sent) {
      return res.status(400).json({ sent: false, error: `The test email could not be sent: ${result.reason}` });
    }

    res.json(result);
  } catch (error) {
    logger.error('Failed to send a test email', { error: error.message });
    res.status(500).json({ error: 'Failed to send the test email' });
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

    // Rotating the key is what an investigation into a misused widget looks
    // for. The prefix is enough to tell which key is current; the log does
    // not need the whole thing.
    await audit.record({
      action: 'widget.key_rotated',
      req,
      target: { type: 'company', id: String(company._id), label: company.name },
      details: { widgetKeyPrefix: String(company.widgetKey).slice(0, 7) }
    });

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

// For the routes below that create companies, switch them off and manage
// their people.
const team = require('../services/team');
const { forgetCompanyStatus } = require('../middleware/auth');

/**
 * Create a company (superadmin only), and invite its first admin.
 *
 * The admin's address is required: there is no made-up `admin@<name>.com`
 * any more, and no password generated here and handed back in the response
 * for somebody to paste into a chat. The admin gets an invitation and
 * chooses their own.
 */
router.post('/', superadmin, async (req, res) => {
  try {
    const { description, website } = req.body;
    const name = requireString(req.body.name);
    const adminEmail = requireString(req.body.adminEmail);
    const adminName = typeof req.body.adminName === 'string' ? req.body.adminName : undefined;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    if (!adminEmail || !team.EMAIL_PATTERN.test(adminEmail.trim())) {
      return res.status(400).json({ error: 'Enter the email address of the company\'s first admin; they will be sent an invitation' });
    }

    // Check if company with this name already exists
    const existingCompany = await Company.findOne({ name });
    if (existingCompany) {
      return res.status(400).json({ error: 'Company with this name already exists' });
    }

    if (await User.exists({ email: adminEmail.trim().toLowerCase() })) {
      return res.status(400).json({ error: 'Someone with that address already has an account' });
    }

    // Create new company
    const company = new Company({
      name,
      description,
      website,
      createdVia: 'superadmin',
      createdBy: req.user.id
    });

    await company.save();

    let invitation;
    try {
      invitation = await team.invite({
        email: adminEmail,
        name: adminName,
        role: 'company_admin',
        company,
        invitedBy: req.user
      });
    } catch (error) {
      // The company is useless without someone to run it, so it goes too.
      await Company.deleteOne({ _id: company._id }).catch(() => {});
      if (error instanceof team.TeamError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }

    audit.record({
      req,
      action: 'company.created',
      company: company._id,
      target: { type: 'company', id: String(company._id), label: company.name },
      details: { adminEmail: invitation.user.email, invitationEmailed: invitation.sent }
    });

    res.status(201).json({
      message: invitation.sent
        ? `Company created. An invitation is on its way to ${invitation.user.email}.`
        : 'Company created, but the invitation could not be emailed. Send the admin the link below.',
      company,
      admin: {
        id: invitation.user._id,
        username: invitation.user.username,
        email: invitation.user.email,
        invitePending: true
      },
      inviteSent: invitation.sent,
      // Only when the email could not go, so somebody can pass it on by hand.
      inviteLink: invitation.link
    });
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

/**
 * Switch a whole company off, or back on.
 *
 * Off means off: sign-in and every API call already refuse its people (see
 * middleware/auth.js), and here their open dashboards are disconnected too, so
 * nobody keeps receiving a queue the company is no longer paying to have.
 */
async function applyCompanyStatus(company) {
  forgetCompanyStatus(company._id);
  tenantService.invalidate();

  if (company.isActive !== false) {
    return 0;
  }

  const people = await User.find({ company: company._id }).select('_id').lean();
  people.forEach(person => team.disconnect(person._id, 'company_inactive'));
  return people.length;
}

// Update company (superadmin or company admin of the same company)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { description, website, isActive } = req.body;
    const name = req.body.name === undefined ? undefined : requireString(req.body.name);

    if (name === null) {
      return res.status(400).json({ error: 'Company name must be text' });
    }

    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: 'Company not found' });
    }

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

    const before = { name: company.name, description: company.description, website: company.website };
    const wasActive = company.isActive !== false;

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
      company.isActive = Boolean(isActive);
    }

    await company.save();

    const statusChanged = wasActive !== (company.isActive !== false);
    const disconnected = statusChanged ? await applyCompanyStatus(company) : 0;

    if (statusChanged) {
      audit.record({
        req,
        action: company.isActive === false ? 'company.deactivated' : 'company.activated',
        company: company._id,
        target: { type: 'company', id: String(company._id), label: company.name },
        details: company.isActive === false ? { peopleSignedOut: disconnected } : undefined
      });
    }

    const changed = Object.keys(before).filter(key => before[key] !== company[key]);
    if (changed.length > 0) {
      audit.record({
        req,
        action: 'company.updated',
        company: company._id,
        target: { type: 'company', id: String(company._id), label: company.name },
        details: { changed, from: before.name !== company.name ? before.name : undefined }
      });
    }

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

    // What the company's customers gave it goes with it: conversations,
    // contacts, files, and every credential it stored for its own systems.
    // Before the company document, so a failure leaves something to retry.
    const purged = await require('../services/uploads').purgeCompanyData(company._id);

    // Delete company
    await Company.findByIdAndDelete(id);

    // Recorded against no company: the company it would belong to is gone,
    // and a superadmin is the one who will look for it.
    audit.record({
      req,
      action: 'company.deleted',
      company: null,
      target: { type: 'company', id: String(company._id), label: company.name },
      details: {
        conversations: purged.conversations,
        contacts: purged.contacts,
        other: purged.other
      }
    });

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

    // Get users for this company. Removed people are not part of it any more.
    const users = await User.find(
      { company: id, deletedAt: { $exists: false } },
      { _id: 1, username: 1, displayName: 1, email: 1, role: 1, isActive: 1, lastLogin: 1, createdAt: 1, invitePending: 1 }
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
    const { displayName, password } = req.body;
    const username = requireString(req.body.username);
    const email = requireString(req.body.email);

    if (!username || !email) {
      return res.status(400).json({ error: 'Username and email are required' });
    }

    if (password !== undefined && password !== '' && passwordProblem(password)) {
      return res.status(400).json({ error: passwordProblem(password) });
    }

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
      setPassword(admin, password);
    }

    await admin.save();
    if (password) {
      team.disconnect(admin._id, 'password_changed');
    }

    audit.record({
      req,
      action: password ? 'company.user_password_reset' : 'operator.updated',
      company: company._id,
      target: { type: 'user', id: String(admin._id), label: admin.displayName || admin.username },
      details: { email: admin.email, role: admin.role }
    });

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
      if (passwordProblem(password)) {
        return res.status(400).json({ error: passwordProblem(password) });
      }
      newPassword = password;
    } else {
      return res.status(400).json({ error: 'Either password or generateRandom must be provided' });
    }

    // Update password
    setPassword(admin, newPassword);
    await admin.save();
    team.disconnect(admin._id, 'password_changed');

    audit.record({
      req,
      action: 'company.user_password_reset',
      company: company._id,
      target: { type: 'user', id: String(admin._id), label: admin.displayName || admin.username },
      details: { generated: Boolean(generateRandom) }
    });

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
    const { name, displayName, role, password } = req.body;
    const username = requireString(req.body.username);
    const email = requireString(req.body.email);

    // Validate input
    if (!username || !email) {
      return res.status(400).json({ error: 'Username and email are required' });
    }

    if (password !== undefined && password !== '' && passwordProblem(password)) {
      return res.status(400).json({ error: passwordProblem(password) });
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
    const previousRole = user.role;
    if (role) {
      user.role = role;
    }
    if (password) {
      setPassword(user, password);
    }

    await user.save();
    if (password) {
      team.disconnect(user._id, 'password_changed');
    }

    audit.record({
      req,
      action: previousRole !== user.role ? 'operator.role_changed' : 'operator.updated',
      company: company._id,
      target: { type: 'user', id: String(user._id), label: user.displayName || user.username },
      details: previousRole !== user.role
        ? { from: previousRole, to: user.role }
        : { email: user.email, passwordChanged: Boolean(password) }
    });

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

// Create company user (superadmin only). A seat is a billable resource, so
// the plan is consulted before the account exists.
router.post('/:id/users', superadmin, enforceLimit('operators'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, displayName, role, password } = req.body;
    const username = requireString(req.body.username);
    const email = requireString(req.body.email);

    // Validate input
    if (!username || !email || !password || !role) {
      return res.status(400).json({ error: 'Username, email, password, and role are required' });
    }

    if (passwordProblem(password)) {
      return res.status(400).json({ error: passwordProblem(password) });
    }

    // Check if company exists
    const company = await Company.findById(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
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

    audit.record({
      req,
      action: 'operator.created',
      company: company._id,
      target: { type: 'user', id: String(user._id), label: user.displayName || user.username },
      details: { role: user.role, email: user.email }
    });

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
      if (passwordProblem(password)) {
        return res.status(400).json({ error: passwordProblem(password) });
      }
      newPassword = password;
    } else {
      return res.status(400).json({ error: 'Either password or generateRandom must be provided' });
    }

    // Update password
    setPassword(user, newPassword);
    await user.save();
    team.disconnect(user._id, 'password_changed');

    audit.record({
      req,
      action: 'company.user_password_reset',
      company: company._id,
      target: { type: 'user', id: String(user._id), label: user.displayName || user.username },
      details: { generated: Boolean(generateRandom) }
    });

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

    // Update user status. Deactivating someone signs them out everywhere and
    // hands their open conversations back to the queue, exactly as on the
    // team screen.
    const wasActive = user.isActive;
    user.isActive = Boolean(isActive);
    await user.save();

    const effect = wasActive && !user.isActive
      ? await team.lockOut(user).catch(() => ({ released: 0 }))
      : null;

    audit.record({
      req,
      action: user.isActive ? 'operator.activated' : 'operator.deactivated',
      company: company._id,
      target: { type: 'user', id: String(user._id), label: user.displayName || user.username },
      details: effect ? { chatsReturnedToQueue: effect.released } : undefined
    });

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
