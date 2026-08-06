/**
 * Advanced analytics.
 *
 * Renders the metrics a support manager acts on: whether the bot is deflecting
 * work, whether anyone is being left unanswered, when cover is needed, and who
 * is carrying the load.
 */

(function() {
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let currentRange = 7;

  function token() {
    return localStorage.getItem('chatbot-auth-token');
  }

  /**
   * Seconds as something a person reads at a glance.
   */
  function formatDuration(seconds) {
    if (!seconds) {
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

  function renderHeadline(data) {
    setStat('stat-deflection', `${data.deflection.rate}%`,
      `${data.deflection.deflected} of ${data.deflection.eligible} handled by the bot alone`);

    setStat('stat-escalated', String(data.deflection.escalated),
      'conversations reached an operator');

    const abandonEl = document.getElementById('stat-abandoned');
    setStat('stat-abandoned', `${data.abandonment.rate}%`,
      `${data.abandonment.unanswered} of ${data.abandonment.total} never got a reply`);

    // Anything above one in twenty going unanswered is worth flagging rather
    // than leaving as a neutral number.
    if (abandonEl) {
      abandonEl.className = `stat-value ${data.abandonment.rate > 5 ? 'text-danger' : ''}`;
    }

    renderSatisfaction(data.satisfaction);

    setStat('stat-tasks', `${data.tasks.completionRate}%`,
      `${data.tasks.completed} of ${data.tasks.created} closed` +
      (data.tasks.overdue ? ` · ${data.tasks.overdue} overdue` : ''));
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
            No ratings yet. Visitors are asked once a conversation ends, if they
            sent more than one message.
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

    const most = Math.max(...csat.distribution, 1);

    const bars = renderDistribution(csat.distribution);
    void most;

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
      ${bars}
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
    const most = Math.max(...distribution, 1);

    return distribution.map((count, index) => `
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
  function renderHeatmap(peakHours) {
    const container = document.getElementById('peak-heatmap');
    if (!container) {
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

    if (!topics.length) {
      container.innerHTML = '<p class="text-muted mb-0">Not enough conversations yet.</p>';
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

    if (!operators.length) {
      table.innerHTML =
        '<tr><td colspan="5" class="text-muted text-center py-3">No operator-handled conversations in this period.</td></tr>';
      return;
    }

    table.innerHTML = operators.map(operator => `
      <tr>
        <td>${escapeHtml(operator.operator)}</td>
        <td class="text-end">${operator.conversations}</td>
        <td class="text-end">${operator.replies}</td>
        <td class="text-end">${escapeHtml(formatDuration(operator.medianResponseSeconds))}</td>
        <td class="text-end text-muted">${escapeHtml(formatDuration(operator.avgResponseSeconds))}</td>
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

  async function load(days = currentRange) {
    currentRange = days;

    const label = document.getElementById('analytics-range-label');
    if (label) {
      label.textContent = `Last ${days} days`;
    }

    try {
      const response = await fetch(`/api/admin/analytics/advanced?days=${days}`, {
        headers: { 'x-auth-token': token() }
      });

      if (response.status === 402) {
        // Not an error: the tenant's plan simply does not include this. The
        // satisfaction figures are not part of that gate — they come from the
        // basic endpoint, so they are rendered here regardless.
        showLocked(true);
        // Read from the basic payload the dashboard already loaded. `let` at
        // script scope is not a property of `window`, so this is the binding
        // itself rather than a lookup that would silently be undefined.
        renderSatisfaction(
          typeof lastAnalyticsData !== 'undefined' && lastAnalyticsData
            ? lastAnalyticsData.satisfaction
            : null,
          { summaryOnly: true }
        );
        return;
      }

      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }

      const data = await response.json();
      showLocked(false);

      renderHeadline(data);
      renderHeatmap(data.peakHours);
      renderTopics(data.topics);
      renderOperators(data.operators);
    } catch (error) {
      logger.error('Failed to load advanced analytics:', error);
      const container = document.getElementById('peak-heatmap');
      if (container) {
        container.innerHTML =
          `<p class="text-danger mb-0">Could not load analytics: ${escapeHtml(error.message)}</p>`;
      }
    }
  }

  function setupAnalytics() {
    const section = document.getElementById('analytics-section');
    if (!section) {
      return;
    }

    section.querySelectorAll('[data-range]').forEach(button => {
      button.addEventListener('click', () => {
        section.querySelectorAll('[data-range]').forEach(other => other.classList.remove('active'));
        button.classList.add('active');
        load(parseInt(button.dataset.range, 10));
      });
    });

    // Loaded on demand: these aggregations are heavier than the dashboard's,
    // and most sessions never open this tab.
    const navLink = document.querySelector('#sidebar .nav-link[data-section="analytics"]');
    let loaded = false;

    const loadOnce = () => {
      if (!loaded) {
        loaded = true;
        load();
      }
    };

    navLink?.addEventListener('click', loadOnce);

    if (section.classList.contains('active')) {
      loadOnce();
    }
  }

  window.setupAnalytics = setupAnalytics;
})();
