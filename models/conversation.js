const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  content: {
    type: String,
    required: true
  },
  sender: {
    type: String,
    enum: ['user', 'bot', 'operator'],
    required: true
  },
  messageId: {
    type: String
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: {
    type: Date
  },
  encrypted: {
    type: Boolean,
    default: false
  },
  fileId: {
    type: String
  },
  fileName: {
    type: String
  },
  operatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  operatorName: {
    type: String
  },
  /** The RFC Message-ID this message was delivered as, for email threading. */
  emailMessageId: {
    type: String
  },
  attachments: [{
    filename: String,
    url: String,
    mimeType: String
  }],
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const ConversationSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true
  },
  // SHA-256 of the secret the widget must present to resume or write to this
  // conversation. The session id alone is not a credential: it appears in
  // dashboard URLs, exports and webhook payloads.
  sessionTokenHash: {
    type: String,
    select: false
  },
  /**
   * How this conversation reaches the customer.
   *
   * Chat and email land in the same queue and are answered from the same
   * composer; the difference is only in delivery. An operator should not have
   * to think about which one they are in.
   */
  channel: {
    type: String,
    enum: ['chat', 'email'],
    default: 'chat'
  },
  /**
   * Threading state for email conversations.
   *
   * `messageIds` is every Message-ID we have seen or sent on this thread.
   * Mail clients reply with `In-Reply-To` pointing at any of them, so matching
   * against the whole set is what keeps a long thread together.
   */
  email: {
    subject: { type: String },
    from: { type: String, lowercase: true, trim: true },
    to: { type: String, lowercase: true, trim: true },
    messageIds: [{ type: String }],
    lastMessageId: { type: String }
  },
  userId: {
    type: String
  },
  domain: {
    type: String
  },
  messages: [MessageSchema],
  status: {
    type: String,
    enum: ['active', 'ended', 'archived'],
    default: 'active'
  },
  hasOperator: {
    type: Boolean,
    default: false
  },
  operatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  operatorName: {
    type: String
  },
  suggestionsEnabled: {
    type: Boolean,
    default: true
  },
  botEnabled: {
    type: Boolean,
    default: true
  },
  metadata: {
    type: Map,
    of: String
  },
  tasks: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task'
  }],
  /**
   * Operator-only notes. Never sent to the visitor and never included in the
   * model's context — the whole point is somewhere to write things you would
   * not say out loud, and to carry context across a handover.
   */
  notes: [{
    body: { type: String, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    authorName: { type: String },
    /** System notes record transfers and similar events. */
    system: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
  }],
  /**
   * Who has handed this conversation on, and to whom. Kept so an operator
   * picking up a transferred chat can see where it came from.
   */
  transferredFrom: {
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    operatorName: { type: String },
    at: { type: Date }
  },
  /**
   * Operator-applied labels: "billing", "vip", "bug-report".
   *
   * Deliberately free-form rather than a fixed list. Every business slices its
   * conversations differently, and a schema that guessed the categories would
   * be wrong for most of them. Existing tags are offered as suggestions, which
   * is enough to stop "billing" and "Billing" both existing.
   */
  tags: [{ type: String, trim: true, lowercase: true }],
  /**
   * How this conversation reached the operator handling it. Kept so a manager
   * can tell whether the queue is distributing work or whether people are
   * cherry-picking.
   */
  assignment: {
    method: { type: String, enum: ['auto', 'manual'] },
    at: { type: Date }
  },
  /**
   * When the visitor asked for a person and nobody was free.
   *
   * Kept separately from `hasOperator` so the queue can distinguish "waiting for
   * someone" from "nobody has looked at this", and cleared once a person takes
   * it. The bot keeps answering while this is set — being in a queue is not a
   * reason to stop helping somebody.
   */
  awaitingOperatorSince: {
    type: Date
  },
  /**
   * Where the published workflow got to.
   *
   * A workflow that asks a question has to survive until the answer arrives,
   * which is a different message, often minutes later and sometimes on a
   * different socket. Without this the walk restarts from the entry point every
   * time and the same question is asked forever.
   *
   * `variables` are what the flow has collected so far. Values only — never a
   * credential, because this is read back into a prompt.
   */
  workflowState: {
    workflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow' },
    awaiting: { type: mongoose.Schema.Types.Mixed },
    variables: { type: mongoose.Schema.Types.Mixed },
    updatedAt: { type: Date }
  },
  /**
   * A change the assistant proposed and the visitor has not yet confirmed.
   *
   * Writes (a booking, a ticket, anything not a GET) are never run on the
   * model's first request: it is told to ask, and this records exactly what
   * it asked about. Only an identical call in a later turn, after an
   * affirmative reply, runs it — see services/assistant-tools.js. `args` are
   * the visitor-supplied values only; never a credential or a verified id.
   */
  pendingAction: {
    tool: { type: String },
    args: { type: mongoose.Schema.Types.Mixed },
    argsHash: { type: String },
    summary: { type: String },
    requestedAt: { type: Date },
    expiresAt: { type: Date }
  },
  /**
   * What the assistant's tools returned in recent turns, trimmed.
   *
   * The model only sees text history, so without this a slot id or an order
   * status read one turn is gone the next, and "book the second one" cannot
   * be answered. Short-lived and capped; cleared with the transcript.
   */
  recentToolResults: [{
    _id: false,
    tool: { type: String },
    content: { type: String },
    at: { type: Date }
  }],
  /**
   * What the customer thought of it.
   *
   * The operator is copied in at rating time rather than looked up later,
   * because ending a chat clears `operatorId` and `operatorName` — reading them
   * afterwards would attribute every rating to nobody.
   *
   * `handledBy` is who actually answered: 'bot' when nobody took it over, which
   * is the comparison that matters. A deflection rate means little without
   * knowing whether the deflected customers were satisfied.
   */
  rating: {
    score: { type: Number, min: 1, max: 5 },
    comment: { type: String, trim: true, maxlength: 1000 },
    ratedAt: { type: Date },
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    operatorName: { type: String },
    handledBy: { type: String, enum: ['bot', 'operator'] }
  },
  /**
   * Whether the visitor has been asked yet. Kept separately from `rating.score`
   * so a decline is remembered: without it every reconnect would ask again,
   * which is the fastest way to make people close the widget.
   */
  ratingRequestedAt: {
    type: Date
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  endedAt: {
    type: Date
  },
  lastActivity: {
    type: Date,
    default: Date.now
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company'
  },
  /**
   * When identifying detail was stripped from this conversation by the
   * retention sweep. Recorded rather than inferred so a second pass does not
   * re-scrub an already-scrubbed transcript, and so the dashboard can say why
   * an old conversation reads as empty instead of looking broken.
   */
  anonymizedAt: {
    type: Date
  },
  /**
   * The person behind this conversation. Lets an operator see everything the
   * same customer has asked before, across sessions and devices.
   */
  contact: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact'
  }
});

