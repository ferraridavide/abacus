import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { startAbacus } from './helpers.js';

// The server closes the database when it's idle, so a sync tool can replace library.db. These tests stand in for the
// sync tool: they replace the file, take it away, or read it while the server is meant to have let go of it.

const basic = { as: 'basic' };
const IDLE = { DB_IDLE_CLOSE_MS: '100' };
// open for the whole test: what's checked is that the file is whole while the server still has it
const STAYS_OPEN = { DB_IDLE_CLOSE_MS: '600000' };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'abacus-idle-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const running = [];
let template;

before(async () => {
  // an empty library, as the server makes it, to copy into the folders the tests use
  const maker = await startAbacus();
  await stopAndKeep(maker);
  template = path.join(scratch, 'template.db');
  const made = new DatabaseSync(path.join(maker.dataDir, 'library.db'));
  try {
    made.prepare('VACUUM INTO ?').run(template);
  } finally {
    made.close();
  }
  fs.rmSync(maker.dataDir, { recursive: true, force: true });
});

after(async () => {
  for (const app of running) await app.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Stop a server and keep its data. stop() gives up waiting after 3 s, and a busy machine can take longer to let go. */
async function stopAndKeep(app) {
  const exited = new Promise((resolve) => app.server.once('exit', resolve));
  await app.stop({ removeData: false });
  if (app.server.exitCode === null) await exited;
}

/** A library file holding notes with these names, made outside the server, as another machine would. */
function makeLibrary(file, names = []) {
  fs.copyFileSync(template, file);
  const other = new DatabaseSync(file);
  try {
    const insert = other.prepare("INSERT INTO items (id, name, type, created_at, updated_at) VALUES (?, ?, 'bookmark', ?, ?)");
    for (const name of names) insert.run('other-' + name, name, Date.now(), Date.now());
  } finally {
    other.close();
  }
}

/** Start a server whose library is in a folder of its own, outside DATA_DIR, as in a synced folder. */
async function startOutsideHome(env = {}, { names = [], beside = [] } = {}) {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  const library = fs.mkdtempSync(path.join(scratch, 'library-'));
  makeLibrary(path.join(library, 'library.db'), names);
  for (const name of beside) fs.writeFileSync(path.join(library, name), '');
  fs.writeFileSync(path.join(home, 'data-location.json'), JSON.stringify({ dataDir: library }));
  const app = await startAbacus(env, { dataDir: home });
  running.push(app);
  app.library = library;
  app.db = path.join(library, 'library.db');
  return app;
}

/**
 * Wait until the server has let go of its library, then run `fn` on a connection of the test's own. Outside DATA_DIR
 * the server holds the file exclusively while it's open, so until then a read here fails with "database is locked".
 */
async function whileClosed(file, fn = () => {}) {
  const until = Date.now() + 5000;
  for (;;) {
    const probe = new DatabaseSync(file);
    try {
      // exclusive like the server, so this leaves no -shm or -wal behind either
      probe.exec('PRAGMA locking_mode = EXCLUSIVE');
      probe.prepare('SELECT 1 FROM sqlite_master').get();
      return fn(probe);
    } catch (err) {
      if (err.errcode !== 5 || Date.now() > until) throw err;
    } finally {
      probe.close();
    }
    await sleep(25);
  }
}

/** Whether the server has the library open: a read from another program then fails with "database is locked". */
const isLocked = (file) => {
  const probe = new DatabaseSync(file);
  try {
    probe.exec('PRAGMA locking_mode = EXCLUSIVE');
    probe.prepare('SELECT 1 FROM sqlite_master').get();
    return false;
  } catch (err) {
    if (err.errcode !== 5) throw err;
    return true;
  } finally {
    probe.close();
  }
};

const walBytes = (file) => fs.statSync(file + '-wal', { throwIfNoEntry: false })?.size ?? 0;
const names = (db) => db.prepare('SELECT name FROM items ORDER BY name').all().map((row) => row.name);
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const revision = async (app) => (await app.call('GET', '/api/revision', undefined, basic)).data.revision;
const revisionStatus = async (app) => (await app.call('GET', '/api/revision', undefined, basic)).status;

async function addNote(app, name) {
  const { status, data } = await app.call('POST', '/api/add', { name, text: 'a note called ' + name });
  assert.equal(status, 201, JSON.stringify(data));
  return data.items[0].id;
}

/** Copy the library aside, then add a note the copy doesn't have. Resolves once the server has let go of it. */
async function addBesideACopy(app) {
  const aside = path.join(app.library, 'aside.tmp');
  await whileClosed(app.db, () => fs.copyFileSync(app.db, aside));
  const id = await addNote(app, 'only here');
  assert.equal((await app.call('GET', '/api/items/' + id, undefined, basic)).status, 200);
  await whileClosed(app.db);
  return { aside, id };
}

/** Replace library.db the way Syncthing does: the old file goes first, then the new one is renamed into place. */
function swapIn(app, replacement) {
  fs.rmSync(app.db);
  fs.renameSync(replacement, app.db);
}

describe('a library in a synced folder', () => {
  test('is released once the server is idle', async () => {
    const app = await startOutsideHome(IDLE);
    await addNote(app, 'released');
    const seen = await whileClosed(app.db, names);
    assert.ok(seen.includes('released'), 'another program reads the write');
    assert.equal(fs.existsSync(app.db + '-wal'), false);
    if (process.platform === 'win32') {
      // what a sync tool needs to replace it
      fs.renameSync(app.db, app.db + '.away');
      fs.renameSync(app.db + '.away', app.db);
    }
    assert.equal((await app.call('GET', '/api/items?q=released', undefined, basic)).data.total, 1);
  });

  test('stays open when DB_IDLE_CLOSE_MS is 0', async () => {
    const app = await startOutsideHome({ DB_IDLE_CLOSE_MS: '0' });
    await addNote(app, 'kept open');
    await sleep(400);
    assert.ok(isLocked(app.db), 'another program is told the database is locked');
  });

  test('keeps library.db whole after every write', async () => {
    const app = await startOutsideHome(STAYS_OPEN);
    for (const name of ['first', 'second']) {
      await addNote(app, name);
      assert.equal(walBytes(app.db), 0, 'nothing waits in the log');
      assert.ok(isLocked(app.db), 'the server still has it open');
      const copy = path.join(scratch, `alone-${name}.db`);
      fs.copyFileSync(app.db, copy);
      const alone = new DatabaseSync(copy, { readOnly: true });
      try {
        assert.ok(names(alone).includes(name), 'a copy of library.db alone has the write');
      } finally {
        alone.close();
      }
    }
  });

  test('leaves no log to replay when the server is killed', async () => {
    const app = await startOutsideHome(STAYS_OPEN);
    const killed = await addNote(app, 'written before the kill');
    const exited = new Promise((resolve) => app.server.once('exit', resolve));
    app.server.kill('SIGKILL');
    await exited;
    assert.equal(walBytes(app.db), 0);

    // the sync tool brings another machine's library while the server is down
    const incoming = path.join(app.library, 'incoming.tmp');
    makeLibrary(incoming, ['from another machine']);
    swapIn(app, incoming);
    const next = await startAbacus(IDLE, { dataDir: app.dataDir });
    running.push(next);
    const { data } = await next.call('GET', '/api/items', undefined, basic);
    assert.deepEqual(data.items.map((item) => item.name), ['from another machine']);
    assert.equal((await next.call('GET', '/api/items/' + killed, undefined, basic)).status, 404);
  });

  test('shows a library replaced from outside', async () => {
    const app = await startOutsideHome(IDLE, { names: ['shared'] });
    const { aside, id } = await addBesideACopy(app);
    swapIn(app, aside);
    assert.equal((await app.call('GET', '/api/items/' + id, undefined, basic)).status, 404);
    const { data } = await app.call('GET', '/api/items', undefined, basic);
    assert.deepEqual(data.items.map((item) => item.name), ['shared']);
  });

  test('tells open tabs about the replacement', async () => {
    const app = await startOutsideHome(IDLE, { names: ['shared'] });
    const { aside } = await addBesideACopy(app);
    const before = await revision(app);
    swapIn(app, aside);
    // nothing but the revision poll, as from an open tab that's waiting
    let after = before;
    for (let i = 0; i < 100 && after === before; i++) {
      await sleep(25);
      after = await revision(app);
    }
    assert.notEqual(after, before, 'the revision moved');
    for (let i = 0; i < 4; i++) {
      await whileClosed(app.db);
      assert.equal(await revision(app), after, 'and moved once');
    }
  });

  test('does not announce its own writes twice', async () => {
    const home = await startAbacus(IDLE);
    running.push(home);
    for (const app of [home, await startOutsideHome(IDLE)]) {
      const id = await addNote(app, 'mine');
      const written = await revision(app);
      for (let i = 0; i < 4; i++) {
        await sleep(250);
        assert.equal((await app.call('GET', '/api/items/' + id, undefined, basic)).status, 200);
        assert.equal((await app.call('GET', '/api/items?q=mine', undefined, basic)).data.total, 1);
        await sleep(250);
        assert.equal(await revision(app), written);
      }
    }
  });

  test('never creates a library that is missing', async () => {
    const app = await startOutsideHome(IDLE, { names: ['still here'] });
    const list = async () => app.call('GET', '/api/items', undefined, basic);
    const before = await list();
    await whileClosed(app.db);
    fs.renameSync(app.db, app.db + '.away');

    const started = Date.now();
    const missing = await list();
    assert.equal(missing.status, 503, JSON.stringify(missing.data));
    assert.ok(Date.now() - started < 1000, 'answered within a second');
    assert.equal(await revisionStatus(app), 200, 'the revision poll still answers');
    assert.equal((await app.call('GET', '/api/health', undefined, { as: 'none' })).status, 200);
    assert.equal(fs.existsSync(app.db), false, 'nothing was created in its place');

    fs.renameSync(app.db + '.away', app.db);
    const back = await list();
    assert.equal(back.status, 200);
    assert.deepEqual(back.data.items, before.data.items);
  });

  test('does not initialize an empty file', async () => {
    const app = await startOutsideHome(IDLE, { names: ['still here'] });
    const list = async () => app.call('GET', '/api/items', undefined, basic);
    const before = await list();
    await whileClosed(app.db);
    fs.renameSync(app.db, app.db + '.away');
    fs.writeFileSync(app.db, '');

    assert.equal((await list()).status, 503);
    assert.equal(await revisionStatus(app), 200, 'the revision poll still answers');
    assert.equal(fs.statSync(app.db).size, 0, 'the file is still empty');

    fs.rmSync(app.db);
    fs.renameSync(app.db + '.away', app.db);
    const back = await list();
    assert.equal(back.status, 200);
    assert.deepEqual(back.data.items, before.data.items);
  });

  test('leaves the file untouched while it only answers reads', async () => {
    const app = await startOutsideHome(IDLE);
    const id = await addNote(app, 'read me');
    assert.equal((await app.call('POST', '/api/folders', { name: 'Shelf' }, basic)).status, 200);
    const key = (await app.call('POST', '/api/settings/api-keys', { name: 'Extension' }, basic)).data;
    const withKey = { as: 'none', headers: { authorization: `Bearer ${key.token}` } };
    assert.equal((await app.call('GET', '/api/bootstrap', undefined, withKey)).status, 200);

    await whileClosed(app.db);
    const before = { hash: hash(app.db), mtime: fs.statSync(app.db).mtimeMs };
    const reads = [
      ['/api/bootstrap', basic],
      ['/api/items', basic],
      ['/api/items?q=read', basic],
      ['/api/items/ids', basic],
      ['/api/items/' + id, basic],
      ['/api/tags', basic],
      ['/api/folders', basic],
      ['/api/settings/api-keys', basic],
      ['/api/settings/appearance', basic],
      ['/api/settings/providers', basic],
      ['/api/settings/embeddings', basic],
      ['/api/embeddings/status', basic],
      ['/api/settings/thumbnails', basic],
      ['/api/settings/storage', basic],
      ['/api/settings/data-location', basic],
      ['/api/revision', basic],
      ['/api/bootstrap', withKey],
      ['/api/autocomplete', withKey],
      ['/api/settings/appearance', withKey],
    ];
    for (const [url, as] of reads) {
      assert.equal((await app.call('GET', url, undefined, as)).status, 200, url);
    }
    await whileClosed(app.db);
    assert.equal(hash(app.db), before.hash);
    assert.equal(fs.statSync(app.db).mtimeMs, before.mtime);
    assert.equal(fs.existsSync(app.db + '-wal'), false);
  });

  test("records an API key's use at most once an hour", async () => {
    const app = await startOutsideHome(IDLE);
    const key = (await app.call('POST', '/api/settings/api-keys', { name: 'Twice' }, basic)).data;
    const withKey = { as: 'none', headers: { authorization: `Bearer ${key.token}` } };
    const lastUsed = async () =>
      (await app.call('GET', '/api/settings/api-keys', undefined, basic)).data.find((row) => row.id === key.id).lastUsedAt;
    assert.equal(await lastUsed(), null);
    assert.equal((await app.call('GET', '/api/bootstrap', undefined, withKey)).status, 200);
    const first = await lastUsed();
    assert.ok(first > 0);
    await sleep(20);
    assert.equal((await app.call('GET', '/api/autocomplete', undefined, withKey)).status, 200);
    assert.equal(await lastUsed(), first);
  });

  test('follows a file replaced while it is open', { skip: process.platform === 'win32' && 'Windows does not let an open file be replaced' }, async () => {
    const app = await startOutsideHome(STAYS_OPEN, { names: ['old library'] });
    assert.deepEqual((await app.call('GET', '/api/items', undefined, basic)).data.items.map((i) => i.name), ['old library']);
    assert.ok(isLocked(app.db), 'the server has it open');

    const incoming = path.join(app.library, 'incoming.tmp');
    makeLibrary(incoming, ['new library']);
    fs.renameSync(incoming, app.db);
    // reads look at the file at most every 250 ms
    await sleep(300);
    assert.deepEqual((await app.call('GET', '/api/items', undefined, basic)).data.items.map((i) => i.name), ['new library']);
    await addNote(app, 'added after');

    await stopAndKeep(app);
    const after = new DatabaseSync(app.db, { readOnly: true });
    try {
      assert.deepEqual(names(after), ['added after', 'new library']);
    } finally {
      after.close();
    }
  });

  test('warns about a conflict copy, once', async () => {
    const conflict = 'library.sync-conflict-20260101-000000-ABCDEFG.db';
    const app = await startOutsideHome(IDLE, { beside: [conflict] });
    await addNote(app, 'after the conflict');
    await whileClosed(app.db);
    await app.call('GET', '/api/items', undefined, basic);
    await whileClosed(app.db);
    const lines = app.log.split('\n').filter((line) => line.includes(conflict));
    assert.equal(lines.length, 1, app.log);
    assert.ok(lines[0].includes(path.join(app.library, conflict)));
  });
});
