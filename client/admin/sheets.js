/**
 * Google Sheets import.
 *
 * Kept while its place in the product is decided: the rows are stored as
 * knowledge documents the assistant does not read yet. It lives in a
 * collapsed panel at the bottom of Knowledge so nobody mistakes it for the
 * way to teach the bot.
 */

import { authToken, parseJsonResponse, setLoading, showToast } from './utils.js';

// Start Google OAuth flow
function connectGoogleAccount(event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = authToken();
  fetch('/api/google/auth/url', { headers: { 'x-auth-token': token } })
    .then(parseJsonResponse)
    .then(data => {
      const w = window.open(data.url, '_blank');
      const poll = setInterval(() => {
        if (w.closed) {
          clearInterval(poll);
          checkGoogleStatus();
        }
      }, 1000);
    })
    .catch(() => showToast('Failed to initiate Google OAuth', 'danger'))
    .finally(() => setLoading(btn, false));
}

function checkGoogleStatus() {
  const token = authToken();
  fetch('/api/google/status', { headers: { 'x-auth-token': token } })
    .then(parseJsonResponse)
    .then(data => {
      const btn = document.getElementById('connect-google');
      if (btn) {
        btn.textContent = data.authorized ? 'Reauthorize Google Account' : 'Connect Google Account';
      }
      const span = document.getElementById('google-account');
      if (span) {
        span.textContent = data.email || '';
      }
      showStep(data.authorized ? 'kb-step-search' : 'kb-step-connect');
    });
}

// Load spreadsheet data and display in table
let currentDocId = null;

function loadSpreadsheet(event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = authToken();
  const spreadsheetId = document.getElementById('spreadsheet-id').value;
  const defaultSheet = document.getElementById('default-sheet').checked;
  const sheet = defaultSheet ? 'Sheet1' : document.getElementById('sheet-select').value;
  // Columns are chosen in the next step, once the sheet has been read.
  const exclude = [];

  fetch('/api/google/knowledge/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ spreadsheetId, sheet, exclude })
  })
    .then(parseJsonResponse)
    .then(data => {
      if (document.getElementById('knowledge-list')) {
        refreshKnowledge();
      }
      currentDocId = data.doc._id;
      expandKnowledge(data.doc._id);
    })
    .catch(() => showToast('Failed to load spreadsheet', 'danger'))
    .finally(() => setLoading(btn, false));
}

// Search Google Drive for spreadsheets
function searchDrive(event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = authToken();
  const query = document.getElementById('drive-query').value;
  fetch(`/api/google/drive/search?q=${encodeURIComponent(query)}`, { headers: { 'x-auth-token': token } })
    .then(parseJsonResponse)
    .then(data => {
      const list = document.getElementById('drive-results');
      list.innerHTML = '';
      data.files.forEach(f => {
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex justify-content-between align-items-center';
        li.textContent = f.name;
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-primary';
        btn.textContent = 'Select';
        btn.addEventListener('click', () => openLoadModal(f.id, f.name));
        li.appendChild(btn);
        list.appendChild(li);
      });
    })
    .catch(() => showToast('Drive search failed', 'danger'))
    .finally(() => setLoading(btn, false));
}

function openLoadModal(id, name) {
  document.getElementById('spreadsheet-id').value = id;
  if (name) {
    const span = document.getElementById('selected-spreadsheet-name');
    if (span) {
      span.textContent = name;
    }
  }
  fetchSheetNames(id).then(() => {
    showStep('kb-step-sheet');
  });
}

function fetchSheetNames(id) {
  const token = authToken();
  return fetch(`/api/google/sheets/${id}/names`, { headers: { 'x-auth-token': token } })
    .then(parseJsonResponse)
    .then(data => {
      const select = document.getElementById('sheet-select');
      select.innerHTML = '';
      data.names.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        select.appendChild(opt);
      });
    })
    .catch(() => showToast('Failed to fetch sheet names', 'danger'));
}

