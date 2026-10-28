/**
 * Perceptual colour search over the pixels that are actually in an image.
 *
 * Indexing builds a weighted histogram in OKLab (Ottosson, 2020) — the space
 * modern colour engines use because Euclidean distance there tracks perceived
 * difference far better than RGB, HSV, or the old redmean approximation.
 * Search ranks an item by how much of its real colour mass sits near the query
 * colour, with a soft Gaussian falloff (σ ≈ 4 ΔE, the just-noticeable-difference
 * scale), so a small accent of the exact code still outranks a large wash of a
 * merely similar one.
 */

const BINS = 24; // per OKLab axis. Cells are ~3 ΔE wide, below one just-noticeable difference.
const LAB_MIN = [-0.1, -0.4, -0.4];
const LAB_MAX = [1.05, 0.4, 0.4];

/** Gaussian width in OKLab ΔE. ~4 ΔE is one just-noticeable difference. */
export const COLOR_SIGMA = 0.045;

/** A pixel counts as "this colour" inside ~2.2σ (about 10 ΔE). */
export const COLOR_MATCH_RANGE = COLOR_SIGMA * 2.2;

/**
 * Suggested starting colours (the UI keeps its own short list): a neutral ramp
 * plus the distinct hues people actually search for. These are swatches, not
 * tags — matching still runs against indexed pixel codes.
 */
export const RECOMMENDED_COLORS = [
  '#ffffff',
  '#808080',
  '#000000',
  '#e53935',
  '#fb8c00',
  '#43a047',
  '#1e88e5',
  '#8e24aa',
];

export function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(r, g, b) {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** sRGB byte → linear light. */
function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** Björn Ottosson's OKLab. L in ~[0, 1], a/b in ~[-0.4, 0.4]. */
export function rgbToOklab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function labToBin(v, axis) {
  const t = (v - LAB_MIN[axis]) / (LAB_MAX[axis] - LAB_MIN[axis]);
  return Math.max(0, Math.min(BINS - 1, Math.floor(t * BINS)));
}

function binIndex(l, a, b) {
  return (l * BINS + a) * BINS + b;
}

/**
 * Collapse raw pixels into a sparse OKLab histogram.
 * `pixels` is interleaved RGB (r, g, b, …). Each occupied cell keeps the mean
 * colour of the pixels that fell in it, so a searched code is compared with the
 * colour that is actually in the image rather than with a snapped bin centre.
 * Returns [{l, a, b, w}] with weights summing to 1.
 */
export function histogramFromRgb(pixels, channels = 3) {
  const cells = new Map();
  let total = 0;
  const n = Math.floor(pixels.length / channels);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const lab = rgbToOklab(pixels[o], pixels[o + 1], pixels[o + 2]);
    const key = binIndex(labToBin(lab[0], 0), labToBin(lab[1], 1), labToBin(lab[2], 2));
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = [0, 0, 0, 0]));
    cell[0] += lab[0];
    cell[1] += lab[1];
    cell[2] += lab[2];
    cell[3]++;
    total++;
  }
  if (!total) return [];
  const out = [];
  for (const cell of cells.values()) {
    out.push({
      l: round4(cell[0] / cell[3]),
      a: round4(cell[1] / cell[3]),
      b: round4(cell[2] / cell[3]),
      w: round4(cell[3] / total),
    });
  }
  out.sort((x, y) => y.w - x.w);
  return out;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** Pack a histogram for the color_hist column. */
export function encodeHistogram(bins) {
  return JSON.stringify(bins);
}

export function decodeHistogram(raw) {
  if (!raw) return [];
  try {
    const bins = JSON.parse(raw);
    return Array.isArray(bins) ? bins : [];
  } catch {
    return [];
  }
}

/**
 * Flatten `[{l, a, b, w}]` into `[l, a, b, w, …]`. Ranking runs on the packed
 * form: decoding a library's histograms is the expensive part of a search, so
 * the result is cached and scored without allocating per bin.
 */
export function packHistogram(bins) {
  const flat = new Float32Array((bins?.length || 0) * 4);
  for (let i = 0; i < (bins?.length || 0); i++) {
    const bin = bins[i];
    flat[i * 4] = bin.l;
    flat[i * 4 + 1] = bin.a;
    flat[i * 4 + 2] = bin.b;
    flat[i * 4 + 3] = bin.w;
  }
  return flat;
}

/**
 * Fraction of the image's colour mass that is perceptually the query colour.
 * A Gaussian kernel (not a hard cutoff) so closer codes always score higher,
 * which is what makes an exact-code search precise rather than "about red".
 * `packed` is the flat histogram from packHistogram().
 */
export function colorScore(packed, lab, sigma = COLOR_SIGMA) {
  if (!packed?.length) return 0;
  const inv = 1 / (2 * sigma * sigma);
  const limit = sigma * sigma * 12; // beyond ~3.5σ a bin cannot move the ranking
  let score = 0;
  for (let i = 0; i < packed.length; i += 4) {
    const dl = packed[i] - lab[0];
    const da = packed[i + 1] - lab[1];
    const db = packed[i + 2] - lab[2];
    const d2 = dl * dl + da * da + db * db;
    if (d2 > limit) continue;
    score += packed[i + 3] * Math.exp(-d2 * inv);
  }
  return score;
}

/**
 * Bins whose centre is inside the match range of the query. Used as a SQL
 * prefilter so paging never has to score the whole library in JS.
 */
export function queryBinRange(lab) {
  const span = COLOR_MATCH_RANGE;
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    lo[axis] = labToBin(lab[axis] - span, axis);
    hi[axis] = labToBin(lab[axis] + span, axis);
  }
  return { lo, hi };
}

/** Accept #RGB, #RRGGBB, RRGGBB, and rgb(r, g, b). */
export function parseColor(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const rgb = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) {
    const parts = rgb.slice(1, 4).map(Number);
    if (parts.some((n) => n > 255)) return null;
    return rgbToHex(...parts);
  }
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return (
      '#' +
      hex
        .split('')
        .map((c) => c + c)
        .join('')
        .toLowerCase()
    );
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) return '#' + hex.toLowerCase();
  return null;
}
