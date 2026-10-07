import { DatabaseSync } from 'node:sqlite';
import { paths } from './config.js';

export const db = new DatabaseSync(paths.db);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

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
    source        TEXT NOT NULL DEFAULT 'upload', -- upload | x | web
    author        TEXT,
    author_handle TEXT,
    author_avatar TEXT,
    text          TEXT,                   -- tweet text / page description
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

db.exec(`
  CREATE TABLE IF NOT EXISTS item_colors (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    r INTEGER NOT NULL, g INTEGER NOT NULL, b INTEGER NOT NULL,
    ratio REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_item_colors_item ON item_colors(item_id);
  CREATE INDEX IF NOT EXISTS idx_items_list ON items(deleted_at, created_at);
`);

// v1 -> v2: backfill item_colors from the palette JSON column
if (db.prepare('PRAGMA user_version').get().user_version < 2) {
  const ins = db.prepare('INSERT INTO item_colors (item_id, r, g, b, ratio) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  db.exec('DELETE FROM item_colors');
  for (const row of db.prepare("SELECT id, palette FROM items WHERE palette IS NOT NULL AND palette != '[]'").all()) {
    for (const p of JSON.parse(row.palette)) {
      const h = p.hex.replace('#', '');
      ins.run(row.id, parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), p.ratio);
    }
  }
  db.exec('PRAGMA user_version = 2');
  db.exec('COMMIT');
}

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
