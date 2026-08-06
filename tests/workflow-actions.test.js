/**
 * Workflow action nodes.
 *
 * Most of these tests are about the two things that make calling a tenant's API
 * from our server dangerous: reaching somewhere it should not, and bringing
 * back more than was asked for.
 */

const http = require('http');
const dns = require('dns');

const actions = require('../services/workflow-actions');
const secrets = require('../services/secrets');
const WorkflowCompilerService = require('../services/workflow-compiler');

describe('address filtering', () => {
  test.each([
    ['127.0.0.1', 'loopback'],
    ['10.4.5.6', 'private class A'],
    ['172.16.0.1', 'private class B'],
    ['172.31.255.254', 'top of the private class B range'],
    ['192.168.1.1', 'private class C'],
    ['169.254.169.254', 'cloud instance metadata'],
    ['100.100.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['fd00::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4 loopback written as IPv6']
  ])('%s is blocked (%s)', address => {
    expect(actions.isBlockedAddress(address)).toBe(true);
  });

  test.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111'])(
    '%s is allowed',
    address => {
      expect(actions.isBlockedAddress(address)).toBe(false);
    }
  );

  test('172.15 and 172.32 sit outside the private range', () => {
    // The boundaries of 172.16.0.0/12, which is the range people get wrong.
    expect(actions.isBlockedAddress('172.15.255.255')).toBe(false);
    expect(actions.isBlockedAddress('172.32.0.0')).toBe(false);
  });

  test('anything that is not an IP is refused rather than guessed at', () => {
    expect(actions.isBlockedAddress('example.com')).toBe(true);
    expect(actions.isBlockedAddress('')).toBe(true);
  });
});

describe('URL validation', () => {
  test('https is accepted', () => {
    expect(actions.validateUrl('https://api.example.com/orders/12').valid).toBe(true);
  });

  test('http is refused, because the API key would travel in clear text', () => {
    const result = actions.validateUrl('http://api.example.com/orders');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/https/);
  });

  test('other schemes are refused', () => {
    expect(actions.validateUrl('file:///etc/passwd').valid).toBe(false);
    expect(actions.validateUrl('ftp://example.com').valid).toBe(false);
    expect(actions.validateUrl('gopher://example.com').valid).toBe(false);
  });

  test('a private address typed directly is refused before any request', () => {
    const result = actions.validateUrl('https://169.254.169.254/latest/meta-data/');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/private or reserved/);
  });

  test('nonsense is refused with something an admin can act on', () => {
    expect(actions.validateUrl('api.example.com').error).toMatch(/full URL/);
  });
});

describe('templating', () => {
  test('placeholders are filled from the run variables', () => {
    expect(actions.fill('Hello {{name}}', { name: 'Jordan' })).toBe('Hello Jordan');
  });

  test('nested and indexed paths resolve', () => {
    const variables = { order: { items: [{ sku: 'A1' }] } };
    expect(actions.fill('{{order.items.0.sku}}', variables)).toBe('A1');
  });

  test('a missing variable becomes empty rather than the literal placeholder', () => {
    expect(actions.fill('id={{missing}}', {})).toBe('id=');
  });

  test('URL values are encoded, so a visitor cannot bolt on query parameters', () => {
    // Without encoding this would append &admin=true to the tenant's API call.
    const filled = actions.fill('https://api.example.com/search?q={{q}}', {
      q: 'shoes&admin=true'
    }, true);
    expect(filled).toBe('https://api.example.com/search?q=shoes%26admin%3Dtrue');
  });

  test('a path segment cannot be escaped', () => {
    const filled = actions.fill('https://api.example.com/orders/{{id}}', {
      id: '../../admin/keys'
    }, true);
    expect(filled).toBe('https://api.example.com/orders/..%2F..%2Fadmin%2Fkeys');
  });
});

