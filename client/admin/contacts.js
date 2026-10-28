/**
 * People: the customer rather than the conversation.
 *
 * Before this the product only knew about sessions, so an operator answering
 * somebody had no way to see what the same person asked last week, or on a
 * different device.
 */

import { channelBadge } from './channels-social.js';
import { openConversation } from './inbox.js';
import { registerSection, showSection } from './nav.js';
import { state } from './state.js';
import { api, confirmDialog, debounce, downloadFile, errorMessage, escapeHtml, formatRelativeTime, setLoading, showToast } from './utils.js';

const contactsState = { page: 1, search: '', filter: '', tag: '' };
let currentContact = null;
let currentConversations = [];


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

const VERIFIED_BY = {
  jwt: 'Signed in on your site',
  hmac: 'Signed in on your site',
  email_code: 'Email code'
};

const identityBadge = level => {
  const meta = IDENTITY[level] || IDENTITY.anonymous;
  return `<span class="badge bg-${meta.variant}">${escapeHtml(meta.label)}</span>`;
};

const personLabel = contact => contact.name || contact.email || contact.phone || 'Anonymous visitor';

function isAdmin() {
  const role = state.currentUser && state.currentUser.role;
  return role === 'company_admin' || role === 'superadmin';
}

// ------------------------------------------------------------------- list

function listParams() {
  const params = new URLSearchParams();
  if (contactsState.search) {
    params.set('search', contactsState.search);
  }
  if (contactsState.filter === 'verified') {
    params.set('verified', 'true');
  }
  if (contactsState.tag) {
    params.set('tag', contactsState.tag);
  }
  return params;
}