function refreshKnowledge(query = '', event) {
  const btn = event?.currentTarget;
  if (btn) {
    setLoading(btn, true);
  }
  const token = authToken();
  const url = '/api/google/knowledge' + (query ? `?q=${encodeURIComponent(query)}` : '');
  fetch(url, { headers: { 'x-auth-token': token } })
    .then(parseJsonResponse)
    .then(data => {
      const list = document.getElementById('knowledge-list');
      list.innerHTML = '';
      data.docs.forEach(doc => {
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex justify-content-between align-items-center';
        li.textContent = (doc.title || doc.spreadsheetId) + ' - ' + (doc.sheet || 'Sheet1');
        const div = document.createElement('div');
        const expand = document.createElement('button');
        expand.className = 'btn btn-sm btn-outline-primary me-1';
        expand.textContent = 'View';
        expand.addEventListener('click', () => expandKnowledge(doc._id));
        const refBtn = document.createElement('button');
        refBtn.className = 'btn btn-sm btn-outline-secondary me-1';
        refBtn.textContent = 'Refresh';
        refBtn.addEventListener('click', event => refreshDocument(doc._id, event));
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-outline-danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', event => deleteKnowledge(doc._id, event));
        div.appendChild(expand);
        div.appendChild(refBtn);
        div.appendChild(delBtn);
        li.appendChild(div);
        list.appendChild(li);
      });
    })
    .catch(() => showToast('Failed to load knowledge list', 'danger'))
    .finally(() => {
      if (btn) {
        setLoading(btn, false);
      }
    });
}

function refreshDocument(id, event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = authToken();
  fetch(`/api/google/knowledge/${id}/refresh`, { method: 'POST', headers: { 'x-auth-token': token } })
    .then(parseJsonResponse)
    .then(() => refreshKnowledge())
    .catch(() => showToast('Refresh failed', 'danger'))
    .finally(() => setLoading(btn, false));
}

