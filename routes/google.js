const express = require('express');
const { auth, operator } = require('../middleware/auth');
const GoogleAuthService = require('../services/googleAuth');
const GoogleSheetsService = require('../services/googleSheets');
const UserGoogleDrive = require('../services/userGoogleDrive');
const KnowledgeService = require('../services/knowledge');
const { logger } = require('../services/logging');

const router = express.Router();
const authService = new GoogleAuthService();
const sheetsService = new GoogleSheetsService();
const driveService = new UserGoogleDrive();
const knowledgeService = new KnowledgeService();

// Generate OAuth URL
router.get('/auth/url', auth, (req, res) => {
  try {
    const url = authService.generateAuthUrl(req.user.id.toString());
    res.json({ url });
  } catch (err) {
    logger.error('Failed to generate auth url', { error: err });
    res.status(500).json({ error: 'Failed to generate auth url' });
  }
});

// OAuth callback
router.get('/oauth2callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send('Invalid OAuth response');
  }
  try {
    await authService.handleOAuthCallback(state, code);
    res.send('Google authorization successful. You can close this window.');
  } catch (err) {
    logger.error('Failed OAuth callback', { error: err });
    res.status(500).send('Failed to authorize with Google');
  }
});

// Save OAuth tokens
router.post('/token', auth, async (req, res) => {
  try {
    await authService.saveTokens(req.user.id, req.body);
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to save Google tokens', { error: err });
    res.status(500).json({ error: 'Failed to save token' });
  }
});

// Check if user already authorized
router.get('/status', auth, async (req, res) => {
  try {
    const authorized = await authService.hasTokens(req.user.id);
    res.json({ authorized });
  } catch (err) {
    logger.error('Failed to check Google auth status', { error: err });
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// Search user drive for spreadsheets
router.get('/drive/search', auth, async (req, res) => {
  const query = req.query.q || '';
  try {
    logger.info('Drive search requested', { userId: req.user.id, query });
    const files = await driveService.searchSpreadsheets(req.user.id, query);
    res.json({ files });
  } catch (err) {
    logger.error('Failed to search Google Drive', { userId: req.user.id, query, error: err });
    res.status(500).json({ error: 'Failed to search drive' });
  }
});

// Import spreadsheet and store as knowledge document
router.post('/knowledge/import', auth, async (req, res) => {
  try {
    const { spreadsheetId, exclude } = req.body;
    const doc = await knowledgeService.importSpreadsheet(req.user.id, spreadsheetId, exclude || []);
    res.json({ doc });
  } catch (err) {
    logger.error('Failed to import spreadsheet', { error: err });
    res.status(500).json({ error: 'Failed to import spreadsheet' });
  }
});

// List stored knowledge documents
router.get('/knowledge', auth, async (req, res) => {
  try {
    const docs = await knowledgeService.list(req.user.id, req.query.q || '');
    res.json({ docs });
  } catch (err) {
    logger.error('Failed to list knowledge documents', { error: err });
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

// Get document with rows
router.get('/knowledge/:id', auth, async (req, res) => {
  try {
    const doc = await knowledgeService.get(req.user.id, req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ doc });
  } catch (err) {
    logger.error('Failed to get knowledge document', { error: err });
    res.status(500).json({ error: 'Failed to get document' });
  }
});

// Refresh document from Google
router.post('/knowledge/:id/refresh', auth, async (req, res) => {
  try {
    const doc = await knowledgeService.refresh(req.user.id, req.params.id);
    res.json({ doc });
  } catch (err) {
    logger.error('Failed to refresh knowledge document', { error: err });
    res.status(500).json({ error: 'Failed to refresh document' });
  }
});

// Update excluded columns
router.post('/knowledge/:id/columns', auth, async (req, res) => {
  try {
    const { excluded } = req.body;
    const doc = await knowledgeService.updateColumns(req.user.id, req.params.id, excluded || []);
    res.json({ doc });
  } catch (err) {
    logger.error('Failed to update excluded columns', { error: err });
    res.status(500).json({ error: 'Failed to update columns' });
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
    logger.error('Failed to fetch spreadsheet', { error: err });
    res.status(500).json({ error: 'Failed to fetch sheet' });
  }
});

module.exports = router;
