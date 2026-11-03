/**
 * The library's appearance: base colour scheme, theme, corners, OLED and one accent colour.
 *
 * It is a server-wide setting rather than a per-browser preference because the Chrome extension has to look like
 * the app it talks to: it reads this endpoint on connect and on every popup open.
 *
 * The server resolves the palettes, so clients only ever apply custom properties. Classic is the original Abacus
 * palette, written out by hand; the other themes are a hue and a saturation run through a lightness ladder per
 * mode (light, dark, OLED). Only the choices someone actually made are stored, so a missing value always follows
 * the current default.
 */
import { getSetting, putSetting } from './settings.js';

export const APPEARANCE_KEY = 'appearance';

/** The accent choices. */
export const ACCENTS = [
  { id: 'blue', label: 'Blue', hex: '#5b8cff' },
  { id: 'violet', label: 'Violet', hex: '#a78bfa' },
  { id: 'green', label: 'Green', hex: '#6cc48d' },
  { id: 'amber', label: 'Amber', hex: '#e8a33d' },
  { id: 'rose', label: 'Rose', hex: '#e8798a' },
  { id: 'slate', label: 'Slate', hex: '#9aa7b8' },
];

/** The original dark palette, value for value. */
const CLASSIC_DARK = {
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

/** The themes. `dark`, when present, replaces the ladder for the dark mode. */
export const THEMES = [
  { id: 'classic', label: 'Classic', hue: 230, sat: 9, dark: CLASSIC_DARK },
  { id: 'graphite', label: 'Graphite', hue: 40, sat: 6 },
  { id: 'slate', label: 'Slate', hue: 214, sat: 10 },
  { id: 'sepia', label: 'Sepia', hue: 32, sat: 18 },
];

export const SCHEMES = ['light', 'dark', 'system'];
export const CORNERS = ['squared', 'rounded'];

export const DEFAULT_APPEARANCE = {
  scheme: 'dark',
  theme: 'classic',
  oled: false,
  corners: 'rounded',
  accent: ACCENTS[0].hex,
};

const HEX = /^#[0-9a-f]{6}$/i;

const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const hsl = (h, s, l) => `hsl(${h} ${s}% ${clamp(l)}%)`;
const alpha = (h, s, l, a) => `hsl(${h} ${s}% ${clamp(l)}% / ${a})`;

/**
 * The lightness ladders. Dark and OLED share the text ramp; OLED drops the surfaces to black and thickens the
 * hairlines so the edges still read without a lit panel behind them.
 */
const MODES = {
  dark: { bg: 7.5, panel: 10.5, panel2: 13.5, panel3: 16.5, text: 93, dim: 65, faint: 45, scrim: 0.6, hairline: 0.07 },
  oled: { bg: 0, panel: 3, panel2: 5.5, panel3: 9, text: 93, dim: 65, faint: 50, scrim: 0.72, hairline: 0.12 },
  light: { bg: 95, panel: 92, panel2: 98, panel3: 87, text: 12, dim: 34, faint: 47, scrim: 0.32, hairline: 0.1 },
};

/** Everything a surface needs, as custom-property values. Keys map to `--bg`, `--panel-2`, … */
function palette(theme, mode) {
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
    // how dark the stylesheet's other drop shadows are (they multiply their alpha by it)
    shade: dark ? '1' : '0.35',
    danger: dark ? '#ff5f5f' : 'hsl(0 68% 48%)',
    ok: dark ? '#3ddc97' : 'hsl(155 60% 30%)',
  };
}

function channels(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
const toHex = (rgb) => '#' + rgb.map(hex2).join('');

/** WCAG relative luminance, for choosing ink that stays readable on the accent. */
function luminance(hex) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const INK_DARK = '#14120d';

/** Text and icons that sit on the accent itself: white, as the app always had, unless it drops under 3:1. */
export function inkFor(hex) {
  return contrast(luminance(hex), 1) >= 3 ? '#ffffff' : INK_DARK;
}

/** The wash used for the active row, selection fills and focus rings. */
export function softFor(hex) {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, 0.16)`;
}

/** `hex` mixed toward `toward` by `amount` (0..1), for accent ink that stays readable on light surfaces. */
export function mixHex(hex, toward, amount) {
  const a = channels(hex);
  const b = channels(toward);
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
}

/** The same colour turned `deg` round the hue wheel: the second stop of the accent gradients (blue → violet). */
export function rotateHue(hex, deg) {
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

const themeById = (id) => THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_APPEARANCE.theme);

/** Stored values are the choices; this expands them into what a client needs to paint. */
export function resolveAppearance(stored = {}) {
  const scheme = SCHEMES.includes(stored.scheme) ? stored.scheme : DEFAULT_APPEARANCE.scheme;
  const theme = themeById(stored.theme);
  const corners = CORNERS.includes(stored.corners) ? stored.corners : DEFAULT_APPEARANCE.corners;
  const oled = typeof stored.oled === 'boolean' ? stored.oled : DEFAULT_APPEARANCE.oled;
  const hex = HEX.test(String(stored.accent || '')) ? String(stored.accent).toLowerCase() : DEFAULT_APPEARANCE.accent;
  const preset = ACCENTS.find((a) => a.hex === hex);

  return {
    scheme,
    theme: theme.id,
    corners,
    oled,
    accent: {
      id: preset ? preset.id : 'custom',
      label: preset ? preset.label : 'Custom',
      hex,
      hex2: rotateHue(hex, 35),
      ink: inkFor(hex),
      soft: softFor(hex),
      // the accent as ink: the same hue, darkened on light surfaces so labels keep their contrast
      text: { light: mixHex(hex, '#000000', 0.38), dark: hex },
    },
    palettes: {
      light: palette(theme, 'light'),
      dark: palette(theme, 'dark'),
      oled: palette(theme, 'oled'),
    },
    themes: THEMES.map((t) => {
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
    }),
    presets: ACCENTS,
  };
}

export function getAppearance() {
  return resolveAppearance(getSetting(APPEARANCE_KEY, {}));
}

/** Accepts any subset of `{ scheme, theme, oled, corners, accent }`; unknown values are ignored. */
export function updateAppearance(patch = {}) {
  const next = { ...getSetting(APPEARANCE_KEY, {}) };

  if (SCHEMES.includes(patch.scheme)) next.scheme = patch.scheme;
  if (THEMES.some((t) => t.id === patch.theme)) next.theme = patch.theme;
  if (typeof patch.oled === 'boolean') next.oled = patch.oled;
  if (CORNERS.includes(patch.corners)) next.corners = patch.corners;

  const asked = typeof patch.accent === 'string' ? patch.accent.trim() : '';
  if (asked) {
    const preset = ACCENTS.find((a) => a.id === asked.toLowerCase());
    if (preset) next.accent = preset.hex;
    else if (HEX.test(asked)) next.accent = asked.toLowerCase();
  }

  putSetting(APPEARANCE_KEY, next);
  return resolveAppearance(next);
}
