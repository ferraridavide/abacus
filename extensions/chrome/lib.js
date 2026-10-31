/**
 * Shared helpers for the Abacus Chrome extension. Everything goes through the server's POST /api/add endpoint.
 */

const STORAGE_KEY = 'config';
export const SCREENSHOT_FORMATS = ['png', 'jpeg', 'webp'];
export const MAX_RECENT_FOLDERS = 5;

// How often, and for how long, to follow an import job (video downloads can take minutes).
const POLL_MS = 1500;
export const POLL_LIMIT_MS = 15 * 60 * 1000;

// Credentials stay in this browser profile: chrome.storage.local is not synced to Google.
export async function getConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const config = stored[STORAGE_KEY] || {};
  return {
    serverUrl: normalizeServerUrl(config.serverUrl || ''),
    token: config.token || '',
    username: config.username || '',
    password: config.password || '',
    folder: config.folder || '',
    tags: config.tags || '',
    contextMenuEnabled: (config.contextMenuEnabled ?? config.pageContextMenuEnabled) === true,
    keyboardShortcutEnabled: config.keyboardShortcutEnabled === true,
    // Page tools need access to every site, which Chrome only grants through a prompt, so they start off.
    dragToSave: config.dragToSave === true,
    altClickSave: config.altClickSave === true,
    hdEnabled: config.hdEnabled !== false,
    screenshotFormat: SCREENSHOT_FORMATS.includes(config.screenshotFormat) ? config.screenshotFormat : 'png',
    recentFolders: Array.isArray(config.recentFolders)
      ? config.recentFolders.filter((f) => typeof f === 'string' && f.trim()).slice(0, MAX_RECENT_FOLDERS)
      : [],
  };
}

let configUpdate = Promise.resolve();
export function setConfig(patch) {
  configUpdate = configUpdate.catch(() => {}).then(async () => {
    const next = { ...(await getConfig()), ...patch };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  });
  return configUpdate;
}

/** "host:8090/" -> "http://host:8090". Returns '' for an empty or invalid value. */
export function normalizeServerUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'http://' + raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** The match pattern Chrome needs permission for, e.g. "http://abacus.example:8090/*". */
export const originPattern = (serverUrl) => new URL(serverUrl).origin + '/*';

/** Bearer token when present, otherwise the HTTP basic login. */
export function authHeaders(config) {
  if (config.token) return { authorization: `Bearer ${config.token}` };
  if (!config.username) return {};
  const bytes = new TextEncoder().encode(`${config.username}:${config.password || ''}`);
  return { authorization: 'Basic ' + btoa(String.fromCharCode(...bytes)) };
}

