const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User = require('../models/user');
const Company = require('../models/company');
const Subscription = require('../models/subscription');
const RevokedToken = require('../models/revoked-token');
const {
  auth, admin, requireString, companyInactive, COMPANY_INACTIVE_MESSAGE
} = require('../middleware/auth');
const { enforceLimit } = require('../middleware/quota');
const { addressKey } = require('../middleware/rateLimiter');
const MongoRateLimitStore = require('../services/rate-limit-store');
const audit = require('../services/audit');
const AlertService = require('../services/alerting');
const accountEmail = require('../services/account-email');
const team = require('../services/team');
const welcomeCrawl = require('../services/welcome-crawl');
const { logger } = require('../services/logging');

const router = express.Router();

const JWT_SECRET = () => process.env.JWT_SECRET || 'chatbot-jwt-secret';

// Eight characters is the floor for an account somebody else created and will
// change; the one account that can reach every tenant gets a higher one.
const MIN_PASSWORD_LENGTH = 8;
const MIN_SUPERADMIN_PASSWORD_LENGTH = 12;

// The old bootstrap script's default. It is in this repository's history, so
// it is in every password list that matters.
const FORBIDDEN_PASSWORDS = ['admin123!'];

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const TOKEN_LIFETIME = '8h';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function envInt(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Self-serve sign-up is on unless a deployment turns it off. */
function signupEnabled() {
  return String(process.env.SIGNUP_ENABLED || 'true').toLowerCase() !== 'false';
}

/** Google sign-in for existing accounts, when its OAuth client is configured. */
function googleSignInConfigured() {
  return Boolean(process.env.GOOGLE_SIGNIN_CLIENT_ID && process.env.GOOGLE_SIGNIN_CLIENT_SECRET);
}

/**
 * New accounts, per address.
 *
 * Every request counts, not only failures: a successful sign-up is exactly
 * what somebody scripting fake tenants produces, so `skipSuccessfulRequests`
 * would never stop them.
 */
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: envInt('RATE_LIMIT_SIGNUP_MAX', 5),
  store: new MongoRateLimitStore({ prefix: 'signup', windowMs: 60 * 60 * 1000 }),
  keyGenerator: req => `ip:${addressKey(req)}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-ups from this address. Please try again later.' }
});

/**
 * Links that arrive by email - an invitation, a reset - looked up or redeemed.
 * The tokens are 256 bits, so this is not about guessing; it keeps a script
 * from using these routes as a cheap way to load the database.
 */
const accountLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: envInt('RATE_LIMIT_ACCOUNT_LINK_MAX', 30),
  store: new MongoRateLimitStore({ prefix: 'acct-link', windowMs: 60 * 60 * 1000 }),
  keyGenerator: req => `ip:${addressKey(req)}`,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please try again later.' }
});

/** Resending a confirmation email, per signed-in person. */
const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: envInt('RATE_LIMIT_VERIFY_RESEND_MAX', 5),
  store: new MongoRateLimitStore({ prefix: 'verify-resend', windowMs: 60 * 60 * 1000 }),
  keyGenerator: req => `u:${req.user ? req.user.id : addressKey(req)}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'That link has been sent several times already. Check your spam folder, or try again in an hour.' }
});

/**
 * Sign a session token for a user.
 *
 * `tv` is the user's tokenVersion at issue time; middleware/auth.js refuses
 * the token once the two differ, which is how a password change or "sign out
 * everywhere" ends every session. `jti` names this one token, so signing out
 * of one browser can end just that session.
 */
function issueToken(user) {
  return jwt.sign(
    {
      id: user._id,
      username: user.username,
      role: user.role,
      company: user.company ? (user.company._id || user.company) : null,
      tv: user.tokenVersion || 0,
      jti: crypto.randomUUID()
    },
    JWT_SECRET(),
    { expiresIn: TOKEN_LIFETIME }
  );
}

/**
 * How long an agency may work in a client's dashboard on one token. Short on
 * purpose: it is a visit, and the banner says when it ends.
 */
const ACTING_TOKEN_LIFETIME = '1h';

/**
 * A token for an agency admin to work in one client's dashboard.
 *
 * The person stays who they are (`id`, `tv`), so signing them out everywhere
 * or changing their password ends this too; `actingAs` names the client, and
 * middleware/auth.js honours it only while the client is still theirs.
 */
function issueActingToken(user, client) {
  return jwt.sign(
    {
      id: user._id || user.id,
      username: user.username,
      role: 'company_admin',
      company: client._id,
      tv: user.tokenVersion || 0,
      jti: crypto.randomUUID(),
      actingAs: { companyId: String(client._id), by: String(user._id || user.id) }
    },
    JWT_SECRET(),
    { expiresIn: ACTING_TOKEN_LIFETIME }
  );
}

