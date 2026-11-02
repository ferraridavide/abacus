import {
  getConfig, mediaPayload, parseTagList, rememberFolder, submitToAbacus, summarize, uploadToAbacus, waitForJob,
} from './lib.js';
import { createImportTracker } from './pending-jobs.js';
import { EXTENSION, stitchRegion } from './screenshot.js';
import { getTheme, syncTheme } from './theme.js';

const MENUS = [
  { id: 'abacus-page', title: 'Save to Abacus', contexts: ['page', 'frame'] },
  { id: 'abacus-link', title: 'Save link to Abacus', contexts: ['link'] },
  { id: 'abacus-image', title: 'Save image to Abacus', contexts: ['image'] },
  { id: 'abacus-selection', title: 'Save selection to Abacus', contexts: ['selection'] },
  { id: 'abacus-batch', title: 'Save all images on this page…', contexts: ['page', 'frame'] },
  { id: 'abacus-shot', title: 'Screenshot to Abacus', contexts: ['page', 'frame'] },
  { id: 'abacus-shot-area', parentId: 'abacus-shot', title: 'Capture area', contexts: ['page', 'frame'] },
  { id: 'abacus-shot-element', parentId: 'abacus-shot', title: 'Capture element', contexts: ['page', 'frame'] },
  { id: 'abacus-shot-full', parentId: 'abacus-shot', title: 'Full page', contexts: ['page', 'frame'] },
  { id: 'abacus-shot-visible', parentId: 'abacus-shot', title: 'Visible area', contexts: ['page', 'frame'] },
];
const SHOT_MODES = {
  'abacus-shot-area': 'area',
  'abacus-shot-element': 'element',
  'abacus-shot-full': 'full',
  'abacus-shot-visible': 'visible',
};
const COMMAND_SHOTS = { 'screenshot-area': 'area', 'screenshot-element': 'element', 'screenshot-full': 'full' };

const isHttp = (url) => /^https?:\/\//i.test(url || '');
const unique = (list) => [...new Set(list.filter(Boolean))];

// Serialize rebuilds so lifecycle and preference changes cannot create duplicate menu IDs.
let menuUpdate = Promise.resolve();
function createMenus() {
  menuUpdate = menuUpdate.catch(() => {}).then(async () => {
    const { contextMenuEnabled } = await getConfig();
    await chrome.contextMenus.removeAll();
    if (contextMenuEnabled) {
      for (const menu of MENUS) chrome.contextMenus.create(menu);
    }
  });
  return menuUpdate;
}

// ---------- page tools: the content script exists only while a tool that needs it is on ----------

const CONTENT_ID = 'abacus-content';
const ALL_SITES = ['http://*/*', 'https://*/*'];
let scriptSync = Promise.resolve();

/**
 * Register content.js (drag to the dock, Alt + right-click) when one of those tools is on and Chrome has granted
 * access to websites; unregister it otherwise. Pages that are already open get it right away.
 */
function syncContentScripts({ refresh = false } = {}) {
  scriptSync = scriptSync.catch(() => {}).then(async () => {
    if (!chrome.scripting?.registerContentScripts || !chrome.permissions?.contains) return;
    const config = await getConfig();
    const wanted = config.dragToSave || config.altClickSave;
    const granted = wanted && (await chrome.permissions.contains({ origins: ALL_SITES }));
    let existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_ID] });
    if (existing.length && (!granted || refresh)) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_ID] });
      existing = [];
    }
    if (!granted || existing.length) return;
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_ID,
      matches: ALL_SITES,
      js: ['theme-boot.js', 'hd.js', 'content.js'],
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true,
    }]);
    const tabs = await chrome.tabs.query({ url: ALL_SITES });
    await Promise.all(tabs.map((tab) => chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['theme-boot.js', 'hd.js', 'content.js'] })
      .catch(() => {})));
  });
  return scriptSync;
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  syncTheme().catch(() => {});
  createMenus().catch((err) => fail(err.message));
  syncContentScripts({ refresh: reason === 'update' }).catch(() => {});
  // There is no default server: ask for one right away.
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => {
  syncTheme().catch(() => {});
  createMenus().catch((err) => fail(err.message));
  syncContentScripts().catch(() => {});
  imports.resume().catch((err) => fail(err.message));
});
chrome.permissions?.onRemoved?.addListener(() => syncContentScripts().catch(() => {}));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.config) return;
  const { oldValue, newValue } = changes.config;
  const flag = (value, key) => value?.[key] === true;
  if (['dragToSave', 'altClickSave'].some((key) => flag(oldValue, key) !== flag(newValue, key))) {
    syncContentScripts().catch(() => {});
  }
  const wasEnabled = (oldValue?.contextMenuEnabled ?? oldValue?.pageContextMenuEnabled) === true;
  const enabled = (newValue?.contextMenuEnabled ?? newValue?.pageContextMenuEnabled) === true;
  if (wasEnabled === enabled) return;
  createMenus().catch((err) => fail(err.message));
});

