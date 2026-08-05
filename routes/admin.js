const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../models/conversation');
const User = require('../models/user');
const Company = require('../models/company');
const { auth, operator, admin } = require('../middleware/auth');
const { logger } = require('../services/logging');
const {
  containsRegex,
  companyFilter,
  companyMatch,
  canAccessCompany,
  parsePagination
} = require('../utils/query');

const router = express.Router();

// Apply auth middleware to all routes
router.use(auth);
router.use(operator);

/**
 * Load a conversation by sessionId, enforcing tenant isolation.
 * Returns null and sends the response when access should be denied, so callers
 * can simply `if (!conversation) return;`.
 */
async function loadScopedConversation(req, res) {
  const conversation = await Conversation.findOne({ sessionId: req.params.sessionId });

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }

  if (!canAccessCompany(req.user, conversation.company)) {
    // Do not disclose that the conversation exists for another tenant.
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }

  return conversation;
}

// Get active conversations
router.get('/active-chats', async (req, res) => {
  try {
    const query = { status: 'active', ...companyFilter(req.user) };

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
        lastActivity: 1,
        'messages.length': { $size: '$messages' }
      }
    ).populate('company', 'name').sort({ lastActivity: -1 }).limit(200);

    const chats = activeChatsSummary.map(chat => ({
      sessionId: chat.sessionId,
      startedAt: chat.startedAt,
      lastActivity: chat.lastActivity,
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
    logger.error('Error fetching active chats', { error });
    res.status(500).json({ error: 'Failed to retrieve active chats' });
  }
});

// Get chat history
router.get('/chat-history', async (req, res) => {
  try {
    const { search } = req.query;
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });

    const conditions = [companyFilter(req.user)];

    if (search) {
      // Escaped so a search term cannot inject regex syntax or trigger ReDoS.
      const term = containsRegex(search);
      conditions.push({
        $or: [
          { sessionId: term },
          { domain: term },
          { operatorName: term },
          { 'messages.content': term }
        ]
      });
    }

    const query = { $and: conditions.filter(c => Object.keys(c).length > 0) };
    const effectiveQuery = query.$and.length > 0 ? query : {};

    const [chatHistory, total] = await Promise.all([
      Conversation.find(
        effectiveQuery,
        {
          sessionId: 1,
          startedAt: 1,
          endedAt: 1,
          status: 1,
          domain: 1,
          company: 1,
          metadata: 1,
          'messages.length': { $size: '$messages' }
        }
      )
        .populate('company', 'name')
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(limit),
      Conversation.countDocuments(effectiveQuery)
    ]);

    const history = chatHistory.map(chat => {
      const obj = chat.toObject({ flattenMaps: true });
      return {
        ...obj,
        userName: obj.metadata && obj.metadata.name,
        company: chat.company ? {
          id: chat.company._id,
          name: chat.company.name
        } : null
      };
    });

    res.json({
      history,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (error) {
    logger.error('Error fetching chat history', { error });
    res.status(500).json({ error: 'Failed to retrieve chat history' });
  }
});

// Get specific chat
router.get('/chat/:sessionId', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
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
    logger.error('Error fetching chat', { error });
    res.status(500).json({ error: 'Failed to retrieve chat' });
  }
});

// Update contact information for a chat
router.post('/chat/:sessionId/contact-info', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    const { name, email, phone } = req.body;

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Initialize metadata if it doesn't exist
    if (!conversation.metadata) {
      conversation.metadata = new Map();
    }

    // Update metadata with contact information
    conversation.metadata.set('name', name || '');
    conversation.metadata.set('email', email || '');
    conversation.metadata.set('phone', phone || '');

    await conversation.save();

    res.json({ success: true, message: 'Contact information updated successfully' });
  } catch (error) {
    logger.error('Error updating contact information', { error });
    res.status(500).json({ error: 'Failed to update contact information' });
  }
});

// Delete chat
router.delete('/chat/:sessionId', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    await Conversation.deleteOne({ _id: conversation._id });

    logger.info('Conversation deleted', {
      sessionId: conversation.sessionId,
      by: req.user.username
    });

    res.json({ success: true, message: 'Chat deleted successfully' });
  } catch (error) {
    logger.error('Error deleting chat', { error });
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

// End chat
router.post('/chat/:sessionId/end', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    conversation.status = 'ended';
    conversation.endedAt = new Date();
    conversation.hasOperator = false;
    conversation.operatorId = null;
    conversation.operatorName = null;
    await conversation.save();

    res.json({ success: true, message: 'Chat ended successfully' });
  } catch (error) {
    logger.error('Error ending chat', { error });
    res.status(500).json({ error: 'Failed to end chat' });
  }
});

