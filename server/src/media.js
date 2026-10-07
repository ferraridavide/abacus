import sharp from 'sharp';

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

function dist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 + (dr * dr + dg * dg + db * db) * 0.3;
}

function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}
