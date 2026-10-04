const jwt = require('jsonwebtoken');
const User = require('../models/user');

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

    // Check if user still exists and is active
    const user = await User.findById(decoded.id)
      .select('username displayName email role company isActive tokenVersion')
      .populate('company');
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Token is not valid' });
    }

    // A token is only as current as the password it was issued under. Every
    // password change, reset and explicit logout bumps `tokenVersion`, so a
    // token minted before that carries a stale `tv` and is refused here - an
    // eight-hour JWT would otherwise outlive the credentials it proved.
    // Tokens issued before this field existed carry no `tv`, which is 0.
    const issuedVersion = Number(decoded.tv) || 0;
    if (issuedVersion !== (user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Token is not valid' });
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

    next();
  } catch (error) {
    res.status(401).json({ error: 'Token is not valid' });
  }
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
  requireString
};
