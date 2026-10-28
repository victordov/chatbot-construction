const jwt = require('jsonwebtoken');
const User = require('../models/user');
const Company = require('../models/company');
const RevokedToken = require('../models/revoked-token');
const audit = require('../services/audit');

/**
 * Why a session was refused, for the cases a person can do something about.
 *
 * Sent as a `X-Auth-Reason` header beside the usual 401 so the dashboard can
 * say "your company's account has been deactivated" instead of "your session
 * expired", which would send them round a sign-in that cannot succeed.
 */
const REASONS = {
  COMPANY_INACTIVE: 'company_inactive',
  ACCOUNT_DISABLED: 'account_disabled'
};

function refuse(res, reason, message) {
  if (reason) {
    res.set('X-Auth-Reason', reason);
  }
  return res.status(401).json({
    error: message || 'Token is not valid',
    code: reason === REASONS.COMPANY_INACTIVE ? 'COMPANY_DEACTIVATED'
      : reason === REASONS.ACCOUNT_DISABLED ? 'ACCOUNT_DISABLED'
        : 'TOKEN_INVALID'
  });
}

/** Whether a populated (or lean) company is switched off. */
function companyInactive(company) {
  return Boolean(company && company.isActive === false);
}

const COMPANY_INACTIVE_MESSAGE = 'This company\'s account has been deactivated. Contact the people who run this service to restore it.';

/**
 * Whether a token id has been signed out.
 *
 * Tokens minted before ids existed have none and cannot be signed out one at
 * a time; `/api/auth/logout` falls back to ending every session for those.
 */
async function isRevoked(jti) {
  if (!jti) {
    return false;
  }
  return Boolean(await RevokedToken.exists({ _id: String(jti) }));
}

/**
 * Whether a "working as" token still holds, and for which client.
 *
 * An agency admin who opens a client's dashboard gets a short token (routes/
 * auth.js `issueActingToken`) carrying `actingAs: { companyId, by }`. It is
 * honoured only while everything that justified it is still true: the token
 * was issued to this person, they are an admin of a company that is still an
 * agency, and the client is still switched on and still that agency's
 * client. Detaching the client, or the agency losing its status, ends every
 * such session at its next request.
 *
 * @param {object} decoded the verified token
 * @param {object} user the token's user, with `company` populated (agency)
 * @returns {Promise<{client: object, agency: object}|null>}
 */
async function actingScope(decoded, user) {
  const acting = decoded && decoded.actingAs;
  if (!acting || !acting.companyId || String(acting.by) !== String(user._id)) {
    return null;
  }
  const agency = user.company;
  if (user.role !== 'company_admin' || !agency || !agency.agency || !agency.agency.isAgency) {
    return null;
  }
  const client = await Company.findById(acting.companyId).select('name isActive agency').lean().catch(() => null);
  if (!client || client.isActive === false || !client.agency
      || String(client.agency.parent) !== String(agency._id)) {
    return null;
  }
  return { client, agency };
}

/**
 * For the socket layer: what an acting token's connection is scoped to.
 * Throws when the token no longer holds, so a handshake that awaits it is
 * refused. The integrator wires this into websockets.js.
 */
async function actingSocketScope(decoded, user) {
  const populated = user.company && user.company.agency !== undefined
    ? user
    : await User.findById(user._id).select('role company').populate('company', 'name isActive agency');
  const scope = await actingScope(decoded, populated);
  if (!scope) {
    throw new Error('Authentication failed: this client session has ended');
  }
  // Never offered chats: the agency is visiting, not on the client's rota.
  return { companyId: String(scope.client._id), role: 'company_admin', acceptingChats: false, actingAs: true };
}

