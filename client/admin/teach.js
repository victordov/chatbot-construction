/**
 * "Teach the bot": turn a wrong or missing answer into a better one, from
 * wherever the mistake is seen (the inbox transcript, the unanswered-questions
 * list, Test your bot).
 *
 * Opens a dialog with the visitor's question and the answer to save, lets the
 * admin choose between a knowledge snippet and a canned reply, saves it
 * through `POST /api/bot/teach`, and marks the message as corrected. The
 * server re-runs the saved tests afterwards, and the dialog says how they did,
 * so a fix that breaks another answer is seen by the person who made it.
 */

import { Modal } from 'bootstrap';
import { api, errorMessage, escapeHtml, setLoading } from './utils.js';

/** The options of the dialog on screen, or null. */
let current = null;
let bound = false;

function elements() {
  return {
    modal: document.getElementById('teachModal'),
    form: document.getElementById('teach-form'),
    question: document.getElementById('teach-question'),
    answer: document.getElementById('teach-answer'),
    title: document.getElementById('teach-title'),
    result: document.getElementById('teach-result'),
    save: document.getElementById('teach-save'),
    cancel: document.getElementById('teach-cancel')
  };
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * What the dialog says once the answer is saved: where it went, and whether
 * the saved tests still pass.
 */
function savedHtml(result) {
  const where = result.kind === 'canned'
    ? 'Saved as a canned reply. It is sent word for word when a visitor asks this.'
    : 'Saved to your knowledge. The bot will use it, in its own words, from the next message.';

  const tests = result.tests;
  if (!tests || !tests.total) {
    return `<div class="alert alert-success py-2 small mb-0">${escapeHtml(where)}</div>`;
  }

  if (!tests.failed) {
    return `
      <div class="alert alert-success py-2 small mb-0">
        ${escapeHtml(where)}
        <div class="fw-semibold mt-1">${escapeHtml(`${tests.passed} of ${plural(tests.total, 'test')} still pass.`)}</div>
      </div>`;
  }

  return `
    <div class="alert alert-warning py-2 small mb-0">
      ${escapeHtml(where)}
      <div class="fw-semibold mt-1">
        ${escapeHtml(`${tests.passed} of ${plural(tests.total, 'test')} still pass; ${tests.failed} ${tests.failed === 1 ? 'fails' : 'fail'}:`)}
      </div>
      <ul class="mb-1 ps-3">
        ${(tests.failures || []).slice(0, 5).map(failure => `
          <li>${escapeHtml(failure.question)} <span class="text-muted">— ${escapeHtml(failure.reason)}</span></li>`).join('')}
      </ul>
      <a href="?section=bot-test">Open Test your bot</a> to see the answers.
    </div>`;
}

async function save(event) {
  event.preventDefault();
  const el = elements();

  if (!current || current.saved) {
    return;
  }

  const question = el.question.value.trim();
  const answer = el.answer.value.trim();
  const kind = (document.querySelector('input[name="teach-kind"]:checked') || {}).value || 'knowledge';

  if (!question) {
    el.question.focus();
    el.result.innerHTML = '<div class="text-danger small">Say what the visitor asked.</div>';
    return;
  }
  if (!answer) {
    el.answer.focus();
    el.result.innerHTML = '<div class="text-danger small">Write the answer the bot should give.</div>';
    return;
  }

  setLoading(el.save, true);
  el.result.innerHTML = '';

  try {
    const result = await api('/api/bot/teach', {
      method: 'POST',
      body: {
        question,
        answer,
        kind,
        title: el.title.value.trim() || undefined,
        sessionId: current.sessionId || undefined,
        messageId: current.messageId || undefined,
        gapKey: current.gapKey || undefined
      }
    });

    current.saved = true;
    el.result.innerHTML = savedHtml(result);
    setLoading(el.save, false);
    el.save.disabled = true;
    el.save.textContent = 'Saved';
    el.cancel.textContent = 'Close';
    // The disabled button just lost focus; without this it falls to the page
    // and Escape no longer reaches the dialog.
    el.cancel.focus();

    if (typeof current.onSaved === 'function') {
      current.onSaved(result);
    }
  } catch (error) {
    setLoading(el.save, false);
    el.result.innerHTML = `<div class="alert alert-danger py-2 small mb-0">${escapeHtml(errorMessage(error, 'Could not save that answer'))}</div>`;
  }
}

function bind() {
  if (bound) {
    return;
  }
  bound = true;
  const el = elements();
  el.form.addEventListener('submit', save);
  el.modal.addEventListener('hidden.bs.modal', () => {
    current = null;
  });
}

/**
 * Open the dialog.
 *
 * @param {object} options
 * @param {string} [options.sessionId] conversation the question came from
 * @param {string} [options.messageId] the bot message being corrected
 * @param {string} options.question what the visitor asked
 * @param {string} [options.answer] a starting answer (e.g. the operator's reply)
 * @param {'knowledge'|'canned'} [options.kind='knowledge'] the choice to start on
 * @param {string} [options.title]
 * @param {string} [options.gapKey] the unanswered-questions group being
 *        answered, which leaves the list once saved
 * @param {Function} [options.onSaved] called with the server's response
 */
export function openTeachDialog(options = {}) {
  const el = elements();
  if (!el.modal) {
    return;
  }
  bind();

  current = { ...options, saved: false };

  el.question.value = options.question || '';
  el.answer.value = options.answer || '';
  el.title.value = options.title || '';
  const kind = options.kind === 'canned' ? 'canned' : 'knowledge';
  document.getElementById(`teach-kind-${kind}`).checked = true;

  el.result.innerHTML = '';
  el.save.disabled = false;
  el.save.textContent = 'Save answer';
  el.cancel.textContent = 'Cancel';

  Modal.getOrCreateInstance(el.modal).show();
  el.modal.addEventListener('shown.bs.modal', () => {
    // Straight to whatever is still missing.
    (el.question.value.trim() ? el.answer : el.question).focus();
  }, { once: true });
}
