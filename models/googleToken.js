const mongoose = require('mongoose');

const GoogleTokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  accessToken: String,
  refreshToken: String,
  scope: String,
  tokenType: String,
  expiryDate: Number,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

GoogleTokenSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const GoogleToken = mongoose.model('GoogleToken', GoogleTokenSchema);
module.exports = GoogleToken;
