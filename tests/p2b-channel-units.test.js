/**
 * P2B: the parts of the messaging channels that need no database - webhook
 * signatures, reading Meta's payloads, the reply window, and fitting replies
 * into each app's limits.
 */

const crypto = require('crypto');

const channels = require('../services/channels');
const whatsapp = require('../services/channels/whatsapp');
const messenger = require('../services/channels/messenger');
const outbound = require('../services/channels/outbound');
const { chunkText, bytes } = require('../services/channels/text');
const graph = require('../services/channels/graph');

const sign = (raw, secret) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

describe('P2B: webhook signatures', () => {
  const secret = 'a3f1c2d4e5f60718293a4b5c6d7e8f90';
  // Meta signs an escaped-unicode body; re-serialising the parsed JSON gives
  // different bytes, which is why the raw body has to be kept.
  const raw = Buffer.from('{"object":"page","entry":[{"id":"1","messaging":[{"message":{"text":"caf\\u00e9 \\/ ok"}}]}]}');

  test('accepts the HMAC-SHA256 of the exact bytes under the app secret', () => {
    expect(channels.verifySignature(raw, sign(raw, secret), secret)).toBe(true);
  });

  test('refuses a signature made with another secret', () => {
    expect(channels.verifySignature(raw, sign(raw, 'someone-elses-secret-0000000000'), secret)).toBe(false);
  });

  test('refuses the right secret over re-serialised JSON', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))));
    expect(reserialised.equals(raw)).toBe(false);
    expect(channels.verifySignature(raw, sign(reserialised, secret), secret)).toBe(false);
  });

  test('refuses anything malformed rather than throwing', () => {
    expect(channels.verifySignature(raw, undefined, secret)).toBe(false);
    expect(channels.verifySignature(raw, 'sha1=abc', secret)).toBe(false);
    expect(channels.verifySignature(raw, 'sha256=zz', secret)).toBe(false);
    expect(channels.verifySignature(raw, sign(raw, secret), '')).toBe(false);
    expect(channels.verifySignature(raw.toString(), sign(raw, secret), secret)).toBe(false);
  });

  test('accepts upper-case hex, as some proxies rewrite it', () => {
    const header = sign(raw, secret).replace(/[a-f]/g, letter => letter.toUpperCase()).replace('SHA256', 'sha256');
    expect(channels.verifySignature(raw, header, secret)).toBe(true);
  });
});

describe('P2B: reading WhatsApp webhooks', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '102290129340398',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
          contacts: [{ profile: { name: 'Sheena Nelson' }, wa_id: '16505551234' }],
          messages: [
            { from: '16505551234', id: 'wamid.text', timestamp: '1749416383', type: 'text', text: { body: 'Does it come in another color?' } },
            {
              from: '16505551234', id: 'wamid.button', timestamp: '1750025136', type: 'interactive',
              interactive: { type: 'button_reply', button_reply: { id: 'Opening hours', title: 'Opening hours' } }
            },
            {
              from: '16505551234', id: 'wamid.list', timestamp: '1749854575', type: 'interactive',
              interactive: { type: 'list_reply', list_reply: { id: '__handoff__', title: 'Talk to a person' } }
            },
            {
              from: '16505551234', id: 'wamid.doc', timestamp: '1749854575', type: 'document',
              document: { caption: 'my receipt', filename: 'receipt.pdf', mime_type: 'application/pdf', id: '622684793477189' }
            },
            { from: '16505551234', id: 'wamid.react', timestamp: '1749854575', type: 'reaction', reaction: { message_id: 'x', emoji: '👍' } },
            { from: '16505551234', id: 'wamid.loc', timestamp: '1749854575', type: 'location', location: { latitude: 51.5, longitude: -0.12, name: 'Office' } }
          ],
          statuses: [{
            id: 'wamid.out', status: 'failed', timestamp: '1750263773', recipient_id: '16505551234',
            errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'More than 24 hours' } }]
          }]
        }
      }]
    }]
  };

  test('names the phone number id the payload is for', () => {
    expect(whatsapp.accountKeys(payload)).toEqual([{ provider: 'whatsapp', key: '106540352242922' }]);
    expect(whatsapp.accountKeys({ object: 'page' })).toEqual([]);
  });

  test('reads text, taps, files and places, and skips reactions', () => {
    const events = whatsapp.parse(payload);
    const messages = events.filter(event => event.kind === 'message');

    expect(messages.map(event => event.messageId)).toEqual(['wamid.text', 'wamid.button', 'wamid.list', 'wamid.doc', 'wamid.loc']);
    expect(messages[0]).toMatchObject({
      provider: 'whatsapp', key: '106540352242922', userId: '16505551234',
      profileName: 'Sheena Nelson', phone: '+16505551234', text: 'Does it come in another color?'
    });
    expect(messages[0].timestamp.toISOString()).toBe(new Date(1749416383 * 1000).toISOString());
    expect(messages[1]).toMatchObject({ text: 'Opening hours', choice: 'Opening hours' });
    expect(messages[2]).toMatchObject({ choice: '__handoff__' });
    expect(messages[3]).toMatchObject({
      text: 'my receipt',
      media: { kind: 'document', id: '622684793477189', mimeType: 'application/pdf', fileName: 'receipt.pdf' }
    });
    expect(messages[4]).toMatchObject({ note: true });
    expect(messages[4].text).toContain('https://maps.google.com/?q=');
  });

  test('reads a failed delivery report with its reason', () => {
    const status = whatsapp.parse(payload).find(event => event.kind === 'status');
    expect(status).toMatchObject({ messageId: 'wamid.out', status: 'failed', error: { code: 131047, message: 'More than 24 hours' } });
  });
});

