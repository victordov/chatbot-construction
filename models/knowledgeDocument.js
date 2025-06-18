const mongoose = require('mongoose');

const ColumnSchema = new mongoose.Schema({
  name: String,
  description: String,
  exclude: { type: Boolean, default: false }
});

const KnowledgeDocumentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  spreadsheetId: { type: String, required: true },
  sheet: { type: String, default: 'Sheet1' },
  title: String,
  columns: [ColumnSchema],
  rows: { type: [[String]], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

KnowledgeDocumentSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const KnowledgeDocument = mongoose.model('KnowledgeDocument', KnowledgeDocumentSchema);
module.exports = KnowledgeDocument;
