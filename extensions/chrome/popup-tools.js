import { getConfig } from './lib.js';

// Image and screenshot tools for the active tab. Opening the popup grants activeTab, so the background worker may
// read the page; the popup closes straight away so it isn't in the screenshot.
const section = document.getElementById('tools');

function showDragHint(config) {
  const hint = document.getElementById('drag-hint');
  if (config.dragToSave) {
    hint.textContent = 'Or drag any image onto the dock that appears at the bottom of the page.';
  } else {
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Turn on drag to save';
    open.addEventListener('click', () => chrome.runtime.openOptionsPage());
    hint.replaceChildren(open, ' to drop images on a dock of your folders.');
  }
  hint.hidden = false;
}

async function init() {
  const config = await getConfig();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!config.serverUrl || !/^https?:\/\//i.test(tab?.url || '')) return;
  section.hidden = false;
  showDragHint(config);

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
  document.getElementById('pick').addEventListener('click', () => start({ type: 'start-screenshot', mode: 'images' }));
  document.getElementById('batch').addEventListener('click', () => start({ type: 'open-batch' }));
}

init().catch(() => {});
