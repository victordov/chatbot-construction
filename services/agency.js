/**
 * Agencies: companies that set up and run support desks for their clients.
 *
 * An agency is an ordinary company a superadmin has marked as one. Its
 * clients are ordinary companies too, with `agency.parent` pointing back at
 * it; everything a client owns stays the client's, so removing a client from
 * an agency detaches it and deletes nothing.
 *
 * What being an agency adds:
 *
 *   - a list of its clients, with how each one is doing
 *   - creating a client and inviting its first admin in one step
 *   - opening a client's dashboard as the agency (middleware/auth.js)
 *   - its own brand on its clients' dashboards, sign-in pages and mail, when
 *     its plan has `customBranding`
 */

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Subscription = require('../models/subscription');
const Usage = require('../models/usage');
const User = require('../models/user');
const accountEmail = require('./account-email');
const { agencyTerms, defaultClientLimit } = require('../config/plans');
const { isSafeLogoUrl } = require('../config/widget-languages');
const { logger } = require('./logging');

class AgencyError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The product's own brand: what everyone sees unless an agency's applies. */
function platformBrand() {
  return { productName: accountEmail.productName(), logoUrl: null, primaryColor: null, supportEmail: null, custom: false };
}

/**
 * Whether a company's brand is in force: it is an agency, switched on, has
 * named its brand, and is on a plan with `customBranding`. A lapsed agency's
 * clients go back to the product's brand rather than wearing one nobody pays
 * for.
 */
async function brandInForce(owner) {
  if (!owner || owner.isActive === false || !owner.agency || !owner.agency.isAgency) {
    return false;
  }
  if (!owner.branding || !owner.branding.productName) {
    return false;
  }
  // Lazily: usage.js reaches this file through account-email.js.
  return require('./usage').hasFeature(owner._id, 'customBranding');
}

/**
 * The brand one company's people see: their agency's when they are an
 * agency's client, the agency's own for the agency itself, the product's
 * otherwise. Never throws; anything unexpected is the product's brand.
 *
 * @returns {Promise<{productName, logoUrl, primaryColor, supportEmail, custom: boolean}>}
 */
async function effectiveBranding(companyId) {
  try {
    if (!companyId) {
      return platformBrand();
    }
    const company = await Company.findById(companyId).select('name isActive agency branding').lean();
    if (!company) {
      return platformBrand();
    }

    const owner = company.agency && company.agency.parent
      ? await Company.findById(company.agency.parent).select('name isActive agency branding').lean()
      : company;

    if (!(await brandInForce(owner))) {
      return platformBrand();
    }

    return {
      productName: owner.branding.productName,
      logoUrl: owner.branding.logoUrl || null,
      primaryColor: owner.branding.primaryColor || null,
      supportEmail: owner.branding.supportEmail || null,
      custom: true
    };
  } catch (error) {
    // An id that is not an id, or a database blip: the product's own name is
    // always a safe thing to show.
    if (error.name !== 'CastError') {
      logger.warn('Could not resolve branding', { error: error.message });
    }
    return platformBrand();
  }
}

/** The brand an invitation link's page should wear. */
async function brandingForInvite(token) {
  const user = await require('./team').findInvite(token).catch(() => null);
  return effectiveBranding(user && user.company ? user.company._id : null);
}

/**
 * Check and tidy an agency's brand before saving it.
 *
 * @returns {object} the clean brand
 * @throws {AgencyError}
 */
function cleanBranding(input = {}) {
  const text = value => (typeof value === 'string' ? value.trim() : '');
  const brand = {
    productName: text(input.productName).slice(0, 60),
    logoUrl: text(input.logoUrl),
    primaryColor: text(input.primaryColor),
    supportEmail: text(input.supportEmail).toLowerCase()
  };

  if (!brand.productName) {
    throw new AgencyError('Give your brand a name: it replaces the product name your clients see');
  }
  if (brand.logoUrl && !isSafeLogoUrl(brand.logoUrl)) {
    throw new AgencyError('The logo must be an https:// address');
  }
  if (brand.primaryColor && !COLOR_PATTERN.test(brand.primaryColor)) {
    throw new AgencyError('The colour must look like #1a73e8');
  }
  if (brand.supportEmail && !EMAIL_PATTERN.test(brand.supportEmail)) {
    throw new AgencyError('Enter a valid support email address');
  }
  return brand;
}

/** How many clients an agency may hold. */
function clientLimitOf(agency) {
  const own = agency && agency.agency ? agency.agency.clientLimit : undefined;
  return Number.isFinite(own) ? own : defaultClientLimit();
}

