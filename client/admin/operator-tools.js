/**
 * The tools an operator uses all shift: saved replies, internal notes,
 * transferring a chat, and working several conversations at once.
 *
 * None of this existed before. An operator who picked up a chat they could not
 * resolve had to abandon it and hope a colleague noticed, had nowhere to write
 * down what they had learned, and retyped the same answers by hand.
 */

import * as bootstrap from 'bootstrap';
import { chatRecord, confirmOverride, mergeChat, openConversation, refreshConversationControls, selectedSessionId } from './inbox.js';
import { alertPerson } from './notifications.js';
import { state } from './state.js';
import { api, debounce, errorMessage, escapeHtml, formatRelativeTime, logger, setLoading, showToast } from './utils.js';

let cannedReplies = [];
let currentNotes = [];
let chatFilter = 'all';
let queueSearch = '';


// ------------------------------------------------------------ saved replies

async function loadCannedReplies() {
  try {
    const result = await api('/api/templates/mine');
    cannedReplies = result.templates || [];
  } catch (error) {
    // Not fatal: the operator can still type.
    logger.error('Could not load saved replies:', error);
    cannedReplies = [];
  }
}

function renderPicker(query = '') {
  const picker = document.getElementById('canned-reply-picker');
  const term = query.trim().toLowerCase();

  const matches = term
    ? cannedReplies.filter(reply =>
      reply.name.toLowerCase().includes(term) || reply.text.toLowerCase().includes(term))
    : cannedReplies;

  if (matches.length === 0) {
    picker.innerHTML = cannedReplies.length === 0
      ? `<div class="canned-empty">
           No saved replies yet. An admin can add them under <strong>Assistant</strong>.
         </div>`
      : '<div class="canned-empty">Nothing matches that.</div>';
    picker.style.display = 'block';
    return;
  }

  picker.innerHTML = matches.map((reply, index) => `
    <button type="button" class="canned-item ${index === 0 ? 'is-active' : ''}" role="option"
            aria-selected="${index === 0 ? 'true' : 'false'}"
            data-reply-index="${cannedReplies.indexOf(reply)}">
      <span class="canned-name">${escapeHtml(reply.name)}</span>
      <span class="canned-text">${escapeHtml(reply.text)}</span>
    </button>`).join('');

  picker.style.display = 'block';

  picker.querySelectorAll('[data-reply-index]').forEach(button => {
    button.addEventListener('click', () => {
      insertReply(cannedReplies[Number(button.dataset.replyIndex)]);
    });
  });
}

function hidePicker() {
  document.getElementById('canned-reply-picker').style.display = 'none';
}

/** Move the highlighted saved reply up or down, keeping it in view. */
function moveSelection(step) {
  const items = [...document.querySelectorAll('#canned-reply-picker [data-reply-index]')];
  if (items.length === 0) {
    return;
  }
  const current = items.findIndex(item => item.classList.contains('is-active'));
  const next = (current + step + items.length) % items.length;
  items.forEach((item, index) => {
    item.classList.toggle('is-active', index === next);
    item.setAttribute('aria-selected', index === next ? 'true' : 'false');
  });
  items[next].scrollIntoView({ block: 'nearest' });
}

/**
 * Fill in `{name}`, `{email}` and `{operator}`.
 *
 * A saved reply that says "Hi {name}" used to go to the customer exactly like
 * that. Whatever is not known reads naturally rather than leaving a gap.
 */
export function fillPlaceholders(text, { name, email, operator } = {}) {
  return String(text || '')
    .replace(/\{\s*name\s*\}/gi, name || 'there')
    .replace(/\{\s*email\s*\}/gi, email || 'your email address')
    .replace(/\{\s*operator\s*\}/gi, operator || 'our team');
}

function placeholderValues() {
  const conversation = state.currentConversation || {};
  const metadata = conversation.metadata instanceof Map
    ? Object.fromEntries(conversation.metadata)
    : (conversation.metadata || {});
  const user = state.currentUser || {};
  const firstName = metadata.name ? String(metadata.name).trim().split(/\s+/)[0] : '';
  return {
    name: firstName,
    email: metadata.email || conversation.followUpEmail || (conversation.email && conversation.email.from) || '',
    operator: user.displayName || user.username || ''
  };
}

/**
 * Put the reply in the composer rather than sending it.
 *
 * Deliberate: an operator almost always wants to adjust a canned reply
 * before it goes out, and sending on click would make a misclick visible to
 * the customer.
 */
