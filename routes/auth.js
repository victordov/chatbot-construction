const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const Company = require('../models/company');
const { auth, superadmin, admin } = require('../middleware/auth');

const router = express.Router();

// Login route
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Check if user exists
    const user = await User.findOne({ username }).populate('company');
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if password is correct
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    // Create JWT token
    const token = jwt.sign(
      {
        id: user._id,
        username: user.username,
        role: user.role,
        company: user.company ? user.company._id : null
      },
      process.env.JWT_SECRET || 'chatbot-jwt-secret',
      { expiresIn: '8h' }
    );

    // Update last login
    user.lastLogin = Date.now();
    await user.save();

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        company: user.company ? {
          id: user.company._id,
          name: user.company.name
        } : null
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Register route (admin only)
router.post('/register', auth, admin, async (req, res) => {
  try {
    const { username, email, password, role, displayName, companyId } = req.body;
    const currentUser = req.user;

    // Check if user already exists
    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
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

// Create first superadmin (only works if no users exist)
router.post('/create-superadmin', async (req, res) => {
  try {
    // Check if any users exist
    const userCount = await User.countDocuments();
    if (userCount > 0) {
      return res.status(403).json({ error: 'Users already exist. Cannot create first superadmin.' });
    }

    const { username, email, password, displayName } = req.body;

    // Create superadmin
    const superadmin = new User({
      username,
      email,
      password,
      role: 'superadmin',
      displayName
    });

    await superadmin.save();

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
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'chatbot-jwt-secret');

    // Check if user still exists and is active
    const user = await User.findById(decoded.id).populate('company');
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Token is not valid' });
    }

    res.json({
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        company: user.company ? {
          id: user.company._id,
          name: user.company.name
        } : null
      }
    });
  } catch (error) {
    res.status(401).json({ error: 'Token is not valid' });
  }
});

module.exports = router;
