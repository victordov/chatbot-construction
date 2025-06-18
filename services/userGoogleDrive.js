const { google } = require('googleapis');
const GoogleAuthService = require('./googleAuth');
const { logger } = require('./logging');

class UserGoogleDrive {
  constructor() {
    this.authService = new GoogleAuthService();
  }

  async searchSpreadsheets(userId, query = '') {
    try {
      const auth = await this.authService.getOAuthClient(userId);
      const drive = google.drive({ version: 'v3', auth });

      const parts = ["mimeType='application/vnd.google-apps.spreadsheet'", 'trashed=false'];
      if (query) {
        const escaped = query.replace(/'/g, "\\'");
        parts.push(`name contains '${escaped}'`);
      }
      const q = parts.join(' and ');

      logger.debug('Searching Google Drive', { userId, query, q });
      const res = await drive.files.list({
        q,
        fields: 'files(id,name)',
        spaces: 'drive'
      });
      logger.debug('Google Drive search complete', { userId, count: res.data.files?.length || 0 });
      return res.data.files || [];
    } catch (error) {
      logger.error('Error searching Google Drive', { userId, query, error });
      throw error;
    }
  }
}

module.exports = UserGoogleDrive;
