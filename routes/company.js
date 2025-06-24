const express = require('express');
const Company = require('../models/company');
const User = require('../models/user');
const { auth, superadmin, admin, sameCompany } = require('../middleware/auth');
const crypto = require('crypto');

const router = express.Router();

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
    if (name) company.name = name;
    if (description !== undefined) company.description = description;
    if (website !== undefined) company.website = website;

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
    if (username) admin.username = username;
    if (email) admin.email = email;
    if (displayName) admin.displayName = displayName;
    if (password) admin.password = password;

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
    if (name !== undefined) user.name = name;
    if (displayName !== undefined) user.displayName = displayName;
    user.email = email;
    if (role) user.role = role;
    if (password) user.password = password;

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
