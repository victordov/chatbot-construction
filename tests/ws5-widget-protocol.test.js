/**
 * The visitor's side of the conversation protocol.
 *
 * The widget is plain browser JavaScript, so, as in widget-i18n.test.js, it
 * runs in a bare VM context and only its pure pieces are exercised: what a
 * server notice says in each language, how a replayed transcript is matched
 * against what is already on screen, how links in answers are drawn, and the
 * small rules that decide what to draw. These are the parts a change to the
 * server protocol can quietly break.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { WIDGET_LANGUAGES } = require('../config/widget-languages');

const WIDGET = path.join(__dirname, '..', 'public', 'widget', 'js', 'widget.js');

function loadWidget(extraWindow = {}) {
  const window = { __CHATBOT_WIDGET_TEST__: true, ...extraWindow };
  vm.runInNewContext(fs.readFileSync(WIDGET, 'utf8'), { window, navigator: { languages: [] }, URL });
  return window;
}

const window = loadWidget();
const widget = window.ChatWidget;
const internals = widget._internals;
const { STRINGS, NOTICE_CODES } = internals;

// The codes the server sends (services/visitor-notices.js is the contract).
// Every one must have words in every language the widget ships.
const CONTRACT_CODES = require('../services/visitor-notices').CODES;

describe('the public API', () => {
  it('is published as ChatWidget and, for older pages, ChatbotWidget', () => {
    expect(window.ChatbotWidget).toBe(widget);
    ['init', 'preview', 'open', 'close', 'toggle', 'identify', 'shutdown', 'on', 'off'].forEach(name => {
      expect(typeof widget[name]).toBe('function');
    });
    expect(widget.languages.sort()).toEqual([...WIDGET_LANGUAGES].sort());
  });

  it('takes over the calls the loader queued before the widget arrived', () => {
    const queue = [['open', []], ['on', ['message', () => {}]], ['bogus']];
    const loaded = loadWidget({ ChatWidget: { _queue: queue } });
    // The stand-in is replaced by the real API; nothing runs until init.
    expect(typeof loaded.ChatWidget.identify).toBe('function');
    expect(loaded.ChatWidget._queue).toBeUndefined();
  });

  it('queues calls made before init instead of failing', () => {
    expect(() => widget.open()).not.toThrow();
    expect(() => widget.identify({ userId: 'u-1', userHash: 'abc' })).not.toThrow();
    expect(widget.on('message', () => {})).toBe(widget);
    expect(widget.off('message')).toBe(widget);
  });
});

describe('notice codes', () => {
  it('covers every code in the contract', () => {
    expect(Object.keys(NOTICE_CODES).sort()).toEqual([...CONTRACT_CODES].sort());
  });

  it.each(WIDGET_LANGUAGES)('every code has words in %s', lang => {
    CONTRACT_CODES.forEach(code => {
      const key = NOTICE_CODES[code];
      expect(typeof STRINGS[lang][key]).toBe('string');

      const notice = internals.noticeText(lang, {
        code,
        params: { operatorName: 'Olive', email: 'alex@example.com' },
        message: 'English fallback'
      });
      expect(notice.code).toBe(code);
      expect(notice.text.trim()).not.toBe('');
      expect(notice.text).not.toBe('English fallback');
      // Placeholders are always filled, never shown.
      expect(notice.text).not.toMatch(/\{\w+\}/);
    });
  });

  it('fills in the operator and the email where the sentence has room for them', () => {
    expect(internals.noticeText('fr', { code: 'operator_joined', params: { operatorName: 'Olive' } }).text)
      .toBe('Olive a rejoint la conversation.');
    expect(internals.noticeText('de', { code: 'followup_saved', params: { email: 'a@b.de' } }).text)
      .toBe('Danke. Wir antworten Ihnen an a@b.de.');
  });

  it('says it without the name when the name did not arrive', () => {
    expect(internals.noticeText('en', { code: 'operator_joined', params: {} }).text)
      .toBe('You are connected to a member of the team.');
    expect(internals.noticeText('en', { code: 'operator_left' }).text)
      .toBe('The team member has left the conversation.');
    expect(internals.noticeText('en', { code: 'followup_saved', params: { email: '  ' } }).text)
      .toBe('Thanks. We\'ll reply by email.');
  });

  it('shows the server\'s English for a code it does not know, and nothing for no notice', () => {
    expect(internals.noticeText('es', { code: 'brand_new_code', message: 'Something new happened.' }))
      .toEqual({ code: 'brand_new_code', text: 'Something new happened.' });
    expect(internals.noticeText('es', { text: 'An ordinary answer.' })).toBeNull();
    expect(internals.noticeText('es', null)).toBeNull();
  });

  it('translates the English lines today\'s server sends without a code', () => {
    const failed = internals.noticeText('ro', {
      text: 'Sorry, something went wrong while preparing a reply. Please try again in a moment.'
    });
    expect(failed.code).toBe('reply_failed');
    expect(failed.text).toBe(STRINGS.ro.replyFailed);

    const unavailable = internals.noticeText('nl', {
      text: 'Sorry, this chat is unavailable right now. Please try again later.'
    });
    expect(unavailable.code).toBe('unavailable');
  });

  it('never shows the raw "Failed to generate a reply" error', () => {
    expect(internals.errorText('de', { message: 'Failed to generate a reply' })).toBeNull();
    expect(internals.errorText('de', { message: 'Failed to process message' })).toBe(STRINGS.de.genericError);
    expect(internals.errorText('pl', { message: 'You are sending messages too quickly. Please wait a moment.' }))
      .toBe(STRINGS.pl.tooFast);
    expect(internals.errorText('en', { code: 'reply_failed', message: 'x' })).toBe(STRINGS.en.replyFailed);
    // Unknown wording is shown as sent rather than swallowed.
    expect(internals.errorText('en', { message: 'Message must be 4000 characters or fewer' }))
      .toBe('Message must be 4000 characters or fewer');
    expect(internals.errorText('en', {})).toBe(STRINGS.en.genericError);
  });
});

describe('who the visitor is talking to', () => {
  it('names the business while the assistant has the stock name', () => {
    expect(internals.headerCopy('en', { chatbotName: 'Assistant', businessName: 'Bloom Dental' }))
      .toEqual({ title: 'Bloom Dental', subtitle: STRINGS.en.assistant });
  });

  it('keeps a name the tenant chose, with the business underneath', () => {
    expect(internals.headerCopy('en', { chatbotName: 'Bea', businessName: 'Bloom Dental' }))
      .toEqual({ title: 'Bea', subtitle: 'AI assistant · Bloom Dental' });
  });

  it('shows the person and where they are from once someone joins', () => {
    expect(internals.headerCopy('en', { chatbotName: 'Bea', businessName: 'Bloom Dental', operator: { name: 'Olive' } }))
      .toEqual({ title: 'Olive', subtitle: 'from Bloom Dental' });
    expect(internals.headerCopy('de', { chatbotName: 'Assistant', operator: { name: '' } }))
      .toEqual({ title: STRINGS.de.operator, subtitle: STRINGS.de.teamMember });
  });
});

describe('the greeting says it is an AI', () => {
  it('uses our greeting, which says so, when the tenant has not written one', () => {
    expect(internals.welcomeFor('en', 'Hi! How can we help you today?')).toBe(STRINGS.en.greeting);
    expect(internals.welcomeFor('fr', '')).toBe(STRINGS.fr.greeting);
    WIDGET_LANGUAGES.forEach(lang => {
      expect(internals.mentionsAi(STRINGS[lang].greeting)).toBe(true);
      expect(internals.mentionsAi(STRINGS[lang].aiDisclosure)).toBe(true);
    });
  });

  it('adds one line under a tenant\'s welcome that does not say so', () => {
    expect(internals.welcomeFor('de', 'Willkommen bei Bloom!'))
      .toBe(`Willkommen bei Bloom!\n${STRINGS.de.aiDisclosure}`);
  });

  it('leaves a welcome that already says so alone', () => {
    ['Hi, I am Bloom\'s AI helper', 'Bonjour, je suis l\'assistant IA', 'Ich bin ein KI-Assistent',
      'Привет! Я ИИ-помощник', 'Our chatbot answers instantly'].forEach(welcome => {
      expect(internals.welcomeFor('en', welcome)).toBe(welcome);
    });
  });

  it('does not mistake ordinary words for "AI"', () => {
    ['Hi there', 'Which shipping option?', 'Said and done', 'Kia ora'].forEach(text => {
      expect(internals.mentionsAi(text)).toBe(false);
    });
  });
});

describe('a replayed transcript', () => {
  const rendered = ids => new Set(ids);

  it('skips what is on screen by server id or by the id this browser gave it', () => {
    const plan = internals.planHistory([
      { id: 'db-1', sender: 'bot', text: 'Hello' },
      { id: 'db-2', sender: 'user', text: 'Hi', clientMessageId: 'msg_1' },
      { id: 'db-3', sender: 'bot', text: 'New' }
    ], rendered(['db-1', 'msg_1']), [{ id: 'msg_1', text: 'Hi', matched: false }]);

    expect(plan.map(entry => entry.draw)).toEqual([false, false, true]);
    expect(plan[1].adopt).toBe('msg_1');
  });

  it('matches a server that does not echo our id by text, in order, once each', () => {
    const plan = internals.planHistory([
      { id: 'db-1', sender: 'user', text: 'yes' },
      { id: 'db-2', sender: 'bot', text: 'Sure?' },
      { id: 'db-3', sender: 'user', text: 'yes' },
      { id: 'db-4', sender: 'user', text: 'yes' }
    ], rendered([]), [
      { id: 'msg_a', text: 'yes', matched: false },
      { id: 'msg_b', text: 'yes', matched: false }
    ]);

    expect(plan.map(entry => entry.adopt || null)).toEqual(['msg_a', null, 'msg_b', null]);
    expect(plan.map(entry => entry.draw)).toEqual([false, true, false, true]);
  });

  it('never draws an operator-facing system line', () => {
    const plan = internals.planHistory([{ id: 's', sender: 'system', text: 'Asked for a person' }], rendered([]), []);
    expect(plan[0].draw).toBe(false);
  });
});

describe('what an answer draws', () => {
  it('draws appointment times once, as the choices', () => {
    const cards = { type: 'Slot', items: [{ id: 's1', label: 'Mon 9:00' }] };
    const choices = [{ id: 's1', label: 'Mon 9:00' }];
    expect(internals.extrasPlan(cards, choices)).toEqual({ cards: null, choices });
    // Slot cards with no choices, and products with choices, are both kept.
    expect(internals.extrasPlan(cards, null)).toEqual({ cards, choices: null });
    const products = { type: 'Product', items: [{ title: 'Pannier' }] };
    expect(internals.extrasPlan(products, choices)).toEqual({ cards: products, choices });
  });

  it('recognises a quick reply that asks for a person', () => {
    expect(internals.isHandoffChoice({ label: 'Talk to a person', action: 'handoff' })).toBe(true);
    expect(internals.isHandoffChoice({ label: 'x', value: '__handoff__' })).toBe(true);
    expect(internals.isHandoffChoice({ label: 'Talk to a person' })).toBe(false);
    expect(internals.isHandoffChoice(null)).toBe(false);
  });

  it('shows the read tick only when a person read it', () => {
    expect(internals.readByPerson({ messageId: 'm', reader: 'operator' })).toBe(true);
    expect(internals.readByPerson({ messageId: 'm', byOperator: true })).toBe(true);
    // What the server sends the moment it stores a message.
    expect(internals.readByPerson({ messageId: 'm', timestamp: new Date() })).toBe(false);
  });
});

describe('links in answers', () => {
  const format = internals.formatMessage;

  it('turns http and https addresses into links that open safely', () => {
    const html = format('See https://example.com/help for more.');
    expect(html).toBe('See <a href="https://example.com/help" target="_blank" rel="noopener noreferrer">' +
      'https://example.com/help</a> for more.');
  });

  it('draws Markdown links by their label, inside bold if asked', () => {
    expect(format('**[Pricing](https://example.com/pricing)**')).toBe(
      '<strong><a href="https://example.com/pricing" target="_blank" rel="noopener noreferrer">Pricing</a></strong>');
  });

  it('keeps sentence punctuation out of the address, but a URL\'s own brackets in', () => {
    expect(format('Go to https://example.com/a.')).toContain('href="https://example.com/a"');
    expect(format('(see https://example.com/a)')).toContain('href="https://example.com/a"');
    expect(format('https://en.wikipedia.org/wiki/Foo_(bar)')).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
  });

  it('links nothing but http and https, and escapes everything else', () => {
    const html = format('[click](javascript:alert(1)) javascript:alert(1) <img src=x onerror=alert(1)> ftp://x.example');
    expect(html).not.toMatch(/<a /);
    expect(html).not.toMatch(/<img/);
    expect(html).toContain('&lt;img');
  });

  it('cannot be tricked into a forged link marker', () => {
    const html = format('0 https://example.com');
    expect((html.match(/<a /g) || []).length).toBe(1);
  });

  it('escapes quotes in an address rather than ending the attribute', () => {
    const html = format('https://example.com/?q=a&b=<c>');
    expect(html).toContain('href="https://example.com/?q=a&amp;b="');
  });
});

describe('the proactive message', () => {
  const proactive = { enabled: true, text: 'Questions about delivery?', delaySeconds: 15, pathContains: '/shop' };

  it('applies only when switched on, written, and on a matching page', () => {
    expect(internals.proactiveApplies(proactive, '/shop/bikes')).toBe(true);
    expect(internals.proactiveApplies(proactive, '/SHOP')).toBe(true);
    expect(internals.proactiveApplies(proactive, '/about')).toBe(false);
    expect(internals.proactiveApplies({ ...proactive, pathContains: '' }, '/about')).toBe(true);
    expect(internals.proactiveApplies({ ...proactive, enabled: false }, '/shop')).toBe(false);
    expect(internals.proactiveApplies({ ...proactive, text: '  ' }, '/shop')).toBe(false);
    expect(internals.proactiveApplies(null, '/shop')).toBe(false);
  });

  it('waits between 5 and 120 seconds', () => {
    expect(internals.proactiveDelayMs(proactive)).toBe(15000);
    expect(internals.proactiveDelayMs({ delaySeconds: 1 })).toBe(5000);
    expect(internals.proactiveDelayMs({ delaySeconds: 999 })).toBe(120000);
    expect(internals.proactiveDelayMs({})).toBe(20000);
  });
});
