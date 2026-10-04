/**
 * History: every conversation, searchable and paged.
 */

import { openConversation } from './inbox.js';
import { registerSection } from './nav.js';
import { api, confirmDialog, debounce, downloadFile, errorMessage, escapeHtml, formatRelativeTime, logger, setLoading, showToast } from './utils.js';

// The endpoint returns a page at a time; an unpaginated list used to be capped
// at 100 rows by the server, so anything older was unreachable.
let chatHistoryState = { page: 1, search: '' };

function historyRow(record) {
  const row = document.createElement('tr');
  const messageCount = record.messageCount ?? (record.messages ? record.messages.length : 0);
  const name = record.userName || `Visitor ${record.sessionId.substring(0, 6)}`;

  row.innerHTML = `
    <td>
      <div>${escapeHtml(name)}</div>
      <span class="font-monospace small text-muted">${escapeHtml(record.sessionId.substring(0, 8))}</span>
    </td>
    <td>
      ${escapeHtml(new Date(record.startedAt).toLocaleDateString())}
      <div class="small text-muted">${escapeHtml(formatRelativeTime(record.startedAt))}</div>
    </td>
    <td>${escapeHtml(calculateDuration(record.startedAt, record.endedAt))}</td>
    <td>${messageCount}</td>
    <td><span class="badge bg-${record.status === 'ended' ? 'secondary' : 'success'}">${escapeHtml(record.status)}</span></td>
    <td class="text-nowrap text-end">
      <button class="btn btn-sm btn-outline-primary view-chat-btn" data-session-id="${escapeHtml(record.sessionId)}">Open</button>
      <button class="btn btn-sm btn-outline-danger delete-chat-btn" data-session-id="${escapeHtml(record.sessionId)}"
              aria-label="Delete this conversation">Delete</button>
    </td>`;
  return row;
}

export async function loadChatHistory(search = chatHistoryState.search, page = 1) {
  chatHistoryState = { page, search };

  const params = new URLSearchParams({ page: String(page), limit: '25' });
  if (search) {
    params.set('search', search);
  }

  const historyTable = document.getElementById('chat-history-table');
  historyTable.innerHTML = `
    <tr><td colspan="6" class="text-center text-muted py-4">
      <span class="spinner-border spinner-border-sm me-2"></span>Loading…
    </td></tr>`;

  let data;
  try {
    data = await api(`/api/admin/chat-history?${params.toString()}`);
  } catch (error) {
    logger.error('Error loading chat history:', error);
    historyTable.innerHTML = `
      <tr><td colspan="6" class="text-center text-danger py-4">
        Could not load the history. <button type="button" class="btn btn-sm btn-link" id="chat-history-retry">Retry</button>
      </td></tr>`;
    historyTable.querySelector('#chat-history-retry')?.addEventListener('click', () => loadChatHistory());
    return;
  }

  const records = data.history || [];
  historyTable.innerHTML = '';

  if (records.length === 0) {
    historyTable.innerHTML = `
      <tr><td colspan="6" class="text-center text-muted py-4">
        ${search ? `No conversations match “${escapeHtml(search)}”` : 'No conversations yet. They appear here once your widget is installed.'}
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

// Delete chat history
async function deleteChatHistory(sessionId) {
  const ok = await confirmDialog({
    title: 'Delete this conversation?',
    message: 'The transcript, its notes and its files are removed for good. This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) {
    return;
  }

  try {
    await api(`/api/admin/chat/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    loadChatHistory(chatHistoryState.search, chatHistoryState.page);
    showToast('Conversation deleted', 'success');
  } catch (error) {
    logger.error('Error deleting chat history:', error);
    showToast(errorMessage(error, 'Could not delete the conversation'), 'danger');
  }
}

// Calculate duration between two timestamps
function calculateDuration(start, end) {
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();

  const durationMs = endTime - startTime;
  const durationMinutes = Math.floor(durationMs / 60000);

  return durationMinutes + ' min';
}


function setupHistory() {
  // One delegated listener rather than two per row.
  document.getElementById('chat-history-table').addEventListener('click', event => {
    const view = event.target.closest('.view-chat-btn');
    const remove = event.target.closest('.delete-chat-btn');
    if (view) {
      openConversation(view.getAttribute('data-session-id'));
    } else if (remove) {
      deleteChatHistory(remove.getAttribute('data-session-id'));
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

  document.getElementById('export-btn').addEventListener('click', async event => {
    const button = event.currentTarget;
    setLoading(button, true);
    try {
      await downloadFile('/api/admin/export?type=conversations', `conversations-${new Date().toISOString().slice(0, 10)}.csv`);
      showToast('Export downloaded', 'success');
    } catch (error) {
      logger.error('Export failed:', error);
      showToast('Could not export conversations', 'danger');
    } finally {
      setLoading(button, false);
    }
  });
}

registerSection('chat-history', {
  setup: setupHistory,
  show: () => loadChatHistory()
});
