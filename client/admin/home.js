/**
 * Home: what to do next, and how things stand.
 *
 * A new admin used to land on three zeros and two empty charts, and had to
 * discover on their own that going live meant visiting four screens in a
 * particular order. The checklist names those steps, ticks them off from what
 * the account actually contains, and opens the screen for each. Below it, the
 * cards say what the bot is worth, what it could not answer, how close the
 * plan is to a limit, and who is here to help.
 */

import { loadOverview } from './charts.js';
import { refreshPlanStatus } from './core.js';
import { registerSection } from './nav.js';
import { state } from './state.js';
import { api, escapeHtml, formatRelativeTime, getUrlParams, logger } from './utils.js';

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

/**
 * Called by Test your bot once it has had an answer. The server records it
 * too (`onboarding.botTestedAt`), which is what the checklist reads; this
 * local flag only covers the moment between the test and the next load.
 */
export function markBotTested() {
  writeFlag(TESTED_KEY);
}

function installedDetail(status) {
  if (status.widgetSeenAt) {
    const where = status.widgetOrigin ? status.widgetOrigin.replace(/^https?:\/\//, '') : 'your site';
    return `Seen on ${where}, ${formatRelativeTime(status.widgetSeenAt)}.`;
  }
  if (status.widgetSeen) {
    return 'Conversations are arriving.';
  }
  return 'Paste one line before </body> on your site. Done when the widget first loads there.';
}

function steps(status) {
  const domains = Array.isArray(status.allowedDomains) ? status.allowedDomains.length : Number(status.allowedDomains) || 0;
  const tested = Boolean(status.botTested) || readFlag(TESTED_KEY);

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
      done: tested,
      title: 'Try it',
      detail: tested && status.botTestedAt
        ? `Tried ${formatRelativeTime(status.botTestedAt)}.`
        : 'Ask what a customer would ask, and check where each answer came from.',
      section: 'bot-test',
      action: 'Test your bot'
    },
    {
      done: domains > 0,
      title: 'Add your website',
      detail: domains > 0
        ? `${domains} site${domains === 1 ? '' : 's'} allowed.`
        : 'The widget only answers on the sites you list, so nobody can borrow it.',
      section: 'widget',
      action: 'Add your domain'
    },
    {
      done: Boolean(status.widgetSeen),
      title: 'Install the widget',
      detail: installedDetail(status),
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

// ------------------------------------------------------------------ cards

function setBody(id, html) {
  const element = document.getElementById(id);
  if (element) {
    element.innerHTML = html;
  }
}

async function loadValueCard() {
  try {
    const report = await api('/api/admin/analytics/value?days=30');
    if (!report.conversations) {
      setBody('home-value-body', '<p class="text-muted small mb-0">No conversations yet. Once people start chatting, this shows how many the bot resolved on its own.</p>');
      return;
    }
    setBody('home-value-body', `
      <div class="home-figure">${report.botResolved.toLocaleString()}
        <span class="fs-6 fw-normal text-muted">resolved</span></div>
      <div class="small text-muted">
        ${report.resolutionRate}% of ${report.conversations.toLocaleString()} conversations,
        about ${escapeHtml(String(report.hoursSaved))} hours of somebody's time.
      </div>`);
  } catch (error) {
    setBody('home-value-body', '<p class="text-muted small mb-0">Could not load this just now.</p>');
  }
}

/**
 * The questions the bot could not answer this week, from the unanswered
 * questions list. That list may not exist on an older server, so a 404 is
 * "nothing to show" rather than an error.
 */
async function loadGapsCard() {
  try {
    const { groups = [], total = 0 } = await api('/api/bot/gaps?days=7&limit=3');
    if (!groups.length) {
      setBody('home-gaps-body', '<p class="text-muted small mb-0">Nothing this week. Every question had an answer.</p>');
      return;
    }
    setBody('home-gaps-body', `
      <div class="home-figure">${Number(total).toLocaleString()}
        <span class="fs-6 fw-normal text-muted">this week</span></div>
      <ul>${groups.map(group => `
        <li>${escapeHtml(group.question)}${group.count > 1 ? ` <span class="text-muted">×${group.count}</span>` : ''}</li>`).join('')}
      </ul>`);
  } catch (error) {
    setBody('home-gaps-body', error.status === 404
      ? '<p class="text-muted small mb-0">Not available yet.</p>'
      : '<p class="text-muted small mb-0">Could not load this just now.</p>');
  }
}

async function loadUsageCard() {
  const status = await refreshPlanStatus();
  if (!status) {
    setBody('home-usage-body', '<p class="text-muted small mb-0">Could not load your plan just now.</p>');
    return;
  }

  if (status.status === 'trial_expired') {
    setBody('home-usage-body', '<div class="text-danger fw-semibold">Your trial has ended.</div><p class="small mb-0">The bot has stopped answering until you choose a plan.</p>');
    return;
  }

  const trial = status.status === 'trialing' && status.trialEndsAt
    ? Math.ceil((new Date(status.trialEndsAt) - Date.now()) / 86400000)
    : null;
  const head = `<div class="fw-semibold">${escapeHtml(status.planName)}${trial !== null && trial > 0
    ? ` <span class="text-muted fw-normal small">· ${trial} day${trial === 1 ? '' : 's'} of trial left</span>` : ''}</div>`;

  if (!status.warnings.length) {
    setBody('home-usage-body', `${head}<p class="small text-muted mb-0">Comfortably inside every limit.</p>`);
    return;
  }

  setBody('home-usage-body', `${head}<ul>${status.warnings.map(warning => `
    <li class="${warning.percent >= 100 ? 'text-danger' : ''}">
      ${escapeHtml(warning.label)}: ${warning.percent}%
      <span class="text-muted">(${Number(warning.used).toLocaleString()} of ${Number(warning.limit).toLocaleString()})</span>
    </li>`).join('')}</ul>`);
}

async function loadOnlineCard() {
  try {
    const { online } = await api('/api/admin/operators/online');
    if (!online.length) {
      setBody('home-online-body', '<p class="text-muted small mb-0">Nobody is signed in to answer right now. Visitors who ask for a person are offered to leave their email.</p>');
      return;
    }
    setBody('home-online-body', `<ul class="list-unstyled ps-0">${online.map(person => `
      <li>
        <span class="online-dot ${person.acceptingChats ? '' : 'is-away'}" aria-hidden="true"></span>
        ${escapeHtml(person.name)}
        <span class="text-muted small">${person.acceptingChats
    ? `· ${person.chats} chat${person.chats === 1 ? '' : 's'}`
    : '· not taking chats'}</span>
      </li>`).join('')}</ul>`);
  } catch (error) {
    setBody('home-online-body', '<p class="text-muted small mb-0">Could not load this just now.</p>');
  }
}

function loadCards() {
  if (!state.currentUser || state.currentUser.role !== 'company_admin') {
    return;
  }
  loadValueCard();
  loadGapsCard();
  loadUsageCard();
  loadOnlineCard();
}

/** After sign-up or an accepted invitation, a word about what happens next. */
function showWelcome() {
  const params = getUrlParams();
  const banner = document.getElementById('home-welcome');
  if (!banner || !params.welcome) {
    return;
  }
  document.getElementById('home-welcome-text').textContent = params.crawling
    ? 'We are reading your website now, so your bot will know something within a few minutes. The steps below get it live.'
    : (state.currentUser && state.currentUser.role === 'company_admin'
      ? 'The steps below get your assistant live.'
      : 'Conversations that need a person appear under Live chats.');
  banner.classList.remove('d-none');
}

function setupHome() {
  document.getElementById('setup-dismiss').addEventListener('click', () => {
    writeFlag(DISMISSED_KEY);
    document.getElementById('setup-checklist').classList.add('d-none');
  });
  showWelcome();
}

registerSection('home', {
  setup: setupHome,
  show: () => {
    loadChecklist();
    loadOverview({ days: 7 });
    loadCards();
  }
});
