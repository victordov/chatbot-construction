const mongoose = require('mongoose');

/**
 * Schema for storing chatbot suggestions for operators
 * These suggestions are generated in response to user messages
 * but are only shown to operators, not automatically sent to users
 */
const SuggestionSchema = new mongoose.Schema({
  // Reference to the conversation this suggestion belongs to
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true
  },
  // Session ID for easier querying
  sessionId: {
    type: String,
    required: true
  },
  // The user message this suggestion is responding to
  userMessageId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  // The content of the user message
  userMessage: {
    type: String,
    required: true
  },
  // The suggested response content
  content: {
    type: String,
    required: true
  },
  // Whether this suggestion was used by an operator
  used: {
    type: Boolean,
    default: false
  },
  // If the suggestion was used, store the edited version if it was modified
  editedContent: {
    type: String
  },
  // If the suggestion was used, reference the message that was created
  resultingMessageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation.messages'
  },
  // Timestamp when the suggestion was created
  createdAt: {
    type: Date,
    default: Date.now
  },
  // Timestamp when the suggestion was used (if it was)
  usedAt: {
    type: Date
  }
});

// Indexes for faster querying
SuggestionSchema.index({ conversationId: 1 });
SuggestionSchema.index({ sessionId: 1 });
SuggestionSchema.index({ userMessageId: 1 });
SuggestionSchema.index({ createdAt: 1 });

const Suggestion = mongoose.model('Suggestion', SuggestionSchema);

module.exports = Suggestion;