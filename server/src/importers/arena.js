import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { addItem, createFolder, findByMediaUrl, listFolders } from '../library.js';
import { fetchTweet } from './x.js';
import { paths } from '../config.js';
import { downloadBuffer, VIDEO_EXTS } from '../util.js';

/**
 * Are.na channel export: a zip holding `<channel-slug>-<id>.csv`
 * (ID, Filename, Title, Description, Created At, Updated At, Source)
 * next to the block files it references. Zips with several channels are supported.
 */

/** RFC 4180 CSV parser (quoted fields, embedded commas/newlines, "" escapes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f !== ''));
}

const REQUIRED = ['id', 'filename', 'title'];

/** Open a zip and return its channels, or null if it isn't an Are.na export. */
export function readArenaZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !e.entryName.startsWith('__MACOSX/'));
  const byName = new Map(entries.map((e) => [e.entryName, e]));
  const channels = [];
  for (const e of entries.filter((x) => x.entryName.toLowerCase().endsWith('.csv'))) {
    const rows = parseCsv(e.getData().toString('utf8').replace(/^﻿/, ''));
    if (rows.length < 1) continue;
    const header = rows[0].map((h) => h.trim().toLowerCase());
    if (!REQUIRED.every((h) => header.includes(h))) continue;
    const col = (r, name) => r[header.indexOf(name)]?.trim() || '';
    const dir = path.posix.dirname(e.entryName);
    const slug = path.posix.basename(e.entryName, '.csv');
    channels.push({
      // "interface-nhlps28vt6m" -> "interface"
      name: slug.replace(/-[a-z0-9]{8,14}$/i, '').replace(/[-_]+/g, ' ').trim() || slug,
      blocks: rows.slice(1).map((r) => {
        const filename = col(r, 'filename');
        const entry = filename ? byName.get(dir === '.' ? filename : `${dir}/${filename}`) : null;
        return {
          id: col(r, 'id'),
          filename,
          title: col(r, 'title'),
          description: col(r, 'description'),
          createdAt: Date.parse(col(r, 'created at').replace(' UTC', 'Z').replace(' ', 'T')) || null,
          source: col(r, 'source'),
          entry,
        };
      }),
    });
  }
  return channels.length ? channels : null;
}

/** Find or create a folder by name under `parentId`. */
export function ensureFolder(name, parentId = null) {
  const existing = listFolders().find(
    (f) => (f.parentId || null) === (parentId || null) && f.name.toLowerCase() === name.toLowerCase()
  );
  return existing || createFolder({ name, parentId });
}

const X_TITLE = /^(.*?) on X:? @?([A-Za-z0-9_]{1,30})\b/;
const X_STATUS = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,30})\/status\/(\d+)/;

/** Import one block. Returns [{ status, item | id }]. */
export async function importBlock(block, { folderIds = [] } = {}) {
  const key = `arena:block:${block.id}`;
  const existing = findByMediaUrl(key);
  if (existing) return [{ status: 'skipped', id: existing.id }];

  const xTitle = X_TITLE.exec(block.title);
  const xStatus = X_STATUS.exec(block.source);
  const isX = !!(xTitle || xStatus);
  const firstLine = block.description.split('\n').find((l) => l.trim())?.trim() || '';
  // X blocks are titled "Name on X @handle"; their description (the post text) makes a better name
  let name = isX && firstLine ? firstLine : block.title || firstLine || block.filename || 'Untitled';
  if (name.length > 100) name = name.slice(0, 98).trimEnd() + '…';

  const common = {
    name,
    url: block.source || `https://www.are.na/block/${block.id}`,
    mediaUrl: key,
    source: isX ? 'x' : 'arena',
    text: block.description || null,
    author: xTitle?.[1] || null,
    authorHandle: xTitle?.[2] || xStatus?.[1] || null,
    postedAt: block.createdAt,
    folderIds,
  };

  if (!block.entry) {
    const item = await addItem({ ...common, type: 'bookmark', name: block.title || name });
    return [{ status: 'imported', item }];
  }

  const buffer = block.entry.getData();
  const ext = path.extname(block.filename).slice(1).toLowerCase();
  if (VIDEO_EXTS.has(ext)) {
    // No ffmpeg on the server: borrow the poster frame from the original X post when there is one.
    let thumbBuffer = null;
    let width;
    let height;
    let duration;
    if (xStatus) {
      try {
        const tw = await fetchTweet(xStatus[2]);
        const v = tw.media.find((m) => m.kind !== 'photo');
        if (v?.poster) {
          thumbBuffer = (await downloadBuffer(v.poster)).buffer;
          ({ width, height, duration } = v);
        }
        if (!common.author) common.author = tw.author.name;
        common.authorAvatar = tw.author.avatar;
      } catch {
        /* poster is best-effort */
      }
    }
    const tmp = path.join(paths.files, `.tmp-arena-${block.id}.${ext}`);
    fs.writeFileSync(tmp, buffer);
    try {
      const item = await addItem({
        ...common,
        type: 'video',
        tempFile: tmp,
        ext,
        mime: `video/${ext === 'mov' ? 'quicktime' : ext}`,
        thumbBuffer,
        width,
        height,
        duration,
      });
      return [{ status: 'imported', item }];
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  const item = await addItem({ ...common, buffer, ext });
  return [{ status: 'imported', item }];
}
