import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db, tx } from './db.js';
import { getSetting, putSetting } from './settings.js';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const metadata = 'id, name, created_at AS createdAt, last_used_at AS lastUsedAt';
const insertKey = db.prepare('INSERT INTO api_keys (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)');
const findKey = db.prepare('SELECT id FROM api_keys WHERE token_hash = ?');
const markUsed = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');

export function listApiKeys() {
  return db.prepare(`SELECT ${metadata} FROM api_keys ORDER BY created_at DESC, rowid DESC`).all();
}

export function createApiKey(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    throw Object.assign(new Error('API key name must be a string of 1–100 characters'), { statusCode: 400 });
  }
  const token = 'abacus_' + randomBytes(32).toString('hex');
  const key = { id: randomUUID(), name: name.trim(), createdAt: Date.now(), lastUsedAt: null };
  insertKey.run(key.id, key.name, hashToken(token), key.createdAt);
  // The plaintext is returned only here; neither listing nor authenticating can retrieve it.
  return { ...key, token };
}

export function deleteApiKey(id) {
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
}

export function findApiKey(token) {
  if (typeof token !== 'string' || !token) return null;
  return findKey.get(hashToken(token))?.id ?? null;
}

export function recordApiKeyUse(id) {
  markUsed.run(Date.now(), id);
}

// Import once so existing clients keep working, but deleting the key remains effective after a restart.
export function migrateEnvironmentApiToken() {
  const token = process.env.API_TOKEN || process.env.ABACUS_API_TOKEN;
  if (!token || getSetting('apiTokenMigration').completed) return;
  tx(() => {
    insertKey.run(randomUUID(), 'Legacy API token', hashToken(token), Date.now());
    putSetting('apiTokenMigration', { completed: true });
  });
}
