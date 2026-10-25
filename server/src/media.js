import fs from 'node:fs';
import sharp from 'sharp';
import { histogramFromRgb, encodeHistogram } from './color.js';

sharp.cache(false);

const THUMB_WIDTH = 720;

/**
 * Inspect an image buffer. Returns null if sharp cannot decode it.
 * Width/height are post-EXIF-rotation.
 */
export async function probeImage(buffer) {
  try {
    const meta = await sharp(buffer, { animated: true, limitInputPixels: false }).metadata();
    let width = meta.width;
    let height = meta.pageHeight || meta.height;
    if (meta.orientation && meta.orientation >= 5) [width, height] = [height, width];
    return {
      width,
      height,
      format: meta.format,
      animated: (meta.pages || 1) > 1,
    };
  } catch {
    return null;
  }
}

/** Build a webp thumbnail (first frame for animations). */
export async function makeThumb(buffer) {
  return sharp(buffer, { animated: false, limitInputPixels: false })
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

/** Extract a dominant colour palette via a small k-means. */
export async function extractPalette(buffer, k = 6) {
  try {
    const { data, info } = await sharp(buffer, { animated: false, limitInputPixels: false })
      .rotate()
      .resize(56, 56, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const n = info.width * info.height;
    const px = new Array(n);
    for (let i = 0; i < n; i++) px[i] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    if (!n) return [];

    // k-means++ style seeding (deterministic: farthest point)
    const centers = [px[Math.floor(n / 2)].slice()];
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
    const clusters = centers
      .map((c, i) => ({ c, count: counts[i] }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
    const merged = [];
    for (const cl of clusters) {
      const near = merged.find((m) => dist(m.c, cl.c) < 18 * 18 * 3);
      if (near) near.count += cl.count;
      else merged.push({ ...cl });
    }
    return merged
      .filter((m) => m.count / n >= 0.02)
      .slice(0, 6)
      .map((m) => ({ hex: toHex(m.c), ratio: Math.round((m.count / n) * 1000) / 1000 }));
  } catch {
    return [];
  }
}

/**
 * Histogram of the colours that are actually in the image, in OKLab.
 * Samples the real pixels (alpha-weighted, so a transparent PNG doesn't pick
 * up its empty background) rather than collapsing to a few dominant tags.
 * Returns a JSON string ready for the color_hist column, or null.
 */
export async function extractHistogram(buffer) {
  try {
    const { data, info } = await sharp(buffer, { animated: false, limitInputPixels: false })
      .rotate()
      .resize(128, 128, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    const rgb = [];
    for (let i = 0; i < n; i++) {
      const a = data[i * 4 + 3];
      if (a < 16) continue; // ignore fully transparent pixels
      rgb.push(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    if (!rgb.length) return null;
    const bins = histogramFromRgb(rgb);
    return bins.length ? encodeHistogram(bins) : null;
  } catch {
    return null;
  }
}

function dist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 + (dr * dr + dg * dg + db * db) * 0.3;
}

function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/**
 * Read a video's display size and duration from an MP4/MOV file's moov box, without decoding it.
 * Returns null for other containers or when the file has no video track.
 */
export function probeMp4(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let pos = 0;
    // moov can come before or after the media data, so walk the top-level boxes
    while (pos + 8 <= size) {
      fs.readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      let hdr = 8;
      if (len === 1) {
        len = Number(head.readBigUInt64BE(8));
        hdr = 16;
      } else if (len === 0) {
        len = size - pos;
      }
      if (len < hdr) return null;
      if (head.toString('latin1', 4, 8) === 'moov') {
        if (len > 64 * 1024 * 1024) return null;
        const moov = Buffer.alloc(len - hdr);
        fs.readSync(fd, moov, 0, moov.length, pos + hdr);
        return parseMoov(moov);
      }
      pos += len;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function* boxes(buf, start = 0, end = buf.length) {
  let pos = start;
  while (pos + 8 <= end) {
    let len = buf.readUInt32BE(pos);
    let hdr = 8;
    if (len === 1) {
      len = Number(buf.readBigUInt64BE(pos + 8));
      hdr = 16;
    } else if (len === 0) {
      len = end - pos;
    }
    if (len < hdr || pos + len > end) return;
    yield { type: buf.toString('latin1', pos + 4, pos + 8), start: pos + hdr, end: pos + len };
    pos += len;
  }
}

function parseMoov(moov) {
  let width = 0;
  let height = 0;
  let duration = null;
  for (const box of boxes(moov)) {
    if (box.type === 'mvhd') {
      const v1 = moov[box.start] === 1;
      const timescale = moov.readUInt32BE(box.start + (v1 ? 20 : 12));
      const length = v1 ? Number(moov.readBigUInt64BE(box.start + 24)) : moov.readUInt32BE(box.start + 16);
      if (timescale && length && length !== 0xffffffff) duration = length / timescale;
    } else if (box.type === 'trak' && !width) {
      for (const tkhd of boxes(moov, box.start, box.end)) {
        if (tkhd.type !== 'tkhd') continue;
        // the transform matrix follows the times, ids, and volume; width and height (16.16 fixed) follow it
        const matrix = tkhd.start + (moov[tkhd.start] === 1 ? 52 : 40);
        const w = Math.round(moov.readUInt32BE(matrix + 36) / 65536);
        const h = Math.round(moov.readUInt32BE(matrix + 40) / 65536);
        if (!w || !h) continue; // audio track
        // a 90° or 270° rotation (phone videos) swaps the displayed width and height
        const rotated = moov.readInt32BE(matrix) === 0 && moov.readInt32BE(matrix + 4) !== 0;
        [width, height] = rotated ? [h, w] : [w, h];
      }
    }
  }
  return width && height ? { width, height, duration } : null;
}

/** Center-crop an image to a width/height ratio, e.g. a page's preview image to its video's shape. */
export async function cropToAspect(buffer, width, height) {
  const meta = await probeImage(buffer);
  if (!meta || Math.abs(meta.width / meta.height - width / height) < 0.02) return buffer;
  const scale = Math.min(meta.width / width, meta.height / height);
  try {
    return await sharp(buffer, { limitInputPixels: false })
      .rotate()
      .resize(Math.round(width * scale), Math.round(height * scale), { fit: 'cover' })
      .toBuffer();
  } catch {
    return buffer;
  }
}
