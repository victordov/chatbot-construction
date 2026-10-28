/**
 * Routing: how conversations reach an operator.
 */

import { registerSection } from './nav.js';
import { api, errorMessage, showToast } from './utils.js';

async function loadRoutingSettings() {
  try {
    const { routing } = await api('/api/companies/me/routing');

    const auto = document.getElementById('routing-auto-assign');
    const max = document.getElementById('routing-max-concurrent');
    const onStart = document.getElementById('routing-assign-on-start');
    const escalate = document.getElementById('routing-escalate-minutes');

    if (auto) {
      auto.checked = Boolean(routing.autoAssign);
    }
    if (max) {
      max.value = routing.maxConcurrent || 3;
    }
    if (onStart) {
      onStart.checked = Boolean(routing.assignOnStart);
    }
    if (escalate) {
      escalate.value = routing.escalateAfterMinutes ?? 5;
    }
  } catch (error) {
    showToast(errorMessage(error, 'Could not load the routing settings'), 'danger');
  }
}

async function saveRoutingSettings() {
  const button = document.getElementById('save-routing-btn');
  button.disabled = true;

  try {
    await api('/api/companies/me/routing', {
      method: 'PUT',
      body: JSON.stringify({
        autoAssign: document.getElementById('routing-auto-assign').checked,
        maxConcurrent: parseInt(document.getElementById('routing-max-concurrent').value, 10),
        assignOnStart: document.getElementById('routing-assign-on-start').checked,
        escalateAfterMinutes: parseInt(document.getElementById('routing-escalate-minutes').value, 10)
      })
    });

    showToast('Routing settings saved', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    button.disabled = false;
  }
}

registerSection('routing', {
  setup() {
    document.getElementById('save-routing-btn').addEventListener('click', saveRoutingSettings);
  },
  show: loadRoutingSettings
});
