// Google Drive API integration service
// Handles authentication and file retrieval from Google Drive

const { google } = require('googleapis');
const fs = require('fs');
const GoogleAuthService = require('./googleAuth');

class GoogleDriveService {
  constructor() {
    this.authService = new GoogleAuthService();
  }

  async getDriveClient(userId) {
    const auth = await this.authService.getOAuthClient(userId);
    return google.drive({ version: 'v3', auth });
  }

  async listSpreadsheets(userId, query = '', pageSize = 100) {
    const drive = await this.getDriveClient(userId);
    const qParts = ["mimeType='application/vnd.google-apps.spreadsheet'"];
    if (query) {
      qParts.push(`name contains '${query.replace(/'/g, "\\'")}'`);
    }
    const res = await drive.files.list({
      q: qParts.join(' and '),
      pageSize,
      fields: 'files(id, name)'
    });
    return res.data.files;
  }

  async downloadFile(userId, fileId, destPath) {
    const drive = await this.getDriveClient(userId);
    const dest = fs.createWriteStream(destPath);
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    await new Promise((resolve, reject) => {
      res.data.on('end', resolve).on('error', reject).pipe(dest);
    });
    return destPath;
  }
}

module.exports = GoogleDriveService;
