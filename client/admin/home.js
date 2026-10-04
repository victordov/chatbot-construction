/**
 * Home: what to do next, and how things stand.
 *
 * A new admin used to land on three zeros and two empty charts, and had to
 * discover on their own that going live meant visiting four screens in a
 * particular order. The checklist names those steps, ticks them off from what
 * the account actually contains, and opens the screen for each.
 */

import { loadOverview } from './charts.js';
import { registerSection } from './nav.js';
import { state } from './state.js';
import { api, escapeHtml, logger } from './utils.js';

const TESTED_KEY = 'bot-tested';
const DISMISSED_KEY = 'setup-dismissed';

function companyKey(base) {
  const company = state.currentUser && state.currentUser.company;
  const id = company && (company._id || company.id || company);
  return `${base}:${id || 'none'}`;
}

function readFlag(base) {
  try {
    return localStorage.getItem(companyKey(base)) === '1';
  } catch (error) {
    return false;
  }
}

function writeFlag(base) {
  try {
    localStorage.setItem(companyKey(base), '1');
  } catch (error) {
    // The step simply shows as not done on the next visit.
  }
}

/** Called by Test your bot once it has had an answer. */
export function markBotTested() {
  writeFlag(TESTED_KEY);
}

function steps(status) {
  return [
    {
      done: status.knowledgeSources > 0,
      title: 'Teach your bot',
      detail: status.knowledgeSources > 0
        ? `${status.knowledgeSources} source${status.knowledgeSources === 1 ? '' : 's'} added.`
        : 'Point it at your website, or upload your FAQ, price list or policies.',
      section: 'knowledge',
      action: 'Add knowledge'
    },
    {
      done: Boolean(status.persona),
      title: 'Give it a voice',
      detail: 'Say who it works for, how it should sound, and what it must never guess at.',
      section: 'assistant',
      action: 'Write the persona'
    },
    {
      done: readFlag(TESTED_KEY),
      title: 'Try it',
      detail: 'Ask what a customer would ask, and check where each answer came from.',
      section: 'bot-test',
      action: 'Test your bot'
    },
    {
      done: status.allowedDomains > 0,
      title: 'Add your website',
      detail: 'The widget only answers on the sites you list, so nobody can borrow it.',
      section: 'widget',
      action: 'Add your domain'
    },
    {
      done: Boolean(status.widgetSeen),
      title: 'Install the widget',
      detail: status.widgetSeen
        ? 'Conversations are arriving.'
        : 'Paste one line before </body> on your site. Done when the first conversation arrives.',
      section: 'widget',
      action: 'Get the snippet'
    }
  ];
}

function render(status) {
  const card = document.getElementById('setup-checklist');
  const list = steps(status);
  const done = list.filter(step => step.done).length;

  if (readFlag(DISMISSED_KEY)) {
    card.classList.add('d-none');
    return;
  }

  // The first step not yet done is the one to do next.
  const next = list.findIndex(step => !step.done);

  document.getElementById('setup-steps').innerHTML = list.map((step, index) => `
    <li class="setup-step ${step.done ? 'is-done' : ''} ${index === next ? 'is-next' : ''}">
      <span class="setup-step-mark" aria-hidden="true">${step.done ? '✓' : index + 1}</span>
      <div class="setup-step-text">
        <div class="fw-semibold">${escapeHtml(step.title)}${step.done ? '<span class="visually-hidden"> (done)</span>' : ''}</div>
        <div class="small text-muted">${escapeHtml(step.detail)}</div>
      </div>
      <a class="btn btn-sm ${index === next ? 'btn-primary' : 'btn-outline-secondary'}"
         href="?section=${step.section}" data-section-link="${step.section}">${escapeHtml(step.action)}</a>
    </li>`).join('');

  document.getElementById('setup-progress-label').textContent = `${done} of ${list.length} done`;
  document.getElementById('setup-progress-bar').style.width = `${Math.round((done / list.length) * 100)}%`;
  document.getElementById('setup-dismiss').classList.toggle('d-none', done < list.length);
  card.classList.remove('d-none');
}

async function loadChecklist() {
  if (!state.currentUser || state.currentUser.role !== 'company_admin') {
    return;
  }
  try {
    render(await api('/api/companies/me/setup'));
  } catch (error) {
    logger.warn('Could not load setup status', error);
  }
}

function setupHome() {
  document.getElementById('setup-dismiss').addEventListener('click', () => {
    writeFlag(DISMISSED_KEY);
    document.getElementById('setup-checklist').classList.add('d-none');
  });
}

registerSection('home', {
  setup: setupHome,
  show: () => {
    loadChecklist();
    loadOverview();
  }
});
