/**
 * Business hours, in the company's own timezone. Outside them the widget
 * stops implying somebody is about to answer.
 */

import { registerSection } from './nav.js';
import { api, escapeHtml, logger, setLoading, showToast } from './utils.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Minutes past midnight -> "09:00", for a time input. */
const toTimeValue = minutes => {
  const value = Number.isFinite(minutes) ? minutes : 0;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

const fromTimeValue = value => {
  const [hours, minutes] = String(value || '0:00').split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
};

function renderHoursTable(days) {
  // Monday first: a business week does not start on Sunday, whatever the
  // date API thinks.
  const order = [1, 2, 3, 4, 5, 6, 0];

  document.getElementById('hours-table').innerHTML = order.map(day => {
    const rule = days.find(entry => entry.day === day) ||
      { day, closed: day === 0 || day === 6, opensAt: 540, closesAt: 1020 };

    return `
      <tr data-day="${day}">
        <td>${escapeHtml(DAY_NAMES[day])}</td>
        <td>
          <input class="form-check-input" type="checkbox" data-day-open
                 ${rule.closed ? '' : 'checked'}>
        </td>
        <td><input type="time" class="form-control form-control-sm" data-day-from
                   value="${toTimeValue(rule.opensAt)}" ${rule.closed ? 'disabled' : ''}></td>
        <td><input type="time" class="form-control form-control-sm" data-day-to
                   value="${toTimeValue(rule.closesAt)}" ${rule.closed ? 'disabled' : ''}></td>
      </tr>`;
  }).join('');

  document.querySelectorAll('#hours-table [data-day-open]').forEach(checkbox => {
    checkbox.addEventListener('change', event => {
      const row = event.target.closest('tr');
      row.querySelector('[data-day-from]').disabled = !event.target.checked;
      row.querySelector('[data-day-to]').disabled = !event.target.checked;
    });
  });
}

function collectHours() {
  return [...document.querySelectorAll('#hours-table tr')].map(row => ({
    day: Number(row.dataset.day),
    closed: !row.querySelector('[data-day-open]').checked,
    opensAt: fromTimeValue(row.querySelector('[data-day-from]').value),
    closesAt: fromTimeValue(row.querySelector('[data-day-to]').value)
  }));
}

function renderCurrentStatus(current) {
  const element = document.getElementById('hours-current');
  if (!current) {
    element.textContent = '';
    return;
  }

  const parts = [];
  parts.push(current.open ? '<span class="text-success">Open</span>' : '<span class="text-danger">Closed</span>');
  parts.push(`${current.operatorsOnline} operator${current.operatorsOnline === 1 ? '' : 's'} online`);
  if (!current.open && current.opensAt) {
    parts.push(`opens ${escapeHtml(current.opensAt)}`);
  }
  element.innerHTML = parts.join(' · ');
}

function populateTimezones(selected) {
  const select = document.getElementById('hours-timezone');

  // Supported timezones come from the platform where available, so the list
  // is always valid for the runtime rather than a hardcoded subset.
  const zones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];

  const chosen = selected || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  select.innerHTML = zones.map(zone =>
    `<option value="${escapeHtml(zone)}" ${zone === chosen ? 'selected' : ''}>${escapeHtml(zone)}</option>`
  ).join('');
}

function syncHoursEnabled() {
  const enabled = document.getElementById('hours-enabled').checked;
  document.getElementById('hours-config').style.opacity = enabled ? '1' : '0.5';
  document.getElementById('hours-config').querySelectorAll('input, select, textarea')
    .forEach(field => {
      field.disabled = !enabled;
    });

  if (enabled) {
    // Re-apply the per-row closed state, which the blanket enable above lost.
    document.querySelectorAll('#hours-table tr').forEach(row => {
      const open = row.querySelector('[data-day-open]').checked;
      row.querySelector('[data-day-from]').disabled = !open;
      row.querySelector('[data-day-to]').disabled = !open;
    });
  }
}

async function loadHours() {
  try {
    const { businessHours, current } = await api('/api/companies/me/hours');

    document.getElementById('hours-enabled').checked = Boolean(businessHours.enabled);
    populateTimezones(businessHours.timezone);
    renderHoursTable(businessHours.days || []);
    document.getElementById('hours-offline-message').value = businessHours.offlineMessage || '';
    renderCurrentStatus(current);
    syncHoursEnabled();
  } catch (error) {
    logger.error('Failed to load business hours:', error);
  }
}

async function saveHours() {
  const button = document.getElementById('save-hours-btn');
  setLoading(button, true);

  try {
    const result = await api('/api/companies/me/hours', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: document.getElementById('hours-enabled').checked,
        timezone: document.getElementById('hours-timezone').value,
        days: collectHours(),
        offlineMessage: document.getElementById('hours-offline-message').value
      })
    });

    renderCurrentStatus(result.current);
    showToast('Business hours saved', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    setLoading(button, false);
  }
}

registerSection('hours', {
  setup() {
    document.getElementById('hours-enabled').addEventListener('change', syncHoursEnabled);
    document.getElementById('save-hours-btn').addEventListener('click', saveHours);
  },
  show: loadHours
});
