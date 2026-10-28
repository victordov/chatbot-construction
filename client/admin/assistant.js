/**
 * Assistant section: persona and canned replies.
 *
 * This is where a tenant tells the product what business they are in. Nothing
 * industry-specific ships with the platform any more, so a company that fills
 * in nothing here gets a generic assistant answering from its knowledge base.
 *
 * A blank persona box is hard to fill, so a few plain questions (the business,
 * what it does, the tone, what never to guess at, when to hand over) can write
 * it, or the model can draft one from the tenant's own website. Either way the
 * text lands in the box for the admin to read and change before it is saved.
 */

import * as bootstrap from 'bootstrap';
import { registerSection } from './nav.js';
import {
  api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, logger, setLoading, showToast
} from './utils.js';

let templates = [];

const ROLE_LABELS = {
  greeting: 'Greeting',
  fallback: 'Fallback',
  offTopic: 'Off topic',
  handoff: 'Handoff'
};

/** What each role is for, shown beside its badge. */
const ROLE_HINTS = {
  greeting: 'The opening line',
  fallback: 'Sent when the bot cannot answer',
  offTopic: 'Sent for questions outside the scope',
  handoff: 'Sent when handing over to a person'
};

const TONE_LINES = {
  friendly: 'Be warm and friendly, and keep answers easy to read.',
  professional: 'Be professional, precise and courteous.',
  brief: 'Keep answers short: a sentence or two unless the customer asks for more.'
};

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- persona

function builderValues() {
  return {
    businessName: $('persona-business-name').value.trim(),
    whatYouDo: $('persona-what-you-do').value.trim(),
    tone: $('persona-tone').value,
    neverGuess: [...document.querySelectorAll('#persona-never-guess input:checked')].map(input => input.value),
    neverGuessOther: $('persona-never-other').value.trim(),
    handover: $('persona-handover').value.trim()
  };
}

function fillBuilder(builder = {}) {
  $('persona-business-name').value = builder.businessName || '';
  $('persona-what-you-do').value = builder.whatYouDo || '';
  $('persona-tone').value = builder.tone || 'friendly';
  document.querySelectorAll('#persona-never-guess input').forEach(input => {
    input.checked = (builder.neverGuess || []).includes(input.value);
  });
  $('persona-never-other').value = builder.neverGuessOther || '';
  $('persona-handover').value = builder.handover || '';
}

