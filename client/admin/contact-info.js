/**
 * The customer's name, email and phone in an open conversation: editing them,
 * and asking the customer for them through the widget.
 */

import * as bootstrap from 'bootstrap';
import { displayUserContactInfo, loadChatMessages } from './inbox.js';
import { state } from './state.js';
import { authToken, errorMessage, logger, showNotification, showToast } from './utils.js';

// Set up contact information management
export function setupContactInfoManagement() {
  // Set up event listener for edit button
  document.getElementById('edit-contact-info-btn').addEventListener('click', function() {
    openContactInfoModal();
  });

  // Request user to provide details
  const requestBtn = document.getElementById('request-user-info-btn');
  if (requestBtn) {
    requestBtn.addEventListener('click', function() {
      requestUserInfo();
    });
  }

  // Set up event listener for save button
  document.getElementById('save-contact-info-btn').addEventListener('click', function() {
    saveContactInfo();
  });
}

// Open contact info modal
function openContactInfoModal() {
  // Get current conversation
  const conversation = state.currentConversation;
  if (!conversation) {
    return;
  }

  // Set session ID
  document.getElementById('contact-info-session-id').value = conversation.sessionId;

  // Fill form with existing data if available
  if (conversation.metadata) {
    // Check if metadata is a Map or a plain object
    if (conversation.metadata instanceof Map) {
      document.getElementById('edit-name-input').value = conversation.metadata.get('name') || '';
      document.getElementById('edit-email-input').value = conversation.metadata.get('email') || '';
      document.getElementById('edit-phone-input').value = conversation.metadata.get('phone') || '';
    } else {
      document.getElementById('edit-name-input').value = conversation.metadata.name || '';
      document.getElementById('edit-email-input').value = conversation.metadata.email || '';
      document.getElementById('edit-phone-input').value = conversation.metadata.phone || '';
    }
  } else {
    // Clear form
    document.getElementById('edit-name-input').value = '';
    document.getElementById('edit-email-input').value = '';
    document.getElementById('edit-phone-input').value = '';
  }

  // Show the modal
  const contactInfoModal = new bootstrap.Modal(document.getElementById('contactInfoModal'));
  contactInfoModal.show();
}

// Save contact info
function saveContactInfo() {
  // Get form data
  const sessionId = document.getElementById('contact-info-session-id').value;
  const name = document.getElementById('edit-name-input').value;
  const email = document.getElementById('edit-email-input').value;
  const phone = document.getElementById('edit-phone-input').value;

  // Create data object
  const contactInfo = {
    name,
    email,
    phone
  };

  // Send request to save contact info
  fetch(`/api/admin/chat/${sessionId}/contact-info`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': authToken()
    },
    body: JSON.stringify(contactInfo)
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to save contact information');
      }
      return response.json();
    })
    .then(
      // eslint-disable-next-line no-unused-vars
      data => {
        // Hide the modal
        bootstrap.Modal.getInstance(document.getElementById('contactInfoModal')).hide();

        // Update the conversation data
        if (state.currentConversation) {
          if (!state.currentConversation.metadata) {
            state.currentConversation.metadata = {};
          }

          // Check if metadata is a Map or a plain object
          if (state.currentConversation.metadata instanceof Map) {
            state.currentConversation.metadata.set('name', name);
            state.currentConversation.metadata.set('email', email);
            state.currentConversation.metadata.set('phone', phone);
          } else {
            state.currentConversation.metadata.name = name;
            state.currentConversation.metadata.email = email;
            state.currentConversation.metadata.phone = phone;
          }

          // Update the display
          displayUserContactInfo(state.currentConversation);

          // Reload messages to update user names
          loadChatMessages(sessionId);
        }

        // Show success notification
        showNotification('Success', 'Contact information saved successfully', 'success');
      })
    .catch(error => {
      logger.error('Error saving contact information:', error);
      showNotification('Error', errorMessage(error, 'Failed to save contact information'), 'error');
    });
}

// Request user to provide contact information via widget
function requestUserInfo() {
  const conversation = state.currentConversation;
  if (!conversation) {
    return;
  }
  const socket = state.socket;
  if (socket) {
    socket.emit('request-user-details', { sessionId: conversation.sessionId });
    showToast('The customer has been asked for their details.', 'info');
  }
}