// ---------- feedback ----------

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message: String(message).slice(0, 300),
    });
  } catch {
    /* notifications are a nicety, not a requirement */
  }
}

async function flashBadge(text, color, clear = true) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    if (clear) setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } catch {
    /* the service worker may be stopping */
  }
}

async function fail(message) {
  await notify('Abacus: save failed', message);
  await flashBadge('!', '#e03131');
  return null;
}

const imports = createImportTracker({
  onComplete: async (data) => {
    await notify('Saved to Abacus', summarize(data));
    await flashBadge('✓', '#2f9e44');
  },
  onError: (err) => fail(err.message),
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  imports.poll(name).catch((err) => fail(err.message));
});

// ---------- saving ----------

async function save(payload) {
  try {
    const config = await getConfig();
    const tags = payload.tags ?? parseTagList(config.tags);
    const theme = await getTheme().catch(() => null);
    await flashBadge('…', theme?.accent?.hex || '#e8a33d', false);
    const data = await submitToAbacus({ ...payload, folder: payload.folder ?? config.folder, tags }, config);
    await imports.track(data, config);
    return data;
  } catch (err) {
    return fail(err.message);
  }
}

const extensionOf = (mime) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg' }[mime] || 'png');

/**
 * Save an image or video found on a page. `media`: { candidates (best first), inline (a data: URL the page had to
 * read itself), pageUrl, title }. A short wait lets the page's toast say what happened; slower imports are handed
 * to the background tracker, which notifies when they finish. Resolves { status: 'ok' | 'pending' | 'error', message }.
 */
async function saveFromPage(media, folder) {
  try {
    const config = await getConfig();
    if (!config.serverUrl) throw new Error('Set your Abacus server in the extension options first.');
    const tags = parseTagList(config.tags);
    const target = folder || config.folder;
    let data;
    if (!media.candidates?.length && media.inline) {
      const blob = await (await fetch(media.inline)).blob();
      data = await uploadToAbacus(
        blob,
        { pageUrl: isHttp(media.pageUrl) ? media.pageUrl : '', folder: target, tags, name: media.title, source: 'web' },
        config,
        `image.${extensionOf(blob.type)}`
      );
    } else {
      if (!media.candidates?.length) throw new Error('There is no image address to save here.');
      data = await submitToAbacus({ ...mediaPayload(media, { folder: target, tags }), name: media.title || undefined }, config);
    }
    const result = await waitForJob(config, data);
    if (!result) {
      await imports.track(data, config);
      return { status: 'pending', message: 'Saving… Abacus will notify you when it is done.' };
    }
    if (target) await rememberFolder(target);
    return { status: 'ok', message: `${summarize(result)}${target ? ` · ${target}` : ''}` };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/** Report a saveFromPage result for callers with no page to show a toast in (the context menu). */
async function announce(result) {
  if (result.status === 'error') return fail(result.message);
  if (result.status === 'ok') {
    await notify('Saved to Abacus', result.message);
    await flashBadge('✓', '#2f9e44');
  }
  return result;
}

// ---------- reading a page (activeTab) ----------

async function run(tabId, { target, script }) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId, ...target }, ...script });
  return result?.result;
}

