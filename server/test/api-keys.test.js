import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { startAbacus } from './helpers.js';

const noEnvironmentToken = { API_TOKEN: '', ABACUS_API_TOKEN: '' };
const basic = { as: 'basic' };
const bearer = (token) => ({ as: 'none', headers: { authorization: `Bearer ${token}` } });
const headerKey = (token) => ({ as: 'none', headers: { 'x-api-key': token } });
let app;

before(async () => { app = await startAbacus(noEnvironmentToken); });
after(async () => { await app?.stop(); });

async function createKey(name = 'Chrome extension') {
  const { status, data, headers } = await app.call('POST', '/api/settings/api-keys', { name }, basic);
  assert.equal(status, 201, JSON.stringify(data));
  assert.equal(headers.get('cache-control'), 'no-store');
  return data;
}

async function listKeys() {
  const { status, data, headers } = await app.call('GET', '/api/settings/api-keys', undefined, basic);
  assert.equal(status, 200);
  assert.equal(headers.get('cache-control'), 'no-store');
  return data;
}

describe('integration API keys', () => {
  test('keys are named, random, stored hashed, and only revealed once', async () => {
    assert.deepEqual(await listKeys(), []);
    const key = await createKey('  Chrome extension  ');
    const other = await createKey('Script');
    assert.equal(key.name, 'Chrome extension');
    assert.equal(key.lastUsedAt, null);
    assert.ok(key.createdAt > 0);
    assert.match(key.token, /^abacus_[a-f0-9]{64}$/);
    assert.notEqual(key.token, other.token);
    assert.notEqual(key.id, other.id);

    const db = new DatabaseSync(path.join(app.dataDir, 'library.db'), { readOnly: true });
    try {
      const stored = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(key.id);
      assert.equal(stored.token_hash, createHash('sha256').update(key.token).digest('hex'));
      assert.ok(!JSON.stringify(stored).includes(key.token));
    } finally {
      db.close();
    }
    const listed = (await listKeys()).find((row) => row.id === key.id);
    const { token, ...metadata } = key;
    assert.deepEqual(listed, metadata);
  });

  test('both header formats authenticate and record use independently for each key', async () => {
    const key = await createKey();
    const unused = await createKey('Unused');
    const started = Date.now();
    for (const auth of [bearer(key.token), headerKey(key.token)]) {
      const result = await app.call('POST', '/api/add', { name: 'Key test', text: 'Saved with a DB key' }, auth);
      assert.equal(result.status, 201, JSON.stringify(result.data));
      assert.equal((await app.call('GET', '/api/bootstrap', undefined, auth)).status, 200);
      assert.equal((await app.call('GET', '/api/jobs/unknown', undefined, auth)).status, 404);
    }
    const listed = await listKeys();
    assert.ok(listed.find((row) => row.id === key.id).lastUsedAt >= started);
    assert.equal(listed.find((row) => row.id === unused.id).lastUsedAt, null);
  });

  test('keys cannot read the library or manage other keys, and denied requests do not record use', async () => {
    const key = await createKey();
    const denied = [
      ['GET', '/api/items'],
      ['GET', '/api/settings/api-keys'],
      ['POST', '/api/settings/api-keys', { name: 'Unauthorized' }],
      ['DELETE', `/api/settings/api-keys/${key.id}`],
    ];
    for (const auth of [bearer(key.token), headerKey(key.token)]) {
      for (const [method, url, body] of denied) {
        assert.equal((await app.call(method, url, body, auth)).status, 403, `${method} ${url}`);
      }
    }
    assert.equal((await listKeys()).find((row) => row.id === key.id).lastUsedAt, null);
    for (const auth of [{ as: 'none' }, bearer('wrong'), headerKey('wrong')]) {
      assert.equal((await app.call('GET', '/api/settings/api-keys', undefined, auth)).status, 401);
    }
  });

  test('key names are required and limited to 100 characters', async () => {
    for (const name of [undefined, null, '', '   ', 3, {}, 'x'.repeat(101)]) {
      const result = await app.call('POST', '/api/settings/api-keys', { name }, basic);
      assert.equal(result.status, 400, JSON.stringify(name));
    }
    assert.equal((await createKey('x'.repeat(100))).name.length, 100);
  });

  test('revocation takes effect immediately without affecting other keys', async () => {
    const key = await createKey('Revoke me');
    const other = await createKey('Keep me');
    assert.equal((await app.call('DELETE', `/api/settings/api-keys/${key.id}`, undefined, basic)).status, 200);
    assert.ok(!(await listKeys()).some((row) => row.id === key.id));
    for (const auth of [bearer(key.token), headerKey(key.token)]) {
      assert.equal((await app.call('POST', '/api/add', { text: 'Rejected' }, auth)).status, 401);
    }
    assert.equal((await app.call('GET', '/api/bootstrap', undefined, bearer(other.token))).status, 200);
    assert.equal((await app.call('DELETE', `/api/settings/api-keys/${key.id}`, undefined, basic)).status, 404);
  });

  test('keys and last-used timestamps survive a server restart', async () => {
    const key = await createKey('Persistent');
    await app.call('GET', '/api/bootstrap', undefined, bearer(key.token));
    const before = (await listKeys()).find((row) => row.id === key.id);
    const { dataDir } = app;
    await app.stop({ removeData: false });
    app = await startAbacus(noEnvironmentToken, { dataDir });
    assert.deepEqual((await listKeys()).find((row) => row.id === key.id), before);
    assert.equal((await app.call('GET', '/api/bootstrap', undefined, bearer(key.token))).status, 200);
  });
});

test('a legacy environment token is imported once and stays revoked after restarting', async () => {
  let legacyApp = await startAbacus({ ABACUS_API_TOKEN: '' });
  try {
    const result = await legacyApp.call('GET', '/api/settings/api-keys', undefined, basic);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].name, 'Legacy API token');
    assert.equal(result.data[0].lastUsedAt, null);
    assert.equal((await legacyApp.call('GET', '/api/bootstrap')).status, 200);
    await legacyApp.call('DELETE', `/api/settings/api-keys/${result.data[0].id}`, undefined, basic);
    const { dataDir } = legacyApp;
    await legacyApp.stop({ removeData: false });
    legacyApp = await startAbacus({}, { dataDir });
    assert.deepEqual((await legacyApp.call('GET', '/api/settings/api-keys', undefined, basic)).data, []);
    assert.equal((await legacyApp.call('GET', '/api/bootstrap')).status, 401);
  } finally {
    await legacyApp.stop();
  }
});

test('creating keys without a web password preserves web access and still restricts key requests', async () => {
  const openApp = await startAbacus({ ...noEnvironmentToken, AUTH_PASSWORD: '' });
  try {
    const key = await openApp.call('POST', '/api/settings/api-keys', { name: 'Open installation' }, { as: 'none' });
    assert.equal(key.status, 201);
    assert.equal((await openApp.call('GET', '/api/items', undefined, { as: 'none' })).status, 200);
    assert.equal((await openApp.call('GET', '/api/bootstrap', undefined, bearer(key.data.token))).status, 200);
    assert.equal((await openApp.call('GET', '/api/settings/api-keys', undefined, bearer(key.data.token))).status, 403);
    assert.equal((await openApp.call('GET', '/api/bootstrap', undefined, bearer('wrong'))).status, 401);
  } finally {
    await openApp.stop();
  }
});
