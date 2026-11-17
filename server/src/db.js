import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, paths } from './config.js';
import { DATA_UNAVAILABLE, samePath } from './location.js';
import { probeMp4 } from './media.js';
import { bumpRevision } from './revision.js';

// The database is only open while there is work for it, and closed after a short idle time (DB_IDLE_CLOSE_MS).
// A sync tool such as Syncthing brings another machine's changes by replacing library.db, and on Windows a file
// that is open can't be replaced. Each time the file is opened again it is compared with the one that was closed:
// a different one is a library from outside, and the server is brought up to date with it (see open()).
//
// The rest of the server uses `db` as if it were the connection: db.prepare(), db.exec() and tx().

const outsideHome = !samePath(config.dataDir, config.homeDir);
const SQLITE_BUSY = 5;
const SQLITE_CORRUPT = 11;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;
// Syncthing removes the old file before it moves the new one into place, so for a moment there is none
const OPEN_TRIES = 5;
const OPEN_RETRY_MS = 50;
const LOOK_EVERY_MS = 250;
const CONFLICT_COPY = /^library\.sync-conflict-.*\.db$/;
// in the home folder, which no sync tool looks at
const SET_ASIDE_DIR = path.join(config.homeDir, 'set-aside');
const SET_ASIDE_KEPT = 5;

const unavailable = (message) => Object.assign(new Error(message), { code: DATA_UNAVAILABLE, statusCode: 503 });
const damaged = (detail) =>
  unavailable(
    `The library in ${config.dataDir} is damaged (${String(detail).replace(/\s+/g, ' ').trim()}); it is left as it is until a good copy arrives`
  );
// node:sqlite is synchronous, and so is everything that uses it: waiting for the file has to block too
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Where SQLite opens library.db. Opening a plain path creates the file when it is missing, which it is for a moment
 * while a sync tool replaces it; the schema would then turn that into a valid, empty library for the sync tool to
 * hand to every machine. As a URI with mode=rw, opening never creates it. Node reads URIs since 22.15 and 23.10;
 * before that open() cleans up after itself instead.
 */