/**
 * Metadata keys that hold the visitor's details. The socket layer and the
 * dashboard write `name`, `email` and `phone` here from the pre-chat form and
 * the operator's "contact details" panel; older widgets wrote `visitor*`
 * variants of the same. `consent` stays: it is what the visitor agreed to,
 * not who they are, and the record of consent is itself something a tenant
 * has to keep.
 */
const PII_METADATA_KEYS = new Set([
  'name', 'email', 'phone', 'firstName', 'lastName', 'fullName',
  'address', 'ip', 'ipAddress', 'userAgent', 'company', 'username', 'userId'
]);

function isIdentifyingMetadataKey(key) {
  return PII_METADATA_KEYS.has(key) || /^visitor/i.test(key) || /^user/i.test(key);
}

/**
 * Strip everything that identifies the person, keeping the shape of the
 * conversation.
 *
 * The distinction retention policies rest on: after the retention window a
 * tenant may no longer hold what a customer said or who they were, but the
 * fact that a conversation happened - when, how long, who answered, how it was
 * rated - is what every report is built from, and deleting that silently
 * rewrites a tenant's history.
 *
 * Message text goes because people type addresses, order numbers and card
 * details into chat windows; there is no reliable way to keep the text and
 * claim the record is anonymous. The same applies to operator notes, to what
 * a workflow collected ("what is your order number?"), and to the free-text
 * half of a rating.
 *
 * Files are not removed here: the model does not know about the filesystem.
 * Callers that scrub a conversation delete its uploads first, through
 * services/uploads.js, while the message still says which files it had.
 */
