/**
 * Test your bot.
 *
 * Runs the real reply path - the live workflow, canned replies, knowledge and
 * read-only actions - through /api/bot/test, which saves no conversation,
 * counts no usage and changes nothing in the tenant's systems. Each answer
 * says how it was produced and what it drew on, so "why did it say that?"
 * is answered on the spot rather than by guesswork after a customer saw it.
 *
 * The same panel appears as a screen of its own and as a drawer beside
 * Knowledge, Persona & replies and Actions, so an admin can change something
 * and try it without losing their place.
 *
 * Any answer can be saved as a test, and the screen keeps the saved tests:
 * questions the bot must keep answering properly, run again with one click
 * (and by the server whenever somebody teaches the bot something).
 */

import { Modal, Offcanvas } from 'bootstrap';
import { markBotTested } from './home.js';
import { registerSection } from './nav.js';
import { openTeachDialog } from './teach.js';
import {
  api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, safeHref, setLoading, showToast
} from './utils.js';

const TOOL_STATUS = {
  ok: 'ran',
  error: 'failed',
  simulated: 'would have run (writes are skipped in a test)',
  confirmation_requested: 'asked the customer to confirm',
  awaiting_confirmation: 'still waiting for a yes',
  limit_reached: 'skipped: too many in one reply',
  bad_arguments: 'missing information',
  unknown_tool: 'not available'
};

/** What answered, in the admin's terms. Only claims knowledge when it was used. */
function pathLabel(result) {
  switch (result.path) {
  case 'workflow':
    return 'Your live workflow';
  case 'canned':
    return 'A canned reply, sent word for word';
  case 'assistant':
    return result.knowledgeMatched ? 'Assistant, from your knowledge' : 'Assistant';
  case 'fallback':
    return result.failed ? 'No answer' : 'Fallback line';
  default:
    return result.path || 'Assistant';
  }
}

function linkOrText(title, url) {
  const href = url ? safeHref(url) : null;
  const text = escapeHtml(title || url || 'a source');
  return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : `<span>${text}</span>`;
}

function sourcesHtml(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return '';
  }
  return `
    <div class="bot-test-meta">
      <span class="text-muted">From:</span>
      ${sources.map(source => linkOrText(source.title, source.url)).join(', ')}
    </div>`;
}

/**
 * The passages retrieval found, with how closely each matched. Collapsed:
 * most of the time the answer is enough, and when it is wrong this is the
 * first place to look.
 */
function passagesHtml(passages) {
  if (!Array.isArray(passages) || passages.length === 0) {
    return '';
  }
  return `
    <details class="bot-test-passages">
      <summary class="small">What it found in your knowledge (${passages.length})</summary>
      ${passages.map(passage => `
        <div class="bot-test-passage">
          <div class="d-flex gap-2 align-items-center">
            <span class="badge text-bg-light border" title="How closely this passage matches the question">${escapeHtml(passage.score)}</span>
            <span class="small fw-semibold text-truncate">${linkOrText(passage.title, passage.url)}</span>
          </div>
          <div class="small text-muted">${escapeHtml(passage.excerpt)}</div>
        </div>`).join('')}
    </details>`;
}

function cardsHtml(cards) {
  const items = cards && Array.isArray(cards.items) ? cards.items : [];
  if (!items.length) {
    return '';
  }
  return `
    <div class="bot-test-cards">
      ${items.slice(0, 6).map(item => `
        <div class="bot-test-card">
          <div class="fw-semibold small">${escapeHtml(item.title || item.label || item.startsAt || item.id)}</div>
          ${item.price !== undefined && item.price !== null
    ? `<div class="small text-muted">${escapeHtml(item.price)} ${escapeHtml(item.currency || '')}</div>` : ''}
        </div>`).join('')}
    </div>`;
}