describe('secrets at rest', () => {
  beforeAll(() => {
    process.env.SECRETS_KEY = 'test-secrets-key-for-the-suite';
    secrets.resetForTests();
  });

  test('a value round-trips', () => {
    const encrypted = secrets.encrypt('sk-live-abcdef');
    expect(encrypted).not.toContain('sk-live');
    expect(secrets.decrypt(encrypted)).toBe('sk-live-abcdef');
  });

  test('encrypting twice does not double-wrap', () => {
    const once = secrets.encrypt('token');
    expect(secrets.encrypt(once)).toBe(once);
  });

  test('two encryptions of the same value differ', () => {
    // A fresh IV each time, so an observer cannot tell that two nodes share a
    // credential.
    expect(secrets.encrypt('token')).not.toBe(secrets.encrypt('token'));
  });

  test('a tampered ciphertext fails to decrypt rather than returning something', () => {
    const encrypted = secrets.encrypt('token');
    const tampered = `${encrypted.slice(0, -4)}AAAA`;
    expect(secrets.decrypt(tampered)).toBeNull();
  });

  test('a value from before encryption existed is passed through', () => {
    expect(secrets.decrypt('plain-old-key')).toBe('plain-old-key');
  });
});

describe('executing an action', () => {
  let server;
  let base;
  let received;

  beforeAll(done => {
    // Plain HTTP against localhost, which is what the address guard exists to
    // block - so the test replaces the guard rather than weakening it.
    process.env.ACTIONS_ALLOW_HTTP = 'true';
    process.env.SECRETS_KEY = 'test-secrets-key-for-the-suite';
    secrets.resetForTests();

    actions.__setLookupForTests((hostname, options, callback) =>
      dns.lookup(hostname, options, callback));

    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        received = {
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8')
        };

        if (req.url.startsWith('/order')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({
            data: { order: { status: 'shipped', eta: '2026-08-11' } },
            customer: { email: 'jordan@example.com' }
          }));
        }

        if (req.url === '/slow') {
          return setTimeout(() => res.end('{}'), 2000);
        }

        if (req.url === '/huge') {
          res.writeHead(200);
          // Deliberately larger than the read limit.
          return res.end('x'.repeat(actions.MAX_RESPONSE_BYTES + 1024));
        }

        if (req.url === '/redirect-to-metadata') {
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
          return res.end();
        }

        if (req.url === '/text') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end('OK, all good');
        }

        res.writeHead(500);
        res.end('{"error":"boom"}');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      base = `http://localhost:${server.address().port}`;
      done();
    });
  });

  afterAll(done => {
    actions.__setLookupForTests(null);
    delete process.env.ACTIONS_ALLOW_HTTP;
    server.close(done);
  });

  test('a successful call exposes only the mapped fields', async () => {
    const result = await actions.execute({
      url: `${base}/order/{{order_id}}`,
      method: 'GET',
      outputs: [
        { variable: 'order_status', path: 'data.order.status' },
        { variable: 'eta', path: 'data.order.eta' }
      ]
    }, { order_id: 'A-1001' });

    expect(result.ok).toBe(true);
    expect(result.variables).toEqual({ order_status: 'shipped', eta: '2026-08-11' });

    // The response also contained a customer email. Nothing asked for it, so it
    // never reaches the conversation.
    expect(JSON.stringify(result.variables)).not.toContain('jordan@example.com');
  });

  test('the URL placeholder is filled', async () => {
    await actions.execute({ url: `${base}/order/{{order_id}}` }, { order_id: 'A-1001' });
    expect(received.url).toBe('/order/A-1001');
  });

  test('a mapping that finds nothing yields its fallback, not undefined', async () => {
    const result = await actions.execute({
      url: `${base}/order/1`,
      outputs: [{ variable: 'missing', path: 'data.nope.deeper', fallback: 'unknown' }]
    }, {});

    expect(result.variables.missing).toBe('unknown');
  });

  test('$body reaches a response that is not JSON', async () => {
    const result = await actions.execute({
      url: `${base}/text`,
      outputs: [{ variable: 'reply', path: '$body' }]
    }, {});

    expect(result.ok).toBe(true);
    expect(result.variables.reply).toBe('OK, all good');
  });

  test('a POST sends the rendered body', async () => {
    await actions.execute({
      url: `${base}/order/new`,
      method: 'POST',
      body: '{"question": "{{user_input}}"}'
    }, { user_input: 'where is my order' });

    expect(received.method).toBe('POST');
    expect(JSON.parse(received.body)).toEqual({ question: 'where is my order' });
    expect(received.headers['content-type']).toBe('application/json');
  });

  test('a bearer credential is decrypted and sent', async () => {
    await actions.execute({
      url: `${base}/order/1`,
      auth: { type: 'bearer', value: secrets.encrypt('sk-live-123') }
    }, {});

    expect(received.headers.authorization).toBe('Bearer sk-live-123');
  });

  test('a custom header credential is sent under the configured name', async () => {
    await actions.execute({
      url: `${base}/order/1`,
      auth: { type: 'header', header: 'x-shop-key', value: secrets.encrypt('abc123') }
    }, {});

    expect(received.headers['x-shop-key']).toBe('abc123');
  });

  test('an undecryptable credential fails the call rather than calling without it', async () => {
    // Sending the request unauthenticated would look to the tenant like their
    // API rejecting us, which is a much harder thing to diagnose.
    const result = await actions.execute({
      url: `${base}/order/1`,
      auth: { type: 'bearer', value: 'enc:v1:bad:bad:bad' }
    }, {});

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credential/i);
  });

  test('a User-Agent is always sent, and a tenant can override it', async () => {
    // Some APIs reject an anonymous client outright; GitHub's is one.
    await actions.execute({ url: `${base}/order/1` }, {});
    expect(received.headers['user-agent']).toMatch(/chatbot-platform/);

    await actions.execute({
      url: `${base}/order/1`,
      headers: { 'User-Agent': 'HarbourlineBot/2.0' }
    }, {});
    expect(received.headers['user-agent']).toBe('HarbourlineBot/2.0');
  });

  test('a header a tenant must not set is dropped', async () => {
    await actions.execute({
      url: `${base}/order/1`,
      headers: { Host: 'evil.example.com', 'X-Fine': 'yes' }
    }, {});

    expect(received.headers.host).not.toBe('evil.example.com');
    expect(received.headers['x-fine']).toBe('yes');
  });

  test('a non-2xx response is a failure, not a success with an error body', async () => {
    const result = await actions.execute({ url: `${base}/broken` }, {});

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.variables).toEqual({});
  });

  test('a slow API times out instead of holding the conversation open', async () => {
    const result = await actions.execute({ url: `${base}/slow`, timeoutMs: 1000 }, {});

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not respond/);
  });

  test('an oversized response is refused rather than buffered', async () => {
    const result = await actions.execute({ url: `${base}/huge` }, {});

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/more data/);
  });

  test('a redirect to the metadata service is refused', async () => {
    // The single most valuable SSRF target: following this would hand a tenant
    // the instance's cloud credentials.
    const result = await actions.execute({ url: `${base}/redirect-to-metadata` }, {});

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/redirect/i);
  });

  test('an unsupported method is refused before any request', async () => {
    const result = await actions.execute({ url: `${base}/order/1`, method: 'TRACE' }, {});

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an allowed method/);
  });

  test('a failure never throws, so the workflow can branch on it', async () => {
    await expect(actions.execute({ url: 'https://nothing.invalid/x' }, {}))
      .resolves.toMatchObject({ ok: false });
  });
});

