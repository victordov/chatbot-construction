const { google } = require('googleapis');
const GoogleAuthService = require('./googleAuth');

class GoogleSheetsService {
  constructor() {
    this.authService = new GoogleAuthService();
  }

  async getSheetData(userId, spreadsheetId, range = 'Sheet1', exclude = []) {
    const auth = await this.authService.getOAuthClient(userId);
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    });

    const values = response.data.values || [];
    if (values.length === 0) {
      return {header: [], rows: []};
    }
    const [header, ...rows] = values;
    const indices = header.reduce((acc, col, idx) => {
      if (exclude.includes(col)) {
        acc.push(idx);
      }
      return acc;
    }, []);
    const filteredHeader = header.filter((_, idx) => !indices.includes(idx));
    const filteredRows = rows.map(row => row.filter((_, idx) => !indices.includes(idx)));
    return { header: filteredHeader, rows: filteredRows };
  }
}

module.exports = GoogleSheetsService;
