/**
 * History: every conversation, searchable, filterable and paged.
 *
 * A row opens the transcript. Deleting one is in the conversation view, for
 * admins - it used to sit on every row, for everybody, one slip away.
 */

import { channelBadge } from './channels-social.js';
import { openConversation } from './inbox.js';
import { registerSection } from './nav.js';
import { state } from './state.js';
import { api, debounce, downloadFile, errorMessage, escapeHtml, formatRelativeTime, logger, setLoading, showToast } from './utils.js';

// The endpoint returns a page at a time; an unpaginated list used to be capped
// at 100 rows by the server, so anything older was unreachable.
let chatHistoryState = { page: 1, search: '' };

/** Each load is numbered; an answer to an older one is ignored. */
let requestSequence = 0;

const COLUMNS = 8;

const OUTCOME_LABELS = {
  resolved: { label: 'Resolved', variant: 'success' },
  follow_up: { label: 'Needs follow-up', variant: 'primary' },
  unresolved: { label: 'Not resolved', variant: 'secondary' },
  spam: { label: 'Spam', variant: 'danger' }
};

/** Filter controls: element id -> query parameter. */
const FILTERS = {
  'history-channel': 'channel',
  'history-status': 'status',
  'history-handled-by': 'handledBy',
  'history-rating': 'rating',
  'history-outcome': 'outcome',
  'history-tag': 'tag'
};

/**
 * A date picked in the browser, as the instant that day starts or ends here.
 * The server compares instants; "the 3rd" means the 3rd where the person is.
 */
