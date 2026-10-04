/**
 * The widget's words.
 *
 * The widget is plain browser JavaScript, so it is run here in a bare VM
 * context with just enough of a `window` for its top level to execute; the
 * pure pieces are exposed only when `__CHATBOT_WIDGET_TEST__` is set, which no
 * page does. What is checked is the contract a translator can break without
 * noticing: every language has every string, and keeps every placeholder.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { WIDGET_LANGUAGES } = require('../config/widget-languages');

const WIDGET = path.join(__dirname, '..', 'public', 'widget', 'js', 'widget.js');

function loadWidget() {
  const window = { __CHATBOT_WIDGET_TEST__: true };
  vm.runInNewContext(fs.readFileSync(WIDGET, 'utf8'), { window, navigator: { languages: [] } });
  return window.ChatbotWidget;
}

describe('widget translations', () => {
  const widget = loadWidget();
  const { STRINGS, resolveLanguage, translateOpening, safeLogoUrl, t } = widget._internals;
  const placeholders = text => (String(text).match(/\{\w+\}/g) || []).sort();

  it('speaks exactly the languages the server accepts', () => {
    expect(Object.keys(STRINGS).sort()).toEqual([...WIDGET_LANGUAGES].sort());
    expect(widget.languages.sort()).toEqual([...WIDGET_LANGUAGES].sort());
  });

  it.each(WIDGET_LANGUAGES.filter(code => code !== 'en'))('%s has every English string, with the same placeholders', code => {
    const english = STRINGS.en;
    const table = STRINGS[code];

    expect(Object.keys(table).sort()).toEqual(Object.keys(english).sort());
    Object.keys(english).forEach(key => {
      expect(typeof table[key]).toBe('string');
      expect(table[key].trim()).not.toBe('');
      expect({ key, placeholders: placeholders(table[key]) })
        .toEqual({ key, placeholders: placeholders(english[key]) });
    });
  });

  it('fills placeholders and falls back to English for a missing key', () => {
    expect(t('fr', 'operatorJoined', { name: 'Olive' })).toBe('Olive a rejoint la conversation.');
    expect(t('de', 'scoreLabel', { score: 4 })).toBe('4 von 5');
    expect(t('xx', 'send')).toBe('Send');
  });

  describe('choosing the language', () => {
    it('prefers the snippet attribute, then the tenant, then the browser, then English', () => {
      expect(resolveLanguage('de', 'fr', ['es-ES'])).toBe('de');
      expect(resolveLanguage(null, 'fr', ['es-ES'])).toBe('fr');
      expect(resolveLanguage(null, 'auto', ['es-ES'])).toBe('es');
      expect(resolveLanguage(null, null, ['ja-JP'])).toBe('en');
    });

    it('treats auto as "ask the browser" and skips codes it does not speak', () => {
      expect(resolveLanguage('auto', 'fr', ['pt-BR'])).toBe('fr');
      expect(resolveLanguage('auto', 'auto', ['pt-BR'])).toBe('pt');
      expect(resolveLanguage('ja', 'ro', [])).toBe('ro');
      expect(resolveLanguage(undefined, undefined, ['ja', 'uk-UA'])).toBe('uk');
    });
  });

  it('translates the opening times the server describes in English', () => {
    expect(translateOpening('en', 'today at 09:00')).toBe('today at 09:00');
    expect(translateOpening('de', 'tomorrow at 08:30')).toBe('morgen um 08:30');
    expect(translateOpening('fr', 'Monday at 08:30')).toBe('lundi à 08:30');
    expect(translateOpening('es', 'Friday at 10:00')).toBe('el viernes a las 10:00');
    expect(translateOpening('fr', 'when the moon is full')).toBe('when the moon is full');
  });

  it('draws a logo only from an https URL', () => {
    expect(safeLogoUrl('https://cdn.example.com/logo.png')).toBe('https://cdn.example.com/logo.png');
    expect(safeLogoUrl('http://cdn.example.com/logo.png')).toBeNull();
    expect(safeLogoUrl('javascript:alert(1)')).toBeNull();
    expect(safeLogoUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(safeLogoUrl(undefined)).toBeNull();
  });
});

describe('widget preview page', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget', 'preview.html'), 'utf8');

  it('has no inline script, which the CSP would refuse', () => {
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
    expect(scripts.length).toBeGreaterThan(0);
    scripts.forEach(tag => {
      expect(tag).toMatch(/\bsrc=/);
      expect(tag.replace(/<script\b[^>]*>|<\/script>/gi, '').trim()).toBe('');
    });
  });

  it('loads the real loader in preview mode and checks postMessage origins', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget', 'js', 'preview.js'), 'utf8');
    expect(script).toContain('/widget/js/widget-loader.js');
    expect(script).toContain('data-preview');
    expect(script).toContain('event.origin !== window.location.origin');
  });
});