function insertReply(reply) {
  if (!reply) {
    return;
  }

  const input = document.getElementById('operator-message');
  input.value = fillPlaceholders(reply.text, placeholderValues());
  hidePicker();
  input.focus();
  // Cursor at the end, ready to edit.
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event('input'));
}

function setupCannedReplies() {
  const input = document.getElementById('operator-message');
  const picker = document.getElementById('canned-reply-picker');

  document.getElementById('canned-reply-btn').addEventListener('click', () => {
    if (picker.style.display === 'block') {
      hidePicker();
    } else {
      renderPicker();
    }
  });

  input.addEventListener('input', event => {
    const value = event.target.value;

    // "/" at the start of an empty-ish composer opens the picker and filters
    // as they keep typing.
    if (value.startsWith('/')) {
      renderPicker(value.slice(1));
    } else {
      hidePicker();
    }
  });

  input.addEventListener('keydown', event => {
    if (picker.style.display !== 'block') {
      return;
    }

    if (event.key === 'Escape') {
      hidePicker();
      return;
    }

    // Up and down move through the matches, as in any picker.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    // Enter picks the highlighted match instead of sending "/refund" as a
    // message.
    if (event.key === 'Enter' || event.key === 'Tab') {
      const chosen = picker.querySelector('[data-reply-index].is-active') ||
        picker.querySelector('[data-reply-index]');
      if (chosen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        insertReply(cannedReplies[Number(chosen.dataset.replyIndex)]);
      }
    }
  }, true);

  document.addEventListener('click', event => {
    if (!event.target.closest('#canned-reply-picker, #canned-reply-btn, #operator-message')) {
      hidePicker();
    }
  });
}

// -------------------------------------------------------------------- notes

function renderNotes() {
  const list = document.getElementById('notes-list');
  document.getElementById('notes-count').textContent = currentNotes.length;

  if (currentNotes.length === 0) {
    list.innerHTML = '<div class="text-muted small">No notes on this conversation yet.</div>';
    return;
  }

  const myId = state.currentUser ? String(state.currentUser.id) : '';
  const admin = state.currentUser && ['company_admin', 'superadmin'].includes(state.currentUser.role);

  list.innerHTML = currentNotes.map(note => `
    <div class="note-item ${note.system ? 'is-system' : ''}">
      <div class="note-body">${escapeHtml(note.body)}</div>
      <div class="note-meta">
        ${escapeHtml(note.authorName || 'Unknown')} ·
        ${escapeHtml(formatRelativeTime(note.createdAt))}
        ${!note.system && note._id && (admin || String(note.author || '') === myId) ? `
          <button class="btn btn-link btn-sm p-0 ms-2 delete-note-btn"
                  data-note-id="${escapeHtml(note._id)}">delete</button>` : ''}
      </div>
    </div>`).join('');

  list.querySelectorAll('.delete-note-btn').forEach(button => {
    button.addEventListener('click', () => deleteNote(button.dataset.noteId));
  });
}

/** Called when a conversation is opened; notes arrive with it. */
function setNotes(notes) {
  currentNotes = (notes || []).map(note => ({ ...note, _id: note._id ? String(note._id) : note._id }));
  renderNotes();
}

/**
 * Add a note to the list once. The author hears about their own note twice -
 * from the response and from the broadcast - and it used to appear twice.
 */
function rememberNote(note) {
  if (!note) {
    return;
  }
  const id = note._id ? String(note._id) : null;
  if (id && currentNotes.some(existing => String(existing._id) === id)) {
    return;
  }
  currentNotes.push({ ...note, _id: id });
  renderNotes();
}

