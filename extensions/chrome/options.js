import { apiFetch, getConfig, normalizeServerUrl, originPattern, setConfig } from './lib.js';
import { initTheme, syncTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['serverUrl', 'token', 'username', 'password', 'folder', 'tags'];

function readForm() {
  return {
    serverUrl: normalizeServerUrl($('serverUrl').value),
    token: $('token').value.trim(),
    username: $('username').value.trim(),
    password: $('password').value,
    folder: $('folder').value.trim(),
    tags: $('tags').value.trim(),
  };
}

function setStatus(text, kind = '', detail = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `connection-status ${kind || 'pending'}`;
  el.hidden = !text;
  $('status-detail').textContent = detail;
  $('status-detail').hidden = !detail;
}

/**
 * The extension only has access to the server you choose. Chrome asks once per server; this must run in direct
 * response to a click, so it is the first await after the click.
 */
async function allowServer(serverUrl) {
  return chrome.permissions.request({ origins: [originPattern(serverUrl)] });
}

/** Validate, ask Chrome for access, save, then test the authenticated connection. */
async function save() {
  const config = readForm();
  if (!config.serverUrl) return setStatus('Check settings', 'error', 'Enter your Abacus server address.');
  if (!config.token && !config.username) return setStatus('Check settings', 'error', 'Add an API token or server login.');
  const button = $('save-settings');
  button.disabled = true;
  try {
    if (!(await allowServer(config.serverUrl))) {
      return setStatus('Access needed', 'error', 'Allow Chrome to access your Abacus server, then try again.');
    }
    await setConfig(config);
    $('serverUrl').value = config.serverUrl;
    setStatus('Connecting…');
    try {
      await apiFetch(config, '/api/bootstrap');
      // the extension wears the library's theme, so pull it as soon as the connection works
      await syncTheme(config);
      setStatus('Connected', 'ok', 'Settings saved.');
    } catch (err) {
      setStatus('Connection failed', 'error', `Settings saved. ${err.message}`);
    }
  } catch (err) {
    setStatus('Could not save', 'error', err.message);
  } finally {
    button.disabled = false;
  }
}

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});

function bindPreference(id, statusId) {
  $(id).addEventListener('change', async (event) => {
    const toggle = event.target;
    const status = $(statusId);
    toggle.disabled = true;
    status.hidden = true;
    try {
      await setConfig({ [id]: toggle.checked });
    } catch (err) {
      toggle.checked = !toggle.checked;
      status.textContent = `Could not save preference: ${err.message}`;
      status.className = 'status error';
      status.hidden = false;
    } finally {
      toggle.disabled = false;
    }
  });
}

function renderShortcut(shortcut) {
  const binding = $('shortcut-binding');
  binding.replaceChildren();
  if (!shortcut) {
    binding.textContent = 'Not assigned';
    return;
  }
  shortcut.split('+').forEach((key, index) => {
    if (index) {
      const separator = document.createElement('span');
      separator.className = 'shortcut-plus';
      separator.textContent = '+';
      binding.append(separator);
    }
    const keycap = document.createElement('kbd');
    keycap.textContent = key;
    binding.append(keycap);
  });
}

async function refreshShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((command) => command.name === 'save-page')?.shortcut;
    renderShortcut(shortcut);
    $('change-shortcut').setAttribute('aria-label', shortcut
      ? `Change keyboard shortcut, currently ${shortcut}, in Chrome`
      : 'Assign keyboard shortcut in Chrome');
  } catch {
    $('shortcut-binding').textContent = 'Check the assignment in Chrome';
  }
}

const ALL_SITES = ['http://*/*', 'https://*/*'];

function pageToolsStatus(text, kind = 'error') {
  const status = $('page-tools-status');
  status.textContent = text;
  status.className = `status ${kind}`;
  status.hidden = !text;
}

/**
 * Drag and Alt + right-click run inside pages, so Chrome must grant access to websites. The request has to be the
 * first await after the click. Turning a tool on without access would do nothing, so the switch goes back off.
 */
function bindPageTool(id) {
  $(id).addEventListener('change', async (event) => {
    const toggle = event.target;
    pageToolsStatus('');
    try {
      if (toggle.checked && !(await chrome.permissions.request({ origins: ALL_SITES }))) {
        toggle.checked = false;
        return pageToolsStatus('Allow access to websites in Chrome to use this tool.');
      }
      await setConfig({ [id]: toggle.checked });
    } catch (err) {
      toggle.checked = !toggle.checked;
      pageToolsStatus(`Could not save preference: ${err.message}`);
    }
  });
}

bindPageTool('dragToSave');
bindPageTool('altClickSave');
bindPreference('hdEnabled', 'page-tools-status');
$('screenshotFormat').addEventListener('change', async (event) => {
  try {
    await setConfig({ screenshotFormat: event.target.value });
    pageToolsStatus('');
  } catch (err) {
    pageToolsStatus(`Could not save preference: ${err.message}`);
  }
});

bindPreference('contextMenuEnabled', 'context-menu-status');
bindPreference('keyboardShortcutEnabled', 'shortcut-status');
$('change-shortcut').addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  } catch (err) {
    const status = $('shortcut-status');
    status.textContent = `Open chrome://extensions/shortcuts to edit the shortcut. ${err.message}`;
    status.className = 'status error';
    status.hidden = false;
  }
});
window.addEventListener('focus', refreshShortcut);
refreshShortcut();

initTheme().catch(() => {});

(async () => {
  const config = await getConfig();
  for (const field of FIELDS) $(field).value = config[field] || '';
  for (const field of ['contextMenuEnabled', 'keyboardShortcutEnabled', 'hdEnabled']) {
    $(field).checked = config[field];
    $(field).disabled = false;
  }
  // The tools only work while Chrome still grants access to websites; show them off if it was revoked.
  const granted = await chrome.permissions.contains({ origins: ALL_SITES }).catch(() => false);
  for (const field of ['dragToSave', 'altClickSave']) {
    $(field).checked = config[field] && granted;
    $(field).disabled = false;
  }
  $('screenshotFormat').value = config.screenshotFormat;
  $('screenshotFormat').disabled = false;
  if (!config.serverUrl) setStatus('Not configured', 'error', 'Enter your server address and API token to get started.');
})();
