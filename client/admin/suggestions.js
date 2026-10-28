/**
 * AI-drafted replies for an operator.
 *
 * When a person holds a conversation the assistant drafts instead of
 * answering; the operator uses a draft as it is, edits it first, or ignores
 * it.
 *
 * Drafts are a plan feature and a per-conversation switch. "Suggest a reply"
 * is only offered when both allow it - on a plan without drafts it used to say
 * "Drafting…" forever - and the switch lives in the composer, where it can be
 * turned back on; it used to live inside the first draft's card, so switching
 * it off removed the only way back.
 */

import { addMessageToChat, confirmPendingMessage, selectedSessionId } from './inbox.js';
import { state } from './state.js';
import { escapeHtml, showToast } from './utils.js';

/** Longest reply the server accepts from a suggestion. */
const MAX_SUGGESTION_LENGTH = 4000;

/** How long "Drafting…" waits before giving up quietly. */
const DRAFT_TIMEOUT_MS = 20000;

/** Whether the open conversation can have drafts at all, and has them on. */
function draftsAvailable() {
  const conversation = state.currentConversation;
  if (!conversation) {
    return false;
  }
  const features = conversation.features || {};
  return features.aiSuggestions !== false && conversation.suggestionsEnabled !== false;
}

/** Put a "Drafting…" button back to "Suggest a reply". */
function resetButton(button) {
  if (!button) {
    return;
  }
  clearTimeout(Number(button.dataset.timer));
  delete button.dataset.timer;
  button.disabled = false;
  button.textContent = 'Suggest a reply';
}

function draftingButton(messageId) {
  if (messageId) {
    const message = document.querySelector(`#chat-messages [data-message-id="${CSS.escape(String(messageId))}"]`);
    const button = message && message.querySelector('.get-suggestion-btn[data-timer]');
    if (button) {
      return button;
    }
  }
  return document.querySelector('#chat-messages .get-suggestion-btn[data-timer]');
}

/**
 * The "Suggest a reply" button under a visitor's message, while the operator
 * is in the conversation.
 */