function dayBoundary(value, end) {
  if (!value) {
    return '';
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = end
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** The search and every filter, as query parameters. Shared with the export. */
function currentQuery() {
  const params = new URLSearchParams();
  if (chatHistoryState.search) {
    params.set('search', chatHistoryState.search);
  }
  Object.entries(FILTERS).forEach(([id, key]) => {
    const value = document.getElementById(id)?.value;
    if (value) {
      params.set(key, value);
    }
  });
  const from = dayBoundary(document.getElementById('history-from')?.value, false);
  const to = dayBoundary(document.getElementById('history-to')?.value, true);
  if (from) {
    params.set('from', from);
  }
  if (to) {
    params.set('to', to);
  }
  return params;
}

function ratingCell(rating) {
  if (!rating) {
    return '<span class="text-muted">—</span>';
  }
  const tone = rating >= 4 ? 'success' : rating <= 2 ? 'danger' : 'secondary';
  return `<span class="badge bg-${tone}">${escapeHtml(rating)}/5</span>`;
}

function historyRow(record) {
  const row = document.createElement('tr');
  row.className = 'history-row';
  row.tabIndex = 0;
  row.dataset.sessionId = record.sessionId;
  const messageCount = record.messageCount ?? (record.messages ? record.messages.length : 0);
  const name = record.userName || record.email || `Visitor ${record.sessionId.substring(0, 6)}`;
  const outcome = record.outcome ? OUTCOME_LABELS[record.outcome] : null;
  const handledBy = record.handledBy === 'person'
    ? escapeHtml((record.operators || []).join(', ') || 'A person')
    : '<span class="text-muted">The bot</span>';

  row.innerHTML = `
    <td>
      <a href="?section=active-chats&chat=${encodeURIComponent(record.sessionId)}" class="history-open">
        ${channelBadge(record.channel)}
        ${escapeHtml(name)}
      </a>
      <div class="small text-muted text-truncate">
        ${escapeHtml(record.subject || (record.email && record.email !== name ? record.email : '') || record.sessionId.substring(0, 8))}
      </div>
    </td>
    <td>
      ${escapeHtml(new Date(record.startedAt).toLocaleDateString())}
      <div class="small text-muted">${escapeHtml(formatRelativeTime(record.startedAt))}</div>
    </td>
    <td>${escapeHtml(calculateDuration(record.startedAt, record.endedAt))}</td>
    <td>${messageCount}</td>
    <td>${handledBy}</td>
    <td>${ratingCell(record.rating)}</td>
    <td>${outcome ? `<span class="badge text-bg-${outcome.variant}">${escapeHtml(outcome.label)}</span>` : '<span class="text-muted">—</span>'}</td>
    <td><span class="badge bg-${record.status === 'ended' ? 'secondary' : 'success'}">${escapeHtml(record.status === 'active' ? 'open' : record.status)}</span></td>`;
  return row;
}

export async function loadChatHistory(search = chatHistoryState.search, page = 1) {
  chatHistoryState = { page, search };
  const sequence = ++requestSequence;

  const params = currentQuery();
  params.set('page', String(page));
  params.set('limit', '25');

  const historyTable = document.getElementById('chat-history-table');
  historyTable.innerHTML = `
    <tr><td colspan="${COLUMNS}" class="text-center text-muted py-4">
      <span class="spinner-border spinner-border-sm me-2"></span>Loading…
    </td></tr>`;

  let data;
  try {
    data = await api(`/api/admin/chat-history?${params.toString()}`);
  } catch (error) {
    if (sequence !== requestSequence) {
      return;
    }
    logger.error('Error loading chat history:', error);
    historyTable.innerHTML = `
      <tr><td colspan="${COLUMNS}" class="text-center text-danger py-4">
        Could not load the history. <button type="button" class="btn btn-sm btn-link" id="chat-history-retry">Retry</button>
      </td></tr>`;
    historyTable.querySelector('#chat-history-retry')?.addEventListener('click', () => loadChatHistory());
    return;
  }

  // Typing "refund" sends five searches; the answer to "ref" arriving after
  // the answer to "refund" used to replace it.
  if (sequence !== requestSequence) {
    return;
  }

  const records = data.history || [];
  historyTable.innerHTML = '';

  const filtered = [...currentQuery().keys()].some(key => key !== 'search');
  if (records.length === 0) {
    historyTable.innerHTML = `
      <tr><td colspan="${COLUMNS}" class="text-center text-muted py-4">
        ${search
    ? `No conversations match “${escapeHtml(search)}”`
    : filtered ? 'No conversations match these filters.' : 'No conversations yet. They appear here once your widget is installed.'}
      </td></tr>`;
  } else {
    // Built off-document so the browser lays out once rather than per row.
    const fragment = document.createDocumentFragment();
    records.forEach(record => fragment.appendChild(historyRow(record)));
    historyTable.appendChild(fragment);
  }

  renderChatHistoryPagination(data.pagination);
}

function renderChatHistoryPagination(pagination) {
  const nav = document.getElementById('chat-history-pagination');
  const summary = document.getElementById('chat-history-summary');
  if (!nav || !summary || !pagination) {
    return;
  }

  const { page, limit, total, totalPages } = pagination;
  const first = total === 0 ? 0 : (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);
  summary.textContent = total === 0
    ? 'No conversations'
    : `Showing ${first}–${last} of ${total}`;

  if (totalPages <= 1) {
    nav.innerHTML = '';
    return;
  }

  // Window the page numbers so a tenant with 400 pages does not get 400 links.
  const windowSize = 5;
  const start = Math.max(1, Math.min(page - Math.floor(windowSize / 2), totalPages - windowSize + 1));
  const end = Math.min(totalPages, start + windowSize - 1);

  const item = (label, targetPage, { disabled = false, active = false } = {}) => `
    <li class="page-item ${disabled ? 'disabled' : ''} ${active ? 'active' : ''}">
      <button class="page-link" data-page="${targetPage}" ${disabled ? 'tabindex="-1"' : ''}>${label}</button>
    </li>`;

  const pages = [];
  for (let p = start; p <= end; p += 1) {
    pages.push(item(String(p), p, { active: p === page }));
  }

  nav.innerHTML = [
    item('&laquo;', page - 1, { disabled: page === 1 }),
    ...pages,
    item('&raquo;', page + 1, { disabled: page === totalPages })
  ].join('');

  nav.onclick = event => {
    const button = event.target.closest('[data-page]');
    if (!button || button.closest('.disabled')) {
      return;
    }
    loadChatHistory(chatHistoryState.search, parseInt(button.dataset.page, 10));
  };
}

// Calculate duration between two timestamps
function calculateDuration(start, end) {
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();

  const durationMs = endTime - startTime;
  const durationMinutes = Math.floor(durationMs / 60000);

  return durationMinutes + ' min';
}

/** The tags in use, for the tag filter. */
async function loadTagOptions() {
  const select = document.getElementById('history-tag');
  if (!select) {
    return;
  }
  try {
    const { tags } = await api('/api/admin/tags');
    const current = select.value;
    select.innerHTML = '<option value="">Any</option>' + (tags || []).slice(0, 50)
      .map(entry => `<option value="${escapeHtml(entry.tag)}">${escapeHtml(entry.tag)}</option>`).join('');
    select.value = current;
  } catch (error) {
    // The filter is a convenience.
  }
}

function setupHistory() {
  const table = document.getElementById('chat-history-table');

  // The whole row opens the transcript; ctrl/cmd-click on the name opens it
  // in a new tab, as a link should.
  table.addEventListener('click', event => {
    const row = event.target.closest('tr[data-session-id]');
    if (!row) {
      return;
    }
    if (event.target.closest('a') && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      return;
    }
    event.preventDefault();
    openConversation(row.dataset.sessionId);
  });
  table.addEventListener('keydown', event => {
    const row = event.target.closest('tr[data-session-id]');
    if (row && event.key === 'Enter') {
      openConversation(row.dataset.sessionId);
    }
  });

  const search = document.getElementById('chat-history-search');

  const run = () => {
    // Always restart at page 1: page 7 of the previous result set is usually
    // empty.
    loadChatHistory(search.value.trim(), 1);
  };

  document.getElementById('chat-history-search-btn').addEventListener('click', run);
  search.addEventListener('input', debounce(run, 350));
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });

  [...Object.keys(FILTERS), 'history-from', 'history-to'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', run);
  });

  // Admins only (the button is not on the page for anybody else). The file
  // holds exactly what the screen is showing.
  document.getElementById('export-btn')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    setLoading(button, true);
    try {
      const params = currentQuery();
      params.set('type', 'conversations');
      await downloadFile(`/api/admin/export?${params.toString()}`, `conversations-${new Date().toISOString().slice(0, 10)}.csv`);
      showToast('Export downloaded', 'success');
    } catch (error) {
      logger.error('Export failed:', error);
      showToast(errorMessage(error, 'Could not export conversations'), 'danger');
    } finally {
      setLoading(button, false);
    }
  });

  loadTagOptions();

  // A conversation deleted from its own view, here or by a colleague, leaves
  // the list too.
  state.socket?.on('conversation-deleted', data => {
    const visible = document.getElementById('chat-history-section')?.classList.contains('active');
    const listed = data && document.querySelector(`#chat-history-table tr[data-session-id="${CSS.escape(String(data.sessionId))}"]`);
    if (visible && listed) {
      loadChatHistory(chatHistoryState.search, chatHistoryState.page);
    } else if (listed) {
      listed.remove();
    }
  });
}

registerSection('chat-history', {
  setup: setupHistory,
  show: () => loadChatHistory()
});
