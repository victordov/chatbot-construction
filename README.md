# Chatbot Construction Application

## Getting Started

This guide explains how to run the application, what needs to be configured, and where to find configuration files.

---

## 1. Prerequisites
- **Node.js** (v18 or higher recommended)
- **npm** (comes with Node.js)
- **MongoDB** (local or remote instance)
  - Alternatively, you can use Docker to run MongoDB (see [Docker Setup](docs/DOCKER.md))

---

## 2. Installation
1. Clone the repository:
   ```sh
   git clone <your-repo-url>
   cd chatbot-construction
   ```
2. Install dependencies:
   ```sh
   npm install
   ```

---

## 3. Configuration

All configuration is managed via environment variables. You can set these in a `.env` file in the project root or via your deployment environment.

### Required Environment Variables
- `PORT` - Port for the server (default: 3000)
- `MONGODB_URI` - MongoDB connection string
- `JWT_SECRET` - Secret for JWT authentication
- `GOOGLE_CLIENT_ID` - Google API client ID (for Google Drive integration)
- `GOOGLE_CLIENT_SECRET` - Google API client secret
- `GOOGLE_REDIRECT_URI` - Google OAuth2 redirect URI (e.g. `http://localhost:3000/api/google/oauth2callback`)
- `GOOGLE_REFRESH_TOKEN` - Google OAuth2 refresh token (optional, legacy)
- `EMAIL_HOST` - SMTP host (for alerting)
- `EMAIL_PORT` - SMTP port
- `EMAIL_USER` - SMTP username
- `EMAIL_PASS` - SMTP password
- `ADMIN_EMAIL` - Email address for admin alerts

Create a `.env` file like this:
```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/chatbot
JWT_SECRET=your_jwt_secret
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/oauth2callback
GOOGLE_REFRESH_TOKEN=your_google_refresh_token
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_USER=your_email_user
EMAIL_PASS=your_email_password
ADMIN_EMAIL=admin@example.com
```

---

## 4. Running the Application

Start the server:
```sh
npm start
```

The server will run on the port specified in your `.env` file (default: 3000).

---

## 5. Features & Endpoints
- **Frontend widget**: Embeddable via `public/widget/js/widget-loader.js`.
- **Admin dashboard**: Available at `/admin`.
- **API endpoints**: See `routes/` for available endpoints (chat, session, admin, auth, gdpr, operations).
- **Google knowledge import**: Connect your Google account from the admin dashboard to load spreadsheet data as knowledge documents.
- **Monitoring**: Prometheus metrics at `/metrics`.

---

## 6. Multi-tenant Architecture

The application supports a multi-tenant architecture with the following roles:

- **Superadmin**: Can manage all companies, create company admins, and view all data.
- **Company Admin**: Can manage operators within their company and view data related to their company.
- **Operator**: Can handle chats assigned to them within their company.

### Migration from Single-tenant to Multi-tenant

If you're upgrading from a previous version, you'll need to run the migration script to update existing admin users to superadmins:

```sh
node migrate-admin-users.js
```

This script will find all users with the role 'admin' and update them to 'superadmin'.

### Creating a Superadmin

To create the first superadmin user:

```sh
node create-admin.js
```

This will create a superadmin user with the default credentials (username: admin, password: Admin123!).

---

## 7. Additional Notes
- **Static files** are served from the `public/` directory.
- **Logs** are stored in the `logs/` directory.
- **Backups** are stored in the `backups/` directory.
- **Widget versions** are managed in the `widget-versions/` directory.

---

## 8. Testing
Run all tests with:
```sh
npm test
```

---

## 9. Troubleshooting
- Ensure all required environment variables are set.
- Check `logs/` for error logs.
- MongoDB must be running and accessible.
  - If using Docker, ensure containers are running with `docker-compose ps`.
  - See [Docker Setup](docs/DOCKER.md) for Docker-specific troubleshooting.
- For Google Drive and email features, ensure credentials are valid.

---

For further details, see the documentation in the `docs/` directory.
