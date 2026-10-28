/**
 * The dashboard's live appearance preview (public/widget/preview.html).
 *
 * Settings arrive two ways, both using the same names:
 *
 *   - the query string, on first load or whenever the dashboard changes the
 *     iframe's `src`: ?name=&color=&position=&welcome=&language=&logoUrl=
 *     &requireName=&requireEmail=&requirePhone=&privacyUrl=&business=
 *     &consent=&consentText=&questions=<JSON array>&proactive=<JSON object>
 *   - `postMessage({ type: 'widget-preview', config: { ...same keys } })`
 *     from the dashboard, which re-renders without a reload. Only messages
 *     from this page's own origin are accepted.
 *
 * The first render goes through the real loader, as an embed would, with the
 * settings as `data-*` attributes and `data-preview="true"`; the widget then
 * draws itself without opening a socket or asking the server for anything.
 * Settings an embed cannot carry as attributes (the business name, suggested
 * questions, consent and the proactive message) are applied straight after.
 * A file rather than an inline script, because the CSP forbids inline script.
 */

(function() {
  /** Preview parameter -> loader attribute. */
  const ATTRIBUTES = {
    name: 'data-chatbot-name',
    color: 'data-primary-color',
    position: 'data-position',
    welcome: 'data-initial-message',
    language: 'data-language',
    logoUrl: 'data-logo-url',
    requireName: 'data-require-name',
    requireEmail: 'data-require-email',
    requirePhone: 'data-require-phone',
    privacyUrl: 'data-privacy-policy-url'
  };

  /** Preview parameter -> widget config key, for the postMessage path. */
  const CONFIG_KEYS = {
    name: 'chatbotName',
    color: 'primaryColor',
    position: 'position',
    welcome: 'initialMessage',
    language: 'language',
    logoUrl: 'logoUrl',
    requireName: 'requireName',
    requireEmail: 'requireEmail',
    requirePhone: 'requirePhone',
    privacyUrl: 'privacyPolicyUrl',
    business: 'businessName',
    consent: 'consentRequired',
    consentText: 'consentText',
    questions: 'suggestedQuestions',
    proactive: 'proactive'
  };

  const BOOLEANS = ['requireName', 'requireEmail', 'requirePhone', 'consent'];
  // Structured values: arrays and objects, or the same as JSON in a query string.
  const STRUCTURED = ['questions', 'proactive'];

  function asBoolean(value) {
    return value === true || ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
  }

  function asStructured(value) {
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  /** Preview settings -> widget config, dropping empty values so defaults apply. */
  function toWidgetConfig(settings) {
    const config = {};
    Object.keys(CONFIG_KEYS).forEach(function(key) {
      const value = settings[key];
      if (value === undefined || value === null || value === '') {
        return;
      }
      if (BOOLEANS.includes(key)) {
        config[CONFIG_KEYS[key]] = asBoolean(value);
      } else if (STRUCTURED.includes(key)) {
        const structured = asStructured(value);
        if (structured && typeof structured === 'object') {
          config[CONFIG_KEYS[key]] = structured;
        }
      } else {
        config[CONFIG_KEYS[key]] = String(value);
      }
    });
    if (config.position && config.position !== 'left') {
      config.position = 'right';
    }
    return config;
  }

  function firstRender() {
    const params = new URLSearchParams(window.location.search);
    const script = document.createElement('script');
    script.src = '/widget/js/widget-loader.js';
    script.setAttribute('data-server-url', window.location.origin);
    script.setAttribute('data-preview', 'true');

    const settings = {};
    Object.keys(CONFIG_KEYS).forEach(function(key) {
      const value = params.get(key);
      if (value !== null && value !== '') {
        settings[key] = value;
        if (ATTRIBUTES[key]) {
          script.setAttribute(ATTRIBUTES[key], value);
        }
      }
    });

    document.body.appendChild(script);

    // Everything the attributes could not carry, applied as soon as the
    // widget is drawn.
    const extras = STRUCTURED.concat(['business', 'consent', 'consentText']);
    const needsMore = extras.some(function(key) {
      return settings[key] !== undefined;
    });
    if (needsMore) {
      pending = toWidgetConfig(settings);
      applyPending();
    }
  }

  window.addEventListener('message', function(event) {
    if (event.origin !== window.location.origin) {
      return;
    }
    const data = event.data || {};
    if (data.type !== 'widget-preview' || !data.config || typeof data.config !== 'object') {
      return;
    }
    pending = toWidgetConfig(data.config);
    applyPending();
  });

  // A message can arrive before the loader has finished bringing the widget
  // in; hold the newest one and apply it as soon as the widget is drawn.
  let pending = null;
  let waiting = null;

  function applyPending() {
    const ready = window.ChatbotWidget && typeof window.ChatbotWidget.preview === 'function' &&
      document.getElementById('chatbot-widget-host');
    if (ready) {
      const config = pending;
      pending = null;
      clearInterval(waiting);
      waiting = null;
      window.ChatbotWidget.preview(config);
    } else if (!waiting) {
      waiting = setInterval(applyPending, 100);
    }
  }

  firstRender();
})();
