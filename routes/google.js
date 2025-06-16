const express = require('express');
const { auth, operator } = require('../middleware/auth');
const GoogleAuthService = require('../services/googleAuth');
const GoogleSheetsService = require('../services/googleSheets');

const router = express.Router();
const authService = new GoogleAuthService();
const sheetsService = new GoogleSheetsService();

// Save OAuth tokens
router.post('/token', auth, async (req, res) => {
  try {
    await authService.saveTokens(req.user.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save token' });
  }
});

// Get spreadsheet data
router.get('/sheets/:spreadsheetId', auth, operator, async (req, res) => {
  try {
    const exclude = req.query.exclude ? req.query.exclude.split(',') : [];
    const data = await sheetsService.getSheetData(
      req.user.id,
      req.params.spreadsheetId,
      req.query.range || 'Sheet1',
      exclude
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sheet' });
  }
});

module.exports = router;
