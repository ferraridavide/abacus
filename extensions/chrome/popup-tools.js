import { getConfig } from './lib.js';

// Screenshot and batch tools for the active tab. Opening the popup grants activeTab, so the background worker may
// read the page; the popup closes straight away so it isn't in the screenshot.
const section = document.getElementById('tools');

async function init() {
  const config = await getConfig();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!config.serverUrl || !/^https?:\/\//i.test(tab?.url || '')) return;
  section.hidden = false;

  const start = async (message) => {
    try {
      await chrome.runtime.sendMessage({ ...message, tabId: tab.id });
    } finally {
      window.close();
    }
  };
  for (const button of section.querySelectorAll('[data-shot]')) {
    button.addEventListener('click', () => start({ type: 'start-screenshot', mode: button.dataset.shot }));
  }
  document.getElementById('batch').addEventListener('click', () => start({ type: 'open-batch' }));
}

init().catch(() => {});
