import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { addItem, findByMediaUrl } from '../library.js';
import { probeImage } from '../media.js';
import { fetchPageInfo } from './web.js';
import { downloadBuffer, downloadToFile, extFromMime, fetchJson, fetchWithTimeout, newId, VIDEO_EXTS } from '../util.js';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic']);
const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
};

// Error codes meaning "cobalt doesn't handle this link"; the caller imports it as a plain web page instead.
const FALLBACK_ERRORS = new Set([
  'error.api.link.invalid',
  'error.api.link.unsupported',
  'error.api.service.unsupported',
  'error.api.service.disabled',
  'error.api.fetch.empty',
]);

export class CobaltUnsupported extends Error {}

export const cobaltEnabled = () => !!config.cobaltUrl;

const authHeaders = () => (config.cobaltApiKey ? { authorization: `Api-Key ${config.cobaltApiKey}` } : {});

let infoCache = null;

/** Instance info (version, supported services), cached for a few minutes. */
export async function cobaltInfo() {
  if (!cobaltEnabled()) return { enabled: false, services: [] };
  if (infoCache && Date.now() - infoCache.at < 5 * 60 * 1000) return infoCache.info;
  let info;
  try {
    const j = await fetchJson(config.cobaltUrl + '/', { headers: authHeaders() });
    info = { enabled: true, online: true, version: j.cobalt?.version, services: j.cobalt?.services || [] };
  } catch {
    info = { enabled: true, online: false, services: [] };
  }
  infoCache = { at: Date.now(), info };
  return info;
}

async function requestMedia(url) {
  let res;
  try {
    res = await fetchWithTimeout(
      config.cobaltUrl + '/',
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          url,
          videoQuality: config.cobaltVideoQuality,
          filenameStyle: 'basic',
          // Twitter GIFs stay MP4, like the X importer stores them.
          convertGif: false,
          // Always download through cobalt, which knows the headers each service's CDN wants.
          alwaysProxy: true,
        }),
      },
      60000
    );
  } catch (err) {
    // cobalt is down or unreachable: don't break link imports because of it.
    console.warn(`cobalt unreachable (${err.cause?.code || err.message}); importing ${url} as a web page`);
    throw new CobaltUnsupported('cobalt unreachable');
  }
  const j = await res.json().catch(() => null);
  if (!j?.status) throw new Error(`cobalt: HTTP ${res.status}`);
  if (j.status === 'error') {
    const code = j.error?.code || 'error.api.generic';
    if (FALLBACK_ERRORS.has(code)) throw new CobaltUnsupported(code);
    throw new Error(`cobalt: ${code.replace(/^error\.api\./, '')}`);
  }
  if (j.status === 'tunnel' || j.status === 'redirect') {
    return [{ url: j.url, filename: j.filename }];
  }
  if (j.status === 'picker') {
    return j.picker.map((p) => ({ url: p.url, kind: p.type, thumb: p.thumb }));
  }
  // local-processing needs the client to merge streams itself; we only take ready-made files.
  throw new Error(`cobalt: unsupported response "${j.status}"`);
}

const extOf = (name = '') => (/\.([a-z0-9]{2,5})$/i.exec(name)?.[1] || '').toLowerCase();

async function tryBuffer(url) {
  if (!url) return null;
  try {
    return (await downloadBuffer(url)).buffer;
  } catch {
    return null;
  }
}

/**
 * Import a link from a service cobalt supports (YouTube, TikTok, Instagram, Reddit, ...).
 * Throws CobaltUnsupported when cobalt can't handle the link, so the caller can fall back.
 */
export async function importWithCobalt(url, { folderIds = [], tags = [] } = {}) {
  const existing = findByMediaUrl(url) || findByMediaUrl(url + '#1');
  if (existing) return [{ status: 'skipped', id: existing.id }];

  // cobalt only returns files, so read the title and preview image from the page itself.
  const [media, page] = await Promise.all([requestMedia(url), fetchPageInfo(url)]);
  const common = {
    url,
    source: 'social',
    text: page.description,
    author: page.siteName,
    folderIds,
    tags,
  };
  let pagePoster;

  const results = [];
  for (const [i, m] of media.entries()) {
    const mediaUrl = media.length > 1 ? `${url}#${i + 1}` : url;
    const found = media.length > 1 && findByMediaUrl(mediaUrl);
    if (found) {
      results.push({ status: 'skipped', id: found.id });
      continue;
    }
    const name = media.length > 1 ? `${page.title} (${i + 1})` : page.title;

    const tmp = path.join(paths.files, `.tmp-${newId()}`);
    try {
      const dl = await downloadToFile(m.url, tmp).catch((err) => {
        // Tunnel URLs are long and signed; keep them out of the job log.
        throw new Error(`cobalt: download failed (${err.message.replace(/ downloading .*/, '')})`);
      });
      const served = dl.contentType.split(';')[0].trim().toLowerCase();
      const mime = served && served !== 'application/octet-stream' ? served : null;
      let ext = extOf(m.filename) || extFromMime(mime || '');
      if (ext === 'jpeg') ext = 'jpg';

      let item;
      if (m.kind === 'photo' || IMAGE_EXTS.has(ext) || mime?.startsWith('image/')) {
        const buffer = fs.readFileSync(tmp);
        if (!ext) {
          const format = (await probeImage(buffer))?.format;
          ext = format === 'jpeg' ? 'jpg' : format || 'jpg';
        }
        item = await addItem({ ...common, name, buffer, ext, mime: mime || MIME_BY_EXT[ext] || null, mediaUrl });
      } else {
        ext ||= 'mp4';
        const resolvedMime = mime || MIME_BY_EXT[ext] || null;
        // Videos and audio need a poster: the picker's thumbnail, or else the page's preview image.
        let thumbBuffer = await tryBuffer(m.thumb);
        if (!thumbBuffer) {
          if (pagePoster === undefined) pagePoster = await tryBuffer(page.image);
          thumbBuffer = pagePoster;
        }
        const isVideo = VIDEO_EXTS.has(ext) || resolvedMime?.startsWith('video/');
        item = await addItem({
          ...common,
          name,
          type: isVideo ? (m.kind === 'gif' ? 'gif' : 'video') : undefined,
          tempFile: tmp,
          ext,
          mime: resolvedMime,
          thumbBuffer,
          mediaUrl,
        });
      }
      results.push({ status: 'imported', item });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return results;
}
