import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, paths } from './config.js';
import { bumpRevision, getRevision } from './revision.js';
import { mapLimit } from './util.js';

// How much disk the library takes, by what it's for. Measured on disk rather than from the database, so files left
// behind or written outside it count too.
//
// Walking the files and thumbnails folders is too slow for every stats request, so the last walk is kept and taken
// again in the background once the library has changed since. The database is only three files, so it's always
// read fresh.

/** Size and count of the files under `dir`, grouped by `kind(name)`; files it returns null for are left out. */
async function measure(dir, kind = () => 'all') {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const groups = {};
  await mapLimit(
    entries.filter((e) => e.isFile()),
    32,
    async (e) => {
      const key = kind(e.name);
      if (!key) return;
      const stat = await fs.stat(path.join(e.parentPath, e.name)).catch(() => null);
      if (!stat) return;
      groups[key] ??= { bytes: 0, count: 0 };
      groups[key].bytes += stat.size;
      groups[key].count++;
    }
  );
  return groups;
}

function thumbKind(name) {
  if (name.endsWith('.webp')) return 'webp';
  if (name.endsWith('.jxl')) return name.includes('.preview.') ? 'preview' : 'jxl';
  return null;
}

// SQLite keeps recent writes in the -wal file until a checkpoint
const DB_FILES = ['', '-wal', '-shm'].map((suffix) => paths.db + suffix);

function dbBytes() {
  return DB_FILES.reduce((sum, file) => sum + (fsSync.statSync(file, { throwIfNoEntry: false })?.size || 0), 0);
}

const sum = (parts) => Object.values(parts).reduce((n, p) => n + p.bytes, 0);

/** the last walk of the files and thumbnails, and the library revision it's up to date with */
let walked = null;
let walkedAt = null;
let walking = null;

/** Walk the files and thumbnails and keep the result; clients are told when the total moved. */
function walk() {
  walking ??= (async () => {
    try {
      const start = getRevision();
      const empty = { bytes: 0, count: 0 };
      const [files, thumbs] = await Promise.all([measure(paths.files), measure(paths.thumbs, thumbKind)]);
      const next = {
        files: files.all || empty,
        webp: thumbs.webp || empty,
        jxl: thumbs.jxl || empty,
        preview: thumbs.preview || empty,
      };
      const moved = sum(next) !== (walked ? sum(walked) : 0);
      // anything written while walking may be missing, so then the walk stays out of date and runs again
      const quiet = getRevision() === start;
      walked = next;
      if (moved) bumpRevision();
      walkedAt = quiet ? getRevision() : start;
      return next;
    } finally {
      walking = null;
    }
  })();
  return walking;
}

/** Start keeping the total, so the first stats request has one. */
export function kickStorageWalk() {
  void walk().catch(() => {});
}

/**
 * Everything the library takes on disk, as last measured: the same total the storage page shows, without walking the
 * folders now. Null before the first walk is done. A walk that is out of date is started in the background.
 */
export function storageTotal() {
  if (walkedAt !== getRevision()) kickStorageWalk();
  return walked ? dbBytes() + sum(walked) : null;
}

export async function storageUsage() {
  const [walkedNow, disk] = await Promise.all([walk(), fs.statfs(config.dataDir).catch(() => null)]);
  const parts = { db: { bytes: dbBytes(), count: 1 }, ...walkedNow };
  return {
    total: sum(parts),
    ...parts,
    disk: disk ? { size: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize } : null,
  };
}
