/**
 * Agencies and their clients. Mounted at /api/agency.
 *
 * Two audiences:
 *
 *   an agency's admins   their clients - list, add, open, remove - and their
 *                        own brand. Not while working as a client: these are
 *                        the agency's screens, and a session in a client's
 *                        dashboard is not the agency's session.
 *   a superadmin         which companies are agencies, and how many clients
 *                        each may hold
 *
 * Everything that changes something is in the audit log of the company it
 * changed, and an agency's actions on a client in the client's log too, so a
 * client can always see what its agency did.
 */

const express = require('express');
const mongoose = require('mongoose');

const Company = require('../models/company');
const User = require('../models/user');
const agencyService = require('../services/agency');
const audit = require('../services/audit');
const { auth, superadmin } = require('../middleware/auth');
const { logger } = require('../services/logging');

const router = express.Router();

router.use(auth);

/** The caller's agency, or a refusal that says why. */
async function requireAgencyAdmin(req, res, next) {
  try {
    if (!req.user || req.user.role !== 'company_admin' || !req.user.company) {
      return res.status(403).json({ error: 'Only an agency\'s admins can manage its clients' });
    }
    if (req.user.actingAs) {
      return res.status(403).json({ error: 'Return to your agency first: these are your agency\'s screens.', code: 'ACTING_AS' });
    }
    const company = await Company.findById(req.user.company.id);
    if (!company || !company.agency || !company.agency.isAgency) {
      return res.status(403).json({ error: 'Your company is not set up as an agency', code: 'NOT_AGENCY' });
    }
    req.agency = company;
    next();
  } catch (error) {
    logger.error('Could not check the agency', { error: error.message });
    res.status(500).json({ error: 'Could not check your agency' });
  }
}

function validId(id) {
  return typeof id === 'string' && mongoose.isValidObjectId(id);
}

function sendAgencyError(res, error, fallback) {
  if (error instanceof agencyService.AgencyError || (error && error.name === 'TeamError') || (error && error.status && error.status < 500)) {
    return res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
  logger.error(fallback, { error: error.message });
  return res.status(500).json({ error: fallback });
}

// ------------------------------------------------------------- the agency

/** The agency's terms, client count and brand. */
router.get('/me', requireAgencyAdmin, async (req, res) => {
  try {
    res.json(await agencyService.overview(req.agency));
  } catch (error) {
    sendAgencyError(res, error, 'Could not load your agency');
  }
});

/** Every client, with what an agency checks on each. */
router.get('/clients', requireAgencyAdmin, async (req, res) => {
  try {
    res.json({ clients: await agencyService.listClients(req.agency._id) });
  } catch (error) {
    sendAgencyError(res, error, 'Could not load your clients');
  }
});

/**
 * Add a client: a new company, linked to this agency, and an invitation to
 * its first admin. `plan` is `trial` (the default) or the agency's client
 * plan, which the agency pays for as part of its own subscription.
 */
router.post('/clients', requireAgencyAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const { company, invitation } = await agencyService.createClient({
      agency: req.agency,
      name: body.name,
      website: body.website,
      adminEmail: body.adminEmail,
      adminName: typeof body.adminName === 'string' ? body.adminName : undefined,
      planId: typeof body.plan === 'string' && body.plan ? body.plan : 'trial',
      invitedBy: req.user
    });

    const details = { client: company.name, adminEmail: invitation.user.email, invitationEmailed: invitation.sent };
    audit.record({
      req,
      action: 'agency.client_created',
      company: req.agency._id,
      target: { type: 'company', id: String(company._id), label: company.name },
      details
    });
    audit.record({
      req,
      action: 'company.created',
      company: company._id,
      target: { type: 'company', id: String(company._id), label: company.name },
      details: { ...details, agency: req.agency.name }
    });

    res.status(201).json({
      message: invitation.sent
        ? `${company.name} is set up. An invitation is on its way to ${invitation.user.email}.`
        : `${company.name} is set up, but the invitation could not be emailed. Send the admin the link below.`,
      client: { id: company._id, name: company.name },
      inviteSent: invitation.sent,
      // Only when the email could not go, so somebody can pass it on by hand.
      inviteLink: invitation.link
    });
  } catch (error) {
    sendAgencyError(res, error, 'Could not add the client');
  }
});

/**
 * Open a client's dashboard: a one-hour token to work in it as its admin.
 * The dashboard keeps the agency's own token aside and goes back to it from
 * the banner. Every request made with this one is in the client's audit log.
 */
router.post('/clients/:id/open', requireAgencyAdmin, async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(404).json({ error: 'Client not found' });
    }
    const client = await agencyService.findClient(req.agency._id, req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    if (client.isActive === false) {
      return res.status(409).json({ error: `${client.name} is switched off, so its dashboard cannot be opened` });
    }

    const user = await User.findById(req.user.id).select('username tokenVersion');
    const { issueActingToken } = require('./auth');
    const token = issueActingToken(user, client);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    audit.record({
      req,
      action: 'agency.client_opened',
      company: req.agency._id,
      target: { type: 'company', id: String(client._id), label: client.name }
    });
    audit.record({
      req,
      action: 'agency.acted_as',
      company: client._id,
      target: { type: 'company', id: String(client._id), label: client.name },
      details: { event: 'session_started', agency: req.agency.name, agencyId: String(req.agency._id), expiresAt }
    });

    res.json({ token, expiresAt, client: { id: client._id, name: client.name } });
  } catch (error) {
    sendAgencyError(res, error, 'Could not open the client\'s dashboard');
  }
});

