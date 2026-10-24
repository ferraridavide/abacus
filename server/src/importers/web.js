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

/** Title, description, site name, and preview image of a web page. */
function pageInfo(html, url) {
  const meta = parseMeta(html);
  const imageRaw = meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'];
  let image = null;
  try {
    if (imageRaw) image = new URL(imageRaw, url).toString();
  } catch {}
  return {
    title: meta['og:title'] || meta['twitter:title'] || meta.__title || nameFromUrl(url),
    description: meta['og:description'] || meta['twitter:description'] || meta.description || '',
    siteName: meta['og:site_name'] || new URL(url).hostname.replace(/^www\./, ''),
    image,
  };
}

/** Fetch a page and read its metadata. Best effort: falls back to names derived from the URL. */
export async function fetchPageInfo(url) {
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: 'text/html' } }, 15000);
    const html = res.ok && (res.headers.get('content-type') || '').includes('html') ? await res.text() : '';
    return pageInfo(html.slice(0, 2_000_000), url);
  } catch {
    return pageInfo('', url);
  }
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
  const page = pageInfo((await res.text()).slice(0, 2_000_000), url);
  const common = {
    name: page.title,
    url,
    mediaUrl: url,
    source: 'web',
    text: page.description,
    author: page.siteName,
    folderIds,
    tags,
  };

  if (page.image) {
    try {
      const dl = await downloadBuffer(page.image);
      if (await probeImage(dl.buffer)) {
        const item = await addItem({
          ...common,
          buffer: dl.buffer,
          ext: extFromMime(dl.contentType) || extFromUrl(page.image),
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
