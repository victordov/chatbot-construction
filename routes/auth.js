const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const Company = require('../models/company');
const { auth, admin, requireString } = require('../middleware/auth');
const { enforceLimit } = require('../middleware/quota');
const audit = require('../services/audit');
const AlertService = require('../services/alerting');
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

/**
 * Sign a session token for a user.
 *
 * `tv` is the user's tokenVersion at issue time; middleware/auth.js refuses
 * the token once the two differ, which is how a password change or logout
 * ends every other session.
 */
function issueToken(user) {
  return jwt.sign(
    {
      id: user._id,
      username: user.username,
      role: user.role,
      company: user.company ? (user.company._id || user.company) : null,
      tv: user.tokenVersion || 0
    },
    JWT_SECRET(),
    { expiresIn: '8h' }
  );
}

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    company: user.company && user.company._id ? {
      id: user.company._id,
      name: user.company.name
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

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Where the reset link points. PUBLIC_URL is the address customers reach the
 * dashboard on; without it the best guess is this process's own port.
 */
function resetLink(token) {
  const base = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  return `${base.replace(/\/$/, '')}/admin/login.html?reset=${token}`;
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
      subject: 'Reset your password',
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

// Login route
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    // A username of `{ "$gt": "" }` is a query operator, not a name, and would
    // match the first account in the collection.
    if (typeof username !== 'string') {
      return res.status(400).json({ error: 'Username is required' });
    }

    // bcrypt throws on anything but a string, which surfaced as a 500 and told
    // the caller that the account exists.
    if (typeof password !== 'string') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // The four sign-in audit writes below are awaited rather than left to
    // finish on their own. An entry that may or may not have landed by the time
    // the answer goes out is not evidence: under load, or if the process is
    // restarted in that window, the record of who signed in - or of a run of
    // failures against a real account - is simply lost.
    //
    // Check if user exists
    const user = await User.findOne({ username }).populate('company');
    if (!user) {
      // Recorded without a company, because there is no account to attribute
      // it to. Only a superadmin sees these, which is right: a run of attempts
      // against usernames that do not exist is the platform's problem.
      await audit.record({
        req,
        action: 'auth.login',
        outcome: 'failure',
        company: null,
        details: { username: username.slice(0, 100), reason: 'no such account' }
      });
      return res.status(401).json({ error: 'Invalid credentials' });
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
        actor: { id: user._id, username: user.username, displayName: user.displayName, role: user.role },
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
        actor: { id: user._id, username: user.username, displayName: user.displayName, role: user.role },
        details: { reason: 'account disabled' }
      });
      return res.status(403).json({ error: 'Account is disabled' });
    }

    const token = issueToken(user);

    // Update last login
    user.lastLogin = Date.now();
    await user.save();

    await audit.record({
      req,
      action: 'auth.login',
      company: user.company ? user.company._id : null,
      actor: { id: user._id, username: user.username, displayName: user.displayName, role: user.role }
    });

    res.json({ token, user: publicUser(user) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

/**
 * Sign out everywhere.
 *
 * A JWT cannot be recalled, so this bumps the version every token of this
 * user was issued under. The one in the caller's hand dies with the rest.
 */
router.post('/logout', auth, async (req, res) => {
  try {
    await User.updateOne({ _id: req.user.id }, { $inc: { tokenVersion: 1 } });

    audit.record({
      req,
      action: 'auth.logout',
      company: req.user.company ? req.user.company.id : null
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Logout failed', { error: error.message });
    res.status(500).json({ error: 'Logout failed' });
  }
});

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

    const problem = passwordProblem(newPassword, req.user.role === 'superadmin'
      ? MIN_SUPERADMIN_PASSWORD_LENGTH
      : MIN_PASSWORD_LENGTH);
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

    const problem = passwordProblem(newPassword, user.role === 'superadmin'
      ? MIN_SUPERADMIN_PASSWORD_LENGTH
      : MIN_PASSWORD_LENGTH);
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
      actor: { id: user._id, username: user.username, displayName: user.displayName, role: user.role },
      target: { type: 'user', id: String(user._id), label: user.displayName || user.username }
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Password reset failed', { error: error.message });
    res.status(500).json({ error: 'Failed to reset password' });
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

    const problem = passwordProblem(password, role === 'superadmin'
      ? MIN_SUPERADMIN_PASSWORD_LENGTH
      : MIN_PASSWORD_LENGTH);
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

// Verify token route
router.get('/verify', async (req, res) => {
  try {
    const token = req.header('x-auth-token');

    if (!token) {
      return res.status(401).json({ error: 'No token, authorization denied' });
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET());

    // Check if user still exists, is active, and has not signed out since.
    const user = await User.findById(decoded.id).populate('company');
    if (!user || !user.isActive || (Number(decoded.tv) || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Token is not valid' });
    }

    res.json({ user: publicUser(user) });
  } catch (error) {
    res.status(401).json({ error: 'Token is not valid' });
  }
});

module.exports = router;