async function loadContacts(page = 1) {
  contactsState.page = page;

  const params = listParams();
  params.set('page', String(page));
  params.set('limit', '25');

  const table = document.getElementById('contacts-table');
  table.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Loading…</td></tr>';

  try {
    const { contacts, pagination } = await api(`/api/contacts?${params.toString()}`);

    if (contacts.length === 0) {
      table.innerHTML = `
        <tr><td colspan="5" class="text-center text-muted py-4">
          ${contactsState.search || contactsState.tag ? 'Nobody matches that.' : 'No people yet. They appear as visitors start conversations.'}
        </td></tr>`;
    } else {
      table.innerHTML = contacts.map(contact => `
        <tr class="contact-row" data-id="${escapeHtml(contact._id)}" tabindex="0">
          <td>
            <div class="fw-semibold">${escapeHtml(personLabel(contact))}</div>
            <div class="small text-muted">${escapeHtml(contact.email || contact.phone || '—')}</div>
            ${(contact.tags || []).length ? `<div class="tag-chips mt-1">${contact.tags.slice(0, 4)
    .map(tag => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
          </td>
          <td>${identityBadge(contact.identityLevel)}</td>
          <td class="text-end">${contact.conversationCount}</td>
          <td class="small text-muted">${escapeHtml(formatRelativeTime(contact.lastSeenAt))}</td>
          <td class="text-end">
            <button class="btn btn-sm btn-outline-primary view-contact-btn"
                    data-id="${escapeHtml(contact._id)}">View</button>
          </td>
        </tr>`).join('');
    }

    renderPagination(pagination);
    document.getElementById('contacts-summary').textContent =
      `${pagination.total} ${pagination.total === 1 ? 'person' : 'people'}`;
  } catch (error) {
    table.innerHTML =
      `<tr><td colspan="5" class="text-danger text-center py-4">${escapeHtml(errorMessage(error, 'Could not load people'))}</td></tr>`;
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

async function loadTagOptions() {
  const select = document.getElementById('contact-tag-filter');
  if (!select) {
    return;
  }
  try {
    const { tags } = await api('/api/contacts/tags');
    select.innerHTML = '<option value="">Any tag</option>' + (tags || [])
      .map(entry => `<option value="${escapeHtml(entry.tag)}">${escapeHtml(entry.tag)} (${entry.count})</option>`).join('');
    select.value = contactsState.tag;
  } catch (error) {
    // The filter is a convenience.
  }
}

function showList() {
  document.getElementById('contact-detail-view').style.display = 'none';
  document.getElementById('contacts-list-view').style.display = '';
  currentContact = null;
}

// ----------------------------------------------------------------- detail

async function openContact(id) {
  try {
    const { contact, conversations, timeline } = await api(`/api/contacts/${encodeURIComponent(id)}`);
    currentContact = contact;
    currentConversations = conversations || [];

    document.getElementById('contacts-list-view').style.display = 'none';
    document.getElementById('contact-detail-view').style.display = '';

    renderHeader(contact);

    document.getElementById('contact-edit-name').value = contact.name || '';
    document.getElementById('contact-edit-email').value = contact.email || '';
    document.getElementById('contact-edit-phone').value = contact.phone || '';
    document.getElementById('contact-edit-tags').value = (contact.tags || []).join(', ');
    hideDuplicateWarning();
    document.getElementById('contact-merge-panel').style.display = 'none';

    // Signed values came from the tenant's own server; the rest came from a
    // page anybody can edit, and are marked so nobody acts on them as fact.
    const attributes = contact.attributeList ||
      Object.entries(contact.attributes || {}).map(([key, value]) => ({ key, value, signed: false }));
    document.getElementById('contact-attributes').innerHTML = attributes.length
      ? `<label class="form-label small">From your application</label>
         <dl class="row small mb-0">
           ${attributes.map(({ key, value, signed }) => `
             <dt class="col-sm-3 text-truncate">${escapeHtml(key)}</dt>
             <dd class="col-sm-9">${escapeHtml(value)}
               ${signed ? '<span class="badge text-bg-success ms-1" title="Signed by your application">signed</span>'
    : '<span class="badge text-bg-light border ms-1" title="Sent by the page, not signed: do not rely on it">unsigned</span>'}</dd>`).join('')}
         </dl>`
      : '';

    renderConversationHistory(currentConversations);
    renderTimeline(timeline || []);
  } catch (error) {
    showToast(errorMessage(error, 'Could not open that person'), 'danger');
  }
}

function renderHeader(contact) {
  document.getElementById('contact-detail-name').textContent = personLabel(contact);

  const meta = IDENTITY[contact.identityLevel] || IDENTITY.anonymous;
  // Proven by an email code is weaker than signed by the tenant's own login:
  // it shows they can read that inbox, not that they are that account.
  const help = contact.verifiedBy === 'email_code'
    ? `Confirmed ${contact.email || 'their email'} with a code sent to it. Fine for their bookings and enquiries; for account changes, ask them to sign in to your site.`
    : meta.help;
  document.getElementById('contact-identity-banner').innerHTML = `
    <div class="alert alert-${contact.verified ? 'success' : 'warning'} py-2 px-3 mb-0 d-flex gap-2 align-items-start">
      ${identityBadge(contact.identityLevel)}
      ${contact.verifiedBy ? `<span class="badge text-bg-light border">${escapeHtml(VERIFIED_BY[contact.verifiedBy] || contact.verifiedBy)}</span>` : ''}
      <span class="small">${escapeHtml(help)}</span>
    </div>`;
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
                ${conversation.ratingScore ? ` · rated ${escapeHtml(conversation.ratingScore)}/5` : ''}
              </div>
            </div>
            <span class="badge bg-${conversation.status === 'active' ? 'success' : 'secondary'}">
              ${escapeHtml(conversation.status === 'active' ? 'open' : conversation.status)}
            </span>
          </div>
        </button>`).join('')}
    </div>`;
}

const OUTCOME_WORDS = {
  resolved: 'resolved',
  follow_up: 'needs follow-up',
  unresolved: 'not resolved',
  spam: 'spam'
};

/** Conversations, tasks and ratings in one line of time, newest first. */
function renderTimeline(entries) {
  const list = document.getElementById('contact-timeline');
  if (!entries.length) {
    list.innerHTML = '<li class="text-muted">Nothing yet.</li>';
    return;
  }

  list.innerHTML = entries.slice(0, 60).map(entry => {
    const when = `<span class="text-muted small" title="${escapeHtml(new Date(entry.at).toLocaleString())}">${escapeHtml(formatRelativeTime(entry.at))}</span>`;
    if (entry.type === 'conversation') {
      return `
        <li class="timeline-entry is-conversation">
          <button type="button" class="btn btn-link p-0 text-start open-conversation-btn" data-session-id="${escapeHtml(entry.sessionId)}">
            ${channelBadge(entry.channel)} ${entry.channel === 'email' ? 'Email' : 'Conversation'}: ${escapeHtml(entry.summary || 'no messages')}
          </button>
          <div class="small text-muted">${entry.messageCount} message${entry.messageCount === 1 ? '' : 's'}${entry.outcome ? ` · ${escapeHtml(OUTCOME_WORDS[entry.outcome] || entry.outcome)}` : ''} · ${when}</div>
        </li>`;
    }
    if (entry.type === 'rating') {
      return `
        <li class="timeline-entry is-rating">
          Rated a conversation <strong>${escapeHtml(entry.score)}/5</strong>${entry.comment ? `: “${escapeHtml(entry.comment)}”` : ''}
          <div>${when}</div>
        </li>`;
    }
    return `
      <li class="timeline-entry is-task">
        <button type="button" class="btn btn-link p-0 text-start open-task-btn" data-task-id="${escapeHtml(entry.taskId)}">
          Task: ${escapeHtml(entry.title)}
        </button>
        ${entry.createdByBot ? '<span class="badge text-bg-info ms-1">Bot</span>' : ''}
        <div class="small text-muted">${escapeHtml(entry.status === 'in_progress' ? 'in progress' : entry.status)}${entry.assignee ? ` · ${escapeHtml(entry.assignee)}` : ''} · ${when}</div>
      </li>`;
  }).join('');
}

function hideDuplicateWarning() {
  const warning = document.getElementById('contact-duplicate-warning');
  warning.style.display = 'none';
  warning.innerHTML = '';
}

/** Somebody else has this address: usually the same person twice. */
function showDuplicates(duplicates) {
  if (!duplicates || !duplicates.length) {
    hideDuplicateWarning();
    return;
  }
  const warning = document.getElementById('contact-duplicate-warning');
  warning.innerHTML = `
    ${duplicates.length === 1 ? 'Someone else has' : `${duplicates.length} other people have`} this email address:
    ${duplicates.map(duplicate => `
      <span class="d-inline-flex align-items-center gap-1 me-2">
        <strong>${escapeHtml(duplicate.name || duplicate.email)}</strong>
        (${duplicate.conversationCount} conversation${duplicate.conversationCount === 1 ? '' : 's'})
        <button type="button" class="btn btn-sm btn-link p-0" data-merge-id="${escapeHtml(duplicate._id)}"
                data-merge-label="${escapeHtml(duplicate.name || duplicate.email)}">Merge into this person</button>
      </span>`).join('')}`;
  warning.style.display = '';
}

async function saveContact() {
  if (!currentContact) {
    return;
  }

  const button = document.getElementById('save-contact-btn');
  setLoading(button, true);

  try {
    const { contact, duplicates } = await api(`/api/contacts/${encodeURIComponent(currentContact._id)}`, {
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
    // The header and the list said the old name until a reload.
    renderHeader(contact);
    showDuplicates(duplicates);
    loadContacts(contactsState.page);
    loadTagOptions();
    showToast('Person updated', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not save this person'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

// ------------------------------------------------------------------ merge

/**
 * Fold another person into this one: their conversations move here and their
 * record goes. Asked first, because it cannot be undone.
 */
async function mergeIn(sourceId, sourceLabel) {
  if (!currentContact || !sourceId || sourceId === currentContact._id) {
    return;
  }
  const ok = await confirmDialog({
    title: `Merge ${sourceLabel} into ${personLabel(currentContact)}?`,
    message: `${sourceLabel}'s conversations move to ${personLabel(currentContact)}, any details this person is missing are copied across, and ${sourceLabel}'s record is removed. This cannot be undone.`,
    confirmLabel: 'Merge',
    danger: true
  });
  if (!ok) {
    return;
  }

  try {
    await api(`/api/contacts/${encodeURIComponent(currentContact._id)}/merge`, {
      method: 'POST',
      body: { sourceId }
    });
    showToast('Merged', 'success');
    openContact(currentContact._id);
    loadContacts(contactsState.page);
  } catch (error) {
    showToast(errorMessage(error, 'Could not merge these people'), 'danger');
  }
}

async function searchForMerge(term) {
  const results = document.getElementById('contact-merge-results');
  if (!term) {
    results.innerHTML = '';
    return;
  }
  try {
    const params = new URLSearchParams({ search: term, limit: '8' });
    const { contacts } = await api(`/api/contacts?${params.toString()}`);
    const others = (contacts || []).filter(contact => currentContact && contact._id !== currentContact._id);
    results.innerHTML = others.length
      ? others.map(contact => `
          <button type="button" class="list-group-item list-group-item-action small"
                  data-merge-id="${escapeHtml(contact._id)}" data-merge-label="${escapeHtml(personLabel(contact))}">
            <strong>${escapeHtml(personLabel(contact))}</strong>
            <span class="text-muted">${escapeHtml(contact.email || contact.phone || '')} · ${contact.conversationCount} conversation${contact.conversationCount === 1 ? '' : 's'}</span>
          </button>`).join('')
      : '<div class="list-group-item small text-muted">Nobody else matches.</div>';
  } catch (error) {
    results.innerHTML = `<div class="list-group-item small text-danger">${escapeHtml(errorMessage(error, 'Search failed'))}</div>`;
  }
}

// --------------------------------------------------------- data protection

/** Everything held about this person, as the file they are entitled to. */
async function exportPersonData() {
  if (!currentContact) {
    return;
  }
  try {
    await downloadFile(`/api/gdpr/export/${encodeURIComponent(currentContact._id)}`,
      `person-${currentContact._id}.json`);
    showToast('Data exported', 'success');
  } catch (error) {
    showToast('Could not export this person\'s data', 'danger');
  }
}

/**
 * The right to be forgotten. The confirmation says exactly what goes, because
 * "delete" alone does not tell an admin that the files and webhook logs go
 * too, or that tasks are kept with the name taken off.
 */
async function erasePerson() {
  if (!currentContact) {
    return;
  }
  const label = personLabel(currentContact);
  const count = currentConversations.length;
  const ok = await confirmDialog({
    title: `Erase ${label}?`,
    message: [
      'This removes, for good:',
      `• ${count} conversation${count === 1 ? '' : 's'} with every message, note and file`,
      `• ${label}'s record in People`,
      '• the deliveries of their messages in your webhook log',
      'Tasks raised about them are kept, with their name, email and phone removed.',
      'Use this for a data protection erasure request. It cannot be undone.'
    ].join('\n'),
    confirmLabel: 'Erase everything',
    danger: true
  });
  if (!ok) {
    return;
  }

  try {
    const result = await api(`/api/gdpr/user-data/${encodeURIComponent(currentContact._id)}`, { method: 'DELETE' });
    showToast(`Erased: ${result.conversationsDeleted || 0} conversations, ${result.filesDeleted || 0} files`, 'success');
    showList();
    loadContacts(1);
  } catch (error) {
    showToast(errorMessage(error, 'Could not erase this person'), 'danger');
  }
}