async function addNote() {
  const input = document.getElementById('note-input');
  const body = input.value.trim();
  const sessionId = selectedSessionId();

  if (!body || !sessionId) {
    return;
  }

  try {
    const result = await api(`/api/admin/chat/${encodeURIComponent(sessionId)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body })
    });

    input.value = '';
    if (selectedSessionId() === sessionId) {
      rememberNote(result.note);
    }
  } catch (error) {
    showToast(errorMessage(error, 'Could not add the note'), 'danger');
  }
}

async function deleteNote(noteId) {
  const sessionId = selectedSessionId();
  if (!sessionId || !noteId) {
    return;
  }

  try {
    await api(`/api/admin/chat/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(noteId)}`, {
      method: 'DELETE'
    });
    currentNotes = currentNotes.filter(note => String(note._id) !== String(noteId));
    renderNotes();
  } catch (error) {
    showToast(errorMessage(error, 'Could not delete the note'), 'danger');
  }
}

function setupNotes() {
  document.getElementById('add-note-btn').addEventListener('click', addNote);

  document.getElementById('note-input').addEventListener('keypress', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addNote();
    }
  });
}

// ----------------------------------------------------------------- transfer

let transferForce = false;

/**
 * Who it could go to, and whether each of them could take it now.
 *
 * Company admins answer chats too, and are offered. Somebody offline, or not
 * taking conversations, is shown but cannot be chosen: the server refuses a
 * transfer to them, because a customer handed to an empty desk waits for
 * nobody.
 */
async function openTransfer() {
  const sessionId = selectedSessionId();
  if (!sessionId) {
    return;
  }

  const override = await confirmOverride('transfer');
  if (!override.ok) {
    return;
  }
  transferForce = override.force;

  const select = document.getElementById('transfer-operator');
  const hint = document.getElementById('transfer-presence-hint');
  const confirm = document.getElementById('confirm-transfer-btn');
  select.innerHTML = '<option value="">Loading…</option>';
  hint.textContent = '';
  confirm.disabled = true;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('transferModal')).show();

  try {
    const { operators } = await api(`/api/admin/chat/${encodeURIComponent(sessionId)}/transfer-targets`);
    const people = operators || [];
    const available = people.filter(person => person.online && person.accepting);

    const label = person => {
      const role = person.role === 'company_admin' ? ' (admin)' : '';
      const status = !person.online
        ? 'offline'
        : !person.accepting ? 'not taking chats' : `online · ${person.load} open`;
      return `${person.displayName}${role} — ${status}`;
    };

    select.innerHTML = people.length
      ? people.map(person => `
          <option value="${escapeHtml(person._id)}" ${person.online && person.accepting ? '' : 'disabled'}>
            ${escapeHtml(label(person))}
          </option>`).join('')
      : '<option value="">Nobody else on your team yet</option>';

    if (available.length) {
      select.value = available[0]._id;
    } else {
      select.value = '';
    }
    hint.textContent = people.length && !available.length
      ? 'Nobody else is online and taking conversations right now. Leave it in the queue instead.'
      : '';
    confirm.disabled = available.length === 0;
  } catch (error) {
    select.innerHTML = '<option value="">Could not load your colleagues</option>';
    showToast(errorMessage(error, 'Could not load your colleagues'), 'danger');
  }
}

async function confirmTransfer() {
  const sessionId = selectedSessionId();
  const operatorId = document.getElementById('transfer-operator').value;
  const note = document.getElementById('transfer-note').value.trim();
  const button = document.getElementById('confirm-transfer-btn');

  if (!sessionId || !operatorId) {
    return;
  }

  setLoading(button, true);
  try {
    const result = await api(`/api/admin/chat/${encodeURIComponent(sessionId)}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ operatorId, note: note || undefined, force: transferForce || undefined })
    });

    bootstrap.Modal.getOrCreateInstance(document.getElementById('transferModal')).hide();
    document.getElementById('transfer-note').value = '';
    showToast(`Transferred to ${result.operatorName}`, 'success');

    // It is no longer this operator's chat.
    const holder = { operatorId: String(result.operatorId || operatorId), operatorName: result.operatorName };
    if (chatRecord(sessionId)) {
      mergeChat(sessionId, holder);
    }
    if (state.currentConversation && state.currentConversation.sessionId === sessionId) {
      Object.assign(state.currentConversation, holder);
      refreshConversationControls();
    }
  } catch (error) {
    // The server says why: offline, not taking chats, somebody else's.
    showToast(errorMessage(error, 'Could not transfer the conversation'), 'danger');
  } finally {
    setLoading(button, false);
    transferForce = false;
  }
}

function setupTransfer() {
  document.getElementById('transfer-chat-btn').addEventListener('click', openTransfer);
  document.getElementById('confirm-transfer-btn').addEventListener('click', confirmTransfer);
}

// ------------------------------------------------------------ multiple chats

/**
 * Show only the conversations matching the current filter and search, and
 * keep the counts honest.
 *
 * "Mine" is what the server says this person holds and "Waiting" is somebody
 * who wants a person and has nobody; the rows carry both (inbox.js). "Mine"
 * used to mean "joined in this browser", and "Waiting" every conversation the
 * bot was handling.
 */