/** "a, b and c". */
function listOf(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The persona the builder's answers amount to.
 *
 * Plain sentences in the second person, the form the model follows best, and
 * nothing the admin did not say: a blank answer leaves its sentence out.
 */
function composePersona(values) {
  const sentences = [];
  const name = values.businessName;
  const what = values.whatYouDo.replace(/\.\s*$/, '');

  if (name && what) {
    sentences.push(`You are the assistant for ${name}, ${what}.`);
  } else if (name) {
    sentences.push(`You are the assistant for ${name}.`);
  } else if (what) {
    sentences.push(`You are the assistant for ${what}.`);
  } else {
    sentences.push('You are the customer support assistant for this business.');
  }

  sentences.push(TONE_LINES[values.tone] || TONE_LINES.friendly);

  const never = [...values.neverGuess, ...(values.neverGuessOther ? [values.neverGuessOther] : [])];
  if (never.length) {
    sentences.push(`Never guess at ${listOf(never)}: if the answer is not in the information you have, say so and offer to pass the question to the team.`);
  } else {
    sentences.push('If the answer is not in the information you have, say so rather than guessing.');
  }

  if (values.handover) {
    sentences.push(`Offer to put the customer in touch with a person when ${values.handover.replace(/\.\s*$/, '')}.`);
  }

  return sentences.join(' ');
}

/** Put text in the persona box, asking first if it would replace something. */
async function offerPersona(text, title) {
  const box = $('assistant-persona');
  const current = box.value.trim();
  if (current && current !== text.trim()) {
    const ok = await confirmDialog({
      title,
      message: 'This replaces the persona text below. Nothing is saved until you press Save assistant.',
      confirmLabel: 'Replace'
    });
    if (!ok) {
      return false;
    }
  }
  box.value = text;
  box.focus();
  return true;
}

async function compose() {
  if (await offerPersona(composePersona(builderValues()), 'Write the persona from your answers?')) {
    $('persona-draft-note').textContent = 'Written from your answers. Read it, change anything, then save.';
  }
}

async function draftFromWebsite() {
  const button = $('persona-draft-btn');
  const note = $('persona-draft-note');
  setLoading(button, true);
  note.textContent = 'Reading your knowledge base…';
  try {
    const result = await api('/api/bot/persona-draft', { method: 'POST', body: { builder: builderValues() } });
    if (await offerPersona(result.persona, 'Use the drafted persona?')) {
      note.textContent = result.basedOn && result.basedOn.length
        ? `Drafted from ${result.basedOn.join(', ')}. Check every fact before saving.`
        : 'Drafted from your knowledge base. Check every fact before saving.';
    } else {
      note.textContent = '';
    }
  } catch (error) {
    note.textContent = '';
    showToast(errorMessage(error, 'Could not draft a persona'), 'danger', 8000);
  } finally {
    setLoading(button, false);
  }
}

async function loadAssistantConfig() {
  try {
    const config = await api('/api/templates/assistant/config');

    $('assistant-persona').value = config.persona || '';
    $('assistant-scope').value = config.scope || '';
    fillBuilder(config.builder || {});

    // A live workflow's own Persona step speaks for its answers. Saying so
    // avoids an admin editing here and wondering why nothing changed.
    const note = $('persona-source-note');
    if (config.effective && config.effective.source === 'workflow') {
      note.classList.remove('d-none');
      note.innerHTML =
        'A live workflow sets its own persona, and that is the one in effect. Edit it in the ' +
        '<strong>workflow editor</strong>, or unpublish the workflow under ' +
        '<a href="?section=workflows" data-section-link="workflows">Workflows</a> to use this one.';
    } else {
      note.classList.add('d-none');
    }

    // An open preview is out of date once the persona is reloaded.
    if ($('persona-prompt-preview').open) {
      loadPromptPreview();
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
        persona: $('assistant-persona').value,
        scope: $('assistant-scope').value,
        builder: builderValues()
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

/** The prompt the assistant is actually given, part by part. */
async function loadPromptPreview() {
  const body = $('persona-prompt-body');
  body.innerHTML = '<span class="text-muted">Loading…</span>';
  try {
    const preview = await api('/api/bot/prompt-preview');
    const roles = preview.cannedReplies.roles.map(role => ROLE_LABELS[role.role] || role.role);
    const canned = `${preview.cannedReplies.triggered} matched by meaning` +
      (roles.length ? `, roles: ${roles.join(', ')}` : '');
    body.innerHTML = `
      <ol class="ps-3 mb-3">
        ${(preview.order || []).map(step => `<li>${escapeHtml(step)}</li>`).join('')}
      </ol>
      <div class="mb-1"><strong>Persona</strong> <span class="text-muted">from ${escapeHtml(preview.persona.sourceLabel)}</span></div>
      <div class="mb-2"><strong>Scope</strong> <span class="text-muted">${escapeHtml(preview.scope.text || 'none')}</span>
        <div class="text-muted">${escapeHtml(preview.scope.note)}</div></div>
      <div class="mb-2"><strong>Canned replies</strong>
        <span class="text-muted">${escapeHtml(canned)}</span>
        <div class="text-muted">${escapeHtml(preview.cannedReplies.note)}</div></div>
      <div class="mb-1"><strong>System prompt</strong> <span class="text-muted">(${escapeHtml(preview.strategy)} questions)</span></div>
      <pre class="prompt-preview-text">${escapeHtml(preview.systemPrompt)}</pre>
      <div class="mb-1"><strong>Then, when knowledge matches</strong> <span class="text-muted">${escapeHtml(preview.knowledge.note)}</span></div>
      <pre class="prompt-preview-text">${escapeHtml(preview.knowledge.appended)}</pre>
      <div class="text-muted">Platform safety rules are applied on top of all of this.</div>`;
  } catch (error) {
    body.innerHTML = `<span class="text-danger">${escapeHtml(errorMessage(error, 'Could not load the prompt'))}</span>`;
  }
}

// -------------------------------------------------------------- templates

function matchesSearch(template, query) {
  if (!query) {
    return true;
  }
  const haystack = [
    template.name,
    ROLE_LABELS[template.role] || '',
    ...(template.triggers || []),
    ...(template.responses || [])
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function renderTemplates() {
  const container = $('template-list');

  if (templates.length === 0) {
    container.innerHTML = `
      <div class="text-center text-muted py-4">
        <p class="mb-1">No canned replies yet.</p>
        <p class="small mb-0">
          Add one for the questions you answer most — they are sent word for word,
          instantly, and cost nothing to serve.
        </p>
      </div>`;
    return;
  }

  const query = $('template-search').value.trim().toLowerCase();
  const shown = templates.filter(template => matchesSearch(template, query));

  if (shown.length === 0) {
    container.innerHTML = `<div class="text-muted small py-3">No reply matches "${escapeHtml(query)}".</div>`;
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
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${shown.map(template => `
            <tr class="${template.enabled ? '' : 'opacity-50'}">
              <td>
                <div class="fw-semibold">${escapeHtml(template.name)}</div>
                <div class="small text-muted text-truncate" style="max-width: 28rem;">
                  ${escapeHtml((template.responses || [])[0] || '')}
                </div>
              </td>
              <td>
                ${template.role
    ? `<span class="badge bg-info-subtle text-info-emphasis">${escapeHtml(ROLE_LABELS[template.role] || template.role)}</span>
       <div class="small text-muted">${escapeHtml(ROLE_HINTS[template.role] || '')}</div>`
    : `<span class="small text-muted">${escapeHtml((template.triggers || []).slice(0, 2).join(', '))}${(template.triggers || []).length > 2 ? '…' : ''}</span>`}
                ${template.enabled ? '' : '<span class="badge bg-secondary ms-1">Disabled</span>'}
              </td>
              <td class="text-end text-muted">${escapeHtml(template.useCount || 0)}</td>
              <td class="small text-muted text-nowrap">${template.lastUsedAt ? escapeHtml(formatRelativeTime(template.lastUsedAt)) : 'Never'}</td>
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
    $('template-list').innerHTML =
      `<div class="text-danger">Could not load replies: ${escapeHtml(error.message)}</div>`;
  }
}

function renderVariables(variables = {}) {
  const container = $('template-variables');
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
  const hasRole = Boolean($('template-role').value);
  $('template-triggers-group').classList.toggle('d-none', hasRole);
  $('template-threshold-group').classList.toggle('d-none', hasRole);
}

function openEditor(id = null) {
  const template = id ? templates.find(t => t._id === id) : null;

  $('templateModalLabel').textContent = template ? 'Edit canned reply' : 'New canned reply';
  $('template-id').value = template ? template._id : '';
  $('template-name').value = template ? template.name : '';
  $('template-role').value = template ? (template.role || '') : '';
  $('template-triggers').value = template ? (template.triggers || []).join('\n') : '';
  $('template-responses').value = template ? (template.responses || []).join('\n') : '';
  $('template-threshold').value = template ? (template.threshold ?? 0.35) : 0.35;
  $('template-threshold-value').textContent = $('template-threshold').value;
  $('template-enabled').checked = template ? template.enabled !== false : true;

  renderVariables(template ? (template.variables || {}) : {});
  syncRoleVisibility();

  bootstrap.Modal.getOrCreateInstance($('templateModal')).show();
}

async function save() {
  const id = $('template-id').value;
  const button = $('save-template-btn');

  const splitLines = value => value.split('\n').map(line => line.trim()).filter(Boolean);

  const payload = {
    name: $('template-name').value,
    role: $('template-role').value || null,
    triggers: splitLines($('template-triggers').value),
    responses: splitLines($('template-responses').value),
    variables: collectVariables(),
    threshold: parseFloat($('template-threshold').value),
    enabled: $('template-enabled').checked
  };

  setLoading(button, true);
  try {
    // The full path: this used to be `/<id>` relative to nothing, left over
    // from a helper that prefixed /api/templates, so saving always failed.
    await api(id ? `/api/templates/${encodeURIComponent(id)}` : '/api/templates', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });

    bootstrap.Modal.getOrCreateInstance($('templateModal')).hide();
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
  const ok = await confirmDialog({
    title: 'Delete this canned reply?',
    message: `"${template ? template.name : 'This reply'}" - questions it matched are answered by the assistant instead.`,
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) {
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
  const input = $('template-preview-input');
  const result = $('template-preview-result');
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
           <div class="small text-muted mt-2">Sent word for word. Testing here does not count as a use.</div>
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
  $('assistant-config-form').addEventListener('submit', saveAssistantConfig);
  $('persona-compose-btn').addEventListener('click', compose);
  $('persona-draft-btn').addEventListener('click', draftFromWebsite);
  $('persona-prompt-preview').addEventListener('toggle', event => {
    if (event.target.open) {
      loadPromptPreview();
    }
  });

  $('new-template-btn').addEventListener('click', () => openEditor());
  $('save-template-btn').addEventListener('click', save);
  $('template-role').addEventListener('change', syncRoleVisibility);
  $('template-preview-btn').addEventListener('click', preview);
  $('template-search').addEventListener('input', renderTemplates);

  $('template-preview-input').addEventListener('keypress', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      preview();
    }
  });

  $('template-threshold').addEventListener('input', event => {
    $('template-threshold-value').textContent = event.target.value;
  });

  $('add-variable-btn').addEventListener('click', () => {
    const current = collectVariables();
    current[''] = '';
    renderVariables(current);
  });
}

registerSection('assistant', {
  setup: setupAssistantSection,
  show() {
    loadAssistantConfig();
    loadTemplates();
  }
});
