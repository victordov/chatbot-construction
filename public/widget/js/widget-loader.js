/**
 * Chatbot Widget Loader
 * This script is designed to be embedded on client websites
 * and will load the chatbot widget dynamically.
 *
 * Configuration is resolved in three layers, later layers winning:
 *
 *   1. built-in defaults
 *   2. the tenant's settings, fetched from the server using the widget key
 *   3. attributes explicitly set on the embed <script> tag
 *
 * Keeping the explicit attributes separate from the defaults matters: merging
 * a fully-populated default object over the server response would mean the
 * tenant's branding never applied, because a default is always present.
 */

(function() {
  const defaultConfig = {
    serverUrl: 'http://localhost:3000',
    chatbotName: 'Assistant',
    primaryColor: '#2196f3',
    position: 'right' // 'right' or 'left'
  };

  // The loader must capture its own <script> element while it is executing.
  // `document.currentScript` is correct even when the tag carries `defer` or
  // `async`; the previous "last script in the document" heuristic picked up
  // whichever script happened to be last, which is wrong for a deferred embed.
  const ownScript = document.currentScript ||
    (function() {
      const scripts = document.getElementsByTagName('script');
      return scripts[scripts.length - 1];
    })();

  /**
   * Read only the attributes the site author actually set.
   * @returns {{overrides: object, serverUrl: string, widgetKey: string|null}}
   */
  function extractConfig() {
    const overrides = {};
    let serverUrl = defaultConfig.serverUrl;
    let widgetKey = null;

    if (!ownScript) {
      return { overrides, serverUrl, widgetKey };
    }

    const attr = name => {
      const value = ownScript.getAttribute(name);
      return value === null || value === '' ? null : value;
    };

    // The widget key identifies the tenant. Without it the server can only
    // guess the company from the page's origin.
    widgetKey = attr('data-widget-key');

    // Default the server URL to wherever this script was loaded from, so a
    // snippet still works if data-server-url is dropped.
    if (attr('data-server-url')) {
      serverUrl = attr('data-server-url');
    } else if (ownScript.src) {
      try {
        serverUrl = new URL(ownScript.src).origin;
      } catch (error) {
        // Keep the default.
      }
    }

    const map = {
      'data-chatbot-name': 'chatbotName',
      'data-primary-color': 'primaryColor',
      'data-position': 'position',
      'data-initial-message': 'initialMessage'
    };

    Object.keys(map).forEach(function(attribute) {
      if (attr(attribute)) {
        overrides[map[attribute]] = attr(attribute);
      }
    });

    return { overrides, serverUrl, widgetKey };
  }

  /**
   * Ask the server which tenant this key belongs to, how the widget should
   * look, and which asset build to load.
   *
   * On failure the widget still loads from the unhashed paths with default
   * branding, so a network blip degrades rather than breaks.
   *
   * @returns {Promise<{settings: object, assets: object}>}
   */
  function fetchTenantSettings(serverUrl, widgetKey) {
    const url = serverUrl + '/api/widget/config' +
      (widgetKey ? '?key=' + encodeURIComponent(widgetKey) : '');

    return fetch(url, { credentials: 'include' })
      .then(function(response) {
        return response.ok ? response.json() : null;
      })
      .then(function(remote) {
        if (!remote) {
          return { settings: {}, assets: {} };
        }

        const s = remote.settings || {};
        const settings = {};
        if (s.chatbotName) {
          settings.chatbotName = s.chatbotName;
        }
        if (s.primaryColor) {
          settings.primaryColor = s.primaryColor;
        }
        if (s.position) {
          settings.position = s.position;
        }
        if (s.welcomeMessage) {
          settings.initialMessage = s.welcomeMessage;
        }

        return {
          settings: settings,
          assets: remote.assets || {},
          // Whether anyone can actually answer right now.
          availability: remote.availability || null
        };
      })
      .catch(function() {
        return { settings: {}, assets: {} };
      });
  }

  /**
   * Fetch config first, then load the widget from the content-hashed URL the
   * server names.
   *
   * The order matters: the config response is what tells us which build to
   * load. Fetching it first costs one round trip but lets the widget bundle
   * itself be cached for a year, instead of being revalidated on every page
   * view of every customer site.
   */
  function loadWidgetScript(parsed) {
    fetchTenantSettings(parsed.serverUrl, parsed.widgetKey).then(function(remote) {
      const assets = remote.assets || {};
      const widgetSrc = parsed.serverUrl +
        (assets['widget/js/widget.js'] || '/widget/js/widget.js');

      const script = document.createElement('script');
      script.src = widgetSrc;

      script.onload = function() {
        if (!window.ChatbotWidget) {
          console.error('Chatbot Widget failed to load properly');
          return;
        }

        // defaults -> tenant settings -> explicit snippet attributes
        const config = Object.assign(
          {},
          defaultConfig,
          remote.settings || {},
          parsed.overrides,
          {
            serverUrl: parsed.serverUrl,
            widgetKey: parsed.widgetKey,
            // Passed through so the widget loads its own dependencies from
            // hashed URLs too.
            assets: assets,
            availability: remote.availability || null
          }
        );

        window.ChatbotWidget.init(config);
      };

      script.onerror = function() {
        console.error('Failed to load Chatbot Widget script');
      };

      document.body.appendChild(script);
    });
  }

  function init() {
    const parsed = extractConfig();

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      loadWidgetScript(parsed);
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        loadWidgetScript(parsed);
      });
    }
  }

  init();
})();
