const { google } = require('googleapis');
const GoogleAuthService = require('./googleAuth');
const { logger } = require('./logging');

class GoogleSheetsService {
  constructor() {
    this.authService = new GoogleAuthService();
  }

  /**
   * Fetches data from a Google Sheet.
   * @param {string} userId The user's ID for authentication.
   * @param {string} spreadsheetId The ID of the spreadsheet.
   * @param {string} [range="'Sheet1'"] The A1 notation of the range to retrieve. Defaults to the entire 'Sheet1'. Note the single quotes.
   * @param {string[]} [exclude=[]] An array of header columns to exclude from the result.
   * @returns {Promise<{header: string[], rows: any[][]}>} The header row and data rows.
   */
  async getSheetData(userId, spreadsheetId, range = 'Sheet1', exclude = []) { // FIX: Added single quotes around Sheet1
    try {
      const auth = await this.authService.getOAuthClient(userId);
      const sheets = google.sheets({ version: 'v4', auth });

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range
      });

      const values = response.data.values || [];
      if (values.length === 0) {
        return { header: [], rows: [] };
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
    } catch (error) {
      logger.error(`Error fetching spreadsheet data from Google: ${JSON.stringify({
        userId,
        error: error.message, // Log the specific error message for clarity
        spreadsheetId,
        range
      })}`);
      // Re-throwing the error maintains the original stack trace and allows the caller to handle it.
      // Adding more context to the thrown error can be helpful for upstream error handlers.
      const enrichedError = new Error(`Failed to fetch data from Google Sheet. ID: ${spreadsheetId}. Range: ${range}.`);
      enrichedError.cause = error;
      enrichedError.statusCode = error.code || 500;
      throw enrichedError;
    }
  }

  /**
   * Retrieves all sheet names for a given spreadsheet.
   * @param {string} userId The user's ID for authentication.
   * @param {string} spreadsheetId The ID of the spreadsheet.
   * @returns {Promise<string[]>} Array of sheet names.
   */
  async getSheetNames(userId, spreadsheetId) {
    try {
      const auth = await this.authService.getOAuthClient(userId);
      const sheets = google.sheets({ version: 'v4', auth });
      const response = await sheets.spreadsheets.get({ spreadsheetId });
      const names = (response.data.sheets || []).map(s => s.properties.title);
      const title = response.data.properties?.title;
      return { names, title };
    } catch (error) {
      logger.error('Error fetching sheet names', {
        userId,
        spreadsheetId,
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = GoogleSheetsService;