/** Why this answer needs attention, if it does, in plain words. */
function noticeHtml(result) {
  if (result.failed && result.visitorWouldSee) {
    const next = result.visitorWouldSee.kind === 'handover'
      ? 'A visitor would get the message above and be passed to your team.'
      : 'A visitor would get the message above and be asked for their email address.';
    return `
      <div class="alert alert-danger py-2 px-2 small mt-2 mb-0">
        <div class="fw-semibold">The AI could not answer this.</div>
        <div>${escapeHtml(result.visitorWouldSee.why)}</div>
        <div class="mt-1">${escapeHtml(next)}</div>
      </div>`;
  }

  if (result.unanswered) {
    return `
      <div class="alert alert-warning py-2 px-2 small mt-2 mb-0">
        The bot said it did not know. A visitor would be offered "Talk to a person".
        Add the answer and it knows next time.
      </div>`;
  }

  if (result.path === 'assistant' && !result.knowledgeMatched) {
    return `
      <div class="bot-test-meta text-muted">
        Nothing in your knowledge matched this question, so the assistant answered from its persona alone.
        <a href="?section=knowledge">Add the material that covers it</a>.
      </div>`;
  }

  return '';
}

function botMessageHtml(result, replyId) {
  const tools = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const needsAnswer = result.unanswered || result.failed;
  return `
    <div class="message-content">${escapeHtml(result.reply || '(no reply)')}</div>
    ${cardsHtml(result.cards)}
    <div class="bot-test-meta">
      <span class="badge text-bg-light border">${escapeHtml(pathLabel(result))}</span>
      ${result.escalate && result.escalate.enabled !== false ? '<span class="badge text-bg-warning">Would hand over to a person</span>' : ''}
      ${result.asVerified ? '<span class="badge text-bg-info">As a verified customer</span>' : ''}
    </div>
    ${sourcesHtml(result.sources)}
    ${noticeHtml(result)}
    ${passagesHtml(result.passages)}
    ${tools.length ? `
      <div class="bot-test-meta">
        ${tools.map(call => `<span class="text-muted">Action <code>${escapeHtml(call.name)}</code> ${escapeHtml(TOOL_STATUS[call.status] || call.status)}</span>`).join('<br>')}
      </div>` : ''}
    ${result.warning && !result.failed ? `<div class="alert alert-warning py-1 px-2 small mt-2 mb-0">${escapeHtml(result.warning)} - the bot can only use scripted replies.</div>` : ''}
    <div class="bot-test-actions">
      <button type="button" class="btn btn-link btn-sm p-0" data-save-test="${replyId}">Save as a test</button>
      <button type="button" class="btn btn-link btn-sm p-0" data-teach="${replyId}">${needsAnswer ? 'Add the answer' : 'Teach a better answer'}</button>
    </div>`;
}

/**
 * The expectation a saved test starts with, guessed from the answer: an
 * answer that handed over is a handover test, one that cited a source checks
 * that source. The admin can change it before saving.
 */
function suggestedExpectation(result) {
  if (result.failed || result.unanswered || (result.escalate && result.escalate.enabled !== false)) {
    return { type: 'handover', value: '' };
  }
  if (Array.isArray(result.sources) && result.sources.length) {
    return { type: 'cites', value: result.sources[0].title || result.sources[0].url || '' };
  }
  return { type: 'contains', value: '' };
}

let replySequence = 0;

/**
 * One test conversation, in one container.
 */
class BotTest {
  constructor(container) {
    this.container = container;
    this.history = [];
    this.workflowState = null;
    this.busy = false;
    // The question and answer behind each bot message, for Save as a test
    // and Teach.
    this.replies = new Map();
    this.render();
  }

