import { addToAbacus, getConfig, parseTagList } from './lib.js';

const $ = (id) => document.getElementById(id);

let config = null;
// Only send a page title when edited, preserving the title read by the importer otherwise.
let prefilledName = '';
let closeTimer;

function setButton(state, text) {
  const button = $('save');
  button.dataset.state = state;
  button.textContent = text;
  button.disabled = state !== 'idle';
  button.setAttribute('aria-busy', String(state === 'saving' || state === 'importing'));
  button.title = state === 'importing' ? 'You can close this popup; the import continues in Abacus.' : '';
}

function clearErrors() {
  for (const field of ['url', 'notes']) {
    $(field).removeAttribute('aria-invalid');
    $(`${field}-error`).hidden = true;
    $(`${field}-error`).textContent = '';
  }
}

function showFieldError(field, message, { invalid = false, warning = false } = {}) {
  const error = $(`${field}-error`);
  error.textContent = message;
  error.className = warning ? 'field-error warn' : 'field-error';
  error.hidden = false;
  if (invalid) $(field).setAttribute('aria-invalid', 'true');
}

function validUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function init() {
  config = await getConfig();
  $('folder').value = config.folder;
  $('tags').value = config.tags;
  $('open-app').disabled = !config.serverUrl;
  if (!config.serverUrl) {
    showFieldError('url', 'Connect your Abacus server in extension settings first.');
    setButton('unconfigured', 'Set up Abacus first');
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && validUrl(tab.url)) {
      $('url').value = tab.url;
      prefilledName = tab.title || '';
      $('name').value = prefilledName;
    }
  } catch {
    /* no access to this tab (chrome:// pages) */
  }
  setButton('idle', 'Save to Abacus');
}

$('open-app').addEventListener('click', async () => {
  if (!config?.serverUrl) return;
  try {
    await chrome.tabs.create({ url: config.serverUrl });
  } catch {
    showFieldError('url', 'Could not open Abacus. Try again.');
  }
});
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('form').addEventListener('input', () => {
  if (!config?.serverUrl) return;
  clearErrors();
  if (['saved', 'warning'].includes($('save').dataset.state)) {
    clearTimeout(closeTimer);
    setButton('idle', 'Save to Abacus');
  }
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if ($('save').disabled) return;
  clearErrors();
  const url = $('url').value.trim();
  const notes = $('notes').value.trim();
  const name = $('name').value.trim();
  if (!url && !notes) {
    showFieldError('url', 'Add a URL or write a note below.', { invalid: true });
    $('url').focus();
    return;
  }
  if (url && !validUrl(url)) {
    showFieldError('url', 'Enter a valid http:// or https:// URL.', { invalid: true });
    $('url').focus();
    return;
  }
  setButton('saving', 'Saving…');
  try {
    const data = await addToAbacus(
      {
        url: url || undefined,
        name: (url ? name !== prefilledName : true) ? name || undefined : undefined,
        folder: $('folder').value.trim() || undefined,
        tags: parseTagList($('tags').value),
        notes: notes || undefined,
      },
      {
        config,
        onPending: async (data) => {
          const response = await chrome.runtime.sendMessage({ type: 'track-import', data, config });
          if (!response?.ok) throw new Error(response?.error || 'Could not follow the import in the background.');
        },
        onProgress: () => setButton('importing', 'Importing…'),
      }
    );
    if (data.warnings?.length || data.failed) {
      setButton('warning', 'Saved with warnings');
      showFieldError(url ? 'url' : 'notes', data.warnings?.join(' ') || 'Some items could not be saved.', { warning: true });
    } else {
      setButton('saved', data.skipped && !data.created ? 'Already saved' : 'Saved');
      closeTimer = setTimeout(() => window.close(), 1400);
    }
  } catch (err) {
    showFieldError(url ? 'url' : 'notes', err.message);
    setButton('idle', 'Save to Abacus');
  }
});

init().catch(() => {
  showFieldError('url', 'Could not load settings. Reopen the popup to try again.');
  setButton('unconfigured', 'Reopen to try again');
});
