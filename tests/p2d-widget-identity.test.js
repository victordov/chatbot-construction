/**
 * P2D: the widget's half of visitor identity.
 *
 * As in widget-i18n.test.js the widget runs in a bare VM context and only its
 * pure pieces are exercised: the new notice codes have words in every
 * language, a token's subject is read the way the server reads it, and the
 * "Verify with your email" choice is recognised.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const jwt = require('jsonwebtoken');

const { WIDGET_LANGUAGES } = require('../config/widget-languages');
const { CODES, notice, verifyEmailChoice } = require('../services/visitor-notices');

const WIDGET_DIR = path.join(__dirname, '..', 'public', 'widget', 'js');

function loadWidget() {
  const window = { __CHATBOT_WIDGET_TEST__: true };
  vm.runInNewContext(fs.readFileSync(path.join(WIDGET_DIR, 'widget.js'), 'utf8'), {
    window, navigator: { languages: [] }, URL, atob, TextDecoder
  });
  return window.ChatWidget;
}

const widget = loadWidget();
const internals = widget._internals;

const P2D_CODES = CODES.filter(code => code === 'identity_expired' || code.startsWith('verify_email_'));

describe('P2D: the widget speaks every identity notice', () => {
  it('knows every new code the server sends', () => {
    expect(P2D_CODES.length).toBeGreaterThanOrEqual(13);
    P2D_CODES.forEach(code => expect(internals.NOTICE_CODES[code]).toBeTruthy());
  });

  it.each(WIDGET_LANGUAGES)('has words for each of them in %s, with the address filled in', lang => {
    P2D_CODES.forEach(code => {
      const payload = { ...notice(code, { email: 'alex@example.com' }) };
      const shown = internals.noticeText(lang, payload);
      expect(shown.code).toBe(code);
      expect(shown.text).not.toMatch(/\{\w+\}/);
      if (lang !== 'en') {
        expect(shown.text).not.toBe(payload.message);
      }
    });
    expect(internals.noticeText(lang, notice('verify_email_sent', { email: 'alex@example.com' })).text)
      .toContain('alex@example.com');
    // Without the address, the sentence that needs none.
    expect(internals.noticeText(lang, { code: 'verify_email_verified' }).text).not.toMatch(/\{\w+\}/);
  });

  it('has every string of the code form in every language', () => {
    const keys = ['verifyWithEmail', 'verifyEmailTitle', 'verifyEmailIntro', 'sendCode', 'verificationCode',
      'verifyCode', 'useDifferentEmail', 'resendCode', 'identityExpired'];
    WIDGET_LANGUAGES.forEach(lang => {
      keys.forEach(key => {
        expect(typeof internals.STRINGS[lang][key]).toBe('string');
        expect(internals.STRINGS[lang][key].trim()).not.toBe('');
      });
    });
  });
});

describe('P2D: tokens and choices in the widget', () => {
  it('reads the subject of a token, as text, including non-ASCII payloads', () => {
    const token = jwt.sign({ sub: 'user-7', name: 'Zoë Łukasz', exp: Math.floor(Date.now() / 1000) + 60 }, 'secret');
    expect(internals.tokenSubject(token)).toBe('user-7');
    expect(internals.tokenSubject(jwt.sign({ sub: 42 }, 'secret'))).toBe('42');
    expect(internals.tokenSubject(jwt.sign({ name: 'nobody' }, 'secret'))).toBeNull();
    expect(internals.tokenSubject('not.a.token!')).toBeNull();
    expect(internals.tokenSubject(undefined)).toBeNull();
  });

  it('recognises the server\'s "Verify with your email" choice', () => {
    expect(internals.isVerifyEmailChoice(verifyEmailChoice())).toBe(true);
    expect(internals.isVerifyEmailChoice({ label: 'Yes' })).toBe(false);
    expect(internals.isHandoffChoice(verifyEmailChoice())).toBe(false);
  });

  it('offers verifyEmail on the public API, before and after the widget loads', () => {
    expect(typeof widget.verifyEmail).toBe('function');
    const loader = fs.readFileSync(path.join(WIDGET_DIR, 'widget-loader.js'), 'utf8');
    expect(loader).toMatch(/'verifyEmail'/);
    expect(loader).toContain("attr('data-user-jwt')");
  });
});
