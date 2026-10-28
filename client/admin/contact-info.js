/**
 * The customer's name, email and phone in an open conversation: editing them,
 * and asking the customer for them through the widget.
 */

import * as bootstrap from 'bootstrap';
import { chatRecord, displayUserContactInfo, mergeChat } from './inbox.js';
import { state } from './state.js';
import { api, errorMessage, logger, setLoading, showToast } from './utils.js';

// Set up contact information management
export function setupContactInfoManagement() {
  document.getElementById('edit-contact-info-btn').addEventListener('click', openContactInfoModal);
  document.getElementById('request-user-info-btn')?.addEventListener('click', requestUserInfo);
  document.getElementById('save-contact-info-btn').addEventListener('click', saveContactInfo);
}

function metadataOf(conversation) {
  const metadata = conversation && conversation.metadata;
  if (!metadata) {
    return {};
  }
  return metadata instanceof Map ? Object.fromEntries(metadata) : metadata;
}

// Open contact info modal
function openContactInfoModal() {
  const conversation = state.currentConversation;
  if (!conversation) {
    return;
  }

  const metadata = metadataOf(conversation);
  document.getElementById('contact-info-session-id').value = conversation.sessionId;
  document.getElementById('edit-name-input').value = metadata.name || '';
  document.getElementById('edit-email-input').value = metadata.email || '';
  document.getElementById('edit-phone-input').value = metadata.phone || '';

  bootstrap.Modal.getOrCreateInstance(document.getElementById('contactInfoModal')).show();
}

/**
 * Save the details. The server also updates the person behind the
 * conversation, so People shows the same; and when it refuses, its own
 * reason is shown ("that email address does not look right") rather than a
 * generic failure.
 */
async function saveContactInfo() {
  const sessionId = document.getElementById('contact-info-session-id').value;
  const details = {
    name: document.getElementById('edit-name-input').value.trim(),
    email: document.getElementById('edit-email-input').value.trim(),
    phone: document.getElementById('edit-phone-input').value.trim()
  };
  const button = document.getElementById('save-contact-info-btn');

  setLoading(button, true);
  try {
    await api(`/api/admin/chat/${encodeURIComponent(sessionId)}/contact-info`, {
      method: 'POST',
      body: details
    });

    bootstrap.Modal.getOrCreateInstance(document.getElementById('contactInfoModal')).hide();

    if (state.currentConversation && state.currentConversation.sessionId === sessionId) {
      state.currentConversation.metadata = { ...metadataOf(state.currentConversation), ...details };
      displayUserContactInfo(state.currentConversation);
      if (details.name) {
        document.getElementById('selected-chat-title').textContent = details.name;
      }
    }
    if (chatRecord(sessionId)) {
      mergeChat(sessionId, {
        ...(details.name ? { visitorName: details.name } : {}),
        ...(details.email ? { email: details.email } : {})
      });
    }

    showToast('Contact details saved', 'success');
  } catch (error) {
    logger.error('Error saving contact information:', error);
    showToast(errorMessage(error, 'Could not save the contact details'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

/**
 * Ask the customer for their details through the widget.
 *
 * Only a visitor with the widget open can be asked. It used to say "the
 * customer has been asked" for an email thread, or for somebody who had
 * closed the tab an hour ago - neither of whom saw anything.
 */
function requestUserInfo() {
  const conversation = state.currentConversation;
  const socket = state.socket;
  if (!conversation || !socket) {
    return;
  }

  if (conversation.channel === 'email') {
    showToast('This is an email conversation; ask in your reply instead.', 'secondary');
    return;
  }
  if (conversation.visitorOnline === false || conversation.status === 'ended') {
    showToast('The visitor is not connected right now, so they cannot be asked. You can add their details with Edit.', 'warning');
    return;
  }

  socket.emit('request-user-details', { sessionId: conversation.sessionId });
  showToast('The customer has been asked for their details.', 'info');
}