/** The image behind a right-click, with its higher-resolution candidates, when the page lets us look. */
async function describeContextImage(tab, info) {
  const target = { frameIds: [info.frameId || 0] };
  if (/^(?:blob|data):/i.test(info.srcUrl || '')) {
    // A data: URL is already everything there is; only the page can read a blob:, so ask it for the bytes.
    if (info.srcUrl.startsWith('data:')) return { candidates: [], inline: info.srcUrl };
    const inline = await run(tab.id, {
      target,
      script: {
        args: [info.srcUrl],
        func: async (src) => {
          const blob = await (await fetch(src)).blob();
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        },
      },
    });
    return { candidates: [], inline };
  }
  const { hdEnabled } = await getConfig();
  if (!hdEnabled || !tab?.id) return { candidates: [info.srcUrl] };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, ...target }, files: ['hd.js'] });
    const found = await run(tab.id, {
      target,
      script: {
        args: [info.srcUrl],
        func: (src) => {
          const elements = [...document.images, ...document.querySelectorAll('video')];
          const element = elements.find((e) => (e.currentSrc || e.src) === src) || elements.find((e) => e.src === src);
          return element ? globalThis.__abacusHd.describe(element, { hd: true }) : null;
        },
      },
    });
    return { candidates: unique([...(found?.candidates || []), info.srcUrl]), title: found?.title };
  } catch {
    // No access to this page (or frame): the address Chrome gave us is still good.
    return { candidates: [info.srcUrl] };
  }
}

// ---------- screenshots ----------

async function pageCall(tabId, name, ...args) {
  return run(tabId, {
    script: { args: [name, args], func: (n, a) => globalThis.__abacusCapture?.[n]?.(...a) },
  });
}

async function startScreenshot(tab, mode) {
  try {
    if (!isHttp(tab?.url)) return await fail('This page cannot be captured.');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['theme-boot.js', 'capture.js'] });
    if (mode === 'area' || mode === 'element') {
      // The result arrives as a 'screenshot-result' message once the user has chosen.
      await pageCall(tab.id, 'pick', mode);
      return null;
    }
    const info = await pageCall(tab.id, 'info');
    const region = mode === 'full'
      ? { x: 0, y: 0, w: info.scrollWidth, h: info.scrollHeight }
      : { x: info.scrollX, y: info.scrollY, w: info.innerWidth, h: info.innerHeight };
    return await finishScreenshot(tab, region);
  } catch (err) {
    return fail(err.message);
  }
}

async function finishScreenshot(tab, region) {
  try {
    const config = await getConfig();
    if (!config.serverUrl) throw new Error('Set your Abacus server in the extension options first.');
    await flashBadge('…', '#5b8cff', false);
    const blob = await stitchRegion({
      windowId: tab.windowId,
      page: (name, ...args) => pageCall(tab.id, name, ...args),
      region,
      format: config.screenshotFormat,
      onStrip: (done, total) => total > 1 && flashBadge(`${done + 1}/${total}`, '#5b8cff', false),
    });
    const title = (tab.title || new URL(tab.url).hostname).trim();
    const data = await uploadToAbacus(
      blob,
      {
        name: `Screenshot - ${title}`.slice(0, 110),
        pageUrl: tab.url,
        folder: config.folder,
        tags: parseTagList(config.tags),
        source: 'web',
      },
      config,
      `screenshot.${EXTENSION[config.screenshotFormat] || 'png'}`
    );
    if (config.folder) await rememberFolder(config.folder);
    await notify('Screenshot saved to Abacus', summarize(data));
    await flashBadge('✓', '#2f9e44');
    return data;
  } catch (err) {
    return fail(err.message);
  }
}

// ---------- batch save ----------

const BATCH_KEEP_MS = 60 * 60 * 1000;

