/**
 * Webhook endpoints.
 *
 * The job here is to make a webhook integrable in one sitting: create it, see
 * the secret once, send a test, and read what came back when it did not work.
 * Everything a developer would otherwise ask support for.
 */

import { registerSection } from './nav.js';
import { api, confirmDialog, escapeHtml, formatRelativeTime, showToast } from './utils.js';

let events = [];
// The endpoints as last loaded, so Edit can fill its form without a request.
let endpoints = [];


const eventLabel = id => (events.find(event => event.id === id) || {}).label || id;

function relative(value) {
  return value ? formatRelativeTime(value) : 'never';
}

// ------------------------------------------------------------------- list

async function loadWebhooks() {
  const container = document.getElementById('webhooks-list');
  if (!container) {
    return;
  }

  container.innerHTML = '<p class="text-muted">Loading…</p>';

  try {
    const { webhooks } = await api('/api/webhooks');
    endpoints = webhooks;

    if (webhooks.length === 0) {
      container.innerHTML = `
        <p class="text-muted mb-0">
          No endpoints yet. Add one to have this platform tell your systems
          when something happens here.
        </p>`;
      return;
    }

    container.innerHTML = webhooks.map(hook => `
      <div class="card mb-2">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap">
            <div class="flex-grow-1" style="min-width: 16rem;">
              <div class="fw-semibold text-break">${escapeHtml(hook.url)}</div>
              ${hook.description
    ? `<div class="small text-muted">${escapeHtml(hook.description)}</div>` : ''}
              <div class="mt-2 d-flex flex-wrap gap-1">
                ${hook.events.map(event =>
    `<span class="badge bg-secondary-subtle text-secondary-emphasis">${escapeHtml(eventLabel(event))}</span>`).join('')}
              </div>
            </div>
            <div class="text-end flex-shrink-0">
              <div>
                <span class="badge bg-${hook.enabled ? 'success' : 'secondary'}">
                  ${hook.enabled ? 'On' : 'Off'}
                </span>
              </div>
              <div class="small text-muted mt-1 text-nowrap">
                Last delivered ${escapeHtml(relative(hook.lastSuccessAt))}
              </div>
            </div>
          </div>

          ${hook.disabledReason ? `
            <div class="alert alert-warning py-2 px-3 small mt-2 mb-0">
              ${escapeHtml(hook.disabledReason)} Switch it back on once the endpoint is fixed.
            </div>` : ''}

          ${!hook.hasSecret ? `
            <div class="alert alert-warning py-2 px-3 small mt-2 mb-0">
              No signing secret, so your endpoint cannot tell our deliveries
              from anyone else's. Rotate to generate one.
            </div>` : ''}

          <div class="mt-2" data-edit-area="${escapeHtml(hook._id)}"></div>

          <div class="mt-2 d-flex gap-2 flex-wrap">
            <button class="btn btn-sm btn-outline-primary" data-test="${escapeHtml(hook._id)}">Send a test</button>
            <button class="btn btn-sm btn-outline-secondary" data-edit-hook="${escapeHtml(hook._id)}">Edit</button>
            <button class="btn btn-sm btn-outline-secondary" data-toggle-hook="${escapeHtml(hook._id)}"
                    data-enabled="${hook.enabled}">
              ${hook.enabled ? 'Turn off' : 'Turn on'}
            </button>
            <button class="btn btn-sm btn-outline-secondary" data-rotate="${escapeHtml(hook._id)}">Rotate secret</button>
            <button class="btn btn-sm btn-outline-danger" data-delete-hook="${escapeHtml(hook._id)}">Delete</button>
          </div>
          <div class="mt-2" data-result="${escapeHtml(hook._id)}"></div>
        </div>
      </div>`).join('');

    bindRowActions(container);
  } catch (error) {
    container.innerHTML = `<p class="text-danger mb-0">${escapeHtml(error.message)}</p>`;
  }
}

