/**
 * The loader on a customer's page.
 *
 * Run in a VM with just enough of a document for it to read its own tag,
 * fetch the config and load the widget, so what is checked is what a real
 * page gets: the config is fetched without cookies (the server sends no
 * Access-Control-Allow-Credentials for a page trusted by its key alone, and a
 * credentialed fetch would fail outright), the tenant's new settings reach the
 * widget, an attribute on the tag still wins, and `ChatWidget` can be called
 * before the widget has arrived.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LOADER = path.join(__dirname, '..', 'public', 'widget', 'js', 'widget-loader.js');

/**
 * Run the loader with these snippet attributes and this config response.
 * Resolves with the fetch it made and the config the widget was started with.
 */
function runLoader(attributes, remote) {
  return new Promise(resolve => {
    const fetches = [];
    const window = {
      location: { href: 'https://shop.example/', origin: 'https://shop.example' }
    };
    const ownScript = {
      src: 'https://chat.example/widget/js/widget-loader.js',
      getAttribute: name => (Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null)
    };
    const document = {
      currentScript: ownScript,
      readyState: 'complete',
      getElementsByTagName: () => [ownScript],
      addEventListener: () => {},
      createElement: () => ({}),
      head: {
        appendChild: script => {
          // The widget script "loads": it publishes its API and the loader
          // starts it.
          window.ChatbotWidget = {
            init: config => resolve({ fetches, config, window })
          };
          script.onload();
        }
      }
    };
    const fetch = (url, options) => {
      fetches.push({ url, options });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(remote) });
    };

    vm.runInNewContext(fs.readFileSync(LOADER, 'utf8'), {
      window, document, fetch, URL, console, Promise
    });
  });
}

const REMOTE = {
  recognised: true,
  companyName: 'Bloom Dental',
  settings: {
    chatbotName: 'Assistant',
    primaryColor: '#123456',
    position: 'left',
    welcomeMessage: 'Welcome to Bloom',
    language: 'auto',
    requireName: false,
    requireEmail: false,
    requirePhone: false,
    privacyPolicyUrl: null,
    suggestedQuestions: ['Do you take new patients?', '', 'Where are you?', 'Prices?', 'Parking?', 'Fifth'],
    consentRequired: true,
    consentText: 'I agree to Bloom storing this chat.',
    proactive: { enabled: true, text: 'Need a check-up?', delaySeconds: 10, pathContains: null }
  },
  availability: { open: true, canReachOperator: false },
  features: { fileUploads: false },
  assets: { 'widget/js/widget.js': '/widget/js/widget.abcdef12.js' }
};

describe('widget loader', () => {
  it('fetches the config without credentials', async () => {
    const { fetches } = await runLoader({ 'data-widget-key': 'wk_bloom' }, REMOTE);
    expect(fetches).toHaveLength(1);
    expect(fetches[0].url).toBe('https://chat.example/api/widget/config?key=wk_bloom');
    expect(fetches[0].options.credentials).toBe('omit');
  });

  it('hands the widget the business, questions, consent, proactive message and plan features', async () => {
    const { config } = await runLoader({ 'data-widget-key': 'wk_bloom' }, REMOTE);

    expect(config.businessName).toBe('Bloom Dental');
    expect(config.suggestedQuestions).toEqual(['Do you take new patients?', 'Where are you?', 'Prices?', 'Parking?']);
    expect(config.consentRequired).toBe(true);
    expect(config.consentText).toBe('I agree to Bloom storing this chat.');
    expect(config.proactive).toEqual(REMOTE.settings.proactive);
    expect(config.features).toEqual({ fileUploads: false });
    expect(config.availability.canReachOperator).toBe(false);
    expect(config.requireName).toBe(false);
    expect(config.serverUrl).toBe('https://chat.example');
    expect(config.widgetKey).toBe('wk_bloom');
  });

  it('lets an attribute on the tag override the dashboard, as documented', async () => {
    const { config } = await runLoader({
      'data-widget-key': 'wk_bloom',
      'data-primary-color': '#ff0000',
      'data-dir': 'rtl'
    }, REMOTE);
    expect(config.primaryColor).toBe('#ff0000');
    expect(config.position).toBe('left');
    expect(config.dir).toBe('rtl');
  });

  it('defines ChatWidget straight away and queues what the page asks of it', async () => {
    const { window } = await runLoader({ 'data-widget-key': 'wk_bloom' }, REMOTE);
    const standIn = window.ChatWidget;

    expect(Array.isArray(standIn._queue)).toBe(true);
    standIn.identify({ userId: 'u-1', userHash: 'h' });
    standIn.on('message', () => {});
    standIn.open();
    expect(standIn._queue.map(call => call[0])).toEqual(['identify', 'on', 'open']);
  });
});

describe('the snippet the dashboard hands out', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'admin', 'widget.js'), 'utf8');
  const snippetFunction = source.slice(source.indexOf('function snippet()'), source.indexOf('function hostOf('));

  it('carries only the script, the key and the server', () => {
    expect(snippetFunction).toContain('widget-loader.js');
    expect(snippetFunction).toContain('data-widget-key');
    expect(snippetFunction).toContain('data-server-url');
    ['data-chatbot-name', 'data-primary-color', 'data-position'].forEach(attribute => {
      expect(snippetFunction).not.toContain(attribute);
    });
  });
});
