/**
 * Live chats: the queue, the open conversation, and the customer beside it.
 *
 * One function opens a conversation, whether it was clicked in the queue,
 * reached from History, People or a notification, or restored from the URL;
 * there used to be two copies of that logic that had drifted apart.
 *
 * On a phone the three panes become one at a time: the list, then the
 * conversation with a back button, with details over it on demand.
 */

import { openContactById } from './contacts.js';
import { registerSection, showSection } from './nav.js';
import { applyChatFilter, setConversationNotes } from './operator-tools.js';
import { saveJoinedChats, state } from './state.js';
import { addSuggestionButton, setSuggestionButtons, setupSuggestionEventHandlers } from './suggestions.js';
import { applyTagFilter, renderConversationTags } from './tags.js';
import { api, apiFetch, confirmDialog, downloadFile, errorMessage, escapeHtml, logger, safeHref, showToast, updateUrlWithParams } from './utils.js';

let selected = null;

/** Session id of the conversation open in the inbox, or null. */
export function selectedSessionId() {
  return selected;
}

const $ = id => document.getElementById(id);

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

// --------------------------------------------------------------- the queue

function listItem(sessionId) {
  return document.querySelector(`#active-chat-list [data-session-id="${CSS.escape(sessionId)}"]`);
}

function displayName(chat) {
  const metadata = chat.metadata || {};
  return chat.userName || metadata.name || (metadata.get && metadata.get('name')) || null;
}

/**
 * Keep every count that depends on the queue in step: Home's numbers, the
 * sidebar badge, and the filter buttons.
 */
function refreshCounts() {
  const items = document.querySelectorAll('#active-chat-list [data-session-id]');
  const waiting = document.querySelectorAll('#active-chat-list [data-session-id] .status-indicator.no-operator').length;

  const set = (id, value) => {
    const element = $(id);
    if (element) {
      element.textContent = String(value);
    }
  };
  set('active-chats-count', items.length);
  set('home-waiting-count', waiting);

  const badge = $('nav-waiting-count');
  if (badge) {
    badge.textContent = String(waiting);
    badge.classList.toggle('d-none', waiting === 0);
  }

  if (items.length === 0 && !document.querySelector('#active-chat-list .empty-state')) {
    $('active-chat-list').innerHTML = '<div class="list-group-item empty-state">No active conversations</div>';
  }

  applyChatFilter();
  applyTagFilter();
}

