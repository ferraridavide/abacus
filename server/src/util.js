import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

/** Time-sortable, URL-safe id. */
export function newId() {
  return Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

export function safeName(name, max = 80) {
  const cleaned = String(name || '')
    .normalize('NFKC')
    .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || 'untitled';
}

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const res = await fetch(url, {
    redirect: 'follow',
    ...opts,
    headers: { 'user-agent': UA, accept: '*/*', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

export async function fetchJson(url, opts) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Download a URL fully into memory (for images / posters). */
export async function downloadBuffer(url, maxBytes = 100 * 1024 * 1024) {
  const res = await fetchWithTimeout(url, {}, 60000);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error('File too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('File too large');
  return { buffer: buf, contentType: res.headers.get('content-type') || '' };
}

/** Stream a URL to disk (for videos). Returns bytes written. */
export async function downloadToFile(url, dest) {
  const res = await fetchWithTimeout(url, {}, 10 * 60 * 1000);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${url}`);
  let written = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      if (written > config.maxDownloadBytes) cb(new Error('File too large'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(dest));
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  return { size: written, contentType: res.headers.get('content-type') || '' };
}

/** Run async fn over items with limited concurrency. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const extFromMime = (mime = '') => {
  const m = mime.split(';')[0].trim().toLowerCase();
  return (
    {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/avif': 'avif',
      'image/svg+xml': 'svg',
      'image/heic': 'heic',
      'image/tiff': 'tiff',
      'image/bmp': 'bmp',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
    }[m] || ''
  );
};

export const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv']);
