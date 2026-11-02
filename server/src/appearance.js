/**
 * The library's appearance: base colour scheme, theme, corners and one accent colour.
 *
 * It is a server-wide setting rather than a per-browser preference because the Chrome extension has to look like
 * the app it talks to: it reads this endpoint on connect and on every popup open.
 *
 * The server resolves the palettes, so no client re-implements the colour maths: a theme is a hue and a
 * saturation, a mode is a lightness ladder, and the palette is the product of the two. Three modes ship — light,
 * dark, and OLED (pure black) — and the app and the extension only ever apply custom properties.
 */
import { getSetting, putSetting } from './settings.js';

export const APPEARANCE_KEY = 'appearance';

/** The accent choices. `hex` is the one accent every surface uses; nothing else takes colour. */
export const ACCENTS = [
  { id: 'amber', label: 'Amber', hex: '#e8a33d' },
  { id: 'blue', label: 'Blue', hex: '#5b8cff' },
  { id: 'violet', label: 'Violet', hex: '#a78bfa' },
  { id: 'green', label: 'Green', hex: '#6cc48d' },
  { id: 'rose', label: 'Rose', hex: '#e8798a' },
  { id: 'slate', label: 'Slate', hex: '#9aa7b8' },
];

/** The themes: one neutral ramp each, tinted by hue and saturation. */
export const THEMES = [
  { id: 'graphite', label: 'Graphite', hue: 40, sat: 6 },
  { id: 'slate', label: 'Slate', hue: 214, sat: 10 },
  { id: 'sepia', label: 'Sepia', hue: 32, sat: 18 },
];

export const SCHEMES = ['light', 'dark', 'system'];
export const CORNERS = ['squared', 'rounded'];

export const DEFAULT_APPEARANCE = { scheme: 'dark', theme: 'graphite', oled: false, corners: 'squared', accent: ACCENTS[0].hex };

const HEX = /^#[0-9a-f]{6}$/i;

const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const hsl = (h, s, l) => `hsl(${h} ${s}% ${clamp(l)}%)`;
const alpha = (h, s, l, a) => `hsl(${h} ${s}% ${clamp(l)}% / ${a})`;

/**
 * The lightness ladders. Dark and OLED share the text ramp; OLED drops the surfaces to black and thickens the
 * hairlines so the edges still read without a lit panel behind them.
 */
const MODES = {
  dark: { bg: 6.5, panel: 9.5, panel2: 12.5, panel3: 16, text: 91, dim: 64, faint: 50, scrim: 0.55, hairline: 0.09 },
  oled: { bg: 0, panel: 3, panel2: 5.5, panel3: 9, text: 91, dim: 64, faint: 50, scrim: 0.72, hairline: 0.14 },
  light: { bg: 95, panel: 92, panel2: 97, panel3: 87, text: 12, dim: 34, faint: 47, scrim: 0.32, hairline: 0.12 },
};

/** Everything a surface needs, as custom-property values. Keys map to `--bg`, `--panel-2`, … */
function palette(theme, mode) {
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
    // the plate of a primary button: light on dark themes, ink on light ones
    primary: dark ? text : hsl(h, s, 14),
    onPrimary: dark ? '#14120d' : hsl(h, s, 96),
    primaryHover: dark ? hsl(h, s, 97) : hsl(h, s, 20),
    danger: dark ? hsl(6, 62, 58) : hsl(6, 58, 44),
    dangerSoft: alpha(6, 62, dark ? 58 : 44, 0.14),
    ok: dark ? hsl(155, 42, 56) : hsl(155, 45, 32),
    okSoft: alpha(155, 42, dark ? 56 : 32, 0.14),
  };
}

function channels(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

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
const INK_LIGHT = '#f4f1ea';

/** Text and icons that sit on the accent itself. Whichever of near-black or paper contrasts better. */
export function inkFor(hex) {
  const l = luminance(hex);
  return contrast(l, luminance(INK_DARK)) >= contrast(l, luminance(INK_LIGHT)) ? INK_DARK : INK_LIGHT;
}

/** The 14% wash used for the active row, selection fills and focus rings. */
export function softFor(hex) {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');

/** `hex` mixed toward `toward` by `amount` (0..1), for accent ink that stays readable on light surfaces. */
export function mixHex(hex, toward, amount) {
  const a = channels(hex);
  const b = channels(toward);
  return '#' + a.map((v, i) => hex2(v + (b[i] - v) * amount)).join('');
}

const themeById = (id) => THEMES.find((t) => t.id === id) ?? THEMES[0];

/** Stored values are the choices; this expands them into what a client needs to paint. */
export function resolveAppearance(stored = {}) {
  const scheme = SCHEMES.includes(stored.scheme) ? stored.scheme : DEFAULT_APPEARANCE.scheme;
  const theme = themeById(stored.theme);
  const corners = CORNERS.includes(stored.corners) ? stored.corners : DEFAULT_APPEARANCE.corners;
  const oled = stored.oled === true;
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
  return resolveAppearance(getSetting(APPEARANCE_KEY, DEFAULT_APPEARANCE));
}

/** Accepts any subset of `{ scheme, theme, oled, corners, accent }`; unknown values are ignored. */
export function updateAppearance(patch = {}) {
  const current = { ...DEFAULT_APPEARANCE, ...getSetting(APPEARANCE_KEY, DEFAULT_APPEARANCE) };
  const next = { ...current };

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

  putSetting(APPEARANCE_KEY, {
    scheme: next.scheme,
    theme: next.theme,
    oled: next.oled,
    corners: next.corners,
    accent: next.accent,
  });
  return resolveAppearance(next);
}
