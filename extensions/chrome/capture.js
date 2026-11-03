/**
 * Page side of the screenshot tools. Injected on demand with chrome.scripting.executeScript (activeTab), never
 * registered, so it only ever runs on a page the user just asked to capture. State lives on globalThis in the
 * extension's isolated world, which persists between executeScript calls on the same page.
 *
 * Choosing an area or an element reports back with a runtime message instead of returning a value: the user may
 * take longer than the service worker stays alive, and a message wakes it up again.
 */
(() => {
  const S = (globalThis.__abacusCapture ||= {});
  if (S.ready) return;
  S.ready = true;

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

  /**
   * Let the user draw a rectangle ('area') or click an element ('element'). Esc cancels; ArrowUp/ArrowDown walk
   * to the parent or back to the child while choosing an element. Resolves nothing: the result is a message.
   */
  S.pick = (mode) => {
    S.dismiss?.();
    const host = doc.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    // The overlay wears the library's theme too: default now, corrected when the cached theme arrives.
    const themeKit = globalThis.AbacusTheme;
    if (themeKit) {
      themeKit.apply(themeKit.normalize(null), host);
      chrome.storage.local.get('theme')
        .then(({ theme }) => { if (host.isConnected) themeKit.apply(themeKit.normalize(theme), host); })
        .catch(() => {});
    }
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      .shade{position:fixed;inset:0;background:rgba(10,11,14,.35);cursor:crosshair;pointer-events:none}
      :host([data-corners="squared"]) *{border-radius:0!important}
      .box{position:fixed;display:none;border:2px solid var(--accent);border-radius:2px;box-shadow:0 0 0 99999px rgba(10,11,14,.45);pointer-events:none}
      .tip{position:fixed;left:50%;top:14px;transform:translateX(-50%);padding:7px 12px;border-radius:8px;background:var(--panel);color:var(--text);
        font:12px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:none}
      .size{position:fixed;display:none;padding:2px 6px;border-radius:5px;background:var(--accent);color:var(--accent-ink);font:11px/1.4 system-ui,sans-serif;pointer-events:none}
    </style><div class="shade"></div><div class="box"></div><div class="size"></div>
    <div class="tip">${mode === 'element' ? 'Click an element to capture it · ↑ parent · Esc to cancel' : 'Drag to choose an area · Esc to cancel'}</div>`;
    (doc.body || root).append(host);
    const box = shadow.querySelector('.box');
    const size = shadow.querySelector('.size');
    const shade = shadow.querySelector('.shade');

    let start = null;
    let rect = null;
    let target = null;
    let chain = [];

    const show = (r) => {
      rect = r;
      shade.style.display = 'none';
      Object.assign(box.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
      Object.assign(size.style, { display: 'block', left: `${r.x}px`, top: `${Math.max(0, r.y - 22)}px` });
    };

    const elementAt = (x, y) => {
      const element = doc.elementsFromPoint(x, y).find((e) => e !== host && !host.contains(e));
      return element && element !== root ? element : null;
    };
    const showElement = (element) => {
      target = element;
      const r = element.getBoundingClientRect();
      show({ x: r.left, y: r.top, w: r.width, h: r.height });
    };

    const stop = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onMove = (event) => {
      if (mode === 'area') {
        if (!start) return;
        stop(event);
        show({
          x: Math.min(start.x, event.clientX),
          y: Math.min(start.y, event.clientY),
          w: Math.abs(event.clientX - start.x),
          h: Math.abs(event.clientY - start.y),
        });
        return;
      }
      const element = elementAt(event.clientX, event.clientY);
      if (element && element !== target) {
        chain = [];
        showElement(element);
      }
    };
    const onDown = (event) => {
      if (event.button !== 0) return;
      stop(event);
      if (mode === 'area') start = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event) => {
      if (event.button !== 0) return;
      stop(event);
      if (mode === 'area') {
        if (!start) return;
        start = null;
        if (!rect || rect.w < 6 || rect.h < 6) return S.dismiss();
        finish({ x: rect.x + window.scrollX, y: rect.y + window.scrollY, w: rect.w, h: rect.h });
      } else if (target) {
        const r = target.getBoundingClientRect();
        finish({ x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height });
      }
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        stop(event);
        S.dismiss();
      } else if (mode === 'element' && event.key === 'ArrowUp' && target?.parentElement && target.parentElement !== root) {
        stop(event);
        chain.push(target);
        showElement(target.parentElement);
      } else if (mode === 'element' && event.key === 'ArrowDown' && chain.length) {
        stop(event);
        showElement(chain.pop());
      }
    };

    const events = [['mousemove', onMove], ['mousedown', onDown], ['mouseup', onUp], ['click', stop], ['keydown', onKey]];
    for (const [name, handler] of events) window.addEventListener(name, handler, true);

    S.dismiss = () => {
      for (const [name, handler] of events) window.removeEventListener(name, handler, true);
      host.remove();
      S.dismiss = null;
    };

    function finish(result) {
      S.dismiss();
      // The service worker waits for the overlay to disappear before it captures the tab.
      chrome.runtime.sendMessage({ type: 'screenshot-result', mode, rect: result, info: S.info() }).catch?.(() => {});
    }
    return true;
  };
})();
