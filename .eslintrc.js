module.exports = {
  env: {
    node: true,
    commonjs: true,
    es2021: true,
    jest: true
  },
  extends: 'eslint:recommended',
  parserOptions: {
    ecmaVersion: 12
  },
  rules: {
    'indent': ['error', 2],
    'linebreak-style': ['error', 'unix'],
    // `avoidEscape` permits double quotes only where the string itself contains
    // a single quote. The identity-verification code samples are exactly that:
    // escaping them would leave customers copying \' out of the dashboard.
    'quotes': ['error', 'single', { avoidEscape: true }],
    'semi': ['error', 'always'],
    'no-unused-vars': ['warn'],
    'no-console': ['warn', { allow: ['error', 'warn', 'info'] }],
    'curly': ['error'],
    'eqeqeq': ['error'],
    'no-trailing-spaces': ['error'],
    'comma-dangle': ['error', 'never'],
    'brace-style': ['error', '1tbs'],
    'no-var': ['error'],
    'prefer-const': ['warn'],
    'no-multiple-empty-lines': ['error', { max: 2 }]
  },
  ignorePatterns: [
    'node_modules/',
    'coverage/',
    'dist/',
    '.claude/',
    '*.min.js'
  ],
  overrides: [
    {
      // The widget: plain browser scripts with no build step, because it is
      // embedded on other people's sites.
      files: ['public/**/*.js'],
      env: {
        browser: true,
        node: false
      },
      globals: {
        io: 'readonly'
      }
    },
    {
      // The dashboard, login page and workflow editor: ES modules bundled by
      // scripts/build-client.js. Every cross-file name is an import, so
      // no-undef catches a reference to something that no longer exists.
      files: ['client/**/*.js'],
      env: {
        browser: true,
        node: false,
        es2022: true
      },
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        // Served by the socket.io server itself, so its version always
        // matches; loaded as a classic script before the bundle.
        io: 'readonly'
      },
      rules: {
        'no-undef': 'error'
      }
    }
  ]
};
