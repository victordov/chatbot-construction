/**
 * People: the customer rather than the conversation.
 *
 * Before this the product only knew about sessions, so an operator answering
 * somebody had no way to see what the same person asked last week, or on a
 * different device.
 */

(function() {
  const contactsState = { page: 1, search: '', filter: '' };
  let currentContact = null;
  let identityExamples = {};


  /**
   * How strongly we know who someone is. Shown prominently because an operator
   * about to discuss an account needs to know whether the identity was proven
   * or merely typed into a form.
   */
  const IDENTITY = {
    verified: { label: 'Verified', variant: 'success', help: 'Signed by your application — safe to discuss account details.' },
    claimed: { label: 'Self-reported', variant: 'warning text-dark', help: 'They typed this address. Anyone could type any address — do not treat it as proof.' },
    anonymous: { label: 'Anonymous', variant: 'secondary', help: 'A browser session only. Nothing identifies this person.' }
  };

  const identityBadge = level => {
    const meta = IDENTITY[level] || IDENTITY.anonymous;
    return `<span class="badge bg-${meta.variant}">${escapeHtml(meta.label)}</span>`;
  };

  // ------------------------------------------------------------------- list

  async function loadContacts(page = 1) {
    contactsState.page = page;

    const params = new URLSearchParams({ page: String(page), limit: '25' });
    if (contactsState.search) {
      params.set('search', contactsState.search);
    }
    if (contactsState.filter === 'verified') {
      params.set('verified', 'true');
    }

    const table = document.getElementById('contacts-table');
    table.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Loading…</td></tr>';

    try {
      const { contacts, pagination } = await api(`/api/contacts?${params.toString()}`);

      if (contacts.length === 0) {
        table.innerHTML = `
          <tr><td colspan="5" class="text-center text-muted py-4">
            ${contactsState.search ? 'Nobody matches that search.' : 'No people yet. They appear as visitors start conversations.'}
          </td></tr>`;
      } else {
        table.innerHTML = contacts.map(contact => `
          <tr>
            <td>
              <div class="fw-semibold">${escapeHtml(contact.name || contact.email || 'Anonymous visitor')}</div>
              <div class="small text-muted">${escapeHtml(contact.email || contact.phone || '—')}</div>
            </td>
            <td>${identityBadge(contact.identityLevel)}</td>
            <td class="text-end">${contact.conversationCount}</td>
            <td class="small text-muted">${escapeHtml(formatRelativeTime(contact.lastSeenAt))}</td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-primary view-contact-btn"
                      data-id="${escapeHtml(contact._id)}">View</button>
            </td>
          </tr>`).join('');

        table.querySelectorAll('.view-contact-btn').forEach(button => {
          button.addEventListener('click', () => openContact(button.dataset.id));
        });
      }

      renderPagination(pagination);
      document.getElementById('contacts-summary').textContent =
        `${pagination.total} ${pagination.total === 1 ? 'person' : 'people'}`;
    } catch (error) {
      table.innerHTML =
        `<tr><td colspan="5" class="text-danger text-center py-4">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  function renderPagination(pagination) {
    const nav = document.getElementById('contacts-pagination');
    const range = document.getElementById('contacts-range');

    const first = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
    range.textContent = pagination.total === 0
      ? ''
      : `Showing ${first}–${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total}`;

    if (pagination.totalPages <= 1) {
      nav.innerHTML = '';
      return;
    }

    const item = (label, page, disabled) => `
      <li class="page-item ${disabled ? 'disabled' : ''} ${page === pagination.page ? 'active' : ''}">
        <button class="page-link" data-page="${page}">${label}</button>
      </li>`;

    const pages = [];
    const start = Math.max(1, Math.min(pagination.page - 2, pagination.totalPages - 4));
    for (let p = start; p <= Math.min(pagination.totalPages, start + 4); p += 1) {
      pages.push(item(String(p), p, false));
    }

    nav.innerHTML = [
      item('&laquo;', pagination.page - 1, pagination.page === 1),
      ...pages,
      item('&raquo;', pagination.page + 1, pagination.page === pagination.totalPages)
    ].join('');

    nav.onclick = event => {
      const button = event.target.closest('[data-page]');
      if (button && !button.closest('.disabled')) {
        loadContacts(Number(button.dataset.page));
      }
    };
  }

  // ----------------------------------------------------------------- detail

  async function openContact(id) {
    try {
      const { contact, conversations } = await api(`/api/contacts/${encodeURIComponent(id)}`);
      currentContact = contact;

      document.getElementById('contacts-list-view').style.display = 'none';
      document.getElementById('contact-detail-view').style.display = '';

      document.getElementById('contact-detail-name').textContent =
        contact.name || contact.email || 'Anonymous visitor';

      const meta = IDENTITY[contact.identityLevel] || IDENTITY.anonymous;
      document.getElementById('contact-identity-banner').innerHTML = `
        <div class="alert alert-${contact.verified ? 'success' : 'warning'} py-2 px-3 mb-0 d-flex gap-2 align-items-start">
          ${identityBadge(contact.identityLevel)}
          <span class="small">${escapeHtml(meta.help)}</span>
        </div>`;

      document.getElementById('contact-edit-name').value = contact.name || '';
      document.getElementById('contact-edit-email').value = contact.email || '';
      document.getElementById('contact-edit-phone').value = contact.phone || '';
      document.getElementById('contact-edit-tags').value = (contact.tags || []).join(', ');

      const attributes = Object.entries(contact.attributes || {});
      document.getElementById('contact-attributes').innerHTML = attributes.length
        ? `<label class="form-label small">From your application</label>
           <dl class="row small mb-0">
             ${attributes.map(([key, value]) => `
               <dt class="col-sm-3 text-truncate">${escapeHtml(key)}</dt>
               <dd class="col-sm-9">${escapeHtml(value)}</dd>`).join('')}
           </dl>`
        : '';

      renderConversationHistory(conversations);
    } catch (error) {
      showToast(error.message, 'danger');
    }
  }

  function renderConversationHistory(conversations) {
    const container = document.getElementById('contact-conversations');

    if (!conversations.length) {
      container.innerHTML = '<p class="text-muted mb-0">No conversations yet.</p>';
      return;
    }

    container.innerHTML = `
      <div class="list-group list-group-flush">
        ${conversations.map(conversation => `
          <button type="button" class="list-group-item list-group-item-action open-conversation-btn"
                  data-session-id="${escapeHtml(conversation.sessionId)}">
            <div class="d-flex justify-content-between align-items-start gap-3">
              <div class="min-w-0">
                <div class="small text-truncate">${escapeHtml(conversation.lastMessage || 'No messages')}</div>
                <div class="small text-muted">
                  ${escapeHtml(formatRelativeTime(conversation.startedAt))} ·
                  ${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'}
                  ${conversation.operatorName ? ` · ${escapeHtml(conversation.operatorName)}` : ''}
                </div>
              </div>
              <span class="badge bg-${conversation.status === 'active' ? 'success' : 'secondary'}">
                ${escapeHtml(conversation.status)}
              </span>
            </div>
          </button>`).join('')}
      </div>`;

    container.querySelectorAll('.open-conversation-btn').forEach(button => {
      button.addEventListener('click', () => {
        // Reuse the existing transcript view rather than building a second one.
        if (typeof viewChatHistory === 'function') {
          viewChatHistory(button.dataset.sessionId);
        }
      });
    });
  }

  async function saveContact() {
    if (!currentContact) {
      return;
    }

    const button = document.getElementById('save-contact-btn');
    setLoading(button, true);

    try {
      const { contact } = await api(`/api/contacts/${encodeURIComponent(currentContact._id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: document.getElementById('contact-edit-name').value,
          email: document.getElementById('contact-edit-email').value,
          phone: document.getElementById('contact-edit-phone').value,
          tags: document.getElementById('contact-edit-tags').value
            .split(',').map(tag => tag.trim()).filter(Boolean)
        })
      });

      currentContact = contact;
      showToast('Person updated', 'success');
    } catch (error) {
      showToast(error.message, 'danger');
    } finally {
      setLoading(button, false);
    }
  }

  // ------------------------------------------------------ identity settings

  function renderIdentitySnippet() {
    const origin = window.location.origin;
    document.getElementById('identity-snippet').textContent = [
      '<script',
      `  src="${origin}/widget/js/widget-loader.js"`,
      '  data-widget-key="YOUR_WIDGET_KEY"',
      '  data-user-id="<%= user.id %>"',
      '  data-user-hash="<%= userHash %>"',
      '  defer><' + '/script>'
    ].join('\n');
  }

  async function loadIdentitySecret() {
    try {
      const { secret, examples } = await api('/api/contacts/identity/secret');
      identityExamples = examples;

      document.getElementById('identity-secret').value = secret;
      document.getElementById('identity-example').textContent = examples.node;
      renderIdentitySnippet();
    } catch (error) {
      // Operators without admin rights simply do not see this.
      logger.error('Could not load identity secret:', error);
    }
  }

  async function rotateSecret() {
    if (!confirm(
      'Rotate the identity secret?\n\n' +
      'Every hash your application has already generated stops working, so ' +
      'logged-in visitors become anonymous until you deploy the new secret.'
    )) {
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

  function setupIdentitySection() {
    if (!document.getElementById('identity-secret')) {
      return;
    }

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

    document.querySelectorAll('#identity-lang-tabs [data-lang]').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('#identity-lang-tabs [data-lang]')
          .forEach(other => other.classList.remove('active'));
        button.classList.add('active');
        document.getElementById('identity-example').textContent =
          identityExamples[button.dataset.lang] || '';
      });
    });

    loadIdentitySecret();
  }

  // ------------------------------------------------------------------ setup

  function setupContacts() {
    if (!document.getElementById('contacts-section')) {
      return;
    }

    document.getElementById('contact-search')
      .addEventListener('input', debounce(event => {
        contactsState.search = event.target.value.trim();
        loadContacts(1);
      }, 350));

    document.getElementById('contact-filter').addEventListener('change', event => {
      contactsState.filter = event.target.value;
      loadContacts(1);
    });

    document.getElementById('back-to-contacts-btn').addEventListener('click', () => {
      document.getElementById('contact-detail-view').style.display = 'none';
      document.getElementById('contacts-list-view').style.display = '';
    });

    document.getElementById('save-contact-btn').addEventListener('click', saveContact);

    // Loaded on demand; most sessions never open this tab.
    let loaded = false;
    const loadOnce = () => {
      if (!loaded) {
        loaded = true;
        loadContacts(1);
      }
    };

    document.querySelector('#sidebar .nav-link[data-section="contacts"]')
      ?.addEventListener('click', loadOnce);

    if (document.getElementById('contacts-section').classList.contains('active')) {
      loadOnce();
    }

    setupIdentitySection();
  }

  window.setupContacts = setupContacts;
  // Lets the conversation panel jump straight to this person's history.
  window.openContactById = openContact;
})();