function publicUser(user) {
  const company = user.company && user.company._id ? user.company : null;
  return {
    id: user._id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    timezone: user.timezone || null,
    emailVerified: Boolean(user.emailVerifiedAt),
    // Only a company that signed itself up has to prove the address before
    // it may add websites; one a superadmin created was vouched for.
    verificationRequired: !user.emailVerifiedAt && Boolean(company && company.createdVia === 'signup'),
    company: company ? {
      id: company._id,
      name: company.name,
      createdVia: company.createdVia || 'superadmin',
      // Agency admins get the Clients screen.
      isAgency: Boolean(company.agency && company.agency.isAgency)
    } : null
  };
}

/**
 * The reason a password is unacceptable, or null.
 */
function passwordProblem(password, minLength = MIN_PASSWORD_LENGTH) {
  if (typeof password !== 'string' || password.length < minLength) {
    return `Password must be at least ${minLength} characters long`;
  }
  if (FORBIDDEN_PASSWORDS.includes(password.toLowerCase())) {
    return 'That password is too well known to use';
  }
  return null;
}

function minimumFor(role) {
  return role === 'superadmin' ? MIN_SUPERADMIN_PASSWORD_LENGTH : MIN_PASSWORD_LENGTH;
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Where the reset link points. PUBLIC_URL is the address customers reach the
 * dashboard on; without it the best guess is this process's own port.
 */
function resetLink(token) {
  return `${accountEmail.publicBase()}/admin/login.html?reset=${token}`;
}

/**
 * Email a reset link, or explain in the log why it could not be sent.
 *
 * Never throws: the caller has already promised the client a 200, and the
 * reason mail failed is for the operator, not for whoever typed the address.
 */
async function sendResetEmail(user, token) {
  const link = resetLink(token);
  const transport = AlertService.createSmtpTransport();

  if (!transport) {
    logger.warn(
      'Password reset requested but SMTP is not configured; set SMTP_HOST (and SMTP_USER/SMTP_PASSWORD) to send reset emails',
      { userId: String(user._id) }
    );
    return false;
  }

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.ALERT_FROM_EMAIL || 'no-reply@chatbot-application.com',
      to: user.email,
      subject: `Reset your ${accountEmail.productName()} password`,
      text: `Somebody asked to reset the password for ${user.username}.\n\n` +
        `If that was you, open this link within the next hour:\n${link}\n\n` +
        'If it was not, you can ignore this email; your password has not changed.'
    });
    logger.info('Password reset email sent', { userId: String(user._id) });
    return true;
  } catch (error) {
    logger.error('Failed to send password reset email', { userId: String(user._id), error: error.message });
    return false;
  }
}

function actorOf(user) {
  return { id: user._id, username: user.username, displayName: user.displayName, role: user.role };
}

/**
 * A `next` the login page may send someone to after signing in: a path on
 * this dashboard and nothing else, so the parameter cannot become an open
 * redirect to somebody else's site.
 */
function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/admin/') || value.startsWith('//') || value.includes('\\')) {
    return null;
  }
  return value.slice(0, 500);
}

/**
 * What the sign-in pages need before anybody has signed in: the product's
 * name, and which ways in are switched on.
 *
 * `?company=<id>` or `?invite=<token>` asks for the brand that company's
 * people see - an agency's, for its clients - so the invitation page and the
 * sign-in page after it look like the business that sent the invitation.
 * A brand is public by nature (it is printed on those pages), so naming a
 * company here reveals nothing an invitation would not.
 */
