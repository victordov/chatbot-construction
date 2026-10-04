/**
 * The knowledge base: what this tenant's bot is allowed to know.
 *
 * Ingestion, embedding, storage and retrieval were all built and none of it had
 * a way in - no route, no form, no button - so every tenant's knowledge base
 * was empty and their bot answered from the persona alone. This is the way in.
 *
 * The "try a question" box matters as much as the import: somebody who has just
 * pasted their returns policy wants to know the bot can find it, and the
 * alternative way of finding out is a customer complaint.
 */

import { registerSection } from './nav.js';
import { setupSheets } from './sheets.js';
import { api, confirmDialog, errorMessage, escapeHtml, setLoading, showToast } from './utils.js';

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

/**
 * Bytes are not a unit anybody thinks in; characters roughly are.
 *
 * Rounding straight to thousands printed "about 0k characters" for anything
 * shorter than five hundred, which is most pasted policies.
 */
function describeSize(source) {
  const chunks = `${source.chunks} piece${source.chunks === 1 ? '' : 's'}`;

  if (!source.characters) {
    return chunks;
  }

  const size = source.characters < 1000
    ? `${source.characters} characters`
    : `about ${Math.round(source.characters / 1000)}k characters`;

  return `${chunks}, ${size}`;
}

function renderSources(data) {
  const list = document.getElementById('kb-source-list');
  const stats = document.getElementById('kb-stats');
  const note = document.getElementById('kb-note');

  if (!list) {
    return;
  }

  // `data.sources` is the array of sources; the route's own `sources` count
  // is overwritten by it in the response, so count the rows rather than
  // printing "[object Object] sources".
  const count = (data.sources || []).length;

  stats.textContent = data.chunks
    ? `${count} source${count === 1 ? '' : 's'}, ${data.chunks} piece${data.chunks === 1 ? '' : 's'}`
    : 'empty';

  // Say plainly when matching is lexical, rather than letting somebody
  // discover it from a bad answer.
  if (data.note) {
    note.textContent = data.note;
    note.classList.remove('d-none');
  } else {
    note.classList.add('d-none');
  }

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
    row.className = 'list-group-item d-flex align-items-start';

    const body = document.createElement('div');
    body.className = 'me-auto';

    const title = document.createElement('div');
    title.className = 'fw-semibold';
    title.textContent = source.title || source.sourceId;
    body.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'small text-muted';
    const kind = SOURCE_LABELS[source.sourceType] || source.sourceType;
    meta.textContent = `${kind} · ${describeSize(source)} · added ${new Date(source.importedAt).toLocaleDateString()}`;
    body.appendChild(meta);

    if (source.metadata && source.metadata.url) {
      const link = document.createElement('a');
      link.className = 'small d-block text-truncate';
      link.href = source.metadata.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.metadata.url;
      body.appendChild(link);
    }

    if (source.excerpt) {
      const excerpt = document.createElement('div');
      excerpt.className = 'small text-muted fst-italic';
      excerpt.textContent = `${source.excerpt}…`;
      body.appendChild(excerpt);
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

    if (source.sourceType === 'url' || source.sourceType === 'pdf') {
      const refresh = document.createElement('button');
      refresh.className = 'btn btn-sm btn-outline-secondary me-2';
      refresh.textContent = 'Re-fetch';
      refresh.addEventListener('click', () => refreshSource(source.sourceId, refresh));
      row.appendChild(refresh);
    }

    const remove = document.createElement('button');
    remove.className = 'btn btn-sm btn-outline-danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeSource(source));
    row.appendChild(remove);

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
    showToast(`Imported ${result.chunks} pieces from that page`, 'success');
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

    showToast(`Added ${result.chunks} pieces`, 'success');
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
    showToast(`Re-fetched: ${result.chunks} pieces`, 'success');
    await load();
  } catch (error) {
    showToast(error.message, 'danger');
    button.disabled = false;
    button.textContent = 'Re-fetch';
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

async function crawlSite() {
  const input = document.getElementById('kb-crawl-url');
  const button = document.getElementById('kb-crawl-btn');
  const output = document.getElementById('kb-crawl-result');
  const url = input.value.trim();

  if (!url) {
    input.focus();
    return;
  }

  button.disabled = true;
  button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Reading…';
  output.innerHTML = '<div class="small text-muted">This takes up to a minute for a larger site.</div>';

  try {
    const result = await knowledgeApi('/crawl', {
      method: 'POST',
      body: { url, maxPages: Number(document.getElementById('kb-crawl-max').value) }
    });
    const imported = result.imported || [];
    const skipped = result.skipped || [];

    output.innerHTML = `
      <div class="alert alert-${imported.length ? 'success' : 'warning'} py-2 small mb-0">
        ${imported.length
    ? `Read ${imported.length} page${imported.length === 1 ? '' : 's'}.`
    : 'No pages could be read from that address.'}
        ${skipped.length ? `
          <details class="mt-1">
            <summary>${skipped.length} skipped</summary>
            <ul class="mb-0 ps-3">
              ${skipped.slice(0, 20).map(item => `<li><span class="text-break">${escapeHtml(item.url)}</span> - ${escapeHtml(item.reason)}</li>`).join('')}
            </ul>
          </details>` : ''}
      </div>`;
    await load();
  } catch (error) {
    output.innerHTML = '';
    showToast(errorMessage(error, 'Could not read that site'), 'danger');
  } finally {
    button.disabled = false;
    button.textContent = 'Read my site';
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
    showToast(`Added "${result.title || file.name}" (${result.chunks} pieces)`, 'success');
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
  document.getElementById('kb-crawl-btn').addEventListener('click', crawlSite);
  document.getElementById('kb-upload-btn').addEventListener('click', uploadFile);
  document.getElementById('kb-reload').addEventListener('click', load);
  document.getElementById('kb-test').addEventListener('click', testSearch);

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
  show: load
});
