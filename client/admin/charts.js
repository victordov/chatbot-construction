/**
 * The charts on Reports, and the overview numbers on Home.
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

  chatVolumeChart = new Chart(volumeCanvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{ label: 'Number of Chats', data: [], backgroundColor: '#0d6efd' }]
    },
    options: chartBaseOptions()
  });

  responseTimeChart = new Chart(responseCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Response Time (seconds)', data: [],
        borderColor: '#28a745', tension: 0.1, fill: false
      }]
    },
    options: chartBaseOptions()
  });

  // Apply whatever the dashboard already fetched.
  if (lastAnalyticsData) {
    if (lastAnalyticsData.chatVolumeOverTime) {
      updateChatVolumeChart(lastAnalyticsData.chatVolumeOverTime);
    }
    if (lastAnalyticsData.responseTimeOverTime) {
      updateResponseTimeChart(lastAnalyticsData.responseTimeOverTime);
    }
  }
}

function initializeOverviewCharts() {
  if (chatActivityChart) {
    return;
  }

  const activityCtx = document.getElementById('chat-activity-chart').getContext('2d');
  chatActivityChart = new Chart(activityCtx, {
    type: 'line',
    data: {
      labels: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'],
      datasets: [{
        label: 'Number of Chats',
        data: [0, 0, 0, 0, 0, 0, 0],
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
  const sourcesCtx = document.getElementById('topics-chart').getContext('2d');
  topSourcesChart = new Chart(sourcesCtx, {
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
    if (lastAnalyticsData.chatVolumePerDay) {
      updateChatActivityChart(lastAnalyticsData.chatVolumePerDay);
    }
    updateTopSourcesChart(lastAnalyticsData.topSources);
  }
}

// Update the Response Time chart using analytics data
function updateResponseTimeChart(rtData) {
  if (!responseTimeChart) {
    return;
  }

  const labels = [];
  const dataPoints = [];

  if (Array.isArray(rtData)) {
    rtData.forEach(record => {
      const date = new Date(record._id.year, record._id.month - 1);
      const label = date.toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric'
      });
      labels.push(label);
      dataPoints.push(record.avg);
    });
  }

  responseTimeChart.data.labels = labels;
  responseTimeChart.data.datasets[0].data = dataPoints;
  responseTimeChart.update();
}

// Update the Chat Activity chart using analytics data
function updateChatActivityChart(volumeData) {
  if (!chatActivityChart) {
    return;
  }

  const labels = [];
  const dataPoints = [];
  const today = new Date();

  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);

    const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    labels.push(label);

    const record = volumeData.find(v =>
      v._id.year === date.getFullYear() &&
      v._id.month === date.getMonth() + 1 &&
      v._id.day === date.getDate()
    );

    dataPoints.push(record ? record.count : 0);
  }

  chatActivityChart.data.labels = labels;
  chatActivityChart.data.datasets[0].data = dataPoints;
  chatActivityChart.update();
}

// Update the Chat Volume chart using analytics data
function updateChatVolumeChart(volumeData) {
  if (!chatVolumeChart) {
    return;
  }

  const labels = [];
  const dataPoints = [];

  if (Array.isArray(volumeData)) {
    volumeData.forEach(record => {
      const date = new Date(record._id.year, record._id.month - 1);
      const label = date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      labels.push(label);
      dataPoints.push(record.count);
    });
  }

  chatVolumeChart.data.labels = labels;
  chatVolumeChart.data.datasets[0].data = dataPoints;
  chatVolumeChart.update();
}

// Update the traffic-sources doughnut
function updateTopSourcesChart(sources) {
  if (!topSourcesChart) {
    return;
  }

  const canvas = document.getElementById('topics-chart');
  const empty = !Array.isArray(sources) || sources.length === 0;

  // An empty doughnut is indistinguishable from a broken one, so say so.
  let emptyLabel = canvas.parentElement.querySelector('.chart-empty-state');
  if (empty) {
    if (!emptyLabel) {
      emptyLabel = document.createElement('p');
      emptyLabel.className = 'chart-empty-state text-muted text-center mb-0 py-4';
      emptyLabel.textContent = 'No conversations yet - install the widget to start collecting data.';
      canvas.parentElement.appendChild(emptyLabel);
    }
    canvas.style.display = 'none';
    return;
  }

  if (emptyLabel) {
    emptyLabel.remove();
  }
  canvas.style.display = '';

  topSourcesChart.data.labels = sources.map(s => s.label);
  topSourcesChart.data.datasets[0].data = sources.map(s => s.count);
  topSourcesChart.update();
}

// Update conversation metrics table
function updateConversationMetrics(metrics) {
  if (!metrics) {
    return;
  }

  if (!document.getElementById('conv-total-today')) {
    return;
  }

  const total = metrics.totalConversations || {};
  document.getElementById('conv-total-today').textContent = total.today || 0;
  document.getElementById('conv-total-week').textContent = total.thisWeek || 0;
  document.getElementById('conv-total-month').textContent = total.thisMonth || 0;
  document.getElementById('conv-total-change').textContent =
    (total.change ?? 0) + '%';

  const dur = metrics.averageDuration || {};
  document.getElementById('conv-duration-today').textContent =
    (dur.today || 0) + ' min';
  document.getElementById('conv-duration-week').textContent =
    (dur.thisWeek || 0) + ' min';
  document.getElementById('conv-duration-month').textContent =
    (dur.thisMonth || 0) + ' min';
  document.getElementById('conv-duration-change').textContent =
    (dur.change ?? 0) + '%';

  const msgs = metrics.messagesPerConversation || {};
  document.getElementById('conv-msgs-today').textContent =
    Math.round(msgs.today || 0);
  document.getElementById('conv-msgs-week').textContent =
    Math.round(msgs.thisWeek || 0);
  document.getElementById('conv-msgs-month').textContent =
    Math.round(msgs.thisMonth || 0);
  document.getElementById('conv-msgs-change').textContent =
    (msgs.change ?? 0) + '%';
}

/**
 * The headline numbers and chart data, from one request. Home shows the
 * numbers; Reports' charts are filled in whenever they exist.
 */
export async function loadOverview() {
  try {
    const data = await api('/api/admin/analytics');
    lastAnalyticsData = data;

    const set = (id, value) => {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = value;
      }
    };
    set('total-chats-today', data.totalChatsToday || '0');
    set('avg-response-time', data.avgResponseTime ? `${data.avgResponseTime}s` : '—');

    if (data.chatVolumePerDay) {
      updateChatActivityChart(data.chatVolumePerDay);
    }
    if (data.chatVolumeOverTime) {
      updateChatVolumeChart(data.chatVolumeOverTime);
    }
    if (data.responseTimeOverTime) {
      updateResponseTimeChart(data.responseTimeOverTime);
    }
    if (data.conversationMetrics) {
      updateConversationMetrics(data.conversationMetrics);
    }
    updateTopSourcesChart(data.topSources);
  } catch (error) {
    logger.error('Error loading the overview:', error);
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
  if (lastAnalyticsData && lastAnalyticsData.conversationMetrics) {
    updateConversationMetrics(lastAnalyticsData.conversationMetrics);
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
