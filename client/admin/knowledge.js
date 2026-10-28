/**
 * The knowledge base: what this tenant's bot is allowed to know.
 *
 * Ingestion, embedding, storage and retrieval were all built and none of it had
 * a way in - no route, no form, no button - so every tenant's knowledge base
 * was empty and their bot answered from the persona alone. This is the way in.
 *
 * The "try a question" box matters as much as the import: somebody who has just
 * pasted their returns policy wants to know the bot can find it, and the
 * alternative way of finding out is a customer complaint. Each source also says
 * how often the bot actually used it, so a page nobody's answers ever draw on
 * is visible as such.
 */

import { Modal } from 'bootstrap';
import { currentSection, registerSection } from './nav.js';
import { setupSheets } from './sheets.js';
import {
  api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, safeHref, setLoading, showToast
} from './utils.js';

/** Every call goes to the signed-in admin's own company's knowledge base. */
function knowledgeApi(path, options = {}) {
  return api(`/api/knowledge${path}`, options);
}

const SOURCE_LABELS = {
  url: 'Web page',
  pdf: 'PDF',
  file: 'Uploaded file',
  text: 'Pasted text',
  manual: 'Pasted text',
  google_sheets: 'Google Sheet'
};

/** How often the crawl progress is asked for. */
const POLL_MS = 1500;

/** "1 passage", "12 passages". A passage is what the bot reads at once. */
function passages(count) {
  const n = Number(count) || 0;
  return `${n} passage${n === 1 ? '' : 's'}`;
}

/**
 * Bytes are not a unit anybody thinks in; characters roughly are.
 *
 * Rounding straight to thousands printed "about 0k characters" for anything
 * shorter than five hundred, which is most pasted policies.
 */
function describeSize(source) {
  const chunks = passages(source.chunks);

  if (!source.characters) {
    return chunks;
  }

  const size = source.characters < 1000
    ? `${source.characters} characters`
    : `about ${Math.round(source.characters / 1000)}k characters`;

  return `${chunks}, ${size}`;
}

/** "Used in 4 answers (30 days)", or that it has not been, which is the useful case. */
function describeUse(source, days) {
  const count = Number(source.usedInAnswers) || 0;
  return count
    ? `Used in ${count} answer${count === 1 ? '' : 's'} (${days} days)`
    : `Not used in an answer in the last ${days} days`;
}

let lastData = null;

