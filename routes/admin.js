const express = require('express');
const Conversation = require('../models/conversation');
const User = require('../models/user');
const Company = require('../models/company');
const { auth, operator, superadmin } = require('../middleware/auth');

const router = express.Router();

// Apply auth middleware to all routes
router.use(auth);
router.use(operator);

// Get active conversations
router.get('/active-chats', async (req, res) => {
  try {
    // Build query based on user role
    let query = { status: 'active' };

    // If not superadmin, filter by company
    if (req.user.role !== 'superadmin' && req.user.company) {
      query.company = req.user.company.id;
    }

    const activeChatsSummary = await Conversation.find(
      query,
      {
        sessionId: 1,
        startedAt: 1,
        domain: 1,
        hasOperator: 1,
        operatorName: 1,
        metadata: 1,
        company: 1,
        'messages.length': { $size: '$messages' }
      }
    ).populate('company', 'name').sort({ lastActivity: -1 });

    const chats = activeChatsSummary.map(chat => ({
      sessionId: chat.sessionId,
      startedAt: chat.startedAt,
      domain: chat.domain,
      hasOperator: chat.hasOperator,
      operatorName: chat.operatorName,
      userName:
        chat.metadata &&
        (chat.metadata.name || (chat.metadata.get && chat.metadata.get('name'))),
      company: chat.company ? {
        id: chat.company._id,
        name: chat.company.name
      } : null,
      'messages.length': chat['messages.length']
    }));

    res.json({ chats });
  } catch (error) {
    console.error('Error fetching active chats:', error);
    res.status(500).json({ error: 'Failed to retrieve active chats' });
  }
});

// Get chat history
router.get('/chat-history', async (req, res) => {
  try {
    const { search } = req.query;
    let query = {};

    // If search parameter is provided, create a query to search in relevant fields
    if (search) {
      query = {
        $or: [
          { sessionId: { $regex: search, $options: 'i' } },
          { domain: { $regex: search, $options: 'i' } },
          { operatorName: { $regex: search, $options: 'i' } },
          { 'messages.content': { $regex: search, $options: 'i' } }
        ]
      };
    }

    // If not superadmin, filter by company
    if (req.user.role !== 'superadmin' && req.user.company) {
      // If search query exists, add company filter to it
      if (Object.keys(query).length > 0) {
        query = {
          $and: [
            query,
            { company: req.user.company.id }
          ]
        };
      } else {
        // Otherwise just set the company filter
        query.company = req.user.company.id;
      }
    }

    const chatHistory = await Conversation.find(
      query,
      { 
        sessionId: 1, 
        startedAt: 1, 
        endedAt: 1, 
        status: 1, 
        domain: 1, 
        company: 1,
        'messages.length': { $size: '$messages' } 
      }
    ).populate('company', 'name').sort({ startedAt: -1 }).limit(100);

    // Format the response
    const history = chatHistory.map(chat => ({
      ...chat.toObject(),
      company: chat.company ? {
        id: chat.company._id,
        name: chat.company.name
      } : null
    }));

    res.json({ history });
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ error: 'Failed to retrieve chat history' });
  }
});

// Get specific chat
router.get('/chat/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const conversation = await Conversation.findOne({ sessionId });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const userName =
      conversation.metadata &&
      (conversation.metadata.name ||
        (conversation.metadata.get && conversation.metadata.get('name')));

    // Convert Map fields like `metadata` into plain objects
    const convoObj = conversation.toObject({ flattenMaps: true });
    convoObj.userName = userName;

    res.json(convoObj);
  } catch (error) {
    console.error('Error fetching chat:', error);
    res.status(500).json({ error: 'Failed to retrieve chat' });
  }
});