  render() {
    const id = `bot-test-${this.container.dataset.botTest}`;
    this.container.innerHTML = `
      <div class="bot-test-toolbar">
        <div class="form-check form-switch mb-0">
          <input class="form-check-input" type="checkbox" id="${id}-workflow" data-bot-test-workflow checked>
          <label class="form-check-label small" for="${id}-workflow">Use your live workflows, if you have any</label>
        </div>
        <div class="form-check form-switch mb-0">
          <input class="form-check-input" type="checkbox" id="${id}-verified" data-bot-test-verified>
          <label class="form-check-label small" for="${id}-verified">Test as a verified customer</label>
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary" data-bot-test-reset>Start again</button>
      </div>
      <div class="bot-test-customer" data-bot-test-customer hidden>
        <p class="small text-muted mb-2">
          As if a signed-in customer were asking, so actions that need a verified customer are offered.
          Nothing is changed in your systems; lookups use the id below.
        </p>
        <div class="d-flex gap-2 flex-wrap">
          <label class="visually-hidden" for="${id}-customer-id">Their id in your system</label>
          <input type="text" class="form-control form-control-sm" id="${id}-customer-id" data-customer-field="externalId"
                 placeholder="e.g. their id in your system (optional)" autocomplete="off">
          <label class="visually-hidden" for="${id}-customer-email">Their email</label>
          <input type="email" class="form-control form-control-sm" id="${id}-customer-email" data-customer-field="email"
                 placeholder="e.g. their email (optional)" autocomplete="off">
        </div>
      </div>
      <div class="bot-test-log chat-messages" aria-live="polite">
        <div class="empty-state">
          <p class="mb-1">Ask what a customer would ask.</p>
          <p class="small text-muted mb-0">Try something your material covers, something it does not, and "can I talk to a person?".</p>
        </div>
      </div>
      <form class="bot-test-form" novalidate>
        <label class="visually-hidden" for="${id}-input">Message</label>
        <input type="text" class="form-control" id="${id}-input" data-bot-test-input placeholder="Type a customer's question…" autocomplete="off">
        <button type="submit" class="btn btn-primary">Send</button>
      </form>`;

    this.log = this.container.querySelector('.bot-test-log');
    this.input = this.container.querySelector('[data-bot-test-input]');
    this.useWorkflow = this.container.querySelector('[data-bot-test-workflow]');
    this.asVerified = this.container.querySelector('[data-bot-test-verified]');
    this.customer = this.container.querySelector('[data-bot-test-customer]');

    this.container.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      this.send(this.input.value);
    });
    this.container.querySelector('[data-bot-test-reset]').addEventListener('click', () => this.reset());
    this.useWorkflow.addEventListener('change', () => this.reset());
    this.asVerified.addEventListener('change', () => {
      this.customer.hidden = !this.asVerified.checked;
      this.reset();
    });

    this.log.addEventListener('click', event => {
      // Choice buttons from a workflow answer as if the customer had tapped them.
      const choice = event.target.closest('[data-choice]');
      if (choice && !this.busy) {
        this.send(choice.dataset.choice);
        return;
      }

      const save = event.target.closest('[data-save-test]');
      if (save) {
        const entry = this.replies.get(save.dataset.saveTest);
        if (entry) {
          openSaveTest({ question: entry.question, expect: suggestedExpectation(entry.result) });
        }
        return;
      }

      const teach = event.target.closest('[data-teach]');
      if (teach) {
        const entry = this.replies.get(teach.dataset.teach);
        if (entry) {
          openTeachDialog({
            question: entry.question,
            // A wrong answer is a starting point to correct; "I don't know"
            // and an apology are not.
            answer: entry.result.unanswered || entry.result.failed ? '' : (entry.result.reply || ''),
            onSaved: () => document.dispatchEvent(new CustomEvent('bot-tests-changed'))
          });
        }
      }
    });
  }

  reset() {
    this.history = [];
    this.workflowState = null;
    this.replies.clear();
    this.log.innerHTML = '<div class="empty-state"><p class="mb-0">Started again.</p></div>';
    this.input.focus();
  }

  append(className, html) {
    this.log.querySelector('.empty-state')?.remove();
    const message = document.createElement('div');
    message.className = `message ${className}`;
    message.innerHTML = html;
    this.log.appendChild(message);
    this.log.scrollTop = this.log.scrollHeight;
    return message;
  }

  customerFields() {
    const fields = {};
    this.customer.querySelectorAll('[data-customer-field]').forEach(input => {
      if (input.value.trim()) {
        fields[input.dataset.customerField] = input.value.trim();
      }
    });
    return fields;
  }

  async send(text) {
    const message = String(text || '').trim();
    if (!message || this.busy) {
      return;
    }

    this.busy = true;
    this.input.value = '';
    this.append('user', `<div class="message-content">${escapeHtml(message)}</div>`);
    const pending = this.append('bot typing', '<div class="message-content"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>');

    try {
      const result = await api('/api/bot/test', {
        method: 'POST',
        body: {
          message,
          history: this.history,
          useWorkflow: this.useWorkflow.checked,
          state: this.workflowState || undefined,
          ...(this.asVerified.checked ? { asVerified: true, customer: this.customerFields() } : {})
        }
      });
      pending.remove();

      replySequence += 1;
      const replyId = String(replySequence);
      this.replies.set(replyId, { question: message, result });

      const reply = this.append('bot', botMessageHtml(result, replyId));
      if (Array.isArray(result.choices) && result.choices.length) {
        const choices = document.createElement('div');
        choices.className = 'bot-test-choices';
        choices.innerHTML = result.choices.map(choice => `
          <button type="button" class="btn btn-sm btn-outline-primary" data-choice="${escapeHtml(choice.label || choice.value)}">
            ${escapeHtml(choice.label || choice.value)}
          </button>`).join('');
        reply.appendChild(choices);
      }

      this.history.push({ role: 'user', content: message });
      this.history.push({ role: 'assistant', content: result.reply || '' });
      this.history = this.history.slice(-20);
      this.workflowState = result.state || null;
      markBotTested();
    } catch (error) {
      pending.remove();
      this.append('system', `<div class="message-content">${escapeHtml(errorMessage(error, 'The test could not run'))}</div>`);
    } finally {
      this.busy = false;
      this.input.focus();
    }
  }
}

