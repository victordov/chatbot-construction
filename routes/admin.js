const express = require('express');
const Conversation = require('../models/conversation');
const ColumnConfig = require('../models/columnConfig');
const User = require('../models/user');
const { auth, operator } = require('../middleware/auth');

const router = express.Router();

// Apply auth middleware to all routes
router.use(auth);
router.use(operator);

// Get active conversations
router.get('/active-chats', async (req, res) => {
  try {
    const activeChatsSummary = await Conversation.find(
      { status: 'active' },
      { sessionId: 1, startedAt: 1, domain: 1, 'messages.length': { $size: '$messages' } }
    ).sort({ lastActivity: -1 });

    res.json({ chats: activeChatsSummary });
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

    const chatHistory = await Conversation.find(
      query,
      { sessionId: 1, startedAt: 1, endedAt: 1, status: 1, domain: 1, 'messages.length': { $size: '$messages' } }
    ).sort({ startedAt: -1 }).limit(100);

    res.json({ history: chatHistory });
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

    res.json(conversation);
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
    // Get total chats today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const totalChatsToday = await Conversation.countDocuments({
      startedAt: { $gte: today }
    });

    // Get active chats
    const activeChats = await Conversation.countDocuments({
      status: 'active'
    });

    // Get chat volume per day for the last 7 days
    const last7Days = new Date();
    last7Days.setDate(last7Days.getDate() - 7);

    const chatVolumePerDay = await Conversation.aggregate([
      {
        $match: {
          startedAt: { $gte: last7Days }
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

    // Get average response time
    // In a real app, you would calculate this based on message timestamps
    const avgResponseTime = 5; // Placeholder

    res.json({
      totalChatsToday,
      activeChats,
      chatVolumePerDay,
      avgResponseTime
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to retrieve analytics data' });
  }
});

// Get column configuration
router.get('/column-config/:type', async (req, res) => {
  try {
    const { type } = req.params;

    // Find existing config or create default
    let config = await ColumnConfig.findOne({ type });

    if (!config) {
      // Create default configuration based on pdfGenerator defaults
      const defaultColumns = [
        { key: 'address', label: 'Address', enabled: true, order: 0 },
        { key: 'size', label: 'Size (sq ft)', enabled: true, order: 1 },
        { key: 'rooms', label: 'Rooms', enabled: true, order: 2 },
        { key: 'price', label: 'Price', enabled: true, order: 3 },
        { key: 'details', label: 'Details', enabled: true, order: 4 }
      ];

      config = new ColumnConfig({
        type,
        columns: defaultColumns,
        createdBy: req.user.id,
        updatedBy: req.user.id
      });

      await config.save();
    }

    res.json(config);
  } catch (error) {
    console.error('Error fetching column configuration:', error);
    res.status(500).json({ error: 'Failed to retrieve column configuration' });
  }
});

// Update column configuration
router.post('/column-config/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { columns } = req.body;

    if (!Array.isArray(columns)) {
      return res.status(400).json({ error: 'Invalid columns data' });
    }

    // Find existing config or create new one
    let config = await ColumnConfig.findOne({ type });

    if (config) {
      // Update existing config
      config.columns = columns;
      config.updatedBy = req.user.id;
    } else {
      // Create new config
      config = new ColumnConfig({
        type,
        columns,
        createdBy: req.user.id,
        updatedBy: req.user.id
      });
    }

    await config.save();

    res.json({ success: true, config });
  } catch (error) {
    console.error('Error updating column configuration:', error);
    res.status(500).json({ error: 'Failed to update column configuration' });
  }
});

// Get operators for task assignment
router.get('/operators', async (req, res) => {
  try {
    // Find all active operators
    const operators = await User.find(
      { role: 'operator', isActive: true },
      { _id: 1, username: 1, email: 1 }
    );

    res.json({ operators });
  } catch (error) {
    console.error('Error fetching operators:', error);
    res.status(500).json({ error: 'Failed to retrieve operators' });
  }
});

// Get all operators (including inactive)
router.get('/all-operators', async (req, res) => {
  try {
    // Find all operators regardless of active status
    const operators = await User.find(
      { role: 'operator' },
      { _id: 1, username: 1, name: 1, email: 1, isActive: 1, createdAt: 1, lastLogin: 1 }
    );

    res.json({ operators });
  } catch (error) {
    console.error('Error fetching operators:', error);
    res.status(500).json({ error: 'Failed to retrieve operators' });
  }
});

// Create a new operator
router.post('/operators', async (req, res) => {
  try {
    const { username, email, password, confirmPassword, name } = req.body;

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

    // Create new operator
    const operator = new User({
      username,
      name,
      email,
      password,
      role: 'operator',
      isActive: true
    });

    await operator.save();

    res.status(201).json({ 
      success: true, 
      message: 'Operator created successfully',
      operator: {
        _id: operator._id,
        username: operator.username,
        name: operator.name,
        email: operator.email,
        isActive: operator.isActive
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
    const { username, name, email } = req.body;

    // Validate input
    if (!username || !email) {
      return res.status(400).json({ error: 'Username and email are required' });
    }

    // Find operator
    const operator = await User.findById(id);

    if (!operator) {
      return res.status(404).json({ error: 'Operator not found' });
    }

    if (operator.role !== 'operator') {
      return res.status(400).json({ error: 'User is not an operator' });
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

    // Update operator details
    operator.username = username;
    operator.name = name;
    operator.email = email;

    await operator.save();

    res.json({ 
      success: true, 
      message: 'Operator details updated successfully',
      operator: {
        _id: operator._id,
        username: operator.username,
        name: operator.name,
        email: operator.email,
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
