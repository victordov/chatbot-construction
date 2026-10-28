/**
 * Business hours, in the company's own timezone. Outside them the widget
 * stops implying somebody is about to answer.
 */

import { registerSection } from './nav.js';
import { api, escapeHtml, logger, setLoading, showToast } from './utils.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Whole days off, kept here until Save. */
let closedDates = [];

/** Minutes past midnight -> "09:00", for a time input. */
const toTimeValue = minutes => {
  const value = Number.isFinite(minutes) ? Math.min(minutes, 1439) : 0;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

/**
 * "17:00" -> minutes past midnight. A closing time of 00:00 means midnight at
 * the end of the day, not the start of it - otherwise "09:00 to 00:00" would
 * read as closing before it opened.
 */
const fromTimeValue = (value, closing = false) => {
  const [hours, minutes] = String(value || '0:00').split(':').map(Number);
  const total = (hours || 0) * 60 + (minutes || 0);
  return closing && total === 0 ? 1440 : total;
};

function renderHoursTable(days) {
  // Monday first: a business week does not start on Sunday, whatever the
  // date API thinks.
  const order = [1, 2, 3, 4, 5, 6, 0];

  document.getElementById('hours-table').innerHTML = order.map(day => {
    const rule = days.find(entry => entry.day === day) ||
      { day, closed: day === 0 || day === 6, opensAt: 540, closesAt: 1020 };
    const overnight = !rule.closed && rule.closesAt < rule.opensAt;

    return `
      <tr data-day="${day}">
        <td>${escapeHtml(DAY_NAMES[day])}</td>
        <td>
          <input class="form-check-input" type="checkbox" data-day-open aria-label="Open on ${escapeHtml(DAY_NAMES[day])}"
                 ${rule.closed ? '' : 'checked'}>
        </td>
        <td><input type="time" class="form-control form-control-sm" data-day-from
                   value="${toTimeValue(rule.opensAt)}" ${rule.closed ? 'disabled' : ''}></td>
        <td>
          <input type="time" class="form-control form-control-sm" data-day-to
                 value="${toTimeValue(rule.closesAt === 1440 ? 0 : rule.closesAt)}" ${rule.closed ? 'disabled' : ''}>
          <div class="small text-muted" data-overnight ${overnight ? '' : 'hidden'}>next day</div>
        </td>
      </tr>`;
  }).join('');

  document.querySelectorAll('#hours-table [data-day-open]').forEach(checkbox => {
    checkbox.addEventListener('change', event => {
      const row = event.target.closest('tr');
      row.querySelector('[data-day-from]').disabled = !event.target.checked;
      row.querySelector('[data-day-to]').disabled = !event.target.checked;
    });
  });

  // Say "next day" as soon as a closing time before the opening time is
  // typed, so an overnight shift is visibly meant rather than a mistake.
  document.querySelectorAll('#hours-table [data-day-from], #hours-table [data-day-to]').forEach(input => {
    input.addEventListener('input', () => {
      const row = input.closest('tr');
      const opens = fromTimeValue(row.querySelector('[data-day-from]').value);
      const closes = fromTimeValue(row.querySelector('[data-day-to]').value, true);
      row.querySelector('[data-overnight]').hidden = !(closes < opens);
    });
  });
}

function collectHours() {
  return [...document.querySelectorAll('#hours-table tr')].map(row => ({
    day: Number(row.dataset.day),
    closed: !row.querySelector('[data-day-open]').checked,
    opensAt: fromTimeValue(row.querySelector('[data-day-from]').value),
    closesAt: fromTimeValue(row.querySelector('[data-day-to]').value, true)
  }));
}

function renderClosedDates() {
  const list = document.getElementById('hours-closed-list');
  if (!closedDates.length) {
    list.innerHTML = '<li class="text-muted">None. Add bank holidays and other days off here.</li>';
    return;
  }
  list.innerHTML = closedDates.map(entry => {
    const [year, month, day] = entry.date.split('-').map(Number);
    const when = new Date(year, month - 1, day).toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
    });
    return `
      <li>
        <span class="flex-grow-1">${escapeHtml(when)}${entry.label ? ` <span class="text-muted">· ${escapeHtml(entry.label)}</span>` : ''}</span>
        <button type="button" class="btn btn-sm btn-link text-danger p-0" data-remove-date="${escapeHtml(entry.date)}">Remove</button>
      </li>`;
  }).join('');
}

function addClosedDate() {
  const dateInput = document.getElementById('hours-closed-date');
  const labelInput = document.getElementById('hours-closed-label');
  const date = dateInput.value;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    showToast('Choose a date first', 'warning');
    return;
  }

  closedDates = closedDates.filter(entry => entry.date !== date)
    .concat({ date, label: labelInput.value.trim() || undefined })
    .sort((a, b) => a.date.localeCompare(b.date));
  dateInput.value = '';
  labelInput.value = '';
  renderClosedDates();
}

function renderCurrentStatus(current) {
  const element = document.getElementById('hours-current');
  if (!current) {
    element.textContent = '';
    return;
  }

  const parts = [];
  parts.push(current.open ? '<span class="text-success">Open</span>' : '<span class="text-danger">Closed</span>');
  if (current.closedToday) {
    parts.push(escapeHtml(current.closedToday));
  }
  parts.push(`${current.operatorsOnline} operator${current.operatorsOnline === 1 ? '' : 's'} online`);
  if (!current.open && current.opensAt) {
    parts.push(`opens ${escapeHtml(current.opensAt)}`);
  }
  element.innerHTML = parts.join(' · ');
}

/** The browser's own zone: the best guess for somebody who has not chosen. */
function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (error) {
    return 'UTC';
  }
}

function populateTimezones(selected) {
  const select = document.getElementById('hours-timezone');

  // Supported timezones come from the platform where available, so the list
  // is always valid for the runtime rather than a hardcoded subset.
  const zones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];

  const chosen = selected || browserZone();
  // The platform's list leaves out "UTC" itself in some browsers; without it
  // in the menu the first zone (Africa/Abidjan) was selected instead.
  const list = zones.includes(chosen) ? zones : [chosen, ...zones];

  select.innerHTML = list.map(zone =>
    `<option value="${escapeHtml(zone)}" ${zone === chosen ? 'selected' : ''}>${escapeHtml(zone)}</option>`
  ).join('');
}

function syncHoursEnabled() {
  const enabled = document.getElementById('hours-enabled').checked;
  document.getElementById('hours-config').style.opacity = enabled ? '1' : '0.5';
  document.getElementById('hours-config').querySelectorAll('input, select, textarea, button')
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
    const { businessHours, current, saved } = await api('/api/companies/me/hours');

    document.getElementById('hours-enabled').checked = Boolean(businessHours.enabled);
    // Never saved: the stored zone is the schema's UTC, not a choice, so the
    // browser's own is offered instead.
    populateTimezones(saved ? businessHours.timezone : browserZone());
    renderHoursTable(businessHours.days || []);
    closedDates = (businessHours.closedDates || []).slice();
    renderClosedDates();
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
        closedDates,
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
    document.getElementById('hours-closed-add').addEventListener('click', addClosedDate);
    document.getElementById('hours-closed-list').addEventListener('click', event => {
      const button = event.target.closest('[data-remove-date]');
      if (button) {
        closedDates = closedDates.filter(entry => entry.date !== button.dataset.removeDate);
        renderClosedDates();
      }
    });
  },
  show: loadHours
});
