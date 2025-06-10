/**
 * Chatbot Widget Loader
 * This script is designed to be embedded on client websites
 * and will load the chatbot widget dynamically.
 */

(function() {
  // Configuration to be passed from the embedding script
  const defaultConfig = {
    serverUrl: 'http://localhost:3000',
    chatbotName: 'Assistant',
    primaryColor: '#2196f3',
    position: 'right' // 'right' or 'left'
  };

  // Extract configuration from the script tag
  function extractConfig() {
    const scripts = document.getElementsByTagName('script');
    const currentScript = scripts[scripts.length - 1];

    // Get data attributes
    const config = { ...defaultConfig };

    if (currentScript.getAttribute('data-server-url')) {
      config.serverUrl = currentScript.getAttribute('data-server-url');
    }

    if (currentScript.getAttribute('data-chatbot-name')) {
      config.chatbotName = currentScript.getAttribute('data-chatbot-name');
    }

    if (currentScript.getAttribute('data-primary-color')) {
      config.primaryColor = currentScript.getAttribute('data-primary-color');
    }

    if (currentScript.getAttribute('data-position')) {
      config.position = currentScript.getAttribute('data-position');
    }

    if (currentScript.getAttribute('data-initial-message')) {
      config.initialMessage = currentScript.getAttribute('data-initial-message');
    }

    return config;
  }

  // Load the widget script
  function loadWidgetScript(config) {
    const script = document.createElement('script');
    script.src = `${config.serverUrl}/widget/js/widget.js`;
    script.onload = function() {
      // Initialize the widget once loaded
      if (window.ChatbotWidget) {
        window.ChatbotWidget.init(config);
      } else {
        console.error('Chatbot Widget failed to load properly');
      }
    };
    script.onerror = function() {
      console.error('Failed to load Chatbot Widget script');
    };

    document.body.appendChild(script);
  }

  // Main initialization
  function init() {
    const config = extractConfig();

    // Check if the script is being loaded after the DOM is ready
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      // DOM already ready, load the widget
      loadWidgetScript(config);
    } else {
      // Wait for DOM to be ready
      document.addEventListener('DOMContentLoaded', function() {
        loadWidgetScript(config);
      });
    }
  }

  // Start initialization
  init();
})();
