const mongoose = require('mongoose');

const ColumnSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true
  },
  label: {
    type: String,
    required: true
  },
  enabled: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0
  }
});

const ColumnConfigSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    default: 'apartment_info',
    enum: ['apartment_info']
  },
  columns: [ColumnSchema],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Pre-save hook to update the updatedAt field
ColumnConfigSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const ColumnConfig = mongoose.model('ColumnConfig', ColumnConfigSchema);

module.exports = ColumnConfig;