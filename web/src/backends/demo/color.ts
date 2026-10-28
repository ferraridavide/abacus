// Colour search for the demo, ported from server/src/color.js: an OKLab histogram per image, scored with a Gaussian
// so an exact code outranks a merely similar one.

const BINS = 24;
const LAB_MIN = [-0.1, -0.4, -0.4];
const LAB_MAX = [1.05, 0.4, 0.4];
const COLOR_SIGMA = 0.045;

/** A candidate counts only when a real share of its pixels is perceptually the query colour. */
export const COLOR_MIN_SCORE = 0.02;

export function hexToRgb(hex: string): [number, number, number] | null {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function srgbToLinear(c: number) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
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

function labToBin(v: number, axis: number) {
  const t = (v - LAB_MIN[axis]) / (LAB_MAX[axis] - LAB_MIN[axis]);
  return Math.max(0, Math.min(BINS - 1, Math.floor(t * BINS)));
}

/**
 * Collapse RGBA pixels into a sparse OKLab histogram, packed flat as [l, a, b, w, …] with weights summing to 1.
 * Each cell keeps the mean colour of its pixels, not the snapped bin centre.
 */
export function histogram(rgba: Uint8ClampedArray): number[] {
  const cells = new Map<number, [number, number, number, number]>();
  let total = 0;
  for (let o = 0; o < rgba.length; o += 4) {
    if (rgba[o + 3] < 16) continue; // ignore fully transparent pixels
    const lab = rgbToOklab(rgba[o], rgba[o + 1], rgba[o + 2]);
    const key = (labToBin(lab[0], 0) * BINS + labToBin(lab[1], 1)) * BINS + labToBin(lab[2], 2);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = [0, 0, 0, 0]));
    cell[0] += lab[0];
    cell[1] += lab[1];
    cell[2] += lab[2];
    cell[3]++;
    total++;
  }
  const out: number[] = [];
  for (const c of cells.values()) out.push(c[0] / c[3], c[1] / c[3], c[2] / c[3], c[3] / total);
  return out;
}

/** Fraction of the image's colour mass that is perceptually the query colour. */
export function colorScore(packed: number[], lab: [number, number, number]) {
  const inv = 1 / (2 * COLOR_SIGMA * COLOR_SIGMA);
  const limit = COLOR_SIGMA * COLOR_SIGMA * 12;
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

/** Accept #RGB, #RRGGBB, RRGGBB, and rgb(r, g, b). */
export function parseColor(input: string | undefined) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const rgb = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map(Number);
    return r > 255 || g > 255 || b > 255 ? null : rgbToHex(r, g, b);
  }
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) return '#' + [...hex.toLowerCase()].map((c) => c + c).join('');
  if (/^[0-9a-f]{6}$/i.test(hex)) return '#' + hex.toLowerCase();
  return null;
}

/** Dominant colours by a small k-means over RGBA pixels, as in server/src/media.js. */
export function palette(rgba: Uint8ClampedArray, k = 6) {
  const px: [number, number, number][] = [];
  for (let o = 0; o < rgba.length; o += 4) if (rgba[o + 3] >= 16) px.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
  const n = px.length;
  if (!n) return [];
  const dist = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  // deterministic farthest-point seeding
  const centers: number[][] = [px[Math.floor(n / 2)].slice()];
  while (centers.length < k) {
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < n; i += 3) {
      let d = Infinity;
      for (const c of centers) d = Math.min(d, dist(px[i], c));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    centers.push(px[best].slice());
  }

  const assign = new Int32Array(n);
  for (let iter = 0; iter < 10; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dist(px[i], centers[c]);
        if (d < bd) {
          bd = d;
          bi = c;
        }
      }
      assign[i] = bi;
      const s = sums[bi];
      s[0] += px[i][0];
      s[1] += px[i][1];
      s[2] += px[i][2];
      s[3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      const s = sums[c];
      if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    }
  }
  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < n; i++) counts[assign[i]]++;

  // merge near-identical clusters
  const merged: { c: number[]; count: number }[] = [];
  const clusters = centers
    .map((c, i) => ({ c, count: counts[i] }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
  for (const cl of clusters) {
    const near = merged.find((m) => dist(m.c, cl.c) < 18 * 18 * 3);
    if (near) near.count += cl.count;
    else merged.push({ ...cl });
  }
  return merged
    .filter((m) => m.count / n >= 0.02)
    .slice(0, 6)
    .map((m) => ({ hex: rgbToHex(m.c[0], m.c[1], m.c[2]), ratio: Math.round((m.count / n) * 1000) / 1000 }));
}