describe('P2B: reading Messenger and Instagram webhooks', () => {
  test('a Page event is Messenger, an Instagram event is Instagram', () => {
    expect(messenger.accountKeys({ object: 'page', entry: [{ id: '111' }] })).toEqual([{ provider: 'messenger', key: '111' }]);
    expect(messenger.accountKeys({ object: 'instagram', entry: [{ id: '222' }] })).toEqual([{ provider: 'instagram', key: '222' }]);
  });

  test('reads text, quick replies, postbacks and attachments, and skips echoes', () => {
    const events = messenger.parse({
      object: 'page',
      entry: [{
        id: 'PAGE',
        time: 1697643211842,
        messaging: [
          { sender: { id: 'PSID' }, recipient: { id: 'PAGE' }, timestamp: 1458692752478, message: { mid: 'm1', text: 'hello, world!' } },
          { sender: { id: 'PSID' }, recipient: { id: 'PAGE' }, timestamp: 1458692752479, message: { mid: 'm2', text: 'Talk to…', quick_reply: { payload: '__handoff__' } } },
          { sender: { id: 'PAGE' }, recipient: { id: 'PSID' }, timestamp: 1458692752480, message: { mid: 'm3', text: 'our reply', is_echo: true } },
          {
            sender: { id: 'PSID' }, recipient: { id: 'PAGE' }, timestamp: 1458692752481,
            message: { mid: 'm4', attachments: [{ type: 'image', payload: { url: 'https://scontent.example/x.jpg' } }] }
          },
          { sender: { id: 'PSID' }, recipient: { id: 'PAGE' }, timestamp: 1458692752482, postback: { mid: 'm5', title: 'Get Started', payload: 'GET_STARTED' } },
          { sender: { id: 'PSID' }, recipient: { id: 'PAGE' }, timestamp: 1458692752483, read: { watermark: 1 } }
        ]
      }]
    });

    expect(events.map(event => event.messageId)).toEqual(['m1', 'm2', 'm4', 'm5']);
    expect(events[0]).toMatchObject({ provider: 'messenger', key: 'PAGE', userId: 'PSID', text: 'hello, world!' });
    expect(events[1]).toMatchObject({ choice: '__handoff__' });
    expect(events[2]).toMatchObject({ media: { kind: 'image', url: 'https://scontent.example/x.jpg' } });
    expect(events[3]).toMatchObject({ text: 'Get Started', choice: 'GET_STARTED' });
  });
});

