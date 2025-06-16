// Google Drive API integration service
// This service will handle authentication and file retrieval from Google Drive

const { google } = require('googleapis');
// eslint-disable-next-line no-unused-vars
const path = require('path');
const fs = require('fs');

// Load OAuth2 client credentials from environment variables or a config file
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oAuth2Client });

async function listFiles(query = '', pageSize = 10) {
  const res = await drive.files.list({
    q: query,
    pageSize,
    fields: 'files(id, name, mimeType, modifiedTime)'
  });
  return res.data.files;
}

async function downloadFile(fileId, destPath) {
  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get({
    fileId,
    alt: 'media'
  }, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    res.data
      .on('end', resolve)
      .on('error', reject)
      .pipe(dest);
  });
  return destPath;
}

module.exports = {
  listFiles,
  downloadFile
};
