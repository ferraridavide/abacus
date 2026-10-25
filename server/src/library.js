import fs from 'node:fs';
import path from 'node:path';
import { db, tx } from './db.js';
import { paths } from './config.js';
import { newId, safeName, VIDEO_EXTS } from './util.js';
import { probeImage, makeThumb, extractPalette, extractHistogram } from './media.js';
import {
  decodeHistogram,
  packHistogram,
  labToBin,
  hexToRgb,
  rgbToOklab,
  colorScore,
  queryBinRange,
  parseColor,
} from './color.js';

const ITEM_COLUMNS = `
  i.*,
  (SELECT json_group_array(tag) FROM (SELECT tag FROM item_tags t WHERE t.item_id = i.id ORDER BY tag)) AS tags_json,
  (SELECT json_group_array(folder_id) FROM item_folders f WHERE f.item_id = i.id) AS folders_json
`;

export function serializeItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ext: row.ext,
    mime: row.mime,
    fileUrl: row.file ? '/files/' + row.file.split('/').map(encodeURIComponent).join('/') : null,
    thumbUrl: row.thumb ? '/thumbs/' + row.thumb + '?v=' + row.updated_at : null,
    width: row.width,
    height: row.height,
    duration: row.duration,
    size: row.size,
    palette: row.palette ? JSON.parse(row.palette) : [],
    url: row.url,
    mediaUrl: row.media_url,
    source: row.source,
    author: row.author,
    authorHandle: row.author_handle,
    authorAvatar: row.author_avatar,
    text: row.text,
    notes: row.notes,
    rating: row.rating,
    postedAt: row.posted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    folders: row.folders_json ? JSON.parse(row.folders_json) : [],
  };
}

export function getItem(id) {
  return serializeItem(db.prepare(`SELECT ${ITEM_COLUMNS} FROM items i WHERE i.id = ?`).get(id));
}

export function findByMediaUrl(mediaUrl) {
  if (!mediaUrl) return null;
  return db
    .prepare('SELECT id FROM items WHERE media_url = ? AND deleted_at IS NULL LIMIT 1')
    .get(mediaUrl);
}

/**
 * Store a new item. Provide either `buffer` (file contents) or `tempFile`
 * (a file already on disk inside the data dir that will be moved).
 * `thumbBuffer` is an optional image used for the thumbnail/palette
 * (e.g. a video poster frame).
 */