router.get('/config', async (req, res) => {
  const agency = require('../services/agency');
  let brand = agency.platformBrand();

  try {
    if (typeof req.query.invite === 'string' && req.query.invite) {
      brand = await agency.brandingForInvite(req.query.invite);
    } else if (typeof req.query.company === 'string' && req.query.company) {
      brand = await agency.effectiveBranding(req.query.company);
    }
  } catch (error) {
    logger.warn('Could not resolve the sign-in brand', { error: error.message });
  }

  res.json({
    productName: brand.productName,
    branding: brand.custom ? {
      productName: brand.productName,
      logoUrl: brand.logoUrl,
      primaryColor: brand.primaryColor,
      supportEmail: brand.supportEmail
    } : null,
    // A trial started from an agency's page would be a trial of ours under
    // their name, so a branded page does not offer one.
    signupEnabled: brand.custom ? false : signupEnabled(),
    googleSignIn: googleSignInConfigured(),
    publicUrl: (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')
  });
});

// Login route
router.post('/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    // The field is still called `username` - the rate limiter keys on it -
    // but it takes an email address as well, which is what people remember.
    const login = req.body && req.body.username !== undefined ? req.body.username : (req.body || {}).email;

    // A username of `{ "$gt": "" }` is a query operator, not a name, and would
    // match the first account in the collection.
    if (typeof login !== 'string' || !login.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }

    // bcrypt throws on anything but a string, which surfaced as a 500 and told
    // the caller that the account exists.
    if (typeof password !== 'string') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const identifier = login.trim();
    const query = identifier.includes('@')
      ? { $or: [{ email: identifier.toLowerCase() }, { username: identifier }] }
      : { username: identifier };

    // The four sign-in audit writes below are awaited rather than left to
    // finish on their own. An entry that may or may not have landed by the time
    // the answer goes out is not evidence: under load, or if the process is
    // restarted in that window, the record of who signed in - or of a run of
    // failures against a real account - is simply lost.
    //
    // Check if user exists
    const user = await User.findOne(query).populate('company');
    if (!user) {
      // Recorded without a company, because there is no account to attribute
      // it to. Only a superadmin sees these, which is right: a run of attempts
      // against usernames that do not exist is the platform's problem.
      await audit.record({
        req,
        action: 'auth.login',
        outcome: 'failure',
        company: null,
        details: { username: identifier.slice(0, 100), reason: 'no such account' }
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // An invited account has a random password nobody knows, so the password
    // check below would only ever say "wrong password" - which sends the person
    // to reset a password they never had. Say what is actually going on.
    if (user.invitePending && user.isActive) {
      await audit.record({
        req,
        action: 'auth.login',
        outcome: 'denied',
        company: user.company ? user.company._id : null,
        actor: actorOf(user),
        details: { reason: 'invitation not accepted' }
      });
      return res.status(403).json({
        error: 'This account has not been set up yet. Open the invitation email and choose a password to sign in.',
        code: 'INVITE_PENDING'
      });
    }

    // Check if password is correct
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      // The single most useful entry in an audit log: repeated failures
      // against a real account, from an address that is not theirs.
      await audit.record({
        req,
        action: 'auth.login',
        outcome: 'failure',
        company: user.company ? user.company._id : null,
        actor: actorOf(user),
        details: { reason: 'wrong password' }
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if user is active
    if (!user.isActive) {
      await audit.record({
        req,
        action: 'auth.login',
        outcome: 'denied',
        company: user.company ? user.company._id : null,
        actor: actorOf(user),
        details: { reason: 'account disabled' }
      });
      return res.status(403).json({ error: 'Account is disabled', code: 'ACCOUNT_DISABLED' });
    }

    // A switched-off company switches off everyone in it.
    if (user.role !== 'superadmin' && companyInactive(user.company)) {
      await audit.record({
        req,
        action: 'auth.login',
        outcome: 'denied',
        company: user.company._id,
        actor: actorOf(user),
        details: { reason: 'company deactivated' }
      });
      return res.status(403).json({ error: COMPANY_INACTIVE_MESSAGE, code: 'COMPANY_DEACTIVATED' });
    }

    const token = issueToken(user);

    // Update last login
    user.lastLogin = Date.now();
    await user.save();

    await audit.record({
      req,
      action: 'auth.login',
      company: user.company ? user.company._id : null,
      actor: actorOf(user)
    });

    res.json({ token, user: publicUser(user) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

/**
 * Sign out.
 *
 * Of this browser only, by default: the token's id is recorded as revoked
 * until it would have expired anyway, and every other device carries on.
 * `{ everywhere: true }` (or `/logout-everywhere`) bumps the version every
 * token of this user was issued under, so all of them die at once - the
 * button for "I left myself signed in on a shared computer".
 *
 * A token issued before tokens had ids cannot be named on its own, so signing
 * it out ends every session, as signing out always used to.
 */
async function signOut(req, res, everywhere) {
  try {
    const jti = req.token && req.token.jti;
    const allOfThem = everywhere || !jti;

    if (allOfThem) {
      await User.updateOne({ _id: req.user.id }, { $inc: { tokenVersion: 1 } });
    } else {
      const expiresAt = req.token.exp
        ? new Date(req.token.exp * 1000)
        : new Date(Date.now() + 8 * 60 * 60 * 1000);
      await RevokedToken.updateOne(
        { _id: String(jti) },
        { $setOnInsert: { user: req.user.id, expiresAt } },
        { upsert: true }
      );
    }

    if (allOfThem) {
      // Sockets in other tabs and on other devices too.
      team.disconnect(req.user.id, 'signed_out');
    }

    audit.record({
      req,
      action: allOfThem ? 'auth.logout_everywhere' : 'auth.logout',
      company: req.user.company ? req.user.company.id : null
    });

    res.json({ success: true, everywhere: allOfThem });
  } catch (error) {
    logger.error('Logout failed', { error: error.message });
    res.status(500).json({ error: 'Logout failed' });
  }
}

router.post('/logout', auth, (req, res) => signOut(req, res, Boolean(req.body && req.body.everywhere === true)));

router.post('/logout-everywhere', auth, (req, res) => signOut(req, res, true));

/**
 * Change one's own password.
 *
 * The current password is required even though the caller holds a valid
 * token: a token left in a browser on a shared machine must not be enough to
 * lock the owner out of their own account.
 */
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ error: 'Current password is required' });
    }

    const problem = passwordProblem(newPassword, minimumFor(req.user.role));
    if (problem) {
      return res.status(400).json({ error: problem });
    }

    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'The new password must differ from the current one' });
    }

    const user = await User.findById(req.user.id).populate('company');
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Token is not valid' });
    }

    if (!(await user.comparePassword(currentPassword))) {
      await audit.record({
        req,
        action: 'auth.password_change',
        outcome: 'failure',
        company: user.company ? user.company._id : null,
        details: { reason: 'wrong current password' }
      });
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    user.password = newPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    await audit.record({
      req,
      action: 'auth.password_change',
      company: user.company ? user.company._id : null
    });

    // Every other session is now signed out; this one continues on a token
    // issued under the new version.
    res.json({ token: issueToken(user) });
  } catch (error) {
    logger.error('Password change failed', { error: error.message });
    res.status(500).json({ error: 'Failed to change password' });
  }
});

