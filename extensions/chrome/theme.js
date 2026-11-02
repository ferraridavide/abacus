/**
 * Keeps every extension surface in step with the library's theme.
 *
 * The server owns the theme (Settings → Appearance), the extension reads it on connect and on every popup open,
 * caches it in chrome.storage.local and in a localStorage mirror (theme-boot.js paints that one before the first
 * frame), and repaints whenever it changes.
 */
import './theme-boot.js'; // classic script, imported so the service worker has the same primitives
import { apiFetch, getConfig } from './lib.js';

const T = globalThis.AbacusTheme;
const CHROME_KEY = 'theme';

export const DEFAULT_THEME = T.normalize(null);

/** Read the cached theme; never throws, never returns null. */
export async function getTheme() {
  try {
    const stored = await chrome.storage.local.get(CHROME_KEY);
    return T.normalize(stored[CHROME_KEY]);
  } catch {
    return T.cached() || DEFAULT_THEME;
  }
}

export function applyTheme(theme, root) {
  T.apply(T.normalize(theme), root);
}

/** Fetch the theme from the server and cache it. Returns null when the server can't be reached. */
export async function syncTheme(config) {
  const conf = config || (await getConfig());
  if (!conf.serverUrl) return null;
  try {
    const theme = T.normalize(await apiFetch(conf, '/api/settings/appearance'));
    await chrome.storage.local.set({ [CHROME_KEY]: theme });
    T.cache(theme);
    return theme;
  } catch {
    // offline: keep the cached theme rather than repainting the default
    return null;
  }
}

/**
 * Paint the cached theme now, follow later changes, and refresh from the server in the background. Every extension
 * page calls this on load; the popup and the options page also call syncTheme after a connection test.
 */
export async function initTheme() {
  const theme = await getTheme();
  applyTheme(theme);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[CHROME_KEY]) applyTheme(changes[CHROME_KEY].newValue);
  });

  syncTheme().catch(() => {});
  return theme;
}
