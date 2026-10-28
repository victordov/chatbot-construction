/**
 * Live chats: the queue, the open conversation, and the customer beside it.
 *
 * One function opens a conversation, whether it was clicked in the queue,
 * reached from History, People or a notification, or restored from the URL;
 * there used to be two copies of that logic that had drifted apart.
 *
 * The queue is kept as data - one record per conversation, merged from the
 * server's list and the live events - and the rows are drawn from it. Rows
 * used to be the only copy, so every redraw lost the unread badges and the
 * count said "0 messages" for a chat with three.
 *
 * Who holds a conversation is whatever the server says (`operatorId`), never
 * what this browser remembers: that was shared by everyone who signed in on
 * the same machine, and made the next person "rejoin" a colleague's chats.
 *
 * On a phone the three panes become one at a time: the list, then the
 * conversation with a back button, with details over it on demand.
 */

import * as bootstrap from 'bootstrap';
import { registerSection, showSection } from './nav.js';
import { channelBadge, isAppChannel, noteChannelMessage, showConversationChannel } from './channels-social.js';
import { actionToast, alertAllowed, alertPerson, beep } from './notifications.js';
import { applyChatFilter, setConversationNotes } from './operator-tools.js';
import { state } from './state.js';
import { addSuggestionButton, setSuggestionButtons, setupSuggestionEventHandlers, syncSuggestionsSwitch } from './suggestions.js';
import { applyTagFilter, renderConversationTags } from './tags.js';
import { openTeachDialog } from './teach.js';
import { api, apiFetch, confirmDialog, downloadFile, errorMessage, escapeHtml, formatRelativeTime, logger, safeHref, setLoading, showToast, updateUrlWithParams } from './utils.js';

let selected = null;

/** Session id of the conversation open in the inbox, or null. */
export function selectedSessionId() {
  return selected;
}

const $ = id => document.getElementById(id);

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

/** Why a conversation reached a person, as the queue says it. */
export const HANDOFF_REASONS = {
  visitor_request: 'Asked for a person',
  bot_unanswered: 'Bot couldn\'t answer',
  model_error: 'Bot error',
  quota: 'Out of AI replies',
  workflow: 'Sent by a workflow',
  offline_message: 'Left a message'
};

/** The signed-in user's id, as a string. */
function me() {
  const user = state.currentUser;
  return user ? String(user.id || user._id || '') : '';
}

function myName() {
  const user = state.currentUser;
  return user ? (user.displayName || user.username || '') : '';
}

export function isAdmin() {
  const role = state.currentUser && state.currentUser.role;
  return role === 'company_admin' || role === 'superadmin';
}

// ---------------------------------------------------------- queue records

/** sessionId -> what the queue knows about that conversation. */
const chats = new Map();
/** sessionId -> messages arrived while it was not open. Survives redraws. */
const unread = new Map();
/** sessionId -> message ids already counted, so two events count once. */
const counted = new Map();

function listItem(sessionId) {
  return document.querySelector(`#active-chat-list [data-session-id="${CSS.escape(sessionId)}"]`);
}

/** The queue's record for a conversation, or null. */
export function chatRecord(sessionId) {
  return chats.get(sessionId) || null;
}

/** A plain object from a conversation's metadata, Map or not. */
function metadataOf(source) {
  const metadata = source && source.metadata;
  if (!metadata) {
    return {};
  }
  return metadata instanceof Map ? Object.fromEntries(metadata) : metadata;
}

/**
 * A queue record from whatever describes a conversation: a row of
 * `/active-chats`, a whole conversation from `/chat/:id`, or a live event.
 * Only what the source actually says is taken, so a thin event does not wipe
 * what a fuller one told us.
 */
function recordFrom(source) {
  const record = {};
  const set = (key, value) => {
    if (value !== undefined) {
      record[key] = value;
    }
  };
  const metadata = metadataOf(source);

  set('sessionId', source.sessionId);
  set('visitorName', source.visitorName || source.userName || metadata.name || (source.email && source.email.from) || undefined);
  set('email', typeof source.email === 'string' ? source.email : (metadata.email || source.followUpEmail || undefined));
  set('domain', source.domain);
  set('channel', source.channel);
  set('subject', source.subject || (source.email && typeof source.email === 'object' ? source.email.subject : undefined));
  set('tags', source.tags);
  set('startedAt', source.startedAt || source.createdAt);
  set('lastActivity', source.lastActivity);
  set('operatorEverJoined', source.operatorEverJoined);

  // A whole conversation leaves out what is not set, and "not set" is an
  // answer: nobody holds it, nobody is waiting.
  const whole = Array.isArray(source.messages);

  if ('operatorId' in source || whole) {
    record.operatorId = source.operatorId ? String(source.operatorId._id || source.operatorId) : null;
    record.operatorName = source.operatorId ? (source.operatorName || null) : null;
  }
  if ('waitingSince' in source) {
    record.waitingSince = source.waitingSince || null;
  } else if ('awaitingOperatorSince' in source || whole) {
    record.waitingSince = source.awaitingOperatorSince || null;
  }
  // A server that marks only `awaitingOperatorSince` says nothing about why;
  // what the queue heard live (the older `operator-requested`) is kept.
  if (source.handoff !== undefined || (whole && !source.awaitingOperatorSince)) {
    record.handoff = source.handoff && source.handoff.requestedAt
      ? { reason: source.handoff.reason || null, requestedAt: source.handoff.requestedAt }
      : null;
  }

  if (Array.isArray(source.messages)) {
    // A whole conversation: count and preview what was said, not the
    // operator-only event lines.
    const spoken = source.messages.filter(message => message.sender !== 'system');
    record.messageCount = spoken.length;
    const last = spoken[spoken.length - 1];
    record.lastMessage = last
      ? { sender: last.sender, content: String(last.content || '').slice(0, 140), timestamp: last.timestamp }
      : null;
    counted.set(source.sessionId, new Set(source.messages.map(message => String(message._id || ''))));
  } else {
    set('messageCount', source.messageCount);
    if (source.lastMessage && typeof source.lastMessage === 'object') {
      record.lastMessage = source.lastMessage;
    } else if (typeof source.lastMessage === 'string') {
      record.lastMessage = { sender: 'user', content: source.lastMessage.slice(0, 140) };
    } else if (source.preview) {
      record.lastMessage = { sender: 'user', content: String(source.preview).slice(0, 140), timestamp: source.createdAt };
    }
  }

  return record;
}

/**
 * Merge what is now known about a conversation into the queue and redraw its
 * row. Creates the row when the conversation is new to the queue.
 */
export function mergeChat(sessionId, update) {
  if (!sessionId) {
    return null;
  }
  const record = { ...(chats.get(sessionId) || { sessionId, messageCount: 0, tags: [] }), ...update, sessionId };
  // Somebody holding it is no longer waiting for one.
  if (record.operatorId) {
    record.waitingSince = null;
  }
  chats.set(sessionId, record);
  state.joinedChats = new Set([...chats.values()].filter(isMine).map(chat => chat.sessionId));
  renderRow(record);
  sortQueue();
  refreshCounts();
  return record;
}

