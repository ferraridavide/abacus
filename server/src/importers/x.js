import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { addItem, findByMediaUrl } from '../library.js';
import { decodeEntities, downloadBuffer, downloadToFile, extFromMime, fetchJson, newId } from '../util.js';

const HOSTS = '(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx|twittpr|nitter)\\.(?:com|net|poast\\.org)';
const TWEET_RE = new RegExp(
  `(?:https?:\\/\\/)?(?:www\\.|mobile\\.|m\\.)?${HOSTS}\\/(?:#!\\/)?(?:[A-Za-z0-9_]{1,30}|i(?:\\/web)?)\\/status(?:es)?\\/(\\d{1,25})`,
  'gi'
);

/** Find every tweet referenced in a blob of text. */
export function extractTweets(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TWEET_RE)) out.push({ id: m[1], match: m[0] });
  return out;
}

function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** pbs.twimg.com/media/ABC.jpg -> pbs.twimg.com/media/ABC?format=jpg&name=orig */
function origPhoto(u) {
  const m = /^(https:\/\/pbs\.twimg\.com\/media\/[^.?]+)\.(jpe?g|png|webp)/i.exec(u || '');
  return m ? `${m[1]}?format=${m[2].toLowerCase()}&name=orig` : u;
}

function bestMp4(variants = []) {
  return variants
    .filter((v) => (v.content_type || v.type) === 'video/mp4')
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
}

function normalizeSyndication(j) {
  let text = j.text || '';
  for (const u of j.entities?.urls || []) text = text.split(u.url).join(u.expanded_url);
  for (const m of j.entities?.media || []) text = text.split(m.url).join('');
  const mediaDetails = j.mediaDetails?.length ? j.mediaDetails : j.quoted_tweet?.mediaDetails || [];
  const media = mediaDetails
    .map((m) => {
      const width = m.original_info?.width;
      const height = m.original_info?.height;
      if (m.type === 'photo') return { kind: 'photo', url: origPhoto(m.media_url_https), fallback: m.media_url_https, width, height };
      const v = bestMp4(m.video_info?.variants);
      if (!v) return null;
      return {
        kind: m.type === 'animated_gif' ? 'gif' : 'video',
        url: v.url || v.src,
        poster: m.media_url_https,
        width,
        height,
        duration: m.video_info?.duration_millis ? m.video_info.duration_millis / 1000 : null,
      };
    })
    .filter(Boolean);
  const handle = j.user?.screen_name;
  return {
    id: j.id_str,
    url: `https://x.com/${handle || 'i'}/status/${j.id_str}`,
    text: decodeEntities(text).trim(),
    postedAt: j.created_at ? Date.parse(j.created_at) : null,
    author: {
      name: j.user?.name,
      handle,
      avatar: j.user?.profile_image_url_https?.replace('_normal.', '_bigger.'),
    },
    media,
  };
}

function normalizeFx(t) {
  const all = t.media?.all?.length ? t.media.all : t.quote?.media?.all || [];
  const media = all
    .map((m) => {
      if (m.type === 'photo') return { kind: 'photo', url: origPhoto(m.url), fallback: m.url, width: m.width, height: m.height };
      if (!m.url) return null;
      return {
        kind: m.type === 'gif' ? 'gif' : 'video',
        url: m.url,
        poster: m.thumbnail_url,
        width: m.width,
        height: m.height,
        duration: m.duration || null,
      };
    })
    .filter(Boolean);
  return {
    id: t.id,
    url: t.url || `https://x.com/${t.author?.screen_name}/status/${t.id}`,
    text: decodeEntities(t.text || '').trim(),
    postedAt: t.created_timestamp ? t.created_timestamp * 1000 : null,
    author: { name: t.author?.name, handle: t.author?.screen_name, avatar: t.author?.avatar_url },
    media,
  };
}

/** Fetch & normalise a tweet. Tries X's public embed (syndication) API first, then fxtwitter. */
export async function fetchTweet(id) {
  const errors = [];
  try {
    const j = await fetchJson(
      `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`
    );
    if (j?.id_str && j.__typename !== 'TweetTombstone') {
      const tw = normalizeSyndication(j);
      if (tw.media.length || tw.text) return tw;
    }
    errors.push('syndication: unavailable');
  } catch (e) {
    errors.push('syndication: ' + e.message);
  }
  try {
    const j = await fetchJson(`https://api.fxtwitter.com/status/${id}`);
    if (j?.tweet) return normalizeFx(j.tweet);
    errors.push('fxtwitter: ' + (j?.message || 'no data'));
  } catch (e) {
    errors.push('fxtwitter: ' + e.message);
  }
  throw new Error(`Could not fetch tweet ${id} (${errors.join('; ')})`);
}

function tweetTitle(tw) {
  const clean = tw.text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean) return clean.length > 90 ? clean.slice(0, 88).trimEnd() + '…' : clean;
  return `@${tw.author.handle || 'x'} · ${tw.id}`;
}

/**
 * Import every media item of a tweet. Text-only tweets become bookmark cards.
 * Returns [{ status: 'imported'|'skipped', item }].
 */
export async function importTweet(id, { folderIds = [], tags = [] } = {}) {
  const tw = await fetchTweet(id);
  const title = tweetTitle(tw);
  const common = {
    url: tw.url,
    source: 'x',
    author: tw.author.name,
    authorHandle: tw.author.handle,
    authorAvatar: tw.author.avatar,
    text: tw.text,
    postedAt: tw.postedAt,
    folderIds,
    tags,
  };

  if (!tw.media.length) {
    const existing = findByMediaUrl(tw.url);
    if (existing) return [{ status: 'skipped', id: existing.id }];
    const item = await addItem({ ...common, type: 'bookmark', name: title, mediaUrl: tw.url });
    return [{ status: 'imported', item }];
  }

  const results = [];
  for (const [i, m] of tw.media.entries()) {
    const existing = findByMediaUrl(m.url);
    if (existing) {
      results.push({ status: 'skipped', id: existing.id });
      continue;
    }
    const name = tw.media.length > 1 ? `${title} (${i + 1})` : title;

    if (m.kind === 'photo') {
      let dl;
      try {
        dl = await downloadBuffer(m.url);
      } catch {
        dl = await downloadBuffer(m.fallback);
      }
      const ext = extFromMime(dl.contentType) || 'jpg';
      const item = await addItem({
        ...common,
        name,
        buffer: dl.buffer,
        ext,
        mime: dl.contentType,
        mediaUrl: m.url,
      });
      results.push({ status: 'imported', item });
    } else {
      const tmp = path.join(paths.files, `.tmp-${newId()}.mp4`);
      await downloadToFile(m.url, tmp);
      let poster = null;
      if (m.poster) {
        try {
          poster = (await downloadBuffer(origPhoto(m.poster))).buffer;
        } catch {
          try {
            poster = (await downloadBuffer(m.poster)).buffer;
          } catch {}
        }
      }
      try {
        const item = await addItem({
          ...common,
          name,
          type: m.kind === 'gif' ? 'gif' : 'video',
          tempFile: tmp,
          ext: 'mp4',
          mime: 'video/mp4',
          thumbBuffer: poster,
          width: m.width,
          height: m.height,
          duration: m.duration,
          mediaUrl: m.url,
        });
        results.push({ status: 'imported', item });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
  }
  return results;
}
