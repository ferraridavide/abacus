import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { addItem, findByMediaUrl } from '../library.js';
import { probeImage } from '../media.js';
import { decodeEntities, downloadBuffer, downloadToFile, extFromMime, fetchWithTimeout, newId, VIDEO_EXTS } from '../util.js';

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

export function extractUrls(text) {
  return [...String(text || '').matchAll(URL_RE)].map((m) => m[0].replace(/[),.;!?\]]+$/, ''));
}

function nameFromUrl(u) {
  try {
    const p = new URL(u);
    const base = decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || p.hostname);
    return base.replace(/\.[a-z0-9]{2,5}$/i, '') || p.hostname;
  } catch {
    return 'download';
  }
}

function extFromUrl(u) {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(u).pathname);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

function parseMeta(html) {
  const meta = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) || []) {
    const attrs = {};
    for (const a of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[a[1].toLowerCase()] = a[3] ?? a[4];
    }
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = decodeEntities(attrs.content);
  }
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  if (title) meta.__title = decodeEntities(title).trim();
  return meta;
}

/** Import an arbitrary URL: a direct image/video, or a web page (saves its og:image). */
export async function importUrl(url, { folderIds = [], tags = [] } = {}) {
  const existing = findByMediaUrl(url);
  if (existing) return [{ status: 'skipped', id: existing.id }];

  const res = await fetchWithTimeout(url, { headers: { accept: 'text/html,image/*,video/*,*/*' } }, 30000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const ext = extFromMime(contentType) || extFromUrl(url);

  if (contentType.startsWith('image/')) {
    const buffer = Buffer.from(await res.arrayBuffer());
    const item = await addItem({
      name: nameFromUrl(url),
      buffer,
      ext,
      mime: contentType,
      url,
      mediaUrl: url,
      source: 'web',
      folderIds,
      tags,
    });
    return [{ status: 'imported', item }];
  }

  if (contentType.startsWith('video/') || VIDEO_EXTS.has(ext)) {
    res.body?.cancel();
    const tmp = path.join(paths.files, `.tmp-${newId()}`);
    try {
      await downloadToFile(url, tmp);
      const item = await addItem({
        name: nameFromUrl(url),
        type: 'video',
        tempFile: tmp,
        ext: ext || 'mp4',
        mime: contentType || 'video/mp4',
        url,
        mediaUrl: url,
        source: 'web',
        folderIds,
        tags,
      });
      return [{ status: 'imported', item }];
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // Web page: read up to ~2 MB of HTML and pull OpenGraph metadata.
  const html = (await res.text()).slice(0, 2_000_000);
  const meta = parseMeta(html);
  const title = meta['og:title'] || meta['twitter:title'] || meta.__title || nameFromUrl(url);
  const description = meta['og:description'] || meta['twitter:description'] || meta.description || '';
  const imageRaw = meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'];
  const common = {
    name: title,
    url,
    mediaUrl: url,
    source: 'web',
    text: description,
    author: meta['og:site_name'] || new URL(url).hostname.replace(/^www\./, ''),
    folderIds,
    tags,
  };

  if (imageRaw) {
    try {
      const imageUrl = new URL(imageRaw, url).toString();
      const dl = await downloadBuffer(imageUrl);
      if (await probeImage(dl.buffer)) {
        const item = await addItem({
          ...common,
          buffer: dl.buffer,
          ext: extFromMime(dl.contentType) || extFromUrl(imageUrl),
          mime: dl.contentType,
        });
        return [{ status: 'imported', item }];
      }
    } catch {
      /* fall through to a plain bookmark */
    }
  }
  const item = await addItem({ ...common, type: 'bookmark' });
  return [{ status: 'imported', item }];
}
