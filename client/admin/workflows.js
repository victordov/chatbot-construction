/**
 * Workflows: the list, what each one answers, and whether it is live.
 *
 * Several workflows can be live at once, each with a trigger saying which
 * messages it takes; everything else goes to the assistant. So the list says,
 * for each one, when it runs, which version visitors get and whether the
 * canvas is ahead of it, what it has done with real visitors, and who put it
 * live - and lets an admin take one offline without opening the editor.
 */

import { registerSection } from './nav.js';
import { api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, promptDialog, showToast } from './utils.js';

const STATUS = {
  published: { label: 'Live', className: 'text-bg-success' },
  draft: { label: 'Draft', className: 'text-bg-light border' },
  archived: { label: 'Archived', className: 'text-bg-secondary' }
};

/** Everything the table shows, by id, for the row actions. */
let byId = new Map();

function editorLink(id) {
  return `workflow-editor.html?id=${encodeURIComponent(id)}`;
}

/** When a workflow runs, in a sentence. Mirrors client/workflow-editor/graph.js. */
function describeTrigger(trigger) {
  const type = trigger && trigger.type;
  if (type === 'intent') {
    return trigger.description
      ? `When the visitor wants: ${trigger.description}`
      : 'When the visitor wants… (not described yet)';
  }
  if (type === 'keywords') {
    const keywords = (trigger.keywords || []).filter(Boolean);
    return keywords.length
      ? `When a message mentions ${keywords.map(keyword => `"${keyword}"`).join(', ')}`
      : 'On keywords (none added yet)';
  }
  return 'Every message';
}

function versionCell(workflow) {
  if (workflow.status === 'published' && workflow.hasUnpublishedChanges) {
    return `
      <div>Live: v${escapeHtml(workflow.liveVersion)}</div>
      <div class="small text-warning-emphasis">Draft: v${escapeHtml(workflow.version)} (unpublished changes)</div>`;
  }
  if (workflow.status === 'published') {
    return `Live: v${escapeHtml(workflow.liveVersion || workflow.version)}`;
  }
  return `v${escapeHtml(workflow.version || 1)}`;
}

function statsCell(workflow) {
  const stats = workflow.executionStats || {};
  const runs = stats.runs || 0;
  if (!runs && !stats.errors) {
    return '<span class="small text-muted">No runs yet</span>';
  }
  return `
    <div class="workflow-stats small">
      <span title="Conversations that started this workflow">${escapeHtml(runs)} run${runs === 1 ? '' : 's'}</span>
      <span title="Reached the end without a person">${escapeHtml(stats.completions || 0)} completed</span>
      <span title="Ended handing the visitor to a person">${escapeHtml(stats.handoffs || 0)} handed over</span>
      ${stats.errors ? `<span class="text-danger" title="Turns where a step failed">${escapeHtml(stats.errors)} error${stats.errors === 1 ? '' : 's'}</span>` : ''}
    </div>
    ${stats.lastRunAt ? `<div class="small text-muted">Last ${escapeHtml(formatRelativeTime(stats.lastRunAt))}</div>` : ''}`;
}

function publishedCell(workflow) {
  if (!workflow.publishedAt) {
    return '<span class="small text-muted">Never published</span>';
  }
  const who = workflow.publishedBy && (workflow.publishedBy.displayName || workflow.publishedBy.username);
  const verb = workflow.status === 'published' ? 'Published' : 'Last published';
  return `<span class="small">${verb} ${escapeHtml(formatRelativeTime(workflow.publishedAt))}${who ? ` by ${escapeHtml(who)}` : ''}</span>`;
}

function actionsCell(workflow) {
  const id = escapeHtml(workflow._id);
  const live = workflow.status === 'published';
  return `
    <div class="btn-group btn-group-sm">
      <a class="btn btn-outline-primary" href="${editorLink(workflow._id)}">Open</a>
      <button type="button" class="btn btn-outline-primary dropdown-toggle dropdown-toggle-split"
              data-bs-toggle="dropdown" aria-expanded="false" aria-label="More for ${escapeHtml(workflow.name || 'this workflow')}"></button>
      <ul class="dropdown-menu dropdown-menu-end">
        <li><button type="button" class="dropdown-item" data-workflow-action="duplicate" data-id="${id}">Duplicate</button></li>
        <li><button type="button" class="dropdown-item" data-workflow-action="rename" data-id="${id}">Rename</button></li>
        ${live ? `<li><button type="button" class="dropdown-item" data-workflow-action="unpublish" data-id="${id}">Unpublish</button></li>` : ''}
        <li><hr class="dropdown-divider"></li>
        <li><button type="button" class="dropdown-item text-danger" data-workflow-action="delete" data-id="${id}">Delete</button></li>
      </ul>
    </div>`;
}

function renderUsage(usage, workflows) {
  const element = document.getElementById('workflows-usage');
  if (!element) {
    return;
  }

  const live = workflows.filter(workflow => workflow.status === 'published').length;
  if (usage && usage.limit !== null && usage.limit !== undefined) {
    element.textContent = `${usage.used} of ${usage.limit} live workflow${usage.limit === 1 ? '' : 's'} on your plan`;
    element.classList.toggle('text-warning-emphasis', usage.used >= usage.limit);
  } else {
    element.textContent = `${live} live`;
    element.classList.remove('text-warning-emphasis');
  }
}

