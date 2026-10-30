import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { paths } from './config.js';
import { newId, safeName, VIDEO_EXTS } from './util.js';
import { addItem, createFolder, getItem, listFolders, normalizeTag, updateItem } from './library.js';
import { parseTargets, startArenaImport, startTargets } from './jobs.js';
import { readArenaZip } from './importers/arena.js';

/**
 * The single "add content" path behind POST /api/add, used by the web app, the bookmarklet, the Chrome extension,
 * and any other client. It accepts links (imported through the X / import provider / web pipeline),
 * plain text (stored as a note card), and files (multipart), including Are.na exports.
 */

const SOURCES = new Set(['api', 'web', 'upload', 'x', 'social', 'arena']);

const str = (v) => (typeof v === 'string' ? v.trim() : '');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

const firstLine = (text) =>
  String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) || '';

export function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function requireHttpUrl(value) {
  if (!isHttpUrl(value)) throw httpError(400, `Only http:// and https:// links can be added (got "${value.slice(0, 80)}")`);
  return value;
}

/** Accept an array, a JSON array string, or a comma-separated string. */
export function parseTags(tags) {
  let list = [];
  if (Array.isArray(tags)) {
    list = tags;
  } else if (typeof tags === 'string') {
    const value = tags.trim();
    if (!value) return [];
    if (value.startsWith('[')) {
      try {
        const parsed = JSON.parse(value);
        list = Array.isArray(parsed) ? parsed : [value];
      } catch {
        list = value.split(',');
      }
    } else {
      list = value.split(',');
    }
  }
  return [...new Set(list.map(normalizeTag).filter(Boolean))];
}

/**
 * Turn `folderId` or `folder` into a folder id.
 *
 * `folder` is a path from the top level, such as "Inbox" or "Design / Logos" (folder names can't contain "/");
 * missing folders along it are created, under `parentId` when given. A `folderId` that no longer exists (say, in a
 * bookmarklet made before the folder was deleted) doesn't fail the save: it falls back to `folder`, or to no
 * folder, and adds a warning.
 */
export function resolveFolder({ folderId, folder, parentId } = {}, warnings = []) {
  const folders = listFolders();
  const segments = str(folder)
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  if (folderId) {
    if (folders.some((f) => f.id === folderId)) return folderId;
    if (!segments.length) {
      warnings.push('The folder no longer exists, so this was saved without one');
      return null;
    }
  }
  if (!segments.length) return null;

  let parent = null;
  if (parentId) {
    if (!folders.some((f) => f.id === parentId)) throw httpError(400, 'Parent folder not found');
    parent = parentId;
  }
  for (const segment of segments) {
    const name = safeName(segment, 80);
    const match = listFolders().find(
      (f) => (f.parentId || null) === parent && f.name.toLowerCase() === name.toLowerCase()
    );
    parent = match ? match.id : createFolder({ name, parentId: parent }).id;
  }
  return parent;
}

/** Give newly imported items the name and notes the client sent. Items that were already there are left alone. */
function applyDetails(createdIds, { name, notes, single }) {
  createdIds.forEach((id, i) => {
    const patch = {};
    if (notes) patch.notes = notes;
    if (name && single) patch.name = createdIds.length > 1 ? `${name} (${i + 1})` : name;
    if (Object.keys(patch).length) updateItem(id, patch);
  });
}

/**
 * Add links and/or a note. Returns `{ job, items, warnings }`. With `async`, it returns as soon as the job starts;
 * clients poll GET /api/jobs/:id, and the name and notes are still applied when the job finishes.
 */
export async function addContent(input = {}) {
  const warnings = [];
  const tags = parseTags(input.tags);
  const text = str(input.text);
  const notes = str(input.notes);
  const name = str(input.name);
  const url = str(input.url);
  const urls = (Array.isArray(input.urls) ? input.urls : input.urls ? [input.urls] : []).map(str).filter(Boolean);
  for (const u of [url, ...urls].filter(Boolean)) requireHttpUrl(u);

  const targets = parseTargets([url, ...urls, text].filter(Boolean).join('\n'));

  if (targets.length) {
    const folderId = resolveFolder(input, warnings);
    const run = startTargets(targets, {
      folderIds: folderId ? [folderId] : [],
      tags,
      // `name` titles a single link; for several links each item keeps the title read from its page.
      onDone: (job, createdIds) => applyDetails(createdIds, { name, notes, single: targets.length === 1 }),
    });
    if (input.async) return { job: run.job, items: [], warnings };
    await run.done;
    if (notes && run.job.skipped) warnings.push('Already in your library, so its notes were not changed');
    // /api/add also accepts add-only tokens: skipped items must not disclose existing private metadata.
    const ids = [...new Set(run.createdIds)];
    return { job: run.job, items: ids.map(getItem).filter(Boolean), warnings };
  }

  // The web app's link import, and the bookmarklet, only ever handle links.
  if (input.linksOnly) return { job: null, items: [], warnings };

  const title = name || firstLine(text) || firstLine(notes);
  if (!title) throw httpError(400, 'Nothing to add: send url, urls, text, name, or notes');

  const folderId = resolveFolder(input, warnings);
  const item = await addItem({
    type: 'bookmark',
    name: title,
    notes: notes || null,
    text: text || null,
    source: SOURCES.has(input.source) ? input.source : 'api',
    folderIds: folderId ? [folderId] : [],
    tags,
  });
  return { job: null, items: [item], warnings };
}