describe('the address guard is what blocks localhost', () => {
  beforeAll(() => {
    process.env.ACTIONS_ALLOW_HTTP = 'true';
  });
  afterAll(() => {
    delete process.env.ACTIONS_ALLOW_HTTP;
  });

  test('a hostname that resolves to loopback is refused at connect time', async () => {
    // `localhost` passes URL validation - it is not an IP literal - so this is
    // the guarded lookup doing its job, which is the same code path that stops
    // a DNS name from resolving to a private address after the fact.
    const result = await actions.execute({ url: 'http://localhost:1/x' }, {});

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private or reserved/);
  });
});

describe('action nodes in a workflow', () => {
  const compiler = new WorkflowCompilerService();

  const persona = { id: 'p1', type: 'persona', position: { x: 0, y: 0 }, data: { prompt: 'Be helpful' } };
  const start = { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} };

  test('a valid action node compiles', () => {
    const nodes = [persona, start, {
      id: 'a1', type: 'action', position: { x: 0, y: 0 },
      data: { label: 'Order lookup', url: 'https://api.example.com/orders/{{order_id}}', method: 'GET' }
    }];
    const edges = [{ id: 'e1', source: 's1', target: 'a1' }];

    expect(compiler.validateWorkflow(nodes, edges).valid).toBe(true);
  });

  test('a private URL is caught at design time, not at run time', () => {
    const nodes = [persona, start, {
      id: 'a1', type: 'action', position: { x: 0, y: 0 },
      data: { label: 'Sneaky', url: 'http://169.254.169.254/latest/meta-data/' }
    }];
    const result = compiler.validateWorkflow(nodes, [{ id: 'e1', source: 's1', target: 'a1' }]);

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/Sneaky/);
  });

  test('a URL with placeholders still validates', () => {
    const nodes = [persona, start, {
      id: 'a1', type: 'action', position: { x: 0, y: 0 },
      data: { url: 'https://api.example.com/{{tenant}}/orders/{{order_id}}' }
    }];

    expect(compiler.validateWorkflow(nodes, [{ id: 'e1', source: 's1', target: 'a1' }]).valid).toBe(true);
  });

  test('an action may branch, unlike most nodes', () => {
    const nodes = [persona, start,
      { id: 'a1', type: 'action', position: { x: 0, y: 0 }, data: { url: 'https://api.example.com/x' } },
      { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { template: 'Status: {{order_status}}' } },
      { id: 'r2', type: 'response', position: { x: 0, y: 0 }, data: { template: 'Sorry, try later' } }
    ];
    const edges = [
      { id: 'e1', source: 's1', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'r1', sourceHandle: 'success' },
      { id: 'e3', source: 'a1', target: 'r2', sourceHandle: 'error' }
    ];

    expect(compiler.validateWorkflow(nodes, edges).valid).toBe(true);
  });

  test('leaving the failure path unconnected warns but does not block', () => {
    const nodes = [persona, start,
      { id: 'a1', type: 'action', position: { x: 0, y: 0 }, data: { label: 'Lookup', url: 'https://api.example.com/x' } },
      { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { template: 'ok' } }
    ];
    const edges = [
      { id: 'e1', source: 's1', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'r1', sourceHandle: 'success' }
    ];

    const result = compiler.validateWorkflow(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/Failed output/);
  });

  test('a body that is not JSON is rejected', () => {
    const nodes = [persona, start, {
      id: 'a1', type: 'action', position: { x: 0, y: 0 },
      data: { label: 'Broken', url: 'https://api.example.com/x', method: 'POST', body: 'not json at all' }
    }];

    const result = compiler.validateWorkflow(nodes, [{ id: 'e1', source: 's1', target: 'a1' }]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/not valid JSON/);
  });

  test('a body containing placeholders is accepted', () => {
    const nodes = [persona, start, {
      id: 'a1', type: 'action', position: { x: 0, y: 0 },
      data: { url: 'https://api.example.com/x', method: 'POST', body: '{"q": "{{user_input}}"}' }
    }];

    expect(compiler.validateWorkflow(nodes, [{ id: 'e1', source: 's1', target: 'a1' }]).valid).toBe(true);
  });

  test('an action with no URL is rejected', () => {
    const nodes = [persona, start, { id: 'a1', type: 'action', position: { x: 0, y: 0 }, data: { label: 'Empty' } }];

    const result = compiler.validateWorkflow(nodes, [{ id: 'e1', source: 's1', target: 'a1' }]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/needs the URL/);
  });
});