export function applyChatFilter() {
  const list = document.getElementById('active-chat-list');
  if (!list) {
    return;
  }
  const items = list.querySelectorAll('a[data-session-id]');
  let mine = 0;
  let waiting = 0;
  let visible = 0;

  items.forEach(item => {
    const isMine = item.dataset.mine === '1';
    const isWaiting = item.dataset.waiting === '1';

    if (isMine) {
      mine += 1;
    }
    if (isWaiting) {
      waiting += 1;
    }

    const show =
      (chatFilter === 'all' ||
        (chatFilter === 'mine' && isMine) ||
        (chatFilter === 'unassigned' && isWaiting)) &&
      (!queueSearch || (item.dataset.search || '').includes(queueSearch));

    item.style.display = show ? '' : 'none';
    if (show) {
      visible += 1;
    }
  });

  document.getElementById('queue-count').textContent = items.length;
  document.getElementById('mine-count').textContent = mine;
  document.getElementById('waiting-count').textContent = waiting;

  const empty = list.querySelector('.empty-state');
  if (empty) {
    empty.style.display = items.length === 0 ? '' : 'none';
  }

  // An empty filtered view needs its own message, or it looks broken.
  let notice = document.getElementById('filter-empty-notice');
  if (items.length > 0 && visible === 0) {
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'filter-empty-notice';
      notice.className = 'list-group-item text-muted small text-center';
      list.appendChild(notice);
    }
    notice.textContent = queueSearch
      ? 'No conversation matches that search.'
      : chatFilter === 'mine'
        ? 'You are not in any conversations.'
        : 'Nobody is waiting for a person.';
    notice.style.display = '';
  } else if (notice) {
    notice.style.display = 'none';
  }
}

function setupChatFilter() {
  document.querySelectorAll('[data-chat-filter]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-chat-filter]').forEach(other =>
        other.classList.remove('active'));
      button.classList.add('active');
      chatFilter = button.dataset.chatFilter;
      applyChatFilter();
    });
  });

  document.getElementById('queue-search')?.addEventListener('input', debounce(event => {
    queueSearch = event.target.value.trim().toLowerCase();
    applyChatFilter();
  }, 150));
}

// -------------------------------------------------------------------- setup

export function setupOperatorTools(socket) {
  if (!document.getElementById('active-chat-list')) {
    return;
  }

  setupCannedReplies();
  setupNotes();
  setupTransfer();
  setupChatFilter();
  loadCannedReplies();

  if (socket) {
    // A colleague added a note to the chat currently open.
    socket.on('conversation-note', data => {
      if (data && data.sessionId === selectedSessionId()) {
        rememberNote(data.note);
      }
    });

    socket.on('conversation-note-deleted', data => {
      if (data && data.sessionId === selectedSessionId()) {
        currentNotes = currentNotes.filter(note => String(note._id) !== String(data.noteId));
        renderNotes();
      }
    });

    socket.on('chat-assigned', data => {
      if (!data || !data.sessionId) {
        return;
      }
      const holder = {
        operatorId: data.operatorId ? String(data.operatorId) : null,
        operatorName: data.operatorName || null
      };
      if (chatRecord(data.sessionId)) {
        mergeChat(data.sessionId, holder);
      }
      if (data.sessionId === selectedSessionId() && state.currentConversation) {
        Object.assign(state.currentConversation, holder);
        refreshConversationControls();
        const me = state.currentUser ? String(state.currentUser.id) : '';
        const myName = state.currentUser ? (state.currentUser.displayName || state.currentUser.username) : '';
        // Whoever handed it over has already been told.
        if (holder.operatorId !== me && data.from !== myName) {
          showToast(`This conversation is now with ${data.operatorName}`, 'info');
        }
      }
    });

    // Being handed a chat is worth interrupting for.
    socket.on('chat-transferred-to-you', data => {
      if (!data || !data.sessionId) {
        return;
      }
      const me = state.currentUser ? String(state.currentUser.id) : '';
      const myName = state.currentUser ? (state.currentUser.displayName || state.currentUser.username) : '';
      if (chatRecord(data.sessionId)) {
        mergeChat(data.sessionId, { operatorId: me, operatorName: myName });
      }
      // Into the conversation's room, so typing and messages arrive here.
      // Already ours on the server, so this is a quiet re-join.
      socket.emit('operator-takeover', { sessionId: data.sessionId });

      alertPerson({
        kind: 'transfer',
        key: `transfer:${data.sessionId}`,
        title: `${data.from || 'A colleague'} transferred a conversation to you`,
        body: data.note || '',
        open: () => openConversation(data.sessionId)
      });
    });
  }

  applyChatFilter();
}

export { setNotes as setConversationNotes };
