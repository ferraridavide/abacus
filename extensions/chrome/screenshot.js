/**
 * Screenshots: the tab is captured with chrome.tabs.captureVisibleTab and, for anything bigger than the viewport,
 * stitched from scrolled strips. Everything here runs in the service worker; the page side is capture.js.
 *
 * planTiles / fitScale are plain geometry (tested in Node). stitchRegion needs OffscreenCanvas, so it only runs
 * inside the browser.
 */

// captureVisibleTab allows two calls a second; stay a little under it.
const CAPTURE_GAP_MS = 600;
// Browsers refuse canvases past these limits, so very tall pages are scaled down instead of failing.
const MAX_SIDE = 16000;
const MAX_PIXELS = 120_000_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
export const EXTENSION = { png: 'png', jpeg: 'jpg', webp: 'webp' };

/** Clamp a region (page CSS pixels) to the page. Returns null when nothing of it is left. */
export function clampRegion(region, { scrollWidth, scrollHeight }) {
  const x = Math.max(0, Math.floor(region.x));
  const y = Math.max(0, Math.floor(region.y));
  const w = Math.min(Math.ceil(region.w + (region.x - x)), scrollWidth - x);
  const h = Math.min(Math.ceil(region.h + (region.y - y)), scrollHeight - y);
  return w >= 1 && h >= 1 ? { x, y, w, h } : null;
}

/** Whether the viewport, at its current scroll, already shows the whole region. */
export function fitsViewport(region, { scrollX, scrollY, innerWidth, innerHeight }) {
  return region.x >= scrollX && region.y >= scrollY && region.x + region.w <= scrollX + innerWidth && region.y + region.h <= scrollY + innerHeight;
}

/** Scroll positions that together cover the region, row by row. The last one in each axis is clamped to the page. */
export function planTiles(region, { innerWidth, innerHeight, scrollWidth, scrollHeight }) {
  const axis = (start, length, view, max) => {
    const positions = [];
    const limit = Math.max(0, max - view);
    for (let at = start; at < start + length; at += view) {
      const clamped = Math.min(at, limit);
      if (positions[positions.length - 1] !== clamped) positions.push(clamped);
    }
    return positions;
  };
  const xs = axis(region.x, region.w, innerWidth, scrollWidth);
  const ys = axis(region.y, region.h, innerHeight, scrollHeight);
  return ys.flatMap((y) => xs.map((x) => ({ x, y })));
}

/** Pixels per CSS pixel for the final image: the screen's own ratio, reduced when the page is too large. */
export function fitScale(width, height, devicePixelRatio) {
  let scale = devicePixelRatio;
  scale = Math.min(scale, MAX_SIDE / width, MAX_SIDE / height);
  scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.max(0.05, scale);
}

let lastCapture = 0;

async function captureBitmap(windowId) {
  const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return await createImageBitmap(await (await fetch(dataUrl)).blob());
  } finally {
    lastCapture = Date.now();
  }
}

/**
 * Capture `region` (page CSS pixels) of a tab and return it as a Blob.
 * `page` talks to capture.js in the tab: page('info'), page('scrollTo', x, y), page('prepare'), page('hideFixed'),
 * page('restore', x, y). Always restores the page, even when a capture fails.
 */
export async function stitchRegion({ windowId, page, region, format = 'png', onStrip }) {
  const info = await page('info');
  const area = clampRegion(region, info);
  if (!area) throw new Error('There is nothing to capture there.');
  const single = fitsViewport(area, info);
  const tiles = single ? [{ x: info.scrollX, y: info.scrollY }] : planTiles(area, info);
  let canvas;
  let context;
  let scale = 1;
  try {
    await page('prepare');
    // Let the picker overlay and the scrollbars disappear from the screen before the first capture.
    await sleep(120);
    for (let i = 0; i < tiles.length; i++) {
      onStrip?.(i, tiles.length);
      const at = single ? { x: info.scrollX, y: info.scrollY } : await page('scrollTo', tiles[i].x, tiles[i].y);
      // After the first strip, fixed headers and sticky bars would repeat down the page: hide them.
      if (!single && i === 1) await page('hideFixed');
      if (!single) await sleep(250);
      const bitmap = await captureBitmap(windowId);
      try {
        if (!canvas) {
          const dpr = bitmap.width / info.innerWidth;
          scale = fitScale(area.w, area.h, dpr);
          canvas = new OffscreenCanvas(Math.max(1, Math.round(area.w * scale)), Math.max(1, Math.round(area.h * scale)));
          context = canvas.getContext('2d');
          if (format === 'jpeg') {
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
          }
        }
        const dpr = bitmap.width / info.innerWidth;
        const left = Math.max(area.x, at.x);
        const top = Math.max(area.y, at.y);
        const right = Math.min(area.x + area.w, at.x + info.innerWidth);
        const bottom = Math.min(area.y + area.h, at.y + info.innerHeight);
        if (right <= left || bottom <= top) continue;
        context.drawImage(
          bitmap,
          (left - at.x) * dpr, (top - at.y) * dpr, (right - left) * dpr, (bottom - top) * dpr,
          (left - area.x) * scale, (top - area.y) * scale, (right - left) * scale, (bottom - top) * scale
        );
      } finally {
        bitmap.close();
      }
    }
  } finally {
    await page('restore', info.scrollX, info.scrollY).catch(() => {});
  }
  return canvas.convertToBlob({ type: MIME[format] || MIME.png, quality: 0.92 });
}