async function load() {
  const table = document.getElementById('workflows-table');
  try {
    const { workflows, liveUsage } = await api('/api/workflows');
    byId = new Map(workflows.map(workflow => [workflow._id, workflow]));
    renderUsage(liveUsage, workflows);

    if (!workflows.length) {
      table.innerHTML = `
        <tr><td colspan="6" class="text-center py-5">
          <p class="mb-1">No workflows yet - your assistant answers everything.</p>
          <p class="small text-muted mb-3">Start from one of eight ready-made flows: order status, returns, booking, lead qualification and more. Each runs only for what it is about.</p>
          <a class="btn btn-sm btn-primary" href="workflow-editor.html?templates=1">Start from a template</a>
        </td></tr>`;
      return;
    }

    // The live ones first, then the most recently changed.
    const sorted = [...workflows].sort((a, b) =>
      (b.status === 'published') - (a.status === 'published') ||
      new Date(b.updatedAt) - new Date(a.updatedAt));

    table.innerHTML = sorted.map(workflow => {
      const status = STATUS[workflow.status] || STATUS.draft;
      // A live workflow runs on its published trigger; a draft on its own.
      const trigger = workflow.status === 'published' && workflow.liveTrigger ? workflow.liveTrigger : workflow.trigger;
      return `
        <tr>
          <td>
            <a href="${editorLink(workflow._id)}" class="fw-semibold text-decoration-none">${escapeHtml(workflow.name || 'Untitled workflow')}</a>
            <div class="small text-muted">${escapeHtml(describeTrigger(trigger))}</div>
            ${workflow.description ? `<div class="small text-muted fst-italic">${escapeHtml(workflow.description)}</div>` : ''}
          </td>
          <td>
            <span class="badge ${status.className}">${status.label}</span>
            ${workflow.hasUnpublishedChanges ? '<div class="small text-warning-emphasis mt-1">Unpublished changes</div>' : ''}
          </td>
          <td class="small">${versionCell(workflow)}</td>
          <td>${statsCell(workflow)}</td>
          <td>${publishedCell(workflow)}</td>
          <td class="text-end text-nowrap">${actionsCell(workflow)}</td>
        </tr>`;
    }).join('');
  } catch (error) {
    table.innerHTML = '<tr><td colspan="6" class="text-danger text-center py-4">Could not load your workflows.</td></tr>';
    showToast(errorMessage(error, 'Could not load your workflows'), 'danger');
  }
}

async function duplicate(workflow) {
  try {
    const { workflow: copy } = await api(`/api/workflows/${encodeURIComponent(workflow._id)}/duplicate`, { method: 'POST' });
    showToast(`Copied as "${copy.name}", a draft`, 'success');
    await load();
  } catch (error) {
    showToast(errorMessage(error, 'Could not copy that workflow'), 'danger');
  }
}

async function rename(workflow) {
  const name = await promptDialog({
    title: 'Rename workflow',
    label: 'Name',
    value: workflow.name || '',
    placeholder: 'Order status'
  });
  if (!name || !name.trim() || name.trim() === workflow.name) {
    return;
  }
  try {
    // A rename is not a new version, so a live workflow does not gain
    // "unpublished changes" from it.
    await api(`/api/workflows/${encodeURIComponent(workflow._id)}`, { method: 'PUT', body: { name: name.trim() } });
    showToast('Renamed', 'success');
    await load();
  } catch (error) {
    showToast(errorMessage(error, 'Could not rename that workflow'), 'danger');
  }
}

async function unpublish(workflow) {
  const ok = await confirmDialog({
    title: 'Unpublish this workflow?',
    message: `"${workflow.name}" stops answering visitors from their next message. ` +
      'Visitors part-way through it are answered by your assistant instead. It stays here as a draft you can publish again.',
    confirmLabel: 'Unpublish',
    danger: true
  });
  if (!ok) {
    return;
  }
  try {
    await api(`/api/workflows/${encodeURIComponent(workflow._id)}/unpublish`, { method: 'POST' });
    showToast(`"${workflow.name}" is no longer live`, 'success');
    await load();
  } catch (error) {
    showToast(errorMessage(error, 'Could not unpublish that workflow'), 'danger');
  }
}

async function remove(workflow) {
  if (workflow.status === 'published') {
    // Deleting what visitors are talking to would cut them off mid-question.
    showToast(`"${workflow.name}" is live. Unpublish it first, then delete it.`, 'warning', 8000);
    return;
  }
  const ok = await confirmDialog({
    title: 'Delete this workflow?',
    message: `"${workflow.name}" and its version history are removed for good.`,
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) {
    return;
  }
  try {
    await api(`/api/workflows/${encodeURIComponent(workflow._id)}`, { method: 'DELETE' });
    showToast('Deleted', 'success');
    await load();
  } catch (error) {
    showToast(errorMessage(error, 'Could not delete that workflow'), 'danger');
  }
}

const ACTIONS = { duplicate, rename, unpublish, delete: remove };

function setup() {
  document.getElementById('workflows-table').addEventListener('click', event => {
    const button = event.target.closest('[data-workflow-action]');
    if (!button) {
      return;
    }
    const workflow = byId.get(button.dataset.id);
    const action = ACTIONS[button.dataset.workflowAction];
    if (workflow && action) {
      action(workflow);
    }
  });
}

registerSection('workflows', { setup, show: load });
