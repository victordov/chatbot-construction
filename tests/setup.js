/**
 * Per-suite test environment. Provides the configuration that production reads
 * from `.env` so services do not bail out with "not configured" errors.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// Every suite connects to MONGODB_TEST_URI and clears the collections it
// uses. Jest runs suites in parallel workers, so two suites on the same
// database race: one suite's `deleteMany({})` empties another's fixtures, and
// a shared username collides on a unique index. Give each worker its own
// database name on the same server; suites in one worker run one at a time.
const withWorkerDatabase = (uri) => {
  if (!uri || !process.env.JEST_WORKER_ID) {
    return uri;
  }
  const parsed = new URL(uri);
  const base = parsed.pathname.replace(/^\//, '') || 'chatbot_test';
  parsed.pathname = `/${base}_w${process.env.JEST_WORKER_ID}`;
  return parsed.toString();
};

if (process.env.MONGODB_TEST_URI) {
  process.env.MONGODB_TEST_URI = withWorkerDatabase(process.env.MONGODB_TEST_URI);
  process.env.MONGODB_URI = process.env.MONGODB_TEST_URI;
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-value-for-tests-only';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-value';

// Google OAuth is mocked in the unit tests, but the service refuses to build a
// client unless these are present.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/google/oauth2callback';

// Never call a real model from the test suite. Loading `.env` (which config
// and several services do) would otherwise pick up a live key and make tests
// slow, flaky and billable. Suites that exercise the AI path mock it directly.
process.env.OPENAI_API_KEY = '';

// Keep background jobs out of the test run.
process.env.ALERTS_ENABLED = 'false';
process.env.EMAIL_ALERTS_ENABLED = 'false';
process.env.BACKUPS_ENABLED = 'false';
