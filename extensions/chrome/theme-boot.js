/**
 * The extension mirrors the theme of the Abacus server it saves to: base colour scheme, theme, corners, OLED and the
 * one accent colour come from GET /api/settings/appearance, are cached here, and are painted as custom properties.
 *
 * This is a classic script on purpose: it must run in <head>, before the first paint, so a light or squared popup
 * does not flash the default Classic dark for a frame. It publishes the primitives on globalThis.AbacusTheme,
 * which theme.js (a module) and content.js (an isolated-world content script) both use.
 */
(() => {
  const STORAGE_KEY = 'abacus-theme';

  const DEFAULT_ACCENT = {
    hex: '#5b8cff',
    hex2: '#8b5cff',
    ink: '#ffffff',
    soft: 'rgba(91, 140, 255, 0.16)',
    text: { light: '#38579e', dark: '#5b8cff' },
  };

  /**
   * Classic dark, the server's default palette. Painted when no theme has been fetched yet, so the in-page UI never
   * inherits a page's own --panel or --text through its shadow host.
   */
  const DEFAULT_PALETTE = {
    bg: '#121316',
    panel: '#18191d',
    panel2: '#1f2025',
    panel3: '#26272d',
    hover: 'rgba(255, 255, 255, 0.055)',
    border: 'rgba(255, 255, 255, 0.07)',
    borderStrong: 'rgba(255, 255, 255, 0.12)',
    text: '#ececef',
    textDim: '#a1a3ab',
    textFaint: '#6c6e77',
    checkerA: '#1c1d22',
    checkerB: '#202127',
    shade: '1',
    danger: '#ff5f5f',
    ok: '#3ddc97',
  };

  const HEX = /^#[0-9a-f]{6}$/i;
  const SCHEMES = ['light', 'dark', 'system'];

  const kebab = (name) =>
    name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()).replace(/\d/g, (d) => '-' + d);

  function mixHex(hex, toward, amount) {
    const a = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const b = [1, 3, 5].map((i) => parseInt(toward.slice(i, i + 2), 16));
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, '0')).join('');
  }

  function normalize(theme) {
    const stored = theme && typeof theme === 'object' ? theme : {};
    const accent = stored.accent && typeof stored.accent === 'object' ? stored.accent : {};
    const hex = HEX.test(accent.hex || '') ? String(accent.hex).toLowerCase() : DEFAULT_ACCENT.hex;
    return {
      scheme: SCHEMES.includes(stored.scheme) ? stored.scheme : 'dark',
      theme: typeof stored.theme === 'string' ? stored.theme : 'classic',
      corners: stored.corners === 'squared' ? 'squared' : 'rounded',
      oled: typeof stored.oled === 'boolean' ? stored.oled : false,
      accent: {
        hex,
        hex2: HEX.test(accent.hex2 || '') ? accent.hex2 : DEFAULT_ACCENT.hex2,
        ink: HEX.test(accent.ink || '') ? accent.ink : DEFAULT_ACCENT.ink,
        soft: typeof accent.soft === 'string' && accent.soft ? accent.soft : DEFAULT_ACCENT.soft,
        text: {
          light: HEX.test(accent.text?.light || '') ? accent.text.light : mixHex(hex, '#000000', 0.38),
          dark: HEX.test(accent.text?.dark || '') ? accent.text.dark : hex,
        },
      },
      // the server resolves the palettes; without them the Classic dark default stands
      palettes:
        stored.palettes && stored.palettes.dark && stored.palettes.light && stored.palettes.oled ? stored.palettes : null,
    };
  }

  /** 'system' asks the OS. */
  function effective(theme) {
    if (theme.scheme !== 'system') return theme.scheme;
    try {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  /**
   * Writes the theme onto an element as inline custom properties. The document root for a page, the shadow host for
   * the in-page UI: everything inside inherits, so the stylesheets only ever read var(--panel) and friends.
   * `data-corners` is an attribute selectors key off: squared drops every radius.
   */
  function apply(theme, root = document.documentElement) {
    if (!root) return;
    const scheme = effective(theme);

    root.dataset.corners = theme.corners;
    root.dataset.scheme = scheme;
    root.style.colorScheme = scheme;

    const palette = (theme.palettes && theme.palettes[scheme === 'dark' && theme.oled ? 'oled' : scheme]) || DEFAULT_PALETTE;
    for (const [name, value] of Object.entries(palette)) root.style.setProperty(`--${kebab(name)}`, value);

    root.style.setProperty('--accent', theme.accent.hex);
    root.style.setProperty('--accent-2', theme.accent.hex2);
    root.style.setProperty('--accent-soft', theme.accent.soft);
    root.style.setProperty('--accent-ink', theme.accent.ink);
    root.style.setProperty('--accent-text', scheme === 'light' ? theme.accent.text.light : theme.accent.text.dark);
  }

  function cached() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? normalize(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  function cache(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
    } catch {
      // a full or disabled storage just costs the no-flash paint, not the theme itself
    }
  }

  globalThis.AbacusTheme = { STORAGE_KEY, DEFAULT_ACCENT, normalize, apply, effective, cached, cache };

  // Extension pages paint immediately from the mirror; content scripts (and Node, in the tests) leave the page alone.
  if (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') {
    const theme = cached();
    if (theme) apply(theme);
    // follow the OS while the scheme is "system"
    try {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        const current = cached();
        if (current) apply(current);
      });
    } catch {
      // no matchMedia: the theme only changes when the server says so
    }
  }
})();