export async function addItem(input) {
  const id = newId();
  const now = Date.now();
  let { type, ext, mime, width, height, duration } = input;
  ext = (ext || '').toLowerCase().replace(/^\./, '');

  let probe = null;
  if (input.buffer && type !== 'video' && !VIDEO_EXTS.has(ext)) {
    probe = await probeImage(input.buffer);
  }
  if (!type) {
    if (probe) type = probe.animated ? 'gif' : 'image';
    else if (VIDEO_EXTS.has(ext) || (mime || '').startsWith('video/')) type = 'video';
    else if (input.buffer || input.tempFile) type = 'file';
    else type = 'bookmark';
  }
  if (probe) {
    width = width || probe.width;
    height = height || probe.height;
    if (!ext && probe.format) ext = probe.format === 'jpeg' ? 'jpg' : probe.format;
  }

  const name = safeName(input.name || 'untitled', 120);
  let file = null;
  let size = 0;
  if (input.buffer || input.tempFile) {
    const dir = path.join(paths.files, id);
    fs.mkdirSync(dir, { recursive: true });
    const fileName = safeName(name, 80) + (ext ? '.' + ext : '');
    const dest = path.join(dir, fileName);
    if (input.buffer) {
      fs.writeFileSync(dest, input.buffer);
      size = input.buffer.length;
    } else {
      fs.renameSync(input.tempFile, dest);
      size = fs.statSync(dest).size;
    }
    file = `${id}/${fileName}`;
  }

  let thumb = null;
  let palette = [];
  let colorHist = null;
  const thumbSrc = input.thumbBuffer || (probe ? input.buffer : null);
  if (thumbSrc) {
    try {
      const t = await makeThumb(thumbSrc);
      thumb = `${id}.webp`;
      fs.writeFileSync(path.join(paths.thumbs, thumb), t);
      palette = await extractPalette(thumbSrc);
      // index the actual pixel codes, not the dominant-colour tags
      colorHist = await extractHistogram(thumbSrc);
      if (!width || !height) {
        const p = await probeImage(thumbSrc);
        if (p) {
          width = width || p.width;
          height = height || p.height;
        }
      }
    } catch {
      thumb = null;
    }
  }

  tx(() => {
    db.prepare(
      `INSERT INTO items (id, name, type, ext, mime, file, thumb, width, height, duration, size, palette,
        url, media_url, source, author, author_handle, author_avatar, text, notes, rating, posted_at,
        created_at, updated_at, color_hist)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).run(
      id,
      name,
      type,
      ext || null,
      mime || null,
      file,
      thumb,
      width || null,
      height || null,
      duration || null,
      size,
      JSON.stringify(palette),
      input.url || null,
      input.mediaUrl || null,
      input.source || 'upload',
      input.author || null,
      input.authorHandle || null,
      input.authorAvatar || null,
      input.text || null,
      input.notes || null,
      input.postedAt || null,
      now,
      now,
      colorHist
    );
    saveColors(id, palette);
    saveHistogram(id, colorHist);
    for (const fid of input.folderIds || []) linkFolder(id, fid, now);
    for (const tag of input.tags || []) linkTag(id, tag);
  });
  return getItem(id);
}

const insertFolderLink = db.prepare(
  'INSERT OR IGNORE INTO item_folders (item_id, folder_id, added_at) SELECT ?, id, ? FROM folders WHERE id = ?'
);
const insertTag = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)');

function linkFolder(itemId, folderId, at = Date.now()) {
  if (folderId) insertFolderLink.run(itemId, at, folderId);
}
const insertColor = db.prepare('INSERT INTO item_colors (item_id, r, g, b, ratio) VALUES (?, ?, ?, ?, ?)');
export function saveColors(itemId, palette) {
  for (const p of palette || []) insertColor.run(itemId, ...hexToRgb(p.hex), p.ratio);
}

const insertBin = db.prepare('INSERT INTO item_color_bins (item_id, l, a, b, w) VALUES (?, ?, ?, ?, ?)');
const deleteBins = db.prepare('DELETE FROM item_color_bins WHERE item_id = ?');

/**
 * Decoded histograms, packed for scoring. Parsing the JSON of every candidate
 * is the slowest part of a colour search, so it happens once per item instead
 * of once per keystroke. saveHistogram() drops the entry when an item changes;
 * the cache is capped so a huge library cannot grow without bound.
 */
const histCache = new Map();
const HIST_CACHE_MAX = 20000;

/** Packed histogram for a row: pixels first, stored swatches while a library is still being indexed. */
function packedHistogram(row) {
  let packed = histCache.get(row.id);
  if (!packed) {
    packed = packHistogram(decodeHistogram(row.color_hist));
    if (!packed.length) return paletteAsBins(row.palette);
    if (histCache.size >= HIST_CACHE_MAX) histCache.delete(histCache.keys().next().value);
    histCache.set(row.id, packed);
  }
  return packed;
}

/** Persist an OKLab histogram so colour search can prefilter in SQL. */
export function saveHistogram(itemId, colorHist) {
  histCache.delete(itemId);
  deleteBins.run(itemId);
  for (const bin of decodeHistogram(colorHist)) {
    if (!bin.w) continue;
    insertBin.run(itemId, labToBin(bin.l, 0), labToBin(bin.a, 1), labToBin(bin.b, 2), bin.w);
  }
}

function linkTag(itemId, tag) {
  const t = normalizeTag(tag);
  if (t) insertTag.run(itemId, t);
}

export function normalizeTag(tag) {
  return String(tag || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

// ---------- querying ----------

const SORTS = {
  created: 'i.created_at',
  posted: 'COALESCE(i.posted_at, i.created_at)',
  name: 'i.name COLLATE NOCASE',
  size: 'i.size',
  dimensions: 'COALESCE(i.width, 0) * COALESCE(i.height, 0)',
  rating: 'i.rating',
  updated: 'i.updated_at',
};

/** WHERE + ORDER BY for a library query (shared by the paged list and the id list). */
function buildQuery(params) {
  const where = [];
  const args = [];

  if (params.view === 'trash') where.push('i.deleted_at IS NOT NULL');
  else where.push('i.deleted_at IS NULL');

  if (params.view === 'uncategorized') where.push('NOT EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = i.id)');
  if (params.view === 'untagged') where.push('NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)');
  if (params.view === 'folder' && params.folderId) {
    where.push('EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = i.id AND f.folder_id = ?)');
    args.push(params.folderId);
  }
  if (params.view === 'tag' && params.tag) {
    where.push('EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag = ?)');
    args.push(params.tag);
  }
  if (params.types?.length) {
    where.push(`i.type IN (${params.types.map(() => '?').join(',')})`);
    args.push(...params.types);
  }
  if (params.source) {
    where.push('i.source = ?');
    args.push(params.source);
  }
  if (params.rating) {
    where.push('i.rating >= ?');
    args.push(Number(params.rating));
  }
  if (params.q) {
    for (const raw of String(params.q).split(/\s+/).filter(Boolean)) {
      const token = raw.toLowerCase();
      if (token.startsWith('#') && token.length > 1) {
        where.push('EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag LIKE ?)');
        args.push(token.slice(1) + '%');
        continue;
      }
      const like = `%${token.replace(/[%_]/g, (m) => '\\' + m)}%`;
      where.push(`(
        lower(i.name) LIKE ? ESCAPE '\\' OR lower(COALESCE(i.notes,'')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(i.text,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(i.author,'')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(i.author_handle,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(i.url,'')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(i.ext,'')) = ?
        OR EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND lower(t.tag) LIKE ? ESCAPE '\\')
      )`);
      args.push(like, like, like, like, like, like, token, like);
    }
  }

  let order;
  if (params.sort === 'random') {
    const seed = Number(params.seed) || 1;
    order = `((i.rowid * 2654435761 + ${Math.floor(seed) % 1000003}) % 4294967291)`;
  } else {
    const col = SORTS[params.sort] || SORTS.created;
    const dir = params.dir === 'asc' ? 'ASC' : 'DESC';
    order = `${col} ${dir}, i.created_at DESC`;
  }
  if (params.view === 'trash') order = 'i.deleted_at DESC';

  // Colour search matches the indexed pixel histogram, not the dominant-colour
  // tags. The SQL clause is only a candidate prefilter; ranking happens in
  // listItems so an exact code outranks a merely similar one.
  const color = colorQuery(params.color);
  if (color) {
    const { lo, hi } = color.range;
    where.push(`EXISTS (SELECT 1 FROM item_color_bins cb WHERE cb.item_id = i.id
      AND cb.l BETWEEN ? AND ? AND cb.a BETWEEN ? AND ? AND cb.b BETWEEN ? AND ?)`);
    args.push(lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]);
  }

  return { where: where.join(' AND '), args, order, color };
}

/**
 * Resolve a colour query (#RGB, #RRGGBB, or rgb()) to the OKLab point it is
 * scored against. Returns null when the input isn't a colour.
 */
function colorQuery(input) {
  const hex = parseColor(input);
  if (!hex) return null;
  const lab = rgbToOklab(...hexToRgb(hex));
  return { hex, lab, range: queryBinRange(lab) };
}

/**
 * A candidate counts only when a real share of its pixels is perceptually the
 * query colour — a 2% accent of the exact code qualifies, a faint tint does not.
 */
const COLOR_MIN_SCORE = 0.02;

function rankByColor(rows, color) {
  const ranked = [];
  for (const row of rows) {
    const score = colorScore(packedHistogram(row), color.lab);
    if (score >= COLOR_MIN_SCORE) ranked.push({ row, score });
  }
  ranked.sort((x, y) => y.score - x.score || y.row.created_at - x.row.created_at);
  return ranked;
}

/** Treat dominant-colour swatches as a coarse histogram, so search works before the backfill finishes. */
function paletteAsBins(palette) {
  if (!palette) return packHistogram([]);
  let colors;
  try {
    colors = JSON.parse(palette);
  } catch {
    return packHistogram([]);
  }
  return packHistogram(
    colors
      .map((p) => {
        const rgb = hexToRgb(p.hex);
        if (!rgb) return null;
        const [l, a, b] = rgbToOklab(...rgb);
        return { l, a, b, w: p.ratio };
      })
      .filter(Boolean),
  );
}

export const PAGE_MAX = 1000;

/** One page of items plus the total match count. */
export function listItems(params = {}) {
  const { where, args, order, color } = buildQuery(params);
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(params.limit) || 200));
  const offset = Math.max(0, Number(params.offset) || 0);
  // Colour search ranks every candidate by how much of the image is that
  // colour, then pages the ranked list. Candidates come from the SQL prefilter
  // (items whose histogram has a bin near the code), and only the page's rows
  // are loaded in full — ranking needs the histogram and nothing else.
  if (color) {
    const candidates = db
      .prepare(`SELECT i.id, i.color_hist, i.palette, i.created_at FROM items i WHERE ${where}`)
      .all(...args);
    const ranked = rankByColor(candidates, color);
    const page = ranked.slice(offset, offset + limit);
    const items = [];
    if (page.length) {
      const ids = page.map((r) => r.row.id);
      const rows = db
        .prepare(`SELECT ${ITEM_COLUMNS} FROM items i WHERE i.id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of ids) {
        const row = byId.get(id);
        if (row) items.push(serializeItem(row));
      }
    }
    return { items, total: ranked.length, offset };
  }
  const items = db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM items i WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, limit, offset)
    .map(serializeItem);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM items i WHERE ${where}`).get(...args).n;
  return { items, total, offset };
}

/** Every matching id, in order — for "select all" without loading every item. */
export function listItemIds(params = {}) {
  const { where, args, order, color } = buildQuery(params);
  if (color) {
    const rows = db
      .prepare(`SELECT i.id, i.color_hist, i.palette, i.created_at FROM items i WHERE ${where}`)
      .all(...args);
    return rankByColor(rows, color).map((r) => r.row.id);
  }
  return db
    .prepare(`SELECT i.id FROM items i WHERE ${where} ORDER BY ${order}`)
    .all(...args)
    .map((r) => r.id);
}

export function getStats() {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    all: one('SELECT COUNT(*) n FROM items WHERE deleted_at IS NULL'),
    uncategorized: one(
      'SELECT COUNT(*) n FROM items i WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = i.id)'
    ),
    untagged: one(
      'SELECT COUNT(*) n FROM items i WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)'
    ),
    trash: one('SELECT COUNT(*) n FROM items WHERE deleted_at IS NOT NULL'),
    totalSize: db.prepare('SELECT COALESCE(SUM(size),0) n FROM items WHERE deleted_at IS NULL').get().n,
  };
}

export function listTags() {
  return db
    .prepare(
      `SELECT t.tag AS name, COUNT(*) AS count FROM item_tags t JOIN items i ON i.id = t.item_id
       WHERE i.deleted_at IS NULL GROUP BY t.tag COLLATE NOCASE ORDER BY count DESC, name COLLATE NOCASE`
    )
    .all()
    .map((r) => ({ ...r }));
}

// ---------- updates ----------

export function updateItem(id, patch) {
  const fields = { name: 'name', notes: 'notes', rating: 'rating', url: 'url' };
  const sets = [];
  const args = [];
  for (const [k, col] of Object.entries(fields)) {
    if (patch[k] !== undefined) {
      let v = patch[k];
      if (k === 'name') v = safeName(v, 120);
      if (k === 'rating') v = Math.max(0, Math.min(5, Number(v) || 0));
      sets.push(`${col} = ?`);
      args.push(v);
    }
  }
  tx(() => {
    if (sets.length) {
      db.prepare(`UPDATE items SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, Date.now(), id);
    }
    if (Array.isArray(patch.tags)) {
      db.prepare('DELETE FROM item_tags WHERE item_id = ?').run(id);
      for (const tag of patch.tags) linkTag(id, tag);
    }
    if (Array.isArray(patch.folders)) {
      db.prepare('DELETE FROM item_folders WHERE item_id = ?').run(id);
      for (const fid of patch.folders) linkFolder(id, fid, Date.now());
    }
  });
  return getItem(id);
}

