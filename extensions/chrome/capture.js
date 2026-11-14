/**
 * Page side of the screenshot tools and the image picker. Injected on demand with chrome.scripting.executeScript
 * (activeTab), never registered, so it only ever runs on a page the user just asked to capture. State lives on
 * globalThis in the extension's isolated world, which persists between executeScript calls on the same page.
 * hd.js is injected first, for finding the image under the pointer.
 *
 * Choosing an area or an element reports back with a runtime message instead of returning a value: the user may
 * take longer than the service worker stays alive, and a message wakes it up again.
 */
(() => {
  // Injected again by the same extension: keep the first copy.
  const previous = globalThis.__abacusCapture;
  if (previous?.alive?.()) return;
  previous?.dismiss?.();
  // A copy from before an extension reload lives in another isolated world: close its picker through the shared DOM.
  const REPLACED = 'abacus-capture-replaced';
  document.dispatchEvent(new CustomEvent(REPLACED));
  document.addEventListener(REPLACED, () => S.dismiss?.());
  const S = (globalThis.__abacusCapture = {
    alive: () => {
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
  });

    const doc = document;
  const root = doc.documentElement;

  /** Everything the service worker needs to place screenshots, in CSS pixels. */
  S.info = () => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientWidth: root.clientWidth,
    clientHeight: root.clientHeight,
    scrollWidth: Math.max(root.scrollWidth, doc.body?.scrollWidth || 0),
    scrollHeight: Math.max(root.scrollHeight, doc.body?.scrollHeight || 0),
    title: doc.title,
    url: location.href,
  });

  /** Scroll without animation and report where the page really ended up (it can't go past its own end). */
  S.scrollTo = (x, y) => {
    S.smooth ??= root.style.getPropertyValue('scroll-behavior');
    root.style.setProperty('scroll-behavior', 'auto', 'important');
    window.scrollTo(x, y);
    return { x: window.scrollX, y: window.scrollY };
  };

  /** Hide scrollbars so they don't end up in every strip. */
  S.prepare = () => {
    S.bar ??= root.style.getPropertyValue('scrollbar-width');
    root.style.setProperty('scrollbar-width', 'none', 'important');
    // Our own toast and drag dock must not end up in the picture.
    S.ui = [...doc.querySelectorAll('[data-abacus-ui]')].map((e) => [e, e.style.getPropertyValue('visibility')]);
    for (const [e] of S.ui) e.style.setProperty('visibility', 'hidden', 'important');
    return true;
  };

  /** Fixed and sticky elements would repeat in every strip of a tall page, so hide them after the first one. */
  S.hideFixed = () => {
    S.hidden ||= [];
    let checked = 0;
    for (const element of doc.querySelectorAll('*')) {
      if (++checked > 20000) break;
      const position = getComputedStyle(element).position;
      if (position !== 'fixed' && position !== 'sticky') continue;
      S.hidden.push([element, element.style.getPropertyValue('visibility'), element.style.getPropertyPriority('visibility')]);
      element.style.setProperty('visibility', 'hidden', 'important');
    }
    return S.hidden.length;
  };

  S.restore = (x, y) => {
    for (const [element, value, priority] of S.hidden || []) {
      if (value) element.style.setProperty('visibility', value, priority);
      else element.style.removeProperty('visibility');
    }
    S.hidden = [];
    for (const [e, value] of S.ui || []) {
      if (value) e.style.setProperty('visibility', value);
      else e.style.removeProperty('visibility');
    }
    S.ui = [];
    if (S.bar !== undefined) {
      if (S.bar) root.style.setProperty('scrollbar-width', S.bar);
      else root.style.removeProperty('scrollbar-width');
      S.bar = undefined;
    }
    if (S.smooth !== undefined) {
      if (S.smooth) root.style.setProperty('scroll-behavior', S.smooth);
      else root.style.removeProperty('scroll-behavior');
      S.smooth = undefined;
    }
    if (x !== undefined) window.scrollTo(x, y);
    return true;
  };

  S.cancel = () => S.dismiss?.();

  const TIPS = {
    area: 'Drag to choose an area',
    element: 'Click an element to capture it · ↑ ↓ parent and child',
    images: 'Click images to save them to Abacus',
  };

  /**
   * Choose what to capture: draw a rectangle ('area'), click an element ('element'), or click images to save their
   * files ('images', stays open for several). A full-page layer takes every mouse event, so the page never reacts
   * to the clicks. Esc, a right-click, or the bar's button ends it: the page may not have keyboard focus right
   * after the popup closes, so the mouse must always be enough.
   */
  S.pick = (mode) => {
    S.dismiss?.();
    const hd = globalThis.__abacusHd;
    const host = doc.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647';
    const themeKit = globalThis.AbacusTheme;
    if (themeKit) {
      themeKit.apply(themeKit.normalize(null), host);
      chrome.storage.local.get('theme')
        .then(({ theme }) => { if (host.isConnected) themeKit.apply(themeKit.normalize(theme), host); })
        .catch(() => {});
    }
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host([data-corners="squared"]) *{border-radius:0!important}
      .layer{position:fixed;inset:0;cursor:crosshair;outline:none;background:transparent}
      .layer.shade{background:rgba(10,11,14,.35)}
      .box{position:fixed;display:none;border:2px solid var(--accent);border-radius:3px;pointer-events:none;
        box-shadow:0 0 0 99999px rgba(10,11,14,.42);transition:background .15s}
      .box.flash{background:color-mix(in srgb,var(--accent) 35%,transparent)}
      .size{position:fixed;display:none;padding:2px 6px;border-radius:5px;background:var(--accent);color:var(--accent-ink);
        font:11px/1.4 system-ui,sans-serif;pointer-events:none;white-space:nowrap}
      .bar{position:fixed;left:50%;top:14px;transform:translateX(-50%);display:flex;align-items:center;gap:12px;
        padding:6px 6px 6px 14px;border-radius:10px;background:var(--panel);color:var(--text);border:1px solid var(--border-strong);
        font:12.5px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);max-width:calc(100vw - 28px)}
      .status{color:var(--text-dim)}
      .status.ok{color:var(--ok)}
      .status.error{color:var(--danger)}
      .bar button{all:unset;cursor:pointer;padding:5px 11px;border-radius:7px;background:var(--panel-3);color:var(--text);
        font:600 12px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif}
      .bar button:hover{background:var(--accent);color:var(--accent-ink)}
      kbd{font:inherit;padding:0 5px;border:1px solid var(--border-strong);border-radius:4px;color:var(--text-dim)}
    </style>
    <div class="layer" tabindex="-1"></div><div class="box"></div><div class="size"></div>
    <div class="bar" role="toolbar"><span class="tip"></span><span class="status" role="status"></span>
      <button type="button">${mode === 'images' ? 'Done' : 'Cancel'} <kbd>Esc</kbd></button></div>`;
    (doc.body || root).append(host);
    const layer = shadow.querySelector('.layer');
    const box = shadow.querySelector('.box');
    const size = shadow.querySelector('.size');
    const statusEl = shadow.querySelector('.status');
    shadow.querySelector('.tip').textContent = TIPS[mode] || TIPS.element;
    if (mode === 'area') layer.classList.add('shade');

    let start = null;
    let rect = null;
    let target = null;
    let hit = null;
    let chain = [];
    let pointer = null;
    let frame = 0;
    let saved = 0;

    const focusLayer = () => {
      try {
        window.focus();
        layer.focus({ preventScroll: true });
      } catch {
        /* the bar's button and right-click still end the picker */
      }
    };

    const status = (text, kind = '') => {
      statusEl.textContent = text;
      statusEl.className = `status ${kind}`;
    };

    const show = (r) => {
      rect = r;
      layer.classList.remove('shade');
      Object.assign(box.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
      Object.assign(size.style, { display: 'block', left: `${r.x}px`, top: `${r.y < 26 ? r.y + 4 : r.y - 22}px` });
    };
    const hide = () => {
      rect = null;
      box.style.display = 'none';
      size.style.display = 'none';
    };

    const ignore = (element) => element === host;
    const findMedia = (x, y) => (hd ? hd.mediaAt(doc, x, y, { ignore }) : null);
    const elementAt = (x, y) => {
      const element = doc.elementsFromPoint(x, y).find((e) => !ignore(e));
      return element && element !== root && element !== doc.body ? element : null;
    };
    const showElement = (element) => {
      target = element;
      const r = element.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return hide();
      show({ x: r.left, y: r.top, w: r.width, h: r.height });
    };

    // Hover: in element mode an image under the pointer wins over the overlays drawn on top of it.
    const hover = () => {
      frame = 0;
      if (!pointer || start) return;
      const { x, y } = pointer;
      if (mode === 'images') {
        hit = findMedia(x, y);
        if (hit) showElement(hit.element);
        else {
          target = null;
          hide();
        }
        return;
      }
      if (mode !== 'element') return;
      const element = findMedia(x, y)?.element || elementAt(x, y);
      if (element && element !== target && !chain.includes(element)) {
        chain = [];
        showElement(element);
      }
    };
    const scheduleHover = () => {
      if (!frame) frame = requestAnimationFrame(hover);
    };

    const onMove = (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (doc.activeElement !== host) focusLayer();
      if (mode === 'area' && start) {
        show({
          x: Math.min(start.x, pointer.x),
          y: Math.min(start.y, pointer.y),
          w: Math.abs(pointer.x - start.x),
          h: Math.abs(pointer.y - start.y),
        });
        return;
      }
      scheduleHover();
    };

    const onDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      focusLayer();
      if (mode === 'area') {
        start = { x: event.clientX, y: event.clientY };
        layer.setPointerCapture?.(event.pointerId);
      }
    };

    async function saveImage(found) {
      const media = { ...found.media, pageUrl: location.href };
      status('Saving…');
      try {
        if (!media.candidates.length && media.inline) media.inline = await hd.inlineToDataUrl(media.inline);
        const response = await chrome.runtime.sendMessage({ type: 'save-media', media });
        if (!response || response.status === 'error') return status(response?.message || 'Could not reach the extension.', 'error');
        saved += 1;
        status(saved > 1 ? `${saved} saved · ${response.message}` : response.message, 'ok');
      } catch (err) {
        status(S.alive() ? `Could not save: ${err.message}` : 'Abacus was updated. Reload this page to use it again.', 'error');
      }
    }

    const onUp = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      if (mode === 'area') {
        if (!start) return;
        start = null;
        if (!rect || rect.w < 6 || rect.h < 6) {
          hide();
          layer.classList.add('shade');
          return;
        }
        finish({ x: rect.x + window.scrollX, y: rect.y + window.scrollY, w: rect.w, h: rect.h });
      } else if (mode === 'images') {
        if (!hit) return status('No image there', 'error');
        box.classList.add('flash');
        setTimeout(() => box.classList.remove('flash'), 250);
        saveImage(hit);
      } else if (target) {
        const r = target.getBoundingClientRect();
        finish({ x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height });
      }
    };

    const onKey = (event) => {
      if (event.key === 'Escape' || (mode === 'images' && event.key === 'Enter')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        S.dismiss();
      } else if (mode === 'element' && event.key === 'ArrowUp' && target?.parentElement && target.parentElement !== root) {
        event.preventDefault();
        event.stopImmediatePropagation();
        chain.push(target);
        showElement(target.parentElement);
      } else if (mode === 'element' && event.key === 'ArrowDown' && chain.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showElement(chain.pop());
      }
    };

    // The box follows its element when the page scrolls under the picker.
    const onScroll = () => {
      if (mode === 'area') return;
      if (target?.isConnected && (mode === 'element' || hit)) showElement(target);
      if (mode === 'images') scheduleHover();
    };

    const swallow = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const cancel = (event) => {
      swallow(event);
      S.dismiss();
    };

    const lifetime = new AbortController();
    const on = (target_, type, handler, options = {}) => target_.addEventListener(type, handler, { ...options, signal: lifetime.signal });
    on(layer, 'pointermove', onMove);
    on(layer, 'pointerdown', onDown);
    on(layer, 'pointerup', onUp);
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick']) on(layer, type, swallow);
    on(layer, 'contextmenu', cancel);
    on(shadow.querySelector('.bar button'), 'click', cancel);
    on(window, 'keydown', onKey, { capture: true });
    on(window, 'scroll', onScroll, { capture: true, passive: true });
    on(window, 'blur', () => { start = null; });

    S.dismiss = () => {
      lifetime.abort();
      cancelAnimationFrame(frame);
      host.remove();
      S.dismiss = null;
    };

    function finish(result) {
      S.dismiss();
      // The service worker waits for the overlay to disappear before it captures the tab.
      chrome.runtime.sendMessage({ type: 'screenshot-result', mode, rect: result, info: S.info() }).catch?.(() => {});
    }

    focusLayer();
    return true;
  };
})();
