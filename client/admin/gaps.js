/**
 * Unanswered questions: what the bot could not answer, most asked first.
 *
 * The loop that makes a bot better is "see what it got wrong, add the answer",
 * and before this screen the first half meant reading transcripts one by one.
 * Each row is a group of the same question asked different ways, with why it
 * is here (the bot said it did not know, a thumbs down, a visitor asking for
 * a person right after the answer, the model failing), a few real examples to
 * open, and the answer added from the same row.
 */

import { registerSection } from './nav.js';
import { openTeachDialog } from './teach.js';
import { api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, showToast } from './utils.js';

const REASONS = {
  unanswered: 'Said it did not know',
  thumbs_down: 'Thumbs down',
  handoff: 'Asked for a person after the answer',
  failed: 'The AI could not answer'
};

let groups = [];

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function days() {
  return Number(document.getElementById('gaps-days').value) || 30;
}

function reasonBadges(reasons = {}) {
  return Object.entries(reasons)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `
      <span class="badge gap-reason gap-reason-${escapeHtml(reason)}">
        ${escapeHtml(REASONS[reason] || reason)}${count > 1 ? ` × ${count}` : ''}
      </span>`)
    .join('');
}

function examplesHtml(group) {
  const examples = group.examples || [];
  if (!examples.length) {
    return '';
  }

  return `
    <details class="gap-examples mt-2">
      <summary class="small">${plural(examples.length, 'example')}</summary>
      <ul class="list-unstyled mb-0 mt-2">
        ${examples.map(example => `
          <li class="gap-example">
            <div class="small"><span class="text-muted">Visitor:</span> ${escapeHtml(example.question)}</div>
            <div class="small"><span class="text-muted">Bot:</span>
              ${example.answer ? escapeHtml(example.answer) : '<em class="text-muted">no answer</em>'}</div>
            <div class="small">
              ${example.sessionId ? `<a href="?section=active-chats&amp;chat=${encodeURIComponent(example.sessionId)}">Open the conversation</a> · ` : ''}
              <span class="text-muted">${escapeHtml(formatRelativeTime(example.at))}</span>
            </div>
          </li>`).join('')}
      </ul>
    </details>`;
}

function groupHtml(group, index) {
  return `
    <div class="card gap-card mb-3" data-gap-index="${index}">
      <div class="card-body">
        <div class="d-flex gap-3 align-items-start flex-wrap">
          <div class="me-auto gap-main">
            <div class="fw-semibold">${escapeHtml(group.question)}</div>
            <div class="small text-muted">
              Asked ${plural(group.count, 'time')} · last ${escapeHtml(formatRelativeTime(group.lastAt))}
            </div>
            <div class="gap-reasons mt-1">${reasonBadges(group.reasons)}</div>
          </div>
          <div class="d-flex gap-2">
            <button type="button" class="btn btn-sm btn-primary" data-gap-teach="${index}">Add the answer</button>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-gap-dismiss="${index}">Dismiss</button>
          </div>
        </div>
        ${examplesHtml(group)}
      </div>
    </div>`;
}

function renderEmpty(list) {
  list.innerHTML = `
    <div class="card">
      <div class="card-body text-center py-5">
        <p class="mb-1">Nothing the bot couldn't answer in the last ${plural(days(), 'day')}.</p>
        <p class="small text-muted mb-0">
          When it says it does not know, gets a thumbs down, or a visitor asks for a person right after an answer,
          the question shows up here.
        </p>
      </div>
    </div>`;
}

async function load() {
  const list = document.getElementById('gaps-list');
  const summary = document.getElementById('gaps-summary');

  list.innerHTML = '<div class="text-muted">Loading…</div>';
  summary.textContent = '';

  try {
    const data = await api(`/api/bot/gaps?days=${days()}&limit=50`);
    groups = data.groups || [];

    if (!groups.length) {
      renderEmpty(list);
      return;
    }

    summary.textContent = [
      `${plural(data.total, 'question')}, asked ${plural(data.occurrences, 'time')}`,
      data.total > groups.length ? `showing the ${groups.length} most asked` : null
    ].filter(Boolean).join(' · ');

    list.innerHTML = groups.map(groupHtml).join('');
  } catch (error) {
    list.innerHTML = '<div class="text-danger">Could not load the unanswered questions.</div>';
    showToast(errorMessage(error, 'Could not load the unanswered questions'), 'danger');
  }
}

/** Take a group off the screen without reloading the rest. */
function removeCard(index) {
  const card = document.querySelector(`#gaps-list [data-gap-index="${index}"]`);
  if (card) {
    card.remove();
  }
  if (!document.querySelector('#gaps-list [data-gap-index]')) {
    renderEmpty(document.getElementById('gaps-list'));
    document.getElementById('gaps-summary').textContent = '';
  }
}

function teach(index) {
  const group = groups[index];
  if (!group) {
    return;
  }
  // The most recent example is the one corrected; the rest of the group
  // leaves the list because it is answered (gapKey).
  const example = (group.examples || [])[0] || {};
  openTeachDialog({
    sessionId: example.sessionId,
    messageId: example.messageId,
    question: group.question,
    answer: '',
    gapKey: group.key,
    onSaved: () => removeCard(index)
  });
}

async function dismiss(index, button) {
  const group = groups[index];
  if (!group) {
    return;
  }

  const ok = await confirmDialog({
    title: 'Dismiss this question?',
    message: `"${group.question}" leaves the list. If visitors ask it again, it comes back.`,
    confirmLabel: 'Dismiss'
  });
  if (!ok) {
    return;
  }

  button.disabled = true;
  try {
    await api(`/api/bot/gaps/${encodeURIComponent(group.key)}/dismiss`, { method: 'POST' });
    removeCard(index);
    showToast('Dismissed', 'success');
  } catch (error) {
    button.disabled = false;
    showToast(errorMessage(error, 'Could not dismiss that question'), 'danger');
  }
}

function setup() {
  document.getElementById('gaps-days').addEventListener('change', load);

  document.getElementById('gaps-list').addEventListener('click', event => {
    const teachButton = event.target.closest('[data-gap-teach]');
    if (teachButton) {
      teach(Number(teachButton.dataset.gapTeach));
      return;
    }
    const dismissButton = event.target.closest('[data-gap-dismiss]');
    if (dismissButton) {
      dismiss(Number(dismissButton.dataset.gapDismiss), dismissButton);
    }
  });
}

registerSection('gaps', { setup, show: load });
