/**
 * The installable operator app (P2C): the manifest, the service worker as
 * the server sends it and as it behaves, the icons and the dashboard's links
 * to them.
 *
 * The headers are read from the real server.js, as the CSP suite does, so
 * they are the ones production sends. The service worker is run in a vm
 * with a stand-in for the browser's worker globals.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.PORT = '0';

const publicDir = path.join(__dirname, '..', 'public');
const workerSource = fs.readFileSync(path.join(publicDir, 'admin', 'sw.js'), 'utf8');

describe('Operator app (P2C)', () => {
  describe('as served', () => {
    let app;
    let server;

    beforeAll(async () => {
      ({ app, server } = require('../server'));
      if (!server.listening) {
        await new Promise(resolve => server.once('listening', resolve));
      }
    });

    afterAll(async () => {
      delete process.env.PRODUCT_NAME;
      await new Promise(resolve => server.close(resolve));
      await mongoose.connection.close(false);
    });

    test('the service worker is served uncached, scoped to the dashboard', async () => {
      const response = await request(app).get('/admin/sw.js');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/javascript/);
      expect(response.headers['service-worker-allowed']).toBe('/admin/');
      expect(response.headers['cache-control']).toBe('no-cache');
    });

    test('the policy lets the dashboard register its worker and read its manifest', async () => {
      const csp = (await request(app).get('/admin/')).headers['content-security-policy'];
      const directive = name => {
        const match = csp.split(';').map(part => part.trim()).find(part => part.startsWith(`${name} `));
        return match ? match.slice(name.length + 1).split(/\s+/) : null;
      };

      // worker-src falls back to script-src, manifest-src to default-src.
      expect(directive('worker-src') || directive('script-src')).toContain("'self'");
      expect(directive('manifest-src') || directive('default-src')).toContain("'self'");
    });

    test('the manifest carries the product name and opens on the live chats', async () => {
      process.env.PRODUCT_NAME = 'Front Desk Pro';
      const response = await request(app).get('/admin/manifest.webmanifest');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/manifest\+json/);
      const manifest = JSON.parse(response.text);
      expect(manifest).toMatchObject({
        name: 'Front Desk Pro',
        short_name: 'Front',
        start_url: '/admin/?section=active-chats',
        scope: '/admin/',
        display: 'standalone'
      });
      expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);

      const sizes = purpose => manifest.icons.filter(icon => icon.purpose === purpose).map(icon => icon.sizes);
      expect(sizes('any')).toEqual(expect.arrayContaining(['192x192', '512x512']));
      expect(sizes('maskable')).toEqual(expect.arrayContaining(['192x192', '512x512']));
    });

    test('a short product name is used whole', async () => {
      delete process.env.PRODUCT_NAME;
      const manifest = JSON.parse((await request(app).get('/admin/manifest.webmanifest')).text);
      expect(manifest.name).toBe('Support Desk');
      expect(manifest.short_name).toBe('Support Desk');
    });

    test('every icon is a PNG of the size it claims', async () => {
      const manifest = JSON.parse((await request(app).get('/admin/manifest.webmanifest')).text);
      const icons = [
        ...manifest.icons,
        { src: '/admin/icons/apple-touch-icon.png', sizes: '180x180' },
        { src: '/admin/icons/badge-96.png', sizes: '96x96' }
      ];

      for (const icon of icons) {
        const response = await request(app).get(icon.src).buffer(true);
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe('image/png');
        const body = response.body;
        expect(body.subarray(1, 4).toString('ascii')).toBe('PNG');
        // IHDR: width and height straight after the chunk header.
        expect(`${body.readUInt32BE(16)}x${body.readUInt32BE(20)}`).toBe(icon.sizes);
      }
    });

    test('the offline page needs no script and says what is going on', async () => {
      const response = await request(app).get('/admin/offline.html');
      expect(response.status).toBe(200);
      expect(response.text).toMatch(/You're offline/);
      expect(response.text).toMatch(/Conversations will appear when you reconnect/);
      expect(response.text).not.toMatch(/<script/i);
    });

    test('the dashboard links its manifest, theme colour and home-screen icon', () => {
      const html = fs.readFileSync(path.join(publicDir, 'admin', 'index.html'), 'utf8');
      expect(html).toContain('<link rel="manifest" href="/admin/manifest.webmanifest">');
      expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}">/i);
      expect(html).toContain('<link rel="apple-touch-icon" href="/admin/icons/apple-touch-icon.png">');
    });
  });

  // ------------------------------------------------------- the worker itself

  describe('the service worker', () => {
    /**
     * Load sw.js against stand-ins for what a browser gives a worker, and
     * hand back its event listeners and the stand-ins to inspect.
     */
    function loadWorker({ userAgent = 'Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile Safari/537.36', windows = [], network } = {}) {
      const listeners = {};
      const cached = new Map([['/admin/offline.html', { offline: true }]]);
      const shown = [];
      const opened = [];

      const self = {
        location: { origin: 'https://desk.example' },
        navigator: { userAgent },
        addEventListener: (type, handler) => {
          listeners[type] = handler;
        },
        skipWaiting: async () => {},
        clients: {
          matchAll: async () => windows,
          claim: async () => {},
          openWindow: async url => {
            opened.push(url);
          }
        },
        registration: {
          showNotification: async (title, options) => {
            shown.push({ title, ...options });
          }
        }
      };

      const context = vm.createContext({
        self,
        URL,
        Request: class {
          constructor(url) {
            this.url = url;
          }
        },
        fetch: network || (async () => {
          throw new TypeError('offline');
        }),
        caches: {
          open: async () => ({ add: async () => {}, put: async () => {} }),
          keys: async () => [],
          delete: async () => true,
          match: async key => cached.get(typeof key === 'string' ? key : new URL(key.url).pathname)
        }
      });
      vm.runInContext(workerSource, context);

      /** Fire an event, returning what it waited on or responded with. */
      const fire = async (type, init) => {
        let waited;
        let responded = null;
        const event = {
          ...init,
          waitUntil: promise => {
            waited = promise;
          },
          respondWith: promise => {
            responded = promise;
          }
        };
        listeners[type](event);
        await waited;
        return { responded: responded && await responded };
      };

      return { fire, shown, opened };
    }

    const dashboardWindow = (overrides = {}) => ({
      url: 'https://desk.example/admin/?section=home',
      focused: false,
      visibilityState: 'hidden',
      focus: jest.fn(async () => {}),
      postMessage: jest.fn(),
      ...overrides
    });

    const pushEvent = data => ({ data: { json: () => data, text: () => JSON.stringify(data) } });

    test('never touches the API or the socket', async () => {
      const { fire } = loadWorker();
      for (const url of ['https://desk.example/api/chat/history', 'https://desk.example/socket.io/?EIO=4']) {
        const { responded } = await fire('fetch', { request: { method: 'GET', url, mode: 'cors' } });
        expect(responded).toBeNull();
      }
    });

    test('a dashboard page that cannot be reached becomes the offline page', async () => {
      const { fire } = loadWorker();
      const { responded } = await fire('fetch', {
        request: { method: 'GET', url: 'https://desk.example/admin/?section=active-chats', mode: 'navigate' }
      });
      expect(responded).toEqual({ offline: true });
    });

    test('shows a push, tagged, with where to go', async () => {
      const { fire, shown } = loadWorker({ windows: [dashboardWindow()] });
      await fire('push', pushEvent({
        title: 'Bea asked for a person',
        body: 'Tap to open the conversation.',
        tag: 'handoff:s1',
        url: '/admin/?section=active-chats&chat=s1'
      }));

      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({
        title: 'Bea asked for a person',
        tag: 'handoff:s1',
        silent: false,
        data: { url: '/admin/?section=active-chats&chat=s1' }
      });
    });

    test('keeps quiet while the dashboard is in front, except for a test', async () => {
      const focused = dashboardWindow({ focused: true, visibilityState: 'visible' });
      const { fire, shown } = loadWorker({ windows: [focused] });

      await fire('push', pushEvent({ title: 'New chat', tag: 'new-chat:s2' }));
      expect(shown).toHaveLength(0);

      await fire('push', pushEvent({ title: 'Notifications are on', tag: 'test', always: true }));
      expect(shown).toHaveLength(1);
    });

    test('on Safari it still shows one, silently, so the subscription is not taken away', async () => {
      const focused = dashboardWindow({ focused: true, visibilityState: 'visible' });
      const { fire, shown } = loadWorker({
        windows: [focused],
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
      });

      await fire('push', pushEvent({ title: 'New chat', tag: 'new-chat:s3' }));
      expect(shown).toHaveLength(1);
      expect(shown[0].silent).toBe(true);
    });

    test('a tap moves an open dashboard to the conversation, without reloading it', async () => {
      const open = dashboardWindow();
      const { fire, opened } = loadWorker({ windows: [open] });
      const notification = { close: jest.fn(), data: { url: '/admin/?section=active-chats&chat=s4' } };

      await fire('notificationclick', { notification });

      expect(notification.close).toHaveBeenCalled();
      expect(open.focus).toHaveBeenCalled();
      expect(open.postMessage).toHaveBeenCalledWith({ type: 'open-link', url: '/admin/?section=active-chats&chat=s4' });
      expect(opened).toEqual([]);
    });

    test('a tap with no dashboard open opens one, and never anywhere else', async () => {
      const { fire, opened } = loadWorker({ windows: [{ url: 'https://desk.example/admin/login.html', focused: false }] });

      await fire('notificationclick', { notification: { close: () => {}, data: { url: '/admin/?section=active-chats&chat=s5' } } });
      await fire('notificationclick', { notification: { close: () => {}, data: { url: 'https://evil.example/phish' } } });

      expect(opened).toEqual(['/admin/?section=active-chats&chat=s5', '/admin/']);
    });
  });

  // ------------------------------------------------------------- the scripts

  describe('the deployer\'s scripts', () => {
    test('generate-vapid-keys makes a P-256 pair in the form web-push takes', () => {
      const { generate, subjectFrom } = require('../scripts/generate-vapid-keys');
      const { publicKey, privateKey } = generate();

      expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65);
      expect(Buffer.from(privateKey, 'base64url')).toHaveLength(32);
      expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(subjectFrom('ops@example.com')).toBe('mailto:ops@example.com');
      expect(subjectFrom('https://example.com/contact')).toBe('https://example.com/contact');
    });
  });
});
