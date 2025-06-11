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
    'quotes': ['error', 'single'],
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
    '*.min.js'
  ],
  overrides: [
    {
      files: [
        'public/**/*.js',
        'widget-versions/**/*.js'
      ],
      env: {
        browser: true,
        node: false
      },
      globals: {
        io: 'readonly',
        nacl: 'readonly',
        Chart: 'readonly',
        EncryptionUtil: 'readonly',
        feather: 'readonly',
        bootstrap: 'readonly'
      }
    }
  ]
};