function libraryLocation() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major === 22 ? minor < 15 : major === 23 && minor < 10) return paths.db;
  const file = path.resolve(paths.db).replaceAll(path.sep, '/');
  const escaped = file.replace(/[%?#]/g, (c) => '%' + c.charCodeAt(0).toString(16));
  // a network share (//server/share/…) needs an empty authority in front, or its server name is taken for one
  return `file:${escaped.startsWith('//') ? '//' : ''}${escaped}?mode=rw`;
}

const location = libraryLocation();
const openCreatesMissing = location === paths.db;
const conn = new DatabaseSync(location, { open: false });
/** Counts the times the database was opened: a statement prepared in an earlier one is dead. */
let opens = 0;
/** The inode of the file the connection is on. */
let openedIno;
/** The file as it was when it was last closed: undefined before the first open, null when that isn't known. */
let lastClosed;
let lookedAt = 0;
let idleTimer = null;
const forgetters = [];
const warnedAbout = new Set();

export const db = {
  /** A statement that outlives the connection it was prepared on: it prepares itself again after a reopen. */
  prepare(sql) {
    let prepared = connection().prepare(sql);
    let preparedIn = opens;
    const current = (use) => {
      const live = connection(use);
      if (preparedIn !== opens) {
        prepared = live.prepare(sql);
        preparedIn = opens;
      }
      return prepared;
    };
    return {
      get: (...args) => current().get(...args),
      all: (...args) => current().all(...args),
      iterate: (...args) => current().iterate(...args),
      run(...args) {
        const result = current({ writing: true }).run(...args);
        keepFileWhole();
        return result;
      },
    };
  },
  exec(sql) {
    connection({ writing: true }).exec(sql);
    keepFileWhole();
  },
  close() {
    if (conn.isOpen) release();
  },
};

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Register a function that drops what a module keeps in memory from the database, for when the file is replaced. */
export function onLibraryReplaced(forget) {
  forgetters.push(forget);
}

/**
 * Bring the server up to date if the library was replaced while nobody used it. For the revision poll, which
 * doesn't touch the database: an open tab learns of another machine's changes without any other request.
 */
export function noticeReplacedLibrary() {
  if (conn.isOpen) {
    if (conn.isTransaction || !replacedWhileOpen({ writing: true })) return;
    release();
  }
  const file = fileState();
  if (file && !sameFile(file, lastClosed)) connection();
}

/** The open connection, on the file that is in the library folder now. */
function connection({ writing = false } = {}) {
  // never inside a transaction: the statements after BEGIN would run on a connection that has none
  if (conn.isOpen && !conn.isTransaction && replacedWhileOpen({ writing })) release();
  if (!conn.isOpen) open();
  if (config.dbIdleCloseMs) {
    idleTimer ??= setTimeout(closeWhenIdle, config.dbIdleCloseMs).unref();
    idleTimer.refresh();
  }
  return conn;
}

function closeWhenIdle() {
  if (!conn.isOpen) return;
  // closing would roll the transaction back without an error
  if (conn.isTransaction) idleTimer.refresh();
  else release();
}

function release() {
  conn.close();
  // Looked at after closing, as closing a library in the home folder folds its log into the file: the server's own
  // writes must not look like a change from outside. A file that isn't the one that was open is not known at all.
  const file = fileState();
  lastClosed = file?.ino === openedIno ? file : null;
}

/**
 * On Linux and macOS a file can be replaced while it is open, and the connection would go on with one that is no
 * longer in the folder. Every write looks first; reads look now and then, so a library on a network share doesn't
 * pay a round trip per query.
 */
function replacedWhileOpen({ writing }) {
  const now = performance.now();
  if (!writing && now - lookedAt < LOOK_EVERY_MS) return false;
  lookedAt = now;
  return fileState()?.ino !== openedIno;
}

function open() {
  const firstOpen = lastClosed === undefined;
  // Only a first start in the home folder makes a new library. Anywhere else, and at any later time, a library
  // that isn't there is one that hasn't arrived.
  const mayBeNew = firstOpen && !outsideHome;
  if (mayBeNew) fs.closeSync(fs.openSync(paths.db, 'a'));
  const file = connect({ mayBeNew });
  try {
    opens++;
    openedIno = file?.ino;
    lookedAt = performance.now();
    // in doubt it counts as replaced: that costs clients a refetch, where a missed one leaves stale caches
    const replaced = !firstOpen && !sameFile(file, lastClosed);
    if (firstOpen || replaced) {
      if (outsideHome) refuseDamaged();
      // the file may come from a machine on older code
      migrate();
      keepFileWhole();
      warnAboutConflictCopies();
    }
    if (replaced) {
      for (const forget of forgetters) forget();
      bumpRevision();
    }
  } catch (err) {
    // closed without remembering it, so the next use starts over from here
    if (conn.isOpen) conn.close();
    throw err;
  }
}

/** Open the file, which has to hold a library already unless it `mayBeNew`. Returns how it looked just before. */
function connect({ mayBeNew }) {
  for (let attempt = 1; ; attempt++) {
    const file = fileState();
    if ((mayBeNew || file?.size > 0n) && holdsLibrary({ mayBeNew })) return file;
    if (attempt === OPEN_TRIES) {
      throw unavailable(`There is no library in ${config.dataDir} right now; is the drive connected, or is it still syncing?`);
    }
    sleep(OPEN_RETRY_MS);
  }
}

function holdsLibrary({ mayBeNew }) {
  try {
    if (outsideHome) setAsideLog();
    conn.open();
    conn.exec('PRAGMA busy_timeout = 5000');
    // A library outside DATA_DIR may be on a network share or in a synced folder. WAL's shared-memory index doesn't
    // work across machines, and two servers on one library would corrupt it, so there the database is held
    // exclusively: no -shm file, and a second server is told the library is locked instead of sharing it.
    if (outsideHome) conn.exec('PRAGMA locking_mode = EXCLUSIVE');
    // asked before anything that writes: setting the journal mode would already turn an empty file into a database
    if (!mayBeNew && !conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'").get()) {
      conn.close();
      // It wasn't empty when it was looked at: it vanished since, and opening it by path made an empty one.
      if (openCreatesMissing && fileState()?.size === 0n) fs.rmSync(paths.db, { force: true });
      return false;
    }
    conn.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    return true;
  } catch (err) {
    // a failed open still leaves the connection open
    if (conn.isOpen) conn.close();
    if (err.errcode === SQLITE_CANTOPEN || err.errcode === SQLITE_NOTADB) return false;
    if (outsideHome && err.errcode === SQLITE_BUSY) {
      throw unavailable(`The library in ${config.dataDir} is in use by another Abacus server`);
    }
    if (outsideHome && err.errcode === SQLITE_CORRUPT) throw damaged(err.message);
    throw err;
  }
}

/**
 * Move a log that is beside the library out of SQLite's sight, before the library is opened. Outside the home folder
 * this server leaves nothing in the log: every write is folded into library.db at once, and closing removes the file.
 * A log that is there anyway was left by a server that was killed or by an older version, on this machine or on one
 * a sync tool brought it from, and it belongs to the library.db of that moment. SQLite can't tell: it replays any log
 * it finds. On 17 November 2026 a week-old log, replayed into the library a sync tool had just delivered, left every
 * machine with a database that couldn't be read. The log is kept in the home folder, in case its changes are wanted.
 */
function setAsideLog() {
  const log = paths.db + '-wal';
  let kept;
  try {
    if (!fs.statSync(log, { throwIfNoEntry: false })?.size) return;
    fs.mkdirSync(SET_ASIDE_DIR, { recursive: true });
    kept = path.join(SET_ASIDE_DIR, `library.db-wal.${new Date().toISOString().replaceAll(':', '-')}`);
    moveFile(log, kept);
  } catch (err) {
    // opening the library with the log still there would replay it
    throw unavailable(`Can't move ${log} out of the way: ${err.message}`);
  }
  console.warn(
    `abacus: ${log} was left by a server that didn't close the library, here or on another machine. It may belong to an older library.db, so it was not applied; it is kept as ${kept}`
  );
  try {
    const older = fs.readdirSync(SET_ASIDE_DIR).filter((name) => name.startsWith('library.db-wal.')).sort();
    for (const name of older.slice(0, -SET_ASIDE_KEPT)) fs.rmSync(path.join(SET_ASIDE_DIR, name), { force: true });
  } catch {
    /* the older ones can go next time */
  }
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // the home folder can be on another drive than the library
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from);
  }
}

