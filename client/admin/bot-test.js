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
 */

import { Offcanvas } from 'bootstrap';
import { markBotTested } from './home.js';
import { registerSection } from './nav.js';
import { api, errorMessage, escapeHtml, safeHref } from './utils.js';

const PATH_LABELS = {
  workflow: 'Your live workflow',
  assistant: 'Assistant, from your knowledge',
  canned: 'A canned reply',
  fallback: 'Fallback'
};

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

function sourcesHtml(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return '';
  }
  return `
    <div class="bot-test-meta">
      <span class="text-muted">From:</span>
      ${sources.map(source => {
    const href = source.url ? safeHref(source.url) : null;
    const title = escapeHtml(source.title || source.url || 'a source');
    return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>` : `<span>${title}</span>`;
  }).join(', ')}
    </div>`;
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

function botMessageHtml(result) {
  const tools = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  return `
    <div class="message-content">${escapeHtml(result.reply || '(no reply)')}</div>
    ${cardsHtml(result.cards)}
    <div class="bot-test-meta">
      <span class="badge text-bg-light border">${escapeHtml(PATH_LABELS[result.path] || result.path || 'Assistant')}</span>
      ${result.escalate && result.escalate.enabled !== false ? '<span class="badge text-bg-warning">Would hand over to a person</span>' : ''}
    </div>
    ${sourcesHtml(result.sources)}
    ${tools.length ? `
      <div class="bot-test-meta">
        ${tools.map(call => `<span class="text-muted">Action <code>${escapeHtml(call.name)}</code> ${escapeHtml(TOOL_STATUS[call.status] || call.status)}</span>`).join('<br>')}
      </div>` : ''}
    ${result.warning ? `<div class="alert alert-warning py-1 px-2 small mt-2 mb-0">${escapeHtml(result.warning)} - the bot can only use scripted replies.</div>` : ''}`;
}

/**
 * One test conversation, in one container.
 */
class BotTest {
  constructor(container) {
    this.container = container;
    this.history = [];
    this.workflowState = null;
    this.busy = false;
    this.render();
  }

  render() {
    const id = `bot-test-${this.container.dataset.botTest}`;
    this.container.innerHTML = `
      <div class="bot-test-toolbar">
        <div class="form-check form-switch mb-0">
          <input class="form-check-input" type="checkbox" id="${id}-workflow" checked>
          <label class="form-check-label small" for="${id}-workflow">Use your live workflow, if you have one</label>
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary" data-bot-test-reset>Start again</button>
      </div>
      <div class="bot-test-log chat-messages" aria-live="polite">
        <div class="empty-state">
          <p class="mb-1">Ask what a customer would ask.</p>
          <p class="small text-muted mb-0">Try something your material covers, something it does not, and "can I talk to a person?".</p>
        </div>
      </div>
      <form class="bot-test-form" novalidate>
        <label class="visually-hidden" for="${id}-input">Message</label>
        <input type="text" class="form-control" id="${id}-input" placeholder="Type a customer's question…" autocomplete="off">
        <button type="submit" class="btn btn-primary">Send</button>
      </form>`;

    this.log = this.container.querySelector('.bot-test-log');
    this.input = this.container.querySelector('input[type="text"]');
    this.useWorkflow = this.container.querySelector('input[type="checkbox"]');

    this.container.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      this.send(this.input.value);
    });
    this.container.querySelector('[data-bot-test-reset]').addEventListener('click', () => this.reset());
    this.useWorkflow.addEventListener('change', () => this.reset());

    // Choice buttons from a workflow answer as if the customer had tapped them.
    this.log.addEventListener('click', event => {
      const choice = event.target.closest('[data-choice]');
      if (choice && !this.busy) {
        this.send(choice.dataset.choice);
      }
    });
  }

  reset() {
    this.history = [];
    this.workflowState = null;
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
          state: this.workflowState || undefined
        }
      });
      pending.remove();

      const reply = this.append('bot', botMessageHtml(result));
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
  show() {
    const test = mount(document.querySelector('[data-bot-test="section"]'));
    test.input.focus();
  }
});
