const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  name: {
    type: String,
    trim: true
  },
  displayName: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['superadmin', 'company_admin', 'operator'],
    default: 'operator'
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: function() {
      return this.role === 'company_admin' || this.role === 'operator';
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Incremented on password change or reset; a JWT carries the value it was
  // issued with (`tv`) and is refused once they differ.
  tokenVersion: {
    type: Number,
    default: 0
  },
  // Self-service password reset. Only the SHA-256 of the emailed token is
  // stored, so a copy of the database is not a copy of every open reset link.
  // Not selected by default: nothing but the reset route has a use for it.
  passwordResetTokenHash: {
    type: String,
    select: false
  },
  /**
   * Invitations. An invited user exists with an unusable random password and
   * cannot sign in until they open the link and choose their own. Only the
   * SHA-256 of the emailed token is stored.
   */
  invitePending: {
    type: Boolean,
    default: false
  },
  inviteTokenHash: {
    type: String,
    select: false
  },
  inviteExpires: {
    type: Date
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  /** Set when the address has been shown to belong to this user. */
  emailVerifiedAt: {
    type: Date
  },
  emailVerifyTokenHash: {
    type: String,
    select: false
  },
  passwordResetExpires: {
    type: Date,
    select: false
  },
  /**
   * Override the company's concurrent-chat cap for this person.
   *
   * A team is not uniform: someone new takes two at a time, someone
   * experienced takes six, and a team lead answering between meetings takes
   * one. Null means "use the company setting".
   */
  maxConcurrentChats: {
    type: Number,
    min: 1,
    max: 20,
    default: null
  },
  /**
   * Whether this person is taking new conversations right now.
   *
   * Distinct from being connected: someone can be at their desk with the
   * dashboard open and still not want the queue handing them anything, because
   * they are finishing a difficult one or about to leave.
   */
  acceptingChats: {
    type: Boolean,
    default: true
  },
  /**
   * The person's own timezone, for showing them times as they live them.
   * Unset means "whatever the browser says".
   */
  timezone: {
    type: String,
    trim: true
  },
  /**
   * Set when an admin removed this person. The account is kept, deactivated
   * and with its name replaced, because conversations, notes and the audit
   * log still point at it; it just stops being anyone.
   */
  deletedAt: {
    type: Date
  },
  lastLogin: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
});

// Hash password before saving
UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    return next();
  }

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare passwords
UserSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', UserSchema);

module.exports = User;