function expandKnowledge(id) {
  const token = authToken();
  fetch(`/api/google/knowledge/${id}`, { headers: { 'x-auth-token': token } })
    .then(parseJsonResponse)
    .then(data => {
      currentDocId = data.doc._id;
      const table = document.getElementById('spreadsheet-table');
      table.innerHTML = '';
      const headerRow = document.createElement('tr');
      data.doc.columns.forEach((col, idx) => {
        const th = document.createElement('th');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !col.exclude;
        cb.addEventListener('change', () => updateColumns(id));
        th.appendChild(cb);
        th.appendChild(document.createTextNode(' ' + col.name));
        if (col.exclude) {
          th.classList.add('text-muted');
        }
        headerRow.appendChild(th);
      });
      const thead = document.createElement('thead');
      thead.appendChild(headerRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      data.doc.rows.forEach(r => {
        const tr = document.createElement('tr');
        r.forEach((c, cellIdx) => {
          const td = document.createElement('td');
          td.textContent = c;
          if (data.doc.columns[cellIdx] && data.doc.columns[cellIdx].exclude) {
            td.classList.add('text-muted');
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);

      applyStickySpreadsheetRows();

      document.getElementById('spreadsheet-id').value = data.doc.spreadsheetId;
      fetchSheetNames(data.doc.spreadsheetId);
      if (document.getElementById('default-sheet')) {
        const cb = document.getElementById('default-sheet');
        const select = document.getElementById('sheet-select');
        if (select) {
          if (cb && !cb.checked && data.doc.sheet) {
            select.value = data.doc.sheet;
          }
        }
      }
      showStep('kb-step-columns');
    })
    .catch(() => showToast('Failed to load document', 'danger'));
}

function updateColumns(id) {
  const table = document.getElementById('spreadsheet-table');
  const excluded = [];
  table.querySelectorAll('thead th').forEach(th => {
    const cb = th.querySelector('input[type="checkbox"]');
    const name = th.textContent.trim();
    if (cb && !cb.checked) {
      excluded.push(name);
      th.classList.add('text-muted');
    } else {
      th.classList.remove('text-muted');
    }
  });
  const headerCells = table.querySelectorAll('thead th');
  table.querySelectorAll('tbody tr').forEach(row => {
    row.querySelectorAll('td').forEach((td, idx) => {
      const headerCell = headerCells[idx];
      if (headerCell && excluded.includes(headerCell.textContent.trim())) {
        td.classList.add('text-muted');
      } else {
        td.classList.remove('text-muted');
      }
    });
  });
  const token = authToken();
  fetch(`/api/google/knowledge/${id}/columns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ excluded })
  });
}

// Make each spreadsheet row sticky so short cells stay in view while long cells scroll
// and adjust z-index on scroll so the active row isn't hidden by others
function applyStickySpreadsheetRows() {
  const table = document.getElementById('spreadsheet-table');
  if (!table) {
    return;
  }

  const header = table.querySelector('thead tr');
  if (header) {
    header.classList.add('sticky-header');
    header.style.top = '0';
  }

  const headerHeight = header ? header.offsetHeight : 0;

  const rows = Array.from(table.querySelectorAll('tbody tr'));
  rows.forEach(tr => {
    tr.classList.add('sticky-row');
    tr.style.top = `${headerHeight}px`;
    tr.style.zIndex = 1;
  });

  const container = table.closest('.spreadsheet-table-container');
  if (container) {
    const updateZIndex = () => {
      let activeRow = null;
      rows.forEach(tr => {
        const { top } = tr.getBoundingClientRect();
        const { top: cTop } = container.getBoundingClientRect();
        if (top - cTop <= headerHeight) {
          if (!activeRow || top > activeRow.top) {
            activeRow = { tr, top };
          }
        }
      });
      rows.forEach(tr => (tr.style.zIndex = 1));
      if (activeRow) {
        activeRow.tr.style.zIndex = 2;
      }
    };
    container.addEventListener('scroll', updateZIndex);
    updateZIndex();
  }

  enableSpreadsheetColumnResizing(table);
}

function enableSpreadsheetColumnResizing(table) {
  if (!table) {
    return;
  }
  const headerCells = table.querySelectorAll('thead th');
  headerCells.forEach((th, index) => {
    const handle = document.createElement('div');
    handle.className = 'col-resizer';
    th.style.position = 'relative';
    th.appendChild(handle);
    let startX = 0;
    let startWidth = 0;
    function onMouseMove(e) {
      const newWidth = Math.max(startWidth + (e.clientX - startX), 30);
      th.style.width = `${newWidth}px`;
      table.querySelectorAll(`tbody td:nth-child(${index + 1})`).forEach(td => {
        td.style.width = `${newWidth}px`;
      });
      const totalWidth = Array.from(headerCells).reduce((sum, cell) => sum + cell.offsetWidth, 0);
      table.style.width = `${totalWidth}px`;
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    handle.addEventListener('mousedown', e => {
      startX = e.clientX;
      startWidth = th.offsetWidth;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
  const initialWidth = Array.from(headerCells).reduce((sum, cell) => sum + cell.offsetWidth, 0);
  table.style.width = `${initialWidth}px`;
}

function saveKnowledgeConfig(event) {
  if (!currentDocId) {
    return;
  }
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const table = document.getElementById('spreadsheet-table');
  const excluded = [];
  table.querySelectorAll('thead th').forEach(th => {
    const cb = th.querySelector('input[type="checkbox"]');
    const name = th.textContent.trim();
    if (cb && !cb.checked) {
      excluded.push(name);
    }
  });
  const token = authToken();
  fetch(`/api/google/knowledge/${currentDocId}/columns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ excluded })
  })
    .then(() => showSummary(currentDocId))
    .catch(() => showToast('Failed to save configuration', 'danger'))
    .finally(() => setLoading(btn, false));
}

function showSummary(id) {
  const token = authToken();
  fetch(`/api/google/knowledge/${id}`, { headers: { 'x-auth-token': token } })
    .then(parseJsonResponse)
    .then(data => {
      const ul = document.getElementById('kb-summary-details');
      if (!ul) {
        return;
      }
      ul.innerHTML = '';
      const email = document.getElementById('google-account')?.textContent || '';
      const items = [
        `Spreadsheet: ${data.doc.title || data.doc.spreadsheetId}`,
        `Sheet: ${data.doc.sheet || 'Sheet1'}`,
        `Authorized Account: ${email}`,
        `Active Columns: ${data.doc.columns.filter(c => !c.exclude).map(c => c.name).join(', ')}`
      ];
      items.forEach(text => {
        const li = document.createElement('li');
        li.textContent = text;
        ul.appendChild(li);
      });
      showStep('kb-summary');
    })
    .catch(() => showToast('Failed to load configuration', 'danger'));
}

function deleteKnowledge(id, event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = authToken();
  fetch(`/api/google/knowledge/${id}`, { method: 'DELETE', headers: { 'x-auth-token': token } })
    .then(parseJsonResponse)
    .then(() => {
      if (currentDocId === id) {
        currentDocId = null;
        showStep('kb-step-connect');
      }
      refreshKnowledge();
    })
    .catch(() => showToast('Delete failed', 'danger'))
    .finally(() => setLoading(btn, false));
}

function showStep(id) {
  document.querySelectorAll('.kb-step').forEach(el => el.classList.add('d-none'));
  const step = document.getElementById(id);
  if (step) {
    step.classList.remove('d-none');
  }
}

/**
 * Wire the wizard. Called the first time its panel on Knowledge is opened,
 * so nobody pays for a Google status check they never asked for.
 */
export function setupSheets() {
  const loadBtn = document.getElementById('load-sheet');
  if (loadBtn) {
    loadBtn.addEventListener('click', loadSpreadsheet);
  }
  const connectBtn = document.getElementById('connect-google');
  if (connectBtn) {
    connectBtn.addEventListener('click', connectGoogleAccount);
    checkGoogleStatus();
  }
  const searchBtn = document.getElementById('search-drive');
  if (searchBtn) {
    searchBtn.addEventListener('click', searchDrive);
  }
  const searchKnowledgeBtn = document.getElementById('search-knowledge');
  if (searchKnowledgeBtn) {
    searchKnowledgeBtn.addEventListener('click', function(event) {
      const q = document.getElementById('knowledge-query').value;
      refreshKnowledge(q, event);
    });
  }
  const refreshBtn = document.getElementById('refresh-knowledge');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', event => refreshKnowledge('', event));
    refreshKnowledge();
  }
  const defaultCb = document.getElementById('default-sheet');
  const sheetSelect = document.getElementById('sheet-select');
  if (defaultCb && sheetSelect) {
    defaultCb.addEventListener('change', function() {
      sheetSelect.disabled = this.checked;
      if (loadBtn) {
        loadBtn.disabled = !this.checked && !sheetSelect.value;
      }
    });
    sheetSelect.disabled = defaultCb.checked;
    if (loadBtn) {
      loadBtn.disabled = !defaultCb.checked && !sheetSelect.value;
    }
    sheetSelect.addEventListener('change', function() {
      if (loadBtn) {
        loadBtn.disabled = !defaultCb.checked && !this.value;
      }
    });
  }
  const idInput = document.getElementById('spreadsheet-id');
  if (idInput) {
    idInput.addEventListener('change', function() {
      if (this.value) {
        fetchSheetNames(this.value);
      }
    });
  }
  const changeSpreadsheetBtn = document.getElementById('kb-change-spreadsheet');
  if (changeSpreadsheetBtn) {
    changeSpreadsheetBtn.addEventListener('click', () => showStep('kb-step-search'));
  }
  const changeGoogleBtn = document.getElementById('change-google');
  if (changeGoogleBtn) {
    changeGoogleBtn.addEventListener('click', () => showStep('kb-step-connect'));
  }

  const finishBtn = document.getElementById('finish-kb-setup');
  if (finishBtn) {
    finishBtn.addEventListener('click', saveKnowledgeConfig);
  }

  const refreshKbBtn = document.getElementById('kb-refresh');
  if (refreshKbBtn) {
    refreshKbBtn.addEventListener('click', event => {
      refreshDocument(currentDocId, event);
      if (currentDocId) {
        showSummary(currentDocId);
      }
    });
  }

  const editKbBtn = document.getElementById('kb-edit');
  if (editKbBtn) {
    editKbBtn.addEventListener('click', () => currentDocId && showStep('kb-step-columns'));
  }

  const disconnectKbBtn = document.getElementById('kb-disconnect');
  if (disconnectKbBtn) {
    disconnectKbBtn.addEventListener('click', event => deleteKnowledge(currentDocId, event));
  }
}
