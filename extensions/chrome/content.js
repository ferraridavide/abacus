/**
 * Page tools that need to run inside pages: drag an image onto the dock to save it, Alt + right-click to save an
 * image even when something covers it or the page blocks the context menu, and the small toast that confirms.
 *
 * This is registered as a content script only while one of those tools is switched on (and Chrome has granted
 * access to websites); switching both off unregisters it, so no extension code runs on pages otherwise.
 * It cannot import modules, so hd.js is loaded before it and the work of saving is done by background.js.
 */
(() => {
  if (globalThis.__abacusContent) return;
  globalThis.__abacusContent = true;

  const hd = globalThis.__abacusHd;
  const MAX_INLINE_BYTES = 25 * 1024 * 1024;
  let config = { dragToSave: false, altClickSave: false, hdEnabled: true, folder: '', recentFolders: [] };

  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  function readConfig(stored) {
    config = {
      dragToSave: stored?.dragToSave === true,
      altClickSave: stored?.altClickSave === true,
      hdEnabled: stored?.hdEnabled !== false,
      folder: String(stored?.folder || '').trim(),
      recentFolders: Array.isArray(stored?.recentFolders) ? stored.recentFolders.filter((f) => typeof f === 'string') : [],
    };
  }
  chrome.storage.local.get('config').then(({ config: stored }) => readConfig(stored)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) readConfig(changes.config.newValue);
  });

  // ---------- shadow-DOM UI (the page's CSS can't touch it) ----------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .toast { position: fixed; right: 24px; bottom: 24px; transform: translateY(12px); opacity: 0; pointer-events: none;
      max-width: min(420px, 90vw); padding: 9px 14px; border-radius: 10px; background: #18191d; color: #ececef;
      border: 1px solid rgba(255,255,255,.12); box-shadow: 0 10px 30px rgba(0,0,0,.45);
      font: 500 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; transition: opacity .18s, transform .18s; }
    .toast.show { opacity: 1; transform: none; }
    .toast.ok { border-color: rgba(61,220,151,.5); }
    .toast.error { border-color: rgba(255,95,95,.55); }
    .dock { position: fixed; left: 0; right: 0; bottom: 0; display: flex; justify-content: center; gap: 10px; padding: 26px 16px 18px;
      background: linear-gradient(to top, rgba(10,11,14,.82), rgba(10,11,14,0)); opacity: 0; transform: translateY(14px);
      transition: opacity .15s, transform .15s; font: 500 12px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif; }
    .dock.show { opacity: 1; transform: none; }
    .tile { pointer-events: auto; min-width: 118px; max-width: 200px; padding: 12px 16px; border-radius: 12px; text-align: center;
      background: #1f2025; color: #ececef; border: 1.5px dashed rgba(255,255,255,.28); transition: background .12s, border-color .12s, transform .12s; }
    .tile small { display: block; margin-bottom: 3px; color: #a1a3ab; font-weight: 400; font-size: 10.5px; letter-spacing: .02em; text-transform: uppercase; }
    .tile b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 13px; }
    .tile.over { background: #2b3a63; border: 1.5px solid #5b8cff; transform: translateY(-4px) scale(1.04); }
  `;

  let ui;
  function root() {
    if (ui?.host.isConnected) return ui;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    // capture.js looks for this to keep our own toast and dock out of screenshots.
    host.setAttribute('data-abacus-ui', '');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.append(style);
    (document.body || document.documentElement).append(host);
    ui = { host, shadow };
    return ui;
  }

  let toastEl;
  let toastTimer;
  function toast(text, kind = '') {
    const { shadow } = root();
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      shadow.append(toastEl);
    }
    toastEl.className = `toast ${kind}`;
    toastEl.textContent = text;
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    if (kind !== 'pending') toastTimer = setTimeout(() => toastEl?.classList.remove('show'), kind === 'error' ? 6000 : 3000);
  }

  // ---------- saving ----------

  async function toDataUrl(inline) {
    const blob = await (await fetch(inline)).blob();
    if (blob.size > MAX_INLINE_BYTES) throw new Error('That image is too large to save from the page.');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function save(media, folder, via) {
    if (!alive()) return toast('Abacus was updated. Reload this page to use it again.', 'error');
    toast('Saving to Abacus…', 'pending');
    try {
      const payload = { candidates: media.candidates, pageUrl: location.href, title: media.title, kind: media.kind, poster: media.poster };
      if (!payload.candidates.length && media.inline) payload.inline = await toDataUrl(media.inline);
      if (!payload.candidates.length && !payload.inline) return toast('There is no image address to save here.', 'error');
      const response = await chrome.runtime.sendMessage({ type: 'save-media', media: payload, folder: folder || undefined, via });
      toast(response?.message || 'Could not reach the extension.', response?.status === 'error' || !response ? 'error' : 'ok');
    } catch (err) {
      toast(`Could not save: ${err.message}`, 'error');
    }
  }

  // ---------- finding the image under the pointer ----------

  /** The topmost image or video at a point, looking through overlays and transparent layers that sit above it. */
  function mediaAt(x, y, fallback) {
    const stack = document.elementsFromPoint(x, y);
    if (fallback && !stack.includes(fallback)) stack.push(fallback);
    for (const element of stack) {
      if (element === document.documentElement || element === document.body) continue;
      const media = hd.describe(element, { hd: config.hdEnabled });
      if (media && (media.candidates.length || media.inline)) return media;
    }
    return null;
  }

  /** The image being dragged: the element itself, an image inside the dragged link, or the one under the pointer. */
  function draggedMedia(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const own = target.matches('img, video') ? target : target.querySelector?.('img, video');
    const media = own ? hd.describe(own, { hd: config.hdEnabled }) : null;
    if (media && (media.candidates.length || media.inline)) return media;
    return mediaAt(event.clientX, event.clientY, null);
  }

  // ---------- Alt + right-click ----------

  window.addEventListener(
    'contextmenu',
    (event) => {
      if (!config.altClickSave || !event.altKey) return;
      const media = mediaAt(event.clientX, event.clientY, event.target instanceof Element ? event.target : null);
      if (!media) return;
      // Handled here: the page's own handlers (and its context menu) must not run.
      event.preventDefault();
      event.stopImmediatePropagation();
      save(media, '', 'alt');
    },
    true
  );

  // ---------- drag to the dock ----------

  let dock;
  function hideDock() {
    if (!dock) return;
    const old = dock;
    dock = null;
    old.classList.remove('show');
    setTimeout(() => old.remove(), 200);
  }

  function tiles() {
    const first = config.folder;
    const rest = config.recentFolders.filter((f) => f.toLowerCase() !== first.toLowerCase()).slice(0, first ? 4 : 5);
    return [
      { folder: first, label: first || 'Library', hint: first ? 'Default folder' : 'No folder' },
      ...rest.map((folder) => ({ folder, label: folder, hint: 'Recent' })),
    ];
  }

  function showDock(media) {
    hideDock();
    const { shadow } = root();
    const element = document.createElement('div');
    element.className = 'dock';
    for (const tile of tiles()) {
      const box = document.createElement('div');
      box.className = 'tile';
      box.title = tile.folder || 'Save without a folder';
      const hint = document.createElement('small');
      hint.textContent = tile.hint;
      const label = document.createElement('b');
      label.textContent = tile.label;
      box.append(hint, label);
      box.addEventListener('dragenter', (e) => { e.preventDefault(); box.classList.add('over'); });
      box.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        box.classList.add('over');
      });
      box.addEventListener('dragleave', () => box.classList.remove('over'));
      box.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideDock();
        save(media, tile.folder, 'drag');
      });
      element.append(box);
    }
    shadow.append(element);
    dock = element;
    requestAnimationFrame(() => element.classList.add('show'));
  }

  // Never cancel or change the drag itself, so dropping into an editor or another tab still works as usual.
  window.addEventListener(
    'dragstart',
    (event) => {
      if (!config.dragToSave || !alive()) return;
      const media = draggedMedia(event);
      // Adding elements while the browser starts the drag can cancel it, so wait a tick.
      if (media) setTimeout(() => showDock(media), 0);
    },
    true
  );
  window.addEventListener('dragend', () => setTimeout(hideDock, 60), true);
  window.addEventListener('drop', () => setTimeout(hideDock, 60), true);
  window.addEventListener('blur', hideDock);
})();
