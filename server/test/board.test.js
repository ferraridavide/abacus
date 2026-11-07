import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PNG, startAbacus } from './helpers.js';

let app;
let call;

before(async () => {
  app = await startAbacus();
  call = app.call;
});

after(async () => {
  await app?.stop();
});

const basic = { as: 'basic' };
const emptyBoard = { mode: 'free', view: null, spots: {}, zOrder: [] };

async function folder(name) {
  return (await call('POST', '/api/folders', { name }, basic)).data;
}

async function image(folderId, name) {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), name);
  form.append('folderId', folderId);
  return (await call('POST', '/api/add', form)).data.items[0];
}

const boardPath = (id) => `/api/folders/${id}/board`;

describe("a folder's board", () => {
  test('is empty, and free, until one is saved', async () => {
    const saved = await folder('Unarranged');
    const { status, data } = await call('GET', boardPath(saved.id), undefined, basic);
    assert.equal(status, 200);
    assert.deepEqual(data, emptyBoard);
  });

  test('keeps every place, size, camera and stacking order, normalized', async () => {
    const f = await folder('Arranged');
    const one = await image(f.id, 'one.png');
    const two = await image(f.id, 'two.png');
    const payload = {
      mode: 'free',
      view: { x: -120.04, y: 40, s: 0.7496 },
      spots: {
        [one.id]: { x: 0, y: 0, w: 300, h: 200 },
        [two.id]: { x: 340.05, y: 10, w: 120.44, h: 90 },
        'not an id!': { x: 1, y: 2, w: 3, h: 4 },
        half: { x: 5, y: 6 },
      },
      zOrder: [two.id, one.id, 'not an id!', two.id],
    };
    const put = await call('PUT', boardPath(f.id), payload, basic);
    assert.equal(put.status, 200);
    const expected = {
      mode: 'free',
      view: { x: -120, y: 40, s: 0.75 },
      spots: {
        [one.id]: { x: 0, y: 0, w: 300, h: 200 },
        [two.id]: { x: 340.1, y: 10, w: 120.4, h: 90 },
      },
      zOrder: [two.id, one.id],
    };
    assert.deepEqual(put.data, expected);
    assert.deepEqual((await call('GET', boardPath(f.id), undefined, basic)).data, expected);
  });

  test('each folder keeps its own arrangement', async () => {
    const a = await folder('Board A');
    const b = await folder('Board B');
    const spot = { x: 12, y: 34, w: 56, h: 78 };
    await call('PUT', boardPath(a.id), { mode: 'grid', spots: { n1: spot }, zOrder: [] }, basic);
    assert.equal((await call('GET', boardPath(b.id), undefined, basic)).data.mode, 'free');
    const boardA = (await call('GET', boardPath(a.id), undefined, basic)).data;
    assert.equal(boardA.mode, 'grid');
    assert.deepEqual(boardA.spots, { n1: spot });
  });

  test('saving an arrangement is not a library change', async () => {
    const f = await folder('Quiet board');
    const before = (await call('GET', '/api/revision', undefined, basic)).data.revision;
    await call('PUT', boardPath(f.id), { mode: 'free', spots: { n1: { x: 0, y: 0, w: 10, h: 10 } } }, basic);
    assert.equal((await call('GET', '/api/revision', undefined, basic)).data.revision, before);
  });

  test('the folder list stays free of arrangements', async () => {
    const f = await folder('Listed folder');
    await call('PUT', boardPath(f.id), { mode: 'free', spots: { n1: { x: 0, y: 0, w: 10, h: 10 } } }, basic);
    const listed = (await app.folders()).find((entry) => entry.id === f.id);
    assert.equal(listed.board, undefined);
  });

  test('an unknown folder is a 404 on both ways in', async () => {
    assert.equal((await call('GET', boardPath('nope'), undefined, basic)).status, 404);
    assert.equal((await call('PUT', boardPath('nope'), emptyBoard, basic)).status, 404);
  });

  test('a deleted folder takes its arrangement with it', async () => {
    const f = await folder('Doomed');
    await call('PUT', boardPath(f.id), { mode: 'free', spots: { n1: { x: 0, y: 0, w: 10, h: 10 } } }, basic);
    assert.equal((await call('DELETE', '/api/folders/' + f.id, undefined, basic)).status, 200);
    assert.equal((await call('GET', boardPath(f.id), undefined, basic)).status, 404);
  });

  test('the arrangement survives a restart', async () => {
    const first = await startAbacus();
    const { dataDir } = first;
    let second = null;
    try {
      const f = (await first.call('POST', '/api/folders', { name: 'Restart' }, basic)).data;
      const saved = {
        mode: 'free',
        view: { x: 5, y: 6, s: 1 },
        spots: { kept: { x: 10, y: 20, w: 100, h: 80 } },
        zOrder: ['kept'],
      };
      assert.equal((await first.call('PUT', boardPath(f.id), saved, basic)).status, 200);
      await first.stop({ removeData: false });

      second = await startAbacus({}, { dataDir });
      const res = await second.call('GET', boardPath(f.id), undefined, basic);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, saved);
    } finally {
      if (second) await second.stop();
      else await first.stop();
    }
  });
});
