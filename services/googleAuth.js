const crypto = require('crypto');
const { google } = require('googleapis');
const GoogleToken = require('../models/googleToken');

// How long a consent screen may sit open before the callback is refused.
const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret() {
  return process.env.JWT_SECRET || 'chatbot-jwt-secret';
}

function stateSignature(userId, issuedAt) {
  return crypto.createHmac('sha256', stateSecret())
    .update(`${userId}.${issuedAt}`)
    .digest('hex');
}

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

  /**
   * The OAuth `state` for a user: who started the flow, when, and a signature
   * over both.
   *
   * The state used to be the bare user id. Google hands it back untouched, so
   * anyone who could reach the callback URL could name any user id and attach
   * their own Google account to that person's login - after which every
   * spreadsheet import that user ran read from the attacker's Drive.
   */
  signState(userId) {
    const issuedAt = Date.now();
    return `${userId}.${issuedAt}.${stateSignature(userId, issuedAt)}`;
  }

  /**
   * The user id a state was issued for, or null when it was not issued by us
   * within the last ten minutes.
   */
  verifyState(state) {
    if (typeof state !== 'string') {
      return null;
    }

    const parts = state.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [userId, issuedAtText, signature] = parts;
    const issuedAt = Number(issuedAtText);

    if (!userId || !Number.isFinite(issuedAt)) {
      return null;
    }

    if (issuedAt > Date.now() || Date.now() - issuedAt > STATE_TTL_MS) {
      return null;
    }

    const expected = Buffer.from(stateSignature(userId, issuedAt), 'hex');
    const given = Buffer.from(signature, 'hex');

    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      return null;
    }

    return userId;
  }

  generateAuthUrl(userId) {
    if (!this.isConfigured) {
      throw new Error('Google OAuth is not configured');
    }

    const state = this.signState(userId);
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

  /**
   * Exchange the callback for tokens and store them against the user the
   * state names. Verified before the exchange, so a forged state costs
   * nothing and stores nothing.
   */
  async handleOAuthCallback(state, code) {
    if (!this.isConfigured) {
      throw new Error('Google OAuth is not configured');
    }

    const userId = this.verifyState(state);
    if (!userId) {
      const error = new Error('Invalid or expired OAuth state');
      error.code = 'INVALID_STATE';
      throw error;
    }

    const client = this.createOAuthClient();
    const { tokens } = await client.getToken(code);
    await this.saveTokens(userId, tokens);
    return userId;
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

    // Refresh when the token is expired, about to expire, or has no recorded
    // expiry at all. The previous `token.expiryDate && ...` guard skipped the
    // refresh for an expiryDate of 0, so an already-dead token was handed back
    // and the next Google API call failed with a 401.
    const REFRESH_SKEW_MS = 60 * 1000;
    if (!token.expiryDate || token.expiryDate <= Date.now() + REFRESH_SKEW_MS) {
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
