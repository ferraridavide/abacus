import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startAbacus } from './helpers.js';

let app;

before(async () => {
  app = await startAbacus();
});

after(async () => {
  await app?.stop();
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

describe('a server with no login and no token (a private network)', () => {
  let open;
  before(async () => {
    open = await startAbacus({ AUTH_PASSWORD: '', API_TOKEN: '' });
  });
  after(async () => {
    await open?.stop();
  });

  test('everything works without credentials', async () => {
    const add = await open.call('POST', '/api/add', { name: 'Open note', text: 'no auth' }, { as: 'none' });
    assert.equal(add.status, 201, JSON.stringify(add.data));
    assert.equal((await open.call('GET', '/api/items', undefined, { as: 'none' })).status, 200);
  });

  test('the extension helpers work without a token', async () => {
    globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
    const lib = await import('../../extensions/chrome/lib.js');
    const data = await lib.addToAbacus({ name: 'From the extension', text: 'x' }, { config: { serverUrl: open.baseUrl } });
    assert.equal(lib.summarize(data), '1 saved');
  });
});
