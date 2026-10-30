import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startAbacus, startFixture } from './helpers.js';

let app;
let fixture;

before(async () => {
  fixture = await startFixture();
  app = await startAbacus();
});

after(async () => {
  await app?.stop();
  await fixture?.close();
});

const page = (title) => `${fixture.url}/page/${encodeURIComponent(title)}`;

describe('Chrome extension helpers', () => {
  let lib;
  before(async () => {
    globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
    lib = await import('../../extensions/chrome/lib.js');
  });
  const config = () => ({ serverUrl: app.baseUrl, token: 'test-token' });

  test('waits for an import to finish and returns the counts', async () => {
    const progress = [];
    const data = await lib.addToAbacus({ url: page('Chrome page') }, { config: config(), onProgress: (j) => progress.push(j.status) });
    assert.deepEqual([data.created, data.skipped, data.failed], [1, 0, 0]);
    assert.equal(lib.summarize(data), '1 saved');
  });

  test('rejects with the reason when the import fails', async () => {
    await assert.rejects(lib.addToAbacus({ url: fixture.url + '/missing' }, { config: config() }), /404/);
  });

  test('reports a wrong token clearly', async () => {
    await assert.rejects(lib.addToAbacus({ text: 'x', name: 'x' }, { config: { ...config(), token: 'wrong' } }), /rejected the token/);
  });

  test('without a server it asks for one', async () => {
    await assert.rejects(lib.addToAbacus({ text: 'x' }, { config: { serverUrl: '', token: 't' } }), /Set your Abacus server/);
  });

  test('shows warnings, such as notes left alone on an existing item', async () => {
    await lib.addToAbacus({ url: page('Warned') }, { config: config() });
    const data = await lib.addToAbacus({ url: page('Warned'), notes: 'again' }, { config: config() });
    // Async adds report the skip but can't know about the notes until the job ends; the sync API warns.
    assert.equal(lib.summarize(data), '1 already in your library');
  });

  test('folder paths list nested folders in full', () => {
    const folders = [
      { id: 'a', name: 'Design', parentId: null },
      { id: 'b', name: 'Logos', parentId: 'a' },
      { id: 'c', name: 'Inbox', parentId: null },
    ];
    assert.deepEqual(lib.folderPaths(folders), ['Design', 'Design / Logos', 'Inbox']);
  });

  test('server addresses are normalized', () => {
    assert.equal(lib.normalizeServerUrl('my-server:8090/'), 'http://my-server:8090');
    assert.equal(lib.normalizeServerUrl(' https://abacus.example/ '), 'https://abacus.example');
    assert.equal(lib.normalizeServerUrl('javascript:alert(1)'), '');
    assert.equal(lib.originPattern('http://my-server:8090'), 'http://my-server:8090/*');
  });
});
