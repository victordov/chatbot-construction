# Google OAuth setup

Optional. Connecting a Google account lets a dashboard user import a Google
Sheet. Without these settings the application starts normally, logs a warning,
and the Google routes answer HTTP 503; nothing else is affected.

Note what the import currently does: spreadsheet rows are stored as knowledge
*documents* that the assistant does not yet read. Material the bot should
answer from goes in through **Settings → Knowledge Base**.

## 1. Create OAuth credentials

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or
   pick a project and enable the **Google Sheets API** and **Google Drive API**.
2. Configure the OAuth consent screen.
3. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID**
   of type **Web application**.
4. Add the authorised redirect URI. The callback route is
   `/api/google/oauth2callback`:
   - `http://localhost:3000/api/google/oauth2callback` for development
   - `https://your-host/api/google/oauth2callback` for production

   Google compares this string exactly, including scheme and port.

## 2. Configure the application

```bash
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/oauth2callback
```

`GOOGLE_REDIRECT_URI` must match the URI registered in step 1.

For server-to-server access with a service account instead (no user
consent), set `GOOGLE_SERVICE_ACCOUNT_EMAIL` (or `GOOGLE_CLIENT_EMAIL`) and
`GOOGLE_PRIVATE_KEY` (the JSON key's `private_key`, with newlines written as
`\n`), and share the spreadsheet with that account.

## 3. How the flow works

1. A signed-in user calls `GET /api/google/auth/url`. The server builds the
   Google consent URL and carries a **signed `state`** value that ties the
   callback to that user.
2. Google redirects the browser to `/api/google/oauth2callback?code=...&state=...`.
3. The server verifies the `state` signature before exchanging the code, so a
   callback that was not started by the platform, or that was started for a
   different user, is rejected rather than attached to whoever's session it
   lands in. Tokens are then stored for that user.

## Troubleshooting

- **"Redirect URI mismatch"**: `GOOGLE_REDIRECT_URI` and the URI registered in
  Google Cloud differ. Compare scheme, host, port and path character by
  character.
- **503 from `/api/google/...`**: `GOOGLE_CLIENT_ID` is not set.
- **"Invalid OAuth response" or a rejected callback**: the `state` was missing
  or its signature did not verify. Start the flow again from the dashboard
  rather than reusing an old consent URL.
- **"Access denied"**: the APIs are not enabled, the consent screen is not
  configured, or the Google user cannot see the spreadsheet.

## Security

- Keep the client secret out of client-side code and version control.
- Use HTTPS in production; the redirect URI should be `https://`.
- Rotate the credentials if they may have leaked, and use separate client IDs
  per environment.
