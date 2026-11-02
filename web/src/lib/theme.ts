/**
 * The library's appearance: base colour scheme, theme, corners, OLED and one accent colour.
 *
 * The server owns it (it is shared, and the Chrome extension reads the same endpoint so it can match), but the app
 * has to paint before the first request lands, so the last known value is cached here. `applyAppearance` is the only
 * place that writes the theme to the document: it sets `data-corners` for the radius scale and writes the palette
 * and accent as custom properties, which override the defaults in `:root`.
 *
 * The demo build has no server, so the palette maths is mirrored here from `server/src/appearance.js`. Keep the two
 * in step: same themes, same ladders, same output.
 */
import type { AccentPreset, Appearance, AppearanceChoice, Palette, ThemeChoice } from '../types';

const CACHE_KEY = 'abacus-appearance';

/** Mirrors `server/src/appearance.js`. */
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'amber', label: 'Amber', hex: '#e8a33d' },
  { id: 'blue', label: 'Blue', hex: '#5b8cff' },
  { id: 'violet', label: 'Violet', hex: '#a78bfa' },
  { id: 'green', label: 'Green', hex: '#6cc48d' },
  { id: 'rose', label: 'Rose', hex: '#e8798a' },
  { id: 'slate', label: 'Slate', hex: '#9aa7b8' },
];

const THEMES = [
  { id: 'graphite', label: 'Graphite', hue: 40, sat: 6 },
  { id: 'slate', label: 'Slate', hue: 214, sat: 10 },
  { id: 'sepia', label: 'Sepia', hue: 32, sat: 18 },
];

const MODES = {
  dark: { bg: 6.5, panel: 9.5, panel2: 12.5, panel3: 16, text: 91, dim: 64, faint: 50, scrim: 0.55, hairline: 0.09 },
  oled: { bg: 0, panel: 3, panel2: 5.5, panel3: 9, text: 91, dim: 64, faint: 50, scrim: 0.72, hairline: 0.14 },
  light: { bg: 95, panel: 92, panel2: 97, panel3: 87, text: 12, dim: 34, faint: 47, scrim: 0.32, hairline: 0.12 },
} as const;

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const hsl = (h: number, s: number, l: number) => `hsl(${h} ${s}% ${clamp(l)}%)`;
const alpha = (h: number, s: number, l: number, a: number) => `hsl(${h} ${s}% ${clamp(l)}% / ${a})`;

function palette(theme: (typeof THEMES)[number], mode: keyof typeof MODES): Palette {
  const { hue: h, sat: s } = theme;
  const m = MODES[mode];
  const dark = mode !== 'light';
  const text = hsl(h, s, m.text);

  return {
    bg: hsl(h, s, m.bg),
    panel: hsl(h, s, m.panel),
    panel2: hsl(h, s, m.panel2),
    panel3: hsl(h, s, m.panel3),
    raise: dark ? hsl(h, s, m.panel3 + 3) : hsl(h, s, m.panel3 - 3),
    hover: alpha(h, s, m.text, 0.05),
    track: alpha(h, s, m.text, 0.08),
    border: alpha(h, s, m.text, m.hairline),
    borderStrong: alpha(h, s, m.text, m.hairline + 0.07),
    text,
    textDim: hsl(h, s, m.dim),
    textFaint: hsl(h, s, m.faint),
    overlay: alpha(h, s, m.panel, 0.97),
    scrim: `hsl(0 0% 0% / ${m.scrim})`,
    stage: hsl(h, s, dark ? m.bg - 2 : m.panel3 - 4),
    stageDot: alpha(h, s, m.text, 0.08),
    checkerA: hsl(h, s, m.panel2),
    checkerB: hsl(h, s, m.panel3),
    shadow: dark ? '0 12px 32px hsl(0 0% 0% / 0.55)' : '0 12px 32px hsl(32 12% 20% / 0.16)',
    primary: dark ? text : hsl(h, s, 14),
    onPrimary: dark ? '#14120d' : hsl(h, s, 96),
    primaryHover: dark ? hsl(h, s, 97) : hsl(h, s, 20),
    danger: dark ? hsl(6, 62, 58) : hsl(6, 58, 44),
    dangerSoft: alpha(6, 62, dark ? 58 : 44, 0.14),
    ok: dark ? hsl(155, 42, 56) : hsl(155, 45, 32),
    okSoft: alpha(155, 42, dark ? 56 : 32, 0.14),
  };
}

export const DEFAULT_APPEARANCE: AppearanceChoice = {
  scheme: 'dark',
  theme: 'graphite',
  corners: 'squared',
  oled: false,
  accent: ACCENT_PRESETS[0].hex,
};

