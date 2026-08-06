/**
 * Install Widget section.
 *
 * Completes the multi-tenant story from the operator's side: without a widget
 * key in the embed snippet, incoming chats cannot be attributed to a company
 * and the dashboard stays empty.
 */

(function() {
  let config = null;

  function token() {
    return localStorage.getItem('chatbot-auth-token');
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api/companies${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': token(),
        ...options.headers
      }
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body;
  }

  function snippet() {
    if (!config) {
      return '';
    }
    const origin = window.location.origin;
    const settings = config.widgetSettings || {};
    return [
      '<script',
      `  src="${origin}/widget/js/widget-loader.js"`,
      `  data-widget-key="${config.widgetKey}"`,
      `  data-server-url="${origin}"`,
      `  data-chatbot-name="${settings.chatbotName || 'Assistant'}"`,
      `  data-primary-color="${settings.primaryColor || '#2196f3'}"`,
      `  data-position="${settings.position || 'right'}"`,
      '  defer><' + '/script>'
    ].join('\n');
  }

  function renderDomains() {
    const list = document.getElementById('domain-list');
    const domains = config.allowedDomains || [];

    if (domains.length === 0) {
      list.innerHTML = `
        <li class="list-group-item text-muted">
          No domains added yet. Until you add one, the widget will only work on this server's own origin.
        </li>`;
      return;
    }

    list.innerHTML = domains.map(domain => `
      <li class="list-group-item d-flex justify-content-between align-items-center">
        <span class="font-monospace">${escapeHtml(domain)}</span>
        <button class="btn btn-sm btn-outline-danger remove-domain-btn" data-domain="${escapeHtml(domain)}">
          Remove
        </button>
      </li>`).join('');

    list.querySelectorAll('.remove-domain-btn').forEach(btn => {
      btn.addEventListener('click', () => removeDomain(btn.dataset.domain));
    });
  }

  function render() {
    if (!config) {
      return;
    }

    document.getElementById('embed-snippet').textContent = snippet();
    document.getElementById('widget-key').value = config.widgetKey || '';

    const settings = config.widgetSettings || {};
    document.getElementById('widget-name').value = settings.chatbotName || '';
    document.getElementById('widget-color').value = settings.primaryColor || '#2196f3';
    document.getElementById('widget-position').value = settings.position || 'right';
    document.getElementById('widget-welcome').value = settings.welcomeMessage || '';

    renderDomains();

    if (typeof feather !== 'undefined') {
      feather.replace();
    }
  }

  async function load() {
    try {
      config = await api('/me/widget');
      render();
    } catch (error) {
      logger.error('Failed to load widget configuration:', error);
      document.getElementById('embed-snippet').textContent =
        `Could not load widget configuration: ${error.message}`;
    }
  }

  async function save(patch, successMessage) {
    try {
      const result = await api('/me/widget', { method: 'PUT', body: JSON.stringify(patch) });
      config.allowedDomains = result.allowedDomains;
      config.widgetSettings = result.widgetSettings;
      render();
      showToast(successMessage, 'success');
    } catch (error) {
      showToast(error.message, 'danger');
    }
  }

  function addDomain() {
    const input = document.getElementById('new-domain-input');
    const value = input.value.trim();
    if (!value) {
      return;
    }

    const domains = [...(config.allowedDomains || []), value];
    input.value = '';
    save({ allowedDomains: domains }, 'Domain added');
  }

  function removeDomain(domain) {
    const domains = (config.allowedDomains || []).filter(d => d !== domain);
    save({ allowedDomains: domains }, 'Domain removed');
  }

  function copySnippet() {
    navigator.clipboard.writeText(snippet())
      .then(() => showToast('Snippet copied to clipboard', 'success'))
      .catch(() => showToast('Could not copy - select the snippet and copy manually', 'warning'));
  }

  async function rotateKey() {
    if (!confirm('Rotate the widget key? Any site still using the old snippet will stop being recognised until you update it.')) {
      return;
    }

    try {
      const result = await api('/me/widget/rotate-key', { method: 'POST' });
      config.widgetKey = result.widgetKey;
      render();
      showToast('Widget key rotated - update your embed snippet', 'success');
    } catch (error) {
      showToast(error.message, 'danger');
    }
  }

  function setupWidgetSection() {
    // Operators have no company-level settings to manage.
    const user = window.currentUser;
    if (!user || (user.role !== 'superadmin' && user.role !== 'company_admin')) {
      return;
    }

    document.getElementById('copy-snippet-btn')?.addEventListener('click', copySnippet);
    document.getElementById('rotate-widget-key-btn')?.addEventListener('click', rotateKey);
    document.getElementById('add-domain-btn')?.addEventListener('click', addDomain);

    document.getElementById('new-domain-input')?.addEventListener('keypress', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addDomain();
      }
    });

    document.getElementById('widget-settings-form')?.addEventListener('submit', e => {
      e.preventDefault();
      save({
        widgetSettings: {
          chatbotName: document.getElementById('widget-name').value.trim(),
          primaryColor: document.getElementById('widget-color').value,
          position: document.getElementById('widget-position').value,
          welcomeMessage: document.getElementById('widget-welcome').value.trim()
        }
      }, 'Appearance saved');
    });

    load();
  }

  window.setupWidgetSection = setupWidgetSection;
})();
