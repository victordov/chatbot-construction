/**
 * The connector: the SDK a tenant implements, and the platform half that calls
 * it.
 *
 * The most valuable tests here run both halves against each other. A contract
 * where each side is tested against its own idea of the contract is a contract
 * that drifts; these use the real SDK handler over real HTTP, so a change to
 * either side that breaks the agreement fails here.
 */

const http = require('http');
const dns = require('dns');
const mongoose = require('mongoose');

const Company = require('../models/company');
const connector = require('../services/connector');
const contract = require('../config/capabilities');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const { createConnector, verifySignature } = require('../sdk');

describe('Connector', () => {
  let acme;
  let server;
  let base;
  let secret;
  let calls;
  let behaviour;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    process.env.SECRETS_KEY = 'test-secrets-key-for-the-suite';
    secrets.resetForTests();

    process.env.ACTIONS_ALLOW_HTTP = 'true';
    safeHttp.__setLookupForTests((hostname, options, callback) =>
      dns.lookup(hostname, options, callback));

    secret = connector.generateSecret();

    // A tenant's connector, written the way the README tells them to.
    const handler = createConnector({
      async searchCatalog({ query, limit }) {
        calls.push({ capability: 'catalog.search', query, limit });

        if (behaviour.throw) {
          throw new Error('the product database is down');
        }
        if (behaviour.malformed) {
          return [{ title: 'No id on this one' }];
        }
        if (behaviour.empty) {
          return [];
        }

        return [
          {
            id: 'p1', title: 'Waterproof pannier', price: '£49.99',
            image: 'https://shop.example/p1.jpg', url: 'https://shop.example/p1',
            inStock: true,
            // A field we have no use for. Dropped rather than passed through.
            internalCostPrice: 22.5
          },
          // A price as a number and a Date, which is what real code returns.
          { id: 2, title: 'Rack strap', price: 7.5 }
        ];
      },

      async getProduct({ id }) {
        calls.push({ capability: 'catalog.get', id });
        return { id, title: 'Waterproof pannier', price: '£49.99' };
      },

      async listSlots({ service }) {
        calls.push({ capability: 'availability.slots', service });
        return [
          { id: 's1', startsAt: new Date('2026-09-03T14:30:00Z'), staff: 'Priya' },
          { id: 's2', startsAt: '2026-09-03T16:00:00Z' }
        ];
      },

      async bookSlot({ slotId, name }) {
        calls.push({ capability: 'availability.book', slotId, name });
        return { id: 'b1', startsAt: '2026-09-03T14:30:00Z', reference: 'BK-1', status: 'confirmed' };
      }
    }, { secret });

    await new Promise(resolve => {
      server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        base = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    acme = await Company.create({
      name: 'Connector Acme',
      connector: {
        enabled: true,
        url: base,
        secret: secrets.encrypt(secret),
        capabilities: ['catalog.search', 'catalog.get', 'availability.slots', 'availability.book']
      }
    });
  });

  afterAll(async () => {
    safeHttp.__setLookupForTests(null);
    delete process.env.ACTIONS_ALLOW_HTTP;
    await new Promise(resolve => server.close(resolve));
    await Company.deleteMany({ name: /^Connector / });
  });

  beforeEach(() => {
    calls = [];
    behaviour = {};
    connector.clearCache();
  });

  describe('the two halves agree', () => {
    test('a search reaches the tenant\'s method and comes back shaped', async () => {
      const result = await connector.call(acme._id, 'catalog.search', { query: 'pannier' });

      expect(result.ok).toBe(true);
      expect(calls[0]).toMatchObject({ capability: 'catalog.search', query: 'pannier' });
      expect(result.value[0]).toEqual({
        id: 'p1',
        title: 'Waterproof pannier',
        price: '£49.99',
        image: 'https://shop.example/p1.jpg',
        url: 'https://shop.example/p1',
        inStock: true
      });
    });

    test('fields we have no use for are dropped, not passed on', async () => {
      // Otherwise arbitrary business data ends up in a model's context and a
      // stored transcript, which is what we avoid everywhere else.
      const result = await connector.call(acme._id, 'catalog.search', { query: 'pannier' });

      expect(JSON.stringify(result.value)).not.toContain('internalCostPrice');
      expect(JSON.stringify(result.value)).not.toContain('22.5');
    });

    test('a number where a string was expected is absorbed, not rejected', async () => {
      // An id or a price arriving as a number is the commonest thing a
      // connector gets "wrong"; refusing it would be pedantry.
      const result = await connector.call(acme._id, 'catalog.search', { query: 'strap' });

      expect(result.value[1]).toMatchObject({ id: '2', price: '7.5' });
    });

    test('a Date is accepted wherever a date is expected', async () => {
      const result = await connector.call(acme._id, 'availability.slots', {});

      expect(result.value[0].startsAt).toBe('2026-09-03T14:30:00.000Z');
      expect(result.value[1].startsAt).toBe('2026-09-03T16:00:00.000Z');
    });

    test('discovery reports what was implemented', async () => {
      const result = await connector.discover(base);

      expect(result.ok).toBe(true);
      expect(result.capabilities.sort()).toEqual([
        'availability.book', 'availability.slots', 'catalog.get', 'catalog.search'
      ]);
      expect(result.signed).toBe(true);
    });
  });

  describe('proving the call is ours', () => {
    test('an unsigned request is refused by the SDK', async () => {
      const response = await fetch(`${base}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability: 'catalog.search', input: { query: 'x' } })
      });

      expect(response.status).toBe(401);
      expect((await response.json()).error).toMatch(/not signed/);
    });

    test('a wrong signature is refused', async () => {
      const body = JSON.stringify({ capability: 'catalog.search', input: { query: 'x' } });
      const response = await fetch(`${base}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-connector-signature': connector.sign(body, 'the-wrong-secret', Math.floor(Date.now() / 1000))
        },
        body
      });

      expect(response.status).toBe(401);
      expect((await response.json()).error).toMatch(/did not match/);
    });

    test('an old request is refused even with a valid signature', async () => {
      // What stops a captured request working forever.
      const stale = Math.floor(Date.now() / 1000) - 3600;
      const body = JSON.stringify({ capability: 'catalog.search', input: { query: 'x' } });

      const response = await fetch(`${base}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-connector-signature': connector.sign(body, secret, stale)
        },
        body
      });

      expect(response.status).toBe(401);
      expect((await response.json()).error).toMatch(/too old/);
    });

    test('a tampered body invalidates the signature', async () => {
      const signed = JSON.stringify({ capability: 'catalog.search', input: { query: 'x' } });
      const sent = JSON.stringify({ capability: 'catalog.search', input: { query: 'tampered' } });
      const timestamp = Math.floor(Date.now() / 1000);

      const response = await fetch(`${base}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-connector-signature': connector.sign(signed, secret, timestamp)
        },
        body: sent
      });

      expect(response.status).toBe(401);
    });

    test('the SDK verifier agrees with the platform signer', () => {
      const body = '{"a":1}';
      const timestamp = Math.floor(Date.now() / 1000);

      expect(verifySignature(body, connector.sign(body, secret, timestamp), secret).ok).toBe(true);
    });
  });

  describe('when things go wrong', () => {
    test('a method that throws surfaces the tenant\'s own message', async () => {
      // They wrote the code; their message is far more use than a status code.
      behaviour.throw = true;
      const result = await connector.call(acme._id, 'catalog.search', { query: 'x' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/product database is down/);
    });

    test('a mis-shaped response is caught here, not three steps later', async () => {
      behaviour.malformed = true;
      const result = await connector.call(acme._id, 'catalog.search', { query: 'x' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/did not match the contract/);
      expect(result.error).toMatch(/id is required/);
    });

    test('an empty list is a success with nothing in it', async () => {
      behaviour.empty = true;
      const result = await connector.call(acme._id, 'catalog.search', { query: 'x' });

      expect(result.ok).toBe(true);
      expect(result.value).toEqual([]);
    });

    test('a missing required input is refused before the call goes out', async () => {
      const result = await connector.call(acme._id, 'catalog.search', {});

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/query is required/);
      expect(calls).toHaveLength(0);
    });

    test('a capability the connector does not implement is refused', async () => {
      const shop = await Company.create({
        name: 'Connector Shop',
        connector: { enabled: true, url: base, capabilities: ['catalog.search'] }
      });

      const result = await connector.call(shop._id, 'availability.book', { slotId: 's1' });

      expect(result.ok).toBe(false);
      expect(result.notImplemented).toBe(true);
    });

    test('no connector set up is said plainly', async () => {
      const bare = await Company.create({ name: 'Connector Bare' });
      const result = await connector.call(bare._id, 'catalog.search', { query: 'x' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/No connector/);
    });

    test('a connector URL pointing somewhere private is refused', async () => {
      const evil = await Company.create({
        name: 'Connector Evil',
        connector: { enabled: true, url: 'http://169.254.169.254/', capabilities: [] }
      });

      const result = await connector.call(evil._id, 'catalog.search', { query: 'x' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/private or reserved/);
    });

    test('a URL that is not a connector says so usefully', async () => {
      const plain = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>my shop</html>');
      });

      await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
      const result = await connector.discover(`http://localhost:${plain.address().port}`);
      await new Promise(resolve => plain.close(resolve));

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not return JSON|not a connector/);
    });
  });

  describe('previews do not change anything', () => {
    test('a read still runs, because that is what makes a preview useful', async () => {
      const result = await connector.call(
        acme._id, 'catalog.search', { query: 'pannier' }, { simulate: true }
      );

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
    });

    test('a write is declined and reported', async () => {
      // Testing a booking branch six times must not put six appointments in
      // somebody's diary.
      const result = await connector.call(
        acme._id, 'availability.book', { slotId: 's1' }, { simulate: true }
      );

      expect(calls).toHaveLength(0);
      expect(result.simulated[0].description).toMatch(/Book an appointment/);
    });
  });

  describe('not asking twice for the same thing', () => {
    test('a repeated read comes from the cache', async () => {
      await connector.call(acme._id, 'catalog.search', { query: 'pannier' });
      const second = await connector.call(acme._id, 'catalog.search', { query: 'pannier' });

      expect(calls).toHaveLength(1);
      expect(second.cached).toBe(true);
    });

    test('a different question is not served from the cache', async () => {
      await connector.call(acme._id, 'catalog.search', { query: 'pannier' });
      await connector.call(acme._id, 'catalog.search', { query: 'strap' });

      expect(calls).toHaveLength(2);
    });

    test('a write is never cached', async () => {
      await connector.call(acme._id, 'availability.book', { slotId: 's1' });
      await connector.call(acme._id, 'availability.book', { slotId: 's1' });

      expect(calls).toHaveLength(2);
    });
  });

  describe('the contract itself', () => {
    test('a list with one bad row keeps the good ones', () => {
      // One product with a broken image should not hide the other nine.
      const result = contract.validateResult('catalog.search', [
        { id: '1', title: 'Fine' },
        { title: 'No id' },
        { id: '3', title: 'Also fine' }
      ]);

      expect(result.ok).toBe(true);
      expect(result.value).toHaveLength(2);
      expect(result.warnings.join(' ')).toMatch(/id is required/);
    });

    test('a list where every row is bad fails outright', () => {
      const result = contract.validateResult('catalog.search', [{ title: 'No id' }]);
      expect(result.ok).toBe(false);
    });

    test('an enormous list is capped', () => {
      const many = Array.from({ length: 500 }, (_, i) => ({ id: String(i), title: `P${i}` }));
      const result = contract.validateResult('catalog.search', many);

      expect(result.value.length).toBeLessThanOrEqual(25);
      expect(result.truncated).toBe(true);
    });

    test('a broken image URL is reported rather than rendered as a gap', () => {
      const result = contract.validateShape(
        { id: '1', title: 'X', image: 'not a url' }, 'Product'
      );

      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/image is not a valid URL/);
    });

    test('writes are marked as such, which is what preview safety rests on', () => {
      expect(contract.isWrite('availability.book')).toBe(true);
      expect(contract.isWrite('catalog.search')).toBe(false);
    });
  });
});
