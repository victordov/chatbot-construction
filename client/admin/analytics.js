/**
 * Reports.
 *
 * At the top, what the bot is worth, on every plan. Below it the metrics a
 * support manager acts on: whether the bot is deflecting work, whether anyone
 * is being left unanswered, when cover is needed, and who is carrying the
 * load. One window for all of it, chosen with the 7/30/90 buttons.
 */

import { formatSeconds, initializeReportCharts, loadOverview, overviewData, resizeChartsIn } from './charts.js';
import { registerSection, showSection } from './nav.js';
import { state } from './state.js';
import { api, apiFetch, downloadFile, errorMessage, escapeHtml, logger, showToast } from './utils.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let currentRange = 7;
// A superadmin's chosen tenant; empty means every tenant together.
let currentCompany = '';

const UNAVAILABLE = '<span class="stat-unavailable">unavailable</span>';

function setStat(id, value, detail) {
  const valueEl = document.getElementById(id);
  const detailEl = document.getElementById(`${id}-detail`);
  if (valueEl) {
    valueEl.textContent = value;
  }
  if (detailEl) {
    detailEl.textContent = detail || '';
  }
}

/**
 * A metric the server could not compute. Said as such: a failure shown as 0%
 * is a lie that looks like a result.
 */
function setUnavailable(id) {
  const valueEl = document.getElementById(id);
  const detailEl = document.getElementById(`${id}-detail`);
  if (valueEl) {
    valueEl.className = 'stat-value';
    valueEl.innerHTML = UNAVAILABLE;
  }
  if (detailEl) {
    detailEl.textContent = 'could not be worked out just now';
  }
}

function query(extra = {}) {
  const params = new URLSearchParams({ days: String(currentRange), ...extra });
  if (currentCompany) {
    params.set('companyId', currentCompany);
  }
  return params.toString();
}

// ------------------------------------------------------------ value report

let valueDefinitions = null;