export function batch({ ids = [], action, tags = [], folderId, fromFolderId }) {
  const now = Date.now();
  const removedFiles = [];
  tx(() => {
    for (const id of ids) {
      switch (action) {
        case 'trash':
          db.prepare('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
          break;
        case 'restore':
          db.prepare('UPDATE items SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
          break;
        case 'delete': {
          const row = db.prepare('SELECT file, thumb FROM items WHERE id = ?').get(id);
          if (row) removedFiles.push({ id, ...row });
          db.prepare('DELETE FROM items WHERE id = ?').run(id);
          break;
        }
        case 'addTags':
          for (const t of tags) linkTag(id, t);
          break;
        case 'removeTags':
          for (const t of tags) db.prepare('DELETE FROM item_tags WHERE item_id = ? AND tag = ?').run(id, t);
          break;
        case 'addToFolder':
          linkFolder(id, folderId, now);
          break;
        case 'moveToFolder':
          if (fromFolderId) {
            db.prepare('DELETE FROM item_folders WHERE item_id = ? AND folder_id = ?').run(id, fromFolderId);
          } else {
            db.prepare('DELETE FROM item_folders WHERE item_id = ?').run(id);
          }
          linkFolder(id, folderId, now);
          break;
        case 'removeFromFolder':
          db.prepare('DELETE FROM item_folders WHERE item_id = ? AND folder_id = ?').run(id, folderId);
          break;
        default:
          throw Object.assign(new Error('Unknown action ' + action), { statusCode: 400 });
      }
      if (action !== 'delete' && action !== 'trash' && action !== 'restore') {
        db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(now, id);
      }
    }
  });
  for (const r of removedFiles) removeItemFiles(r);
  return { ok: true, count: ids.length };
}

export function emptyTrash() {
  const ids = db
    .prepare('SELECT id FROM items WHERE deleted_at IS NOT NULL')
    .all()
    .map((r) => r.id);
  return batch({ ids, action: 'delete' });
}

function removeItemFiles({ id, thumb }) {
  fs.rmSync(path.join(paths.files, id), { recursive: true, force: true });
  if (thumb) fs.rmSync(path.join(paths.thumbs, thumb), { force: true });
}

// ---------- folders ----------

export function listFolders() {
  return db
    .prepare(
      `SELECT fo.id, fo.name, fo.parent_id AS parentId, fo.color, fo.sort, fo.created_at AS createdAt,
        (SELECT COUNT(*) FROM item_folders f JOIN items i ON i.id = f.item_id
          WHERE f.folder_id = fo.id AND i.deleted_at IS NULL) AS count,
        (SELECT i.thumb FROM item_folders f JOIN items i ON i.id = f.item_id
          WHERE f.folder_id = fo.id AND i.deleted_at IS NULL AND i.thumb IS NOT NULL
          ORDER BY f.added_at DESC LIMIT 1) AS cover
       FROM folders fo ORDER BY fo.sort, fo.name COLLATE NOCASE`
    )
    .all()
    .map((r) => ({ ...r, cover: r.cover ? '/thumbs/' + r.cover : null }));
}

export function createFolder({ name, parentId = null, color = null }) {
  const id = newId();
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM folders').get().s;
  db.prepare('INSERT INTO folders (id, name, parent_id, color, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    safeName(name || 'New Folder', 80),
    parentId || null,
    color,
    sort,
    Date.now()
  );
  return listFolders().find((f) => f.id === id);
}

export function updateFolder(id, patch) {
  if (patch.parentId !== undefined && patch.parentId !== null) {
    // prevent cycles: walk up from the new parent
    let cur = patch.parentId;
    while (cur) {
      if (cur === id) throw Object.assign(new Error('Cannot move a folder into itself'), { statusCode: 400 });
      cur = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cur)?.parent_id;
    }
  }
  const sets = [];
  const args = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    args.push(safeName(patch.name, 80));
  }
  if (patch.color !== undefined) {
    sets.push('color = ?');
    args.push(patch.color);
  }
  if (patch.parentId !== undefined) {
    sets.push('parent_id = ?');
    args.push(patch.parentId || null);
  }
  if (patch.sort !== undefined) {
    sets.push('sort = ?');
    args.push(Number(patch.sort));
  }
  if (sets.length) db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return listFolders().find((f) => f.id === id);
}

export function deleteFolder(id) {
  db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  return { ok: true };
}

/**
 * Libraries created before colour search only stored a few dominant swatches.
 * Rebuild the pixel histogram from each thumbnail in the background so search
 * matches the colours that are actually in the image. Runs once per item;
 * `color_hist = ''` marks an item whose thumbnail couldn't be read.
 */
export function backfillColorHistograms() {
  const pending = db
    .prepare("SELECT id, thumb FROM items WHERE color_hist IS NULL AND thumb IS NOT NULL")
    .all();
  if (!pending.length) return;
  setTimeout(() => runColorBackfill(pending), 400);
}

async function runColorBackfill(pending) {
  let done = 0;
  for (const row of pending) {
    let hist = '';
    try {
      const file = path.join(paths.thumbs, row.thumb);
      if (fs.existsSync(file)) hist = (await extractHistogram(fs.readFileSync(file))) || '';
    } catch {
      hist = '';
    }
    tx(() => {
      db.prepare('UPDATE items SET color_hist = ? WHERE id = ? AND color_hist IS NULL').run(hist, row.id);
      if (hist) saveHistogram(row.id, hist);
    });
    done++;
    if (done % 25 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}