ConversationSchema.methods.anonymize = async function() {
  if (this.anonymizedAt) {
    return this;
  }

  this.userId = undefined;
  this.domain = undefined;
  this.contact = undefined;

  if (this.email) {
    this.email.from = undefined;
    this.email.to = undefined;
    this.email.subject = undefined;
    this.email.messageIds = [];
    this.email.lastMessageId = undefined;
  }

  if (this.metadata) {
    // Iterate over a copy: deleting from a Map while iterating it is defined
    // behaviour in JavaScript, but mongoose's change tracking is happier when
    // the keys are settled before the deletes begin.
    Array.from(this.metadata.keys())
      .filter(isIdentifyingMetadataKey)
      .forEach(key => this.metadata.delete(key));
    this.markModified('metadata');
  }

  this.messages.forEach(message => {
    message.content = '[removed]';
    message.fileId = undefined;
    message.fileName = undefined;
    message.attachments = [];
    message.emailMessageId = undefined;
    message.encrypted = false;
  });

  // Notes are where an operator writes what they would not say out loud,
  // which is exactly the kind of thing that names somebody.
  this.notes = [];

  if (this.workflowState) {
    // The answers a flow collected are the visitor's words, same as messages.
    // `awaiting` is only the question, but it is keyed by the flow's state and
    // useless once the answers are gone.
    this.workflowState.variables = undefined;
    this.workflowState.awaiting = undefined;
    this.markModified('workflowState');
  }

  // What the assistant's tools read back is third-party data about this
  // person — an order, a booking — so it goes with the messages.
  this.pendingAction = undefined;
  this.recentToolResults = [];

  if (this.rating && this.rating.comment) {
    // A free-text comment is as likely to name somebody as a message is.
    this.rating.comment = undefined;
  }

  this.anonymizedAt = new Date();
  return this.save();
};

// Indexes tuned for the dashboard's access patterns.
// `sessionId` is already indexed by its `unique: true` constraint.
ConversationSchema.index({ userId: 1 });
// Active-chat list: filter by company + status, sort by lastActivity.
ConversationSchema.index({ company: 1, status: 1, lastActivity: -1 });
// Chat history and analytics: filter by company, sort/range by startedAt.
ConversationSchema.index({ company: 1, startedAt: -1 });
ConversationSchema.index({ status: 1, lastActivity: -1 });
// A contact's history, newest first.
ConversationSchema.index({ contact: 1, startedAt: -1 });
// Email threading: an inbound reply is matched against every Message-ID we
// have seen on the thread.
ConversationSchema.index({ 'email.messageIds': 1 });
ConversationSchema.index({ company: 1, channel: 1, status: 1 });
// Filtering the queue by tag.
ConversationSchema.index({ company: 1, tags: 1, lastActivity: -1 });
// Per-operator load: how many conversations someone currently holds.
ConversationSchema.index({ company: 1, operatorId: 1, status: 1 });
// CSAT reporting: rated conversations for a company over a period.
ConversationSchema.index(
  { company: 1, 'rating.ratedAt': -1 },
  { partialFilterExpression: { 'rating.score': { $exists: true } } }
);

const Conversation = mongoose.model('Conversation', ConversationSchema);

module.exports = Conversation;
