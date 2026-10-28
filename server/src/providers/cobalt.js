import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { addItem, findByMediaUrl } from '../library.js';
import { cropToAspect, probeImage, probeMp4 } from '../media.js';
import { fetchPageInfo } from '../importers/web.js';
import { downloadBuffer, downloadToFile, extFromMime, fetchJson, fetchWithTimeout, newId, VIDEO_EXTS } from '../util.js';
import { ProviderUnsupported } from './errors.js';

// cobalt (https://github.com/imputnet/cobalt) downloads media from YouTube, TikTok, Instagram, Reddit, and more.

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

// Error codes meaning "cobalt doesn't handle this link"; it's passed on to the web importer instead.
const FALLBACK_ERRORS = new Set([
  'error.api.link.invalid',
  'error.api.link.unsupported',
  'error.api.service.unsupported',
  'error.api.service.disabled',
  'error.api.fetch.empty',
]);

const SITE_NAMES = {
  bilibili: 'Bilibili',
  bluesky: 'Bluesky',
  dailymotion: 'Dailymotion',
  facebook: 'Facebook',
  instagram: 'Instagram',
  loom: 'Loom',
  newgrounds: 'Newgrounds',
  ok: 'OK.ru',
  pinterest: 'Pinterest',
  reddit: 'Reddit',
  rutube: 'Rutube',
  snapchat: 'Snapchat',
  soundcloud: 'SoundCloud',
  streamable: 'Streamable',
  tiktok: 'TikTok',
  tumblr: 'Tumblr',
  'twitch clips': 'Twitch clips',
  vimeo: 'Vimeo',
  vk: 'VK',
  xiaohongshu: 'Xiaohongshu',
  youtube: 'YouTube',
};

const authHeaders = (cfg) => (cfg.apiKey ? { authorization: `Api-Key ${cfg.apiKey}` } : {});

async function instanceInfo(cfg) {
  const j = await fetchJson(cfg.url + '/', { headers: authHeaders(cfg) });
  if (!j?.cobalt) throw new Error("This doesn't look like a cobalt instance");
  return j.cobalt;
}

const siteNames = (services = []) =>
  services
    // X posts go through Abacus's own importer.
    .filter((s) => s !== 'twitter')
    .map((s) => SITE_NAMES[s] || s.replace(/^./, (c) => c.toUpperCase()))
    .sort((a, b) => a.localeCompare(b));

async function postJson(cfg, body) {
  const res = await fetchWithTimeout(
    cfg.url + '/',
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...authHeaders(cfg) },
      body: JSON.stringify(body),
    },
    60000
  );
  const j = await res.json().catch(() => null);
  if (!j?.status) throw new Error(`cobalt: HTTP ${res.status}`);
  return j;
}

async function test(cfg) {
  let info;
  try {
    info = await instanceInfo(cfg);
  } catch (err) {
    const reason = err.cause?.code || err.message.replace(/ for .*/, '');
    return { ok: false, message: `Can't reach cobalt at ${cfg.url} (${reason})` };
  }
  // GET / doesn't check the API key, so make a request that does; any link-level error means we got through.
  const j = await postJson(cfg, { url: 'https://example.com/' });
  const code = j.error?.code || '';
  if (code.startsWith('error.api.auth.')) {
    return { ok: false, message: cfg.apiKey ? 'cobalt rejected the API key' : 'This cobalt instance requires an API key' };
  }
  return { ok: true, message: `Connected to cobalt ${info.version || ''}`.trim(), sites: siteNames(info.services) };
}

async function sites(cfg) {
  return siteNames((await instanceInfo(cfg)).services);
}

/**
 * Tunnel links point at cobalt's own API_URL, which isn't always reachable from here (for example
 * http://localhost:9000/ when cobalt runs in another container), so fetch them through the configured address.
 */
function throughConfiguredUrl(link, cfg) {
  const u = new URL(link);
  if (!u.pathname.endsWith('/tunnel')) return link;
  return new URL('tunnel' + u.search, cfg.url + '/').toString();
}

async function requestMedia(url, cfg) {
  let j;
  try {
    j = await postJson(cfg, {
      url,
      videoQuality: cfg.videoQuality,
      filenameStyle: 'basic',
      // Twitter GIFs stay MP4, like the X importer stores them.
      convertGif: false,
      // Always download through cobalt, which knows the headers each service's CDN wants.
      alwaysProxy: true,
    });
  } catch (err) {
    if (err.message.startsWith('cobalt:')) throw err;
    // cobalt is down or unreachable: don't break link imports because of it.
    console.warn(`cobalt unreachable (${err.cause?.code || err.message}); importing ${url} as a web page`);
    throw new ProviderUnsupported('cobalt unreachable');
  }
  if (j.status === 'error') {
    const code = j.error?.code || 'error.api.generic';
    if (FALLBACK_ERRORS.has(code)) throw new ProviderUnsupported(code);
    throw new Error(`cobalt: ${code.replace(/^error\.api\./, '')}`);
  }
  if (j.status === 'tunnel' || j.status === 'redirect') {
    return [{ url: throughConfiguredUrl(j.url, cfg), filename: j.filename }];
  }
  if (j.status === 'picker') {
    return j.picker.map((p) => ({ url: throughConfiguredUrl(p.url, cfg), kind: p.type, thumb: p.thumb }));
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

async function importLink(url, cfg, { folderIds = [], tags = [] } = {}) {
  const existing = findByMediaUrl(url) || findByMediaUrl(url + '#1');
  if (existing) return [{ status: 'skipped', id: existing.id }];

  // cobalt only returns files, so read the title and preview image from the page itself.
  const [media, page] = await Promise.all([requestMedia(url, cfg), fetchPageInfo(url)]);
  const common = {
    url,
    source: 'social',
    description: page.description,
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
        // Size the item by the video itself: posters often have another shape, or are missing.
        const probe = isVideo ? probeMp4(tmp) : null;
        if (probe && thumbBuffer) thumbBuffer = await cropToAspect(thumbBuffer, probe.width, probe.height);
        item = await addItem({
          ...common,
          name,
          type: isVideo ? (m.kind === 'gif' ? 'gif' : 'video') : undefined,
          tempFile: tmp,
          ext,
          mime: resolvedMime,
          thumbBuffer,
          width: probe?.width,
          height: probe?.height,
          duration: probe?.duration,
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

export default {
  id: 'cobalt',
  name: 'cobalt',
  description: 'Downloads videos, photos, and audio from YouTube, TikTok, Instagram, Reddit, and other sites.',
  docsUrl: 'https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md',
  fields: [
    {
      key: 'url',
      label: 'Instance URL',
      type: 'url',
      required: true,
      placeholder: 'http://192.168.1.10:9000',
      hint: 'Must be reachable from the Abacus server.',
    },
    {
      key: 'apiKey',
      label: 'API key',
      type: 'secret',
      placeholder: 'Optional',
      hint: 'Only needed if the instance requires API key authentication.',
    },
    {
      key: 'videoQuality',
      label: 'Video quality',
      type: 'select',
      default: '1080',
      options: [
        { value: 'max', label: 'Best available' },
        { value: '2160', label: '2160p (4K)' },
        { value: '1440', label: '1440p' },
        { value: '1080', label: '1080p' },
        { value: '720', label: '720p' },
        { value: '480', label: '480p' },
        { value: '360', label: '360p' },
      ],
    },
  ],
  test,
  sites,
  import: importLink,
};
