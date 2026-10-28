/**
 * The charts on Reports, and the overview numbers on Home.
 *
 * One request fills both, for one window: the range buttons on Reports move
 * every number and chart together, and each title says which window it is.
 */

import Chart from 'chart.js/auto';
import { api, logger } from './utils.js';

let chatActivityChart;
let chatVolumeChart;
let responseTimeChart;
let topSourcesChart;

/**
 * Chart.js infers its scale from the data, so an all-zero series produced a
 * -1.0 to 1.0 axis that looked like a rendering fault rather than "no data
 * yet". Pinning the axis to zero with a small suggested maximum keeps an empty
 * chart legible.
 *
 * Returns a fresh object per call rather than a shared constant: Chart.js
 * mutates the options object it is handed, so several charts sharing one
 * object corrupt each other's scale state and silently stop drawing their
 * datasets.
 */
function chartBaseOptions() {
  return {
    responsive: true,
    maintainAspectRatio: true,
    aspectRatio: 2,
    interaction: { mode: 'index', intersect: false },
    scales: {
      y: {
        beginAtZero: true,
        suggestedMax: 5,
        ticks: {
          // Conversation counts are whole numbers; fractional ticks are noise.
          precision: 0
        }
      }
    }
  };
}

/**
 * The most recent analytics payload, kept so charts built later (when their
 * section is first opened) can be populated without another request.
 */
let lastAnalyticsData = null;

/** A day key (`2026-10-22`) as a short label in the reader's own words. */
function dayLabel(day) {
  const [year, month, date] = String(day).split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Say "nothing yet" over an empty chart. An empty axis is indistinguishable
 * from a broken one, and a reader should not have to guess which.
 */
function setEmpty(canvas, empty, text) {
  if (!canvas) {
    return;
  }
  let label = canvas.parentElement.querySelector('.chart-empty-state');
  if (empty) {
    if (!label) {
      label = document.createElement('p');
      label.className = 'chart-empty-state text-muted text-center mb-0 py-4';
      canvas.parentElement.appendChild(label);
    }
    label.textContent = text;
    canvas.style.display = 'none';
    return;
  }
  if (label) {
    label.remove();
  }
  canvas.style.display = '';
}

/**
 * Build the charts that live in the Analytics section.
 *
 * Deferred until the section is actually shown. Chart.js measures its canvas
 * at construction, and a canvas inside a `display: none` section measures
 * zero; it then pins that zero with inline styles and never recovers, so the
 * axes render but the data never appears. Building on first view side-steps
 * the whole problem rather than trying to repair it afterwards.
 */
function initializeTrendCharts() {
  if (chatVolumeChart) {
    return;
  }

  const volumeCanvas = document.getElementById('chat-volume-chart');
  const responseCanvas = document.getElementById('response-time-chart');
  if (!volumeCanvas || !responseCanvas) {
    return;
  }

  const stacked = chartBaseOptions();
  stacked.scales.x = { stacked: true };
  stacked.scales.y.stacked = true;

  chatVolumeChart = new Chart(volumeCanvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'The bot alone', data: [], backgroundColor: '#20c997' },
        { label: 'Reached a person', data: [], backgroundColor: '#0d6efd' }
      ]
    },
    options: stacked
  });

  responseTimeChart = new Chart(responseCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'First response from a person (seconds)', data: [],
        borderColor: '#28a745', tension: 0.1, fill: false, spanGaps: true
      }]
    },
    options: chartBaseOptions()
  });

  if (lastAnalyticsData) {
    applyTrends(lastAnalyticsData);
  }
}

function initializeOverviewCharts() {
  if (chatActivityChart) {
    return;
  }

  const activityCanvas = document.getElementById('chat-activity-chart');
  const sourcesCanvas = document.getElementById('topics-chart');
  if (!activityCanvas || !sourcesCanvas) {
    return;
  }

  chatActivityChart = new Chart(activityCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Conversations',
        data: [],
        borderColor: '#007bff',
        tension: 0.1,
        fill: false
      }]
    },
    options: chartBaseOptions()
  });

  // Traffic sources. This slot used to hold a "Common Topics" doughnut with
  // four hardcoded categories (Properties/Mortgages/Payments/Other) that
  // nothing ever populated, so it permanently displayed an empty ring.
  topSourcesChart = new Chart(sourcesCanvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: [],
      datasets: [{
        data: [],
        backgroundColor: ['#0d6efd', '#20c997', '#fd7e14', '#6f42c1', '#dc3545', '#6c757d']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      plugins: { legend: { position: 'right' } }
    }
  });

  if (lastAnalyticsData) {
    applyOverviewCharts(lastAnalyticsData);
  }
}

function applyOverviewCharts(data) {
  const perDay = data.chatVolumePerDay || [];

  if (chatActivityChart) {
    const empty = perDay.every(day => !day.count);
    setEmpty(document.getElementById('chat-activity-chart'), empty, 'No conversations in this period.');
    chatActivityChart.data.labels = perDay.map(day => dayLabel(day.date));
    chatActivityChart.data.datasets[0].data = perDay.map(day => day.count);
    chatActivityChart.update();
  }

  if (topSourcesChart) {
    const sources = data.topSources || [];
    setEmpty(document.getElementById('topics-chart'), sources.length === 0,
      'No conversations in this period. Once the widget is on your site, this shows which pages they start on.');
    topSourcesChart.data.labels = sources.map(source => source.label);
    topSourcesChart.data.datasets[0].data = sources.map(source => source.count);
    topSourcesChart.update();
  }
}