// ------------------------------------------------------------------ setup

function setupContacts() {
  document.getElementById('contact-search')
    .addEventListener('input', debounce(event => {
      contactsState.search = event.target.value.trim();
      loadContacts(1);
    }, 350));

  document.getElementById('contact-filter').addEventListener('change', event => {
    contactsState.filter = event.target.value;
    loadContacts(1);
  });

  document.getElementById('contact-tag-filter').addEventListener('change', event => {
    contactsState.tag = event.target.value;
    loadContacts(1);
  });

  document.getElementById('contacts-table').addEventListener('click', event => {
    const row = event.target.closest('[data-id]');
    if (row) {
      openContact(row.dataset.id);
    }
  });
  document.getElementById('contacts-table').addEventListener('keydown', event => {
    const row = event.target.closest('tr[data-id]');
    if (row && event.key === 'Enter') {
      openContact(row.dataset.id);
    }
  });

  document.getElementById('back-to-contacts-btn').addEventListener('click', showList);
  document.getElementById('save-contact-btn').addEventListener('click', saveContact);

  // Past conversations, and timeline entries, open where they live.
  document.getElementById('contact-detail-view').addEventListener('click', event => {
    const conversation = event.target.closest('.open-conversation-btn');
    const task = event.target.closest('.open-task-btn');
    const merge = event.target.closest('[data-merge-id]');
    if (conversation) {
      openConversation(conversation.dataset.sessionId);
    } else if (task) {
      showSection('tasks', { params: { taskId: task.dataset.taskId } });
    } else if (merge) {
      mergeIn(merge.dataset.mergeId, merge.dataset.mergeLabel);
    }
  });

  document.getElementById('contact-merge-btn').addEventListener('click', () => {
    const panel = document.getElementById('contact-merge-panel');
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
    if (panel.style.display === '') {
      document.getElementById('contact-merge-search').focus();
    }
  });
  document.getElementById('contact-merge-search').addEventListener('input', debounce(event => {
    searchForMerge(event.target.value.trim());
  }, 300));

  // Admins only; the buttons are not on the page for anybody else.
  document.getElementById('contact-gdpr-export-btn')?.addEventListener('click', exportPersonData);
  document.getElementById('contact-gdpr-erase-btn')?.addEventListener('click', erasePerson);
  document.getElementById('contacts-export-btn')?.addEventListener('click', async event => {
    if (!isAdmin()) {
      return;
    }
    const button = event.currentTarget;
    setLoading(button, true);
    try {
      await downloadFile(`/api/contacts/export?${listParams().toString()}`, `people-${new Date().toISOString().slice(0, 10)}.csv`);
      showToast('Export downloaded', 'success');
    } catch (error) {
      showToast('Could not export people', 'danger');
    } finally {
      setLoading(button, false);
    }
  });

  loadTagOptions();
  // Loaded on demand; most sessions never open this tab.
  loadContacts(1);
}

registerSection('contacts', {
  setup: setupContacts,
  // The sidebar link goes back to the list - it used to leave whoever was
  // open on screen. A link to one person (from a conversation) opens them.
  show(params) {
    if (params && params.contact) {
      openContact(params.contact);
    } else {
      showList();
    }
  }
});

// Lets the conversation panel jump straight to this person's history.
export { openContact as openContactById };