function renderValue(report) {
  const percent = report.resolutionRate === null ? '' : ` (${report.resolutionRate}%)`;

  setStat('value-resolved', report.botResolved.toLocaleString(),
    report.conversations
      ? `of ${report.conversations.toLocaleString()} conversations${percent}`
      : 'no conversations in this period');
  setStat('value-handed', report.handedOver.toLocaleString(), 'reached or asked for a person');
  setStat('value-hours', String(report.hoursSaved),
    `at ${report.minutesPerConversation} min a conversation`);
  setStat('value-cost',
    report.costPerResolution === null ? '—' : `$${report.costPerResolution.toFixed(2)}`,
    report.costPerResolution === null
      ? (report.monthlyPrice ? 'nothing resolved yet' : 'no plan price to divide')
      : 'your plan, per conversation resolved');
  setStat('value-ai', report.aiReplies.toLocaleString());

  const bot = report.csatBot && report.csatBot.rated ? `${report.csatBot.csat}%` : '—';
  const person = report.csatHuman && report.csatHuman.rated ? `${report.csatHuman.csat}%` : '—';
  setStat('value-csat', `${bot} / ${person}`,
    `${(report.csatBot && report.csatBot.rated) || 0} and ${(report.csatHuman && report.csatHuman.rated) || 0} ratings`);

  document.getElementById('value-title').textContent = `What the bot did, last ${report.days} days`;

  valueDefinitions = report.definition || {};
  const labels = {
    botResolved: 'Resolved by the bot',
    handedOver: 'Handed to a person',
    hoursSaved: 'Hours saved',
    costPerResolution: 'Cost per resolution',
    aiReplies: 'AI replies'
  };
  document.getElementById('value-definition-list').innerHTML = Object.entries(labels)
    .filter(([key]) => valueDefinitions[key])
    .map(([key, label]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(valueDefinitions[key])}</dd>`)
    .join('');

  const minutes = document.getElementById('value-minutes');
  if (minutes && document.activeElement !== minutes) {
    minutes.value = report.minutesPerConversation;
  }
}

async function loadValue() {
  try {
    renderValue(await api(`/api/admin/analytics/value?${query()}`));
  } catch (error) {
    logger.error('Failed to load the value report:', error);
    ['value-resolved', 'value-handed', 'value-hours', 'value-cost', 'value-ai', 'value-csat'].forEach(setUnavailable);
  }
}

async function saveMinutes() {
  const input = document.getElementById('value-minutes');
  const minutes = parseInt(input.value, 10);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
    showToast('Choose a whole number of minutes between 1 and 240', 'warning');
    return;
  }
  try {
    await api('/api/admin/analytics/settings', { method: 'PUT', body: { minutesPerConversation: minutes } });
    showToast('Saved. Hours saved now counts that many minutes a conversation.', 'success');
    loadValue();
  } catch (error) {
    showToast(errorMessage(error, 'Could not save the minutes'), 'danger');
  }
}

// ------------------------------------------------------- advanced metrics

function renderHeadline(data) {
  const missing = new Set(data.unavailable || []);

  if (data.deflection && !missing.has('deflection')) {
    setStat('stat-deflection', `${data.deflection.rate}%`,
      `${data.deflection.deflected} of ${data.deflection.eligible} handled by the bot alone` +
      (data.deflection.unmetHandoffs ? ` · ${data.deflection.unmetHandoffs} asked for a person and got nobody` : ''));
    setStat('stat-escalated', String(data.deflection.escalated), 'conversations a person joined');
  } else {
    setUnavailable('stat-deflection');
    setUnavailable('stat-escalated');
  }

  const abandonEl = document.getElementById('stat-abandoned');
  if (data.abandonment && !missing.has('abandonment')) {
    setStat('stat-abandoned', `${data.abandonment.rate}%`,
      `${data.abandonment.unanswered} of ${data.abandonment.total} never got a reply`);
    // Anything above one in twenty going unanswered is worth flagging rather
    // than leaving as a neutral number.
    if (abandonEl) {
      abandonEl.className = `stat-value ${data.abandonment.rate > 5 ? 'text-danger' : ''}`;
    }
  } else {
    setUnavailable('stat-abandoned');
  }

  if (data.satisfaction && !missing.has('satisfaction')) {
    renderSatisfaction(data.satisfaction);
  } else {
    setUnavailable('stat-csat');
  }

  if (data.tasks && !missing.has('tasks')) {
    setStat('stat-tasks', `${data.tasks.completionRate}%`,
      data.tasks.created
        ? `${data.tasks.completed} of ${data.tasks.created} closed` + (data.tasks.overdue ? ` · ${data.tasks.overdue} overdue` : '')
        : 'no tasks raised in this period');
  } else {
    setUnavailable('stat-tasks');
  }
}

/** Where a rating's conversation opens. */
function conversationLink(sessionId) {
  return `?section=active-chats&chat=${encodeURIComponent(sessionId)}`;
}

/**
 * Satisfaction.
 *
 * The headline number is the share of ratings that were 4 or 5, which is what
 * CSAT conventionally means — not the mean, which people routinely confuse it
 * with. The count is always shown beside it: 100% from two ratings and 100%
 * from two hundred should not look the same.
 */
function renderSatisfaction(csat, options = {}) {
  const panel = document.getElementById('csat-panel');

  if (!csat || !csat.rated) {
    // "No ratings yet" and "0% satisfied" mean very different things, so the
    // empty state says so rather than showing a zero.
    setStat('stat-csat', '—', csat && csat.asked
      ? `asked ${csat.asked}, none answered yet`
      : 'no ratings yet');

    if (panel) {
      panel.innerHTML = `
        <p class="text-muted mb-0">
          No ratings in this period. Visitors are asked once a conversation ends,
          if they sent more than one message.
        </p>`;
    }
    return;
  }

  setStat('stat-csat', `${csat.csat}%`,
    `${csat.rated} rating${csat.rated === 1 ? '' : 's'}` +
    (csat.responseRate !== null ? ` · ${csat.responseRate}% answered` : '') +
    ` · avg ${csat.average}`);

  const csatEl = document.getElementById('stat-csat');
  if (csatEl) {
    // Below 70% satisfied is a problem worth flagging — but only once there
    // are enough ratings for the number to mean anything. A single 3 is not
    // a satisfaction crisis, and colouring it red teaches people to ignore
    // the colour.
    const meaningful = csat.rated >= 10;
    csatEl.className = `stat-value ${meaningful && csat.csat < 70 ? 'text-danger' : ''}`;
  }

  const detailEl = document.getElementById('stat-csat-detail');
  if (detailEl && csat.rated < 10) {
    detailEl.textContent += ' · too few to read much into';
  }

  if (!panel) {
    return;
  }

  if (options.summaryOnly) {
    // On a plan without the advanced report we still have the distribution
    // and the headline; what is missing is the per-operator split and the
    // comments, and the panel says so rather than pretending there is
    // nothing to see.
    panel.innerHTML = `
      ${renderDistribution(csat.distribution)}
      <p class="small text-muted mt-3 mb-0">
        Who was rated, and what people wrote, are part of the advanced report
        on the Professional plan.
      </p>`;
    return;
  }

  const handler = csat.byHandler || {};
  const side = (label, stats) => `
    <div class="col-6">
      <div class="stat-label">${label}</div>
      <div class="fs-5">${stats && stats.rated ? `${stats.csat}%` : '—'}</div>
      <div class="small text-muted">${stats && stats.rated
    ? `${stats.rated} rating${stats.rated === 1 ? '' : 's'}`
    : 'not rated yet'}</div>
    </div>`;

  const comments = (csat.comments || []).slice(0, 5);

  panel.innerHTML = `
    ${renderDistribution(csat.distribution)}
    <div class="row g-2 mt-3 pt-3 border-top">
      ${side('Handled by the bot', handler.bot)}
      ${side('Handled by a person', handler.operator)}
    </div>
    ${(csat.byOperator || []).length ? `
      <div class="mt-3 pt-3 border-top">
        <div class="stat-label mb-2">By operator</div>
        <table class="table table-sm mb-0">
          <tbody>
            ${csat.byOperator.slice(0, 8).map(row => `
              <tr>
                <td>${escapeHtml(row.operator)}</td>
                <td class="text-end">${row.csat}%</td>
                <td class="text-end text-muted small">${row.rated}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}
    ${comments.length ? `
      <div class="mt-3 pt-3 border-top">
        <div class="stat-label mb-2">What people said</div>
        ${comments.map(row => `
          <div class="csat-comment">
            <span class="badge bg-${row.rating.score >= 4 ? 'success' : row.rating.score <= 2 ? 'danger' : 'secondary'}">${row.rating.score}</span>
            <span>${escapeHtml(row.rating.comment)}</span>
            ${row.sessionId ? `<a class="small ms-1 text-nowrap" href="${escapeHtml(conversationLink(row.sessionId))}"
               data-open-chat="${escapeHtml(row.sessionId)}">Read the conversation</a>` : ''}
          </div>`).join('')}
      </div>` : ''}`;
}

/**
 * The spread of scores.
 *
 * Shown rather than only an average, because "4.2" hides whether that is
 * everyone mildly content or half delighted and half furious — and those call
 * for very different responses.
 */
function renderDistribution(distribution) {
  const counts = distribution || [0, 0, 0, 0, 0];
  const most = Math.max(...counts, 1);

  return counts.map((count, index) => `
    <div class="csat-bar-row">
      <span class="csat-bar-label">${index + 1}</span>
      <span class="csat-bar-track">
        <span class="csat-bar-fill ${index + 1 >= 4 ? 'good' : index + 1 <= 2 ? 'bad' : ''}"
              style="width:${Math.round((count / most) * 100)}%"></span>
      </span>
      <span class="csat-bar-count">${count}</span>
    </div>`).reverse().join('');
}

/**
 * A 7x24 grid. Built from a flat list, so hours with no traffic simply have
 * no entry and render as empty.
 */
function renderHeatmap(peakHours, timezone) {
  const container = document.getElementById('peak-heatmap');
  if (!container) {
    return;
  }

  const note = document.getElementById('heatmap-note');
  if (note) {
    note.textContent = `Darker means busier, in ${timezone || 'UTC'} time. Use it to plan cover.`;
  }

  if (peakHours === null) {
    container.innerHTML = `<p class="mb-0">${UNAVAILABLE}</p>`;
    return;
  }

  if (!peakHours.length) {
    container.innerHTML = '<p class="text-muted mb-0">No conversations in this period yet.</p>';
    return;
  }

  const counts = new Map(peakHours.map(cell => [`${cell.day}-${cell.hour}`, cell.count]));
  const max = Math.max(...peakHours.map(cell => cell.count));

  // Hour labels every three hours; a label per hour is unreadable at this size.
  const header = ['<div class="heatmap-row heatmap-header"><span class="heatmap-day"></span>']
    .concat(Array.from({ length: 24 }, (_, hour) =>
      `<span class="heatmap-hour-label">${hour % 3 === 0 ? hour : ''}</span>`))
    .concat('</div>').join('');

  const rows = DAY_NAMES.map((name, day) => {
    const cells = Array.from({ length: 24 }, (_, hour) => {
      const count = counts.get(`${day}-${hour}`) || 0;
      // Square-root scaling: a linear ramp makes everything but the single
      // busiest hour look empty.
      const intensity = count ? Math.max(0.12, Math.sqrt(count / max)) : 0;
      return `<span class="heatmap-cell" style="--intensity: ${intensity.toFixed(3)}"
                    title="${escapeHtml(name)} ${hour}:00 — ${count} conversation${count === 1 ? '' : 's'}"></span>`;
    }).join('');

    return `<div class="heatmap-row"><span class="heatmap-day">${escapeHtml(name)}</span>${cells}</div>`;
  }).join('');

  container.innerHTML = header + rows;
}

function renderTopics(topics) {
  const container = document.getElementById('topic-cloud');
  if (!container) {
    return;
  }

  if (topics === null) {
    container.innerHTML = `<p class="mb-0">${UNAVAILABLE}</p>`;
    return;
  }

  if (!topics.length) {
    container.innerHTML = '<p class="text-muted mb-0">Not enough conversations in this period yet.</p>';
    return;
  }

  const max = topics[0].conversations;

  container.innerHTML = topics.map(topic => {
    // Size by frequency, but keep a floor so the tail stays readable.
    const scale = 0.85 + (topic.conversations / max) * 0.9;
    return `<span class="topic-tag" style="font-size: ${scale.toFixed(2)}rem"
                  title="${topic.conversations} conversation${topic.conversations === 1 ? '' : 's'}">
              ${escapeHtml(topic.term)}
              <span class="topic-count">${topic.conversations}</span>
            </span>`;
  }).join('');
}

function renderOperators(operators) {
  const table = document.getElementById('operator-performance-table');
  if (!table) {
    return;
  }

  if (operators === null) {
    table.innerHTML = `<tr><td colspan="5" class="text-center py-3">${UNAVAILABLE}</td></tr>`;
    return;
  }

  if (!operators.length) {
    table.innerHTML =
      '<tr><td colspan="5" class="text-muted text-center py-3">No conversations reached a person in this period.</td></tr>';
    return;
  }

  table.innerHTML = operators.map(operator => `
    <tr>
      <td>${escapeHtml(operator.operator)}</td>
      <td class="text-end">${operator.conversations}</td>
      <td class="text-end">${operator.replies}</td>
      <td class="text-end">${escapeHtml(formatSeconds(operator.medianResponseSeconds || null))}</td>
      <td class="text-end text-muted">${escapeHtml(formatSeconds(operator.avgResponseSeconds || null))}</td>
    </tr>`).join('');
}

function showLocked(locked) {
  const banner = document.getElementById('analytics-locked');
  const headline = document.getElementById('analytics-headline');
  if (banner) {
    banner.classList.toggle('d-none', !locked);
  }
  if (headline) {
    headline.classList.toggle('d-none', locked);
  }
}

async function loadAdvanced() {
  try {
    const response = await apiFetch(`/api/admin/analytics/advanced?${query()}`);

    if (response.status === 402) {
      // Not an error: the tenant's plan simply does not include this. The
      // satisfaction figures are not part of that gate — they come from the
      // basic endpoint, so they are rendered here regardless.
      showLocked(true);
      const overview = overviewData();
      renderSatisfaction(overview ? overview.satisfaction : null, { summaryOnly: true });
      renderHeatmap([], null);
      renderTopics([]);
      renderOperators([]);
      return;
    }

    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }

    const data = await response.json();
    showLocked(false);

    renderHeadline(data);
    renderHeatmap(data.peakHours, data.timezone);
    renderTopics(data.topics);
    renderOperators(data.operators);
  } catch (error) {
    logger.error('Failed to load advanced analytics:', error);
    renderHeatmap(null);
    renderTopics(null);
    renderOperators(null);
  }
}

async function load(days = currentRange) {
  currentRange = days;

  const label = document.getElementById('analytics-range-label');
  if (label) {
    label.textContent = `Last ${days} days${currentCompany ? '' : (state.currentUser && state.currentUser.role === 'superadmin' ? ' · every company together' : '')}`;
  }

  // The overview first: the plan-gated panel falls back to its satisfaction.
  await loadOverview({ days, companyId: currentCompany });
  resizeChartsIn('analytics-section');
  loadValue();
  loadAdvanced();
}

/** The tenant picker, for a superadmin. */
async function setupCompanyPicker() {
  const select = document.getElementById('analytics-company');
  if (!select || !state.currentUser || state.currentUser.role !== 'superadmin') {
    return;
  }

  select.classList.remove('d-none');
  try {
    const { companies } = await api('/api/companies');
    select.innerHTML = '<option value="">All companies</option>' + companies.map(company =>
      `<option value="${escapeHtml(company._id)}">${escapeHtml(company.name)}</option>`).join('');
  } catch (error) {
    logger.warn('Could not list companies for the report picker', error);
  }

  select.addEventListener('change', () => {
    currentCompany = select.value;
    load();
  });
}

function setupAnalytics() {
  const section = document.getElementById('analytics-section');

  section.querySelectorAll('[data-range]').forEach(button => {
    button.addEventListener('click', () => {
      section.querySelectorAll('[data-range]').forEach(other => other.classList.remove('active'));
      button.classList.add('active');
      load(parseInt(button.dataset.range, 10));
    });
  });

  document.getElementById('value-minutes-save')?.addEventListener('click', saveMinutes);

  // A rating comment opens its conversation in the inbox, in this tab.
  document.getElementById('csat-panel').addEventListener('click', event => {
    const link = event.target.closest('[data-open-chat]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    showSection('active-chats', { params: { chat: link.dataset.openChat } });
  });

  document.getElementById('value-export').addEventListener('click', async () => {
    try {
      await downloadFile(`/api/admin/analytics/value/export?${query()}`,
        `bot-value-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (error) {
      showToast('Could not export the report', 'danger');
    }
  });

  initializeReportCharts();
  setupCompanyPicker();
}

registerSection('analytics', {
  setup: setupAnalytics,
  show: () => {
    resizeChartsIn('analytics-section');
    load();
  }
});
