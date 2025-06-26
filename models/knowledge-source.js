const mongoose = require('mongoose');

const KnowledgeSourceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  
  description: {
    type: String,
    trim: true
  },
  
  type: {
    type: String,
    enum: ['google_sheets', 'pdf', 'url', 'vector_store', 'file_upload'],
    required: true
  },
  
  // Configuration based on source type
  config: {
    // Google Sheets specific
    sheetId: { type: String },
    range: { type: String, default: 'A:Z' },
    apiKey: { type: String }, // Encrypted
    
    // PDF/URL specific
    url: { type: String },
    filePath: { type: String },
    
    // Vector Store specific
    collectionName: { type: String },
    embeddingModel: { type: String, default: 'text-embedding-ada-002' },
    
    // File Upload specific
    fileName: { type: String },
    fileSize: { type: Number },
    mimeType: { type: String },
    s3Key: { type: String },
    
    // Processing options
    chunkSize: { type: Number, default: 1000 },
    chunkOverlap: { type: Number, default: 200 },
    preprocessingOptions: {
      removeEmptyLines: { type: Boolean, default: true },
      normalizeWhitespace: { type: Boolean, default: true },
      extractMetadata: { type: Boolean, default: true }
    }
  },
  
  // Company context for multi-tenancy
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: function() {
      return this.createdBy && this.createdBy.role !== 'superadmin';
    },
    default: null
  },
  
  // Access control
  isActive: {
    type: Boolean,
    default: true
  },
  
  isPublic: {
    type: Boolean,
    default: false // Whether this source can be used by other companies
  },
  
  // Sync status
  lastSync: {
    type: Date
  },
  
  syncStatus: {
    type: String,
    enum: ['pending', 'syncing', 'success', 'error', 'never_synced'],
    default: 'never_synced'
  },
  
  syncError: {
    message: { type: String },
    timestamp: { type: Date },
    retryCount: { type: Number, default: 0 }
  },
  
  // Statistics
  stats: {
    documentCount: { type: Number, default: 0 },
    totalSize: { type: Number, default: 0 }, // in bytes
    embeddingCount: { type: Number, default: 0 },
    lastUsed: { type: Date },
    usageCount: { type: Number, default: 0 }
  },
  
  // Metadata
  tags: [{ type: String, trim: true }],
  
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
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

// Indexes for performance
KnowledgeSourceSchema.index({ company: 1, isActive: 1 });
KnowledgeSourceSchema.index({ type: 1, company: 1 });
KnowledgeSourceSchema.index({ tags: 1 });
KnowledgeSourceSchema.index({ syncStatus: 1 });
KnowledgeSourceSchema.index({ 'stats.lastUsed': -1 });
KnowledgeSourceSchema.index({ createdBy: 1 });

// Text search index
KnowledgeSourceSchema.index({ 
  name: 'text', 
  description: 'text', 
  tags: 'text' 
}, {
  weights: {
    name: 10,
    description: 5,
    tags: 1
  }
});

// Pre-save middleware
KnowledgeSourceSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Methods
KnowledgeSourceSchema.methods.markAsUsed = function() {
  this.stats.lastUsed = new Date();
  this.stats.usageCount = (this.stats.usageCount || 0) + 1;
  return this.save();
};

KnowledgeSourceSchema.methods.updateSyncStatus = function(status, error = null) {
  this.syncStatus = status;
  this.lastSync = new Date();
  
  if (error) {
    this.syncError = {
      message: error.message || error,
      timestamp: new Date(),
      retryCount: (this.syncError?.retryCount || 0) + 1
    };
  } else if (status === 'success') {
    this.syncError = undefined;
  }
  
  return this.save();
};

KnowledgeSourceSchema.methods.updateStats = function(stats) {
  Object.assign(this.stats, stats);
  return this.save();
};

// Static methods
KnowledgeSourceSchema.statics.getByCompany = function(companyId, type = null) {
  const filter = { 
    company: companyId, 
    isActive: true 
  };
  
  if (type) filter.type = type;
  
  return this.find(filter)
    .populate('createdBy', 'username displayName')
    .sort({ updatedAt: -1 });
};

KnowledgeSourceSchema.statics.getPublicSources = function(type = null) {
  const filter = { 
    isPublic: true, 
    isActive: true,
    syncStatus: 'success'
  };
  
  if (type) filter.type = type;
  
  return this.find(filter)
    .populate('createdBy', 'username displayName')
    .sort({ 'stats.usageCount': -1 });
};

KnowledgeSourceSchema.statics.searchSources = function(query, companyId) {
  return this.find({
    $and: [
      { 
        $or: [
          { company: companyId },
          { isPublic: true }
        ]
      },
      { isActive: true },
      { $text: { $search: query } }
    ]
  }, { 
    score: { $meta: 'textScore' } 
  })
  .sort({ score: { $meta: 'textScore' } })
  .populate('createdBy', 'username displayName');
};

KnowledgeSourceSchema.statics.getNeedingSync = function() {
  return this.find({
    isActive: true,
    syncStatus: { $in: ['pending', 'error'] },
    $or: [
      { 'syncError.retryCount': { $lt: 3 } },
      { 'syncError.retryCount': { $exists: false } }
    ]
  });
};

const KnowledgeSource = mongoose.model('KnowledgeSource', KnowledgeSourceSchema);

module.exports = KnowledgeSource;
