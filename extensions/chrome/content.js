/**
 * Page tools that run inside pages: drag an image (or a link) onto the dock to save it, Alt + right-click to save
 * an image even when something covers it or the page blocks the context menu, and the toast that confirms.
 *
 * Registered as a content script only while one of those tools is on (and Chrome grants access to websites).
 * It runs at document_start so its window listeners come before the page's own. It cannot import modules, so
 * theme-boot.js and hd.js are loaded before it; the saving itself is done by background.js.
 *
 * Every frame describes what is dragged and attaches it to the drag as MEDIA_TYPE; only the top frame shows the
 * dock and takes the drop, so images dragged out of iframes (or other tabs) land in the same place.
 */
(() => {
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  // Injected twice into the same page by the same extension: keep the first.
  const previous = globalThis.__abacusContent;
  if (previous?.alive?.()) return;
  previous?.teardown?.();
  // A copy from before the extension was reloaded lives in another isolated world and can no longer reach the
  // extension. The DOM is shared, so tell it to stand down before it swallows events meant for this copy.
  const REPLACED = 'abacus-content-replaced';
  document.dispatchEvent(new CustomEvent(REPLACED));

  const hd = globalThis.__abacusHd;
  const themeKit = globalThis.AbacusTheme;
  const IS_TOP = window === window.top;
  const MEDIA_TYPE = 'application/x-abacus-media';
  const DOCK_WATCHDOG_MS = 10_000;
  const lifetime = new AbortController();
  // Every handler first checks that the extension is still there; an orphaned copy removes itself instead.
  const listen = (target, type, handler, capture = true) => target.addEventListener(
    type,
    (event) => (alive() ? handler(event) : teardown()),
    { capture, signal: lifetime.signal }
  );

  let config = { dragToSave: false, altClickSave: false, hdEnabled: true, folder: '', recentFolders: [] };
  function readConfig(stored) {
    config = {
      dragToSave: stored?.dragToSave === true,
      altClickSave: stored?.altClickSave === true,
      hdEnabled: stored?.hdEnabled !== false,
      folder: String(stored?.folder || '').trim(),
      recentFolders: Array.isArray(stored?.recentFolders) ? stored.recentFolders.filter((f) => typeof f === 'string') : [],
    };
  }
  let theme = themeKit ? themeKit.normalize(null) : null;
  function readTheme(stored) {
    theme = themeKit ? themeKit.normalize(stored) : null;
    if (theme && ui?.host) themeKit.apply(theme, ui.host);
  }
  function onStorage(changes, area) {
    if (area !== 'local') return;
    if (changes.config) readConfig(changes.config.newValue);
    if (changes.theme) readTheme(changes.theme.newValue);
  }
  try {
    chrome.storage.local.get(['config', 'theme']).then(({ config: stored, theme: storedTheme }) => {
      readConfig(stored);
      readTheme(storedTheme);
    }).catch(() => {});
    chrome.storage.onChanged.addListener(onStorage);
  } catch {
    return;
  }

  // ---------- shadow-DOM UI (the page's CSS can't touch it) ----------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    :host([data-corners="squared"]) * { border-radius: 0 !important; }
    .toast { position: fixed; right: 24px; bottom: 24px; transform: translateY(12px); opacity: 0; pointer-events: none;
      max-width: min(420px, 90vw); padding: 9px 14px; border-radius: 10px; background: var(--panel); color: var(--text);
      border: 1px solid var(--border-strong); box-shadow: 0 10px 30px rgba(0,0,0,calc(.45 * var(--shade)));
      font: 500 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; transition: opacity .18s, transform .18s; }
    .toast.show { opacity: 1; transform: none; }
    .toast.ok { border-color: color-mix(in srgb, var(--ok) 50%, transparent); }
    .toast.error { border-color: color-mix(in srgb, var(--danger) 55%, transparent); }
    .dock { position: fixed; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; align-items: center; gap: 8px;
      padding: 30px 16px 18px; background: linear-gradient(to top, rgba(10,11,14,.85), rgba(10,11,14,0));
      opacity: 0; transform: translateY(14px); transition: opacity .15s, transform .15s;
      font: 500 12px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif; }
    .dock.show { opacity: 1; transform: none; }
    .caption { color: #fff; opacity: .8; font-size: 11.5px; letter-spacing: .02em; text-shadow: 0 1px 3px rgba(0,0,0,.6); }
    .tiles { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
    .tile { pointer-events: auto; min-width: 118px; max-width: 200px; padding: 12px 16px; border-radius: 12px; text-align: center;
      background: var(--panel-2); color: var(--text); border: 1.5px dashed color-mix(in srgb, var(--text) 28%, transparent);
      transition: background .12s, border-color .12s, transform .12s; }
    .tile small { display: block; margin-bottom: 3px; color: var(--text-dim); font-weight: 400; font-size: 10.5px; letter-spacing: .02em; text-transform: uppercase; }
    .tile b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 13px; }
    .tile.over { background: color-mix(in srgb, var(--accent) 25%, var(--panel-2)); border: 1.5px solid var(--accent);
      transform: translateY(-4px) scale(1.04); }
  `;

  let ui;
  function root() {
    if (ui?.host.isConnected) return ui;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    if (theme && themeKit) themeKit.apply(theme, host);
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
  const isOurs = (element) => element === ui?.host;

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

  async function save(media, folder) {
    if (!alive()) return toast('Abacus was updated. Reload this page to use it again.', 'error');
    toast('Saving to Abacus…', 'pending');
    try {
      const payload = {
        kind: media.kind,
        candidates: Array.isArray(media.candidates) ? media.candidates : [],
        title: media.title,
        poster: media.poster,
        pageUrl: media.pageUrl || location.href,
      };
      if (!payload.candidates.length && media.inline) payload.inline = await hd.inlineToDataUrl(media.inline);
      if (!payload.candidates.length && !payload.inline) return toast('There is no image address to save here.', 'error');
      const response = await chrome.runtime.sendMessage({ type: 'save-media', media: payload, folder: folder || undefined });
      toast(response?.message || 'Could not reach the extension.', response?.status === 'error' || !response ? 'error' : 'ok');
    } catch (err) {
      toast(`Could not save: ${err.message}`, 'error');
    }
  }

  const findMedia = (x, y) => hd.mediaAt(document, x, y, { hd: config.hdEnabled, ignore: isOurs });

  // ---------- Alt + right-click ----------

  listen(document, REPLACED, teardown);

  listen(window, 'contextmenu', (event) => {
    if (!config.altClickSave || !event.altKey) return;
    const hit = findMedia(event.clientX, event.clientY);
    if (!hit) return;
    // Handled here: the page's own handlers (and its context menu) must not run.
    event.preventDefault();
    event.stopImmediatePropagation();
    save(hit.media, '');
  });

  // ---------- drag: what is being dragged ----------

  function draggedMedia(target, x, y) {
    if (!(target instanceof Element)) return null;
    const own = target.matches('img, video') ? target : target.querySelector('img, video');
    const media = own && hd.describe(own, { hd: config.hdEnabled });
    if (media && (media.candidates.length || media.inline)) return media;
    return findMedia(x, y)?.media || null;
  }

  /**
   * Images under an overlay (Pinterest, ArtStation, Instagram…) can't be dragged: the overlay isn't draggable.
   * On mousedown over such an overlay, make it draggable until the button is released, and drag the image.
   * Alt also unlocks images the site blocks on purpose, and keeps the page from cancelling the drag.
   */
  let forced = null;
  const NOT_FORCED = 'input, textarea, select, button, video, audio, [contenteditable]:not([contenteditable="false"])';

  function overText(element, x, y) {
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  }

  function releaseForced() {
    if (!forced) return;
    const { element, draggable, userDrag } = forced;
    forced = null;
    if (draggable === null) element.removeAttribute('draggable');
    else element.setAttribute('draggable', draggable);
    if (userDrag.value) element.style.setProperty('-webkit-user-drag', userDrag.value, userDrag.priority);
    else element.style.removeProperty('-webkit-user-drag');
  }

  listen(window, 'mousedown', (event) => {
    releaseForced();
    if (!config.dragToSave || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const top = event.composedPath()[0];
    if (!(top instanceof HTMLElement) || isOurs(top)) return;
    const alt = event.altKey;
    if (!alt) {
      if (top.closest('[draggable="true"], a[href]') || (top instanceof HTMLImageElement && top.draggable)) return;
      if (top.closest(NOT_FORCED) || top instanceof HTMLImageElement || overText(top, event.clientX, event.clientY)) return;
    }
    const hit = findMedia(event.clientX, event.clientY);
    if (!hit) return;
    forced = {
      element: top,
      hit,
      alt,
      x: event.clientX,
      y: event.clientY,
      draggable: top.getAttribute('draggable'),
      userDrag: { value: top.style.getPropertyValue('-webkit-user-drag'), priority: top.style.getPropertyPriority('-webkit-user-drag') },
    };
    top.setAttribute('draggable', 'true');
    top.style.setProperty('-webkit-user-drag', 'element', 'important');
    // the page must not cancel an Alt-drag with preventDefault
    if (alt) event.stopImmediatePropagation();
  });
  listen(window, 'mouseup', releaseForced);

  listen(window, 'dragstart', (event) => {
    const transfer = event.dataTransfer;
    if (!config.dragToSave || !transfer) return;
    const own = forced && (event.target === forced.element || forced.element.contains(event.target)) ? forced : null;
    const media = own ? own.hit.media : draggedMedia(event.target, event.clientX, event.clientY);
    if (!media) return;
    if (own) {
      if (own.alt) event.stopImmediatePropagation();
      const url = media.candidates[0];
      if (url) {
        transfer.setData('text/uri-list', url);
        transfer.setData('text/plain', url);
      }
      const rect = own.hit.element.getBoundingClientRect();
      const offsetX = Math.max(0, Math.min(rect.width, own.x - rect.left));
      const offsetY = Math.max(0, Math.min(rect.height, own.y - rect.top));
      try {
        transfer.setDragImage(own.hit.element, offsetX, offsetY);
      } catch {
        /* the overlay's own snapshot is the drag image then */
      }
    }
    transfer.setData(MEDIA_TYPE, JSON.stringify({ ...media, pageUrl: location.href }));
  });
  listen(window, 'dragend', () => {
    releaseForced();
    hideDock();
  });

  // ---------- drag: the dock (top frame only) ----------

  let dock = null;
  let lastDragSeen = 0;
  let watchdog;

  function tiles() {
    const first = config.folder;
    const rest = config.recentFolders.filter((f) => f.toLowerCase() !== first.toLowerCase()).slice(0, first ? 4 : 5);
    return [
      { folder: first, label: first || 'Library', hint: first ? 'Default folder' : 'No folder' },
      ...rest.map((folder) => ({ folder, label: folder, hint: 'Recent' })),
    ];
  }

  function showDock() {
    hideDock();
    const { shadow } = root();
    const element = document.createElement('div');
    element.className = 'dock';
    const caption = document.createElement('div');
    caption.className = 'caption';
    caption.textContent = 'Drop on a folder to save to Abacus';
    const row = document.createElement('div');
    row.className = 'tiles';
    const boxes = tiles().map((tile) => {
      const box = document.createElement('div');
      box.className = 'tile';
      box.title = tile.folder || 'Save without a folder';
      const hint = document.createElement('small');
      hint.textContent = tile.hint;
      const label = document.createElement('b');
      label.textContent = tile.label;
      box.append(hint, label);
      row.append(box);
      return { box, folder: tile.folder };
    });
    element.append(caption, row);
    shadow.append(element);
    dock = { element, boxes };
    requestAnimationFrame(() => element.classList.add('show'));
    lastDragSeen = Date.now();
    clearInterval(watchdog);
    // a drag that ends inside an iframe or another window sends us nothing: don't leave the dock behind
    watchdog = setInterval(() => {
      if (Date.now() - lastDragSeen > DOCK_WATCHDOG_MS) hideDock();
    }, 1000);
  }

  function hideDock() {
    clearInterval(watchdog);
    if (!dock) return;
    const old = dock.element;
    dock = null;
    old.classList.remove('show');
    setTimeout(() => old.remove(), 200);
  }

  function tileAt(x, y) {
    if (!dock) return null;
    return dock.boxes.find(({ box }) => {
      const r = box.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }) || null;
  }

  const DROP_EFFECT = { copy: 'copy', copyLink: 'copy', copyMove: 'copy', all: 'copy', uninitialized: 'copy', link: 'link', linkMove: 'link', move: 'move' };

  /** Over a tile, take the drag away from the page; anywhere else, leave it alone. */
  function trackOver(event) {
    lastDragSeen = Date.now();
    const tile = tileAt(event.clientX, event.clientY);
    for (const { box } of dock.boxes) box.classList.toggle('over', box === tile?.box);
    if (!tile) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const effect = DROP_EFFECT[event.dataTransfer?.effectAllowed];
    if (effect) event.dataTransfer.dropEffect = effect;
  }

  const wantsDock = (transfer) => {
    const types = [...(transfer?.types || [])];
    return types.includes(MEDIA_TYPE) || types.includes('text/uri-list');
  };

  /** What was dropped: our own description first, then the image in the dragged HTML, then the dragged URL. */
  function droppedMedia(transfer) {
    try {
      const media = JSON.parse(transfer.getData(MEDIA_TYPE) || 'null');
      if (media && Array.isArray(media.candidates)) return media;
    } catch {
      /* not ours, or not readable: look at the plain data */
    }
    const html = transfer.getData('text/html');
    if (html) {
      // DOMParser makes an inert document: nothing in it runs or loads
      const image = new DOMParser().parseFromString(html, 'text/html').querySelector('img[src]');
      if (image) {
        const src = image.getAttribute('src');
        const candidates = hd.candidates(
          { src, srcset: image.getAttribute('srcset'), link: image.closest('a')?.getAttribute('href'), base: location.href },
          { hd: config.hdEnabled }
        );
        if (candidates.length) return { kind: 'image', candidates, title: image.getAttribute('alt') || '' };
        if (/^data:image\//i.test(src)) return { kind: 'image', candidates: [], inline: src, title: image.getAttribute('alt') || '' };
      }
    }
    const url = (transfer.getData('text/uri-list') || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
    if (!hd.isHttp(url)) return null;
    if (hd.looksLikeImage(url)) return { kind: 'image', candidates: hd.candidates({ src: url }, { hd: config.hdEnabled }) };
    if (hd.looksLikeVideo(url)) return { kind: 'video', candidates: [url] };
    return { kind: 'link', candidates: [url] };
  }

  if (IS_TOP) {
    listen(window, 'dragenter', (event) => {
      if (!config.dragToSave) return;
      if (!dock && wantsDock(event.dataTransfer)) showDock();
      if (dock) trackOver(event);
    });
    listen(window, 'dragover', (event) => {
      if (dock) trackOver(event);
    });
    listen(window, 'drop', (event) => {
      if (!dock) return;
      const tile = tileAt(event.clientX, event.clientY);
      hideDock();
      if (!tile) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const media = droppedMedia(event.dataTransfer);
      if (!media) return toast('Nothing to save in what was dropped.', 'error');
      save(media, tile.folder);
    });
    listen(window, 'dragleave', (event) => {
      const outside = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= innerWidth || event.clientY >= innerHeight;
      if (dock && !event.relatedTarget && outside) hideDock();
    });
    // Mouse events don't fire during a drag: one arriving means the drag is over.
    listen(window, 'mousemove', () => dock && hideDock());
  }

  function teardown() {
    lifetime.abort();
    releaseForced();
    hideDock();
    ui?.host.remove();
    try {
      chrome.storage.onChanged.removeListener(onStorage);
    } catch {
      /* the extension context is already gone */
    }
  }

  globalThis.__abacusContent = { alive, teardown };
})();