export function addSuggestionButton(messageDiv) {
  if (!draftsAvailable() || messageDiv.querySelector('.get-suggestion-btn')) {
    return;
  }

  let actionDiv = messageDiv.querySelector('.message-actions');
  if (!actionDiv) {
    actionDiv = document.createElement('div');
    actionDiv.className = 'message-actions';
    messageDiv.appendChild(actionDiv);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm btn-link p-0 get-suggestion-btn';
  button.textContent = 'Suggest a reply';
  button.addEventListener('click', () => {
    state.socket.emit('request-suggestions', {
      sessionId: selectedSessionId(),
      messageId: messageDiv.dataset.messageId
    });

    button.disabled = true;
    button.textContent = 'Drafting…';
    button.dataset.timer = String(setTimeout(() => resetButton(button), DRAFT_TIMEOUT_MS));
  });

  actionDiv.appendChild(button);
}

/** Add or remove the suggestion buttons on every visitor message shown. */
export function setSuggestionButtons(enabled) {
  document.querySelectorAll('#chat-messages .message.user').forEach(messageDiv => {
    if (enabled && draftsAvailable()) {
      addSuggestionButton(messageDiv);
    } else {
      messageDiv.querySelector('.get-suggestion-btn')?.remove();
      const actions = messageDiv.querySelector('.message-actions');
      if (actions && !actions.children.length) {
        actions.remove();
      }
    }
  });
}

/**
 * The composer's switch, from the open conversation: shown only on a plan
 * with drafts, and set from what the server has for this conversation.
 */
export function syncSuggestionsSwitch(conversation) {
  const wrapper = document.getElementById('suggestions-switch');
  const toggle = document.getElementById('suggestions-toggle');
  if (!wrapper || !toggle) {
    return;
  }
  const offered = Boolean(conversation) && (conversation.features || {}).aiSuggestions !== false;
  wrapper.style.display = offered ? '' : 'none';
  toggle.checked = Boolean(conversation) && conversation.suggestionsEnabled !== false;
}

let suggestionCounter = 0;

function displaySuggestion(data) {
  const { sessionId, userMessage, suggestion, userMessageId } = data || {};

  // A failed draft is not a draft. The error text used to be shown as one,
  // with a "Use" button that would have sent it to the customer.
  if (!data || data.error || typeof suggestion !== 'string' || !suggestion.trim()) {
    resetButton(draftingButton(userMessageId));
    if (data && selectedSessionId() === sessionId) {
      showToast('Could not draft a reply this time.', 'secondary');
    }
    return;
  }

  if (selectedSessionId() !== sessionId) {
    // Not the current chat, don't display
    return;
  }

  resetButton(draftingButton(userMessageId));

  // The server no longer keeps suggestions, so there is no id to refer back
  // to: the text is sent when it is used. A local id ties the buttons to the
  // right card.
  const suggestionId = `local-${Date.now()}-${++suggestionCounter}`;

  let suggestionsContainer = document.querySelector('.suggestions-container');
  if (!suggestionsContainer) {
    suggestionsContainer = document.createElement('div');
    suggestionsContainer.className = 'suggestions-container';
    suggestionsContainer.innerHTML = `
      <div class="suggestions-header">
        <h5 class="suggestions-title">Drafted replies</h5>
        <button type="button" class="btn btn-sm btn-link p-0 suggestions-clear">Clear</button>
      </div>`;
    suggestionsContainer.querySelector('.suggestions-clear')
      .addEventListener('click', () => suggestionsContainer.remove());

    // Insert after chat messages and before operator input
    const chatMessages = document.getElementById('chat-messages');
    chatMessages.parentNode.insertBefore(suggestionsContainer, document.getElementById('operator-input'));
  }

  const suggestionItem = document.createElement('div');
  suggestionItem.className = 'suggestion-item';
  suggestionItem.dataset.suggestionId = suggestionId;
  suggestionItem.dataset.sessionId = sessionId;
  suggestionItem.innerHTML = `
    ${userMessage ? `<div class="user-query">Visitor: ${escapeHtml(userMessage)}</div>` : ''}
    <div class="suggestion-content"></div>
    <div class="suggestion-actions">
      <button class="btn btn-sm btn-primary use-suggestion-btn">Use</button>
      <button class="btn btn-sm btn-secondary edit-suggestion-btn">Edit</button>
      <button class="btn btn-sm btn-outline-danger dismiss-suggestion-btn">Dismiss</button>
    </div>`;
  suggestionItem.querySelector('.suggestion-content').textContent = suggestion;
  suggestionsContainer.appendChild(suggestionItem);

  suggestionItem.querySelector('.use-suggestion-btn').addEventListener('click', () => useSuggestion(suggestionId));
  suggestionItem.querySelector('.edit-suggestion-btn').addEventListener('click', () => {
    editSuggestion(suggestionItem, suggestion);
  });
  suggestionItem.querySelector('.dismiss-suggestion-btn').addEventListener('click', () => suggestionItem.remove());
}

/** Shown in the transcript at once; matched to its id when the server confirms. */
function showSent(text) {
  addMessageToChat({
    content: text,
    sender: 'operator',
    operatorId: state.currentUser ? String(state.currentUser.id || '') : undefined,
    timestamp: new Date()
  }, { pending: true });
}

function markUsed(suggestionItem, note) {
  suggestionItem.classList.add('used');
  suggestionItem.querySelectorAll('button').forEach(button => {
    button.disabled = true;
  });
  if (note && !suggestionItem.querySelector('.suggestion-note')) {
    const noteEl = document.createElement('div');
    noteEl.className = 'text-muted small mt-2 suggestion-note';
    noteEl.textContent = note;
    suggestionItem.appendChild(noteEl);
  }
}

// Function to use a suggestion
function useSuggestion(suggestionId) {
  const socket = state.socket;
  const sessionId = selectedSessionId();

  const suggestionItem = document.querySelector(`.suggestion-item[data-suggestion-id="${CSS.escape(suggestionId)}"]`);
  if (!suggestionItem) {
    return;
  }
  const suggestionText = suggestionItem.querySelector('.suggestion-content').textContent;

  showSent(suggestionText);

  // The text itself goes up, as the server does not hold a copy.
  socket.emit('use-suggestion', {
    sessionId,
    suggestion: suggestionText.slice(0, MAX_SUGGESTION_LENGTH)
  });

  markUsed(suggestionItem);
}

// Function to edit a suggestion
function editSuggestion(suggestionItem, suggestion) {
  const editContainer = document.createElement('div');
  editContainer.className = 'suggestion-edit-container';

  const textarea = document.createElement('textarea');
  textarea.className = 'suggestion-edit-textarea form-control';
  textarea.value = suggestion;
  editContainer.appendChild(textarea);

  const actionsEl = document.createElement('div');
  actionsEl.className = 'suggestion-edit-actions';
  actionsEl.innerHTML = `
    <button class="btn btn-sm btn-primary save-edit-btn">Save & Use</button>
    <button class="btn btn-sm btn-secondary cancel-edit-btn">Cancel</button>
  `;
  editContainer.appendChild(actionsEl);

  const contentEl = suggestionItem.querySelector('.suggestion-content');
  const originalActionsEl = suggestionItem.querySelector('.suggestion-actions');
  contentEl.style.display = 'none';
  originalActionsEl.style.display = 'none';

  suggestionItem.appendChild(editContainer);
  textarea.focus();

  editContainer.querySelector('.save-edit-btn').addEventListener('click', () => {
    const editedText = textarea.value.trim();
    if (!editedText) {
      return;
    }

    showSent(editedText);

    // Both the original and the edit go up, so the server can tell how much
    // the operator changed.
    state.socket.emit('use-suggestion', {
      sessionId: selectedSessionId(),
      suggestion: suggestion.slice(0, MAX_SUGGESTION_LENGTH),
      edited: editedText.slice(0, MAX_SUGGESTION_LENGTH)
    });

    contentEl.textContent = editedText;
    contentEl.style.display = 'block';
    originalActionsEl.style.display = 'flex';
    editContainer.remove();
    markUsed(suggestionItem);
  });

  editContainer.querySelector('.cancel-edit-btn').addEventListener('click', () => {
    contentEl.style.display = 'block';
    originalActionsEl.style.display = 'flex';
    editContainer.remove();
  });
}

function setupSwitch(socket) {
  const toggle = document.getElementById('suggestions-toggle');
  if (!toggle) {
    return;
  }
  toggle.addEventListener('change', () => {
    const sessionId = selectedSessionId();
    if (!sessionId) {
      return;
    }
    const enabled = toggle.checked;
    socket.emit('toggle-suggestions', { sessionId, enabled });

    if (state.currentConversation && state.currentConversation.sessionId === sessionId) {
      state.currentConversation.suggestionsEnabled = enabled;
    }
    const joined = document.getElementById('join-chat-btn')?.hasAttribute('data-joined');
    setSuggestionButtons(Boolean(joined));
    if (!enabled) {
      document.querySelector('.suggestions-container')?.remove();
    }
  });
}

// Add socket event listeners for suggestions
export function setupSuggestionEventHandlers(socket) {
  setupSwitch(socket);

  socket.on('operator-suggestion', data => displaySuggestion(data));

  /**
   * Somebody sent a reply from a draft. The server says which conversation
   * and who, not which card - there are no card ids on the server - so:
   * our own use is already marked; a colleague's makes our drafts for that
   * conversation stale.
   */
  socket.on('suggestion-used', data => {
    if (!data || selectedSessionId() !== data.sessionId) {
      return;
    }
    const mine = state.currentUser && String(data.operatorId) === String(state.currentUser.id);
    if (mine) {
      // Our reply is on screen already; now it has its stored id.
      confirmPendingMessage(data.messageId);
      return;
    }
    document.querySelectorAll(`.suggestion-item[data-session-id="${CSS.escape(String(data.sessionId))}"]:not(.used)`)
      .forEach(item => markUsed(item, `${data.operatorName || 'A colleague'} has already replied`));
  });

  // Another operator, or another tab, switched drafts on or off.
  socket.on('suggestions-status-changed', data => {
    if (!data || selectedSessionId() !== data.sessionId) {
      return;
    }
    if (state.currentConversation) {
      state.currentConversation.suggestionsEnabled = data.enabled;
    }
    syncSuggestionsSwitch(state.currentConversation);
    const joined = document.getElementById('join-chat-btn')?.hasAttribute('data-joined');
    setSuggestionButtons(Boolean(joined));
  });

  // The server could not change it: put the switch back.
  socket.on('suggestions-toggled', data => {
    if (data && data.success === false && selectedSessionId() === data.sessionId) {
      if (state.currentConversation) {
        state.currentConversation.suggestionsEnabled = !state.currentConversation.suggestionsEnabled;
      }
      syncSuggestionsSwitch(state.currentConversation);
      showToast(data.error || 'Could not change the drafts setting', 'danger');
    }
  });
}