/**
 * Change what one is called, and the timezone times are shown in.
 *
 * Only these two: the address and the username are how other people find an
 * account, and the role is not the person's own to change.
 */
router.put('/me', auth, async (req, res) => {
  try {
    const { displayName, timezone } = req.body || {};
    const user = await User.findById(req.user.id).populate('company');

    if (!user) {
      return res.status(401).json({ error: 'Token is not valid' });
    }

    if (displayName !== undefined) {
      const name = typeof displayName === 'string' ? displayName.trim() : '';
      if (!name || name.length > 100) {
        return res.status(400).json({ error: 'Your name must be between 1 and 100 characters' });
      }
      user.displayName = name;
    }

    if (timezone !== undefined) {
      if (timezone === null || timezone === '') {
        user.timezone = undefined;
      } else {
        try {
          new Intl.DateTimeFormat('en-GB', { timeZone: String(timezone) }).format(new Date());
        } catch {
          return res.status(400).json({ error: `"${timezone}" is not a recognised timezone` });
        }
        user.timezone = String(timezone);
      }
    }

    await user.save();
    res.json({ user: publicUser(user) });
  } catch (error) {
    logger.error('Profile update failed', { error: error.message });
    res.status(500).json({ error: 'Failed to save your details' });
  }
});

/**
 * Ask for a reset link.
 *
 * Always 200, and always the same 200: the response must not say whether an
 * address is on file, or the form becomes a way to list customers' staff.
 */
router.post('/forgot-password', async (req, res) => {
  const reply = () => res.json({
    message: 'If an account exists for that address, a reset link has been sent.'
  });

  try {
    const email = requireString((req.body || {}).email);
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase(), isActive: true });
    if (!user) {
      return reply();
    }

    const token = crypto.randomBytes(32).toString('hex');
    await User.updateOne({ _id: user._id }, {
      $set: {
        passwordResetTokenHash: hashResetToken(token),
        passwordResetExpires: new Date(Date.now() + RESET_TOKEN_TTL_MS)
      }
    });

    audit.record({
      req,
      action: 'auth.password_reset_requested',
      company: user.company || null,
      target: { type: 'user', id: String(user._id), label: user.displayName || user.username }
    });

    // Not awaited: the time an SMTP round trip takes is measurable from
    // outside, and would say which addresses exist.
    sendResetEmail(user, token);

    reply();
  } catch (error) {
    logger.error('Password reset request failed', { error: error.message });
    res.status(500).json({ error: 'Failed to process the request' });
  }
});

/**
 * What the reset form needs to know before asking for a password: whether
 * the link still works, and how long the password has to be. A superadmin's
 * is longer, and the form used to say eight to everybody.
 */