describe('branching on the result', () => {
  const compiler = new WorkflowCompilerService();

  const step = handles => ({
    next: handles.map(h => ({ target: `to-${h}`, handle: h }))
  });

  test('success takes the success branch', () => {
    expect(compiler.resolveActionTarget(step(['success', 'error']), true)).toBe('to-success');
  });

  test('failure takes the error branch', () => {
    expect(compiler.resolveActionTarget(step(['success', 'error']), false)).toBe('to-error');
  });

  test('failure with no error branch ends the walk', () => {
    // Better a fallback answer than continuing down the success path and
    // telling the customer their order shipped when nothing was looked up.
    expect(compiler.resolveActionTarget(step(['success']), false)).toBeNull();
  });

  test('a single unlabelled output is followed on success only', () => {
    const single = { next: [{ target: 'next', handle: null }] };
    expect(compiler.resolveActionTarget(single, true)).toBe('next');
    expect(compiler.resolveActionTarget(single, false)).toBeNull();
  });
});

describe('running a workflow that contains an action', () => {
  let server;
  let base;

  beforeAll(done => {
    process.env.ACTIONS_ALLOW_HTTP = 'true';
    actions.__setLookupForTests((hostname, options, callback) =>
      dns.lookup(hostname, options, callback));

    server = http.createServer((req, res) => {
      if (req.url === '/fail') {
        res.writeHead(503);
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'shipped', tracking: 'TRK-9' }));
    });

    server.listen(0, '127.0.0.1', () => {
      base = `http://localhost:${server.address().port}`;
      done();
    });
  });

  afterAll(done => {
    actions.__setLookupForTests(null);
    delete process.env.ACTIONS_ALLOW_HTTP;
    server.close(done);
  });

  /** Build a compiled chain by hand, the shape the executor consumes. */
  const chain = url => ({
    tenantId: 'tenant-1',
    entryPoint: 'a1',
    prompts: { moderation: { enabled: false } },
    knowledge: { sources: [] },
    routing: { conditions: [], fallback: null },
    steps: {
      a1: {
        type: 'action',
        data: {
          label: 'Order lookup',
          url,
          outputs: [
            { variable: 'order_status', path: 'status' },
            { variable: 'tracking', path: 'tracking' }
          ]
        },
        next: [
          { target: 'ok', handle: 'success' },
          { target: 'bad', handle: 'error' }
        ]
      },
      ok: {
        type: 'response',
        data: { template: 'Your order is {{order_status}} — tracking {{tracking}}.' },
        next: []
      },
      bad: {
        type: 'response',
        data: { template: 'I could not reach our order system just now.' },
        next: []
      }
    }
  });

  test('the API result reaches the reply the visitor sees', async () => {
    const compiler = new WorkflowCompilerService();
    const result = await compiler.executeWorkflow(chain(`${base}/orders/1`), 'where is my order?');

    expect(result.response).toBe('Your order is shipped — tracking TRK-9.');
    expect(result.metadata.path).toEqual(['a1', 'ok']);
    expect(result.metadata.actions[0]).toMatchObject({ label: 'Order lookup', ok: true });
  });

  test('a failing API takes the error branch rather than answering with blanks', async () => {
    const compiler = new WorkflowCompilerService();
    const result = await compiler.executeWorkflow(chain(`${base}/fail`), 'where is my order?');

    expect(result.response).toBe('I could not reach our order system just now.');
    expect(result.metadata.actions[0]).toMatchObject({ ok: false, status: 503 });
  });
});

