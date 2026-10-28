/**
 * Connected tools (MCP): remote MCP servers, on the Actions screen.
 *
 * An admin connects a server (a URL and, usually, a token), we list the tools
 * it offers, and they switch on the ones the assistant may use — each with the
 * same choices as a saved Action: automatic or workflow only, verified
 * customers only, ask before running. Everything starts switched off, because
 * a server's tool list is somebody else's idea of what our bot should do.
 *
 * The card lives inside the Actions section, which actions.js registers. This
 * module watches the section open rather than registering it a second time
 * (nav.js keeps one set of hooks per section).
 */

import { Modal } from 'bootstrap';
import {
  api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, setLoading, showToast
} from './utils.js';

let servers = [];
let editing = null;
let ready = false;

const $ = id => document.getElementById(id);

const STATUS = {
  connected: { label: 'Connected', badge: 'text-bg-success' },
  error: { label: 'Could not connect', badge: 'text-bg-danger' },
  new: { label: 'Not connected yet', badge: 'text-bg-light border' }
};

// ------------------------------------------------------------------- list

function inputsLine(tool) {
  if (!tool.inputs.length) {
    return '<div class="small text-muted mt-1">Takes no inputs.</div>';
  }
  return `
    <ul class="small mt-1 mb-0 mcp-tool-inputs">
      ${tool.inputs.map(input => `
        <li><code>${escapeHtml(input.name)}</code>
          <span class="text-muted">${escapeHtml(input.type)}${input.required ? ', required' : ''}</span>
          ${input.description ? ` — ${escapeHtml(input.description)}` : ''}</li>`).join('')}
    </ul>`;
}

function toolRow(server, tool, index) {
  const id = `mcp-${escapeHtml(server._id)}-${index}`;
  const blocked = !tool.available || Boolean(tool.problem);

  return `
    <li class="list-group-item px-0" data-mcp-tool="${escapeHtml(tool.name)}" data-mcp-server-id="${escapeHtml(server._id)}">
      <div class="d-flex gap-3 align-items-start">
        <div class="form-check form-switch mt-1">
          <input class="form-check-input" type="checkbox" role="switch" id="${id}-enabled" data-mcp-field="enabled"
                 ${tool.enabled ? 'checked' : ''} ${blocked && !tool.enabled ? 'disabled' : ''}
                 aria-label="Let the bot use ${escapeHtml(tool.title || tool.name)}">
        </div>
        <div class="flex-grow-1 min-width-0">
          <div class="fw-semibold">${escapeHtml(tool.title || tool.name)}
            <code class="small text-muted ms-1">${escapeHtml(tool.name)}</code></div>
          <div class="small text-muted mcp-tool-description" data-mcp-expand title="Show all">${escapeHtml(tool.description || 'No description.')}</div>
          <div class="d-flex gap-1 flex-wrap mt-1">
            ${tool.readOnly
    ? '<span class="badge text-bg-light border">Only reads, says the server</span>'
    : '<span class="badge text-bg-warning">May change data</span>'}
            ${tool.changedAt ? `<span class="badge text-bg-info">Changed ${escapeHtml(formatRelativeTime(tool.changedAt))} — check the description</span>` : ''}
            ${!tool.available ? '<span class="badge text-bg-secondary">No longer offered by the server</span>' : ''}
            ${tool.problem ? `<span class="badge text-bg-danger">${escapeHtml(tool.problem)}</span>` : ''}
            ${tool.lastCalledAt ? `<span class="badge text-bg-light border">Last used ${escapeHtml(formatRelativeTime(tool.lastCalledAt))}</span>` : ''}
          </div>
          ${inputsLine(tool)}
          <div class="d-flex flex-wrap align-items-center gap-3 mt-2 small mcp-tool-settings">
            <select class="form-select form-select-sm w-auto" data-mcp-field="mode" aria-label="How it is used">
              <option value="automatic" ${tool.mode === 'automatic' ? 'selected' : ''}>The assistant uses it</option>
              <option value="workflow_only" ${tool.mode === 'workflow_only' ? 'selected' : ''}>Workflow only</option>
            </select>
            <div class="form-check form-switch mb-0">
              <input class="form-check-input" type="checkbox" id="${id}-verified" data-mcp-field="verifiedOnly" ${tool.verifiedOnly ? 'checked' : ''}>
              <label class="form-check-label" for="${id}-verified">Verified customers only</label>
            </div>
            <div class="form-check form-switch mb-0">
              <input class="form-check-input" type="checkbox" id="${id}-confirm" data-mcp-field="needsConfirmation" ${tool.needsConfirmation ? 'checked' : ''}>
              <label class="form-check-label" for="${id}-confirm">Ask the customer before running</label>
            </div>
          </div>
        </div>
      </div>
    </li>`;
}

