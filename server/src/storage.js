import fs from 'node:fs/promises';
import path from 'node:path';
import { config, paths } from './config.js';
import { mapLimit } from './util.js';

// How much disk the library takes, by what it's for. Measured on disk rather than from the database, so files left
// behind or written outside it count too.

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

export async function storageUsage() {
  const empty = { bytes: 0, count: 0 };
  const [dbFiles, files, thumbs, disk] = await Promise.all([
    // SQLite keeps recent writes in the -wal file until a checkpoint
    Promise.all(['', '-wal', '-shm'].map((suffix) => fs.stat(paths.db + suffix).catch(() => null))),
    measure(paths.files),
    measure(paths.thumbs, thumbKind),
    fs.statfs(config.dataDir).catch(() => null),
  ]);
  const parts = {
    db: { bytes: dbFiles.reduce((sum, s) => sum + (s?.size || 0), 0), count: 1 },
    files: files.all || empty,
    webp: thumbs.webp || empty,
    jxl: thumbs.jxl || empty,
    preview: thumbs.preview || empty,
  };
  return {
    total: Object.values(parts).reduce((sum, p) => sum + p.bytes, 0),
    ...parts,
    disk: disk ? { size: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize } : null,
  };
}
