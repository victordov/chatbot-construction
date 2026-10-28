/**
 * Tags, the tag filter, and whether this operator is taking work.
 *
 * All three are about the same thing: a queue that distributes conversations
 * rather than leaving them to whoever happens to be looking.
 */

import { chatRecord, mergeChat, openConversation, refreshConversationControls } from './inbox.js';
import { alertPerson } from './notifications.js';
import { state } from './state.js';
import { api, errorMessage, escapeHtml, logger, showToast } from './utils.js';

let knownTags = [];
let activeTagFilter = null;


// -------------------------------------------------------------- tagging

/**
 * The tags on the conversation currently open.
 *
 * Sent as the whole list rather than as add/remove: the UI is a set of chips
 * being edited, and two operators looking at the same conversation would
 * otherwise need conflict handling for something this small.
 */
function renderTags(tags) {
  const panel = document.getElementById('tags-panel');
  const chips = document.getElementById('tag-chips');

  if (!panel || !chips) {
    return;
  }

  const conversation = state.currentConversation;
  panel.style.display = conversation ? 'block' : 'none';

  if (!conversation) {
    return;
  }

  const current = tags || conversation.tags || [];

  chips.innerHTML = current.length
    ? current.map(tag => `
        <span class="tag-chip">
          ${escapeHtml(tag)}
          <button type="button" class="tag-chip-remove" data-remove-tag="${escapeHtml(tag)}"
                  aria-label="Remove ${escapeHtml(tag)}">&times;</button>
        </span>`).join('')
    : '<span class="text-muted small">No tags yet</span>';

  chips.querySelectorAll('[data-remove-tag]').forEach(button => {
    button.addEventListener('click', () => {
      saveTags(current.filter(tag => tag !== button.dataset.removeTag));
    });
  });
}