function bindRowActions(container) {
  container.querySelectorAll('[data-test]').forEach(button => {
    button.addEventListener('click', async () => {
      const target = container.querySelector(`[data-result="${button.dataset.test}"]`);
      button.disabled = true;
      target.innerHTML = '<span class="small text-muted">Sending…</span>';

      try {
        const { result } = await api(`/api/webhooks/${button.dataset.test}/test`, { method: 'POST' });

        target.innerHTML = `
          <div class="alert alert-${result.delivered ? 'success' : 'danger'} py-2 px-3 small mb-0">
            ${result.delivered
    ? `Delivered — your endpoint returned ${escapeHtml(result.status)}.`
    : escapeHtml(result.error || 'The endpoint did not accept it.')}
          </div>`;
      } catch (error) {
        target.innerHTML =
          `<div class="alert alert-danger py-2 px-3 small mb-0">${escapeHtml(error.message)}</div>`;
      } finally {
        button.disabled = false;
        loadDeliveries();
      }
    });
  });

  container.querySelectorAll('[data-edit-hook]').forEach(button => {
    button.addEventListener('click', () => openEditor(container, button.dataset.editHook));
  });

  container.querySelectorAll('[data-toggle-hook]').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/webhooks/${button.dataset.toggleHook}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: button.dataset.enabled !== 'true' })
        });
        loadWebhooks();
      } catch (error) {
        showToast(error.message, 'danger');
      }
    });
  });

  container.querySelectorAll('[data-rotate]').forEach(button => {
    button.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Make a new signing secret?',
        message: 'Deliveries signed with the current secret stop verifying until your receiver has the new one.',
        confirmLabel: 'Make a new secret',
        danger: true
      });
      if (!ok) {
        return;
      }

      try {
        const result = await api(`/api/webhooks/${button.dataset.rotate}/rotate-secret`, { method: 'POST' });
        showSecret(result.secret, result.secretNotice);
        loadWebhooks();
      } catch (error) {
        showToast(error.message, 'danger');
      }
    });
  });

  container.querySelectorAll('[data-delete-hook]').forEach(button => {
    button.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete this endpoint?',
        message: 'Its delivery history goes with it, and nothing more is sent to it.',
        confirmLabel: 'Delete',
        danger: true
      });
      if (!ok) {
        return;
      }

      try {
        await api(`/api/webhooks/${button.dataset.deleteHook}`, { method: 'DELETE' });
        loadWebhooks();
        loadDeliveries();
      } catch (error) {
        showToast(error.message, 'danger');
      }
    });
  });
}

/**
 * Change where an endpoint points, what it is for, and which events it gets,
 * in place. The API always allowed it; the screen only offered delete and
 * add again, which threw away the secret and the delivery history with it.
 */
