/**
 * Tags, the tag filter, and whether this operator is taking work.
 *
 * All three are about the same thing: a queue that distributes conversations
 * rather than leaving them to whoever happens to be looking.
 */

(function() {
  let knownTags = [];
  let activeTagFilter = null;

  function token() {
    return localStorage.getItem('chatbot-auth-token');
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api/admin${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': token(),
        ...options.headers
      }
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body;
  }

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

    const conversation = window.currentConversation;
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
    const conversation = window.currentConversation;
    if (!conversation) {
      return;
    }

    try {
      const result = await api(`/chat/${encodeURIComponent(conversation.sessionId)}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tags })
      });

      conversation.tags = result.tags;
      renderTags(result.tags);
      // A new tag should be offered to the next person immediately.
      loadKnownTags();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  }

  function addTagFromInput() {
    const input = document.getElementById('tag-input');
    const value = (input.value || '').trim();

    if (!value) {
      return;
    }

    const current = (window.currentConversation && window.currentConversation.tags) || [];
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
      const { tags } = await api('/tags');
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
  function applyTagFilter() {
    document.querySelectorAll('#active-chat-list .list-group-item').forEach(item => {
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
      await api('/me/availability', {
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
      showToast(error.message, 'danger');
      // Put the switch back: leaving it showing a state the server rejected is
      // worse than the failure itself, because the operator would believe they
      // had stopped receiving work.
      const toggle = document.getElementById('accepting-chats-toggle');
      if (toggle) {
        toggle.checked = !accepting;
      }
    }
  }

  // ------------------------------------------------------ company settings

  async function loadRoutingSettings() {
    try {
      const response = await fetch('/api/companies/me/routing', {
        headers: { 'x-auth-token': token() }
      });

      if (!response.ok) {
        // An operator has no company settings to read; that is not an error
        // worth surfacing to them.
        return;
      }

      const { routing } = await response.json();

      const auto = document.getElementById('routing-auto-assign');
      const max = document.getElementById('routing-max-concurrent');
      const onStart = document.getElementById('routing-assign-on-start');

      if (auto) {
        auto.checked = Boolean(routing.autoAssign);
      }
      if (max) {
        max.value = routing.maxConcurrent || 3;
      }
      if (onStart) {
        onStart.checked = Boolean(routing.assignOnStart);
      }
    } catch {
      // Leave the defaults in place.
    }
  }

  async function saveRoutingSettings() {
    const button = document.getElementById('save-routing-btn');
    button.disabled = true;

    try {
      const response = await fetch('/api/companies/me/routing', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': token()
        },
        body: JSON.stringify({
          autoAssign: document.getElementById('routing-auto-assign').checked,
          maxConcurrent: parseInt(document.getElementById('routing-max-concurrent').value, 10),
          assignOnStart: document.getElementById('routing-assign-on-start').checked
        })
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error || 'Could not save the routing settings');
      }

      showToast('Routing settings saved', 'success');
    } catch (error) {
      showToast(error.message, 'danger');
    } finally {
      button.disabled = false;
    }
  }

  // ----------------------------------------------------------------- init

  function setupRouting(socket) {
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

    document.getElementById('save-routing-btn')?.addEventListener('click', saveRoutingSettings);

    loadKnownTags();
    loadRoutingSettings();

    if (socket) {
      socket.on('conversation-tagged', data => {
        if (window.currentConversation &&
            window.currentConversation.sessionId === data.sessionId) {
          window.currentConversation.tags = data.tags;
          renderTags(data.tags);
        }

        const item = document.querySelector(
          `#active-chat-list [data-session-id="${data.sessionId}"]`);
        if (item) {
          item.dataset.tags = (data.tags || []).join(',');
          applyTagFilter();
        }
      });

      socket.on('chat-assigned-to-you', data => {
        showToast('A conversation has been assigned to you', 'info');
        const item = document.querySelector(
          `#active-chat-list [data-session-id="${data.sessionId}"]`);
        if (item) {
          item.classList.add('assigned-to-me');
        }
      });

      // Somebody is waiting for a person. Louder than a new message, because
      // they have explicitly asked and are now watching an empty chat window.
      socket.on('operator-requested', data => {
        if (data && data.sessionId) {
          showToast('A visitor has asked to speak to someone', 'warning');
        }
      });
    }
  }

  window.setupRouting = setupRouting;
  window.renderConversationTags = renderTags;
  window.applyTagFilter = applyTagFilter;
})();
