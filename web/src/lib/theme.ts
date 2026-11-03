/**
 * The library's appearance: base colour scheme, theme, corners, OLED and one accent colour. Classic, the default, is
 * the original Abacus palette; `styles.css` carries the same values in `:root` for the first paint.
 *
 * The server owns it (it is shared, and the Chrome extension reads the same endpoint so it can match), but the app
 * has to paint before the first request lands, so the last known value is cached here. `applyAppearance` is the only
 * place that writes the theme to the document: it sets `data-corners` (squared drops every radius) and writes the palette
 * and accent as custom properties, which override the defaults in `:root`.
 *
 * The demo build has no server, so the palette maths is mirrored here from `server/src/appearance.js`. Keep the two
 * in step: same themes, same ladders, same output.
 */
import type { AccentPreset, Appearance, AppearanceChoice, Palette, ThemeChoice } from '../types';

const CACHE_KEY = 'abacus-appearance';

/** Mirrors `server/src/appearance.js`. */
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'blue', label: 'Blue', hex: '#5b8cff' },
  { id: 'violet', label: 'Violet', hex: '#a78bfa' },
  { id: 'green', label: 'Green', hex: '#6cc48d' },
  { id: 'amber', label: 'Amber', hex: '#e8a33d' },
  { id: 'rose', label: 'Rose', hex: '#e8798a' },
  { id: 'slate', label: 'Slate', hex: '#9aa7b8' },
];

/** The original dark palette, value for value. */
const CLASSIC_DARK: Palette = {
  bg: '#121316',
  panel: '#18191d',
  panel2: '#1f2025',
  panel3: '#26272d',
  raise: '#2e2f36',
  hover: 'rgba(255, 255, 255, 0.055)',
  track: 'rgba(255, 255, 255, 0.06)',
  border: 'rgba(255, 255, 255, 0.07)',
  borderStrong: 'rgba(255, 255, 255, 0.12)',
  text: '#ececef',
  textDim: '#a1a3ab',
  textFaint: '#6c6e77',
  overlay: 'rgba(32, 33, 39, 0.97)',
  float: 'rgba(36, 37, 43, 0.97)',
  scrim: 'rgba(6, 7, 9, 0.6)',
  stage: '#0b0c0f',
  checkerA: '#1c1d22',
  checkerB: '#202127',
  shadow: '0 18px 50px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.35)',
  shade: '1',
  danger: '#ff5f5f',
  ok: '#3ddc97',
};

interface Theme {
  id: string;
  label: string;
  hue: number;
  sat: number;
  dark?: Palette;
}

const THEMES: Theme[] = [
  { id: 'classic', label: 'Classic', hue: 230, sat: 9, dark: CLASSIC_DARK },
  { id: 'graphite', label: 'Graphite', hue: 40, sat: 6 },
  { id: 'slate', label: 'Slate', hue: 214, sat: 10 },
  { id: 'sepia', label: 'Sepia', hue: 32, sat: 18 },
];

const MODES = {
  dark: { bg: 7.5, panel: 10.5, panel2: 13.5, panel3: 16.5, text: 93, dim: 65, faint: 45, scrim: 0.6, hairline: 0.07 },
  oled: { bg: 0, panel: 3, panel2: 5.5, panel3: 9, text: 93, dim: 65, faint: 50, scrim: 0.72, hairline: 0.12 },
  light: { bg: 95, panel: 92, panel2: 98, panel3: 87, text: 12, dim: 34, faint: 47, scrim: 0.32, hairline: 0.1 },
} as const;

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const hsl = (h: number, s: number, l: number) => `hsl(${h} ${s}% ${clamp(l)}%)`;
const alpha = (h: number, s: number, l: number, a: number) => `hsl(${h} ${s}% ${clamp(l)}% / ${a})`;

