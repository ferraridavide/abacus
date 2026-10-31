import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PNG, startAbacus } from './helpers.js';

let app;

before(async () => {
  app = await startAbacus();
});

after(async () => {
  await app?.stop();
});

const revision = async () => (await app.call('GET', '/api/revision', undefined, { as: 'basic' })).data.revision;

describe('GET /api/revision', () => {
  test('is stable while nothing is written, and not cached', async () => {
    const res = await app.call('GET', '/api/revision', undefined, { as: 'basic' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.data.revision, /^[a-z0-9]+\.\d+$/);
    assert.equal(await revision(), res.data.revision);
    assert.equal(await revision(), res.data.revision);
  });

  test('changes after a note, an upload, and a folder are added', async () => {
    let last = await revision();

    const note = await app.call('POST', '/api/add', { name: 'Revision note', text: 'hello' });
    assert.equal(note.status, 201);
    let next = await revision();
    assert.notEqual(next, last);
    last = next;

    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'rev.png');
    assert.equal((await app.call('POST', '/api/add', form)).status, 201);
    next = await revision();
    assert.notEqual(next, last);
    last = next;

    assert.equal((await app.call('POST', '/api/folders', { name: 'Revision folder' }, { as: 'basic' })).status, 200);
    next = await revision();
    assert.notEqual(next, last);
  });

  test('changes after editing and trashing items', async () => {
    const { data } = await app.call('POST', '/api/add', { name: 'Edit me', text: 'x' });
    const id = data.items[0].id;
    let last = await revision();
    await app.call('PATCH', '/api/items/' + id, { notes: 'changed' }, { as: 'basic' });
    let next = await revision();
    assert.notEqual(next, last);
    last = next;
    await app.call('POST', '/api/items/batch', { ids: [id], action: 'trash' }, { as: 'basic' });
    assert.notEqual(await revision(), last);
  });

  test('needs the web login: the API token is refused', async () => {
    assert.equal((await app.call('GET', '/api/revision')).status, 403);
    assert.equal((await app.call('GET', '/api/revision', undefined, { as: 'none' })).status, 401);
  });
});