router.get('/reset-info', accountLinkLimiter, async (req, res) => {
  try {
    const token = requireString(req.query.token);
    const user = token
      ? await User.findOne({
        passwordResetTokenHash: hashResetToken(token),
        passwordResetExpires: { $gt: new Date() },
        isActive: true
      }).select('role')
      : null;

    if (!user) {
      return res.status(400).json({ valid: false, error: 'This reset link is invalid or has expired' });
    }

    res.json({ valid: true, minLength: minimumFor(user.role) });
  } catch (error) {
    logger.error('Could not check a reset link', { error: error.message });
    res.status(500).json({ error: 'Failed to check the link' });
  }
});

/**
 * Finish a reset with the emailed token.
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};

    if (typeof token !== 'string' || !token) {
      return res.status(400).json({ error: 'Reset token is required' });
    }

    // The token's own fields are not selected by default, and the user's role
    // is needed to pick the right minimum length.
    const user = await User.findOne({
      passwordResetTokenHash: hashResetToken(token),
      passwordResetExpires: { $gt: new Date() },
      isActive: true
    }).select('+passwordResetTokenHash +passwordResetExpires');

    if (!user) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired' });
    }

    const problem = passwordProblem(newPassword, minimumFor(user.role));
    if (problem) {
      return res.status(400).json({ error: problem });
    }

    user.password = newPassword;
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpires = undefined;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    await audit.record({
      req,
      action: 'auth.password_reset',
      company: user.company || null,
      actor: actorOf(user),
      target: { type: 'user', id: String(user._id), label: user.displayName || user.username }
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Password reset failed', { error: error.message });
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// --------------------------------------------------------------- sign-up

/**
 * The address as given, made into a URL the crawler can fetch: people type
 * "bloomdental.com", not "https://bloomdental.com/".
 */
function normaliseWebsite(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const raw = value.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * A company name nobody has.
 *
 * Names are unique, but two unrelated businesses called "Bloom Dental" both
 * signing up is ordinary. Refusing the second would also tell them the first
 * exists, so the second quietly becomes "Bloom Dental 2", which they can
 * rename.
 */
async function availableCompanyName(name) {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name} ${attempt}`;
    if (!(await Company.exists({ name: candidate }))) {
      return candidate;
    }
  }
  return `${name} ${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Start a free trial: a company, its first admin, and a signed-in session.
 *
 * The trial starts now, the same subscription a superadmin-created company
 * gets, and the website (if given) is read into the knowledge base in the
 * background so the bot knows something by the time they reach Home. The
 * address is confirmed by email; until then everything works except adding
 * the websites the widget may run on.
 */
router.post('/signup', signupLimiter, async (req, res) => {
  if (!signupEnabled()) {
    return res.status(404).json({ error: 'Sign-up is not open on this service. Ask whoever runs it for an invitation.' });
  }

  let company = null;

  try {
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const companyName = typeof body.companyName === 'string' ? body.companyName.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
    const website = normaliseWebsite(body.website);

    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (companyName.length < 2 || companyName.length > 100) {
      return res.status(400).json({ error: 'Enter your company\'s name' });
    }
    if (website === undefined) {
      return res.status(400).json({ error: 'That website address does not look right. Try something like bloomdental.com' });
    }

    const problem = passwordProblem(body.password);
    if (problem) {
      return res.status(400).json({ error: problem });
    }

    if (await User.exists({ email })) {
      return res.status(409).json({
        error: 'An account with that address already exists. Sign in instead, or reset the password.',
        code: 'EMAIL_TAKEN'
      });
    }

    company = await Company.create({
      name: await availableCompanyName(companyName),
      website: website || undefined,
      createdVia: 'signup'
    });

    // The trial clock starts at sign-up rather than whenever something first
    // reads the plan.
    await Subscription.forCompany(company._id);

    const verifyToken = team.newToken();
    const user = new User({
      username: await team.usernameFromEmail(email),
      email,
      displayName: name || undefined,
      password: body.password,
      role: 'company_admin',
      company: company._id,
      emailVerifyTokenHash: team.hashToken(verifyToken),
      lastLogin: new Date()
    });

    try {
      await user.save();
    } catch (error) {
      // Somebody else took the address between the check and the save. The
      // company made for this attempt belongs to nobody, so it goes.
      await Subscription.deleteOne({ company: company._id }).catch(() => {});
      await Company.deleteOne({ _id: company._id }).catch(() => {});
      if (error && error.code === 11000) {
        return res.status(409).json({
          error: 'An account with that address already exists. Sign in instead, or reset the password.',
          code: 'EMAIL_TAKEN'
        });
      }
      throw error;
    }

    company.createdBy = user._id;
    await company.save();

    const delivery = await accountEmail.sendVerification(user, verifyToken);

    if (website) {
      welcomeCrawl.start(company._id, website);
    }

    await audit.record({
      req,
      action: 'company.signed_up',
      company: company._id,
      actor: actorOf(user),
      target: { type: 'company', id: String(company._id), label: company.name },
      details: { website: website || undefined, email }
    });

    user.company = company;
    res.status(201).json({
      token: issueToken(user),
      user: publicUser(user),
      verificationEmailSent: delivery.sent,
      crawling: Boolean(website)
    });
  } catch (error) {
    logger.error('Sign-up failed', { error: error.message });
    res.status(500).json({ error: 'Could not create your account. Please try again.' });
  }
});

/**
 * The link in the confirmation email.
 *
 * A GET because it is opened from a mail client; it does the one thing and
 * sends the person on to the dashboard, which says whether it worked.
 * `?format=json` answers in JSON instead, for anything that is not a browser.
 */
router.get('/verify-email', accountLinkLimiter, async (req, res) => {
  const json = req.query.format === 'json';
  const done = (status, outcome) => (json
    ? res.status(status).json(outcome === 'ok'
      ? { verified: true }
      : { verified: false, error: 'This confirmation link is invalid or has already been used' })
    : res.redirect(`/admin/?verified=${outcome}`));

  try {
    const token = requireString(req.query.token);
    if (!token) {
      return done(400, 'invalid');
    }

    const user = await User.findOne({ emailVerifyTokenHash: team.hashToken(token) })
      .select('+emailVerifyTokenHash');

    if (!user) {
      return done(400, 'invalid');
    }

    user.emailVerifiedAt = new Date();
    user.emailVerifyTokenHash = undefined;
    await user.save();

    await audit.record({
      req,
      action: 'user.email_verified',
      company: user.company || null,
      actor: actorOf(user),
      target: { type: 'user', id: String(user._id), label: user.email }
    });

    done(200, 'ok');
  } catch (error) {
    logger.error('Email verification failed', { error: error.message });
    json ? res.status(500).json({ error: 'Failed to confirm the address' }) : res.redirect('/admin/?verified=error');
  }
});

/** Send the confirmation email again, with a new link. */
router.post('/resend-verification', auth, resendLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(401).json({ error: 'Token is not valid' });
    }
    if (user.emailVerifiedAt) {
      return res.status(409).json({ error: 'Your address is already confirmed' });
    }

    const token = team.newToken();
    user.emailVerifyTokenHash = team.hashToken(token);
    await user.save();

    const delivery = await accountEmail.sendVerification(user, token);
    res.json({ sent: delivery.sent, email: user.email });
  } catch (error) {
    logger.error('Could not resend the confirmation email', { error: error.message });
    res.status(500).json({ error: 'Could not send the email' });
  }
});