/** Read a multipart request: one file (plus an optional `thumb` poster) and form fields, saved to a temp file. */
async function readUpload(req) {
  const upload = { fields: {}, tmp: null, original: null, mime: null, thumbBuffer: null };
  try {
    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        upload.fields[part.fieldname] = part.value;
      } else if (part.fieldname === 'thumb') {
        upload.thumbBuffer = await part.toBuffer();
      } else {
        if (upload.tmp) throw httpError(400, 'One file per request');
        upload.tmp = path.join(paths.files, `.tmp-${newId()}`);
        upload.original = part.filename;
        upload.mime = part.mimetype;
        await pipeline(part.file, fs.createWriteStream(upload.tmp));
        if (part.file.truncated) throw httpError(413, 'File too large');
      }
    }
    if (!upload.tmp) throw httpError(400, 'No file');
    return upload;
  } catch (err) {
    if (upload.tmp) fs.rmSync(upload.tmp, { force: true });
    throw err;
  }
}

function readArena(tmp) {
  try {
    return readArenaZip(tmp);
  } catch {
    return null;
  }
}

/**
 * Store a multipart upload. Returns `{ item }`, or `{ job }` for an Are.na export, whose channels become folders
 * (inside the given folder, if any).
 *
 * The `arena` field: "auto" (default) imports .zip files that are Are.na exports and stores any other file as is;
 * "only" answers 422 when the zip isn't an Are.na export; "off" always stores the file.
 */
export async function addUpload(req, { arena } = {}) {
  const upload = await readUpload(req);
  const { fields, tmp, original, mime, thumbBuffer } = upload;
  const warnings = [];
  let keepTmp = false;
  try {
    const ext = (path.extname(original || '').slice(1) || '').toLowerCase();
    const requested = arena || fields.arena;
    const arenaMode = ['only', 'off'].includes(requested) ? requested : 'auto';
    const folderId = resolveFolder({ folderId: fields.folderId, folder: fields.folder }, warnings);

    if (arenaMode !== 'off' && (ext === 'zip' || arenaMode === 'only')) {
      const channels = readArena(tmp);
      if (channels) {
        // blocks are read lazily from the zip, so keep it until the job finishes
        keepTmp = true;
        const job = startArenaImport(channels, {
          parentId: folderId,
          tags: parseTags(fields.tags),
          notes: str(fields.notes) || null,
          onDone: () => fs.rmSync(tmp, { force: true }),
        });
        return { job, warnings };
      }
      if (arenaMode === 'only') throw httpError(422, 'Not an Are.na export');
    }

    const url = str(fields.url);
    if (url) requireHttpUrl(url);
    const base = path.basename(original || 'upload', path.extname(original || ''));
    const isVideo = VIDEO_EXTS.has(ext) || (mime || '').startsWith('video/');
    const common = {
      name: str(fields.name) || base,
      ext,
      mime,
      url: url || null,
      mediaUrl: url || null,
      source: SOURCES.has(fields.source) ? fields.source : 'upload',
      folderIds: folderId ? [folderId] : [],
      tags: parseTags(fields.tags),
      thumbBuffer,
      width: Number(fields.width) || undefined,
      height: Number(fields.height) || undefined,
      duration: Number(fields.duration) || undefined,
      notes: str(fields.notes) || null,
    };
    const item = isVideo
      ? await addItem({ ...common, type: 'video', tempFile: tmp })
      : await addItem({ ...common, buffer: fs.readFileSync(tmp) });
    return { item, warnings };
  } finally {
    if (!keepTmp) fs.rmSync(tmp, { force: true });
  }
}