function openEditor(container, id) {
  const hook = endpoints.find(endpoint => String(endpoint._id) === String(id));
  const area = container.querySelector(`[data-edit-area="${CSS.escape(id)}"]`);
  if (!hook || !area) {
    return;
  }

  const chosen = new Set(hook.events || []);
  area.innerHTML = `
    <div class="border rounded p-2 bg-light">
      <div class="mb-2">
        <label class="form-label small mb-1" for="wh-edit-url-${escapeHtml(id)}">URL</label>
        <input class="form-control form-control-sm" id="wh-edit-url-${escapeHtml(id)}" data-edit-url value="${escapeHtml(hook.url)}">
      </div>
      <div class="mb-2">
        <label class="form-label small mb-1" for="wh-edit-desc-${escapeHtml(id)}">What is it for?</label>
        <input class="form-control form-control-sm" id="wh-edit-desc-${escapeHtml(id)}" data-edit-description value="${escapeHtml(hook.description || '')}">
      </div>
      <div class="mb-2 small">
        ${events.map(event => `
          <div class="form-check">
            <input class="form-check-input" type="checkbox" value="${escapeHtml(event.id)}"
                   id="wh-edit-${escapeHtml(id)}-${escapeHtml(event.id)}" data-edit-event ${chosen.has(event.id) ? 'checked' : ''}>
            <label class="form-check-label" for="wh-edit-${escapeHtml(id)}-${escapeHtml(event.id)}">${escapeHtml(event.label)}</label>
          </div>`).join('')}
      </div>
      <div class="d-flex gap-2">
        <button type="button" class="btn btn-sm btn-primary" data-edit-save>Save</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" data-edit-cancel>Cancel</button>
      </div>
    </div>`;

  area.querySelector('[data-edit-cancel]').addEventListener('click', () => {
    area.innerHTML = '';
  });

  area.querySelector('[data-edit-save]').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api(`/api/webhooks/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: {
          url: area.querySelector('[data-edit-url]').value.trim(),
          description: area.querySelector('[data-edit-description]').value.trim(),
          events: [...area.querySelectorAll('[data-edit-event]:checked')].map(input => input.value)
        }
      });
      showToast('Endpoint saved', 'success');
      loadWebhooks();
      loadDeliveries();
    } catch (error) {
      showToast(error.message, 'danger');
      button.disabled = false;
    }
  });
}

/**
 * Show a secret once, with the verification recipe beside it.
 *
 * The recipe is here rather than in documentation because this is the one
 * moment somebody is holding the secret and about to write the verifying
 * code — and because a signature scheme nobody implements correctly protects
 * nothing.
 */
function showSecret(secret, notice) {
  const panel = document.getElementById('webhook-secret-panel');

  panel.innerHTML = `
    <div class="alert alert-success alert-dismissible">
      <!-- Dismissible rather than auto-hiding: somebody needs time to copy
           it, but a secret left on screen until the next page load is one
           more place it can be read from. -->
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Hide"></button>
      <div class="fw-semibold mb-1">${escapeHtml(notice || 'Copy this now.')}</div>
      <code class="d-block p-2 bg-light text-dark rounded user-select-all mb-2">${escapeHtml(secret)}</code>
      <details>
        <summary class="small">How to verify a delivery</summary>
        <p class="small mt-2 mb-1">
          Each request carries <code>X-Webhook-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>.
          Sign <code>&lt;t&gt;.&lt;raw body&gt;</code> with this secret and compare.
          Reject anything where <code>t</code> is more than a few minutes old —
          that is what stops an old delivery being replayed at you.
        </p>
<pre class="small mb-0"><code>const [t, v1] = header.split(',').map(p =&gt; p.split('=')[1]);
const expected = crypto.createHmac('sha256', SECRET)
.update(t + '.' + rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
&amp;&amp; Math.abs(Date.now() / 1000 - Number(t)) &lt; 300;</code></pre>
      </details>
    </div>`;

  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// -------------------------------------------------------------- creating

async function loadEvents() {
  try {
    const body = await api('/api/webhooks/events');
    events = body.events || [];

    const container = document.getElementById('webhook-events');
    if (container) {
      container.innerHTML = events.map(event => `
        <div class="form-check">
          <input class="form-check-input" type="checkbox" value="${escapeHtml(event.id)}"
                 id="wh-event-${escapeHtml(event.id)}">
          <label class="form-check-label small" for="wh-event-${escapeHtml(event.id)}">
            ${escapeHtml(event.label)}
            <code class="text-muted ms-1">${escapeHtml(event.id)}</code>
          </label>
        </div>`).join('');
    }
  } catch {
    // The list still renders; only the create form is short of options.
  }
}

async function create() {
  const button = document.getElementById('webhook-create-btn');
  const chosen = [...document.querySelectorAll('#webhook-events input:checked')]
    .map(input => input.value);

  button.disabled = true;

  try {
    const result = await api('/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        url: document.getElementById('webhook-url').value.trim(),
        description: document.getElementById('webhook-description').value.trim(),
        events: chosen
      })
    });

    showSecret(result.secret, result.secretNotice);
    document.getElementById('webhook-url').value = '';
    document.getElementById('webhook-description').value = '';
    document.querySelectorAll('#webhook-events input:checked').forEach(input => {
      input.checked = false;
    });

    loadWebhooks();
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------ deliveries

async function loadDeliveries() {
  const table = document.getElementById('webhook-deliveries');
  if (!table) {
    return;
  }

  try {
    const status = document.getElementById('webhook-delivery-filter')?.value || '';
    const { deliveries, retentionDays } = await api(`/api/webhooks/deliveries${status ? `?status=${status}` : ''}`);

    const note = document.getElementById('webhook-retention-note');
    if (note && retentionDays) {
      note.textContent = `Kept for ${retentionDays} days.`;
    }

    if (deliveries.length === 0) {
      table.innerHTML =
        '<tr><td colspan="7" class="text-center text-muted py-4">Nothing sent yet.</td></tr>';
      return;
    }

    const tone = { delivered: 'success', pending: 'warning', failed: 'danger' };

    table.innerHTML = deliveries.map(delivery => `
      <tr>
        <td class="small text-nowrap">${escapeHtml(new Date(delivery.createdAt).toLocaleString())}</td>
        <td class="small">${escapeHtml(eventLabel(delivery.event))}</td>
        <td class="small text-break" title="${escapeHtml(delivery.webhookUrl || '')}">
          ${escapeHtml(delivery.webhookDescription || delivery.webhookUrl || 'A deleted endpoint')}
        </td>
        <td><span class="badge bg-${tone[delivery.status]}">${escapeHtml(delivery.status)}</span></td>
        <td class="small">${escapeHtml(delivery.responseStatus || '—')}</td>
        <td class="small text-muted text-break">
          ${escapeHtml(delivery.error || delivery.responseBody || '')}
          ${delivery.status === 'pending' && delivery.nextAttemptAt
    ? `<div>Next try ${escapeHtml(formatRelativeTime(delivery.nextAttemptAt))}</div>` : ''}
          ${delivery.attempts > 1 ? `<div>${delivery.attempts} attempts</div>` : ''}
        </td>
        <td class="text-end">
          ${delivery.status === 'failed' && delivery.webhookUrl
    ? `<button class="btn btn-sm btn-outline-primary" data-redeliver="${escapeHtml(delivery._id)}"
                       data-webhook="${escapeHtml(delivery.webhook)}">Send again</button>`
    : ''}
        </td>
      </tr>`).join('');
  } catch (error) {
    table.innerHTML =
      `<tr><td colspan="7" class="text-danger text-center py-4">${escapeHtml(error.message)}</td></tr>`;
  }
}

/**
 * Send a failed delivery again, once the endpoint is fixed. The result shows
 * as a new row; the failed one stays as the record of what went wrong.
 */
async function redeliver(button) {
  button.disabled = true;
  try {
    const { result } = await api(
      `/api/webhooks/${encodeURIComponent(button.dataset.webhook)}/deliveries/${encodeURIComponent(button.dataset.redeliver)}/redeliver`,
      { method: 'POST' }
    );
    showToast(result.delivered
      ? `Delivered - your endpoint returned ${result.status}.`
      : (result.error || 'The endpoint did not accept it.'), result.delivered ? 'success' : 'danger');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    loadDeliveries();
  }
}

function setupWebhooks() {
  document.getElementById('webhook-create-btn').addEventListener('click', create);
  document.getElementById('webhook-delivery-filter').addEventListener('change', loadDeliveries);
  document.getElementById('webhook-refresh-deliveries').addEventListener('click', loadDeliveries);
  document.getElementById('webhook-deliveries').addEventListener('click', event => {
    const button = event.target.closest('[data-redeliver]');
    if (button) {
      redeliver(button);
    }
  });
}

registerSection('webhooks', {
  setup: setupWebhooks,
  show() {
    loadEvents().then(() => {
      loadWebhooks();
      loadDeliveries();
    });
  }
});
