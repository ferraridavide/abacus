import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startAbacus, startFixture } from './helpers.js';

let app;
let fixture;

before(async () => {
  app = await startAbacus();
  fixture = await startFixture();
});

after(async () => {
  await app?.stop();
  await fixture?.close();
});

describe('authentication', () => {
  test('health is public', async () => {
    const { status } = await app.call('GET', '/api/health', undefined, { as: 'none' });
    assert.equal(status, 200);
  });

  test('no credentials: 401, with a basic-auth challenge for browsers', async () => {
    const { status, headers } = await app.call('POST', '/api/add', { text: 'hi' }, { as: 'none' });
    assert.equal(status, 401);
    assert.match(headers.get('www-authenticate'), /Basic/);
  });

  test('a wrong token: 401 without a browser challenge', async () => {
    const { status, headers } = await app.call('POST', '/api/add', { text: 'hi' }, { as: 'none', headers: { authorization: 'Bearer wrong' } });
    assert.equal(status, 401);
    assert.equal(headers.get('www-authenticate'), null);
  });

  test('the basic login and x-api-key both work on /api/add', async () => {
    const basic = await app.call('POST', '/api/add', { name: 'Basic', text: 'b' }, { as: 'basic' });
    assert.equal(basic.status, 201, JSON.stringify(basic.data));
    const header = await app.call('POST', '/api/add', { name: 'Header', text: 'h' }, { as: 'none', headers: { 'x-api-key': 'test-token' } });
    assert.equal(header.status, 201, JSON.stringify(header.data));
  });

  test('the token can add, follow jobs, and list folders', async () => {
    const add = await app.call('POST', '/api/add', { name: 'n', text: 't' });
    assert.equal(add.status, 201);
    assert.equal((await app.call('POST', '/api/v1/add', { name: 'n', text: 't' })).status, 201);
    assert.equal((await app.call('GET', '/api/bootstrap')).status, 200);
    assert.equal((await app.call('GET', '/api/jobs/unknown')).status, 404);
  });

  test('API-key bootstrap only returns the folder tree, without library counts', async () => {
    const parent = await app.call('POST', '/api/folders', { name: 'Tree parent' }, { as: 'basic' });
    const child = await app.call('POST', '/api/folders', { name: 'Tree child', parentId: parent.data.id }, { as: 'basic' });
    for (const headers of [{ authorization: 'Bearer test-token' }, { 'x-api-key': 'test-token' }]) {
      const { status, data } = await app.call('GET', '/api/bootstrap', undefined, { as: 'none', headers });
      assert.equal(status, 200);
      assert.deepEqual(Object.keys(data), ['folders']);
      assert.ok(data.folders.some((folder) => folder.id === child.data.id && folder.parentId === parent.data.id));
      for (const folder of data.folders) assert.deepEqual(Object.keys(folder).sort(), ['id', 'name', 'parentId']);
    }
    const web = await app.call('GET', '/api/bootstrap', undefined, { as: 'basic' });
    assert.equal(web.status, 200);
    assert.ok(web.data.stats);
    assert.ok(Array.isArray(web.data.tags));
  });

  test('autocomplete authenticates and returns only folder identifiers and active tag names', async () => {
    const folder = (await app.call('POST', '/api/folders', { name: 'Autocomplete folder' }, { as: 'basic' })).data;
    await app.call('POST', '/api/add', { text: 'Tagged note', tags: ['Lazy tag', 'Design'] });
    const trash = (await app.call('POST', '/api/add', { text: 'Trashed note', tags: ['Trash only tag'] })).data.items[0];
    await app.call('POST', '/api/items/batch', { ids: [trash.id], action: 'delete' }, { as: 'basic' });
    for (const headers of [{ authorization: 'Bearer test-token' }, { 'x-api-key': 'test-token' }]) {
      const response = await app.call('GET', '/api/autocomplete', undefined, { as: 'none', headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(Object.keys(response.data).sort(), ['folders', 'tags']);
      assert.ok(response.data.folders.some((entry) => entry.id === folder.id));
      for (const entry of response.data.folders) assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'parentId']);
      assert.ok(response.data.tags.includes('Lazy tag'));
      assert.ok(!response.data.tags.includes('Trash only tag'));
      assert.ok(response.data.tags.every((tag) => typeof tag === 'string'));
    }
    assert.equal((await app.call('GET', '/api/autocomplete', undefined, { as: 'basic' })).status, 200);
    assert.equal((await app.call('GET', '/api/autocomplete', undefined, { as: 'none' })).status, 401);
    assert.equal((await app.call('GET', '/api/autocomplete', undefined, { as: 'none', headers: { authorization: 'Bearer wrong' } })).status, 401);
  });

  test('the token cannot read, change, or delete the library', async () => {
    const id = (await app.call('POST', '/api/add', { name: 'Protected', text: 't' })).data.items[0].id;
    const denied = [
      ['GET', '/api/items'],
      ['GET', `/api/items/${id}`],
      ['PATCH', `/api/items/${id}`, { name: 'x' }],
      ['POST', '/api/items/batch', { ids: [id], action: 'delete' }],
      ['DELETE', '/api/trash'],
      ['POST', '/api/folders', { name: 'x' }],
      ['GET', '/api/settings/providers'],
      ['PATCH', '/api/settings/embeddings', { enabled: true }],
      ['POST', '/api/import', { text: 'https://example.com' }],
      ['GET', '/files/anything'],
      ['GET', '/'],
    ];
    for (const [method, path, body] of denied) {
      const { status, data } = await app.call(method, path, body);
      assert.equal(status, 403, `${method} ${path}`);
      assert.match(data.error, /can only add content/);
    }
    assert.equal((await app.item(id)).name, 'Protected');
  });

  test('adding an existing URL never returns its private metadata to a token', async () => {
    const url = fixture.url + '/page/Existing';
    const first = await app.call('POST', '/api/add', { url }, { as: 'basic' });
    const id = first.data.items[0].id;
    await app.call('PATCH', '/api/items/' + id, {
      name: 'Private title', notes: 'Private notes', tags: ['Private tag'], rating: 5,
    }, { as: 'basic' });

    for (const pathname of ['/api/add', '/api/v1/add']) {
      for (const auth of [{}, { as: 'none', headers: { 'x-api-key': 'test-token' } }]) {
        const { status, data } = await app.call('POST', pathname, { url }, auth);
        assert.equal(status, 200);
        assert.equal(data.skipped, 1);
        assert.deepEqual(data.items, []);
        assert.doesNotMatch(JSON.stringify(data), /Private/);
      }
    }
    const mixed = await app.call('POST', '/api/add', { urls: [url, fixture.url + '/page/New'] });
    assert.deepEqual([mixed.data.created, mixed.data.skipped], [1, 1]);
    assert.equal(mixed.data.items.length, 1);
    assert.equal(mixed.data.items[0].name, 'New');
    assert.doesNotMatch(JSON.stringify(mixed.data), /Private/);
  });
});

describe('CORS', () => {
  const preflight = (origin) =>
    fetch(app.baseUrl + '/api/add', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });

  test('browser extensions may call the API', async () => {
    const res = await preflight('chrome-extension://abcdefghijklmnop');
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');
  });

  test('other websites may not', async () => {
    const res = await preflight('https://evil.example');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

describe('errors', () => {
  test('errors from routes carry their message in `error`', async () => {
    const folder = (await app.call('POST', '/api/folders', { name: 'A' }, { as: 'basic' })).data;
    const { status, data } = await app.call('PATCH', '/api/folders/' + folder.id, { parentId: folder.id }, { as: 'basic' });
    assert.equal(status, 400);
    assert.deepEqual(data, { error: 'Cannot move a folder into itself' });
  });
});