/** Add a conversation to the queue, or refresh its row if it is there. */
export function addChatToList(chat) {
  const chatList = $('active-chat-list');
  chatList.querySelector('.empty-state')?.remove();

  const existing = listItem(chat.sessionId);
  const chatItem = existing || document.createElement('a');
  chatItem.href = `?section=active-chats&chat=${encodeURIComponent(chat.sessionId)}`;
  chatItem.className = 'list-group-item list-group-item-action inbox-item';
  chatItem.setAttribute('data-session-id', chat.sessionId);
  // Read by the tag filter, which hides rows in place rather than refetching
  // a queue that is already live over the socket.
  chatItem.dataset.tags = (chat.tags || []).join(',');
  if (selected === chat.sessionId) {
    chatItem.classList.add('active');
  }

  const started = new Date(chat.startedAt || Date.now());
  const hasOperator = Boolean(chat.hasOperator || state.joinedChats.has(chat.sessionId));
  const name = displayName(chat);
  const messageCount = chat.messageCount ?? (chat.messages ? chat.messages.length : 0);

  // The visitor's name, domain and operator name all originate from untrusted
  // input, so every interpolation is escaped.
  chatItem.innerHTML = `
    <div class="d-flex w-100 justify-content-between align-items-start gap-2">
      <span class="inbox-item-name text-truncate">
        <span class="status-indicator ${hasOperator ? 'has-operator' : 'no-operator'}"
              title="${hasOperator ? 'A person is in this conversation' : 'Waiting for a person'}"></span>
        ${chat.channel === 'email' ? '<span class="channel-badge" title="Email">✉</span>' : ''}
        ${name ? escapeHtml(name) : `Visitor ${escapeHtml(chat.sessionId.substring(0, 6))}`}
      </span>
      <small class="text-muted text-nowrap" title="${escapeHtml(started.toLocaleString())}">
        ${escapeHtml(started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
      </small>
    </div>
    <div class="small text-muted d-flex gap-2">
      <span>${messageCount} message${messageCount === 1 ? '' : 's'}</span>
      <span>·</span>
      <span class="text-truncate">${escapeHtml(chat.subject || chat.domain || 'Unknown source')}</span>
    </div>
    ${(chat.tags || []).length ? `
      <div class="tag-chips mt-1">
        ${chat.tags.slice(0, 4).map(tag => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}
      </div>` : ''}
    <div class="user-name small text-muted"></div>
    <div class="operator-name small text-muted">${hasOperator && chat.operatorName ? `With ${escapeHtml(chat.operatorName)}` : ''}</div>`;

  if (!existing) {
    chatList.appendChild(chatItem);
  }
  refreshCounts();
}

export function removeChatFromList(sessionId) {
  const chatItem = listItem(sessionId);
  if (!chatItem) {
    return;
  }
  chatItem.remove();
  if (selected === sessionId) {
    resetChatView();
  }
  refreshCounts();
}

export function updateChatOperatorStatus(sessionId, hasOperator, operatorName = '') {
  const chatItem = listItem(sessionId);
  if (chatItem) {
    const indicator = chatItem.querySelector('.status-indicator');
    indicator?.classList.remove('has-operator', 'no-operator');
    indicator?.classList.add(hasOperator ? 'has-operator' : 'no-operator');
    const operator = chatItem.querySelector('.operator-name');
    if (operator) {
      operator.textContent = hasOperator && operatorName ? `With ${operatorName}` : '';
    }
  }
  refreshCounts();
}

export function updateChatUserName(sessionId, userName) {
  const userEl = listItem(sessionId)?.querySelector('.user-name');
  if (userEl) {
    userEl.textContent = userName || '';
  }
}

/** The whole live queue, from the server. */
export async function loadActiveChats(socket = state.socket) {
  try {
    const data = await api('/api/admin/active-chats');
    const chats = data.chats || [];
    $('active-chat-list').innerHTML = '';

    chats.forEach(chat => {
      addChatToList(chat);
      // A conversation this operator was in before a reload is rejoined.
      if (state.joinedChats.has(chat.sessionId)) {
        socket.emit('operator-takeover', { sessionId: chat.sessionId });
      }
    });
    refreshCounts();
  } catch (error) {
    logger.error('Error loading active chats:', error);
    showToast(errorMessage(error, 'Could not load the live conversations'), 'danger');
  }
}

/** Browser notification and sound for a new or returning conversation. */
export function notifyNewChat(chat) {
  let setting = 'all';
  let sound = false;
  try {
    setting = localStorage.getItem('notification-setting') || 'all';
    sound = localStorage.getItem('sound-notifications') === 'true';
  } catch (error) {
    // Defaults.
  }

  if (setting === 'none') {
    return;
  }

  if ('Notification' in window && Notification.permission === 'granted') {
    const title = chat.reactivated ? 'A conversation is back' : 'New conversation';
    const body = `From ${chat.domain || 'your website'}`;
    new Notification(title, { body });
  }

  if (sound) {
    beep();
  }
}

function beep() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 800;
    gain.gain.value = 0.1;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    setTimeout(() => oscillator.stop(), 200);
  } catch (error) {
    // No audio is not worth an error.
  }
}

// --------------------------------------------------------- the transcript

function fileLink(message) {
  const url = message.fileUrl || (message.fileId ? `/api/upload/${message.fileId}` : null);
  if (!url) {
    return null;
  }

  const name = message.fileName || message.content || 'file';
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'file-chip';
  chip.innerHTML = `<span class="file-chip-icon" aria-hidden="true">📎</span><span class="text-truncate">${escapeHtml(name)}</span>`;
  chip.title = `Download ${name}`;
  // Staff authenticate with a header, never a token in a URL, so a plain
  // link cannot download it: fetch it and hand the browser the bytes.
  chip.addEventListener('click', () => {
    downloadFile(url, name).catch(error => showToast(errorMessage(error, 'Could not download the file'), 'danger'));
  });

  const wrapper = document.createElement('div');
  wrapper.className = 'message-file';
  wrapper.appendChild(chip);

  if (IMAGE_FILE.test(name)) {
    const img = document.createElement('img');
    img.className = 'message-file-thumb';
    img.alt = name;
    apiFetch(`${url}${url.includes('?') ? '&' : '?'}inline=1`)
      .then(response => (response.ok ? response.blob() : null))
      .then(blob => {
        if (blob) {
          img.src = URL.createObjectURL(blob);
          wrapper.prepend(img);
        }
      })
      .catch(() => {});
  }

  return wrapper;
}