// Update contact information for a chat
router.post('/chat/:sessionId/contact-info', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { name, email, phone } = req.body;

    // Find the conversation
    const conversation = await Conversation.findOne({ sessionId });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Initialize metadata if it doesn't exist
    if (!conversation.metadata) {
      conversation.metadata = new Map();
    }

    // Update metadata with contact information
    conversation.metadata.set('name', name || '');
    conversation.metadata.set('email', email || '');
    conversation.metadata.set('phone', phone || '');

    // Save the conversation
    await conversation.save();

    res.json({ success: true, message: 'Contact information updated successfully' });
  } catch (error) {
    console.error('Error updating contact information:', error);
    res.status(500).json({ error: 'Failed to update contact information' });
  }
});

// Delete chat
router.delete('/chat/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await Conversation.deleteOne({ sessionId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true, message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat:', error);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

// End chat
router.post('/chat/:sessionId/end', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const conversation = await Conversation.findOne({ sessionId });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    conversation.status = 'ended';
    conversation.endedAt = new Date();
    await conversation.save();

    res.json({ success: true, message: 'Chat ended successfully' });
  } catch (error) {
    console.error('Error ending chat:', error);
    res.status(500).json({ error: 'Failed to end chat' });
  }
});

// Get analytics data
router.get('/analytics', async (req, res) => {
  try {
    // Create base query for company filtering
    let companyFilter = {};
    if (req.user.role !== 'superadmin' && req.user.company) {
      companyFilter = { company: req.user.company.id };
    }

    // Get total chats today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const totalChatsToday = await Conversation.countDocuments({
      startedAt: { $gte: today },
      ...companyFilter
    });

    // Get active chats
    const activeChats = await Conversation.countDocuments({
      status: 'active',
      ...companyFilter
    });

    // Get chat volume per day for the last 7 days
    const last7Days = new Date();
    last7Days.setDate(last7Days.getDate() - 7);

    const chatVolumePerDay = await Conversation.aggregate([
      {
        $match: {
          startedAt: { $gte: last7Days },
          ...(companyFilter.company ? { company: mongoose.Types.ObjectId(companyFilter.company) } : {})
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$startedAt' },
            month: { $month: '$startedAt' },
            day: { $dayOfMonth: '$startedAt' }
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: {
          '_id.year': 1,
          '_id.month': 1,
          '_id.day': 1
        }
      }
    ]);

    // Get chat volume per month for the last 12 months
    const last12Months = new Date();
    last12Months.setMonth(last12Months.getMonth() - 11);

    const chatVolumeOverTime = await Conversation.aggregate([
      {
        $match: {
          startedAt: { $gte: last12Months },
          ...(companyFilter.company ? { company: mongoose.Types.ObjectId(companyFilter.company) } : {})
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$startedAt' },
            month: { $month: '$startedAt' }
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: {
          '_id.year': 1,
          '_id.month': 1
        }
      }
    ]);

    // Calculate average response time for the last 7 days
    const responseSince = new Date();
    responseSince.setDate(responseSince.getDate() - 7);

    const convsForResponse = await Conversation.find(
      { 
        startedAt: { $gte: responseSince },
        ...companyFilter
      },
      { messages: 1, startedAt: 1 }
    ).lean();

    let totalResponseMs = 0;
    let responseCount = 0;
    const monthlyResponseTotals = {};

    convsForResponse.forEach(conv => {
      const msgs = (conv.messages || []).sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );
      let awaiting = null;
      msgs.forEach(msg => {
        const ts = new Date(msg.timestamp);
        if (ts < responseSince) return;
        if (msg.sender === 'user') {
          awaiting = ts;
        } else if ((msg.sender === 'operator' || msg.sender === 'bot') && awaiting) {
          const diff = ts - awaiting;
          totalResponseMs += diff;
          responseCount += 1;

          const y = awaiting.getFullYear();
          const m = awaiting.getMonth() + 1;
          const key = `${y}-${m}`;
          if (!monthlyResponseTotals[key]) {
            monthlyResponseTotals[key] = { year: y, month: m, total: 0, count: 0 };
          }
          monthlyResponseTotals[key].total += diff;
          monthlyResponseTotals[key].count += 1;
          awaiting = null;
        }
      });
    });

    const avgResponseTime = responseCount
      ? Math.round(totalResponseMs / responseCount / 1000)
      : 0;

    const responseTimeOverTime = Object.values(monthlyResponseTotals)
      .sort((a, b) => (a.year === b.year ? a.month - b.month : a.year - b.year))
      .map(r => ({
        _id: { year: r.year, month: r.month },
        avg: Math.round(r.total / r.count / 1000)
      }));

    // Helper to compute conversation metrics for a period
    async function conversationMetricsBetween(start, end) {
      const result = await Conversation.aggregate([
        { 
          $match: { 
            startedAt: { $gte: start, $lt: end },
            ...(companyFilter.company ? { company: mongoose.Types.ObjectId(companyFilter.company) } : {})
          } 
        },
        {
          $project: {
            messagesCount: { $size: '$messages' },
            durationMs: {
              $subtract: [
                { $ifNull: ['$endedAt', '$lastActivity'] },
                '$startedAt'
              ]
            }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            avgDurationMs: { $avg: '$durationMs' },
            avgMessages: { $avg: '$messagesCount' }
          }
        }
      ]);
      return result[0] || { total: 0, avgDurationMs: 0, avgMessages: 0 };
    }

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    const prevMonthStart = new Date(monthStart);
    prevMonthStart.setMonth(prevMonthStart.getMonth() - 1);

    const metricsToday = await conversationMetricsBetween(todayStart, now);
    const metricsWeek = await conversationMetricsBetween(weekStart, now);
    const metricsMonth = await conversationMetricsBetween(monthStart, now);
    const metricsPrevMonth = await conversationMetricsBetween(prevMonthStart, monthStart);

    function pctChange(curr, prev) {
      if (!prev) return 0;
      if (prev === 0) return curr === 0 ? 0 : 100;
      return Math.round(((curr - prev) / prev) * 100);
    }

    const conversationMetrics = {
      totalConversations: {
        today: metricsToday.total,
        thisWeek: metricsWeek.total,
        thisMonth: metricsMonth.total,
        change: pctChange(metricsMonth.total, metricsPrevMonth.total)
      },
      averageDuration: {
        today: Math.round(metricsToday.avgDurationMs / 60000),
        thisWeek: Math.round(metricsWeek.avgDurationMs / 60000),
        thisMonth: Math.round(metricsMonth.avgDurationMs / 60000),
        change: pctChange(metricsMonth.avgDurationMs, metricsPrevMonth.avgDurationMs)
      },
      messagesPerConversation: {
        today: Math.round(metricsToday.avgMessages),
        thisWeek: Math.round(metricsWeek.avgMessages),
        thisMonth: Math.round(metricsMonth.avgMessages),
        change: pctChange(metricsMonth.avgMessages, metricsPrevMonth.avgMessages)
      }
    };

    // Get company information if applicable
    let companyInfo = null;
    if (req.user.company) {
      const company = await Company.findById(req.user.company.id);
      if (company) {
        companyInfo = {
          id: company._id,
          name: company.name
        };
      }
    }

    res.json({
      totalChatsToday,
      activeChats,
      chatVolumePerDay,
      chatVolumeOverTime,
      avgResponseTime,
      responseTimeOverTime,
      conversationMetrics,
      company: companyInfo
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to retrieve analytics data' });
  }
});


// Get operators for task assignment
router.get('/operators', async (req, res) => {
  try {
    // Build query based on user role
    let query = { role: 'operator', isActive: true };

    // If not superadmin, filter by company
    if (req.user.role !== 'superadmin' && req.user.company) {
      query.company = req.user.company.id;
    }

    // Find operators
    const operators = await User.find(
      query,
      { _id: 1, username: 1, displayName: 1, email: 1, company: 1 }
    ).populate('company', 'name');

    res.json({ operators });
  } catch (error) {
    console.error('Error fetching operators:', error);
    res.status(500).json({ error: 'Failed to retrieve operators' });
  }
});

// Get all operators (including inactive)
router.get('/all-operators', async (req, res) => {
  try {
    // Build query based on user role
    let query = { role: 'operator' };

    // If not superadmin, filter by company
    if (req.user.role !== 'superadmin' && req.user.company) {
      query.company = req.user.company.id;
    }

    // Find operators
    const operators = await User.find(
      query,
      { _id: 1, username: 1, displayName: 1, name: 1, email: 1, isActive: 1, createdAt: 1, lastLogin: 1, company: 1 }
    ).populate('company', 'name');

    res.json({ operators });
  } catch (error) {
    console.error('Error fetching operators:', error);
    res.status(500).json({ error: 'Failed to retrieve operators' });
  }
});

// Create a new operator
router.post('/operators', async (req, res) => {
  try {
    const { username, email, password, confirmPassword, name, displayName, companyId } = req.body;
    const currentUser = req.user;

    // Validate input
    if (!username || !email || !password || !confirmPassword) {
      return res.status(400).json({ error: 'Username, email, password, and confirm password are required' });
    }

    // Check if passwords match
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ username }, { email }]
    });

    if (existingUser) {
      return res.status(400).json({
        error: 'User with this username or email already exists'
      });
    }

    // Determine company assignment
    let company = null;

    // If company ID is provided, validate it
    if (companyId) {
      company = await Company.findById(companyId);
      if (!company) {
        return res.status(400).json({ error: 'Company not found' });
      }

      // Company admins can only create operators for their own company
      if (currentUser.role === 'company_admin' && 
          (!currentUser.company || currentUser.company.id.toString() !== companyId)) {
        return res.status(403).json({ error: 'You can only create operators for your own company' });
      }
    } else {
      // If no company ID is provided, use the current user's company (for company admins)
      if (currentUser.role === 'company_admin') {
        if (!currentUser.company) {
          return res.status(400).json({ error: 'Company is required' });
        }
        company = await Company.findById(currentUser.company.id);
      } else if (currentUser.role !== 'superadmin') {
        return res.status(400).json({ error: 'Company is required' });
      }
    }

    // Create new operator
    const operator = new User({
      username,
      name,
      displayName,
      email,
      password,
      role: 'operator',
      company: company ? company._id : null,
      isActive: true,
      createdBy: currentUser.id
    });

    await operator.save();

    res.status(201).json({
      success: true,
      message: 'Operator created successfully',
      operator: {
        _id: operator._id,
        username: operator.username,
        displayName: operator.displayName,
        name: operator.name,
        email: operator.email,
        isActive: operator.isActive,
        company: company ? {
          id: company._id,
          name: company.name
        } : null
      }
    });
  } catch (error) {
    console.error('Error creating operator:', error);
    res.status(500).json({ error: 'Failed to create operator' });
  }
});