async function saveTags(tags) {
  const conversation = state.currentConversation;
  if (!conversation) {
    return;
  }

  try {
    const result = await api(`/api/admin/chat/${encodeURIComponent(conversation.sessionId)}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tags })
    });

    conversation.tags = result.tags;
    renderTags(result.tags);
    if (chatRecord(conversation.sessionId)) {
      mergeChat(conversation.sessionId, { tags: result.tags });
    }
    // A new tag should be offered to the next person immediately.
    loadKnownTags();
  } catch (error) {
    showToast(errorMessage(error, 'Could not save the tags'), 'danger');
  }
}

function addTagFromInput() {
  const input = document.getElementById('tag-input');
  const value = (input.value || '').trim();

  if (!value) {
    return;
  }

  const current = (state.currentConversation && state.currentConversation.tags) || [];
  saveTags([...current, value]);
  input.value = '';
}

/**
 * The tags this company already uses.
 *
 * Offered as a datalist while typing. This is what stops "billing",
 * "Billing" and "billin" all ending up in the same account.
 */
async function loadKnownTags() {
  try {
    const { tags } = await api('/api/admin/tags');
    knownTags = tags || [];

    const list = document.getElementById('tag-suggestions');
    if (list) {
      list.innerHTML = knownTags
        .map(entry => `<option value="${escapeHtml(entry.tag)}">`).join('');
    }

    renderTagFilter();
  } catch {
    // Suggestions are a convenience; failing to load them should not break
    // tagging itself.
  }
}

// --------------------------------------------------------------- filter

function renderTagFilter() {
  const container = document.getElementById('queue-tag-filter');
  if (!container) {
    return;
  }

  if (knownTags.length === 0) {
    // An empty filter control is clutter on an account that does not tag.
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  container.innerHTML = `
    <select class="form-select form-select-sm" id="queue-tag-select" aria-label="Filter by tag">
      <option value="">Any tag</option>
      ${knownTags.slice(0, 30).map(entry => `
        <option value="${escapeHtml(entry.tag)}" ${entry.tag === activeTagFilter ? 'selected' : ''}>
          ${escapeHtml(entry.tag)} (${entry.count})
        </option>`).join('')}
    </select>`;

  container.querySelector('#queue-tag-select').addEventListener('change', event => {
    activeTagFilter = event.target.value || null;
    applyTagFilter();
  });
}

/**
 * Hide queue entries that do not carry the chosen tag.
 *
 * Done in the DOM rather than by refetching: the queue is already live over
 * the socket, and a refetch would fight with it.
 */
export function applyTagFilter() {
  document.querySelectorAll('#active-chat-list .list-group-item[data-session-id]').forEach(item => {
    if (!activeTagFilter) {
      item.classList.remove('filtered-by-tag');
      return;
    }

    const tags = (item.dataset.tags || '').split(',').filter(Boolean);
    item.classList.toggle('filtered-by-tag', !tags.includes(activeTagFilter));
  });
}

// --------------------------------------------------------- availability

async function setAccepting(accepting) {
  try {
    await api('/api/admin/me/availability', {
      method: 'PUT',
      body: JSON.stringify({ acceptingChats: accepting })
    });

    showToast(
      accepting
        ? 'You are taking new conversations again'
        : 'You will not be given new conversations',
      accepting ? 'success' : 'secondary'
    );
  } catch (error) {
    showToast(errorMessage(error, 'Could not change your availability'), 'danger');
    // Put the switch back: leaving it showing a state the server rejected is
    // worse than the failure itself, because the operator would believe they
    // had stopped receiving work.
    const toggle = document.getElementById('accepting-chats-toggle');
    if (toggle) {
      toggle.checked = !accepting;
    }
  }
}

/**
 * Start the switch where the server has it. It used to start "on" for
 * everybody, so somebody who switched off yesterday looked available while
 * the queue skipped them.
 */
async function loadAvailability() {
  const toggle = document.getElementById('accepting-chats-toggle');
  if (!toggle) {
    return;
  }
  try {
    const { acceptingChats } = await api('/api/admin/me/availability');
    toggle.checked = acceptingChats !== false;
  } catch (error) {
    logger.warn('Could not load availability', error);
  }
}

// ----------------------------------------------------------------- init

export function setupTags(socket) {
  document.getElementById('add-tag-btn')?.addEventListener('click', addTagFromInput);

  document.getElementById('tag-input')?.addEventListener('keypress', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addTagFromInput();
    }
  });

  document.getElementById('accepting-chats-toggle')?.addEventListener('change', event => {
    setAccepting(event.target.checked);
  });

  loadKnownTags();
  loadAvailability();

  if (socket) {
    socket.on('conversation-tagged', data => {
      if (state.currentConversation &&
          state.currentConversation.sessionId === data.sessionId) {
        state.currentConversation.tags = data.tags;
        renderTags(data.tags);
      }

      // The row is drawn from the queue's record, so the record changes.
      if (chatRecord(data.sessionId)) {
        mergeChat(data.sessionId, { tags: data.tags || [] });
      }
    });

    // The queue (or a colleague) gave this person a conversation. It used to
    // say only "a conversation has been assigned to you" - which one, and
    // where, was left to a hunt through the queue.
    socket.on('chat-assigned-to-you', data => {
      const sessionId = data && data.sessionId;
      if (!sessionId) {
        return;
      }
      const me = state.currentUser ? String(state.currentUser.id) : '';
      const myName = state.currentUser ? (state.currentUser.displayName || state.currentUser.username) : '';
      const record = chatRecord(sessionId);
      if (record) {
        mergeChat(sessionId, { operatorId: me, operatorName: myName });
      }
      if (state.currentConversation && state.currentConversation.sessionId === sessionId) {
        state.currentConversation.operatorId = me;
        state.currentConversation.operatorName = myName;
        refreshConversationControls();
      }

      const name = (record && record.visitorName) || 'A visitor';
      alertPerson({
        kind: 'assignment',
        key: `assignment:${sessionId}`,
        title: `${name}'s conversation was assigned to you`,
        open: () => openConversation(sessionId)
      });
    });

    // "Somebody wants a person" is the inbox's (inbox.js), where the queue
    // and the handover strip are.
  }
}

export { renderTags as renderConversationTags };