// Middleware to verify JWT token
const auth = async (req, res, next) => {
  try {
    // Get token from header
    const token = req.header('x-auth-token');

    if (!token) {
      return res.status(401).json({ error: 'No token, authorization denied' });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'chatbot-jwt-secret');

    // Check if user still exists and is active. The company comes with it
    // because a switched-off company switches off everybody in it, and the
    // populate is already paid for: every route reads the company's name.
    const user = await User.findById(decoded.id)
      .select('username displayName email role company isActive tokenVersion invitePending')
      .populate('company', 'name isActive agency');
    if (!user) {
      return res.status(401).json({ error: 'Token is not valid' });
    }
    if (!user.isActive || user.invitePending) {
      return refuse(res, REASONS.ACCOUNT_DISABLED, 'This account has been deactivated');
    }

    // A token is only as current as the password it was issued under. Every
    // password change, reset and "sign out everywhere" bumps `tokenVersion`,
    // so a token minted before that carries a stale `tv` and is refused here -
    // an eight-hour JWT would otherwise outlive the credentials it proved.
    // Tokens issued before this field existed carry no `tv`, which is 0.
    const issuedVersion = Number(decoded.tv) || 0;
    if (issuedVersion !== (user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Token is not valid' });
    }

    // Signed out of this one browser, while the others carry on.
    if (await isRevoked(decoded.jti)) {
      return res.status(401).json({ error: 'Token is not valid' });
    }

    // A superadmin has no company; everyone else stops when theirs does.
    if (user.role !== 'superadmin' && companyInactive(user.company)) {
      return refuse(res, REASONS.COMPANY_INACTIVE, COMPANY_INACTIVE_MESSAGE);
    }

    // Add user to request.
    //
    // `displayName` is included because several routes attribute records to
    // "displayName || username" - notes, transfers, task comments. Without it
    // every one of those silently fell back to the username, so a note written
    // by Bea Baker was signed "admin".
    req.user = {
      id: user._id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      company: user.company ? {
        id: user.company._id,
        name: user.company.name
      } : null
    };
    // The token's own id and expiry, so signing out of this browser can name
    // exactly this token.
    req.token = { jti: decoded.jti || null, exp: decoded.exp || null };

    // An agency admin working in a client's dashboard: the same person, the
    // client's company, an admin there - and every request on the record.
    if (decoded.actingAs) {
      const scope = await actingScope(decoded, user);
      if (!scope) {
        return res.status(401).json({ error: 'This client session has ended. Return to your agency.', code: 'ACTING_ENDED' });
      }
      const { client, agency } = scope;
      req.user.role = 'company_admin';
      req.user.company = { id: client._id, name: client.name };
      // What the client's team reads in notes, transfers and the audit log:
      // who did it, and on whose behalf.
      req.user.displayName = `${user.displayName || user.username} (${agency.name})`;
      req.user.actingAs = {
        companyId: String(client._id),
        companyName: client.name,
        agencyId: String(agency._id),
        agencyName: agency.name,
        by: String(user._id),
        expiresAt: decoded.exp ? new Date(decoded.exp * 1000) : null
      };
      // Every request, reads included: the client is entitled to know what
      // the agency looked at, not only what it changed. Not awaited - the
      // record never blocks the request it records.
      audit.record({
        req,
        action: 'agency.acted_as',
        company: client._id,
        target: { type: 'company', id: String(client._id), label: client.name },
        details: {
          method: req.method,
          path: `${req.baseUrl || ''}${req.path || ''}`,
          agency: agency.name,
          agencyId: String(agency._id)
        }
      });
    }

    next();
  } catch (error) {
    res.status(401).json({ error: 'Token is not valid' });
  }
};

/**
 * Whether a company is switched on, cached briefly.
 *
 * For callers that hold a token's company id but not a populated user - the
 * socket handshake above all, which runs for every reconnect of every open
 * dashboard. Thirty seconds is how long a deactivated company's sockets could
 * reconnect after it is switched off; the HTTP routes check on every request.
 */
const COMPANY_STATUS_TTL_MS = 30 * 1000;
const companyStatusCache = new Map();

async function companyActive(companyId) {
  if (!companyId) {
    return true;
  }

  const key = String(companyId);
  const hit = companyStatusCache.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.active;
  }

  try {
    const company = await Company.findById(key).select('isActive').lean();
    // A company that no longer exists is not one anybody should be working in.
    const active = Boolean(company) && company.isActive !== false;
    companyStatusCache.set(key, { active, expires: Date.now() + COMPANY_STATUS_TTL_MS });
    return active;
  } catch {
    // Fail open on a database blip, as the rest of the auth path does by
    // answering 401 only for what it has actually seen.
    return true;
  }
}

/** Forget a company's cached status, after it is switched on or off. */
function forgetCompanyStatus(companyId) {
  if (companyId) {
    companyStatusCache.delete(String(companyId));
  } else {
    companyStatusCache.clear();
  }
}

/**
 * Refuse while working as a client. Billing is between the client and
 * whoever pays for it, and an agency visiting to set up a bot is not that
 * person - however convenient the button would be.
 */
