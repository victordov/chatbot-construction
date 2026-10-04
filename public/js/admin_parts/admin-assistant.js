/**
 * Assistant section: persona and canned replies.
 *
 * This is where a tenant tells the product what business they are in. Nothing
 * industry-specific ships with the platform any more, so a company that fills
 * in nothing here gets a generic assistant answering from its knowledge base.
 */

(function() {
  let templates = [];


  const ROLE_LABELS = {
    greeting: 'Greeting',
    fallback: 'Fallback',
    offTopic: 'Off topic',
    handoff: 'Handoff'
  };

  // ---------------------------------------------------------------- persona

  async function loadAssistantConfig() {
    try {
      const config = await api('/api/templates/assistant/config');

      document.getElementById('assistant-persona').value = config.persona || '';
      document.getElementById('assistant-scope').value = config.scope || '';

      // A published workflow's Persona node overrides this field. Saying so
      // avoids an admin editing here and wondering why nothing changed.
      const note = document.getElementById('persona-source-note');
      if (config.effective.source === 'workflow') {
        note.classList.remove('d-none');
        note.innerHTML =
          'Your published workflow defines a persona, and that takes precedence over this field. ' +
          'Edit it in the <strong>Workflow Editor</strong>, or unpublish the workflow to use this instead.';
      } else {
        note.classList.add('d-none');
      }
    } catch (error) {
      logger.error('Failed to load assistant config:', error);
    }
  }

  async function saveAssistantConfig(event) {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');

    setLoading(button, true);
    try {
      await api('/api/templates/assistant/config', {
        method: 'PUT',
        body: JSON.stringify({
          persona: document.getElementById('assistant-persona').value,
          scope: document.getElementById('assistant-scope').value
        })
      });
      showToast('Assistant saved', 'success');
      loadAssistantConfig();
    } catch (error) {
      showToast(error.message, 'danger');
    } finally {
      setLoading(button, false);
    }
  }

  // -------------------------------------------------------------- templates

  function renderTemplates() {
    const container = document.getElementById('template-list');

    if (templates.length === 0) {
      container.innerHTML = `
        <div class="text-center text-muted py-4">
          <p class="mb-1">No canned replies yet.</p>
          <p class="small mb-0">
            Add one for the questions you answer most — they are returned instantly
            and cost nothing to serve.
          </p>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead>
            <tr>
              <th>Name</th>
              <th>Triggered by</th>
              <th class="text-end">Used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${templates.map(template => `
              <tr class="${template.enabled ? '' : 'opacity-50'}">
                <td>
                  <div class="fw-semibold">${escapeHtml(template.name)}</div>
                  <div class="small text-muted text-truncate" style="max-width: 28rem;">
                    ${escapeHtml((template.responses || [])[0] || '')}
                  </div>
                </td>
                <td>
                  ${template.role
    ? `<span class="badge bg-info-subtle text-info-emphasis">${escapeHtml(ROLE_LABELS[template.role] || template.role)}</span>`
    : `<span class="small text-muted">${escapeHtml((template.triggers || []).slice(0, 2).join(', '))}${(template.triggers || []).length > 2 ? '…' : ''}</span>`}
                  ${template.enabled ? '' : '<span class="badge bg-secondary ms-1">Disabled</span>'}
                </td>
                <td class="text-end text-muted">${template.useCount || 0}</td>
                <td class="text-end text-nowrap">
                  <button class="btn btn-sm btn-outline-secondary edit-template-btn"
                          data-id="${escapeHtml(template._id)}">Edit</button>
                  <button class="btn btn-sm btn-outline-danger delete-template-btn"
                          data-id="${escapeHtml(template._id)}">Delete</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    container.querySelectorAll('.edit-template-btn').forEach(button => {
      button.addEventListener('click', () => openEditor(button.dataset.id));
    });
    container.querySelectorAll('.delete-template-btn').forEach(button => {
      button.addEventListener('click', () => remove(button.dataset.id));
    });
  }

  async function loadTemplates() {
    try {
      const result = await api('/api/templates');
      templates = result.templates || [];
      renderTemplates();
    } catch (error) {
      logger.error('Failed to load templates:', error);
      document.getElementById('template-list').innerHTML =
        `<div class="text-danger">Could not load replies: ${escapeHtml(error.message)}</div>`;
    }
  }

  function renderVariables(variables = {}) {
    const container = document.getElementById('template-variables');
    const entries = Object.entries(variables);

    container.innerHTML = entries.map(([key, value], index) => `
      <div class="input-group input-group-sm mb-2" data-variable-row="${index}">
        <span class="input-group-text">[</span>
        <input class="form-control" data-variable-key value="${escapeHtml(key)}" placeholder="NAME">
        <span class="input-group-text">]</span>
        <input class="form-control" data-variable-value value="${escapeHtml(value)}" placeholder="value">
        <button class="btn btn-outline-danger" type="button" data-remove-variable>&times;</button>
      </div>`).join('');

    container.querySelectorAll('[data-remove-variable]').forEach(button => {
      button.addEventListener('click', () => button.closest('[data-variable-row]').remove());
    });
  }

  function collectVariables() {
    const variables = {};
    document.querySelectorAll('#template-variables [data-variable-row]').forEach(row => {
      const key = row.querySelector('[data-variable-key]').value.trim();
      const value = row.querySelector('[data-variable-value]').value;
      if (key) {
        variables[key] = value;
      }
    });
    return variables;
  }

  /** A role fills a fixed slot, so example phrases do not apply to it. */
  function syncRoleVisibility() {
    const hasRole = Boolean(document.getElementById('template-role').value);
    document.getElementById('template-triggers-group').classList.toggle('d-none', hasRole);
    document.getElementById('template-threshold-group').classList.toggle('d-none', hasRole);
  }

  function openEditor(id = null) {
    const template = id ? templates.find(t => t._id === id) : null;

    document.getElementById('templateModalLabel').textContent =
      template ? 'Edit canned reply' : 'New canned reply';
    document.getElementById('template-id').value = template ? template._id : '';
    document.getElementById('template-name').value = template ? template.name : '';
    document.getElementById('template-role').value = template ? (template.role || '') : '';
    document.getElementById('template-triggers').value =
      template ? (template.triggers || []).join('\n') : '';
    document.getElementById('template-responses').value =
      template ? (template.responses || []).join('\n') : '';
    document.getElementById('template-threshold').value = template ? (template.threshold ?? 0.35) : 0.35;
    document.getElementById('template-threshold-value').textContent =
      document.getElementById('template-threshold').value;
    document.getElementById('template-enabled').checked = template ? template.enabled !== false : true;

    renderVariables(template ? (template.variables || {}) : {});
    syncRoleVisibility();

    bootstrap.Modal.getOrCreateInstance(document.getElementById('templateModal')).show();
  }

  async function save() {
    const id = document.getElementById('template-id').value;
    const button = document.getElementById('save-template-btn');

    const splitLines = value => value.split('\n').map(line => line.trim()).filter(Boolean);

    const payload = {
      name: document.getElementById('template-name').value,
      role: document.getElementById('template-role').value || null,
      triggers: splitLines(document.getElementById('template-triggers').value),
      responses: splitLines(document.getElementById('template-responses').value),
      variables: collectVariables(),
      threshold: parseFloat(document.getElementById('template-threshold').value),
      enabled: document.getElementById('template-enabled').checked
    };

    setLoading(button, true);
    try {
      await api(id ? `/${encodeURIComponent(id)}` : '', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });

      bootstrap.Modal.getOrCreateInstance(document.getElementById('templateModal')).hide();
      showToast(id ? 'Reply updated' : 'Reply created', 'success');
      loadTemplates();
    } catch (error) {
      showToast(error.message, 'danger');
    } finally {
      setLoading(button, false);
    }
  }

  async function remove(id) {
    const template = templates.find(t => t._id === id);
    if (!confirm(`Delete "${template ? template.name : 'this reply'}"?`)) {
      return;
    }

    try {
      await api(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast('Reply deleted', 'success');
      loadTemplates();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  }

  // ---------------------------------------------------------------- preview

  async function preview() {
    const input = document.getElementById('template-preview-input');
    const result = document.getElementById('template-preview-result');
    const message = input.value.trim();

    if (!message) {
      return;
    }

    result.innerHTML = '<div class="text-muted small">Testing…</div>';

    try {
      const outcome = await api('/api/templates/preview', {
        method: 'POST',
        body: JSON.stringify({ message })
      });

      result.innerHTML = outcome.matched
        ? `<div class="alert alert-success mb-0">
             <div class="d-flex justify-content-between align-items-start gap-3">
               <strong>${escapeHtml(outcome.templateName)}</strong>
               <span class="badge bg-success">match ${escapeHtml(outcome.score)}</span>
             </div>
             <hr class="my-2">
             <div>${escapeHtml(outcome.response)}</div>
           </div>`
        : `<div class="alert alert-secondary mb-0">
             No canned reply matched — this message would be answered by the assistant
             using your persona and knowledge base.
           </div>`;
    } catch (error) {
      result.innerHTML = `<div class="text-danger">${escapeHtml(error.message)}</div>`;
    }
  }

  // ------------------------------------------------------------------ setup

  function setupAssistantSection() {
    const user = window.currentUser;
    if (!user || (user.role !== 'superadmin' && user.role !== 'company_admin')) {
      return;
    }
    if (!document.getElementById('assistant-section')) {
      return;
    }

    // A superadmin belongs to no tenant, so there is no assistant of their own.
    if (!user.company) {
      document.getElementById('template-list').innerHTML =
        '<p class="text-muted mb-0">Assistants are configured per company. ' +
        'Open a company from the Companies section to manage its replies.</p>';
      document.getElementById('assistant-config-form').classList.add('d-none');
      return;
    }

    document.getElementById('assistant-config-form').addEventListener('submit', saveAssistantConfig);
    document.getElementById('new-template-btn').addEventListener('click', () => openEditor());
    document.getElementById('save-template-btn').addEventListener('click', save);
    document.getElementById('template-role').addEventListener('change', syncRoleVisibility);
    document.getElementById('template-preview-btn').addEventListener('click', preview);

    document.getElementById('template-preview-input').addEventListener('keypress', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        preview();
      }
    });

    document.getElementById('template-threshold').addEventListener('input', event => {
      document.getElementById('template-threshold-value').textContent = event.target.value;
    });

    document.getElementById('add-variable-btn').addEventListener('click', () => {
      const current = collectVariables();
      current[''] = '';
      renderVariables(current);
    });

    loadAssistantConfig();
    loadTemplates();
  }

  window.setupAssistantSection = setupAssistantSection;
})();
