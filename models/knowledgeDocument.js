const mongoose = require('mongoose');

const ColumnSchema = new mongoose.Schema({
  name: String,
  description: String,
  exclude: { type: Boolean, default: false }
});

const KnowledgeDocumentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  spreadsheetId: { type: String, required: true },
  title: String,
  active: { type: Boolean, default: true },
  columns: [ColumnSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

KnowledgeDocumentSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const KnowledgeDocument = mongoose.model('KnowledgeDocument', KnowledgeDocumentSchema);
module.exports = KnowledgeDocument;
