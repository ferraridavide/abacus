import { db } from './db.js';

// Server-wide settings, edited in the Settings dialog. Per-browser preferences live in the client.

const getRow = db.prepare('SELECT value FROM settings WHERE key = ?');
const putRow = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getSetting(key, defaults = {}) {
  const row = getRow.get(key);
  return { ...defaults, ...(row ? JSON.parse(row.value) : {}) };
}

export function putSetting(key, value) {
  putRow.run(key, JSON.stringify(value));
}
