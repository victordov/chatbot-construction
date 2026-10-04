/**
 * Workflows: the list, and which one is live.
 *
 * The editor is a page of its own, and used to be reachable only from the
 * sidebar with no way to see, before opening it, which workflow customers
 * were actually talking to. This says so, and that a live workflow answers
 * ahead of the assistant.
 */

import { registerSection } from './nav.js';
import { api, errorMessage, escapeHtml, formatRelativeTime, showToast } from './utils.js';

const STATUS = {
  published: { label: 'Live', className: 'text-bg-success' },
  draft: { label: 'Draft', className: 'text-bg-light border' },
  archived: { label: 'Archived', className: 'text-bg-secondary' }
};

function editorLink(id) {
  return `workflow-editor.html?id=${encodeURIComponent(id)}`;
}

async function load() {
  const table = document.getElementById('workflows-table');
  try {
    const { workflows } = await api('/api/workflows');

    if (!workflows.length) {
      table.innerHTML = `
        <tr><td colspan="5" class="text-center py-5">
          <p class="mb-1">No workflows yet - your assistant answers everything.</p>
          <p class="small text-muted mb-3">Start from one of eight ready-made flows: order status, returns, booking, lead qualification and more.</p>
          <a class="btn btn-sm btn-primary" href="workflow-editor.html?templates=1">Start from a template</a>
        </td></tr>`;
      return;
    }

    // The one customers are talking to goes first.
    const sorted = [...workflows].sort((a, b) =>
      (b.status === 'published') - (a.status === 'published') ||
      new Date(b.updatedAt) - new Date(a.updatedAt));

    table.innerHTML = sorted.map(workflow => {
      const status = STATUS[workflow.status] || STATUS.draft;
      return `
        <tr>
          <td>
            <a href="${editorLink(workflow._id)}" class="fw-semibold text-decoration-none">${escapeHtml(workflow.name || 'Untitled workflow')}</a>
            ${workflow.description ? `<div class="small text-muted">${escapeHtml(workflow.description)}</div>` : ''}
          </td>
          <td><span class="badge ${status.className}">${status.label}</span></td>
          <td>v${escapeHtml(workflow.version || 1)}</td>
          <td class="small text-muted">${escapeHtml(formatRelativeTime(workflow.updatedAt))}</td>
          <td class="text-end"><a class="btn btn-sm btn-outline-primary" href="${editorLink(workflow._id)}">Open</a></td>
        </tr>`;
    }).join('');
  } catch (error) {
    table.innerHTML = '<tr><td colspan="5" class="text-danger text-center py-4">Could not load your workflows.</td></tr>';
    showToast(errorMessage(error, 'Could not load your workflows'), 'danger');
  }
}

registerSection('workflows', { show: load });
