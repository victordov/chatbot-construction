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

import { api, authToken, getStoredUser, showNotification } from './utils.js';

// Which tenant we are looking at. Empty for a superadmin until they choose.
let companyId = null;


function currentUser() {
  return getStoredUser() || {};
}

function isSuperadmin() {
  return currentUser().role === 'superadmin';
}

/**
 * Knowledge is tenant-scoped, so every call has to say whose.
 *
 * A company admin has exactly one and it comes from their account. A
 * superadmin has none of their own and picks one; until they do, the screen
 * says so rather than sitting silently empty.
 */
function withCompany(path) {
  if (!companyId) {
    return path;
  }
  return path.includes('?')
    ? `${path}&companyId=${encodeURIComponent(companyId)}`
    : `${path}?companyId=${encodeURIComponent(companyId)}`;
}

/**
 * The shared `api()` plus this section's company scoping: a superadmin's
 * chosen company travels in the body on a write and in the query string on
 * a read, because that is what the route accepts.
 */
function knowledgeApi(path, options = {}) {
  if (companyId && options.body) {
    const payload = JSON.parse(options.body);
    payload.companyId = companyId;
    options = { ...options, body: JSON.stringify(payload) };
  }

  return api(`/api/knowledge${withCompany(path)}`, options);
}

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
      'Nothing yet. Your bot answers from its persona alone until you add something here.';
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
    meta.textContent = `${describeSize(source)} · imported ${new Date(source.importedAt).toLocaleDateString()}`;
    body.appendChild(meta);

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
  if (isSuperadmin() && !companyId) {
    // Say what to do rather than showing an empty list and a toast that has
    // already faded by the time anybody looks.
    document.getElementById('kb-stats').textContent = '';
    document.getElementById('kb-source-list').innerHTML =
      '<li class="list-group-item text-muted">' +
      'Knowledge belongs to a tenant. Choose a company above to see and edit theirs.' +
      '</li>';
    return;
  }

  try {
    renderSources(await knowledgeApi(''));
  } catch (error) {
    showNotification(error.message, 'error');
  }
}

/** Populate the tenant picker, for a superadmin only. */
async function setupCompanyPicker() {
  const select = document.getElementById('kb-company');

  if (!select || !isSuperadmin()) {
    return;
  }

  select.classList.remove('d-none');

  try {
    const response = await fetch('/api/companies', { headers: { 'x-auth-token': authToken() } });
    const data = await response.json();
    const companies = Array.isArray(data) ? data : (data.companies || []);

    companies.forEach(company => {
      const option = document.createElement('option');
      option.value = company._id;
      option.textContent = company.name;
      select.appendChild(option);
    });
  } catch {
    // A picker that could not be filled is better left empty than replaced
    // with an error where the list should be.
  }

  select.addEventListener('change', () => {
    companyId = select.value || null;
    document.getElementById('kb-test-results').innerHTML = '';
    load();
  });
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
    showNotification(`Imported ${result.chunks} pieces from that page`, 'success');
    input.value = '';
    await load();
  } catch (error) {
    // The message is theirs to act on: a bad URL, a scanned PDF, a site that
    // refused us.
    showNotification(error.message, 'error');
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
    showNotification('Paste something first', 'error');
    return;
  }

  button.disabled = true;

  try {
    const result = await knowledgeApi('/sources', {
      method: 'POST',
      body: JSON.stringify({ title: title.value.trim() || 'Note', text: text.value })
    });

    showNotification(`Added ${result.chunks} pieces`, 'success');
    title.value = '';
    text.value = '';
    await load();
  } catch (error) {
    showNotification(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function refreshSource(sourceId, button) {
  button.disabled = true;
  button.textContent = 'Fetching…';

  try {
    const result = await knowledgeApi(`/sources/${encodeURIComponent(sourceId)}/refresh`, { method: 'POST' });
    showNotification(`Re-fetched: ${result.chunks} pieces`, 'success');
    await load();
  } catch (error) {
    showNotification(error.message, 'error');
    button.disabled = false;
    button.textContent = 'Re-fetch';
  }
}

async function removeSource(source) {
  // Removing a source changes what the bot can answer, so name the thing
  // rather than asking "are you sure?" about an unnamed row.
  if (!confirm(`Remove "${source.title || source.sourceId}"? Your bot will stop answering from it.`)) {
    return;
  }

  try {
    await knowledgeApi(`/sources/${encodeURIComponent(source.sourceId)}`, { method: 'DELETE' });
    showNotification('Removed', 'success');
    await load();
  } catch (error) {
    showNotification(error.message, 'error');
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
        'Nothing matched. Your bot would answer this from its persona alone.' +
        '</div>';
      return;
    }

    data.results.forEach(result => {
      const card = document.createElement('div');
      card.className = 'border rounded p-2 mb-2 small';

      const score = document.createElement('span');
      score.className = 'badge bg-light text-dark float-end';
      score.textContent = result.score;
      card.appendChild(score);

      const content = document.createElement('div');
      content.textContent = result.content;
      card.appendChild(content);

      results.appendChild(card);
    });
  } catch (error) {
    showNotification(error.message, 'error');
    results.innerHTML = '';
  }
}

export function setupKnowledge() {
  if (!document.getElementById('kb-source-list')) {
    return;
  }

  document.getElementById('kb-add-url')?.addEventListener('click', addUrl);
  document.getElementById('kb-add-text')?.addEventListener('click', addText);
  document.getElementById('kb-reload')?.addEventListener('click', load);
  document.getElementById('kb-test')?.addEventListener('click', testSearch);

  document.getElementById('kb-test-query')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      testSearch();
    }
  });

  setupCompanyPicker().then(load);
}
