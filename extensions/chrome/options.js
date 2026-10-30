import { apiFetch, getConfig, normalizeServerUrl, originPattern, setConfig } from './lib.js';

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

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

/**
 * The extension only has access to the server you choose. Chrome asks once per server; this must run in direct
 * response to a click, so it is the first await after the click.
 */
async function allowServer(serverUrl) {
  return chrome.permissions.request({ origins: [originPattern(serverUrl)] });
}

async function checkConnection(config) {
  const data = await apiFetch(config, '/api/bootstrap');
  const items = data.stats?.all ?? 0;
  const folders = data.folders?.length ?? 0;
  return `Connected: ${items} item${items === 1 ? '' : 's'}, ${folders} folder${folders === 1 ? '' : 's'}.`;
}

/** Validate, ask Chrome for access to the server, save, then test the connection. */
async function save() {
  const config = readForm();
  if (!config.serverUrl) return setStatus('Enter your Abacus server, for example http://my-server:8090', 'error');
  if (!(await allowServer(config.serverUrl))) {
    return setStatus('Chrome needs access to your Abacus server to save to it. Click again and choose Allow.', 'error');
  }
  await setConfig(config);
  $('serverUrl').value = config.serverUrl;
  setStatus('Saved. Testing…');
  try {
    setStatus(`Saved. ${await checkConnection(config)}`, 'ok');
  } catch (err) {
    setStatus(`Saved, but the test failed: ${err.message}`, 'error');
  }
}

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});

(async () => {
  const config = await getConfig();
  for (const field of FIELDS) $(field).value = config[field] || '';
  if (!config.serverUrl) setStatus('Enter your Abacus server to get started.');
})();