function sourcesLine(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }
  const line = document.createElement('div');
  line.className = 'message-sources';
  line.innerHTML = 'From: ' + sources.slice(0, 5).map(source => {
    const href = source.url ? safeHref(source.url) : null;
    const title = escapeHtml(source.title || source.url || 'a source');
    return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
  }).join(', ');
  return line;
}

const SENDER_LABEL = { user: null, bot: 'Bot', operator: null, system: null };

/**
 * Append one message to the open transcript.
 *
 * @param {object} data `{content, sender, timestamp, _id|messageId,
 *        userName, operatorName, fileId, fileName, fileUrl, sources}`
 */
export function addMessageToChat(data) {
  const chatMessages = $('chat-messages');
  chatMessages.querySelector('.empty-state')?.remove();

  const id = data._id || data.messageId || data.id;
  if (id && chatMessages.querySelector(`[data-message-id="${CSS.escape(String(id))}"]`)) {
    // Already shown: an operator who sends a file hears about it twice, once
    // from the upload and once from the socket.
    return;
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${data.sender}`;
  if (id) {
    messageDiv.dataset.messageId = id;
  }

  const file = fileLink(data);
  if (file) {
    messageDiv.appendChild(file);
  } else {
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = data.content;
    messageDiv.appendChild(content);
  }

  if (data.sender === 'bot') {
    const sources = sourcesLine(data.sources);
    if (sources) {
      messageDiv.appendChild(sources);
    }
  }

  const time = document.createElement('div');
  time.className = 'message-time';
  const timestamp = new Date(data.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let who = SENDER_LABEL[data.sender];
  if (data.sender === 'user') {
    who = data.userName && data.userName !== 'user' ? data.userName : 'Visitor';
  } else if (data.sender === 'operator') {
    who = data.operatorName || 'You';
  }
  time.textContent = who ? `${who} · ${timestamp}` : timestamp;
  messageDiv.appendChild(time);

  if (data.sender === 'user' && selected && state.joinedChats.has(selected)) {
    addSuggestionButton(messageDiv);
  }

  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * The customer's rating, at the top of the details pane: how a chat landed
 * is most useful while somebody can still do something about it.
 */
export function displayRating(rating) {
  $('conversation-rating')?.remove();
  if (!rating || !rating.score) {
    return;
  }

  const tone = rating.score >= 4 ? 'success' : rating.score <= 2 ? 'danger' : 'secondary';
  const panel = document.createElement('div');
  panel.id = 'conversation-rating';
  panel.className = `alert alert-${tone} py-2 px-3 mb-3 d-flex gap-2 align-items-start`;
  panel.innerHTML = `
    <span class="badge bg-${tone}">${escapeHtml(rating.score)}/5</span>
    <div class="small">
      <div>Rated by the customer${rating.operatorName ? ` · ${escapeHtml(rating.operatorName)}` : ''}</div>
      ${rating.comment ? `<div class="mt-1">${escapeHtml(rating.comment)}</div>` : ''}
    </div>`;

  const details = document.querySelector('#inbox-details .card-body');
  details?.prepend(panel);
}

/**
 * Who the customer is. A chat visitor fills in the pre-chat form, which lands
 * in `metadata`; an email thread has only the sender address.
 */
export function displayUserContactInfo(conversation) {
  $('user-contact-info').style.display = 'block';

  const metadata = conversation.metadata instanceof Map
    ? Object.fromEntries(conversation.metadata)
    : (conversation.metadata || {});

  const details = {
    name: metadata.name || '',
    email: metadata.email || (conversation.email && conversation.email.from) || '',
    phone: metadata.phone || ''
  };

  const set = (element, value) => {
    element.textContent = value || 'Not provided';
    element.className = value ? '' : 'text-muted fst-italic';
  };
  set($('user-name'), details.name);
  set($('user-email'), details.email);
  set($('user-phone'), details.phone);

  $('contact-profile-link')?.remove();
  if (conversation.contact) {
    const link = document.createElement('button');
    link.id = 'contact-profile-link';
    link.type = 'button';
    link.className = 'btn btn-sm btn-link p-0 mt-2';
    link.textContent = 'Everything this person has asked before';
    link.addEventListener('click', () => {
      showSection('contacts');
      openContactById(conversation.contact);
    });
    $('user-contact-info').appendChild(link);
  }
}

// ------------------------------------------------------ the conversation

/** Reflect whether this operator is in the open conversation. */
function setJoined(joined, active = true) {
  const join = $('join-chat-btn');
  join.disabled = !active || !selected;
  join.classList.toggle('btn-primary', !joined && active);
  join.classList.toggle('btn-success', joined && active);
  join.classList.toggle('btn-secondary', !active);
  join.textContent = !active ? 'Ended' : joined ? 'Joined' : 'Join';
  join.toggleAttribute('data-joined', joined);

  $('leave-chat-btn').disabled = !joined || !active;
  $('end-chat-btn').disabled = !active || !selected;
  $('operator-input').style.display = joined && active ? 'block' : 'none';
  setSuggestionButtons(joined && active);
}

/** Back to "nothing selected". */
export function resetChatView() {
  selected = null;
  state.currentConversation = null;
  $('selected-chat-title').textContent = 'Select a conversation';
  $('chat-messages').innerHTML = '<div class="empty-state"><p>Select a conversation to view messages</p></div>';
  document.querySelectorAll('#active-chat-list .active').forEach(item => item.classList.remove('active'));
  ['transfer-chat-btn', 'notes-toggle-btn', 'create-task-btn', 'view-tasks-btn'].forEach(id => {
    $(id).disabled = true;
  });
  $('user-contact-info').style.display = 'none';
  $('tags-panel').style.display = 'none';
  $('notes-panel').style.display = 'none';
  $('conversation-rating')?.remove();
  document.querySelector('.suggestions-container')?.remove();
  $('inbox-layout').classList.remove('conversation-open', 'details-open');
  setJoined(false, true);
  $('join-chat-btn').disabled = true;
  setConversationNotes([]);
}

/**
 * Open a conversation in the inbox, from anywhere.
 *
 * @param {string} sessionId
 * @param {object} [options]
 * @param {boolean} [options.navigate=true] also switch to the Live chats section
 */
export async function openConversation(sessionId, { navigate = true } = {}) {
  if (!sessionId) {
    return;
  }

  if (navigate) {
    // The section's show hook opens it, once the section is on screen.
    showSection('active-chats', { params: { chat: sessionId } });
    return;
  }

  let data;
  try {
    data = await api(`/api/admin/chat/${encodeURIComponent(sessionId)}`);
  } catch (error) {
    logger.error('Error loading the conversation:', error);
    showToast(errorMessage(error, 'Could not load the conversation'), 'danger');
    return;
  }

  selected = sessionId;
  state.currentConversation = data;

  document.querySelectorAll('#active-chat-list .active').forEach(item => item.classList.remove('active'));
  const item = listItem(sessionId);
  if (item) {
    item.classList.add('active');
    item.classList.remove('has-new-message');
    item.querySelector('.unread-badge')?.remove();
  }

  const name = displayName(data);
  $('selected-chat-title').textContent = name || `Visitor ${sessionId.substring(0, 6)}`;
  $('join-chat-btn').setAttribute('data-session-id', sessionId);

  const active = data.status !== 'ended';
  ['transfer-chat-btn', 'notes-toggle-btn', 'create-task-btn', 'view-tasks-btn'].forEach(id => {
    $(id).disabled = false;
  });
  $('transfer-chat-btn').disabled = !active;

  const chatMessages = $('chat-messages');
  chatMessages.innerHTML = '';
  document.querySelector('.suggestions-container')?.remove();
  setJoined(state.joinedChats.has(sessionId), active);

  const userName = (data.metadata && data.metadata.name) || null;
  (data.messages || []).forEach(message => addMessageToChat({ ...message, userName }));
  if (!data.messages || data.messages.length === 0) {
    chatMessages.innerHTML = '<div class="empty-state"><p>No messages yet</p></div>';
  }

  displayUserContactInfo(data);
  displayRating(data.rating);
  renderConversationTags(data.tags || []);
  setConversationNotes(data.notes || []);
  $('notes-panel').style.display = 'block';

  $('inbox-layout').classList.add('conversation-open');
  updateUrlWithParams({ section: 'active-chats', chat: sessionId });
}

/** Reload the open conversation, after something changed it elsewhere. */
export function loadChatMessages(sessionId) {
  return openConversation(sessionId, { navigate: false });
}

// ------------------------------------------------------------ composer

function sendText(socket) {
  const input = $('operator-message');
  const message = input.value.trim();
  if (!message || !selected) {
    return;
  }

  socket.emit('operator-typing', { sessionId: selected, isTyping: false });
  socket.emit('operator-message', { sessionId: selected, message });
  addMessageToChat({ content: message, sender: 'operator', timestamp: new Date() });

  input.value = '';
  autosize(input);
}

/** Grow the reply box with what is typed, up to a limit, then scroll. */
function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
}

async function sendFile(file) {
  if (!file || !selected) {
    return;
  }

  const button = $('attach-file-btn');
  button.disabled = true;
  try {
    const form = new FormData();
    form.append('file', file);
    const result = await api(`/api/admin/conversations/${encodeURIComponent(selected)}/files`, {
      method: 'POST',
      body: form
    });
    if (result.message) {
      addMessageToChat({ ...result.message, messageId: result.message.id, sender: 'operator' });
    }
  } catch (error) {
    showToast(errorMessage(error, 'Could not send the file'), 'danger');
  } finally {
    button.disabled = false;
    $('operator-file-input').value = '';
  }
}

function setupComposer(socket) {
  const input = $('operator-message');

  $('send-operator-message').addEventListener('click', () => sendText(socket));

  // Enter sends, Shift+Enter is a new line: what every chat tool does. The
  // saved-reply picker claims Enter first while it is open.
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendText(socket);
    }
  });

  let typingTimeout;
  input.addEventListener('input', () => {
    autosize(input);
    if (!selected) {
      return;
    }
    clearTimeout(typingTimeout);
    socket.emit('operator-typing', { sessionId: selected, isTyping: true });
    typingTimeout = setTimeout(() => {
      socket.emit('operator-typing', { sessionId: selected, isTyping: false });
    }, 2000);
  });

  $('attach-file-btn').addEventListener('click', () => $('operator-file-input').click());
  $('operator-file-input').addEventListener('change', event => sendFile(event.target.files[0]));
}

// --------------------------------------------------------- the buttons

function forget(sessionId) {
  state.joinedChats.delete(sessionId);
  saveJoinedChats();
}

function setupActions(socket) {
  $('join-chat-btn').addEventListener('click', () => {
    if (!selected) {
      return;
    }
    // The server names the operator from the socket's own identity.
    socket.emit('operator-takeover', { sessionId: selected });

    const me = state.currentUser ? (state.currentUser.displayName || state.currentUser.username) : '';
    state.joinedChats.add(selected);
    saveJoinedChats();
    updateChatOperatorStatus(selected, true, me);
    setJoined(true, true);
    $('operator-message').focus();
  });

  // Two named ways to leave, rather than one confirm() whose OK and Cancel
  // meant different things.
  document.querySelectorAll('[data-leave]').forEach(button => {
    button.addEventListener('click', () => {
      const sessionId = selected;
      if (!sessionId) {
        return;
      }
      const passToBot = button.getAttribute('data-leave') === 'bot';
      socket.emit('operator-leave', { sessionId, passToBot });
      forget(sessionId);
      updateChatOperatorStatus(sessionId, false);
      setJoined(false, true);
      showToast(passToBot ? 'The bot has the conversation again.' : 'Back in the queue for someone else.', 'info');
    });
  });

  $('end-chat-btn').addEventListener('click', async () => {
    const sessionId = selected;
    if (!sessionId) {
      return;
    }
    const ok = await confirmDialog({
      title: 'End this conversation?',
      message: 'The customer is told the chat has ended and asked how it went. A new message from them starts a new conversation.',
      confirmLabel: 'End conversation',
      danger: true
    });
    if (!ok) {
      return;
    }
    socket.emit('end-chat', { sessionId });
    forget(sessionId);
    resetChatView();
  });

  // Details: always visible on a wide screen, a drawer on a narrower one.
  $('notes-toggle-btn').addEventListener('click', () => {
    $('inbox-layout').classList.toggle('details-open');
  });
  $('inbox-details-close').addEventListener('click', () => {
    $('inbox-layout').classList.remove('details-open');
  });

  $('inbox-back-btn').addEventListener('click', () => {
    $('inbox-layout').classList.remove('conversation-open', 'details-open');
    updateUrlWithParams({ section: 'active-chats' });
  });

  // Rows are links (so they can be opened in a new tab), but a plain click
  // opens the conversation in place.
  $('active-chat-list').addEventListener('click', event => {
    const item = event.target.closest('[data-session-id]');
    if (!item || event.metaKey || event.ctrlKey) {
      return;
    }
    event.preventDefault();
    openConversation(item.getAttribute('data-session-id'), { navigate: false });
  });
}

// ---------------------------------------------------------- socket events

function markUnread(sessionId) {
  const chatItem = listItem(sessionId);
  if (!chatItem) {
    return;
  }
  chatItem.classList.add('has-new-message');
  let badge = chatItem.querySelector('.unread-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'unread-badge badge bg-danger';
    chatItem.querySelector('.d-flex')?.appendChild(badge);
  }
  badge.textContent = String((parseInt(badge.textContent, 10) || 0) + 1);

  try {
    if (localStorage.getItem('sound-notifications') === 'true') {
      beep();
    }
  } catch (error) {
    // No preference readable; stay quiet.
  }
}

async function fetchIntoQueue(sessionId, notify) {
  try {
    const chat = await api(`/api/admin/chat/${encodeURIComponent(sessionId)}`);
    if (chat) {
      addChatToList(chat);
      if (notify) {
        notifyNewChat({ sessionId: chat.sessionId, domain: chat.domain, reactivated: true });
      }
    }
  } catch (error) {
    logger.error('Could not load a conversation into the queue:', error);
  }
}

function setupSocketEvents(socket) {
  setupSuggestionEventHandlers(socket);

  socket.on('new-chat', data => {
    addChatToList(data);
    notifyNewChat(data);
  });

  socket.on('chat-ended', data => removeChatFromList(data.sessionId));

  // Shown live rather than only in a report: a 1 arriving while the operator
  // is still at their desk is something they can act on.
  socket.on('conversation-rated', data => {
    if (state.currentConversation && state.currentConversation.sessionId === data.sessionId) {
      state.currentConversation.rating = { ...state.currentConversation.rating, ...data };
      displayRating(state.currentConversation.rating);
    }
    // Only the bad ones interrupt: a stream of "someone gave you a 5" toasts
    // trains people to dismiss the one that mattered.
    if (data.score <= 2) {
      showToast(`A customer rated a conversation ${data.score}/5`, 'warning');
    }
  });

  socket.on('operator-joined', data => updateChatOperatorStatus(data.sessionId, true, data.operatorName));

  socket.on('operator-left', data => {
    // A dropped connection can hand the chat straight to somebody else; show
    // the new owner rather than a chat that looks unattended.
    if (data.reassignedTo) {
      const name = typeof data.reassignedTo === 'object'
        ? (data.reassignedTo.name || data.reassignedTo.displayName || 'another operator')
        : String(data.reassignedTo);
      updateChatOperatorStatus(data.sessionId, true, name);
    } else {
      updateChatOperatorStatus(data.sessionId, false);
    }

    if (data.reason === 'disconnected') {
      const who = data.operatorName || 'An operator';
      showToast(data.reassignedTo
        ? `${who} lost their connection; the chat was passed on.`
        : `${who} lost their connection; their chat is waiting for somebody.`, 'warning');
    }
  });

  // Somebody else took this chat: nothing typed here would reach the visitor.
  socket.on('chat-taken-from-you', data => {
    const sessionId = data && data.sessionId;
    if (!sessionId) {
      return;
    }
    forget(sessionId);
    const takenBy = data.takenBy && typeof data.takenBy === 'object'
      ? (data.takenBy.name || data.takenBy.displayName || 'another operator')
      : (data.takenBy || 'another operator');

    if (selected === sessionId) {
      setJoined(false, true);
    }
    removeChatFromList(sessionId);
    showToast(`${takenBy} took over a chat you were in.`, 'warning');
  });

  // The server refused something - most often a join of a chat another
  // operator holds, which an admin may take anyway.
  socket.on('error', async data => {
    const payload = typeof data === 'string' ? { message: data } : (data || {});

    if (payload.heldBy && payload.sessionId) {
      const holder = payload.heldBy.name || 'another operator';
      const role = state.currentUser && state.currentUser.role;
      const mayForce = role === 'company_admin' || role === 'superadmin';

      // Whatever the join button did optimistically is undone: we are not in.
      forget(payload.sessionId);
      if (selected === payload.sessionId) {
        setJoined(false, true);
      }
      updateChatOperatorStatus(payload.sessionId, true, holder);

      if (mayForce && await confirmDialog({
        title: 'Take over this conversation?',
        message: `${holder} is already in it. They will be told you took over and can no longer reply.`,
        confirmLabel: 'Take over'
      })) {
        socket.emit('operator-takeover', { sessionId: payload.sessionId, force: true });
        state.joinedChats.add(payload.sessionId);
        saveJoinedChats();
        if (selected === payload.sessionId) {
          setJoined(true, true);
        }
        return;
      }

      showToast(`${holder} is already handling this chat.`, 'warning');
      return;
    }

    showToast(payload.message || 'The server refused that request.', 'danger');
  });

  socket.on('user-details-updated', data => {
    updateChatUserName(data.sessionId, data.name);
    if (state.currentConversation && state.currentConversation.sessionId === data.sessionId) {
      state.currentConversation.metadata = {
        ...(state.currentConversation.metadata || {}),
        name: data.name,
        email: data.email,
        phone: data.phone
      };
      displayUserContactInfo(state.currentConversation);
    }
  });

  socket.on('new-message', data => {
    if (selected === data.sessionId) {
      addMessageToChat({
        ...data,
        content: data.message,
        userName: state.currentConversation && state.currentConversation.metadata
          ? state.currentConversation.metadata.name
          : null
      });
    } else {
      markUnread(data.sessionId);
    }
  });

  socket.on('chat-reactivated', data => fetchIntoQueue(data.sessionId, true));

  // A visitor who closes the tab keeps their place for three minutes.
  const disconnectTimers = {};
  socket.on('chat-activity', ({ type, sessionId }) => {
    if (type === 'opened') {
      if (!listItem(sessionId)) {
        fetchIntoQueue(sessionId, false);
        return;
      }
      if (disconnectTimers[sessionId]) {
        clearTimeout(disconnectTimers[sessionId]);
        delete disconnectTimers[sessionId];
        listItem(sessionId)?.classList.remove('user-disconnected');
        if (selected === sessionId) {
          addMessageToChat({ content: 'The visitor is back.', sender: 'system', timestamp: new Date() });
        }
      }
    } else if (type === 'closed') {
      if (selected === sessionId) {
        addMessageToChat({
          content: 'The visitor closed the chat. It stays open for three minutes in case they come back.',
          sender: 'system',
          timestamp: new Date()
        });
      }
      listItem(sessionId)?.classList.add('user-disconnected');
      disconnectTimers[sessionId] = setTimeout(() => {
        removeChatFromList(sessionId);
        delete disconnectTimers[sessionId];
      }, 3 * 60 * 1000);
    }
  });

  socket.on('user-typing', ({ sessionId, isTyping }) => {
    if (selected !== sessionId) {
      return;
    }
    const chatMessages = $('chat-messages');
    let indicator = chatMessages.querySelector('.typing-indicator');

    if (isTyping && !indicator) {
      indicator = document.createElement('div');
      indicator.className = 'typing-indicator';
      indicator.innerHTML = `
        <div class="message bot typing">
          <div class="message-content"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
          <div class="message-time">The visitor is typing…</div>
        </div>`;
      chatMessages.appendChild(indicator);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    } else if (!isTyping && indicator) {
      indicator.remove();
    }
  });
}

// ------------------------------------------------------------------- setup

/**
 * Wire the inbox. Runs at boot, not when the section is first opened: the
 * queue has to be live, and counted on Home and in the sidebar, whichever
 * screen the operator is on.
 */
export function setupInbox(socket) {
  setupComposer(socket);
  setupActions(socket);
  setupSocketEvents(socket);
  loadActiveChats(socket);
}

registerSection('active-chats', {
  show(params) {
    const sessionId = params.chat || params.session;
    if (sessionId && sessionId !== selected) {
      openConversation(sessionId, { navigate: false });
    }
  }
});