/**
 * Remove a client from the agency. Detaches; deletes nothing. The client
 * keeps its people, settings and conversations, and carries on as a company
 * of its own.
 */
router.delete('/clients/:id', requireAgencyAdmin, async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(404).json({ error: 'Client not found' });
    }
    const client = await agencyService.detachClient(req.agency._id, req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    audit.record({
      req,
      action: 'agency.client_removed',
      company: req.agency._id,
      target: { type: 'company', id: String(client._id), label: client.name }
    });
    audit.record({
      req,
      action: 'agency.client_removed',
      company: client._id,
      target: { type: 'company', id: String(client._id), label: client.name },
      details: { agency: req.agency.name }
    });

    res.json({ success: true, message: `${client.name} is no longer one of your clients. Nothing of theirs was deleted.` });
  } catch (error) {
    sendAgencyError(res, error, 'Could not remove the client');
  }
});

/** The agency's brand, shown to its clients in place of the product's. */
router.put('/branding', requireAgencyAdmin, async (req, res) => {
  try {
    if (!(await require('../services/usage').hasFeature(req.agency._id, 'customBranding'))) {
      return res.status(402).json({ error: 'Your own brand comes with the Agency plan. See Plan & billing.', code: 'FEATURE_NOT_AVAILABLE' });
    }

    const branding = agencyService.cleanBranding(req.body || {});
    const before = req.agency.toObject().branding || {};
    req.agency.branding = branding;
    await req.agency.save();

    audit.record({
      req,
      action: 'agency.branding_changed',
      company: req.agency._id,
      target: { type: 'company', id: String(req.agency._id), label: req.agency.name },
      details: {
        changed: Object.keys(branding).filter(key => (before[key] || '') !== (branding[key] || ''))
      }
    });

    res.json({ success: true, branding });
  } catch (error) {
    sendAgencyError(res, error, 'Could not save your brand');
  }
});

// ------------------------------------------------------------- superadmin

/**
 * Which companies are agencies and which are their clients, for the
 * platform's company list.
 */
router.get('/companies', superadmin, async (req, res) => {
  try {
    const rows = await Company.find({ $or: [{ 'agency.isAgency': true }, { 'agency.parent': { $exists: true, $ne: null } }] })
      .select('name agency').lean();
    const names = new Map(rows.map(row => [String(row._id), row.name]));
    const parents = rows.filter(row => row.agency && row.agency.parent).map(row => row.agency.parent);
    const missing = parents.filter(id => !names.has(String(id)));
    if (missing.length) {
      (await Company.find({ _id: { $in: missing } }).select('name').lean())
        .forEach(row => names.set(String(row._id), row.name));
    }
    const clientCounts = new Map();
    parents.forEach(id => clientCounts.set(String(id), (clientCounts.get(String(id)) || 0) + 1));

    res.json({
      agencies: rows.filter(row => row.agency && row.agency.isAgency).map(row => ({
        id: row._id,
        name: row.name,
        clients: clientCounts.get(String(row._id)) || 0,
        clientLimit: agencyService.clientLimitOf(row)
      })),
      clients: rows.filter(row => row.agency && row.agency.parent).map(row => ({
        id: row._id,
        name: row.name,
        agencyId: row.agency.parent,
        agencyName: names.get(String(row.agency.parent)) || null
      }))
    });
  } catch (error) {
    logger.error('Could not list agencies', { error: error.message });
    res.status(500).json({ error: 'Could not list agencies' });
  }
});

/**
 * Make a company an agency, or stop it being one, and set how many clients
 * it may hold. Stopping does not detach its clients: their link stays, so
 * switching it back on restores everything, but while it is off nobody can
 * open their dashboards and they wear the product's brand.
 */
router.patch('/companies/:id', superadmin, async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(404).json({ error: 'Company not found' });
    }
    const company = await Company.findById(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const body = req.body || {};
    if (body.isAgency !== undefined && typeof body.isAgency !== 'boolean') {
      return res.status(400).json({ error: 'isAgency must be true or false' });
    }
    if (body.clientLimit !== undefined && body.clientLimit !== null
        && (!Number.isInteger(body.clientLimit) || body.clientLimit < 0 || body.clientLimit > 10000)) {
      return res.status(400).json({ error: 'clientLimit must be a whole number, or null for the default' });
    }
    if (body.isAgency === true && company.agency && company.agency.parent) {
      return res.status(409).json({ error: 'This company is another agency\'s client. Remove it from that agency first.' });
    }

    const was = Boolean(company.agency && company.agency.isAgency);
    if (!company.agency) {
      company.agency = {};
    }
    if (body.isAgency !== undefined) {
      company.agency.isAgency = body.isAgency;
    }
    if (body.clientLimit !== undefined) {
      company.agency.clientLimit = body.clientLimit === null ? undefined : body.clientLimit;
    }
    await company.save();

    const now = Boolean(company.agency.isAgency);
    audit.record({
      req,
      action: was === now ? 'agency.updated' : (now ? 'agency.enabled' : 'agency.disabled'),
      company: company._id,
      target: { type: 'company', id: String(company._id), label: company.name },
      details: { clientLimit: agencyService.clientLimitOf(company) }
    });

    res.json({
      success: true,
      company: {
        id: company._id,
        name: company.name,
        isAgency: now,
        clientLimit: agencyService.clientLimitOf(company)
      }
    });
  } catch (error) {
    logger.error('Could not change the agency', { error: error.message });
    res.status(500).json({ error: 'Could not change the agency' });
  }
});

module.exports = router;
