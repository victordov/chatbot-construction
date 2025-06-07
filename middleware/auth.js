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
    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Token is not valid' });
    }

    // Add user to request
    req.user = {
      id: user._id,
      username: user.username,
      email: user.email,
      role: user.role
    };

    next();
  } catch (error) {
    res.status(401).json({ error: 'Token is not valid' });
  }
};

// Middleware to check if user is admin
const admin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Admin privileges required' });
  }

  next();
};

// Middleware to check if user is operator or admin
const operator = (req, res, next) => {
  if (!req.user || (req.user.role !== 'operator' && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Access denied: Operator privileges required' });
  }

  next();
};

module.exports = {
  auth,
  admin,
  operator
};
