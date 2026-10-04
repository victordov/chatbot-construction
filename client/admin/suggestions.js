/**
 * AI-drafted replies for an operator.
 *
 * When a person holds a conversation the assistant drafts instead of
 * answering; the operator uses a draft as it is, edits it first, or ignores
 * it.
 */

import { addMessageToChat, selectedSessionId } from './inbox.js';
import { state } from './state.js';

/** Longest reply the server accepts from a suggestion. */
const MAX_SUGGESTION_LENGTH = 4000;

/**
 * The "Suggest a reply" button under a visitor's message, while the operator
 * is in the conversation.
 */
export function addSuggestionButton(messageDiv) {
  if (messageDiv.querySelector('.message-actions')) {
    return;
  }

  const actionDiv = document.createElement('div');
  actionDiv.className = 'message-actions';

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
    setTimeout(() => {
      button.disabled = false;
      button.textContent = 'Suggest a reply';
    }, 5000);
  });

  actionDiv.appendChild(button);
  messageDiv.appendChild(actionDiv);
}

/** Add or remove the suggestion buttons on every visitor message shown. */
export function setSuggestionButtons(enabled) {
  document.querySelectorAll('#chat-messages .message.user').forEach(messageDiv => {
    if (enabled) {
      addSuggestionButton(messageDiv);
    } else {
      messageDiv.querySelector('.message-actions')?.remove();
    }
  });
}

let suggestionCounter = 0;

function displaySuggestion(data) {
  const { sessionId, userMessage, suggestion } = data;

  // The server no longer keeps suggestions, so there is no id to refer back
  // to: the text is sent when it is used. A local id ties the buttons to the
  // right card.
  const suggestionId = `local-${Date.now()}-${++suggestionCounter}`;

  if (selectedSessionId() !== sessionId) {
    // Not the current chat, don't display
    return;
  }

  // Check if suggestions container exists, create if not
  let suggestionsContainer = document.querySelector('.suggestions-container');
  if (!suggestionsContainer) {
    suggestionsContainer = document.createElement('div');
    suggestionsContainer.className = 'suggestions-container';

    // Create header
    const header = document.createElement('div');
    header.className = 'suggestions-header';
    header.innerHTML = `
      <h5 class="suggestions-title">AI Suggestions</h5>
      <div class="suggestions-controls">
        <div class="form-check form-switch">
          <input class="form-check-input" type="checkbox" id="suggestions-toggle" checked>
          <label class="form-check-label" for="suggestions-toggle">Enable Suggestions</label>
        </div>
      </div>
    `;
    suggestionsContainer.appendChild(header);

    // Add event listener for toggle switch
    const toggle = header.querySelector('#suggestions-toggle');
    toggle.addEventListener('change', function() {
      const enabled = this.checked;
      const sessionId = selectedSessionId();

      // Emit event to toggle suggestions
      const socket = state.socket;
      socket.emit('toggle-suggestions', {
        sessionId,
        enabled
      });
    });

    // Insert after chat messages and before operator input
    const chatMessages = document.getElementById('chat-messages');
    chatMessages.parentNode.insertBefore(suggestionsContainer, document.getElementById('operator-input'));
  }

  // Create suggestion item
  const suggestionItem = document.createElement('div');
  suggestionItem.className = 'suggestion-item';
  suggestionItem.dataset.suggestionId = suggestionId;

  // Add user query
  const userQueryEl = document.createElement('div');
  userQueryEl.className = 'user-query';
  userQueryEl.textContent = `User: ${userMessage}`;
  suggestionItem.appendChild(userQueryEl);

  // Add suggestion content
  const contentEl = document.createElement('div');
  contentEl.className = 'suggestion-content';
  contentEl.textContent = suggestion;
  suggestionItem.appendChild(contentEl);

  // Add action buttons
  const actionsEl = document.createElement('div');
  actionsEl.className = 'suggestion-actions';
  actionsEl.innerHTML = `
    <button class="btn btn-sm btn-primary use-suggestion-btn">Use</button>
    <button class="btn btn-sm btn-secondary edit-suggestion-btn">Edit</button>
    <button class="btn btn-sm btn-outline-danger dismiss-suggestion-btn">Dismiss</button>
  `;
  suggestionItem.appendChild(actionsEl);

  // Add to container
  suggestionsContainer.appendChild(suggestionItem);

  // Add event listeners
  const useBtn = suggestionItem.querySelector('.use-suggestion-btn');
  useBtn.addEventListener('click', function() {
    useSuggestion(suggestionId);
  });

  const editBtn = suggestionItem.querySelector('.edit-suggestion-btn');
  editBtn.addEventListener('click', function() {
    editSuggestion(suggestionItem, suggestion, suggestionId);
  });

  const dismissBtn = suggestionItem.querySelector('.dismiss-suggestion-btn');
  dismissBtn.addEventListener('click', function() {
    suggestionItem.remove();
  });
}

