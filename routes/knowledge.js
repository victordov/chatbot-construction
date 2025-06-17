const express = require('express');
const { auth, operator } = require('../middleware/auth');
const KnowledgeDocument = require('../models/knowledgeDocument');
const GoogleSheetsService = require('../services/googleSheets');

const router = express.Router();
const sheetsService = new GoogleSheetsService();

// Save a new spreadsheet as knowledge
router.post('/', auth, operator, async (req, res) => {
  const { spreadsheetId, title, active } = req.body || {};
  if (!spreadsheetId) {
    return res.status(400).json({ error: 'Spreadsheet ID required' });
  }
  try {
    const exists = await KnowledgeDocument.findOne({
      userId: req.user.id,
      spreadsheetId
    });
    if (exists) {
      return res.status(409).json({ error: 'Spreadsheet already saved' });
    }
    const doc = new KnowledgeDocument({
      userId: req.user.id,
      spreadsheetId,
      title,
      active: active !== undefined ? !!active : true
    });
    await doc.save();
    res.status(201).json({
      _id: doc._id,
      spreadsheetId: doc.spreadsheetId,
      title: doc.title,
      active: doc.active
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save spreadsheet' });
  }
});

// List knowledge documents belonging to the user
router.get('/', auth, operator, async (req, res) => {
  try {
    const filter = { userId: req.user.id };
    if (req.query.q) {
      filter.title = { $regex: req.query.q, $options: 'i' };
    }
    const docs = await KnowledgeDocument.find(filter)
      .select('title spreadsheetId active');
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

// Update active flag
router.put('/:id/active', auth, operator, async (req, res) => {
  try {
    const doc = await KnowledgeDocument.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { active: !!req.body.active },
      { new: true }
    ).select('title spreadsheetId active');
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// Get spreadsheet data for a knowledge document
router.get('/:id/sheet', auth, operator, async (req, res) => {
  try {
    const doc = await KnowledgeDocument.findOne({
      _id: req.params.id,
      userId: req.user.id
    });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const exclude = req.query.exclude ? req.query.exclude.split(',') : [];
    const data = await sheetsService.getSheetData(
      req.user.id,
      doc.spreadsheetId,
      req.query.range || 'Sheet1',
      exclude
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load spreadsheet' });
  }
});

module.exports = router;