/**
 * What the agency's own screen needs: its terms, its clients count and what
 * the clients beyond the included ones add to the bill.
 */
async function overview(agency) {
  const terms = agencyTerms();
  const clients = await Company.countDocuments({ 'agency.parent': agency._id });
  const extra = Math.max(0, clients - terms.clientsIncluded);

  return {
    isAgency: true,
    clients,
    clientLimit: clientLimitOf(agency),
    clientsIncluded: terms.clientsIncluded,
    perClientPrice: terms.perClientPrice,
    extraClients: extra,
    extraClientsCost: Math.round(extra * terms.perClientPrice * 100) / 100,
    clientPlan: terms.clientPlan,
    branding: {
      productName: (agency.branding && agency.branding.productName) || '',
      logoUrl: (agency.branding && agency.branding.logoUrl) || '',
      primaryColor: (agency.branding && agency.branding.primaryColor) || '',
      supportEmail: (agency.branding && agency.branding.supportEmail) || ''
    },
    brandingAllowed: await require('./usage').hasFeature(agency._id, 'customBranding')
  };
}

/** A subscription's status as a person would say it, from a lean row. */
function statusOf(subscription, now) {
  if (!subscription) {
    return 'trialing';
  }
  return subscription.status === 'trialing' && subscription.trialEndsAt && new Date(subscription.trialEndsAt) < now
    ? 'trial_expired'
    : subscription.status;
}

/**
 * The agency's clients, with what an agency checks on each: plan and its
 * state, whether the widget is installed, conversations this month, how many
 * of them the bot resolved, and when anything last happened.
 */
async function listClients(agencyId) {
  const resolutions = require('./resolutions');
  const clients = await Company.find({ 'agency.parent': agencyId }).sort({ name: 1 }).lean();
  const ids = clients.map(client => client._id);
  const period = Usage.currentPeriod();
  const now = new Date();

  const [subscriptions, usage, activity] = await Promise.all([
    Subscription.find({ company: { $in: ids } }).lean(),
    Usage.find({ company: { $in: ids }, period }).lean(),
    Conversation.aggregate([
      { $match: { company: { $in: ids } } },
      { $group: { _id: '$company', lastActivity: { $max: '$lastActivity' } } }
    ])
  ]);

  const subscriptionOf = new Map(subscriptions.map(row => [String(row.company), row]));
  const usageOf = new Map(usage.map(row => [String(row.company), row]));
  const lastActivityOf = new Map(activity.map(row => [String(row._id), row.lastActivity]));

  // The report's own definition, over this month so far: a rate to compare
  // clients by, not a bill, so open conversations count too.
  const stats = await Promise.all(ids.map(id =>
    resolutions.statsForPeriod(id, period, { settledOnly: false }).catch(() => null)));

  return clients.map((client, index) => {
    const subscription = subscriptionOf.get(String(client._id));
    const rate = stats[index] && stats[index].conversations
      ? Math.round((stats[index].botResolved / stats[index].conversations) * 100)
      : null;
    return {
      id: client._id,
      name: client.name,
      website: client.website || '',
      isActive: client.isActive !== false,
      planId: subscription ? subscription.planId : 'trial',
      status: statusOf(subscription, now),
      managedByAgency: Boolean(subscription && subscription.managedByAgency),
      installed: Boolean(client.widgetSeen && client.widgetSeen.at),
      widgetSeenAt: client.widgetSeen ? client.widgetSeen.at || null : null,
      conversationsThisMonth: (usageOf.get(String(client._id)) || {}).conversations || 0,
      resolutionRate: rate,
      lastActivity: lastActivityOf.get(String(client._id)) || null,
      attachedAt: client.agency ? client.agency.attachedAt || null : null
    };
  });
}

/**
 * Create a client company for an agency and invite its first admin.
 *
 * The client starts on a trial, or on the agency's client plan when the
 * agency is paying for it (`planId` equal to that plan). The invitation goes
 * through the ordinary team invitation, so it is the same link, the same
 * seven days and the same password page - under the agency's brand.
 *
 * @returns {Promise<{company: object, invitation: {user, sent, link?}}>}
 * @throws {AgencyError|TeamError}
 */