const HEX = /^#[0-9a-f]{6}$/i;

function channels(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const INK_DARK = '#14120d';
const INK_LIGHT = '#f4f1ea';

/** Whichever of near-black or paper reads better on the accent. Same rule as the server's `inkFor`. */
export function inkFor(hex: string) {
  const l = luminance(hex);
  return contrast(l, luminance(INK_DARK)) >= contrast(l, luminance(INK_LIGHT)) ? INK_DARK : INK_LIGHT;
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');

function mixHex(hex: string, toward: string, amount: number) {
  const a = channels(hex);
  const b = channels(toward);
  return '#' + a.map((v, i) => hex2(v + (b[i] - v) * amount)).join('');
}

/** Expands the stored choices into everything a client needs to paint. Mirrors the server's `resolveAppearance`. */
export function resolveAppearance(stored: Partial<AppearanceChoice> = {}): Appearance {
  const scheme = stored.scheme === 'light' || stored.scheme === 'system' ? stored.scheme : 'dark';
  const theme = THEMES.find((t) => t.id === stored.theme) ?? THEMES[0];
  const corners = stored.corners === 'rounded' ? 'rounded' : 'squared';
  const oled = stored.oled === true;
  const hex = HEX.test(String(stored.accent || '')) ? String(stored.accent).toLowerCase() : DEFAULT_APPEARANCE.accent;
  const preset = ACCENT_PRESETS.find((a) => a.hex === hex);
  const [r, g, b] = channels(hex);

  const themes: ThemeChoice[] = THEMES.map((t) => {
    const dark = palette(t, 'dark');
    const light = palette(t, 'light');
    return {
      id: t.id,
      label: t.label,
      preview: {
        light: { bg: light.bg, panel: light.panel3, text: light.text },
        dark: { bg: dark.bg, panel: dark.panel3, text: dark.text },
      },
    };
  });

  return {
    scheme,
    theme: theme.id,
    corners,
    oled,
    accent: {
      id: preset?.id ?? 'custom',
      label: preset?.label ?? 'Custom',
      hex,
      ink: inkFor(hex),
      soft: `rgba(${r}, ${g}, ${b}, 0.14)`,
      text: { light: mixHex(hex, '#000000', 0.38), dark: hex },
    },
    palettes: {
      light: palette(theme, 'light'),
      dark: palette(theme, 'dark'),
      oled: palette(theme, 'oled'),
    },
    themes,
    presets: ACCENT_PRESETS,
  };
}

const KEBAB = (name: string) =>
  name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()).replace(/\d/g, (d) => '-' + d);

/** Which of the three palettes applies right now. `system` asks the OS. */
export function effectiveScheme(appearance: Appearance): 'light' | 'dark' {
  if (appearance.scheme !== 'system') return appearance.scheme;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function paletteFor(appearance: Appearance, scheme = effectiveScheme(appearance)): Palette {
  return scheme === 'dark' && appearance.oled ? appearance.palettes.oled : appearance.palettes[scheme];
}

export function applyAppearance(appearance: Appearance) {
  const root = document.documentElement;
  const scheme = effectiveScheme(appearance);

  root.dataset.corners = appearance.corners;
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;

  for (const [name, value] of Object.entries(paletteFor(appearance, scheme))) {
    root.style.setProperty(`--${KEBAB(name)}`, value);
  }

  root.style.setProperty('--accent', appearance.accent.hex);
  root.style.setProperty('--accent-soft', appearance.accent.soft);
  root.style.setProperty('--accent-ink', appearance.accent.ink);
  root.style.setProperty('--accent-text', appearance.accent.text[scheme]);
}

/** Follow the OS while the scheme is `system`. Returns a disposer. */
export function watchSystemScheme(onChange: () => void) {
  const query = window.matchMedia('(prefers-color-scheme: light)');
  const listener = () => onChange();
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

export function cachedAppearance(): Appearance | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? resolveAppearance(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function cacheAppearance(appearance: Appearance) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        scheme: appearance.scheme,
        theme: appearance.theme,
        corners: appearance.corners,
        oled: appearance.oled,
        accent: appearance.accent.hex,
      })
    );
  } catch {
    // private mode: the theme still applies for this page, it just won't survive a reload before the server answers
  }
}

/** Read the cached theme from the server payload (the full resolved object is cached by `cacheAppearance`). */
export function initAppearance() {
  applyAppearance(cachedAppearance() ?? resolveAppearance());
}