/** Read every image on the page now, while we are allowed to, and let batch.html pick which to save. */
async function openBatch(tab) {
  try {
    if (!isHttp(tab?.url)) return await fail('This page cannot be scanned.');
    const { hdEnabled } = await getConfig();
    const scan = async (allFrames) => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames }, files: ['hd.js'] });
      return chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames },
        args: [hdEnabled],
        func: (hd) => globalThis.__abacusHd.scan(document, { hd }),
      });
    };
    let results;
    try {
      results = await scan(true);
    } catch {
      results = await scan(false);
    }
    const seen = new Set();
    const images = results.flatMap((r) => r.result || []).filter((image) => {
      if (seen.has(image.candidates[0])) return false;
      seen.add(image.candidates[0]);
      return true;
    }).slice(0, 1500);
    if (!images.length) return await fail('No images found on this page.');

    const stored = await chrome.storage.session.get(null);
    const stale = Object.entries(stored)
      .filter(([key, value]) => key.startsWith('batch:') && Date.now() - (value.createdAt || 0) > BATCH_KEEP_MS)
      .map(([key]) => key);
    if (stale.length) await chrome.storage.session.remove(stale);
    const id = crypto.randomUUID();
    await chrome.storage.session.set({ [`batch:${id}`]: { createdAt: Date.now(), pageUrl: tab.url, title: tab.title || '', images } });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`batch.html?id=${id}`), index: tab.index + 1, openerTabId: tab.id });
    return null;
  } catch (err) {
    return fail(err.message);
  }
}

// ---------- messages ----------

// Register listeners synchronously, then recover jobs whenever Chrome starts a fresh worker.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'track-import') {
    imports.track(message.data, message.config).then(
      () => respond({ ok: true }),
      (err) => respond({ error: err.message })
    );
    return true;
  }
  if (message?.type === 'save-media') {
    saveFromPage({ ...message.media, pageUrl: message.media?.pageUrl || sender.tab?.url }, message.folder).then(respond);
    return true;
  }
  if (message?.type === 'screenshot-result') {
    if (sender.tab) finishScreenshot(sender.tab, message.rect);
    return;
  }
  if (message?.type === 'start-screenshot' || message?.type === 'open-batch') {
    // From the popup: opening it granted access to the active tab.
    chrome.tabs.get(message.tabId).then(
      (tab) => (message.type === 'open-batch' ? openBatch(tab) : startScreenshot(tab, message.mode)),
      (err) => fail(err.message)
    );
    respond({ ok: true });
  }
});
imports.resume().catch((err) => fail(err.message));

// ---------- context menu and keyboard ----------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!(await getConfig()).contextMenuEnabled) return;
  if (SHOT_MODES[info.menuItemId]) return startScreenshot(tab, SHOT_MODES[info.menuItemId]);
  if (info.menuItemId === 'abacus-batch') return openBatch(tab);
  if (info.menuItemId === 'abacus-image') {
    if (!info.srcUrl) return fail('This image has no address to save.');
    if (!isHttp(info.srcUrl) && !/^(?:blob|data):/i.test(info.srcUrl)) return fail('Only http(s) images can be saved.');
    const media = await describeContextImage(tab, info).catch(() => ({ candidates: isHttp(info.srcUrl) ? [info.srcUrl] : [] }));
    await flashBadge('…', '#5b8cff', false);
    return announce(await saveFromPage({ ...media, pageUrl: info.frameUrl || info.pageUrl }));
  }
  if (info.menuItemId === 'abacus-link') {
    if (!isHttp(info.linkUrl)) return fail('Only http(s) links can be saved.');
    return save({ url: info.linkUrl });
  }
  if (info.menuItemId === 'abacus-selection') {
    const text = (info.selectionText || '').trim();
    const url = /https?:\/\/\S+/.exec(text)?.[0];
    if (url) return save({ url });
    if (!text) return fail('The selection is empty.');
    return save({ text, name: text.slice(0, 80) });
  }
  if (!isHttp(info.pageUrl)) return fail('This page cannot be saved.');
  return save({ url: info.pageUrl });
});

chrome.commands.onCommand.addListener(async (command, commandTab) => {
  try {
    if (command !== 'save-page' && command !== 'save-all-images' && !COMMAND_SHOTS[command]) return;
    if (!(await getConfig()).keyboardShortcutEnabled) return;
    const tab = commandTab?.url ? commandTab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (command === 'save-all-images') return openBatch(tab);
    if (COMMAND_SHOTS[command]) return startScreenshot(tab, COMMAND_SHOTS[command]);
    if (!isHttp(tab?.url)) return fail('No http(s) page to save.');
    return save({ url: tab.url, name: tab.title || undefined });
  } catch (err) {
    return fail(err.message);
  }
});
