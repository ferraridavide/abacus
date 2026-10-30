import { addToAbacus, apiFetch, folderPaths, getConfig, parseTagList, summarize } from './lib.js';

const $ = (id) => document.getElementById(id);

let config = null;
// The tab title the Name field was filled with; the name is only sent when you change it, so links otherwise
// keep the title Abacus reads from the page (a post's text, a video's title, ...).
let prefilledName = '';

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = kind;
}

function setResult(text, kind = '') {
  const el = $('result');
  el.textContent = text;
  el.className = `result ${kind}`.trim();
  el.hidden = !text;
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

async function loadFolders() {
  const datalist = $('folders');
  datalist.replaceChildren();
  try {
    const data = await apiFetch(config, '/api/bootstrap');
    for (const path of folderPaths(data.folders)) {
      const option = document.createElement('option');
      option.value = path;
      datalist.append(option);
    }
    setStatus(`${data.stats?.all ?? 0} items · ${hostOf(config.serverUrl)}`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

async function init() {
  config = await getConfig();
  $('folder').value = config.folder;
  $('tags').value = config.tags;
  if (!config.serverUrl) {
    setStatus('Set up your Abacus server first (⚙)', 'error');
    $('save').disabled = true;
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https?:/i.test(tab.url)) {
      $('url').value = tab.url;
      prefilledName = tab.title || '';
      $('name').value = prefilledName;
    }
  } catch {
    /* no access to this tab (chrome:// pages) */
  }
  await loadFolders();
}

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $('url').value.trim();
  const notes = $('notes').value.trim();
  const name = $('name').value.trim();
  if (!url && !notes) return setResult('Add a URL or a note first.', 'error');
  if (url && !/^https?:\/\//i.test(url)) return setResult('Only http:// and https:// links can be saved.', 'error');

  const button = $('save');
  button.disabled = true;
  button.textContent = 'Saving…';
  setResult('');

  try {
    const data = await addToAbacus(
      {
        url: url || undefined,
        // For a link, only a title you typed; for a note, whatever is there.
        name: (url ? name !== prefilledName : true) ? name || undefined : undefined,
        folder: $('folder').value.trim() || undefined,
        tags: parseTagList($('tags').value),
        notes: notes || undefined,
      },
      {
        config,
        onProgress: () => {
          button.textContent = 'Importing…';
          setResult('Downloading. You can close this; the import continues in Abacus.');
        },
      }
    );
    setResult(`✓ ${summarize(data)}`, data.warnings?.length ? 'warn' : 'ok');
    if (!data.warnings?.length) setTimeout(() => window.close(), 1400);
    button.textContent = 'Saved';
  } catch (err) {
    setResult(err.message, 'error');
    button.disabled = false;
    button.textContent = 'Save to Abacus';
  }
});

init().catch((err) => setStatus(err.message, 'error'));