const instances = new Map();

function mount(container) {
  if (!instances.has(container)) {
    instances.set(container, new BotTest(container));
  }
  return instances.get(container);
}

// ------------------------------------------------------------ saved tests

const EXPECT_COPY = {
  contains: {
    label: 'Mentions',
    help: 'A word or phrase a right answer always includes: a price, a time, "30 days".',
    describe: value => `Mentions "${value}"`
  },
  cites: {
    label: 'Source',
    help: 'Part of the source\'s title or address. Leave it empty to accept any of your sources.',
    describe: value => (value ? `Uses "${value}"` : 'Uses one of your sources')
  },
  handover: {
    label: '',
    help: '',
    describe: () => 'Hands over to a person, or offers one'
  }
};

let tests = [];
let testsLimit = 50;
let saveTestBound = false;

function saveTestElements() {
  return {
    modal: document.getElementById('saveTestModal'),
    form: document.getElementById('save-test-form'),
    id: document.getElementById('save-test-id'),
    question: document.getElementById('save-test-question'),
    type: document.getElementById('save-test-type'),
    valueGroup: document.getElementById('save-test-value-group'),
    valueLabel: document.getElementById('save-test-value-label'),
    value: document.getElementById('save-test-value'),
    help: document.getElementById('save-test-value-help'),
    error: document.getElementById('save-test-error'),
    submit: document.getElementById('save-test-submit'),
    title: document.getElementById('saveTestModalLabel')
  };
}

function showExpectField() {
  const el = saveTestElements();
  const copy = EXPECT_COPY[el.type.value] || EXPECT_COPY.contains;
  el.valueGroup.hidden = el.type.value === 'handover';
  el.valueLabel.textContent = copy.label;
  el.help.textContent = copy.help;
}