async function createClient({ agency, name, website, adminEmail, adminName, planId = 'trial', invitedBy }) {
  const team = require('./team');
  const usage = require('./usage');
  const billing = require('./billing');

  const companyName = typeof name === 'string' ? name.trim() : '';
  const email = typeof adminEmail === 'string' ? adminEmail.trim().toLowerCase() : '';
  const terms = agencyTerms();

  if (!companyName) {
    throw new AgencyError('Enter the client\'s company name');
  }
  if (!team.EMAIL_PATTERN.test(email)) {
    throw new AgencyError('Enter the email address of the client\'s first admin; they will be sent an invitation');
  }
  if (!['trial', terms.clientPlan].includes(planId)) {
    throw new AgencyError(`A client starts on a trial or on the ${terms.clientPlan} plan`);
  }

  const subscription = await usage.getSubscription(agency._id);
  if (!subscription.isEntitled()) {
    throw new AgencyError('Your own plan is not active, so new clients cannot be added. See Plan & billing.', 402, 'AGENCY_NOT_ENTITLED');
  }
  // A client on the agency-paid plan is billed to the agency. An agency still
  // on its trial, or not on the Agency plan, pays for nothing yet, so it can
  // add clients only on their own trials.
  if (planId !== 'trial' && !(subscription.planId === 'agency' && subscription.status === 'active')) {
    throw new AgencyError(
      `Clients go on the ${terms.clientPlan} plan once your Agency plan is paid for. Until then, add them on a trial.`,
      402,
      'AGENCY_NOT_PAYING'
    );
  }

  const limit = clientLimitOf(agency);
  if (await Company.countDocuments({ 'agency.parent': agency._id }) >= limit) {
    throw new AgencyError(`Your agency can hold ${limit} clients. Remove one, or ask us to raise the limit.`, 403, 'CLIENT_LIMIT');
  }
  if (await Company.exists({ name: companyName })) {
    throw new AgencyError('A company with that name already exists', 409, 'NAME_TAKEN');
  }
  if (await User.exists({ email })) {
    throw new AgencyError('Someone with that address already has an account', 409, 'EMAIL_TAKEN');
  }

  const company = await Company.create({
    name: companyName,
    website: typeof website === 'string' ? website.trim().slice(0, 300) : undefined,
    createdBy: invitedBy && invitedBy.id,
    agency: { parent: agency._id, attachedAt: new Date() }
  });

  try {
    if (planId === 'trial') {
      await Subscription.forCompany(company._id);
    } else {
      await billing.applySubscriptionChange(company._id, { planId, status: 'active' });
      await Subscription.updateOne({ company: company._id }, { $set: { managedByAgency: agency._id } });
      usage.invalidateSubscription(company._id);
    }

    const invitation = await team.invite({
      email,
      name: adminName,
      role: 'company_admin',
      company,
      invitedBy
    });

    return { company, invitation };
  } catch (error) {
    // A company nobody can sign into is no use to anyone, so it goes too.
    await Subscription.deleteOne({ company: company._id }).catch(() => {});
    await Company.deleteOne({ _id: company._id }).catch(() => {});
    throw error;
  }
}

/** One of this agency's clients, or null. */
function findClient(agencyId, clientId) {
  return Company.findOne({ _id: clientId, 'agency.parent': agencyId });
}

/**
 * Take a client off an agency's books. Nothing of the client's is deleted:
 * it carries on as a company of its own, with its people, settings and
 * history. A plan the agency was paying for ends, and the client gets a
 * fresh trial to choose its own; a plan the client pays for itself stays.
 * Any open "working as" session for it stops at its next request, because
 * the parent link it depends on is gone.
 *
 * @returns {Promise<object|null>} the client, or null when it is not theirs
 */
async function detachClient(agencyId, clientId) {
  const client = await findClient(agencyId, clientId);
  if (!client) {
    return null;
  }

  client.agency.parent = undefined;
  client.agency.attachedAt = undefined;
  client.agency.detachedFrom = agencyId;
  client.agency.detachedAt = new Date();
  await client.save();

  const subscription = await Subscription.findOne({ company: client._id });
  if (subscription && subscription.managedByAgency && String(subscription.managedByAgency) === String(agencyId)) {
    subscription.planId = 'trial';
    subscription.status = 'trialing';
    subscription.trialEndsAt = new Date(Date.now() + Subscription.trialDays() * 24 * 60 * 60 * 1000);
    subscription.managedByAgency = undefined;
    subscription.pricingModel = 'flat';
    await subscription.save();
    require('./usage').invalidateSubscription(client._id);
  }

  return client;
}

module.exports = {
  AgencyError,
  platformBrand,
  effectiveBranding,
  brandingForInvite,
  cleanBranding,
  clientLimitOf,
  overview,
  listClients,
  createClient,
  findClient,
  detachClient
};
