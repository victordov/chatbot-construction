/**
 * Globals shared by the dashboard scripts.
 *
 * admin_parts/*.js are loaded as plain scripts in one global scope, and the
 * helpers below are defined once in admin-utils.js. Declared here, next to
 * the code that uses them, so the root config need not change every time a
 * helper is added.
 */
module.exports = {
  globals: {
    authToken: 'readonly',
    setAuthToken: 'readonly',
    getStoredUser: 'readonly',
    setStoredUser: 'readonly',
    authHeaders: 'readonly',
    parseJsonResponse: 'readonly',
    errorMessage: 'readonly',
    api: 'readonly',
    logout: 'readonly',
    setupAccountSettings: 'readonly'
  }
};
