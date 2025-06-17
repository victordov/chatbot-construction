const { google } = require('googleapis');
const GoogleAuthService = require('./googleAuth');

class UserGoogleDrive {
  constructor() {
    this.authService = new GoogleAuthService();
  }

  async searchSpreadsheets(userId, query = '') {
    const auth = await this.authService.getOAuthClient(userId);
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.spreadsheet' and name contains '${query}'`,
      fields: 'files(id,name)',
      spaces: 'drive'
    });
    return res.data.files || [];
  }
}

module.exports = UserGoogleDrive;