// ------------------------------------------------------------ invitations

/**
 * Who an invitation is for, so the page can greet them before they choose a
 * password. Answers only for a live link.
 */
router.get('/invite/:token', accountLinkLimiter, async (req, res) => {
  try {
    const user = await team.findInvite(req.params.token);

    if (!user || !user.company || user.company.isActive === false) {
      return res.status(404).json({ error: 'This invitation is invalid, has expired, or has already been used. Ask for a new one.' });
    }

    const inviter = user.invitedBy
      ? await User.findById(user.invitedBy).select('displayName username').lean()
      : null;

    res.json({
      email: user.email,
      displayName: user.displayName || '',
      role: user.role,
      companyName: user.company.name,
      invitedBy: inviter ? (inviter.displayName || inviter.username) : null,
      minLength: MIN_PASSWORD_LENGTH
    });
  } catch (error) {
    logger.error('Could not read an invitation', { error: error.message });
    res.status(500).json({ error: 'Could not read the invitation' });
  }
});

/**
 * Accept an invitation: choose a password and sign in.
 *
 * Opening the emailed link proves the address, so it counts as confirmed.
 */
router.post('/accept-invite', accountLinkLimiter, async (req, res) => {
  try {
    const { token, password, displayName } = req.body || {};
    const user = await team.findInvite(requireString(token));

    if (!user || !user.company || user.company.isActive === false) {
      return res.status(400).json({ error: 'This invitation is invalid, has expired, or has already been used. Ask for a new one.' });
    }

    const problem = passwordProblem(password, minimumFor(user.role));
    if (problem) {
      return res.status(400).json({ error: problem });
    }

    if (typeof displayName === 'string' && displayName.trim()) {
      user.displayName = displayName.trim().slice(0, 100);
    }

    user.password = password;
    user.invitePending = false;
    user.inviteTokenHash = undefined;
    user.inviteExpires = undefined;
    user.emailVerifiedAt = user.emailVerifiedAt || new Date();
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.lastLogin = new Date();
    await user.save();

    await audit.record({
      req,
      action: 'user.invite_accepted',
      company: user.company._id,
      actor: actorOf(user),
      target: { type: 'user', id: String(user._id), label: user.displayName || user.email },
      details: { role: user.role }
    });

    res.json({ token: issueToken(user), user: publicUser(user) });
  } catch (error) {
    logger.error('Could not accept an invitation', { error: error.message });
    res.status(500).json({ error: 'Could not accept the invitation' });
  }
});