async function submitSaveTest(event) {
  event.preventDefault();
  const el = saveTestElements();
  const id = el.id.value;
  const body = {
    question: el.question.value.trim(),
    expect: { type: el.type.value, value: el.value.value.trim() }
  };

  el.error.textContent = '';
  setLoading(el.submit, true);
  try {
    await api(id ? `/api/bot/tests/${encodeURIComponent(id)}` : '/api/bot/tests', {
      method: id ? 'PUT' : 'POST',
      body
    });
    Modal.getOrCreateInstance(el.modal).hide();
    showToast(id ? 'Test updated' : 'Saved as a test. Run it any time from Test your bot.', 'success');
    document.dispatchEvent(new CustomEvent('bot-tests-changed'));
  } catch (error) {
    el.error.textContent = errorMessage(error, 'Could not save that test');
  } finally {
    setLoading(el.submit, false);
  }
}

/**
 * Open the save-a-test dialog, for a new test or to edit one.
 *
 * @param {{id?: string, question: string, expect: {type: string, value: string}}} test
 */
function openSaveTest(test) {
  const el = saveTestElements();
  if (!el.modal) {
    return;
  }
  if (!saveTestBound) {
    saveTestBound = true;
    el.type.addEventListener('change', showExpectField);
    el.form.addEventListener('submit', submitSaveTest);
  }

  el.title.textContent = test.id ? 'Edit test' : 'Save as a test';
  el.id.value = test.id || '';
  el.question.value = test.question || '';
  el.type.value = (test.expect && test.expect.type) || 'contains';
  el.value.value = (test.expect && test.expect.value) || '';
  el.error.textContent = '';
  showExpectField();

  Modal.getOrCreateInstance(el.modal).show();
  el.modal.addEventListener('shown.bs.modal', () => {
    (el.type.value !== 'handover' && !el.value.value ? el.value : el.question).focus();
  }, { once: true });
}

function describeExpectation(expect = {}) {
  const copy = EXPECT_COPY[expect.type];
  return copy ? copy.describe(expect.value || '') : 'Unknown';
}

function testHtml(test) {
  const run = test.lastRun;
  const verdict = !run
    ? '<span class="bot-test-verdict verdict-none" title="Not run yet">–</span>'
    : run.passed
      ? '<span class="bot-test-verdict verdict-pass" title="Passed">✓</span>'
      : '<span class="bot-test-verdict verdict-fail" title="Failed">✗</span>';

  return `
    <div class="bot-test-case" data-test-id="${escapeHtml(test.id)}">
      ${verdict}
      <div class="bot-test-case-body">
        <div class="fw-semibold small">${escapeHtml(test.question)}</div>
        <div class="small text-muted">${escapeHtml(describeExpectation(test.expect))}</div>
        ${run ? `
          <div class="small ${run.passed ? 'text-success' : 'text-danger'}">
            ${escapeHtml(run.reason || '')} <span class="text-muted">· ${escapeHtml(formatRelativeTime(run.at))}</span>
          </div>
          ${run.answer ? `
            <details class="small">
              <summary>Answer</summary>
              <div class="bot-test-case-answer">${escapeHtml(run.answer)}</div>
            </details>` : ''}` : ''}
      </div>
      <div class="btn-group btn-group-sm bot-test-case-actions">
        <button type="button" class="btn btn-outline-secondary" data-test-run title="Run this test">Run</button>
        <button type="button" class="btn btn-outline-secondary" data-test-edit title="Edit">Edit</button>
        <button type="button" class="btn btn-outline-danger" data-test-delete title="Delete">Delete</button>
      </div>
    </div>`;
}