function renderSites(sites) {
  const container = document.getElementById('kb-sites');
  if (!sites || sites.length === 0) {
    container.classList.add('d-none');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('d-none');
  container.innerHTML = `
    <div class="small text-muted mb-1">Websites</div>
    <ul class="list-group">
      ${sites.map(site => `
        <li class="list-group-item d-flex align-items-center gap-2 flex-wrap">
          <div class="me-auto">
            <div class="fw-semibold">${escapeHtml(site.origin)}</div>
            <div class="small text-muted">
              ${escapeHtml(`${site.pages} page${site.pages === 1 ? '' : 's'}`)}
              ${site.lastRunAt ? ` · read ${escapeHtml(formatRelativeTime(site.lastRunAt))}` : ''}
              ${site.status === 'running' || site.status === 'queued' ? ' · <span class="text-primary">reading now…</span>' : ''}
              ${site.status === 'failed' && site.error ? ` · <span class="text-danger">${escapeHtml(site.error)}</span>` : ''}
            </div>
          </div>
          <div class="form-check form-switch mb-0">
            <input class="form-check-input" type="checkbox" role="switch" id="kb-site-weekly-${escapeHtml(site.jobId)}"
                   data-site-weekly="${escapeHtml(site.jobId)}" ${site.refreshWeekly ? 'checked' : ''}>
            <label class="form-check-label small" for="kb-site-weekly-${escapeHtml(site.jobId)}">Weekly</label>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-site-recrawl="${escapeHtml(site.startUrl)}"
                  data-site-max="${escapeHtml(site.maxPages)}">Read again</button>
        </li>`).join('')}
    </ul>`;
}

function renderSources(data) {
  const list = document.getElementById('kb-source-list');
  const stats = document.getElementById('kb-stats');
  const note = document.getElementById('kb-note');

  if (!list) {
    return;
  }

  lastData = data;
  const days = data.usageWindowDays || 30;

  // `data.sources` is the array of sources; the route's own `sources` count
  // is overwritten by it in the response, so count the rows rather than
  // printing "[object Object] sources".
  const count = (data.sources || []).length;

  stats.textContent = data.chunks
    ? `${count} source${count === 1 ? '' : 's'}, ${passages(data.chunks)}`
    : 'empty';

  // Say plainly when matching is lexical, rather than letting somebody
  // discover it from a bad answer.
  if (data.note) {
    note.textContent = data.note;
    note.classList.remove('d-none');
  } else {
    note.classList.add('d-none');
  }

  // Kept, but only offered where the operator has switched it on.
  document.getElementById('sheets-card')
    .classList.toggle('d-none', !(data.features && data.features.googleSheets));

  renderSites(data.sites || []);
  list.innerHTML = '';

  if (!data.sources || data.sources.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'list-group-item text-muted';
    empty.textContent =
      'Nothing yet. Until you add something, your bot answers from its persona alone - and has to say it does not know a lot.';
    list.appendChild(empty);
    return;
  }

  data.sources.forEach(source => {
    const row = document.createElement('li');
    row.className = 'list-group-item d-flex align-items-start gap-2 flex-wrap';

    const body = document.createElement('div');
    body.className = 'me-auto kb-source-body';

    const title = document.createElement('div');
    title.className = 'fw-semibold';
    title.textContent = source.title || source.sourceId;
    body.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'small text-muted';
    const kind = SOURCE_LABELS[source.sourceType] || source.sourceType;
    meta.textContent = `${kind} · ${describeSize(source)} · added ${new Date(source.importedAt).toLocaleDateString()}`;
    body.appendChild(meta);

    const use = document.createElement('div');
    use.className = `small ${source.usedInAnswers ? 'text-success' : 'text-muted'}`;
    use.textContent = describeUse(source, days);
    body.appendChild(use);

    // The server sends the address as `url`; reading `metadata.url` meant
    // no source ever showed its link.
    const href = source.url ? safeHref(source.url) : null;
    if (href) {
      const link = document.createElement('a');
      link.className = 'small d-block text-truncate';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.url;
      body.appendChild(link);
    }

    if (source.site) {
      const site = document.createElement('div');
      site.className = 'small text-muted';
      site.textContent = `Part of ${source.site}, read as a whole site`;
      body.appendChild(site);
    }

    if (source.excerpt) {
      const excerpt = document.createElement('div');
      excerpt.className = 'small text-muted fst-italic';
      excerpt.textContent = `${source.excerpt}…`;
      body.appendChild(excerpt);
    }

    if (source.lastError) {
      const failed = document.createElement('div');
      failed.className = 'small text-danger';
      failed.textContent = `Last refresh failed: ${source.lastError}`;
      body.appendChild(failed);
    }

    // A source embedded by a different model than the one now configured
    // cannot be searched at all, so it is worth saying rather than leaving
    // somebody to wonder why it never matches.
    if (source.stale) {
      const stale = document.createElement('span');
      stale.className = 'badge bg-warning text-dark mt-1';
      stale.textContent = 'Indexed with a different model — re-import to use it';
      body.appendChild(stale);
    }

    row.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'd-flex align-items-center gap-2 flex-wrap';

    // A page that belongs to a site is kept current by reading the site.
    if (source.refreshable && !source.site) {
      const id = `kb-weekly-${Math.random().toString(36).slice(2, 10)}`;
      const toggle = document.createElement('div');
      toggle.className = 'form-check form-switch mb-0';
      toggle.innerHTML = `
        <input class="form-check-input" type="checkbox" role="switch" id="${id}" ${source.refreshWeekly ? 'checked' : ''}>
        <label class="form-check-label small" for="${id}">Weekly</label>`;
      toggle.querySelector('input').addEventListener('change', event =>
        setWeekly(source.sourceId, event.target.checked, event.target));
      actions.appendChild(toggle);

      const refresh = document.createElement('button');
      refresh.className = 'btn btn-sm btn-outline-secondary';
      refresh.textContent = 'Re-fetch';
      refresh.addEventListener('click', () => refreshSource(source.sourceId, refresh));
      actions.appendChild(refresh);
    }

    if (source.editable) {
      const edit = document.createElement('button');
      edit.className = 'btn btn-sm btn-outline-secondary';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => openEditor(source, edit));
      actions.appendChild(edit);
    }

    const remove = document.createElement('button');
    remove.className = 'btn btn-sm btn-outline-danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeSource(source));
    actions.appendChild(remove);

    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function load() {
  try {
    renderSources(await knowledgeApi(''));
  } catch (error) {
    showToast(errorMessage(error, 'Could not load your knowledge base'), 'danger');
  }
}

async function addUrl() {
  const input = document.getElementById('kb-url');
  const button = document.getElementById('kb-add-url');
  const url = input.value.trim();

  if (!url) {
    return;
  }

  button.disabled = true;
  button.textContent = 'Importing…';

  try {
    const result = await knowledgeApi('/sources', { method: 'POST', body: JSON.stringify({ url }) });
    showToast(`Added ${passages(result.chunks)} from that page`, 'success');
    input.value = '';
    await load();
  } catch (error) {
    // The message is theirs to act on: a bad URL, a scanned PDF, a site that
    // refused us.
    showToast(error.message, 'danger');
  } finally {
    button.disabled = false;
    button.textContent = 'Import';
  }
}

async function addText() {
  const title = document.getElementById('kb-title');
  const text = document.getElementById('kb-text');
  const button = document.getElementById('kb-add-text');

  if (!text.value.trim()) {
    showToast('Paste something first', 'warning');
    return;
  }

  button.disabled = true;

  try {
    const result = await knowledgeApi('/sources', {
      method: 'POST',
      body: JSON.stringify({ title: title.value.trim() || 'Note', text: text.value })
    });

    showToast(`Added ${passages(result.chunks)}`, 'success');
    title.value = '';
    text.value = '';
    await load();
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    button.disabled = false;
  }
}

async function refreshSource(sourceId, button) {
  button.disabled = true;
  button.textContent = 'Fetching…';

  try {
    const result = await knowledgeApi(`/sources/${encodeURIComponent(sourceId)}/refresh`, { method: 'POST' });
    showToast(`Re-fetched: ${passages(result.chunks)}`, 'success');
    await load();
  } catch (error) {
    showToast(error.message, 'danger');
    button.disabled = false;
    button.textContent = 'Re-fetch';
  }
}

async function setWeekly(sourceId, refreshWeekly, input) {
  try {
    await knowledgeApi(`/sources/${encodeURIComponent(sourceId)}`, { method: 'PATCH', body: { refreshWeekly } });
    showToast(refreshWeekly ? 'It will be fetched again every week' : 'Weekly refresh switched off', 'success');
  } catch (error) {
    input.checked = !refreshWeekly;
    showToast(errorMessage(error, 'Could not change that source'), 'danger');
  }
}

async function setSiteWeekly(jobId, refreshWeekly, input) {
  try {
    await knowledgeApi(`/crawl/${encodeURIComponent(jobId)}`, { method: 'PATCH', body: { refreshWeekly } });
    showToast(refreshWeekly ? 'The site will be read again every week' : 'Weekly reading switched off', 'success');
  } catch (error) {
    input.checked = !refreshWeekly;
    showToast(errorMessage(error, 'Could not change that site'), 'danger');
  }
}

async function removeSource(source) {
  // Removing a source changes what the bot can answer, so name the thing
  // rather than asking "are you sure?" about an unnamed row.
  const ok = await confirmDialog({
    title: 'Remove this source?',
    message: `"${source.title || source.sourceId}" - your bot stops answering from it straight away.`,
    confirmLabel: 'Remove',
    danger: true
  });
  if (!ok) {
    return;
  }

  try {
    await knowledgeApi(`/sources/${encodeURIComponent(source.sourceId)}`, { method: 'DELETE' });
    showToast('Removed', 'success');
    await load();
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

// ---------------------------------------------------------------- editing

async function openEditor(source, button) {
  setLoading(button, true);
  try {
    const note = await knowledgeApi(`/sources/${encodeURIComponent(source.sourceId)}/text`);
    document.getElementById('kb-edit-source').value = source.sourceId;
    document.getElementById('kb-edit-title').value = note.title || '';
    document.getElementById('kb-edit-text').value = note.text || '';
    Modal.getOrCreateInstance(document.getElementById('kbEditModal')).show();
  } catch (error) {
    showToast(errorMessage(error, 'Could not open that note'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

async function saveEdit() {
  const sourceId = document.getElementById('kb-edit-source').value;
  const title = document.getElementById('kb-edit-title').value.trim();
  const text = document.getElementById('kb-edit-text').value;
  const button = document.getElementById('kb-edit-save');

  if (!text.trim()) {
    showToast('The note is empty. Remove the source instead.', 'warning');
    return;
  }

  setLoading(button, true);
  try {
    const result = await knowledgeApi(`/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PUT',
      body: { title, text }
    });
    Modal.getOrCreateInstance(document.getElementById('kbEditModal')).hide();
    showToast(`Saved: ${passages(result.chunks)}`, 'success');
    await load();
  } catch (error) {
    showToast(errorMessage(error, 'Could not save the note'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

// ---------------------------------------------------------------- search

async function testSearch() {
  const input = document.getElementById('kb-test-query');
  const results = document.getElementById('kb-test-results');
  const query = input.value.trim();

  if (!query) {
    return;
  }

  results.innerHTML = '<div class="text-muted small">Searching…</div>';

  try {
    const data = await knowledgeApi('/search', { method: 'POST', body: JSON.stringify({ query }) });

    results.innerHTML = '';

    if (data.results.length === 0) {
      results.innerHTML =
        '<div class="alert alert-warning py-2 small mb-0">' +
        'Nothing matched. Your bot would answer this from its persona alone - add the material that covers it.' +
        '</div>';
      return;
    }

    data.results.forEach(result => {
      const card = document.createElement('div');
      card.className = 'border rounded p-2 mb-2 small';

      const score = document.createElement('span');
      score.className = 'badge bg-light text-dark float-end';
      score.textContent = result.score;
      score.title = 'How closely this passage matches the question';
      card.appendChild(score);

      // Which source this came from, so a wrong passage can be traced to
      // the page or note to fix.
      const from = document.createElement('div');
      from.className = 'text-muted mb-1';
      from.append('From: ');
      const href = result.url ? safeHref(result.url) : null;
      if (href) {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = result.title || result.url;
        from.appendChild(link);
      } else {
        const name = document.createElement('span');
        name.className = 'fw-semibold';
        name.textContent = result.title || 'Knowledge base';
        from.appendChild(name);
      }
      card.appendChild(from);

      const content = document.createElement('div');
      content.textContent = result.content;
      card.appendChild(content);

      results.appendChild(card);
    });
  } catch (error) {
    showToast(error.message, 'danger');
    results.innerHTML = '';
  }
}

// ---------------------------------------------------------------- crawling

let polling = null;

function stopPolling() {
  if (polling) {
    clearTimeout(polling);
    polling = null;
  }
}

function progressHtml(job) {
  const progress = job.progress || {};
  const planned = progress.planned || job.maxPages || 0;
  const saving = progress.phase === 'saving';
  const done = saving ? (progress.saved || 0) : (progress.read || 0);
  const total = saving ? (progress.read || 0) : planned;
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const label = saving
    ? `Saving ${done} of ${total} page${total === 1 ? '' : 's'}…`
    : `Reading ${done} of ${planned} page${planned === 1 ? '' : 's'}…`;

  return `
    <div class="small mb-1">${escapeHtml(label)}</div>
    <div class="progress" role="progressbar" aria-label="Crawl progress" aria-valuenow="${percent}"
         aria-valuemin="0" aria-valuemax="100" style="height: 6px;">
      <div class="progress-bar" style="width: ${percent}%"></div>
    </div>`;
}

function resultHtml(job) {
  const imported = job.imported || [];
  const skipped = job.skipped || [];
  const removed = job.removed || [];

  if (job.status === 'failed') {
    return `<div class="alert alert-danger py-2 small mb-0">${escapeHtml(job.error || 'The crawl failed.')}</div>`;
  }

  return `
    <div class="alert alert-${imported.length ? 'success' : 'warning'} py-2 small mb-0">
      ${imported.length
    ? `Read ${imported.length} page${imported.length === 1 ? '' : 's'}.`
    : 'No pages could be read from that address.'}
      ${removed.length ? ` Removed ${removed.length} page${removed.length === 1 ? '' : 's'} the site no longer has.` : ''}
      ${skipped.length ? `
        <details class="mt-1">
          <summary>${skipped.length} skipped</summary>
          <ul class="mb-0 ps-3">
            ${skipped.slice(0, 20).map(item => `<li><span class="text-break">${escapeHtml(item.url)}</span> - ${escapeHtml(item.reason)}</li>`).join('')}
          </ul>
        </details>` : ''}
    </div>`;
}

/**
 * Follow a crawl until it finishes. Stops quietly when the admin leaves the
 * Knowledge screen; the crawl carries on regardless, and its result is in the
 * list next time they look.
 */
function pollCrawl(jobId, done) {
  const output = document.getElementById('kb-crawl-result');

  const tick = async () => {
    polling = null;
    if (currentSection() !== 'knowledge') {
      done();
      return;
    }
    try {
      const job = await knowledgeApi(`/crawl/${encodeURIComponent(jobId)}`);
      if (job.status === 'done' || job.status === 'failed') {
        output.innerHTML = resultHtml(job);
        done();
        await load();
        return;
      }
      output.innerHTML = progressHtml(job);
    } catch (error) {
      output.innerHTML = '';
      showToast(errorMessage(error, 'Lost track of the crawl'), 'danger');
      done();
      return;
    }
    polling = setTimeout(tick, POLL_MS);
  };

  stopPolling();
  polling = setTimeout(tick, 300);
}

async function crawlSite(url = null, maxPages = null) {
  const input = document.getElementById('kb-crawl-url');
  const button = document.getElementById('kb-crawl-btn');
  const output = document.getElementById('kb-crawl-result');
  const target = (url || input.value).trim();

  if (!target) {
    input.focus();
    return;
  }

  button.disabled = true;
  button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Reading…';

  const finish = () => {
    button.disabled = false;
    button.textContent = 'Read my site';
  };

  try {
    const body = {
      url: target,
      maxPages: Number(maxPages || document.getElementById('kb-crawl-max').value)
    };
    // From the form, the switch says what to do; "Read again" on a site row
    // keeps the site's own setting.
    if (!url) {
      body.refreshWeekly = document.getElementById('kb-crawl-weekly').checked;
    }

    const started = await knowledgeApi('/crawl', { method: 'POST', body });
    output.innerHTML = progressHtml(started.job || {});
    if (started.alreadyRunning) {
      showToast('That site is being read already; following that crawl.', 'info');
    }
    pollCrawl(started.jobId, finish);
  } catch (error) {
    output.innerHTML = '';
    showToast(errorMessage(error, 'Could not read that site'), 'danger');
    finish();
  }
}

async function uploadFile() {
  const input = document.getElementById('kb-file');
  const title = document.getElementById('kb-file-title');
  const button = document.getElementById('kb-upload-btn');
  const file = input.files[0];

  if (!file) {
    showToast('Choose a file first', 'warning');
    return;
  }

  const form = new FormData();
  form.append('file', file);
  if (title.value.trim()) {
    form.append('title', title.value.trim());
  }

  setLoading(button, true);
  try {
    const result = await knowledgeApi('/upload', { method: 'POST', body: form });
    showToast(`Added "${result.title || file.name}" (${passages(result.chunks)})`, 'success');
    input.value = '';
    title.value = '';
    await load();
  } catch (error) {
    showToast(errorMessage(error, 'Could not read that file'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

function setupKnowledge() {
  document.getElementById('kb-add-url').addEventListener('click', addUrl);
  document.getElementById('kb-add-text').addEventListener('click', addText);
  document.getElementById('kb-crawl-btn').addEventListener('click', () => crawlSite());
  document.getElementById('kb-upload-btn').addEventListener('click', uploadFile);
  document.getElementById('kb-reload').addEventListener('click', load);
  document.getElementById('kb-test').addEventListener('click', testSearch);
  document.getElementById('kb-edit-save').addEventListener('click', saveEdit);

  document.getElementById('kb-test-query').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      testSearch();
    }
  });
  document.getElementById('kb-crawl-url').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      crawlSite();
    }
  });

  const sites = document.getElementById('kb-sites');
  sites.addEventListener('change', event => {
    const toggle = event.target.closest('[data-site-weekly]');
    if (toggle) {
      setSiteWeekly(toggle.dataset.siteWeekly, toggle.checked, toggle);
    }
  });
  sites.addEventListener('click', event => {
    const again = event.target.closest('[data-site-recrawl]');
    if (again) {
      crawlSite(again.dataset.siteRecrawl, again.dataset.siteMax);
    }
  });

  // The Sheets wizard wakes up only when somebody opens its panel.
  document.getElementById('sheets-card').addEventListener('toggle', event => {
    if (event.target.open) {
      setupSheetsOnce();
    }
  });
}

let sheetsReady = false;
function setupSheetsOnce() {
  if (!sheetsReady) {
    sheetsReady = true;
    setupSheets();
  }
}

registerSection('knowledge', {
  setup: setupKnowledge,
  async show() {
    await load();
    // A crawl started earlier and still running: pick its progress back up.
    const running = ((lastData && lastData.sites) || [])
      .find(site => site.status === 'running' || site.status === 'queued');
    if (running && !polling) {
      const button = document.getElementById('kb-crawl-btn');
      button.disabled = true;
      pollCrawl(running.jobId, () => {
        button.disabled = false;
        button.textContent = 'Read my site';
      });
    }
  }
});