function applyTrends(data) {
  const perDay = data.chatVolumePerDay || [];
  const responses = data.firstResponseOverTime || [];

  if (chatVolumeChart) {
    setEmpty(document.getElementById('chat-volume-chart'), perDay.every(day => !day.count),
      'No conversations in this period.');
    chatVolumeChart.data.labels = perDay.map(day => dayLabel(day.date));
    chatVolumeChart.data.datasets[0].data = perDay.map(day => day.botOnly);
    chatVolumeChart.data.datasets[1].data = perDay.map(day => day.reachedPerson);
    chatVolumeChart.update();
  }

  if (responseTimeChart) {
    setEmpty(document.getElementById('response-time-chart'), responses.every(day => day.avgSeconds === null),
      'Nobody asked for a person in this period, or nobody has replied yet.');
    responseTimeChart.data.labels = responses.map(day => dayLabel(day.date));
    responseTimeChart.data.datasets[0].data = responses.map(day => day.avgSeconds);
    responseTimeChart.update();
  }
}

/** A change between periods; "new" when there was nothing to compare with. */
function formatChange(value) {
  if (value === null || value === undefined) {
    return 'new';
  }
  return `${value > 0 ? '+' : ''}${value}%`;
}

function updateConversationMetrics(data) {
  const metrics = data.conversationMetrics;
  if (!metrics || !document.getElementById('conv-total-current')) {
    return;
  }

  const days = data.range ? data.range.days : 7;
  const set = (id, value) => {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = value;
    }
  };

  set('conv-col-current', `Last ${days} days`);
  set('conv-col-previous', `The ${days} days before`);

  const current = metrics.current || {};
  const previous = metrics.previous || {};
  const change = metrics.change || {};

  set('conv-total-current', current.total || 0);
  set('conv-total-previous', previous.total || 0);
  set('conv-total-change', formatChange(change.total));
  set('conv-duration-current', `${current.avgDurationMinutes || 0} min`);
  set('conv-duration-previous', `${previous.avgDurationMinutes || 0} min`);
  set('conv-duration-change', formatChange(change.duration));
  set('conv-msgs-current', current.avgMessages || 0);
  set('conv-msgs-previous', previous.avgMessages || 0);
  set('conv-msgs-change', formatChange(change.messages));
}

/** Seconds as something a person reads at a glance. */
export function formatSeconds(seconds) {
  if (seconds === null || seconds === undefined) {
    return '—';
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * The headline numbers and chart data for one window, from one request.
 * Home shows the numbers; Reports' charts are filled in whenever they exist.
 *
 * @param {object} [options]
 * @param {number} [options.days=7]
 * @param {string} [options.companyId] a superadmin's chosen tenant
 */
export async function loadOverview({ days = 7, companyId = '' } = {}) {
  try {
    const query = new URLSearchParams({ days: String(days) });
    if (companyId) {
      query.set('companyId', companyId);
    }
    const data = await api(`/api/admin/analytics?${query.toString()}`);
    lastAnalyticsData = data;

    const set = (id, value) => {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = value;
      }
    };
    set('total-chats-today', data.totalChatsToday || '0');
    set('home-waiting-count', data.waitingForPerson || '0');
    set('avg-response-time', formatSeconds(data.avgFirstResponseSeconds));
    set('avg-response-detail', data.firstResponseCount
      ? `average over ${data.firstResponseCount} conversation${data.firstResponseCount === 1 ? '' : 's'}, last ${days} days`
      : `nobody asked for a person in the last ${days} days`);
    set('chart-activity-title', `Conversations, last ${days} days`);

    applyOverviewCharts(data);
    applyTrends(data);
    updateConversationMetrics(data);
    return data;
  } catch (error) {
    logger.error('Error loading the overview:', error);
    return null;
  }
}

/**
 * Build Reports' charts. Deferred until the section is first shown: Chart.js
 * measures its canvas at construction, and a canvas in a hidden section
 * measures zero and never recovers.
 */
export function initializeReportCharts() {
  initializeOverviewCharts();
  initializeTrendCharts();
  if (lastAnalyticsData) {
    updateConversationMetrics(lastAnalyticsData);
  }
}

/** The last overview payload, for Reports' satisfaction card. */
export function overviewData() {
  return lastAnalyticsData;
}

/**
 * Re-measure any charts inside a section that has just become visible.
 *
 * Chart.js sizes a canvas when the chart is constructed. Sections other than
 * the one open at page load are `display: none`, so their canvases measure
 * zero and the chart draws nothing - the axes and labels appear, but the
 * datasets are invisible. Chart.js does not re-measure on its own when the
 * element later becomes visible, so we ask it to.
 */
export function resizeChartsIn(sectionId) {
  if (typeof Chart === 'undefined') {
    return;
  }

  const section = document.getElementById(sectionId);
  if (!section) {
    return;
  }

  // Two frames: one for the browser to apply the display change and lay the
  // section out, one for the canvas to have its final size.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    section.querySelectorAll('canvas').forEach(canvas => {
      const chart = Chart.getChart ? Chart.getChart(canvas) : null;
      if (!chart) {
        return;
      }

      // Chart.js wrote `width: 0px; height: 0px` inline from its initial
      // measurement of a hidden canvas. resize() re-reads those styles, so
      // without clearing them it measures zero again - the chart stays blank
      // permanently. Clearing lets it size from the container.
      canvas.style.width = '';
      canvas.style.height = '';
      chart.resize();
    });
  }));
}
