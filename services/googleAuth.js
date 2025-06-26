const { google } = require('googleapis');
const GoogleToken = require('../models/googleToken');

class GoogleAuthService {
  constructor() {
    this.clientId = process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    this.redirectUri = process.env.GOOGLE_REDIRECT_URI;
    
    // Validate that required environment variables are set
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      console.warn('Google OAuth environment variables not configured. Google features will be disabled.');
      this.isConfigured = false;
    } else {
      this.isConfigured = true;
    }
  }

  createOAuthClient() {
    if (!this.isConfigured) {
      throw new Error('Google OAuth is not configured. Please set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI environment variables.');
    }
    
    return new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirectUri
    );
  }

  generateAuthUrl(state) {
    if (!this.isConfigured) {
      throw new Error('Google OAuth is not configured');
    }
    
    const client = this.createOAuthClient();
    const scopes = [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email'
    ];
    return client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
      state
    });
  }

  async handleOAuthCallback(userId, code) {
    if (!this.isConfigured) {
      throw new Error('Google OAuth is not configured');
    }
    
    const client = this.createOAuthClient();
    const { tokens } = await client.getToken(code);
    await this.saveTokens(userId, tokens);
  }

  async saveTokens(userId, tokens) {
    const data = {
      accessToken: tokens.access_token || tokens.accessToken,
      refreshToken: tokens.refresh_token || tokens.refreshToken,
      scope: tokens.scope,
      tokenType: tokens.token_type || tokens.tokenType,
      expiryDate: tokens.expiry_date || tokens.expiryDate,
      userId
    };

    const saved = await GoogleToken.findOneAndUpdate(
      { userId },
      data,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return saved;
  }

  async getOAuthClient(userId) {
    const token = await GoogleToken.findOne({ userId });
    if (!token) {
      throw new Error('Google token not found');
    }

    const client = this.createOAuthClient();
    client.setCredentials({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      scope: token.scope,
      token_type: token.tokenType,
      expiry_date: token.expiryDate
    });

    client.on('tokens', async (tokens) => {
      if (tokens.access_token || tokens.refresh_token) {
        await this.saveTokens(userId, tokens);
      }
    });

    // Refresh if expired
    if (token.expiryDate && token.expiryDate <= Date.now()) {
      await client.getAccessToken();
    }

    return client;
  }

  async hasTokens(userId) {
    const token = await GoogleToken.findOne({ userId });
    return !!token;
  }

  async getUserEmail(userId) {
    const client = await this.getOAuthClient(userId);
    const oauth2 = google.oauth2({ auth: client, version: 'v2' });
    const res = await oauth2.userinfo.get();
    return res.data.email;
  }

  isGoogleConfigured() {
    return this.isConfigured;
  }
}

module.exports = GoogleAuthService;
