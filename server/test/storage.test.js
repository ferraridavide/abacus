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

const totalSize = async () => (await app.call('GET', '/api/bootstrap', undefined, { as: 'basic' })).data.stats.totalSize;

/** the stats total is measured in the background, so give it a moment to catch up */
async function settled() {
  let last;
  for (let i = 0; i < 50; i++) {
    const next = await totalSize();
    if (next === last) return next;
    last = next;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

describe('stats totalSize', () => {
  test('matches the storage page, thumbnails and database included', async () => {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'storage.png');
    assert.equal((await app.call('POST', '/api/add', form)).status, 201);

    const stats = await settled();
    const usage = (await app.call('GET', '/api/settings/storage', undefined, { as: 'basic' })).data;
    assert.ok(usage.total > PNG.length, 'the storage page counts more than the file itself');
    // the files and thumbnails are the same walk; only the database can grow between the two requests
    assert.ok(Math.abs(stats - usage.total) <= usage.db.bytes, `${stats} vs ${usage.total}`);
  });

  test('follows the library as items are added', async () => {
    const before = await settled();
    const form = new FormData();
    form.append('file', new Blob([Buffer.concat([PNG, Buffer.alloc(200_000)])], { type: 'image/png' }), 'big.png');
    await app.call('POST', '/api/add', form);
    let after = before;
    for (let i = 0; i < 50 && after - before < 200_000; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = await totalSize();
    }
    assert.ok(after - before >= 200_000, `${before} -> ${after}`);
  });
});