export async function apiFetch(config, pathname, options = {}) {
  if (!config.serverUrl) throw new Error('Set your Abacus server in the extension options first.');
  let res;
  try {
    res = await fetch(config.serverUrl + pathname, {
      ...options,
      headers: { ...authHeaders(config), ...(options.headers || {}) },
    });
  } catch (err) {
    throw new Error(`Cannot reach ${config.serverUrl} (${err.message}). Is this device on the network that can reach it?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = res.status === 401
      ? 'Abacus rejected the token or login. Check the extension options.'
      : data.error || `Abacus returned HTTP ${res.status}`;
    throw Object.assign(new Error(message), { status: res.status });
  }
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function resultFromJob(data, job) {
  if (job.failed && !job.imported && !job.skipped) {
    throw new Error(job.entries.find((e) => e.error)?.error || 'The import failed');
  }
  return { ...data, ok: job.failed === 0, pending: false, job, created: job.imported, skipped: job.skipped, failed: job.failed };
}

/** Submit without waiting; background imports are tracked persistently by pending-jobs.js. */
export async function submitToAbacus(payload, config) {
  return apiFetch(config, '/api/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, async: true }),
  });
}

/**
 * Add to Abacus and wait in the popup. `onPending(data)` registers background tracking before showing progress,
 * so closing the popup doesn't lose the completion notification. Background callers use submitToAbacus instead.
 * `onProgress(job)` is called on every poll. Rejects with the server's reason when nothing could be saved.
 */
export async function addToAbacus(payload, { config, onProgress, onPending } = {}) {
  config ||= await getConfig();
  const data = await submitToAbacus(payload, config);
  let job = data.job;
  if (!job) return data;
  if (job.status !== 'done') await onPending?.(data);

  const started = Date.now();
  while (job.status !== 'done') {
    if (Date.now() - started > POLL_LIMIT_MS) throw new Error('Still importing after 15 minutes; check Abacus later.');
    onProgress?.(job);
    await sleep(POLL_MS);
    job = await apiFetch(config, '/api/jobs/' + job.id);
  }
  return resultFromJob(data, job);
}

/**
 * Add one file (a screenshot, or an image that only the page can read) with POST /api/add as multipart.
 * `fields` are plain strings (`tags` may be an array); empty ones are left out. Resolves like any other add.
 */
export async function uploadToAbacus(blob, fields, config, fileName = 'upload') {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields || {})) {
    const text = Array.isArray(value) ? value.join(',') : value;
    if (text !== undefined && text !== null && text !== '') form.append(key, String(text));
  }
  form.append('file', blob, fileName);
  return apiFetch(config, '/api/add', { method: 'POST', body: form });
}

/**
 * Follow a job for up to `timeoutMs`. Resolves with the result when it finishes in time and with null when it is
 * still running, so the caller can hand it to the background tracker. Rejects with the server's reason on failure.
 */
export async function waitForJob(config, data, { timeoutMs = 8000, intervalMs = 500 } = {}) {
  let job = data.job;
  if (!job) return data;
  const started = Date.now();
  while (job.status !== 'done') {
    if (Date.now() - started > timeoutMs) return null;
    await sleep(intervalMs);
    job = await apiFetch(config, '/api/jobs/' + job.id);
  }
  return resultFromJob(data, job);
}

/** Put a folder first in the short "recent folders" list that the drag dock offers. */
export async function rememberFolder(folder) {
  const name = String(folder || '').trim();
  if (!name) return;
  const { recentFolders } = await getConfig();
  if (recentFolders[0]?.toLowerCase() === name.toLowerCase()) return;
  const next = [name, ...recentFolders.filter((f) => f.toLowerCase() !== name.toLowerCase())].slice(0, MAX_RECENT_FOLDERS);
  await setConfig({ recentFolders: next });
}

/**
 * The /api/add body for an image or video found on a page. `candidates` come best first: the server tries the first
 * and falls back to the others, and sends the page as the Referer so hotlink-protected files still download.
 */
export function mediaPayload(media, { folder, tags } = {}) {
  const urls = (media.candidates || []).filter((u) => /^https?:\/\//i.test(u));
  const [url, ...rest] = urls;
  return {
    url,
    ...(rest.length ? { fallbackUrls: rest.slice(0, 3) } : {}),
    ...(/^https?:\/\//i.test(media.pageUrl || '') ? { pageUrl: media.pageUrl } : {}),
    folder,
    tags,
  };
}

export function parseTagList(value) {
  return String(value || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** Full paths ("Design / Logos") of every folder, for the folder picker. */
export function folderPaths(folders = []) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (f, seen = new Set()) => {
    const parent = f.parentId && byId.get(f.parentId);
    if (!parent || seen.has(parent.id)) return f.name;
    seen.add(f.id);
    return `${pathOf(parent, seen)} / ${f.name}`;
  };
  return folders.map((f) => pathOf(f)).sort((a, b) => a.localeCompare(b));
}

/** One-line human summary of an /api/add result. */
export function summarize(data) {
  const parts = [];
  if (data.created) parts.push(`${data.created} saved`);
  if (data.skipped) parts.push(`${data.skipped} already in your library`);
  if (data.failed) parts.push(`${data.failed} failed`);
  const text = parts.length ? parts.join(' · ') : 'Saved';
  return data.warnings?.length ? `${text}. ${data.warnings.join('. ')}` : text;
}