// Function to use a suggestion
function useSuggestion(suggestionId) {
  // Use the global socket connection with authentication
  const socket = state.socket;
  const sessionId = selectedSessionId();

  // Mark suggestion as used
  const suggestionItem = document.querySelector(`.suggestion-item[data-suggestion-id="${CSS.escape(suggestionId)}"]`);
  if (suggestionItem) {
    const suggestionText = suggestionItem.querySelector('.suggestion-content').textContent;

    // Add message to chat window to show it's being sent
    addMessageToChat({
      content: suggestionText,
      sender: 'operator',
      timestamp: new Date()
    });

    // Emit the event to use the suggestion: the text itself, as the server
    // does not hold a copy.
    socket.emit('use-suggestion', {
      sessionId: sessionId,
      suggestion: suggestionText.slice(0, MAX_SUGGESTION_LENGTH)
    });

    suggestionItem.classList.add('used');

    // Disable buttons
    const buttons = suggestionItem.querySelectorAll('button');
    buttons.forEach(btn => btn.disabled = true);
  }
}

// Function to edit a suggestion
function editSuggestion(suggestionItem, suggestion, suggestionId) {
  // Create edit container
  const editContainer = document.createElement('div');
  editContainer.className = 'suggestion-edit-container';

  // Create textarea with suggestion content
  const textarea = document.createElement('textarea');
  textarea.className = 'suggestion-edit-textarea form-control';
  textarea.value = suggestion;
  editContainer.appendChild(textarea);

  // Create action buttons
  const actionsEl = document.createElement('div');
  actionsEl.className = 'suggestion-edit-actions';
  actionsEl.innerHTML = `
    <button class="btn btn-sm btn-primary save-edit-btn">Save & Use</button>
    <button class="btn btn-sm btn-secondary cancel-edit-btn">Cancel</button>
  `;
  editContainer.appendChild(actionsEl);

  // Hide the original content and actions
  const contentEl = suggestionItem.querySelector('.suggestion-content');
  const originalActionsEl = suggestionItem.querySelector('.suggestion-actions');
  contentEl.style.display = 'none';
  originalActionsEl.style.display = 'none';

  // Add edit container
  suggestionItem.appendChild(editContainer);

  // Focus textarea
  textarea.focus();

  // Add event listeners
  const saveBtn = editContainer.querySelector('.save-edit-btn');
  saveBtn.addEventListener('click', function() {
    const editedText = textarea.value;
    const sessionId = selectedSessionId();

    // Add message to chat window to show it's being sent
    addMessageToChat({
      content: editedText,
      sender: 'operator',
      timestamp: new Date()
    });

    // Use the edited suggestion. Both the original and the edit go up, so
    // the server can tell how much the operator changed.
    const socket = state.socket;
    socket.emit('use-suggestion', {
      sessionId: sessionId,
      suggestion: suggestion.slice(0, MAX_SUGGESTION_LENGTH),
      edited: editedText.slice(0, MAX_SUGGESTION_LENGTH)
    });

    // Update UI
    contentEl.textContent = editedText;
    contentEl.style.display = 'block';
    originalActionsEl.style.display = 'flex';
    editContainer.remove();

    // Mark as used
    suggestionItem.classList.add('used');

    // Disable buttons
    const buttons = suggestionItem.querySelectorAll('.suggestion-actions button');
    buttons.forEach(btn => btn.disabled = true);
  });

  const cancelBtn = editContainer.querySelector('.cancel-edit-btn');
  cancelBtn.addEventListener('click', function() {
    // Restore original content and actions
    contentEl.style.display = 'block';
    originalActionsEl.style.display = 'flex';
    editContainer.remove();
  });
}

// Add socket event listeners for suggestions
export function setupSuggestionEventHandlers(socket) {
  // Listen for operator suggestions
  socket.on('operator-suggestion', function(data) {
    displaySuggestion(data);
  });

  // Listen for suggestion used events
  socket.on('suggestion-used', function(data) {
    const { suggestionId, operatorName } = data;

    // Mark suggestion as used if it exists
    const suggestionItem = suggestionId
      ? document.querySelector(`.suggestion-item[data-suggestion-id="${CSS.escape(String(suggestionId))}"]`)
      : null;
    if (suggestionItem) {
      suggestionItem.classList.add('used');

      // Add a note about who used it
      const noteEl = document.createElement('div');
      noteEl.className = 'text-muted small mt-2';
      noteEl.textContent = `Used by ${operatorName}`;
      suggestionItem.appendChild(noteEl);

      // Disable buttons
      const buttons = suggestionItem.querySelectorAll('button');
      buttons.forEach(btn => btn.disabled = true);
    }
  });

  // Listen for suggestions status changed
  socket.on('suggestions-status-changed', function(data) {
    const { sessionId, enabled } = data;

    // Update toggle if this is the current chat
    if (selectedSessionId() === sessionId) {
      const toggle = document.getElementById('suggestions-toggle');
      if (toggle) {
        toggle.checked = enabled;
      }
    }
  });
}

