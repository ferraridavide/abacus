import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PNG, startAbacus } from './helpers.js';

let app;
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'abacus-elsewhere-'));
const basic = { as: 'basic' };

before(async () => {
  app = await startAbacus();
});
after(async () => {
  await app?.stop();
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

async function settled(expectPath) {
  for (let i = 0; i < 150; i++) {
    const res = await app.call('GET', '/api/settings/data-location', undefined, basic).catch(() => null);
    if (res?.status === 200 && !res.data.move && res.data.path === expectPath) return res.data;
    if (res?.data?.move?.state === 'failed') throw new Error(res.data.move.error);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`never settled in ${expectPath}\n${app.log}`);
}

describe('library folder', () => {
  test('starts in DATA_DIR', async () => {
    const { data } = await app.call('GET', '/api/settings/data-location', undefined, basic);
    assert.equal(data.path, app.dataDir);
    assert.equal(data.isHome, true);
    assert.equal(data.move, null);
  });

  test('browses folders and marks libraries', async () => {
    const { status, data } = await app.call('GET', '/api/settings/data-location/browse?path=' + encodeURIComponent(path.dirname(app.dataDir)), undefined, basic);
    assert.equal(status, 200);
    assert.ok(data.folders.find((f) => f.path === app.dataDir)?.library);
    assert.ok(data.places.length >= 2);
    const missing = await app.call('GET', '/api/settings/data-location/browse?path=' + encodeURIComponent(path.join(elsewhere, 'nope')), undefined, basic);
    assert.equal(missing.status, 400);
  });

  test('refuses relative paths, the current folder and folders inside it', async () => {
    for (const body of [{ path: 'relative', mode: 'copy' }, { path: app.dataDir, mode: 'copy' }, { path: path.join(app.dataDir, 'files', 'x'), mode: 'copy' }, { path: elsewhere, mode: 'open' }]) {
      assert.equal((await app.call('POST', '/api/settings/data-location', body, basic)).status, 400, JSON.stringify(body));
    }
    assert.equal((await app.call('POST', '/api/settings/data-location', { path: elsewhere, mode: 'copy' })).status, 403);
  });

  test('copies the library to another folder, keeps working there, and opens the old one again', async () => {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'moved.png');
    const added = await app.call('POST', '/api/add', form);
    assert.equal(added.status, 201);
    const id = added.data.items[0].id;

    const target = path.join(elsewhere, 'library');
    const before = (await app.call('GET', '/api/revision', undefined, basic)).data;
    assert.equal(before.library, app.dataDir);
    // pasted as Explorer's "Copy as path" gives it: quoted
    assert.equal((await app.call('POST', '/api/settings/data-location', { path: ` "${target}" `, mode: 'copy' }, basic)).status, 202);
    const moved = await settled(target);
    assert.equal((await app.call('GET', '/api/revision', undefined, basic)).data.library, target, 'clients see the library changed');
    assert.equal(moved.isHome, false);
    assert.ok(fs.existsSync(path.join(target, 'library.db')));
    assert.ok(fs.existsSync(path.join(app.dataDir, 'library.db')), 'the old copy is left in place');
    // held exclusively: no shared-memory file next to it
    assert.equal(fs.existsSync(path.join(target, 'library.db-shm')), false);

    const item = await app.item(id);
    assert.equal(item.name, 'moved');
    assert.equal((await fetch(app.baseUrl + item.fileUrl, { headers: { authorization: 'Basic ' + Buffer.from('abacus:secret').toString('base64') } })).status, 200);
    assert.equal((await app.call('POST', '/api/add', { name: 'after', text: 'written in the new folder' })).status, 201);

    // a copy onto a folder that already holds a library needs replace
    assert.equal((await app.call('POST', '/api/settings/data-location', { path: app.dataDir, mode: 'copy' }, basic)).status, 409);
    assert.equal((await app.call('POST', '/api/settings/data-location', { path: app.dataDir, mode: 'open' }, basic)).status, 202);
    const back = await settled(app.dataDir);
    assert.equal(back.isHome, true);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'data-location.json')), false);
    const { data } = await app.call('GET', '/api/items?q=after', undefined, basic);
    assert.equal(data.total, 0, 'the old library does not have what was added to the new one');
  });
});

describe('a library folder that is missing', () => {
  test('is reported until it comes back, instead of starting an empty library', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abacus-home-'));
    const gone = path.join(elsewhere, 'unmounted');
    fs.writeFileSync(path.join(home, 'data-location.json'), JSON.stringify({ dataDir: gone }));
    const { spawn } = await import('node:child_process');
    const { freePort, SERVER_DIR } = await import('./helpers.js');
    const port = await freePort();
    const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: home, LOG_LEVEL: 'silent', AUTH_PASSWORD: '' },
      stdio: 'ignore',
    });
    try {
      let res;
      for (let i = 0; i < 100 && !res; i++) {
        res = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
        if (!res) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(res.status, 503);
      assert.match((await res.json()).error, /No library in/);
      assert.equal(fs.existsSync(gone), false, 'nothing was created in its place');
    } finally {
      server.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
