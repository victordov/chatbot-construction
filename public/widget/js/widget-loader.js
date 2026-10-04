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
   * Where the widget's server is, when the snippet does not say.
   *
   * The loader was fetched from somewhere, and that somewhere is the server:
   * a snippet with `data-server-url` dropped still works. There is no
   * localhost fallback - a production embed pointing at a developer's laptop
   * is a widget that silently does nothing.
   */
  function inferredServerUrl() {
    if (ownScript && ownScript.src) {
      try {
        return new URL(ownScript.src, window.location.href).origin;
      } catch (error) {
        // Fall through.
      }
    }
    return window.location.origin;
  }

  /** "true"/"false"/"1"/"0"/"yes"/"no" -> boolean, or null when unparseable. */
  function parseBoolean(value) {
    if (value === null || value === undefined) {
      return null;
    }
    const normalised = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'required'].includes(normalised)) {
      return true;
    }
    if (['false', '0', 'no', 'off', 'optional'].includes(normalised)) {
      return false;
    }
    return null;
  }

  /**
   * Read only the attributes the site author actually set.
   * @returns {{overrides: object, serverUrl: string, widgetKey: string|null}}
   */
  function extractConfig() {
    const overrides = {};
    let serverUrl = inferredServerUrl();
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

    // A signed identity, for sites where the visitor is logged in. The hash is
    // computed on the tenant's server; without it the id is ignored, so a
    // visitor cannot claim to be someone else by editing the page.
    if (attr('data-user-id')) {
      overrides.externalId = attr('data-user-id');
    }
    if (attr('data-user-hash')) {
      overrides.userHash = attr('data-user-hash');
    }

    if (attr('data-server-url')) {
      serverUrl = attr('data-server-url').replace(/\/+$/, '');
    }

    const map = {
      'data-chatbot-name': 'chatbotName',
      'data-primary-color': 'primaryColor',
      'data-position': 'position',
      'data-initial-message': 'initialMessage',
      'data-privacy-policy-url': 'privacyPolicyUrl'
    };

    Object.keys(map).forEach(function(attribute) {
      if (attr(attribute)) {
        overrides[map[attribute]] = attr(attribute);
      }
    });

    // Which details the pre-chat form asks for. Strings on the tag, booleans
    // in the config.
    const flags = {
      'data-require-name': 'requireName',
      'data-require-email': 'requireEmail',
      'data-require-phone': 'requirePhone'
    };

    Object.keys(flags).forEach(function(attribute) {
      const parsed = parseBoolean(attr(attribute));
      if (parsed !== null) {
        overrides[flags[attribute]] = parsed;
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
        if (s.privacyPolicyUrl) {
          settings.privacyPolicyUrl = s.privacyPolicyUrl;
        }
        ['requireName', 'requireEmail', 'requirePhone'].forEach(function(key) {
          if (typeof s[key] === 'boolean') {
            settings[key] = s[key];
          }
        });

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
      script.async = true;

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

      document.head.appendChild(script);
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
