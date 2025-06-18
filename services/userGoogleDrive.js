const { google } = require('googleapis');
const GoogleAuthService = require('./googleAuth');
const { logger } = require('./logging');

class UserGoogleDrive {
  constructor() {
    this.authService = new GoogleAuthService();
  }

  /**
   * Searches for non-trashed Google Spreadsheets in a user's Drive,
   * fetching all pages of results.
   * @param {string} userId - The ID of the user to authenticate as.
   * @param {string} [query=''] - An optional string to filter files by name.
   * @returns {Promise<Array<Object>>} A promise that resolves to an array of file objects.
   * @throws Will throw an error if the API call fails.
   */
  async searchSpreadsheets(userId, query = '') {
    try {
      const auth = await this.authService.getOAuthClient(userId);
      const drive = google.drive({ version: 'v3', auth });

      const queryParts = ["mimeType='application/vnd.google-apps.spreadsheet'", 'trashed=false'];

      if (query) {
        // DEFECT FIX #3: More robustly escape backslashes and single quotes.
        const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        queryParts.push(`name contains '${escapedQuery}'`);
      }
      const q = queryParts.join(' and ');

      logger.debug('Searching Google Drive', { userId, query, q });

      // DEFECT FIX #2: Implement pagination to fetch all results.
      let allFiles = [];
      let pageToken = null;
      do {
        const res = await drive.files.list({
          q,
          fields: 'files(id,name),nextPageToken',
          spaces: 'drive',
          pageSize: 1000,
          pageToken: pageToken
        });

        if (res.data.files) {
          allFiles = allFiles.concat(res.data.files);
        }
        pageToken = res.data.nextPageToken; // Get the token for the next iteration
      } while (pageToken);

      logger.debug('Google Drive search complete', { userId, count: allFiles.length });
      return allFiles;

    } catch (error) {
      const apiError = error.response ? error.response.data : error.message;
      logger.error(`Error searching Google Drive: ${JSON.stringify({
        userId,
        query,
        error: apiError
      })}`);

      throw error;
    }
  }
}

module.exports = UserGoogleDrive;