// Get analytics data
router.get('/analytics', async (req, res) => {
  try {
    const filter = companyFilter(req.user);
    const matchFilter = companyMatch(req.user);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const last7Days = new Date();
    last7Days.setDate(last7Days.getDate() - 7);

    const last12Months = new Date();
    last12Months.setMonth(last12Months.getMonth() - 11);

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    const prevMonthStart = new Date(monthStart);
    prevMonthStart.setMonth(prevMonthStart.getMonth() - 1);

    // Compute conversation counts/durations/message averages for one window.
    const metricsFacet = (start, end) => {
      return [
        { $match: { startedAt: { $gte: start, $lt: end } } },
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
      ];
    };

    // A single pipeline replaces what used to be nine separate round trips
    // plus a full in-memory scan of every conversation's messages.
    const [facets] = await Conversation.aggregate([
      { $match: matchFilter },
      {
        $facet: {
          totalChatsToday: [
            { $match: { startedAt: { $gte: today } } },
            { $count: 'count' }
          ],
          activeChats: [
            { $match: { status: 'active' } },
            { $count: 'count' }
          ],
          chatVolumePerDay: [
            { $match: { startedAt: { $gte: last7Days } } },
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
            { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
          ],
          chatVolumeOverTime: [
            { $match: { startedAt: { $gte: last12Months } } },
            {
              $group: {
                _id: {
                  year: { $year: '$startedAt' },
                  month: { $month: '$startedAt' }
                },
                count: { $sum: 1 }
              }
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } }
          ],
          today: metricsFacet(todayStart, now),
          week: metricsFacet(weekStart, now),
          month: metricsFacet(monthStart, now),
          prevMonth: metricsFacet(prevMonthStart, monthStart)
        }
      }
    ]);

    const first = (arr, fallback) => (arr && arr[0]) || fallback;
    const count = arr => first(arr, { count: 0 }).count;
    const emptyMetrics = { total: 0, avgDurationMs: 0, avgMessages: 0 };

    const metricsToday = first(facets.today, emptyMetrics);
    const metricsWeek = first(facets.week, emptyMetrics);
    const metricsMonth = first(facets.month, emptyMetrics);
    const metricsPrevMonth = first(facets.prevMonth, emptyMetrics);

    // Response time: only load the message timestamps/senders we actually need
    // rather than every message body of every conversation.
    const responseSince = new Date();
    responseSince.setDate(responseSince.getDate() - 7);

    const convsForResponse = await Conversation.find(
      { startedAt: { $gte: responseSince }, ...filter },
      { 'messages.timestamp': 1, 'messages.sender': 1 }
    ).lean();

    let totalResponseMs = 0;
    let responseCount = 0;
    const monthlyResponseTotals = {};

    convsForResponse.forEach(conv => {
      const msgs = (conv.messages || []).slice().sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );
      let awaiting = null;
      msgs.forEach(msg => {
        const ts = new Date(msg.timestamp);
        if (ts < responseSince) {
          return;
        }
        if (msg.sender === 'user') {
          // Keep the *first* unanswered user message so bursts of consecutive
          // user messages measure time-to-first-reply, not time since the last one.
          if (!awaiting) {
            awaiting = ts;
          }
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

    const pctChange = (curr, prev) => {
      if (!prev) {
        return curr ? 100 : 0;
      }
      return Math.round(((curr - prev) / prev) * 100);
    };

    const conversationMetrics = {
      totalConversations: {
        today: metricsToday.total,
        thisWeek: metricsWeek.total,
        thisMonth: metricsMonth.total,
        change: pctChange(metricsMonth.total, metricsPrevMonth.total)
      },
      averageDuration: {
        today: Math.round((metricsToday.avgDurationMs || 0) / 60000),
        thisWeek: Math.round((metricsWeek.avgDurationMs || 0) / 60000),
        thisMonth: Math.round((metricsMonth.avgDurationMs || 0) / 60000),
        change: pctChange(metricsMonth.avgDurationMs, metricsPrevMonth.avgDurationMs)
      },
      messagesPerConversation: {
        today: Math.round(metricsToday.avgMessages || 0),
        thisWeek: Math.round(metricsWeek.avgMessages || 0),
        thisMonth: Math.round(metricsMonth.avgMessages || 0),
        change: pctChange(metricsMonth.avgMessages, metricsPrevMonth.avgMessages)
      }
    };

    // Get company information if applicable
    let companyInfo = null;
    if (req.user.company) {
      const company = await Company.findById(req.user.company.id).select('name');
      if (company) {
        companyInfo = { id: company._id, name: company.name };
      }
    }

    res.json({
      totalChatsToday: count(facets.totalChatsToday),
      activeChats: count(facets.activeChats),
      chatVolumePerDay: facets.chatVolumePerDay,
      chatVolumeOverTime: facets.chatVolumeOverTime,
      avgResponseTime,
      responseTimeOverTime,
      conversationMetrics,
      company: companyInfo
    });
  } catch (error) {
    logger.error('Error fetching analytics', { error });
    res.status(500).json({ error: 'Failed to retrieve analytics data' });
  }
});

// Export analytics + conversation history as CSV
router.get('/export', async (req, res) => {
  try {
    const { type = 'conversations' } = req.query;

    if (type !== 'conversations') {
      return res.status(400).json({ error: `Unsupported export type: ${type}` });
    }

    const conversations = await Conversation.find(
      companyFilter(req.user),
      {
        sessionId: 1,
        startedAt: 1,
        endedAt: 1,
        status: 1,
        domain: 1,
        operatorName: 1,
        metadata: 1,
        'messages.length': { $size: '$messages' }
      }
    ).sort({ startedAt: -1 }).limit(5000).lean();

    const escapeCsv = value => {
      const str = value === null || value === undefined ? '' : String(value);
      return `"${str.replace(/"/g, '""')}"`;
    };

    const header = [
      'Session ID', 'Started At', 'Ended At', 'Status', 'Domain',
      'Operator', 'User Name', 'User Email', 'User Phone', 'Messages'
    ];

    const rows = conversations.map(c => [
      c.sessionId,
      c.startedAt ? new Date(c.startedAt).toISOString() : '',
      c.endedAt ? new Date(c.endedAt).toISOString() : '',
      c.status,
      c.domain,
      c.operatorName,
      c.metadata && c.metadata.name,
      c.metadata && c.metadata.email,
      c.metadata && c.metadata.phone,
      c.messages ? c.messages.length : 0
    ].map(escapeCsv).join(','));

    const csv = [header.map(escapeCsv).join(','), ...rows].join('\r\n');
    const filename = `conversations-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + csv);
  } catch (error) {
    logger.error('Error exporting data', { error });
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// Get operators for task assignment
router.get('/operators', async (req, res) => {
  try {
    const query = { role: 'operator', isActive: true, ...companyFilter(req.user) };

    const operators = await User.find(
      query,
      { _id: 1, username: 1, displayName: 1, email: 1, company: 1 }
    ).populate('company', 'name');

    res.json({ operators });
  } catch (error) {
    logger.error('Error fetching operators', { error });
    res.status(500).json({ error: 'Failed to retrieve operators' });
  }
});

// Get all operators (including inactive)
router.get('/all-operators', async (req, res) => {
  try {
    const query = { role: 'operator', ...companyFilter(req.user) };

    const operators = await User.find(
      query,
      { _id: 1, username: 1, displayName: 1, name: 1, email: 1, isActive: 1, createdAt: 1, lastLogin: 1, company: 1 }
    ).populate('company', 'name');

    res.json({ operators });
  } catch (error) {
    logger.error('Error fetching operators', { error });
    res.status(500).json({ error: 'Failed to retrieve operators' });
  }
});

/**
 * Everything below manages operator accounts. Plain operators must not be able
 * to create accounts, change roles, or reset their colleagues' passwords, so
 * these routes require admin (company_admin or superadmin) privileges.
 */
router.use('/operators', admin);

/**
 * Load a managed user, enforcing that company admins stay within their company.
 */
async function loadManagedOperator(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'Operator not found' });
    return null;
  }

  const target = await User.findById(req.params.id).populate('company');

  if (!target) {
    res.status(404).json({ error: 'Operator not found' });
    return null;
  }

  const targetCompanyId = target.company ? target.company._id : null;
  if (!canAccessCompany(req.user, targetCompanyId)) {
    res.status(403).json({ error: 'You can only manage users from your own company' });
    return null;
  }

  return target;
}

// Create a new operator
router.post('/operators', async (req, res) => {
  try {
    const { username, email, password, confirmPassword, name, displayName, companyId } = req.body;
    const currentUser = req.user;

    if (!username || !email || !password || !confirmPassword) {
      return res.status(400).json({ error: 'Username, email, password, and confirm password are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    const existingUser = await User.findOne({
      $or: [{ username }, { email: String(email).toLowerCase() }]
    });

    if (existingUser) {
      return res.status(400).json({
        error: 'User with this username or email already exists'
      });
    }

    // Determine company assignment
    let company = null;

    if (companyId) {
      if (!canAccessCompany(currentUser, companyId)) {
        return res.status(403).json({ error: 'You can only create operators for your own company' });
      }
      company = await Company.findById(companyId);
      if (!company) {
        return res.status(400).json({ error: 'Company not found' });
      }
    } else if (currentUser.role === 'company_admin') {
      if (!currentUser.company) {
        return res.status(400).json({ error: 'Company is required' });
      }
      company = await Company.findById(currentUser.company.id);
    } else {
      return res.status(400).json({ error: 'Company is required' });
    }

    const newOperator = new User({
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

    await newOperator.save();

    res.status(201).json({
      success: true,
      message: 'Operator created successfully',
      operator: {
        _id: newOperator._id,
        username: newOperator.username,
        displayName: newOperator.displayName,
        name: newOperator.name,
        email: newOperator.email,
        isActive: newOperator.isActive,
        company: company ? {
          id: company._id,
          name: company.name
        } : null
      }
    });
  } catch (error) {
    logger.error('Error creating operator', { error });
    res.status(500).json({ error: 'Failed to create operator' });
  }
});

// Update operator status (active/inactive)
router.patch('/operators/:id', async (req, res) => {
  try {
    const { isActive } = req.body;

    if (isActive === undefined) {
      return res.status(400).json({ error: 'isActive status is required' });
    }

    const target = await loadManagedOperator(req, res);
    if (!target) {
      return;
    }

    if (target.role !== 'operator') {
      return res.status(400).json({ error: 'User is not an operator' });
    }

    target.isActive = Boolean(isActive);
    await target.save();

    res.json({
      success: true,
      message: `Operator ${target.isActive ? 'activated' : 'deactivated'} successfully`,
      operator: {
        _id: target._id,
        username: target.username,
        displayName: target.displayName,
        name: target.name,
        email: target.email,
        isActive: target.isActive
      }
    });
  } catch (error) {
    logger.error('Error updating operator status', { error });
    res.status(500).json({ error: 'Failed to update operator status' });
  }
});

// Update operator details
router.put('/operators/:id', async (req, res) => {
  try {
    const { username, name, displayName, email, role, companyId } = req.body;
    const currentUser = req.user;

    if (!username || !email) {
      return res.status(400).json({ error: 'Username and email are required' });
    }

    const target = await loadManagedOperator(req, res);
    if (!target) {
      return;
    }

    if (currentUser.role === 'company_admin') {
      if (role && role !== 'operator') {
        return res.status(403).json({ error: 'Company admins can only manage operators' });
      }
      if (companyId && !canAccessCompany(currentUser, companyId)) {
        return res.status(403).json({ error: 'Company admins can only assign operators to their own company' });
      }
    }

    const existingUser = await User.findOne({
      $and: [
        { _id: { $ne: target._id } },
        { $or: [{ username }, { email: String(email).toLowerCase() }] }
      ]
    });

    if (existingUser) {
      if (existingUser.username === username) {
        return res.status(400).json({ error: 'Username is already taken' });
      }
      return res.status(400).json({ error: 'Email is already taken' });
    }

    let company = target.company;
    const newRole = role || target.role;

    if (newRole === 'superadmin' && currentUser.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmins can create other superadmins' });
    }

    if (companyId && (newRole === 'company_admin' || newRole === 'operator')) {
      company = await Company.findById(companyId);
      if (!company) {
        return res.status(400).json({ error: 'Company not found' });
      }
    } else if (!companyId && (newRole === 'company_admin' || newRole === 'operator') && !target.company) {
      return res.status(400).json({ error: 'Company is required for company admin and operator roles' });
    }

    target.username = username;
    target.name = name;
    target.displayName = displayName;
    target.email = email;

    if (role && (currentUser.role === 'superadmin' || (currentUser.role === 'company_admin' && role === 'operator'))) {
      target.role = role;
    }

    if (newRole === 'superadmin') {
      target.company = null;
    } else if (company) {
      target.company = company._id;
    }

    await target.save();

    res.json({
      success: true,
      message: 'Operator details updated successfully',
      operator: {
        _id: target._id,
        username: target.username,
        displayName: target.displayName,
        name: target.name,
        email: target.email,
        role: target.role,
        company: company ? {
          id: company._id,
          name: company.name
        } : null,
        isActive: target.isActive
      }
    });
  } catch (error) {
    logger.error('Error updating operator details', { error });
    res.status(500).json({ error: 'Failed to update operator details' });
  }
});

// Reset operator password
router.post('/operators/:id/reset-password', async (req, res) => {
  try {
    const { password, confirmPassword } = req.body;

    if (!password || !confirmPassword) {
      return res.status(400).json({ error: 'Password and confirm password are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    const target = await loadManagedOperator(req, res);
    if (!target) {
      return;
    }

    if (target.role !== 'operator') {
      return res.status(400).json({ error: 'User is not an operator' });
    }

    target.password = password;
    await target.save();

    logger.info('Operator password reset', {
      operatorId: target._id.toString(),
      by: req.user.username
    });

    res.json({
      success: true,
      message: 'Operator password reset successfully'
    });
  } catch (error) {
    logger.error('Error resetting operator password', { error });
    res.status(500).json({ error: 'Failed to reset operator password' });
  }
});

module.exports = router;
