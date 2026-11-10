import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { config, paths } from './config.js';
import { dataPaths, isInside, samePath, syncTrees } from './location.js';

// Settings → Storage → Library folder: browse the server's disks for a folder, then copy the library there or open
// the one already in it. The files are copied here, while the library stays in use; the supervisor (index.js) then
// stops this app, copies what changed meanwhile and the database, and starts it again in the new folder.

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/** A path as it's pasted: Explorer's "Copy as path" quotes it, a browser gives a file:// URL. */
function cleanPath(input) {
  let s = String(input).trim();
  if (/^(["']).*\1$/.test(s)) s = s.slice(1, -1).trim();
  if (/^file:\/\//i.test(s)) {
    const url = new URL(s);
    s = decodeURIComponent(url.pathname);
    if (url.host) s = `//${url.host}${s}`;
    else if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  }
  return s;
}

/** The move in progress: { path, mode, state: 'copying' | 'switching' | 'failed', total, done, error }. */
let move = null;

export function dataLocation() {
  return {
    path: config.dataDir,
    home: config.homeDir,
    isHome: samePath(config.dataDir, config.homeDir),
    // set by the supervisor when the last move couldn't be finished, and the library stayed where it was
    lastError: workerData?.moveError ?? null,
    move: move && { ...move },
  };
}

async function drives() {
  if (process.platform !== 'win32') return ['/'];
  const letters = [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`);
  const found = await Promise.all(letters.map((d) => fs.promises.access(d).then(() => d, () => null)));
  return found.filter(Boolean);
}

const hasLibrary = (dir) => fs.existsSync(dataPaths(dir).db);

/** The folders in `input` (by default the library's own), for the folder picker. */
export async function browseFolders(input) {
  const dir = input ? path.resolve(cleanPath(input)) : config.dataDir;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw fail(`Can't open ${dir}: ${err.code === 'ENOENT' ? 'there is no such folder' : err.message}`);
  }
  const folders = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && (await fs.promises.stat(full).catch(() => null))?.isDirectory());
    if (isDir) folders.push({ name: e.name, path: full, library: hasLibrary(full) });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: samePath(parent, dir) ? null : parent,
    library: hasLibrary(dir),
    folders,
    places: [
      { label: 'Library', path: config.dataDir },
      { label: 'Home', path: os.homedir() },
      ...(samePath(config.dataDir, config.homeDir) ? [] : [{ label: 'Default', path: config.homeDir }]),
      ...(await drives()).map((d) => ({ label: d, path: d })),
    ],
  };
}

async function writable(dir) {
  const probe = path.join(dir, `.abacus-write-test-${process.pid}`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.rm(probe);
  } catch (err) {
    throw fail(`Can't write to ${dir}: ${err.message}`);
  }
}

/**
 * Start moving the library to `input`. 'copy' copies this library there (an existing one is only replaced with
 * `replace`), 'open' switches to the library already there. Either way the current folder is left as it is.
 */
export async function startMove({ path: input, mode, replace = false } = {}) {
  if (!parentPort) throw fail('The server was started without src/index.js, so it cannot switch folders', 409);
  if (move && move.state !== 'failed') throw fail('The library is already moving', 409);
  if (mode !== 'copy' && mode !== 'open') throw fail('mode must be copy or open');
  const cleaned = typeof input === 'string' ? cleanPath(input) : '';
  if (!path.isAbsolute(cleaned)) throw fail('Give the full path of a folder');

  const dir = path.resolve(cleaned);
  if (samePath(dir, config.dataDir)) throw fail('The library is already in that folder');
  if (isInside(dir, config.dataDir)) throw fail("The new folder can't be inside the library's current folder");
  const stat = await fs.promises.stat(dir).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw fail(`Can't open ${dir}: ${err.message}`);
  });
  if (stat && !stat.isDirectory()) throw fail(`${dir} is a file, not a folder`);
  const library = !!stat && hasLibrary(dir);
  if (mode === 'open' && !library) throw fail(`There is no Abacus library in ${dir}`);
  if (mode === 'copy' && library && !replace) throw fail(`${dir} already holds a library. Open it, or replace it`, 409);
  await writable(dir);

  move = { path: dir, mode, state: 'copying', total: 0, done: 0, error: null };
  const current = move;
  const switchOver = () => {
    current.state = 'switching';
    parentPort.postMessage({ type: 'move', path: dir, mode });
  };
  if (mode === 'open') {
    switchOver();
  } else {
    const to = dataPaths(dir);
    syncTrees([[paths.files, to.files], [paths.thumbs, to.thumbs]], { progress: current }).then(switchOver, (err) => {
      current.state = 'failed';
      current.error = err.message;
    });
  }
  return dataLocation();
}