// Update operator status (active/inactive)
router.patch('/operators/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    // Validate input
    if (isActive === undefined) {
      return res.status(400).json({ error: 'isActive status is required' });
    }

    // Find and update operator
    const operator = await User.findById(id);

    if (!operator) {
      return res.status(404).json({ error: 'Operator not found' });
    }

    if (operator.role !== 'operator') {
      return res.status(400).json({ error: 'User is not an operator' });
    }

    operator.isActive = isActive;
    await operator.save();

    res.json({
      success: true,
      message: `Operator ${isActive ? 'activated' : 'deactivated'} successfully`,
      operator: {
        _id: operator._id,
        username: operator.username,
        displayName: operator.displayName,
        name: operator.name,
        email: operator.email,
        isActive: operator.isActive
      }
    });
  } catch (error) {
    console.error('Error updating operator status:', error);
    res.status(500).json({ error: 'Failed to update operator status' });
  }
});

// Update operator details
router.put('/operators/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { username, name, displayName, email, role, companyId } = req.body;
    const currentUser = req.user;

    // Validate input
    if (!username || !email) {
      return res.status(400).json({ error: 'Username and email are required' });
    }

    // Find operator
    const operator = await User.findById(id).populate('company');

    if (!operator) {
      return res.status(404).json({ error: 'Operator not found' });
    }

    // Check if user has permission to edit this operator
    if (currentUser.role === 'company_admin') {
      // Company admins can only edit operators from their own company
      if (!operator.company || operator.company._id.toString() !== currentUser.company.id.toString()) {
        return res.status(403).json({ error: 'You can only edit operators from your own company' });
      }

      // Company admins can't change operators to other roles
      if (role && role !== 'operator') {
        return res.status(403).json({ error: 'Company admins can only create operators' });
      }

      // Company admins can't change operators to other companies
      if (companyId && companyId !== currentUser.company.id.toString()) {
        return res.status(403).json({ error: 'Company admins can only assign operators to their own company' });
      }
    }

    // Check if username or email is already taken by another user
    const existingUser = await User.findOne({
      $and: [
        { _id: { $ne: id } },
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

    // Validate role and company
    let company = operator.company;
    const newRole = role || operator.role;

    // Superadmin can only be created by another superadmin
    if (newRole === 'superadmin' && currentUser.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmins can create other superadmins' });
    }

    // Validate company exists if companyId is provided
    if (companyId && (newRole === 'company_admin' || newRole === 'operator')) {
      company = await Company.findById(companyId);
      if (!company) {
        return res.status(400).json({ error: 'Company not found' });
      }
    } else if (!companyId && (newRole === 'company_admin' || newRole === 'operator') && !operator.company) {
      // Company is required for company_admin and operator roles
      return res.status(400).json({ error: 'Company is required for company admin and operator roles' });
    }

    // Update operator details
    operator.username = username;
    operator.name = name;
    operator.displayName = displayName;
    operator.email = email;

    // Only update role and company if provided and user has permission
    if (role && (currentUser.role === 'superadmin' || (currentUser.role === 'company_admin' && role === 'operator'))) {
      operator.role = role;
    }

    if (companyId && (newRole === 'company_admin' || newRole === 'operator')) {
      operator.company = company._id;
    } else if (newRole === 'superadmin') {
      operator.company = null;
    }

    await operator.save();

    res.json({
      success: true,
      message: 'Operator details updated successfully',
      operator: {
        _id: operator._id,
        username: operator.username,
        displayName: operator.displayName,
        name: operator.name,
        email: operator.email,
        role: operator.role,
        company: operator.company ? {
          id: operator.company._id,
          name: company.name
        } : null,
        isActive: operator.isActive
      }
    });
  } catch (error) {
    console.error('Error updating operator details:', error);
    res.status(500).json({ error: 'Failed to update operator details' });
  }
});

// Reset operator password
router.post('/operators/:id/reset-password', async (req, res) => {
  try {
    const { id } = req.params;
    const { password, confirmPassword } = req.body;

    // Validate input
    if (!password || !confirmPassword) {
      return res.status(400).json({ error: 'Password and confirm password are required' });
    }

    // Check if passwords match
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    // Find operator
    const operator = await User.findById(id);

    if (!operator) {
      return res.status(404).json({ error: 'Operator not found' });
    }

    if (operator.role !== 'operator') {
      return res.status(400).json({ error: 'User is not an operator' });
    }

    // Update password
    operator.password = password;

    await operator.save();

    res.json({
      success: true,
      message: 'Operator password reset successfully'
    });
  } catch (error) {
    console.error('Error resetting operator password:', error);
    res.status(500).json({ error: 'Failed to reset operator password' });
  }
});

module.exports = router;