function renderTests() {
  const list = document.getElementById('bot-tests-list');
  const summary = document.getElementById('bot-tests-summary');
  if (!list) {
    return;
  }

  const run = tests.filter(test => test.lastRun);
  const passing = run.filter(test => test.lastRun.passed).length;
  summary.textContent = !tests.length
    ? ''
    : run.length
      ? `${passing} of ${run.length} passing`
      : `${tests.length} test${tests.length === 1 ? '' : 's'}`;

  document.getElementById('bot-tests-run').disabled = tests.length === 0;
  document.getElementById('bot-tests-add').disabled = tests.length >= testsLimit;

  list.innerHTML = tests.length
    ? tests.map(testHtml).join('')
    : `<div class="text-muted small">
         No saved tests yet. Ask something on the left, then <strong>Save as a test</strong> under the answer.
       </div>`;
}

async function loadTests() {
  try {
    const data = await api('/api/bot/tests');
    tests = data.tests || [];
    testsLimit = data.limit || testsLimit;
    renderTests();
  } catch (error) {
    showToast(errorMessage(error, 'Could not load your saved tests'), 'danger');
  }
}

/** Put fresh results onto the tests on screen. */
function applyResults(results) {
  results.forEach(result => {
    const test = tests.find(candidate => candidate.id === result.id);
    if (test) {
      test.lastRun = {
        passed: result.passed, answer: result.answer, path: result.path, reason: result.reason, at: result.at
      };
    }
  });
  renderTests();
}

async function runAllTests() {
  const button = document.getElementById('bot-tests-run');
  setLoading(button, true);
  try {
    const result = await api('/api/bot/tests/run', { method: 'POST', body: {} });
    applyResults(result.results || []);
    showToast(`${result.passed} of ${result.total} test${result.total === 1 ? '' : 's'} passed`,
      result.failed ? 'warning' : 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not run your tests'), 'danger');
  } finally {
    setLoading(button, false);
    renderTests();
  }
}

async function onTestAction(event) {
  const row = event.target.closest('[data-test-id]');
  if (!row) {
    return;
  }
  const test = tests.find(candidate => candidate.id === row.dataset.testId);
  if (!test) {
    return;
  }

  const run = event.target.closest('[data-test-run]');
  if (run) {
    setLoading(run, true);
    try {
      applyResults([await api(`/api/bot/tests/${encodeURIComponent(test.id)}/run`, { method: 'POST' })]);
    } catch (error) {
      setLoading(run, false);
      showToast(errorMessage(error, 'Could not run that test'), 'danger');
    }
    return;
  }

  if (event.target.closest('[data-test-edit]')) {
    openSaveTest(test);
    return;
  }

  if (event.target.closest('[data-test-delete]')) {
    const ok = await confirmDialog({
      title: 'Delete this test?',
      message: `"${test.question}" will no longer be checked.`,
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) {
      return;
    }
    try {
      await api(`/api/bot/tests/${encodeURIComponent(test.id)}`, { method: 'DELETE' });
      tests = tests.filter(candidate => candidate.id !== test.id);
      renderTests();
    } catch (error) {
      showToast(errorMessage(error, 'Could not delete that test'), 'danger');
    }
  }
}

function setupTests() {
  document.getElementById('bot-tests-run').addEventListener('click', runAllTests);
  document.getElementById('bot-tests-add').addEventListener('click', () =>
    openSaveTest({ question: '', expect: { type: 'contains', value: '' } }));
  document.getElementById('bot-tests-list').addEventListener('click', onTestAction);
  // A test saved from the drawer, or results changed by teaching the bot.
  document.addEventListener('bot-tests-changed', loadTests);
}

/** Open the drawer from anywhere with a `data-open-bot-test` button. */
document.addEventListener('click', event => {
  if (!event.target.closest('[data-open-bot-test]')) {
    return;
  }
  const drawer = document.getElementById('botTestDrawer');
  const test = mount(drawer.querySelector('[data-bot-test]'));
  Offcanvas.getOrCreateInstance(drawer).show();
  drawer.addEventListener('shown.bs.offcanvas', () => test.input.focus(), { once: true });
});

registerSection('bot-test', {
  setup: setupTests,
  show() {
    const test = mount(document.querySelector('[data-bot-test="section"]'));
    loadTests();
    test.input.focus();
  }
});
