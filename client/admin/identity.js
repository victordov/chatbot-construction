/**
 * Identity verification: the tenant's server vouches for a signed-in
 * visitor, and only a visitor vouched for that way counts as verified.
 *
 * Two ways to vouch, both with the company's identity secret: a short-lived
 * signed token (JWT, recommended - it expires and can carry attributes) or
 * the older HMAC of the user id. The examples are shown with this company's
 * own widget key and server address, so what is pasted works as it is.
 */

import { registerSection } from './nav.js';
import { api, confirmDialog, errorMessage, logger, showToast } from './utils.js';

let identityExamples = {};
let widgetKey = 'YOUR_WIDGET_KEY';
let server = window.location.origin;

/** Quote a value for an HTML attribute in the snippet the admin copies. */
const attr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Quote a value for a single-quoted string in example code. */
const quoted = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, '\\\'');

/**
 * How to sign a visitor token, per language, with the widget key as `aud`.
 * One hour: long enough for a visit, short enough that a copied token is
 * soon worthless; the widget asks the page for a fresh one when it lapses.
 */
function jwtExamples() {
  const key = quoted(widgetKey);
  return {
    node: [
      '// npm install jsonwebtoken',
      "const jwt = require('jsonwebtoken');",
      '',
      'const userJwt = jwt.sign(',
      '  {',
      '    sub: String(user.id),',
      '    email: user.email,',
      '    name: user.name,',
      `    aud: '${key}',`,
      '    attrs: { plan: user.plan }',
      '  },',
      '  process.env.CHAT_IDENTITY_SECRET,',
      "  { algorithm: 'HS256', expiresIn: '1h' }",
      ');'
    ].join('\n'),
    python: [
      '# pip install pyjwt',
      'import time, jwt',
      '',
      'now = int(time.time())',
      'user_jwt = jwt.encode({',
      '    "sub": str(user.id),',
      '    "email": user.email,',
      '    "name": user.name,',
      `    "aud": "${key}",`,
      '    "attrs": {"plan": user.plan},',
      '    "iat": now,',
      '    "exp": now + 3600,',
      '}, CHAT_IDENTITY_SECRET, algorithm="HS256")'
    ].join('\n'),
    php: [
      '// composer require firebase/php-jwt',
      'use Firebase\\JWT\\JWT;',
      '',
      '$now = time();',
      '$userJwt = JWT::encode([',
      "    'sub' => (string) $user->id,",
      "    'email' => $user->email,",
      "    'name' => $user->name,",
      `    'aud' => '${key}',`,
      "    'attrs' => ['plan' => $user->plan],",
      "    'iat' => $now,",
      "    'exp' => $now + 3600,",
      "], getenv('CHAT_IDENTITY_SECRET'), 'HS256');"
    ].join('\n'),
    ruby: [
      '# gem install jwt',
      "require 'jwt'",
      '',
      'now = Time.now.to_i',
      'user_jwt = JWT.encode({',
      '  sub: user.id.to_s,',
      '  email: user.email,',
      '  name: user.name,',
      `  aud: '${key}',`,
      '  attrs: { plan: user.plan },',
      '  iat: now,',
      '  exp: now + 3600',
      "}, ENV['CHAT_IDENTITY_SECRET'], 'HS256')"
    ].join('\n')
  };
}

function loaderTag(extraLines) {
  return [
    '<script',
    `  src="${attr(server)}/widget/js/widget-loader.js"`,
    `  data-widget-key="${attr(widgetKey)}"`,
    `  data-server-url="${attr(server)}"`,
    ...extraLines,
    '  defer><' + '/script>'
  ].join('\n');
}

function selectedJwtLanguage() {
  const active = document.querySelector('#identity-jwt-lang-tabs [data-jwt-lang].active');
  return active ? active.dataset.jwtLang : 'node';
}

