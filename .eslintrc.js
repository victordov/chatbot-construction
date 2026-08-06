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
        bootstrap: 'readonly',
        marked: 'readonly',
        logger: 'readonly',
        escapeHtml: 'readonly',
        renderMarkdown: 'readonly',
        formatRelativeTime: 'readonly',
        debounce: 'readonly',
        showToast: 'readonly',
        showNotification: 'readonly',
        setLoading: 'readonly',
        // Cross-file helpers: the dashboard loads admin_parts/*.js as plain
        // scripts sharing one global scope rather than as modules.
        viewChatHistory: 'readonly',
        loadOperators: 'readonly',
        loadTaskDetails: 'readonly',
        loadAllOperators: 'readonly',
        showTaskList: 'readonly',
        setupNotifications: 'readonly',
        setupWidgetSection: 'readonly',
        setupBillingSection: 'readonly',
        setupAnalytics: 'readonly',
        setupAssistantSection: 'readonly',
        setupOperatorTools: 'readonly',
        setupContacts: 'readonly',
        openContactById: 'readonly',
        displayRating: 'readonly',
        renderConversationTags: 'readonly',
        setupRouting: 'readonly',
        applyTagFilter: 'readonly',
        setupAudit: 'readonly',
        lastAnalyticsData: 'readonly',
        setConversationNotes: 'readonly',
        applyChatFilter: 'readonly',
        resizeChartsIn: 'readonly',
        initializeAnalyticsCharts: 'readonly',
        updateChatVolumeChart: 'readonly',
        updateResponseTimeChart: 'readonly',
        removeChatFromList: 'readonly',
        updateActiveChatCount: 'readonly',
        displayUserContactInfo: 'readonly',
        loadChatMessages: 'readonly',
        addChatToList: 'readonly',
        addMessageToChat: 'readonly',
        resetChatView: 'readonly',
        updateChatOperatorStatus: 'readonly',
        updateChatUserName: 'readonly',
        notifyNewChat: 'readonly',
        calculateDuration: 'readonly',
        sendOperatorMessage: 'readonly',
        saveSettings: 'readonly',
        loadChatHistory: 'readonly',
        loadTasks: 'readonly',
        getUrlParams: 'readonly',
        updateUrlWithParams: 'readonly',
        setupSuggestionEventHandlers: 'readonly',
        setupTaskManagement: 'readonly',
        setupContactInfoManagement: 'readonly',
        setupEventHandlers: 'readonly',
        setupConnectionHandlers: 'readonly',
        startHeartbeat: 'readonly',
        initializeCharts: 'readonly',
        loadDashboardData: 'readonly',
        loadActiveChats: 'readonly',
        displaySuggestion: 'readonly',
        loadTasksForConversation: 'readonly',
        getActivityIcon: 'readonly',
        editTaskFromDetails: 'readonly',
        saveTask: 'readonly',
        openTaskModal: 'readonly',
        updateConnectionStatus: 'readonly'
      }
    }
  ]
};
