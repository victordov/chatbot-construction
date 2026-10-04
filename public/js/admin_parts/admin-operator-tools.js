/**
 * The tools an operator uses all shift: saved replies, internal notes,
 * transferring a chat, and working several conversations at once.
 *
 * None of this existed before. An operator who picked up a chat they could not
 * resolve had to abandon it and hope a colleague noticed, had nowhere to write
 * down what they had learned, and retyped the same answers by hand.
 */

(function() {
  let cannedReplies = [];
  let currentNotes = [];
  let chatFilter = 'all';


  const selectedSessionId = () =>
    document.getElementById('join-chat-btn').getAttribute('data-session-id');

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
      <button type="button" class="canned-item ${index === 0 ? 'is-active' : ''}"
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
    input.value = reply.text;
    hidePicker();
    input.focus();
    // Cursor at the end, ready to edit.
    input.setSelectionRange(input.value.length, input.value.length);
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

      // Enter picks the first match instead of sending "/refund" as a message.
      if (event.key === 'Enter') {
        const first = picker.querySelector('[data-reply-index]');
        if (first) {
          event.preventDefault();
          event.stopImmediatePropagation();
          insertReply(cannedReplies[Number(first.dataset.replyIndex)]);
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

    list.innerHTML = currentNotes.map(note => `
      <div class="note-item ${note.system ? 'is-system' : ''}">
        <div class="note-body">${escapeHtml(note.body)}</div>
        <div class="note-meta">
          ${escapeHtml(note.authorName || 'Unknown')} ·
          ${escapeHtml(formatRelativeTime(note.createdAt))}
          ${note.system ? '' : `
            <button class="btn btn-link btn-sm p-0 ms-2 delete-note-btn"
                    data-note-id="${escapeHtml(note._id || '')}">delete</button>`}
        </div>
      </div>`).join('');

    list.querySelectorAll('.delete-note-btn').forEach(button => {
      button.addEventListener('click', () => deleteNote(button.dataset.noteId));
    });
  }

  /** Called when a conversation is opened; notes arrive with it. */
  function setNotes(notes) {
    currentNotes = notes || [];
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

      currentNotes.push(result.note);
      input.value = '';
      renderNotes();
    } catch (error) {
      showToast(error.message, 'danger');
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
      currentNotes = currentNotes.filter(note => note._id !== noteId);
      renderNotes();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  }

  function setupNotes() {
    document.getElementById('notes-toggle-btn').addEventListener('click', () => {
      const panel = document.getElementById('notes-panel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('add-note-btn').addEventListener('click', addNote);

    document.getElementById('note-input').addEventListener('keypress', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addNote();
      }
    });
  }

  // ----------------------------------------------------------------- transfer

  async function openTransfer() {
    const sessionId = selectedSessionId();
    if (!sessionId) {
      return;
    }

    const select = document.getElementById('transfer-operator');
    select.innerHTML = '<option>Loading…</option>';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('transferModal')).show();

    try {
      const { operators } = await api('/api/admin/operators');
      const currentUserId = window.currentUser ? String(window.currentUser.id) : null;

      // Transferring to yourself is a no-op the server rejects; do not offer it.
      const options = (operators || []).filter(op => String(op._id) !== currentUserId);

      select.innerHTML = options.length
        ? options.map(op =>
          `<option value="${escapeHtml(op._id)}">${escapeHtml(op.displayName || op.username)}</option>`).join('')
        : '<option value="">No other operators available</option>';

      document.getElementById('confirm-transfer-btn').disabled = options.length === 0;
    } catch (error) {
      select.innerHTML = '<option value="">Could not load operators</option>';
      showToast(error.message, 'danger');
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
        body: JSON.stringify({ operatorId, note: note || undefined })
      });

      bootstrap.Modal.getOrCreateInstance(document.getElementById('transferModal')).hide();
      document.getElementById('transfer-note').value = '';
      showToast(`Transferred to ${result.operatorName}`, 'success');

      // It is no longer this operator's chat.
      window.joinedChats.delete(sessionId);
      window.saveJoinedChats();
      applyChatFilter();
    } catch (error) {
      showToast(error.message, 'danger');
    } finally {
      setLoading(button, false);
    }
  }

  function setupTransfer() {
    document.getElementById('transfer-chat-btn').addEventListener('click', openTransfer);
    document.getElementById('confirm-transfer-btn').addEventListener('click', confirmTransfer);
  }

  // ------------------------------------------------------------ multiple chats

  /**
   * Show only the conversations matching the current filter, and keep the
   * counts honest.
   *
   * Operators could always join several chats, but the queue gave them no way
   * to tell which were theirs, so in practice they worked one at a time.
   */
  function applyChatFilter() {
    const items = document.querySelectorAll('#active-chat-list a[data-session-id]');
    let mine = 0;
    let waiting = 0;
    let visible = 0;

    items.forEach(item => {
      const sessionId = item.getAttribute('data-session-id');
      const isMine = window.joinedChats.has(sessionId);
      const hasOperator = item.querySelector('.status-indicator.has-operator') !== null;

      if (isMine) {
        mine += 1;
      }
      if (!hasOperator) {
        waiting += 1;
      }

      item.classList.toggle('is-mine', isMine);

      const show =
        chatFilter === 'all' ||
        (chatFilter === 'mine' && isMine) ||
        (chatFilter === 'unassigned' && !hasOperator);

      item.style.display = show ? '' : 'none';
      if (show) {
        visible += 1;
      }
    });

    document.getElementById('queue-count').textContent = items.length;
    document.getElementById('mine-count').textContent = mine;
    document.getElementById('waiting-count').textContent = waiting;

    const empty = document.querySelector('#active-chat-list .empty-state');
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
        document.getElementById('active-chat-list').appendChild(notice);
      }
      notice.textContent = chatFilter === 'mine'
        ? 'You have not joined any conversations yet.'
        : 'No conversations are waiting.';
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
  }

  // -------------------------------------------------------------------- setup

  function setupOperatorTools(socket) {
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
        if (data.sessionId === selectedSessionId()) {
          currentNotes.push(data.note);
          renderNotes();
        }
      });

      socket.on('chat-assigned', data => {
        applyChatFilter();
        if (data.sessionId === selectedSessionId()) {
          showToast(`This conversation is now with ${data.operatorName}`, 'info');
        }
      });

      // Being handed a chat is worth interrupting for.
      socket.on('chat-transferred-to-you', data => {
        showToast(`${data.from} transferred a conversation to you`, 'info');
        window.joinedChats.add(data.sessionId);
        window.saveJoinedChats();
        applyChatFilter();

        if (localStorage.getItem('notification-setting') !== 'none' &&
            'Notification' in window && Notification.permission === 'granted') {
          new Notification('Conversation transferred to you', {
            body: data.note || `From ${data.from}`
          });
        }
      });
    }

    applyChatFilter();
  }

  window.setupOperatorTools = setupOperatorTools;
  window.setConversationNotes = setNotes;
  window.applyChatFilter = applyChatFilter;
})();