// ------------------------------------------------------- Google sign-in

const GOOGLE_STATE_COOKIE = 'g_signin_state';

function googleRedirectUri(req) {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/api/auth/google/callback`;
}

function googleClient(req) {
  // Required here: googleapis is large, and most deployments never sign in
  // through Google.
  const { google } = require('googleapis');
  return new google.auth.OAuth2(
    process.env.GOOGLE_SIGNIN_CLIENT_ID,
    process.env.GOOGLE_SIGNIN_CLIENT_SECRET,
    googleRedirectUri(req)
  );
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/**
 * Send the browser to Google.
 *
 * The state is signed and also bound to this browser by a cookie, so a
 * callback URL somebody else started cannot sign this browser into their
 * account.
 */
router.get('/google/start', (req, res) => {
  if (!googleSignInConfigured()) {
    return res.status(404).json({ error: 'Google sign-in is not set up on this service' });
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const state = jwt.sign(
    { purpose: 'google-signin', nonce, next: safeNext(req.query.next) },
    JWT_SECRET(),
    { expiresIn: '10m' }
  );

  res.cookie(GOOGLE_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 10 * 60 * 1000,
    path: '/api/auth/google'
  });

  res.redirect(googleClient(req).generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account'
  }));
});

/**
 * Back from Google: find the account with that address and sign it in.
 *
 * Only an existing, active account whose address Google has verified. Nobody
 * gets an account by signing in with Google in this version; the session goes
 * back to the login page in the URL fragment, which is never sent to a
 * server.
 */
router.get('/google/callback', async (req, res) => {
  const fail = reason => res.redirect(`/admin/login.html?google=${encodeURIComponent(reason)}`);

  if (!googleSignInConfigured()) {
    return fail('unavailable');
  }

  try {
    let state;
    try {
      state = jwt.verify(String(req.query.state || ''), JWT_SECRET());
    } catch {
      return fail('expired');
    }

    const nonce = readCookie(req, GOOGLE_STATE_COOKIE);
    res.clearCookie(GOOGLE_STATE_COOKIE, { path: '/api/auth/google' });

    if (state.purpose !== 'google-signin' || !nonce || nonce !== state.nonce) {
      return fail('expired');
    }
    if (!req.query.code) {
      return fail('cancelled');
    }

    const client = googleClient(req);
    const { tokens } = await client.getToken(String(req.query.code));
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_SIGNIN_CLIENT_ID
    });
    const payload = ticket.getPayload() || {};

    if (!payload.email || payload.email_verified !== true) {
      return fail('unverified');
    }

    const user = await User.findOne({ email: String(payload.email).toLowerCase() }).populate('company');

    if (!user || !user.isActive || user.invitePending) {
      await audit.record({
        req,
        action: 'auth.login',
        outcome: 'failure',
        company: user && user.company ? user.company._id : null,
        details: { method: 'google', reason: user ? 'account not usable' : 'no such account' }
      });
      return fail('no_account');
    }

    if (user.role !== 'superadmin' && companyInactive(user.company)) {
      return fail('company_inactive');
    }

    user.lastLogin = new Date();
    await user.save();

    await audit.record({
      req,
      action: 'auth.login',
      company: user.company ? user.company._id : null,
      actor: actorOf(user),
      details: { method: 'google' }
    });

    const next = safeNext(state.next);
    res.redirect(`/admin/login.html${next ? `?next=${encodeURIComponent(next)}` : ''}#token=${issueToken(user)}`);
  } catch (error) {
    logger.error('Google sign-in failed', { error: error.message });
    fail('error');
  }
});