describe('credentials never cross back to the browser', () => {
  const { redactWorkflow, protectNodeSecrets } = require('../services/workflow');

  beforeAll(() => {
    process.env.SECRETS_KEY = 'test-secrets-key-for-the-suite';
    secrets.resetForTests();
  });

  const nodeWith = auth => ({
    id: 'a1', type: 'action', position: { x: 0, y: 0 },
    data: { label: 'Lookup', url: 'https://api.example.com/x', auth }
  });

  test('a new credential is encrypted before it is stored', () => {
    const [node] = protectNodeSecrets([nodeWith({ type: 'bearer', value: 'sk-live-999' })]);

    expect(node.data.auth.value).not.toContain('sk-live-999');
    expect(secrets.decrypt(node.data.auth.value)).toBe('sk-live-999');
  });

  test('saving without re-entering the credential keeps the stored one', () => {
    const [stored] = protectNodeSecrets([nodeWith({ type: 'bearer', value: 'sk-live-999' })]);

    // What the editor sends back: it never had the value to send.
    const [updated] = protectNodeSecrets(
      [nodeWith({ type: 'bearer', hasSecret: true })],
      [stored]
    );

    expect(secrets.decrypt(updated.data.auth.value)).toBe('sk-live-999');
  });

  test('turning authentication off drops the stored credential', () => {
    const [stored] = protectNodeSecrets([nodeWith({ type: 'bearer', value: 'sk-live-999' })]);
    const [updated] = protectNodeSecrets([nodeWith({ type: 'none' })], [stored]);

    expect(updated.data.auth.value).toBeUndefined();
  });

  test('a workflow sent to the editor reports that a secret exists, not what it is', () => {
    const [stored] = protectNodeSecrets([nodeWith({ type: 'bearer', value: 'sk-live-999' })]);
    const redacted = redactWorkflow({ nodes: [stored] });

    expect(redacted.nodes[0].data.auth).toEqual({
      type: 'bearer', header: undefined, hasSecret: true
    });
    expect(JSON.stringify(redacted)).not.toContain('sk-live-999');
    expect(JSON.stringify(redacted)).not.toContain(stored.data.auth.value);
  });

  test('the compiled chain is redacted too', () => {
    // The compiled chain embeds a copy of every node's data, so redacting the
    // nodes alone would hand the same secret straight back by another route.
    const [stored] = protectNodeSecrets([nodeWith({ type: 'bearer', value: 'sk-live-999' })]);
    const ciphertext = stored.data.auth.value;

    const redacted = redactWorkflow({
      nodes: [stored],
      compiledChain: { steps: { a1: { type: 'action', data: stored.data } } }
    });

    expect(redacted.compiledChain.steps.a1.data.auth.hasSecret).toBe(true);
    expect(JSON.stringify(redacted.compiledChain)).not.toContain(ciphertext);
  });

  test('the credential is redacted wherever it sits, not only where expected', () => {
    // The stored compiled chain nests the node data under
    // `compilationResult.executionPlan` and `compilationResult.compiledChain`.
    // Redacting only the shapes we thought of let the ciphertext straight out.
    const [stored] = protectNodeSecrets([nodeWith({ type: 'bearer', value: 'sk-live-999' })]);
    const ciphertext = stored.data.auth.value;

    const redacted = redactWorkflow({
      nodes: [stored],
      compiledChain: {
        compilationResult: {
          executionPlan: { nodes: [{ id: 'a1', data: stored.data }] },
          compiledChain: { steps: { a1: { data: stored.data } } }
        }
      }
    });

    expect(JSON.stringify(redacted)).not.toContain(ciphertext);
    expect(JSON.stringify(redacted)).not.toContain('sk-live-999');
    expect(redacted.compiledChain.compilationResult.executionPlan.nodes[0].data.auth)
      .toEqual({ type: 'bearer', header: undefined, hasSecret: true });
  });

  test('redacting does not strip the credential from the workflow being saved', () => {
    // The argument is normally a live mongoose document whose Mixed paths are
    // shared with what the caller saves next. Editing them here removed the
    // credential from the stored workflow, and the next call went out
    // unauthenticated.
    const [stored] = protectNodeSecrets([nodeWith({ type: 'bearer', value: 'sk-live-999' })]);
    const chain = { steps: { a1: { type: 'action', data: stored.data } } };

    redactWorkflow({ nodes: [stored], compiledChain: chain });

    expect(secrets.decrypt(stored.data.auth.value)).toBe('sk-live-999');
    expect(secrets.decrypt(chain.steps.a1.data.auth.value)).toBe('sk-live-999');
  });
});
