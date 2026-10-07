import type { Item } from '../types';

export function formatBytes(n: number) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(s: number | null | undefined) {
  if (!s && s !== 0) return '';
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
}

export function formatDate(ts: number | null | undefined, withTime = true) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export function itemMeta(item: Item) {
  if (item.type === 'bookmark') {
    if (item.authorHandle) return '@' + item.authorHandle;
    try {
      return item.url ? new URL(item.url).hostname.replace(/^www\./, '') : 'Bookmark';
    } catch {
      return 'Bookmark';
    }
  }
  const parts: string[] = [];
  if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
  if (item.ext) parts.push(item.ext.toUpperCase());
  return parts.join(' · ');
}

export function hostOf(url: string | null) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const TWEET_RE =
  /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/(?:#!\/)?(?:[A-Za-z0-9_]{1,30}|i(?:\/web)?)\/status(?:es)?\/(\d{1,25})/gi;

/** Count X posts and other URLs in pasted text (mirrors the server-side parser). */
export function countLinks(text: string) {
  const tweets = new Set<string>();
  const tweetMatches: string[] = [];
  for (const m of text.matchAll(TWEET_RE)) {
    tweets.add(m[1]);
    tweetMatches.push(m[0].replace(/^https?:\/\//, ''));
  }
  const urls = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const bare = m[0].replace(/^https?:\/\//, '');
    if (!tweetMatches.some((t) => bare.startsWith(t))) urls.add(m[0]);
  }
  return { tweets: tweets.size, urls: urls.size, total: tweets.size + urls.size };
}

export const FOLDER_COLORS = ['#ff6b6b', '#ff9f43', '#feca57', '#1dd1a1', '#48dbfb', '#5b8cff', '#a55eea', '#ff6bcb'];
