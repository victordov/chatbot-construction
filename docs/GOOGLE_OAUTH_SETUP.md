# Google OAuth Setup Guide

## Overview
This application includes Google OAuth integration for accessing Google Sheets and Google Drive. This feature is optional and the application will work without it, but Google-related features will be disabled.

## Setting Up Google OAuth (Optional)

### 1. Create a Google Cloud Project
1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the following APIs:
   - Google Sheets API
   - Google Drive API
   - Google OAuth2 API

### 2. Create OAuth 2.0 Credentials
1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth 2.0 Client IDs"
3. Choose "Web application" as the application type
4. Add authorized redirect URIs:
   - `http://localhost:3000/api/google/auth/callback` (for development)
   - `https://yourdomain.com/api/google/auth/callback` (for production)

### 3. Configure Environment Variables
Add the following variables to your `.env` file:

```bash
# Google OAuth Configuration
GOOGLE_CLIENT_ID=your-google-client-id-here
GOOGLE_CLIENT_SECRET=your-google-client-secret-here
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/auth/callback
```

For production, update the `GOOGLE_REDIRECT_URI` to match your domain.

### 4. Download Service Account Key (Optional)
If you need server-to-server authentication for certain features:
1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "Service Account"
3. Download the JSON key file
4. Store it securely and reference it in your application if needed

## Features Enabled by Google OAuth

When Google OAuth is configured, the following features become available:

- **Google Sheets Integration**: Import spreadsheets as knowledge documents
- **Google Drive Search**: Search for spreadsheets in user's Google Drive
- **Knowledge Management**: Store and refresh Google Sheets data
- **Document Synchronization**: Keep local copies in sync with Google Sheets

## Error Handling

If Google OAuth is not configured:
- The application will start normally with a warning message
- Google-related API endpoints will return HTTP 503 (Service Unavailable)
- Frontend features that depend on Google integration will be disabled
- Users will see appropriate messages indicating the feature is unavailable

## Testing the Setup

1. Start the application with Google OAuth configured
2. Log in to the admin panel
3. Look for Google integration options in the interface
4. Try connecting your Google account
5. Test importing a Google Sheet as a knowledge document

## Troubleshooting

### "Could not determine client ID from request"
- Check that `GOOGLE_CLIENT_ID` is correctly set in `.env`
- Ensure the client ID matches the one from Google Cloud Console
- Verify there are no extra spaces or characters in the environment variable

### "Redirect URI mismatch"
- Ensure `GOOGLE_REDIRECT_URI` matches the authorized redirect URIs in Google Cloud Console
- Check that the protocol (http/https) and port numbers match exactly

### "Access denied"
- Verify that the required APIs are enabled in Google Cloud Console
- Check that the OAuth consent screen is properly configured
- Ensure the user has permission to access the requested resources

## Security Considerations

- Keep your Google Client Secret secure and never expose it in client-side code
- Use HTTPS in production
- Regularly rotate your OAuth credentials
- Implement proper scope restrictions to limit access to only what's needed
- Monitor OAuth token usage and revoke unused tokens

## Production Deployment

For production:
1. Update `GOOGLE_REDIRECT_URI` to use your production domain
2. Configure OAuth consent screen for external users if needed
3. Set up proper domain verification in Google Cloud Console
4. Use environment-specific client IDs and secrets
5. Implement proper logging and monitoring for OAuth flows
