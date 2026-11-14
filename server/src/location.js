import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Where the library lives. DATA_DIR is the home folder; a data-location.json there can point the library at any
// other folder (a synced folder, a network share), chosen in Settings → Storage. Without it the library is in
// DATA_DIR itself. Shared by the supervisor (index.js), which switches folders, and the app, which runs in one.

const here = path.dirname(fileURLToPath(import.meta.url));

export const HOME_DIR = path.resolve(process.env.DATA_DIR || path.join(here, '../../data'));
const POINTER = path.join(HOME_DIR, 'data-location.json');

/** The supervisor waits and tries again on this code: a network share or a synced drive may come back. */
export const DATA_UNAVAILABLE = 'ABACUS_DATA_UNAVAILABLE';

export const dataPaths = (dir) => ({
  db: path.join(dir, 'library.db'),
  files: path.join(dir, 'files'),
  thumbs: path.join(dir, 'thumbs'),
});

export function samePath(a, b) {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The folder the library is in: the one data-location.json names, else DATA_DIR. */
export function chosenDataDir() {
  let raw;
  try {
    raw = fs.readFileSync(POINTER, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return HOME_DIR;
    throw err;
  }
  const dir = JSON.parse(raw).dataDir;
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error(`${POINTER} does not name an absolute folder`);
  return dir;
}

function pointTo(dir) {
  if (samePath(dir, HOME_DIR)) {
    fs.rmSync(POINTER, { force: true });
    return;
  }
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(POINTER + '.part', JSON.stringify({ dataDir: path.resolve(dir) }, null, 2) + '\n');
  fs.renameSync(POINTER + '.part', POINTER);
}

/**
 * Copy every file under each `from` that its `to` lacks or holds an older or different-sized version of. With
 * `mirror`, files `to` has that `from` doesn't are deleted. Files an import is still writing (.tmp-*) are skipped.
 * `progress.total` and `progress.done` count the files as they're compared.
 */
export async function syncTrees(pairs, { mirror = false, progress = { total: 0, done: 0 } } = {}) {
  const jobs = [];
  for (const [from, to] of pairs) {
    const entries = await fs.promises.readdir(from, { recursive: true, withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const rels = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.tmp-'))
      .map((e) => path.relative(from, path.join(e.parentPath, e.name)));
    jobs.push({ from, to, rels });
    progress.total += rels.length;
  }
  for (const { from, to, rels } of jobs) {
    const queue = [...rels];
    const copyNext = async () => {
      while (queue.length) {
        const rel = queue.pop();
        const src = path.join(from, rel);
        const dest = path.join(to, rel);
        const [a, b] = await Promise.all([fs.promises.stat(src).catch(() => null), fs.promises.stat(dest).catch(() => null)]);
        // gone since the listing: the item was deleted meanwhile
        if (a && (!b || b.size !== a.size || b.mtimeMs < a.mtimeMs)) {
          await fs.promises.mkdir(path.dirname(dest), { recursive: true });
          await fs.promises.copyFile(src, dest);
        }
        progress.done++;
      }
    };
    await Promise.all(Array.from({ length: 8 }, copyNext));
    if (mirror) {
      const keep = new Set(rels.map((r) => (process.platform === 'win32' ? r.toLowerCase() : r)));
      const there = await fs.promises.readdir(to, { recursive: true, withFileTypes: true }).catch(() => []);
      for (const e of there.filter((x) => x.isFile())) {
        const rel = path.relative(to, path.join(e.parentPath, e.name));
        if (!keep.has(process.platform === 'win32' ? rel.toLowerCase() : rel)) await fs.promises.rm(path.join(to, rel), { force: true });
      }
    }
  }
  return progress;
}

/** A consistent copy of the database, checked before it takes the place of library.db in `toDir`. */
function copyDatabase(fromDir, toDir) {
  const dest = dataPaths(toDir).db;
  const part = dest + '.part';
  fs.rmSync(part, { force: true });
  const src = new DatabaseSync(dataPaths(fromDir).db);
  try {
    src.exec('PRAGMA busy_timeout = 5000; PRAGMA locking_mode = EXCLUSIVE;');
    src.prepare('VACUUM INTO ?').run(part);
  } finally {
    src.close();
  }
  const copy = new DatabaseSync(part);
  try {
    const { quick_check: check } = copy.prepare('PRAGMA quick_check').get();
    if (check !== 'ok') throw new Error(`The copied database failed its check: ${check}`);
  } finally {
    copy.close();
  }
  // a log left by the library this replaces would be replayed into the new one
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dest + suffix, { force: true });
  fs.renameSync(part, dest);
}

/**
 * Point the library at `target`, once the app has stopped. 'copy' first brings over what changed since the app's own
 * copy pass and then the database; 'open' takes the library already there. The current folder is left as it is.
 */
export async function finishMove(target, mode) {
  const from = chosenDataDir();
  if (mode === 'copy') {
    const [a, b] = [dataPaths(from), dataPaths(target)];
    await syncTrees([[a.files, b.files], [a.thumbs, b.thumbs]], { mirror: true });
    copyDatabase(from, target);
  }
  if (!fs.existsSync(dataPaths(target).db)) throw new Error(`There is no Abacus library in ${target}`);
  pointTo(target);
}