// Register route (admin only). A seat is a billable resource, so the plan is
// checked before the account exists rather than after.
router.post('/register', auth, admin, enforceLimit('operators'), async (req, res) => {
  try {
    const { password, role, displayName, companyId } = req.body || {};
    const username = requireString(req.body && req.body.username);
    const email = requireString(req.body && req.body.email);
    const currentUser = req.user;

    if (!username || !email) {
      return res.status(400).json({ error: 'Username and email are required' });
    }

    const problem = passwordProblem(password, minimumFor(role));
    if (problem) {
      return res.status(400).json({ error: problem });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ $or: [{ username }, { email: email.toLowerCase() }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    // Validate role and company
    if (role === 'superadmin' && currentUser.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmins can create other superadmins' });
    }

    // Company admins can only create operators for their own company
    if (currentUser.role === 'company_admin') {
      if (role !== 'operator') {
        return res.status(403).json({ error: 'Company admins can only create operators' });
      }

      if (!currentUser.company || companyId !== currentUser.company.id.toString()) {
        return res.status(403).json({ error: 'Company admins can only create users for their own company' });
      }
    }

    // Validate company exists if companyId is provided
    let company = null;
    if (companyId) {
      if (typeof companyId !== 'string') {
        return res.status(400).json({ error: 'Company not found' });
      }
      company = await Company.findById(companyId);
      if (!company) {
        return res.status(400).json({ error: 'Company not found' });
      }
    }

    // Company is required for company_admin and operator roles
    if ((role === 'company_admin' || role === 'operator') && !companyId) {
      return res.status(400).json({ error: 'Company is required for company admin and operator roles' });
    }

    // Create new user
    const user = new User({
      username,
      email,
      password,
      role: role || 'operator',
      displayName,
      company: companyId,
      createdBy: currentUser.id
    });

    await user.save();

    audit.record({
      req,
      action: 'user.created',
      company: companyId || null,
      target: { type: 'user', id: String(user._id), label: user.displayName || user.username },
      // The role is the part worth being able to look up later.
      details: { role: user.role, email: user.email }
    });

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        company: company ? {
          id: company._id,
          name: company.name
        } : null
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Create first superadmin (only works if no users exist). This is the
// bootstrap: there is no script with a default password any more.
router.post('/create-superadmin', async (req, res) => {
  try {
    const { password, displayName } = req.body || {};
    const username = requireString(req.body && req.body.username);
    const email = requireString(req.body && req.body.email);

    // Input is checked before the "any users yet?" question, so a bad request
    // is a bad request whatever state the database is in.
    if (!username || !email) {
      return res.status(400).json({ error: 'Username and email are required' });
    }

    const problem = passwordProblem(password, MIN_SUPERADMIN_PASSWORD_LENGTH);
    if (problem) {
      return res.status(400).json({ error: problem });
    }

    // Check if any users exist
    const userCount = await User.countDocuments();
    if (userCount > 0) {
      return res.status(403).json({ error: 'Users already exist. Cannot create first superadmin.' });
    }

    // Create superadmin
    const superadmin = new User({
      username,
      email,
      password,
      role: 'superadmin',
      displayName
    });

    await superadmin.save();

    // The one account that can reach every tenant. Its creation is the single
    // most important line this log will ever hold.
    audit.record({
      action: 'superadmin.created',
      company: null,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      actor: { id: superadmin._id, username: superadmin.username, displayName: superadmin.displayName, role: 'superadmin' },
      target: { type: 'user', id: String(superadmin._id), label: superadmin.displayName || superadmin.username }
    });

    res.status(201).json({
      message: 'Superadmin created successfully',
      user: {
        id: superadmin._id,
        username: superadmin.username,
        displayName: superadmin.displayName,
        email: superadmin.email,
        role: superadmin.role
      }
    });
  } catch (error) {
    console.error('Create superadmin error:', error);
    res.status(500).json({ error: 'Failed to create superadmin' });
  }
});

/**
 * Who the token belongs to.
 *
 * Through the same middleware as every other route, so a deactivated account,
 * a switched-off company or a signed-out token is refused here for the same
 * reason - and with the same `X-Auth-Reason` - as anywhere else.
 */
router.get('/verify', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('company');
    if (!user) {
      return res.status(401).json({ error: 'Token is not valid' });
    }

    const shown = publicUser(user);

    // Working in a client's dashboard: the person is the agency's, the
    // company is the client's, and the banner needs both.
    if (req.user.actingAs) {
      shown.role = 'company_admin';
      shown.company = {
        id: req.user.company.id,
        name: req.user.company.name,
        createdVia: 'superadmin',
        isAgency: false
      };
      shown.verificationRequired = false;
      shown.actingAs = req.user.actingAs;
    }

    res.json({
      user: shown,
      // The brand this person's dashboard wears (an agency's, for its clients).
      branding: await accountEmail.brandFor(shown.company ? shown.company.id : null)
    });
  } catch (error) {
    res.status(401).json({ error: 'Token is not valid' });
  }
});

module.exports = router;
module.exports.publicUser = publicUser;
module.exports.issueActingToken = issueActingToken;
module.exports.ACTING_TOKEN_LIFETIME = ACTING_TOKEN_LIFETIME;
module.exports.passwordProblem = passwordProblem;
