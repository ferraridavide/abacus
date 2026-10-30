import { addToAbacus, getConfig, parseTagList, summarize } from './lib.js';

const MENUS = [
  { id: 'abacus-page', title: 'Save page to Abacus', contexts: ['page', 'frame'] },
  { id: 'abacus-link', title: 'Save link to Abacus', contexts: ['link'] },
  { id: 'abacus-image', title: 'Save image to Abacus', contexts: ['image'] },
  { id: 'abacus-selection', title: 'Save selection to Abacus', contexts: ['selection'] },
];

const isHttp = (url) => /^https?:\/\//i.test(url || '');

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const menu of MENUS) chrome.contextMenus.create(menu);
  });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  createMenus();
  // There is no default server: ask for one right away.
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(createMenus);

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

async function save(payload) {
  try {
    const config = await getConfig();
    const tags = payload.tags ?? parseTagList(config.tags);
    await flashBadge('…', '#5b8cff', false);
    const data = await addToAbacus({ ...payload, folder: payload.folder ?? config.folder, tags }, { config });
    await notify('Saved to Abacus', summarize(data));
    await flashBadge('✓', '#2f9e44');
    return data;
  } catch (err) {
    return fail(err.message);
  }
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'abacus-image') {
    if (!isHttp(info.srcUrl)) return fail('Only http(s) images can be saved.');
    return save({ url: info.srcUrl });
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

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-page') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isHttp(tab?.url)) return fail('No http(s) page to save.');
    return save({ url: tab.url, name: tab.title || undefined });
  } catch (err) {
    return fail(err.message);
  }
});