/**
 * A sync tool can deliver a library that isn't whole: copied while another machine was writing it, or already
 * damaged there. Anything written to it would become the newest version on every machine, so such a library isn't
 * used at all. The next open looks again: by then a good copy may have arrived.
 */
function refuseDamaged() {
  let check;
  try {
    check = conn.prepare('PRAGMA quick_check(1)').get().quick_check;
  } catch (err) {
    check = err.message;
  }
  if (check !== 'ok') throw damaged(check);
}

/**
 * Outside the home folder, fold every write into library.db at once and empty the log. SQLite replays whatever log
 * it finds beside a database, also another database's: a server killed with writes in the log, followed by a sync
 * tool replacing library.db, would start with those old pages in place of the new library. This way a kill leaves
 * nothing to replay, and library.db alone is always the whole library.
 */
function keepFileWhole() {
  if (outsideHome && !conn.isTransaction) conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/** Two machines changed the library before they synced: Syncthing kept one database and renamed the other. */
function warnAboutConflictCopies() {
  let names;
  try {
    names = fs.readdirSync(config.dataDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!CONFLICT_COPY.test(name) || warnedAbout.has(name)) continue;
    warnedAbout.add(name);
    console.warn(
      `abacus: ${path.join(config.dataDir, name)} is a conflict copy of the library; changes made on another machine may be in it`
    );
  }
}

/** What tells one library.db from another: a replaced file has a new inode, also when its size is the same. */
function fileState() {
  try {
    const stat = fs.statSync(paths.db, { bigint: true });
    return { ino: stat.ino, size: stat.size, mtime: stat.mtimeNs };
  } catch {
    return null;
  }
}

const sameFile = (a, b) => !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime;

/**
 * The schema, and its migrations from older versions. Runs on every library the server meets: at start, and when
 * the file was replaced from outside. It writes nothing to a database that is up to date.
 */
function migrate() {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
      color      TEXT,
      sort       REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL,          -- image | gif | video | bookmark | file
      ext           TEXT,
      mime          TEXT,
      file          TEXT,                   -- path relative to files dir
      thumb         TEXT,                   -- path relative to thumbs dir
      width         INTEGER,
      height        INTEGER,
      duration      REAL,
      size          INTEGER NOT NULL DEFAULT 0,
      palette       TEXT,                   -- JSON [{hex, ratio}]
      url           TEXT,                   -- source page (tweet, web page)
      media_url     TEXT,                   -- original media URL, used for de-duplication
      source        TEXT NOT NULL DEFAULT 'upload', -- upload | x | web | arena | social
      author        TEXT,
      author_handle TEXT,
      author_avatar TEXT,
      text          TEXT,                   -- post text
      description   TEXT,                   -- linked page's meta description
      notes         TEXT,
      rating        INTEGER NOT NULL DEFAULT 0,
      posted_at     INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      deleted_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
    CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_items_media_url ON items(media_url);

    CREATE TABLE IF NOT EXISTS item_folders (
      item_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      added_at  INTEGER NOT NULL,
      PRIMARY KEY (item_id, folder_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_folders_folder ON item_folders(folder_id);

    CREATE TABLE IF NOT EXISTS item_tags (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      tag     TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (item_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag);
  `);

  conn.exec(`
    CREATE TABLE IF NOT EXISTS item_colors (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      r INTEGER NOT NULL, g INTEGER NOT NULL, b INTEGER NOT NULL,
      ratio REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_item_colors_item ON item_colors(item_id);
    CREATE INDEX IF NOT EXISTS idx_items_list ON items(deleted_at, created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL                   -- JSON
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );

  `);

  const EMBEDDINGS_TABLE = `
    CREATE TABLE IF NOT EXISTS item_embeddings (
      item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,             -- image | text
      model      TEXT NOT NULL,             -- rows from another model count as missing
      vector     BLOB,                      -- unit-length Float32 values; NULL when embedding failed
      error      TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, kind)
    );
  `;
  conn.exec(EMBEDDINGS_TABLE);

  // Colour search: a real histogram (OKLab bins of the actual pixels), not just
  // the handful of dominant swatches. Searched via item_color_bins. Idempotent,
  // so it isn't tied to user_version; existing items are indexed in the
  // background by backfillColorHistograms().
  try {
    conn.exec('ALTER TABLE items ADD COLUMN color_hist TEXT');
  } catch {
    /* column already exists */
  }
  conn.exec(`
    CREATE TABLE IF NOT EXISTS item_color_bins (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      l INTEGER NOT NULL,
      a INTEGER NOT NULL,
      b INTEGER NOT NULL,
      w REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_color_bins_lab ON item_color_bins(l, a, b);
    CREATE INDEX IF NOT EXISTS idx_color_bins_item ON item_color_bins(item_id);
  `);

  // v1 -> v2: backfill item_colors from the palette JSON column
  if (conn.prepare('PRAGMA user_version').get().user_version < 2) {
    const ins = conn.prepare('INSERT INTO item_colors (item_id, r, g, b, ratio) VALUES (?, ?, ?, ?, ?)');
    conn.exec('BEGIN');
    conn.exec('DELETE FROM item_colors');
    for (const row of conn.prepare("SELECT id, palette FROM items WHERE palette IS NOT NULL AND palette != '[]'").all()) {
      for (const p of JSON.parse(row.palette)) {
        const h = p.hex.replace('#', '');
        ins.run(row.id, parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), p.ratio);
      }
    }
    conn.exec('PRAGMA user_version = 2');
    conn.exec('COMMIT');
  }

  // v2 -> v3: size videos by their files; cobalt imports used the poster's size, or none
  if (conn.prepare('PRAGMA user_version').get().user_version < 3) {
    const upd = conn.prepare('UPDATE items SET width = ?, height = ?, duration = COALESCE(duration, ?) WHERE id = ?');
    conn.exec('BEGIN');
    for (const row of db
      .prepare("SELECT id, file, width, height FROM items WHERE type IN ('video', 'gif') AND ext IN ('mp4', 'mov', 'm4v') AND file IS NOT NULL")
      .all()) {
      const probe = probeMp4(path.join(paths.files, row.file));
      if (probe && (probe.width !== row.width || probe.height !== row.height)) {
        upd.run(probe.width, probe.height, probe.duration, row.id);
      }
    }
    conn.exec('PRAGMA user_version = 3');
    conn.exec('COMMIT');
  }

  // v3 -> v4: embeddings per kind (image, text); the old image-only ones are computed again
  if (conn.prepare('PRAGMA user_version').get().user_version < 4) {
    conn.exec('BEGIN');
    conn.exec('DROP TABLE IF EXISTS item_embeddings');
    conn.exec(EMBEDDINGS_TABLE);
    conn.exec('PRAGMA user_version = 4');
    conn.exec('COMMIT');
  }

  // v4 -> v5: links keep their page's meta description in its own column instead of the post text one
  if (conn.prepare('PRAGMA user_version').get().user_version < 5) {
    conn.exec('BEGIN');
    if (!conn.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'description'").get()) {
      conn.exec('ALTER TABLE items ADD COLUMN description TEXT');
    }
    conn.exec("UPDATE items SET description = text, text = NULL WHERE source IN ('web', 'social') AND text IS NOT NULL");
    conn.exec('PRAGMA user_version = 5');
    conn.exec('COMMIT');
  }

  // A browser-safe full-screen copy of an original browsers can't show (HEIC), made at import. NULL means not made
  // yet, '' means it couldn't be decoded. See library.js.
  if (!conn.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'preview'").get()) {
    conn.exec('ALTER TABLE items ADD COLUMN preview TEXT');
  }
  // Optional progressive JPEG XL thumbnail, next to the webp one (which stays: embeddings and colours read it, and
  // browsers without JPEG XL show it). NULL means not made yet, '' means it couldn't be made. See thumbnails.js.
  if (!conn.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'thumb_jxl'").get()) {
    conn.exec('ALTER TABLE items ADD COLUMN thumb_jxl TEXT');
  }
  // ...and a screen-sized one for the full-screen viewer, made from the original. '' when there's none: not an image,
  // or an original no bigger than the thumbnail.
  if (!conn.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'preview_jxl'").get()) {
    conn.exec('ALTER TABLE items ADD COLUMN preview_jxl TEXT');
  }

  // A folder's board: where every image sits on its canvas, how it was last arranged, and the camera it was
  // looking through. JSON, normalized on the way in and out by board.js; NULL until someone arranges the folder.
  if (!conn.prepare("SELECT 1 FROM pragma_table_info('folders') WHERE name = 'board'").get()) {
    conn.exec('ALTER TABLE folders ADD COLUMN board TEXT');
  }
}

// Opened while the module loads: a server that can't open its library fails at start, and the supervisor (index.js)
// waits and tries again.
connection();