/** Everything on the screen that names this company's key or server. */
function renderSnippets() {
  document.getElementById('identity-widget-key').textContent = widgetKey;
  document.getElementById('identity-jwt-example').textContent = jwtExamples()[selectedJwtLanguage()];
  document.getElementById('identity-jwt-snippet').textContent = loaderTag(['  data-user-jwt="<%= userJwt %>"']);
  document.getElementById('identity-jwt-refresh').textContent = [
    "ChatWidget.on('identity-expired', async () => {",
    '  // An endpoint of yours that signs a new token for the signed-in user.',
    "  const response = await fetch('/chat-token', { credentials: 'same-origin' });",
    '  if (response.ok) {',
    '    const { userJwt } = await response.json();',
    '    ChatWidget.identify({ jwt: userJwt });',
    '  }',
    '});',
    '',
    '// Signing in or out without a page load:',
    '// ChatWidget.identify({ jwt: userJwt });   ChatWidget.shutdown();'
  ].join('\n');
  document.getElementById('identity-snippet').textContent = loaderTag([
    '  data-user-id="<%= user.id %>"',
    '  data-user-hash="<%= userHash %>"'
  ]);
}

/**
 * This company's widget key and the address of this server - the same two
 * values as the install snippet on Website widget. A placeholder like
 * YOUR_WIDGET_KEY is something somebody would paste as is.
 */
async function loadInstallValues() {
  try {
    const [widget, config] = await Promise.all([
      api('/api/companies/me/widget'),
      fetch('/api/auth/config').then(response => (response.ok ? response.json() : {}))
    ]);
    widgetKey = widget.widgetKey || widgetKey;
    server = (config && config.publicUrl) || server;
  } catch (error) {
    logger.warn('Could not read the widget key for the identity snippets', error);
  }
  renderSnippets();
}

async function loadIdentitySecret() {
  try {
    const { secret, examples } = await api('/api/contacts/identity/secret');
    identityExamples = examples;

    document.getElementById('identity-secret').value = secret;
    document.getElementById('identity-example').textContent = examples.node;
  } catch (error) {
    logger.error('Could not load identity secret:', error);
    showToast(errorMessage(error, 'Could not load the identity secret'), 'danger');
  }
}

async function rotateSecret() {
  const ok = await confirmDialog({
    title: 'Rotate the identity secret?',
    message: 'Every token and hash your application has already signed stops working, so signed-in visitors become anonymous until you deploy the new secret.',
    confirmLabel: 'Rotate secret',
    danger: true
  });
  if (!ok) {
    return;
  }

  try {
    const { secret } = await api('/api/contacts/identity/secret/rotate', { method: 'POST' });
    document.getElementById('identity-secret').value = secret;
    showToast('Secret rotated — update your server', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

/** One of a group of toggle buttons pressed, the rest released. */
function press(buttons, chosen) {
  buttons.forEach(button => {
    const on = button === chosen;
    button.classList.toggle('active', on);
    if (button.hasAttribute('aria-pressed')) {
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  });
}

function showMethod(method) {
  press([...document.querySelectorAll('#identity-method-tabs [data-method]')],
    document.querySelector(`#identity-method-tabs [data-method="${method}"]`));
  document.querySelectorAll('#identity-section [data-identity-pane]').forEach(pane => {
    pane.hidden = pane.dataset.identityPane !== method;
  });
}

function setupIdentitySection() {
  document.getElementById('reveal-secret-btn').addEventListener('click', event => {
    const field = document.getElementById('identity-secret');
    const hidden = field.type === 'password';
    field.type = hidden ? 'text' : 'password';
    event.target.textContent = hidden ? 'Hide' : 'Show';
  });

  document.getElementById('copy-secret-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('identity-secret').value)
      .then(() => showToast('Secret copied — keep it server-side', 'success'))
      .catch(() => showToast('Could not copy', 'warning'));
  });

  document.getElementById('rotate-secret-btn').addEventListener('click', rotateSecret);

  document.getElementById('identity-method-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-method]');
    if (button) {
      showMethod(button.dataset.method);
    }
  });

  document.getElementById('identity-jwt-lang-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-jwt-lang]');
    if (!button) {
      return;
    }
    press([...document.querySelectorAll('#identity-jwt-lang-tabs [data-jwt-lang]')], button);
    document.getElementById('identity-jwt-example').textContent = jwtExamples()[button.dataset.jwtLang] || '';
  });

  document.querySelectorAll('#identity-lang-tabs [data-lang]').forEach(button => {
    button.addEventListener('click', () => {
      press([...document.querySelectorAll('#identity-lang-tabs [data-lang]')], button);
      document.getElementById('identity-example').textContent =
        identityExamples[button.dataset.lang] || '';
    });
  });

  renderSnippets();
  loadIdentitySecret();
  loadInstallValues();
}

registerSection('identity', { setup: setupIdentitySection });