const notWhileActing = (req, res, next) => {
  if (req.user && req.user.actingAs) {
    return res.status(403).json({
      error: 'This cannot be done while you are working in a client\'s account.',
      code: 'ACTING_AS'
    });
  }
  next();
};

// Middleware to check if user is superadmin
const superadmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Access denied: Superadmin privileges required' });
  }

  next();
};

// Middleware to check if user is company admin
const companyAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'company_admin') {
    return res.status(403).json({ error: 'Access denied: Company admin privileges required' });
  }

  next();
};

// Middleware to check if user is admin (superadmin or company_admin)
const admin = (req, res, next) => {
  if (!req.user || (req.user.role !== 'superadmin' && req.user.role !== 'company_admin')) {
    return res.status(403).json({ error: 'Access denied: Admin privileges required' });
  }

  next();
};

// Middleware to check if user is operator or admin
const operator = (req, res, next) => {
  if (!req.user || (req.user.role !== 'operator' && req.user.role !== 'company_admin' && req.user.role !== 'superadmin')) {
    return res.status(403).json({ error: 'Access denied: Operator privileges required' });
  }

  next();
};

// Middleware to check if user belongs to the same company as the resource
const sameCompany = (req, res, next) => {
  // Superadmin can access all companies
  if (req.user && req.user.role === 'superadmin') {
    return next();
  }

  // Get company ID from request parameters or query
  const companyId = req.params.companyId || req.query.companyId || (req.body && req.body.companyId);

  // If no company ID is provided, continue (other middleware will handle access control)
  if (!companyId) {
    return next();
  }

  // Check if user belongs to the specified company
  if (!req.user || !req.user.company || req.user.company.id.toString() !== companyId.toString()) {
    return res.status(403).json({ error: 'Access denied: You can only access resources from your own company' });
  }

  next();
};

/**
 * Refuse to add the websites a widget runs on until the address is confirmed.
 *
 * Only for companies that signed themselves up: anybody can type any company
 * name and website into the sign-up form, and an unverified account claiming
 * somebody else's domain is the first thing an abuser would try. A company a
 * superadmin created was vouched for by a person.
 *
 * Passes untouched when the request does not change `allowedDomains`, so the
 * rest of the widget settings stay editable while the email is unconfirmed.
 */
async function domainsNeedVerifiedEmail(req, res, next) {
  try {
    const wanted = req.body && req.body.allowedDomains;
    if (!Array.isArray(wanted) || !req.user || req.user.role === 'superadmin' || !req.user.company) {
      return next();
    }

    const [company, user] = await Promise.all([
      Company.findById(req.user.company.id).select('createdVia allowedDomains').lean(),
      User.findById(req.user.id).select('emailVerifiedAt').lean()
    ]);

    if (!company || company.createdVia !== 'signup' || (user && user.emailVerifiedAt)) {
      return next();
    }

    // Removing a domain is always allowed; only adding one needs the proof.
    const current = new Set((company.allowedDomains || []).map(domain => String(domain).toLowerCase()));
    const adding = wanted
      .map(domain => String(domain || '').trim().toLowerCase().replace(/\/+$/, ''))
      .filter(domain => domain && !current.has(domain));

    if (adding.length === 0) {
      return next();
    }

    return res.status(403).json({
      error: 'Confirm your email address before adding a website. Check your inbox, or resend the link from the banner at the top of the dashboard.',
      code: 'EMAIL_NOT_VERIFIED'
    });
  } catch {
    next();
  }
}

/**
 * The value when it is a string, otherwise null.
 *
 * Mongoose casts most things, but a query value of `{ "$gt": "" }` is not
 * cast - it is an operator, and `User.findOne({ username: { $gt: '' } })`
 * matches the first account in the collection. Every place a request field
 * becomes a query value goes through this, and answers 400 on null.
 */
function requireString(value) {
  return typeof value === 'string' ? value : null;
}

module.exports = {
  auth,
  superadmin,
  companyAdmin,
  admin,
  operator,
  sameCompany,
  requireString,
  companyActive,
  forgetCompanyStatus,
  companyInactive,
  domainsNeedVerifiedEmail,
  isRevoked,
  actingScope,
  actingSocketScope,
  notWhileActing,
  REASONS,
  COMPANY_INACTIVE_MESSAGE
};