describe('P2B: the reply window', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const hoursAgo = hours => new Date(now - hours * 60 * 60 * 1000);
  const conversation = (channel, hours) => ({ channel, external: { lastInboundAt: hoursAgo(hours) } });

  test('anything goes within 24 hours of the customer\'s last message', () => {
    const window = channels.windowFor(conversation('whatsapp', 2), { enabled: true }, now);
    expect(window.mode).toBe('open');
    expect(window.until.toISOString()).toBe(new Date(hoursAgo(2).getTime() + 24 * 3600 * 1000).toISOString());
  });

  test('after 24 hours WhatsApp allows the configured template only', () => {
    const withTemplate = channels.windowFor(conversation('whatsapp', 30), { enabled: true, template: { name: 'follow_up' } }, now);
    expect(withTemplate).toMatchObject({ mode: 'template', template: 'follow_up' });
    expect(withTemplate.reason).toMatch(/approved template/);

    const without = channels.windowFor(conversation('whatsapp', 30), { enabled: true }, now);
    expect(without).toMatchObject({ mode: 'template', template: null });
    expect(without.reason).toMatch(/none is set up/);
  });

  test('Messenger and Instagram allow a person for 7 days with the Human Agent tag', () => {
    ['messenger', 'instagram'].forEach(channel => {
      expect(channels.windowFor(conversation(channel, 30), { enabled: true, humanAgentTag: true }, now))
        .toMatchObject({ mode: 'human_agent' });
      const closed = channels.windowFor(conversation(channel, 30), { enabled: true, humanAgentTag: false }, now);
      expect(closed.mode).toBe('closed');
      expect(closed.reason).toMatch(/Human Agent/);
      const tooLate = channels.windowFor(conversation(channel, 8 * 24), { enabled: true, humanAgentTag: true }, now);
      expect(tooLate.mode).toBe('closed');
      expect(tooLate.reason).toMatch(/7 days/);
    });
  });

  test('a disconnected account allows nothing', () => {
    expect(channels.windowFor(conversation('whatsapp', 1), null, now).mode).toBe('closed');
    expect(channels.windowFor(conversation('whatsapp', 1), { enabled: false }, now).mode).toBe('closed');
  });
});

describe('P2B: fitting replies into each app', () => {
  test('long text splits at a paragraph, and every part fits', () => {
    const paragraph = 'word '.repeat(300).trim();
    const parts = chunkText(`${paragraph}\n\n${paragraph}`, 2000);
    expect(parts).toHaveLength(2);
    parts.forEach(part => expect(part.length).toBeLessThanOrEqual(2000));
    expect(parts.join(' ').split(' ').length).toBe(600);
  });

  test('Instagram\'s limit is bytes, and an emoji is never split', () => {
    const text = '😀'.repeat(400);
    const parts = chunkText(text, 1000, bytes);
    parts.forEach(part => {
      expect(bytes(part)).toBeLessThanOrEqual(1000);
      expect(part).not.toMatch(/�/);
    });
    expect(parts.join('')).toBe(text);
  });

  test('up to three short choices are WhatsApp buttons; more are a list', () => {
    const buttons = whatsapp.interactiveMessage('1', 'Pick one', [
      { id: 'Yes', label: 'Yes' }, { id: 'No', label: 'No' }
    ]);
    expect(buttons.interactive.type).toBe('button');
    expect(buttons.interactive.action.buttons).toHaveLength(2);

    const list = whatsapp.interactiveMessage('1', 'Pick one', [
      { id: 'a', label: 'Monday 2 November at half past ten' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }
    ]);
    expect(list.interactive.type).toBe('list');
    const rows = list.interactive.action.sections[0].rows;
    expect(rows).toHaveLength(4);
    expect(rows[0].title.length).toBeLessThanOrEqual(24);
    expect(rows[0].description).toBe('Monday 2 November at half past ten');
  });

  test('the bot\'s "talk to a person" choice keeps its handoff id', () => {
    const choices = outbound.choicesFrom([
      'Opening hours',
      { label: 'Book', value: 'book' },
      { label: 'Talk to a person', value: '__handoff__', action: 'handoff' },
      'Opening hours'
    ]);
    expect(choices).toEqual([
      { id: 'Opening hours', label: 'Opening hours' },
      { id: 'Book', label: 'Book' },
      { id: '__handoff__', label: 'Talk to a person' }
    ]);
  });

  test('product cards are written out as text with links', () => {
    const text = outbound.composeText('Here are two:', {
      type: 'Product',
      items: [{ title: 'Blue mug', price: '£8', url: 'https://shop.example/blue' }, { title: 'Red mug' }]
    }, []);
    expect(text).toBe('Here are two:\n\n• Blue mug – £8\n  https://shop.example/blue\n• Red mug');
  });

  test('time slots offered as buttons are not listed again', () => {
    const cards = { type: 'Slot', items: [{ label: 'Mon 10:00' }] };
    expect(outbound.composeText('When?', cards, [{ id: 'Mon 10:00', label: 'Mon 10:00' }])).toBe('When?');
  });

  test('a refusal is explained in words an operator can act on', () => {
    expect(graph.describe(new graph.GraphError({ message: '(#131047) Re-engagement message', code: 131047 })))
      .toMatch(/24 hours/);
    expect(graph.describe(new graph.GraphError({ message: 'Error validating access token', code: 190 })))
      .toMatch(/access token/);
    expect(graph.GRAPH_VERSION).toMatch(/^v\d+\.0$/);
  });
});
