/**
 * How long a company's conversations are kept. The company's obligations are
 * theirs, so the windows are theirs to set.
 */

import { registerSection } from './nav.js';
import { api, confirmDialog, debounce, escapeHtml, setLoading, showToast } from './utils.js';

const number = value => Number(value || 0).toLocaleString();

/** Deleting sooner than this is asked about before it is saved. */
const SHORT_DELETE_WINDOW = 30;

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

/**
 * What the policy would do tonight. `typed` says whether these are the values
 * in the boxes rather than the saved ones, so the heading can say so.
 */
function renderImpact(data, typed = false) {
  const impact = document.getElementById('retention-impact');
  const effective = data.effective;

  // The counts come first: "delete after 30 days" means nothing next to
  // "this would remove 4,812 conversations tonight".
  impact.innerHTML = `
    <h6 class="mb-2">What happens tonight${typed ? ' with these values' : ''}</h6>
    <p class="mb-2">
      <strong>${number(data.impact.toAnonymize)}</strong> conversations would be anonymised,
      <strong>${number(data.impact.toDelete)}</strong> deleted.
    </p>
    <p class="text-muted small mb-0">
      ${typed ? 'Would be in force' : 'In force'}: anonymise ${escapeHtml(describe(effective.anonymizeAfterDays))}
      (${escapeHtml(effective.source.anonymizeAfterDays)}),
      delete ${escapeHtml(describe(effective.deleteAfterDays))}
      (${escapeHtml(effective.source.deleteAfterDays)}).
    </p>`;
}

function renderRetention(data) {
  const stored = data.dataRetention || {};
  document.getElementById('retention-anonymize').value = stored.anonymizeAfterDays ?? '';
  document.getElementById('retention-delete').value = stored.deleteAfterDays ?? '';
  renderImpact(data);
}

async function loadRetention() {
  try {
    renderRetention(await api('/api/companies/me/retention'));
  } catch (error) {
    document.getElementById('retention-impact').innerHTML =
      `<div class="text-danger small">${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Recompute "what happens tonight" from what is typed, before anything is
 * saved. It used to show the saved policy's numbers right up to the moment
 * Save was pressed.
 */
const previewTyped = debounce(async () => {
  const params = new URLSearchParams();
  const anonymize = readDays('retention-anonymize');
  const remove = readDays('retention-delete');
  if (anonymize !== null) {
    params.set('anonymizeAfterDays', String(anonymize));
  }
  if (remove !== null) {
    params.set('deleteAfterDays', String(remove));
  }

  try {
    renderImpact(await api(`/api/companies/me/retention/preview?${params.toString()}`), true);
  } catch (error) {
    document.getElementById('retention-impact').innerHTML =
      `<div class="text-danger small">${escapeHtml(error.message)}</div>`;
  }
}, 400);

async function saveRetention() {
  const button = document.getElementById('retention-save');
  const deleteAfterDays = readDays('retention-delete');

  if (deleteAfterDays !== null && deleteAfterDays > 0 && deleteAfterDays < SHORT_DELETE_WINDOW) {
    const ok = await confirmDialog({
      title: `Delete conversations after ${deleteAfterDays} day${deleteAfterDays === 1 ? '' : 's'}?`,
      message: 'That is shorter than a month. Deleted conversations cannot be brought back, and reports lose them too. Check "What happens tonight" before you go ahead.',
      confirmLabel: 'Save and delete on that schedule',
      danger: true
    });
    if (!ok) {
      return;
    }
  }

  setLoading(button, true);

  try {
    const result = await api('/api/companies/me/retention', {
      method: 'PUT',
      body: JSON.stringify({
        anonymizeAfterDays: readDays('retention-anonymize'),
        deleteAfterDays
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
    ['retention-anonymize', 'retention-delete'].forEach(id => {
      document.getElementById(id).addEventListener('input', previewTyped);
    });
  },
  show: loadRetention
});