export function isMine(chat) {
  return Boolean(chat && chat.operatorId && chat.operatorId === me());
}

/**
 * Waiting for a person: asked for one (or was handed over) and nobody has it.
 * A conversation the bot is happily handling is not waiting, which the old
 * count said every unclaimed conversation was.
 */
export function isWaiting(chat) {
  if (!chat || chat.operatorId) {
    return false;
  }
  return Boolean(chat.waitingSince || (chat.handoff && chat.handoff.requestedAt && !chat.operatorEverJoined));
}

function waitingStart(chat) {
  return chat.waitingSince || (chat.handoff && chat.handoff.requestedAt) || null;
}

/** "waiting 4m", "waiting 1h 05m". */
export function formatWait(since) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60000));
  if (minutes < 1) {
    return 'waiting <1m';
  }
  if (minutes < 60) {
    return `waiting ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `waiting ${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function displayName(chat) {
  return chat.visitorName || chat.email || `Visitor ${String(chat.sessionId).substring(0, 6)}`;
}

function previewLine(chat) {
  const last = chat.lastMessage;
  if (!last || !last.content) {
    return '';
  }
  const who = last.sender === 'bot' ? 'Bot: ' : last.sender === 'operator' ? 'Agent: ' : '';
  return `${who}${last.content}`;
}

/** Draw one row from its record. Keeps the row's place and its unread badge. */
function renderRow(chat) {
  const chatList = $('active-chat-list');
  if (!chatList) {
    return;
  }
  chatList.querySelector('.empty-state')?.remove();

  const existing = listItem(chat.sessionId);
  const row = existing || document.createElement('a');
  const mine = isMine(chat);
  const waiting = isWaiting(chat);
  const unreadCount = unread.get(chat.sessionId) || 0;
  const name = displayName(chat);
  const preview = previewLine(chat);
  const count = Number(chat.messageCount) || 0;
  const activity = new Date(chat.lastActivity || chat.startedAt || Date.now());
  const reason = chat.handoff && chat.handoff.reason ? HANDOFF_REASONS[chat.handoff.reason] : null;

  // Kept across a redraw: set by the visitor leaving and by the tag filter.
  const kept = ['user-disconnected', 'filtered-by-tag'].filter(name => row.classList.contains(name));

  row.href = `?section=active-chats&chat=${encodeURIComponent(chat.sessionId)}`;
  row.className = 'list-group-item list-group-item-action inbox-item';
  kept.forEach(name => row.classList.add(name));
  row.classList.toggle('active', selected === chat.sessionId);
  row.classList.toggle('is-mine', mine);
  row.classList.toggle('is-waiting', waiting);
  row.classList.toggle('has-new-message', unreadCount > 0);
  row.setAttribute('data-session-id', chat.sessionId);
  // Read by the filters, which hide rows in place rather than refetching a
  // queue that is already live over the socket.
  row.dataset.tags = (chat.tags || []).join(',');
  row.dataset.mine = mine ? '1' : '0';
  row.dataset.waiting = waiting ? '1' : '0';
  row.dataset.search = [name, chat.email, chat.subject, chat.lastMessage && chat.lastMessage.content]
    .filter(Boolean).join(' ').toLowerCase();

  const status = chat.operatorId ? 'has-operator' : waiting ? 'no-operator' : 'is-bot';
  const statusTitle = chat.operatorId
    ? `With ${chat.operatorName || 'a colleague'}`
    : waiting ? 'Waiting for a person' : 'The bot is answering';

  // The visitor's name, the preview and the operator name all originate
  // from untrusted input, so every interpolation is escaped.
  row.innerHTML = `
    <div class="d-flex w-100 justify-content-between align-items-start gap-2">
      <span class="inbox-item-name text-truncate">
        <span class="status-indicator ${status}" title="${escapeHtml(statusTitle)}"></span>
        ${channelBadge(chat.channel)}
        ${escapeHtml(name)}
      </span>
      <span class="d-flex align-items-center gap-1 text-nowrap">
        <small class="text-muted" title="${escapeHtml(activity.toLocaleString())}">
          ${escapeHtml(activity.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
        </small>
        ${unreadCount > 0 ? `<span class="unread-badge badge bg-danger" aria-label="${unreadCount} new">${unreadCount}</span>` : ''}
      </span>
    </div>
    ${preview ? `<div class="inbox-item-preview small text-truncate">${escapeHtml(preview)}</div>` : ''}
    <div class="small text-muted d-flex gap-2 align-items-center flex-wrap inbox-item-meta">
      ${reason ? `<span class="handoff-badge">${escapeHtml(reason)}</span>` : ''}
      ${waiting && waitingStart(chat)
    ? `<span class="wait-timer" data-waiting-since="${escapeHtml(new Date(waitingStart(chat)).toISOString())}">${escapeHtml(formatWait(waitingStart(chat)))}</span>`
    : ''}
      <span>${count} message${count === 1 ? '' : 's'}</span>
      <span class="text-truncate">${escapeHtml(chat.subject || chat.domain || '')}</span>
    </div>
    ${(chat.tags || []).length ? `
      <div class="tag-chips mt-1">
        ${chat.tags.slice(0, 4).map(tag => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}
      </div>` : ''}
    <div class="operator-name small text-muted">${chat.operatorId ? `With ${escapeHtml(mine ? 'you' : (chat.operatorName || 'a colleague'))}` : ''}</div>`;

  if (!existing) {
    chatList.appendChild(row);
  }
}

/**
 * Whoever has waited longest for a person first, then the most recent
 * activity. Re-run whenever anything changes, so the queue is always in the
 * order it should be worked.
 */
function compareChats(a, b) {
  const waitA = isWaiting(a) ? new Date(waitingStart(a) || 0).getTime() : null;
  const waitB = isWaiting(b) ? new Date(waitingStart(b) || 0).getTime() : null;
  if (waitA !== null && waitB !== null) {
    return waitA - waitB;
  }
  if (waitA !== null || waitB !== null) {
    return waitA === null ? 1 : -1;
  }
  return new Date(b.lastActivity || b.startedAt || 0) - new Date(a.lastActivity || a.startedAt || 0);
}

function sortQueue() {
  const chatList = $('active-chat-list');
  if (!chatList) {
    return;
  }
  const ordered = [...chats.values()].sort(compareChats);
  const rows = ordered.map(chat => listItem(chat.sessionId)).filter(Boolean);
  const current = [...chatList.querySelectorAll(':scope > [data-session-id]')];
  if (rows.length === current.length && rows.every((row, index) => row === current[index])) {
    return;
  }
  rows.forEach(row => chatList.appendChild(row));
  // Notices stay at the bottom.
  const notice = $('filter-empty-notice');
  if (notice) {
    chatList.appendChild(notice);
  }
}

/** Keep the "waiting 4m" labels honest without redrawing anything. */
function tickTimers() {
  document.querySelectorAll('#active-chat-list .wait-timer[data-waiting-since]').forEach(timer => {
    timer.textContent = formatWait(timer.dataset.waitingSince);
  });
  const strip = $('handoff-strip');
  const since = strip && strip.querySelector('[data-relative-time]');
  if (since) {
    since.textContent = formatRelativeTime(since.dataset.relativeTime);
  }
}

/**
 * Keep every count that depends on the queue in step: Home's numbers, the
 * sidebar badge, and the filter buttons.
 */
function refreshCounts() {
  const all = [...chats.values()];
  const waiting = all.filter(isWaiting).length;

  const set = (id, value) => {
    const element = $(id);
    if (element) {
      element.textContent = String(value);
    }
  };
  set('active-chats-count', all.length);
  set('home-waiting-count', waiting);

  const badge = $('nav-waiting-count');
  if (badge) {
    badge.textContent = String(waiting);
    badge.classList.toggle('d-none', waiting === 0);
  }

  const chatList = $('active-chat-list');
  if (chatList && all.length === 0 && !chatList.querySelector('.empty-state')) {
    chatList.insertAdjacentHTML('afterbegin', '<div class="list-group-item empty-state">No active conversations</div>');
  }

  applyChatFilter();
  applyTagFilter();
}

/** Add a conversation to the queue, or refresh its row if it is there. */
export function addChatToList(chat) {
  if (!chat || !chat.sessionId) {
    return;
  }
  mergeChat(chat.sessionId, recordFrom(chat));
}

export function removeChatFromList(sessionId) {
  chats.delete(sessionId);
  unread.delete(sessionId);
  counted.delete(sessionId);
  listItem(sessionId)?.remove();
  state.joinedChats.delete(sessionId);
  refreshCounts();
}

export function updateChatOperatorStatus(sessionId, hasOperator, operatorName = '', operatorId = null) {
  if (!chats.has(sessionId)) {
    return;
  }
  mergeChat(sessionId, hasOperator
    ? { operatorId: operatorId ? String(operatorId) : (chats.get(sessionId).operatorId || 'someone'), operatorName }
    : { operatorId: null, operatorName: null });
}

export function updateChatUserName(sessionId, userName) {
  if (chats.has(sessionId) && userName) {
    mergeChat(sessionId, { visitorName: userName });
  }
}

/**
 * The whole live queue, from the server - and back into every conversation
 * this person holds.
 *
 * Runs at boot and after every reconnect. Re-joining sends
 * `operator-takeover` for each conversation the server says is ours; the
 * server treats a takeover by the holder as a silent re-join (`operator-
 * rejoined`), so the customer is not told somebody "has joined" again.
 */
export async function loadActiveChats(socket = state.socket) {
  try {
    const data = await api('/api/admin/active-chats');
    const rows = data.chats || [];
    const fresh = new Set(rows.map(row => row.sessionId));

    // Anything that ended while we were away is not in the list any more.
    [...chats.keys()].filter(sessionId => !fresh.has(sessionId)).forEach(removeChatFromList);

    rows.forEach(row => {
      const record = recordFrom(row);
      chats.set(row.sessionId, { ...(chats.get(row.sessionId) || {}), ...record });
    });
    state.joinedChats = new Set(rows.filter(row => row.assignedToMe || isMine(recordFrom(row))).map(row => row.sessionId));

    $('active-chat-list').querySelector('.empty-state')?.remove();
    [...chats.values()].forEach(renderRow);
    sortQueue();
    refreshCounts();

    if (socket) {
      state.joinedChats.forEach(sessionId => socket.emit('operator-takeover', { sessionId }));
    }

    if (selected && chats.has(selected)) {
      setHeld();
    }
  } catch (error) {
    logger.error('Error loading active chats:', error);
    showToast(errorMessage(error, 'Could not load the live conversations'), 'danger');
  }
}

/**
 * Browser notification and sound for a new or returning conversation.
 * Kept for anything that still calls it; new code uses alertPerson.
 */
export function notifyNewChat(chat) {
  const name = chat.visitorName || chat.userName || null;
  alertPerson({
    kind: 'new-chat',
    key: `new-chat:${chat.sessionId}`,
    title: chat.reactivated
      ? `${name || 'A visitor'} is back`
      : `New conversation${name ? ` with ${name}` : ''}`,
    body: chat.preview || (chat.domain ? `From ${chat.domain}` : ''),
    open: () => openConversation(chat.sessionId)
  });
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

/** The visitor message a bot or operator message answered. */
function precedingQuestion(messageDiv) {
  let node = messageDiv.previousElementSibling;
  while (node) {
    if (node.classList.contains('message') && node.classList.contains('user')) {
      return node.querySelector('.message-content')?.textContent || '';
    }
    node = node.previousElementSibling;
  }
  return '';
}

/** "Fixed": somebody already taught the bot the right answer to this. */
function markCorrected(messageDiv) {
  if (messageDiv.querySelector('.message-fixed')) {
    return;
  }
  const badge = document.createElement('span');
  badge.className = 'message-badge message-fixed';
  badge.textContent = 'Fixed';
  badge.title = 'The bot has been taught a better answer to this';
  (messageDiv.querySelector('.message-markers') || messageDiv).appendChild(badge);
  messageDiv.querySelector('.teach-btn')?.remove();
}

/** The visitor's thumbs up or down on a bot answer. */
function showFeedback(messageDiv, rating) {
  messageDiv.querySelector('.message-feedback')?.remove();
  if (rating !== 'up' && rating !== 'down') {
    return;
  }
  const badge = document.createElement('span');
  badge.className = `message-badge message-feedback is-${rating}`;
  badge.textContent = rating === 'up' ? '👍' : '👎';
  badge.title = rating === 'up' ? 'The visitor found this helpful' : 'The visitor found this unhelpful';
  (messageDiv.querySelector('.message-markers') || messageDiv).appendChild(badge);
}

/**
 * "Teach the bot" under a bot answer and "Save as the bot's answer" under an
 * operator's: the moment somebody sees a wrong or missing answer is the
 * moment to fix it, not a trip to the knowledge screen later. Admins only,
 * and only for messages the server has stored.
 */
function addTeachAction(messageDiv, data) {
  const messageId = messageDiv.dataset.messageId;
  const corrected = data.correction && (data.correction.kind || data.correction.at);
  if (!isAdmin() || !messageId || corrected || messageDiv.querySelector('.teach-btn')) {
    return;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-link btn-sm p-0 teach-btn';
  button.textContent = data.sender === 'bot' ? 'Teach the bot' : 'Save as the bot\'s answer';
  button.addEventListener('click', () => {
    const answerText = messageDiv.querySelector('.message-content')?.textContent || data.content || '';
    openTeachDialog({
      sessionId: selected,
      messageId,
      question: precedingQuestion(messageDiv),
      // A bot answer that missed is a poor starting point; an operator's
      // reply is usually exactly the answer to keep.
      answer: data.sender === 'bot' && data.unanswered ? '' : answerText,
      onSaved: () => markCorrected(messageDiv)
    });
  });

  let actions = messageDiv.querySelector('.message-actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'message-actions';
    messageDiv.appendChild(actions);
  }
  actions.appendChild(button);
}

/**
 * Append one message to the open transcript.
 *
 * Every viewer of a conversation hears about every stored message, including
 * this operator's own replies, so a message is drawn once per id: a reply
 * shown the moment it was sent is matched to its id when the server confirms
 * it, rather than appearing twice.
 *
 * @param {object} data `{content, sender, timestamp, _id|messageId,
 *        userName, operatorName, operatorId, fileId, fileName, fileUrl,
 *        sources, unanswered, feedback, correction, path}`
 * @param {object} [options]
 * @param {boolean} [options.pending] shown before the server has it
 */
export function addMessageToChat(data, { pending = false } = {}) {
  const chatMessages = $('chat-messages');
  chatMessages.querySelector('.empty-state')?.remove();

  const id = data._id || data.messageId || data.id;
  if (id && chatMessages.querySelector(`[data-message-id="${CSS.escape(String(id))}"]`)) {
    // Already shown: an operator who sends a file hears about it twice, once
    // from the upload and once from the socket.
    return null;
  }

  if (id && data.sender === 'operator' && (!data.operatorId || String(data.operatorId) === me())) {
    // Our own reply, already on screen without an id.
    const waiting = [...chatMessages.querySelectorAll('.message.operator[data-pending]')]
      .find(element => element.querySelector('.message-content')?.textContent === data.content);
    if (waiting) {
      waiting.removeAttribute('data-pending');
      waiting.dataset.messageId = id;
      addTeachAction(waiting, data);
      return waiting;
    }
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${data.sender}`;
  if (id) {
    messageDiv.dataset.messageId = id;
  }
  if (pending) {
    messageDiv.dataset.pending = '1';
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
    who = data.operatorName && (!data.operatorId || String(data.operatorId) !== me()) ? data.operatorName : 'You';
  }
  time.textContent = who ? `${who} · ${timestamp}` : timestamp;
  messageDiv.appendChild(time);

  if (data.sender === 'bot' || data.sender === 'operator') {
    const markers = document.createElement('div');
    markers.className = 'message-markers';
    messageDiv.appendChild(markers);

    if (data.sender === 'bot' && data.unanswered) {
      const marker = document.createElement('span');
      marker.className = 'message-badge message-unanswered';
      marker.textContent = 'Couldn\'t answer';
      marker.title = 'The bot did not have an answer to this';
      markers.appendChild(marker);
    }
    if (data.feedback && data.feedback.rating) {
      showFeedback(messageDiv, data.feedback.rating);
    }
    if (data.correction && (data.correction.kind || data.correction.at)) {
      markCorrected(messageDiv);
    }
    addTeachAction(messageDiv, data);
  }

  if (data.sender === 'user' && selected && heldByMe()) {
    addSuggestionButton(messageDiv);
  }

  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return messageDiv;
}

/**
 * Give the oldest reply still waiting for the server its stored id, when the
 * server names the id but not the text (a reply sent from a draft).
 */
export function confirmPendingMessage(messageId) {
  const chatMessages = $('chat-messages');
  if (!messageId || chatMessages.querySelector(`[data-message-id="${CSS.escape(String(messageId))}"]`)) {
    return;
  }
  const waiting = chatMessages.querySelector('.message.operator[data-pending]');
  if (waiting) {
    waiting.removeAttribute('data-pending');
    waiting.dataset.messageId = messageId;
    addTeachAction(waiting, { sender: 'operator' });
  }
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

  const metadata = metadataOf(conversation);

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

  // Asking through the widget only reaches somebody on a web chat.
  const ask = $('request-user-info-btn');
  if (ask) {
    ask.style.display = conversation.channel === 'email' || isAppChannel(conversation.channel) ? 'none' : '';
  }

  $('contact-profile-link')?.remove();
  if (conversation.contact) {
    const link = document.createElement('button');
    link.id = 'contact-profile-link';
    link.type = 'button';
    link.className = 'btn btn-sm btn-link p-0 mt-2';
    link.textContent = 'Everything this person has asked before';
    link.addEventListener('click', () => {
      showSection('contacts', { params: { contact: String(conversation.contact) } });
    });
    $('user-contact-info').appendChild(link);
  }
}

/**
 * Why this reached a person, when, and what they asked - above the
 * transcript, so an operator picking it up does not have to scroll back to
 * find out.
 */
function renderHandoffStrip(conversation) {
  const strip = $('handoff-strip');
  if (!strip) {
    return;
  }
  const handoff = conversation && conversation.handoff;
  if (!handoff || !handoff.requestedAt || conversation.status === 'ended') {
    strip.style.display = 'none';
    strip.innerHTML = '';
    return;
  }

  const asked = (conversation.messages || [])
    .filter(message => message.sender === 'user' && message.content)
    .slice(-3);

  strip.innerHTML = `
    <div class="d-flex flex-wrap gap-2 align-items-baseline">
      <strong>${escapeHtml(HANDOFF_REASONS[handoff.reason] || 'Handed to a person')}</strong>
      <span class="text-muted small" data-relative-time="${escapeHtml(new Date(handoff.requestedAt).toISOString())}"
            title="${escapeHtml(new Date(handoff.requestedAt).toLocaleString())}">
        ${escapeHtml(formatRelativeTime(handoff.requestedAt))}
      </span>
    </div>
    ${handoff.summary ? `<div class="small mt-1">${escapeHtml(handoff.summary)}</div>` : ''}
    ${asked.length ? `
      <div class="small text-muted mt-1">What they asked</div>
      <ul class="handoff-asked small mb-0">
        ${asked.map(message => `<li>${escapeHtml(String(message.content).slice(0, 300))}</li>`).join('')}
      </ul>` : ''}`;
  strip.style.display = '';
}

// ------------------------------------------------------ the conversation

/** Whether the signed-in person holds the open conversation. */
export function heldByMe() {
  const conversation = state.currentConversation;
  return Boolean(conversation && conversation.operatorId && String(conversation.operatorId) === me());
}

/** Who holds the open conversation, if somebody else does. */
function heldByOther() {
  const conversation = state.currentConversation;
  if (!conversation || !conversation.operatorId || heldByMe()) {
    return null;
  }
  return conversation.operatorName || 'A colleague';
}

/**
 * Set the open conversation's buttons from who holds it.
 *
 * End, Leave and Transfer belong to whoever holds the chat: any operator used
 * to be able to end a colleague's conversation from under them. An admin can
 * still do it, after a confirmation that names who holds it.
 */
function setHeld() {
  const conversation = state.currentConversation;
  const active = Boolean(conversation) && conversation.status !== 'ended';
  const held = heldByMe();
  const other = heldByOther();
  const admin = isAdmin();

  const join = $('join-chat-btn');
  join.disabled = !active || !selected || held || (Boolean(other) && !admin);
  join.classList.toggle('btn-primary', !held && active);
  join.classList.toggle('btn-success', held && active);
  join.classList.toggle('btn-secondary', !active);
  join.textContent = !active ? 'Ended' : held ? 'Joined' : other ? (admin ? 'Take over' : `With ${other}`) : 'Join';
  join.toggleAttribute('data-joined', held);

  const mayManage = active && (held || (admin && Boolean(other)));
  $('leave-chat-btn').disabled = !mayManage;
  $('transfer-chat-btn').disabled = !(active && (held || admin));
  $('end-chat-btn').disabled = !(active && (held || admin));
  if ($('delete-chat-btn')) {
    $('delete-chat-btn').disabled = !conversation;
  }

  $('operator-input').style.display = held && active ? 'block' : 'none';

  // What this conversation allows: no attachments on email, no drafts on a
  // plan without them.
  const features = (conversation && conversation.features) || {};
  const attach = $('attach-file-btn');
  if (attach) {
    attach.style.display = conversation && (conversation.channel === 'email' || isAppChannel(conversation.channel) ||
      features.fileUploads === false) ? 'none' : '';
  }
  syncSuggestionsSwitch(conversation);
  setSuggestionButtons(held && active);

  // A conversation that has ended can still be answered, by email.
  const followUp = $('followup-composer');
  if (followUp) {
    const address = conversation && !active ? conversation.followUpEmail : null;
    followUp.style.display = address ? '' : 'none';
    $('followup-to').textContent = address || '';
  }

  if (selected && chats.has(selected)) {
    listItem(selected)?.classList.toggle('is-mine', held);
  }
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
  if ($('delete-chat-btn')) {
    $('delete-chat-btn').disabled = true;
  }
  $('user-contact-info').style.display = 'none';
  $('tags-panel').style.display = 'none';
  $('notes-panel').style.display = 'none';
  $('conversation-rating')?.remove();
  renderHandoffStrip(null);
  document.querySelector('.suggestions-container')?.remove();
  $('inbox-layout').classList.remove('conversation-open', 'details-open');
  setHeld();
  $('join-chat-btn').disabled = true;
  $('followup-composer').style.display = 'none';
  setConversationNotes([]);
  showConversationChannel(null);
}

let openSequence = 0;

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

  // Two clicks in quick succession: only the last one's answer is shown.
  const sequence = ++openSequence;
  let data;
  try {
    data = await api(`/api/admin/chat/${encodeURIComponent(sessionId)}`);
  } catch (error) {
    logger.error('Error loading the conversation:', error);
    showToast(errorMessage(error, 'Could not load the conversation'), 'danger');
    return;
  }
  if (sequence !== openSequence) {
    return;
  }

  selected = sessionId;
  state.currentConversation = data;
  unread.delete(sessionId);

  if (chats.has(sessionId) && data.status !== 'ended') {
    // What the conversation says is newer than the queue's row.
    mergeChat(sessionId, recordFrom(data));
  }

  document.querySelectorAll('#active-chat-list .active').forEach(item => item.classList.remove('active'));
  const item = listItem(sessionId);
  if (item) {
    item.classList.add('active');
    item.classList.remove('has-new-message');
    item.querySelector('.unread-badge')?.remove();
  }

  const name = recordFrom(data).visitorName;
  $('selected-chat-title').textContent = name || `Visitor ${sessionId.substring(0, 6)}`;
  $('join-chat-btn').setAttribute('data-session-id', sessionId);
  // WhatsApp, Messenger, Instagram: which, and how long a reply is allowed.
  showConversationChannel(data);

  ['notes-toggle-btn', 'create-task-btn', 'view-tasks-btn'].forEach(id => {
    $(id).disabled = false;
  });

  const chatMessages = $('chat-messages');
  chatMessages.innerHTML = '';
  document.querySelector('.suggestions-container')?.remove();
  setHeld();

  const userName = metadataOf(data).name || null;
  (data.messages || []).forEach(message => addMessageToChat({ ...message, userName }));
  if (!data.messages || data.messages.length === 0) {
    chatMessages.innerHTML = '<div class="empty-state"><p>No messages yet</p></div>';
  }

  const heard = chatRecord(sessionId);
  renderHandoffStrip(data.handoff || !heard || !heard.handoff ? data : { ...data, handoff: heard.handoff });
  displayUserContactInfo(data);
  displayRating(data.rating);
  renderConversationTags(data.tags || []);
  setConversationNotes(data.notes || []);
  $('notes-panel').style.display = 'block';

  $('inbox-layout').classList.add('conversation-open');
  updateUrlWithParams({ section: 'active-chats', chat: sessionId });
  markReadByMe(sessionId);
}

/**
 * Tell the visitor a person has read what they wrote. Only for the person
 * holding the chat: a colleague glancing at the queue has not read it in any
 * sense the visitor cares about, and a tick that promises otherwise is worse
 * than none.
 */
function markReadByMe(sessionId) {
  const conversation = state.currentConversation;
  if (!state.socket || selected !== sessionId || !conversation || document.hidden) {
    return;
  }
  if (conversation.status === 'ended' || conversation.channel === 'email' || !heldByMe()) {
    return;
  }
  state.socket.emit('operator-read', { sessionId });
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
  addMessageToChat({ content: message, sender: 'operator', operatorId: me(), timestamp: new Date() }, { pending: true });
  // Counted when the server confirms it (conversation-message), not here,
  // or it would be counted twice.
  if (chats.has(selected)) {
    mergeChat(selected, {
      lastMessage: { sender: 'operator', content: message.slice(0, 140), timestamp: new Date() },
      lastActivity: new Date().toISOString()
    });
  }

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
      addMessageToChat({ ...result.message, messageId: result.message.id, sender: 'operator', operatorId: me() });
    }
  } catch (error) {
    showToast(errorMessage(error, 'Could not send the file'), 'danger');
  } finally {
    button.disabled = false;
    $('operator-file-input').value = '';
  }
}

/** Reply by email to somebody whose conversation has ended. */
async function sendFollowUp() {
  const sessionId = selected;
  const input = $('followup-message');
  const message = input.value.trim();
  if (!sessionId || !message) {
    return;
  }

  const button = $('followup-send-btn');
  setLoading(button, true);
  try {
    const result = await api(`/api/admin/chat/${encodeURIComponent(sessionId)}/follow-up`, {
      method: 'POST',
      body: { message }
    });
    input.value = '';
    showToast(`Sent to ${result.to || 'the customer'} by email`, 'success');
    if (selected === sessionId) {
      openConversation(sessionId, { navigate: false });
    }
  } catch (error) {
    showToast(errorMessage(error, 'Could not send the email'), 'danger');
  } finally {
    setLoading(button, false);
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

  $('followup-send-btn').addEventListener('click', sendFollowUp);
}

// --------------------------------------------------------- the buttons

/** What each override says, by what is being done. */
const OVERRIDES = {
  end: holder => ({
    title: `End ${holder}'s conversation?`,
    message: `${holder} is in this conversation. Ending it closes it for them and for the customer.`,
    confirmLabel: 'End it'
  }),
  takeover: holder => ({
    title: `Take over from ${holder}?`,
    message: `${holder} is in this conversation. They will be told you took over and can no longer reply.`,
    confirmLabel: 'Take over'
  }),
  transfer: holder => ({
    title: `Transfer ${holder}'s conversation?`,
    message: `${holder} is in this conversation. Transferring it moves it away from them.`,
    confirmLabel: 'Choose who gets it'
  }),
  leave: holder => ({
    title: `Take ${holder} out of this conversation?`,
    message: `${holder} is in this conversation. They will no longer be able to reply to the customer.`,
    confirmLabel: 'Remove them'
  })
};

/**
 * An admin acting on a colleague's conversation is told whose it is first.
 * An operator cannot, and is told why.
 *
 * @param {'end'|'takeover'|'transfer'|'leave'} action
 * @returns {Promise<{ok: boolean, force: boolean}>}
 */
export async function confirmOverride(action) {
  const holder = heldByOther();
  if (!holder) {
    return { ok: true, force: false };
  }
  if (!isAdmin()) {
    showToast(`${holder} is handling this conversation.`, 'warning');
    return { ok: false, force: false };
  }
  const ok = await confirmDialog({ ...OVERRIDES[action](holder), danger: true });
  return { ok, force: ok };
}

/** Redraw the open conversation's buttons, after something changed who holds it. */
export function refreshConversationControls() {
  setHeld();
}

/** What ending tells the customer, depending on what they did. */
function endCopy(conversation) {
  if (!conversation) {
    return '';
  }
  if (conversation.channel === 'email') {
    return 'The conversation is closed. A new email from them opens it again.';
  }
  if (isAppChannel(conversation.channel)) {
    // No rating form on WhatsApp, Messenger or Instagram.
    return 'The customer is told the chat has ended. A new message from them starts a new conversation.';
  }
  const visitorMessages = (conversation.messages || []).filter(message => message.sender === 'user').length;
  const rated = conversation.rating && conversation.rating.score;
  // Matches when the server asks for a rating (services/csat.js): only once
  // they have actually said something, and never twice.
  const willAsk = visitorMessages >= 2 && !rated && !conversation.ratingRequestedAt;
  return willAsk
    ? 'The customer is told the chat has ended and asked how it went. A new message from them starts a new conversation.'
    : 'The customer is told the chat has ended. A new message from them starts a new conversation.';
}

let endForce = false;

async function openEndDialog() {
  const sessionId = selected;
  if (!sessionId) {
    return;
  }
  const override = await confirmOverride('end');
  if (!override.ok) {
    return;
  }
  endForce = override.force;

  $('end-chat-copy').textContent = endCopy(state.currentConversation);
  $('end-chat-note').value = '';
  const resolved = $('end-outcome-resolved');
  if (resolved) {
    resolved.checked = true;
  }
  bootstrap.Modal.getOrCreateInstance($('endChatModal')).show();
}

function confirmEnd(socket) {
  const sessionId = selected;
  if (!sessionId) {
    return;
  }
  const chosen = document.querySelector('input[name="end-outcome"]:checked');
  const note = $('end-chat-note').value.trim();

  socket.emit('end-chat', {
    sessionId,
    outcome: { status: chosen ? chosen.value : 'resolved', note: note || undefined },
    force: endForce || undefined
  });
  bootstrap.Modal.getOrCreateInstance($('endChatModal')).hide();
  endForce = false;

  removeChatFromList(sessionId);
  if (state.currentConversation) {
    // Shown as ended straight away; the reload confirms it.
    state.currentConversation.status = 'ended';
    state.currentConversation.operatorId = null;
    setHeld();
  }
  setTimeout(() => {
    if (selected === sessionId) {
      openConversation(sessionId, { navigate: false });
    }
  }, 800);
}

/** The conversation this person is deleting right now, if any. */
let deleting = null;

async function deleteConversation() {
  const sessionId = selected;
  if (!sessionId || !isAdmin()) {
    return;
  }
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
    // The broadcast about it arrives first; this person needs one toast.
    deleting = sessionId;
    await api(`/api/admin/chat/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    removeChatFromList(sessionId);
    if (selected === sessionId) {
      resetChatView();
      updateUrlWithParams({ section: 'active-chats' });
    }
    showToast('Conversation deleted', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not delete the conversation'), 'danger');
  } finally {
    deleting = null;
  }
}

function setupActions(socket) {
  $('join-chat-btn').addEventListener('click', async () => {
    const sessionId = selected;
    if (!sessionId) {
      return;
    }
    const override = await confirmOverride('takeover');
    if (!override.ok) {
      return;
    }
    // The server names the operator from the socket's own identity.
    socket.emit('operator-takeover', override.force ? { sessionId, force: true } : { sessionId });

    if (state.currentConversation && state.currentConversation.sessionId === sessionId) {
      state.currentConversation.operatorId = me();
      state.currentConversation.operatorName = myName();
    }
    if (chats.has(sessionId)) {
      mergeChat(sessionId, { operatorId: me(), operatorName: myName() });
    }
    setHeld();
    $('operator-message').focus();
  });

  // Two named ways to leave, rather than one confirm() whose OK and Cancel
  // meant different things.
  document.querySelectorAll('[data-leave]').forEach(button => {
    button.addEventListener('click', async () => {
      const sessionId = selected;
      if (!sessionId) {
        return;
      }
      const override = await confirmOverride('leave');
      if (!override.ok) {
        return;
      }
      const passToBot = button.getAttribute('data-leave') === 'bot';
      socket.emit('operator-leave', { sessionId, passToBot, force: override.force || undefined });

      if (state.currentConversation && state.currentConversation.sessionId === sessionId) {
        state.currentConversation.operatorId = null;
        state.currentConversation.operatorName = null;
      }
      if (chats.has(sessionId)) {
        mergeChat(sessionId, passToBot
          ? { operatorId: null, operatorName: null, waitingSince: null }
          : { operatorId: null, operatorName: null, waitingSince: new Date().toISOString() });
      }
      setHeld();
      showToast(passToBot ? 'The bot has the conversation again.' : 'Back in the queue for someone else.', 'info');
    });
  });

  $('end-chat-btn').addEventListener('click', openEndDialog);
  $('confirm-end-chat-btn').addEventListener('click', () => confirmEnd(socket));
  $('delete-chat-btn')?.addEventListener('click', deleteConversation);

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
  if (!chats.has(sessionId)) {
    return;
  }
  unread.set(sessionId, (unread.get(sessionId) || 0) + 1);
  renderRow(chats.get(sessionId));
  // A message in a conversation this person holds is theirs to answer, and
  // worth a sound under "Important only"; one the bot is handling is not.
  if (alertAllowed(isMine(chats.get(sessionId)) ? 'assignment' : 'message')) {
    beep();
  }
}

/**
 * Bring one conversation's queue row up to date from the server: after an
 * event that does not say enough (somebody left: is it waiting again?).
 */
async function refreshChat(sessionId, { alert = false } = {}) {
  try {
    const chat = await api(`/api/admin/chat/${encodeURIComponent(sessionId)}`);
    if (!chat || chat.status === 'ended') {
      removeChatFromList(sessionId);
      return null;
    }
    const isNew = !chats.has(sessionId);
    mergeChat(sessionId, recordFrom(chat));
    if (alert && isNew) {
      notifyNewChat({
        sessionId,
        visitorName: recordFrom(chat).visitorName,
        domain: chat.domain,
        reactivated: true
      });
    }
    return chat;
  } catch (error) {
    logger.error('Could not load a conversation into the queue:', error);
    return null;
  }
}

/**
 * A message stored in a conversation, from whichever event said so.
 *
 * `conversation-message` carries every stored message; `new-message` is the
 * older event and carries some of them. Either may arrive, or both: the id
 * makes a message count, and appear, once.
 */
function onMessage(sessionId, message) {
  if (!sessionId || !message) {
    return;
  }
  const id = message._id || message.messageId || message.id;
  const seen = counted.get(sessionId) || new Set();
  const isNew = !id || !seen.has(String(id));
  if (id) {
    seen.add(String(id));
    counted.set(sessionId, seen);
  }

  if (selected === sessionId) {
    const conversation = state.currentConversation;
    addMessageToChat({
      ...message,
      userName: conversation ? metadataOf(conversation).name : null
    });
    if (conversation && message.sender === 'user' && Array.isArray(conversation.messages) && isNew) {
      conversation.messages.push(message);
    }
    if (message.sender === 'user' && isNew) {
      markReadByMe(sessionId);
    }
  }

  if (!chats.has(sessionId)) {
    // Something new in a conversation the queue does not have: it started
    // or came back while we were not looking.
    if (message.sender === 'user') {
      refreshChat(sessionId);
    }
    return;
  }

  if (!isNew) {
    return;
  }

  const record = chats.get(sessionId);
  const spoken = message.sender !== 'system';
  mergeChat(sessionId, {
    lastActivity: message.timestamp || new Date().toISOString(),
    ...(spoken ? {
      messageCount: (record.messageCount || 0) + 1,
      lastMessage: {
        sender: message.sender,
        content: String(message.content || message.fileName || '').slice(0, 140),
        timestamp: message.timestamp
      }
    } : {})
  });

  if (selected !== sessionId && message.sender === 'user') {
    markUnread(sessionId);
  }
}

/**
 * Somebody wants a person. Louder than a new message: they have asked and
 * are now watching an empty chat window.
 */
function onHandoff(data) {
  const sessionId = data && data.sessionId;
  if (!sessionId) {
    return;
  }
  const requestedAt = data.requestedAt || new Date().toISOString();
  const update = { handoff: { reason: data.reason || null, requestedAt } };
  if (data.visitorName) {
    update.visitorName = data.visitorName;
  }

  if (chats.has(sessionId)) {
    const record = chats.get(sessionId);
    if (!record.operatorId) {
      update.waitingSince = record.waitingSince || requestedAt;
    }
    mergeChat(sessionId, update);
  } else {
    refreshChat(sessionId);
  }

  if (selected === sessionId && state.currentConversation) {
    state.currentConversation.handoff = { ...(state.currentConversation.handoff || {}), ...update.handoff };
    renderHandoffStrip(state.currentConversation);
  }

  const name = data.visitorName || (chatRecord(sessionId) && chatRecord(sessionId).visitorName) || 'A visitor';
  const reason = HANDOFF_REASONS[data.reason] || 'Asked for a person';
  alertPerson({
    kind: 'handoff',
    key: `handoff:${sessionId}`,
    title: `${name}: ${reason.toLowerCase()}`,
    body: data.preview || '',
    tone: 'warning',
    open: () => openConversation(sessionId)
  });
}

/** Waiting for `handoff-requested` before falling back to the older event. */
const handoffFallbacks = new Map();

function setupSocketEvents(socket) {
  setupSuggestionEventHandlers(socket);

  // A new conversation, once somebody has actually engaged.
  socket.on('new-chat', data => {
    if (!data || !data.sessionId) {
      return;
    }
    addChatToList({
      ...data,
      lastActivity: data.createdAt || data.timestamp || new Date().toISOString(),
      startedAt: data.createdAt || data.timestamp,
      // The email channel's event carries the first message as `message`.
      preview: data.preview || data.message,
      messageCount: data.messageCount || (data.preview || data.message ? 1 : 0)
    });
    notifyNewChat({
      sessionId: data.sessionId,
      visitorName: data.visitorName || data.userName,
      domain: data.domain,
      preview: data.preview || data.subject
    });
  });

  socket.on('handoff-requested', data => {
    const pending = data && handoffFallbacks.get(data.sessionId);
    if (pending) {
      clearTimeout(pending);
      handoffFallbacks.delete(data.sessionId);
    }
    onHandoff(data);
  });

  // The older event for the same thing. Servers that send both are heard
  // once; one that sends only this is still heard.
  socket.on('operator-requested', data => {
    const sessionId = data && data.sessionId;
    if (!sessionId || handoffFallbacks.has(sessionId)) {
      return;
    }
    handoffFallbacks.set(sessionId, setTimeout(() => {
      handoffFallbacks.delete(sessionId);
      const record = chatRecord(sessionId);
      if (record && record.handoff && Date.now() - new Date(record.handoff.requestedAt).getTime() < 5000) {
        return;
      }
      if (data.assigned) {
        refreshChat(sessionId);
        return;
      }
      onHandoff({ sessionId, reason: 'visitor_request', requestedAt: data.timestamp });
    }, 1500));
  });

  socket.on('chat-ended', data => {
    const sessionId = data && data.sessionId;
    removeChatFromList(sessionId);
    if (selected === sessionId && state.currentConversation && state.currentConversation.status !== 'ended') {
      openConversation(sessionId, { navigate: false });
    }
  });

  socket.on('conversation-deleted', data => {
    const sessionId = data && data.sessionId;
    removeChatFromList(sessionId);
    if (selected === sessionId) {
      resetChatView();
      if (deleting !== sessionId) {
        showToast('This conversation was deleted.', 'secondary');
      }
    }
  });

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
      actionToast(`A customer rated a conversation ${data.score}/5`, {
        type: 'warning',
        onAction: () => openConversation(data.sessionId)
      });
    }
  });

  socket.on('message-feedback', data => {
    if (!data || selected !== data.sessionId) {
      return;
    }
    const element = document.querySelector(`#chat-messages [data-message-id="${CSS.escape(String(data.messageId))}"]`);
    if (element) {
      showFeedback(element, data.rating);
    }
  });

  socket.on('operator-joined', data => {
    if (!data || !data.sessionId) {
      return;
    }
    const operatorId = data.operatorId ? String(data.operatorId) : null;
    if (chats.has(data.sessionId)) {
      mergeChat(data.sessionId, { operatorId: operatorId || 'someone', operatorName: data.operatorName || null });
    }
    if (selected === data.sessionId && state.currentConversation) {
      state.currentConversation.operatorId = operatorId;
      state.currentConversation.operatorName = data.operatorName || null;
      setHeld();
    }
  });

  // The server's answer to re-joining a conversation we already hold.
  socket.on('operator-rejoined', data => {
    const sessionId = data && data.sessionId;
    if (!sessionId) {
      return;
    }
    if (chats.has(sessionId) && !isMine(chats.get(sessionId))) {
      mergeChat(sessionId, { operatorId: me(), operatorName: myName() });
    }
    if (selected === sessionId) {
      setHeld();
    }
  });

  socket.on('operator-left', data => {
    const sessionId = data && data.sessionId;
    if (!sessionId) {
      return;
    }

    // A dropped connection can hand the chat straight to somebody else; show
    // the new owner rather than a chat that looks unattended.
    if (data.reassignedTo) {
      const to = data.reassignedTo;
      const name = typeof to === 'object' ? (to.name || to.displayName || 'another operator') : String(to);
      const id = typeof to === 'object' ? (to.id || to._id || null) : null;
      updateChatOperatorStatus(sessionId, true, name, id);
    } else if (chats.has(sessionId)) {
      // Back to the bot or back to the queue: the server knows which.
      mergeChat(sessionId, { operatorId: null, operatorName: null });
      refreshChat(sessionId);
    }

    if (selected === sessionId && state.currentConversation &&
        String(state.currentConversation.operatorId || '') === String(data.operatorId || '')) {
      state.currentConversation.operatorId = null;
      state.currentConversation.operatorName = null;
      setHeld();
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
    const takenBy = data.takenBy && typeof data.takenBy === 'object'
      ? (data.takenBy.name || data.takenBy.displayName || 'another operator')
      : (data.takenBy || 'another operator');

    if (chats.has(sessionId)) {
      mergeChat(sessionId, { operatorId: 'someone', operatorName: takenBy });
      refreshChat(sessionId);
    }
    if (selected === sessionId && state.currentConversation) {
      state.currentConversation.operatorId = 'someone';
      state.currentConversation.operatorName = takenBy;
      setHeld();
    }
    showToast(`${takenBy} took over a chat you were in.`, 'warning');
  });

  // The server refused something - most often a join of a chat another
  // operator holds, which an admin may take anyway.
  socket.on('error', async data => {
    const payload = typeof data === 'string' ? { message: data } : (data || {});

    if (payload.heldBy && payload.sessionId) {
      const holder = payload.heldBy.name || 'another operator';
      const holderId = payload.heldBy.id ? String(payload.heldBy.id) : 'someone';

      // Whatever the join button did optimistically is undone: we are not in.
      if (chats.has(payload.sessionId)) {
        mergeChat(payload.sessionId, { operatorId: holderId, operatorName: holder });
      }
      if (selected === payload.sessionId && state.currentConversation) {
        state.currentConversation.operatorId = holderId;
        state.currentConversation.operatorName = holder;
        setHeld();
      }

      if (isAdmin() && await confirmDialog({
        title: 'Take over this conversation?',
        message: `${holder} is already in it. They will be told you took over and can no longer reply.`,
        confirmLabel: 'Take over'
      })) {
        socket.emit('operator-takeover', { sessionId: payload.sessionId, force: true });
        if (chats.has(payload.sessionId)) {
          mergeChat(payload.sessionId, { operatorId: me(), operatorName: myName() });
        }
        if (selected === payload.sessionId && state.currentConversation) {
          state.currentConversation.operatorId = me();
          state.currentConversation.operatorName = myName();
          setHeld();
        }
        return;
      }

      showToast(`${holder} is already handling this chat.`, 'warning');
      return;
    }

    showToast(payload.message || 'The server refused that request.', 'danger');
  });

  socket.on('user-details-updated', data => {
    if (!data || !data.sessionId) {
      return;
    }
    if (chats.has(data.sessionId)) {
      mergeChat(data.sessionId, {
        ...(data.name ? { visitorName: data.name } : {}),
        ...(data.email ? { email: data.email } : {})
      });
    }
    if (state.currentConversation && state.currentConversation.sessionId === data.sessionId) {
      state.currentConversation.metadata = {
        ...metadataOf(state.currentConversation),
        name: data.name,
        email: data.email,
        phone: data.phone
      };
      displayUserContactInfo(state.currentConversation);
      if (data.name) {
        $('selected-chat-title').textContent = data.name;
      }
    }
  });

  socket.on('new-message', data => {
    if (!data || !data.sessionId) {
      return;
    }
    onMessage(data.sessionId, {
      ...data,
      _id: data.messageId,
      content: data.message
    });
  });

  // Every stored message, operator replies and event lines included, so a
  // second person viewing the conversation sees everything the first does.
  socket.on('conversation-message', data => {
    if (data && data.sessionId && data.message) {
      onMessage(data.sessionId, data.message);
      noteChannelMessage(data.sessionId, data.message);
    }
  });

  socket.on('chat-reactivated', data => refreshChat(data.sessionId, { alert: true }));

  // A reply to a visitor who had gone went out by email instead; the
  // transcript gets its own line from the server, this just says so now.
  socket.on('operator-message-emailed', data => {
    if (data && data.to) {
      showToast(`They had left, so your reply was emailed to ${data.to}.`, 'info');
    }
  });

  // A visitor who closes the tab keeps their place for three minutes.
  const disconnectTimers = {};
  socket.on('chat-activity', ({ type, sessionId }) => {
    if (selected === sessionId && state.currentConversation) {
      state.currentConversation.visitorOnline = type === 'opened';
    }
    if (type === 'opened') {
      if (!chats.has(sessionId)) {
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
      if (!chats.has(sessionId)) {
        return;
      }
      if (selected === sessionId) {
        addMessageToChat({
          content: 'The visitor closed the chat. It stays open for three minutes in case they come back.',
          sender: 'system',
          timestamp: new Date()
        });
      }
      listItem(sessionId)?.classList.add('user-disconnected');
      disconnectTimers[sessionId] = setTimeout(() => {
        delete disconnectTimers[sessionId];
        // Still open on the server means it is still somebody's to answer;
        // the queue asks rather than guessing.
        refreshChat(sessionId);
        listItem(sessionId)?.classList.remove('user-disconnected');
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
  setInterval(tickTimers, 30 * 1000);
}

registerSection('active-chats', {
  show(params) {
    const sessionId = params.chat || params.session;
    if (sessionId && sessionId !== selected) {
      openConversation(sessionId, { navigate: false });
    }
  }
});