function serverCard(server) {
  const status = STATUS[server.status] || STATUS.new;
  const on = server.tools.filter(tool => tool.enabled).length;
  const facts = [
    server.lastCheckedAt ? `Checked ${formatRelativeTime(server.lastCheckedAt)}` : null,
    server.protocol ? `MCP ${server.protocol.version}` : null,
    server.serverInfo ? `${server.serverInfo.name} ${server.serverInfo.version}`.trim() : null
  ].filter(Boolean);

  return `
    <div class="mcp-server border rounded p-3 mb-3" data-mcp-server="${escapeHtml(server._id)}">
      <div class="d-flex flex-wrap gap-2 align-items-start">
        <div class="me-auto min-width-0">
          <div class="fw-semibold">${escapeHtml(server.name)}
            <span class="badge ${status.badge} ms-1">${status.label}</span></div>
          <div class="small text-muted font-monospace text-break">${escapeHtml(server.url)}</div>
          ${facts.length ? `<div class="small text-muted">${escapeHtml(facts.join(' · '))}</div>` : ''}
        </div>
        <div class="btn-group btn-group-sm">
          <button type="button" class="btn btn-outline-secondary" data-mcp-refresh="${escapeHtml(server._id)}">
            ${server.status === 'new' ? 'Connect &amp; list tools' : 'Refresh tools'}
          </button>
          <button type="button" class="btn btn-outline-secondary" data-mcp-edit="${escapeHtml(server._id)}">Edit</button>
        </div>
      </div>
      ${server.lastError ? `
        <div class="alert alert-danger small py-2 px-3 mt-2 mb-0">
          <strong>Last error:</strong> ${escapeHtml(server.lastError)}
        </div>` : ''}
      ${server.warnings.length ? `
        <details class="small mt-2">
          <summary>${server.warnings.length === 1 ? 'One tool was skipped' : `${server.warnings.length} tools were skipped`}</summary>
          <ul class="mb-0">${server.warnings.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
        </details>` : ''}
      ${server.tools.length ? `
        <details class="mt-2" ${on > 0 || server.tools.length <= 8 ? 'open' : ''}>
          <summary class="small">${server.tools.length === 1 ? 'One tool' : `${server.tools.length} tools`} · ${on} switched on</summary>
          <ul class="list-group list-group-flush mcp-tools">
            ${server.tools.map((tool, index) => toolRow(server, tool, index)).join('')}
          </ul>
        </details>` : (server.status === 'connected'
    ? '<div class="small text-muted mt-2">The server offers no tools.</div>' : '')}
    </div>`;
}

function render() {
  const container = $('mcp-servers');

  if (!servers.length) {
    container.innerHTML = `
      <div class="text-center text-muted small py-3">
        No servers connected. Most services list theirs in their developer documentation, under "MCP".
      </div>`;
    return;
  }

  container.innerHTML = servers.map(serverCard).join('');
}

async function load() {
  try {
    const { servers: list } = await api('/api/mcp');
    servers = list || [];
    $('mcp-unavailable').classList.add('d-none');
    $('mcp-add-btn').disabled = false;
    render();
  } catch (error) {
    if (error.status === 402) {
      // Not an error: MCP tools come with actions, which the plan lacks.
      $('mcp-unavailable').textContent = 'Connected tools come with actions, which your plan does not include.';
      $('mcp-unavailable').classList.remove('d-none');
      $('mcp-servers').innerHTML = '';
      $('mcp-add-btn').disabled = true;
      return;
    }
    $('mcp-servers').innerHTML = `<div class="text-muted small">${escapeHtml(errorMessage(error, 'Could not load the connected servers'))}</div>`;
  }
}

function replaceServer(server) {
  const index = servers.findIndex(entry => entry._id === server._id);
  if (index === -1) {
    servers.push(server);
  } else {
    servers[index] = server;
  }
  render();
}

// ---------------------------------------------------------------- connect

/** Connect & list tools, and say what changed. */
async function connect(id, button) {
  setLoading(button, true);
  try {
    const result = await api(`/api/mcp/${encodeURIComponent(id)}/connect`, { method: 'POST' });
    replaceServer(result.server);
    if (!result.ok) {
      showToast(`Could not connect: ${result.error}`, 'danger', 8000);
      return false;
    }
    const { listed, added, changed, missing } = result.summary;
    const notes = [
      added ? `${added} new` : null,
      changed ? `${changed} changed` : null,
      missing ? `${missing} no longer offered` : null
    ].filter(Boolean);
    showToast(`Connected: ${listed} tool${listed === 1 ? '' : 's'}${notes.length ? ` (${notes.join(', ')})` : ''}. Switch on the ones the bot may use.`, 'success');
    return true;
  } catch (error) {
    showToast(errorMessage(error, 'Could not connect to the server'), 'danger');
    return false;
  } finally {
    // The button may have been re-rendered away; restoring a detached one is harmless.
    setLoading(button, false);
  }
}

// ------------------------------------------------------------------ tools

async function updateTool(row, field, value) {
  const serverId = row.dataset.mcpServerId;
  const name = row.dataset.mcpTool;

  try {
    const { tool } = await api(`/api/mcp/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: { [field]: value }
    });
    const server = servers.find(entry => entry._id === serverId);
    if (server) {
      server.tools = server.tools.map(entry => (entry.name === tool.name ? tool : entry));
      // Re-rendered for the "N switched on" count and the badges.
      render();
    }
    if (field === 'enabled') {
      showToast(value ? `${tool.title || tool.name} switched on` : `${tool.title || tool.name} switched off`, 'success');
    }
  } catch (error) {
    showToast(errorMessage(error, 'Could not change the tool'), error.status === 402 ? 'warning' : 'danger', 8000);
    render();
  }
}

// ----------------------------------------------------------------- editor

function syncForm() {
  const type = $('mcp-auth-type').value;
  $('mcp-auth-header-group').classList.toggle('d-none', type !== 'header');
  $('mcp-auth-secret-group').classList.toggle('d-none', type === 'none');
}

function openEditor(server = null) {
  editing = server;
  $('mcpServerModalLabel').textContent = server ? `Edit ${server.name}` : 'Connect an MCP server';
  $('mcp-server-name').value = server ? server.name : '';
  $('mcp-server-url').value = server ? server.url : '';
  $('mcp-auth-type').value = server ? server.auth.type : 'none';
  $('mcp-auth-header').value = server && server.auth.headerName ? server.auth.headerName : '';
  $('mcp-auth-secret').value = '';
  $('mcp-auth-hint').textContent = server && server.auth.hasSecret
    ? 'A secret is saved. Leave this empty to keep it — it is only sent to the address it was saved for.'
    : 'Stored encrypted and never shown again.';
  $('mcp-server-delete-btn').classList.toggle('d-none', !server);
  syncForm();
  Modal.getOrCreateInstance($('mcpServerModal')).show();
}

async function save() {
  const type = $('mcp-auth-type').value;
  const payload = {
    name: $('mcp-server-name').value.trim(),
    url: $('mcp-server-url').value.trim(),
    auth: {
      type,
      ...(type === 'header' ? { headerName: $('mcp-auth-header').value.trim() } : {}),
      ...(type !== 'none' && $('mcp-auth-secret').value ? { secret: $('mcp-auth-secret').value } : {})
    }
  };

  if (!payload.name || !payload.url) {
    showToast('A name and the server\'s URL are both needed', 'warning');
    return;
  }

  const button = $('mcp-server-save-btn');
  setLoading(button, true);
  try {
    const { server } = editing
      ? await api(`/api/mcp/${encodeURIComponent(editing._id)}`, { method: 'PUT', body: payload })
      : await api('/api/mcp', { method: 'POST', body: payload });
    replaceServer(server);
    Modal.getOrCreateInstance($('mcpServerModal')).hide();
    // Saving is only half of what the button says; the list shows the result.
    const card = document.querySelector(`[data-mcp-refresh="${CSS.escape(server._id)}"]`);
    await connect(server._id, card);
  } catch (error) {
    const detail = error.body && Array.isArray(error.body.errors) && error.body.errors.length > 1
      ? ` ${error.body.errors.slice(1).join(' ')}` : '';
    showToast(errorMessage(error, 'Could not save the server') + detail, 'danger', 8000);
  } finally {
    setLoading(button, false);
  }
}

async function remove() {
  if (!editing) {
    return;
  }
  const ok = await confirmDialog({
    title: 'Remove this server?',
    message: `"${editing.name}" and its ${editing.tools.length} tool settings are removed, and the bot stops using its tools.`,
    confirmLabel: 'Remove',
    danger: true
  });
  if (!ok) {
    return;
  }
  try {
    await api(`/api/mcp/${encodeURIComponent(editing._id)}`, { method: 'DELETE' });
    servers = servers.filter(server => server._id !== editing._id);
    Modal.getOrCreateInstance($('mcpServerModal')).hide();
    render();
    showToast('Server removed', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not remove the server'), 'danger');
  }
}

// ------------------------------------------------------------------ wiring

function setup() {
  $('mcp-add-btn').addEventListener('click', () => openEditor());

  $('mcp-card').addEventListener('click', event => {
    const refresh = event.target.closest('[data-mcp-refresh]');
    if (refresh) {
      connect(refresh.dataset.mcpRefresh, refresh);
      return;
    }
    const edit = event.target.closest('[data-mcp-edit]');
    if (edit) {
      openEditor(servers.find(server => server._id === edit.dataset.mcpEdit) || null);
      return;
    }
    const description = event.target.closest('[data-mcp-expand]');
    if (description) {
      description.classList.toggle('expanded');
    }
  });

  $('mcp-card').addEventListener('change', event => {
    const field = event.target.closest('[data-mcp-field]');
    const row = field && field.closest('[data-mcp-tool]');
    if (!row) {
      return;
    }
    const value = field.type === 'checkbox' ? field.checked : field.value;
    updateTool(row, field.dataset.mcpField, value);
  });

  $('mcp-auth-type').addEventListener('change', syncForm);
  $('mcp-server-save-btn').addEventListener('click', save);
  $('mcp-server-delete-btn').addEventListener('click', remove);
}

/**
 * Load whenever the Actions section opens.
 *
 * A re-open removes and adds the `active` class in one go, so the records'
 * old values are what tell an open apart from an unrelated class change.
 */
function watchSection() {
  const section = $('actions-section');
  const card = $('mcp-card');
  if (!section || !card) {
    return;
  }

  const open = () => {
    if (!ready) {
      ready = true;
      setup();
    }
    load();
  };

  new MutationObserver(records => {
    const opened = section.classList.contains('active') &&
      records.some(record => !String(record.oldValue || '').split(/\s+/).includes('active'));
    if (opened) {
      open();
    }
  }).observe(section, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });

  if (section.classList.contains('active')) {
    open();
  }
}

watchSection();