function palette(theme: Theme, mode: keyof typeof MODES): Palette {
  if (mode === 'dark' && theme.dark) return theme.dark;
  const { hue: h, sat: s } = theme;
  const m = MODES[mode];
  const dark = mode !== 'light';

  return {
    bg: hsl(h, s, m.bg),
    panel: hsl(h, s, m.panel),
    panel2: hsl(h, s, m.panel2),
    panel3: hsl(h, s, m.panel3),
    raise: dark ? hsl(h, s, m.panel3 + 3.5) : hsl(h, s, m.panel3 - 3),
    hover: alpha(h, s, m.text, 0.055),
    track: alpha(h, s, m.text, 0.06),
    border: alpha(h, s, m.text, m.hairline),
    borderStrong: alpha(h, s, m.text, m.hairline + 0.05),
    text: hsl(h, s, m.text),
    textDim: hsl(h, s, m.dim),
    textFaint: hsl(h, s, m.faint),
    overlay: alpha(h, s, dark ? (m.panel2 + m.panel3) / 2 : m.panel2, 0.97),
    float: alpha(h, s, dark ? m.panel3 + 1 : m.panel2, 0.97),
    scrim: `hsl(0 0% 0% / ${m.scrim})`,
    stage: hsl(h, s, dark ? m.bg - 3 : m.panel3 - 4),
    checkerA: hsl(h, s, dark ? m.panel2 + 1.5 : m.panel3 + 2),
    checkerB: hsl(h, s, dark ? m.panel2 + 3 : m.panel3 + 4),
    shadow: dark
      ? '0 18px 50px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.35)'
      : `0 18px 50px hsl(${h} 12% 20% / 0.14), 0 2px 8px hsl(${h} 12% 20% / 0.08)`,
    shade: dark ? '1' : '0.35',
    danger: dark ? '#ff5f5f' : 'hsl(0 68% 48%)',
    ok: dark ? '#3ddc97' : 'hsl(155 60% 30%)',
  };
}

export const DEFAULT_APPEARANCE: AppearanceChoice = {
  scheme: 'dark',
  theme: 'classic',
  corners: 'rounded',
  oled: false,
  accent: ACCENT_PRESETS[0].hex,
};

const HEX = /^#[0-9a-f]{6}$/i;

function channels(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
const toHex = (rgb: number[]) => '#' + rgb.map(hex2).join('');

function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** White on the accent, as the app always had, unless it drops under 3:1. Same rule as the server's `inkFor`. */
export function inkFor(hex: string) {
  return contrast(luminance(hex), 1) >= 3 ? '#ffffff' : '#14120d';
}

function mixHex(hex: string, toward: string, amount: number) {
  const a = channels(hex);
  const b = channels(toward);
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
}

/** Mirrors the server's `rotateHue`: the second stop of the accent gradients. */
function rotateHue(hex: string, deg: number) {
  const [r, g, b] = channels(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return hex.toLowerCase();
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const hue = (((h * 60 + deg) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return toHex([r1, g1, b1].map((v) => (v + m) * 255));
}

/** Expands the stored choices into everything a client needs to paint. Mirrors the server's `resolveAppearance`. */
export function resolveAppearance(stored: Partial<AppearanceChoice> = {}): Appearance {
  const scheme = stored.scheme === 'light' || stored.scheme === 'system' ? stored.scheme : DEFAULT_APPEARANCE.scheme;
  const theme = THEMES.find((t) => t.id === stored.theme) ?? THEMES.find((t) => t.id === DEFAULT_APPEARANCE.theme)!;
  const corners = stored.corners === 'squared' || stored.corners === 'rounded' ? stored.corners : DEFAULT_APPEARANCE.corners;
  const oled = typeof stored.oled === 'boolean' ? stored.oled : DEFAULT_APPEARANCE.oled;
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
      hex2: rotateHue(hex, 35),
      ink: inkFor(hex),
      soft: `rgba(${r}, ${g}, ${b}, 0.16)`,
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
  root.style.setProperty('--accent-2', appearance.accent.hex2);
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
