/**
 * How long a company's conversations are kept. The company's obligations are
 * theirs, so the windows are theirs to set.
 */

import { registerSection } from './nav.js';
import { api, escapeHtml, setLoading, showToast } from './utils.js';

const number = value => Number(value || 0).toLocaleString();

/** An empty box means "follow the platform default", which is not zero. */
function readDays(id) {
  const value = document.getElementById(id).value.trim();
  return value === '' ? null : Number(value);
}

function describe(days) {
  if (days === 0) {
    return 'never';
  }
  return `after ${number(days)} days`;
}

function renderRetention(data) {
  const anonymize = document.getElementById('retention-anonymize');
  const remove = document.getElementById('retention-delete');
  const stored = data.dataRetention || {};

  anonymize.value = stored.anonymizeAfterDays ?? '';
  remove.value = stored.deleteAfterDays ?? '';

  const impact = document.getElementById('retention-impact');
  const effective = data.effective;

  // The counts come first: "delete after 30 days" means nothing next to
  // "this would remove 4,812 conversations tonight".
  impact.innerHTML = `
    <h6 class="mb-2">What happens tonight</h6>
    <p class="mb-2">
      <strong>${number(data.impact.toAnonymize)}</strong> conversations would be anonymised,
      <strong>${number(data.impact.toDelete)}</strong> deleted.
    </p>
    <p class="text-muted small mb-0">
      In force: anonymise ${escapeHtml(describe(effective.anonymizeAfterDays))}
      (${escapeHtml(effective.source.anonymizeAfterDays)}),
      delete ${escapeHtml(describe(effective.deleteAfterDays))}
      (${escapeHtml(effective.source.deleteAfterDays)}).
    </p>`;
}

async function loadRetention() {
  try {
    renderRetention(await api('/api/companies/me/retention'));
  } catch (error) {
    document.getElementById('retention-impact').innerHTML =
      `<div class="text-danger small">${escapeHtml(error.message)}</div>`;
  }
}

async function saveRetention() {
  const button = document.getElementById('retention-save');
  setLoading(button, true);

  try {
    const result = await api('/api/companies/me/retention', {
      method: 'PUT',
      body: JSON.stringify({
        anonymizeAfterDays: readDays('retention-anonymize'),
        deleteAfterDays: readDays('retention-delete')
      })
    });

    renderRetention({
      dataRetention: result.dataRetention,
      effective: result.effective,
      impact: result.impact
    });
    showToast('Retention policy saved', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    setLoading(button, false);
  }
}

registerSection('retention', {
  setup() {
    document.getElementById('retention-save').addEventListener('click', saveRetention);
  },
  show: loadRetention
});
