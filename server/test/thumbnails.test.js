import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import decode, { init } from '@jsquash/jxl/decode.js';
import { startAbacus } from './helpers.js';

let app;
const basic = { as: 'basic' };

before(async () => {
  app = await startAbacus();
  const require = createRequire(import.meta.url);
  await init(await WebAssembly.compile(fs.readFileSync(require.resolve('@jsquash/jxl/codec/dec/jxl_dec.wasm'))));
});

after(async () => { await app?.stop(); });

async function upload(name, { width = 64, height = 48 } = {}) {
  const png = await sharp({ create: { width, height, channels: 3, background: '#3a7bd5' } }).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), name + '.png');
  const { status, data } = await app.call('POST', '/api/add', form, basic);
  assert.equal(status, 201, JSON.stringify(data));
  return data.items[0];
}

async function settled() {
  for (let i = 0; i < 200; i++) {
    const { data } = await app.call('GET', '/api/settings/thumbnails', undefined, basic);
    if (data.state !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the JPEG XL conversion did not finish');
}

describe('progressive JPEG XL thumbnails', () => {
  test('are off by default, and items only have the webp thumbnail', async () => {
    const item = await upload('before');
    assert.ok(item.thumbUrl.includes('.webp'));
    assert.equal(item.thumbJxlUrl, null);
    const { data } = await app.call('GET', '/api/settings/thumbnails', undefined, basic);
    assert.deepEqual([data.jxl, data.previews, data.state], [false, true, 'off']);
  });

  test('turning them on converts the existing items, and new ones get one too', async () => {
    const existing = await upload('existing');
    const { data } = await app.call('PATCH', '/api/settings/thumbnails', { jxl: true }, basic);
    assert.equal(data.jxl, true);
    const done = await settled();
    assert.equal(done.state, 'complete');
    assert.equal(done.processed, done.total);
    assert.equal(done.failed, 0);

    const converted = await app.item(existing.id);
    assert.match(converted.thumbJxlUrl, /^\/thumbs\/.+\.jxl$/);
    assert.ok(converted.thumbUrl.includes('.webp'), 'the webp thumbnail stays for browsers without JPEG XL');

    const res = await fetch(app.baseUrl + converted.thumbJxlUrl, { headers: { authorization: 'Basic ' + Buffer.from('abacus:secret').toString('base64') } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jxl');
    const image = await decode(await res.arrayBuffer());
    assert.deepEqual([image.width, image.height], [64, 48]);

    const fresh = await upload('fresh');
    await settled();
    assert.ok((await app.item(fresh.id)).thumbJxlUrl);
  });

  test('images bigger than the thumbnail get a screen-sized preview, never bigger than the original', async () => {
    const small = await upload('small');
    await settled();
    const converted = await app.item(small.id);
    assert.ok(converted.thumbJxlUrl);
    assert.equal(converted.previewJxlUrl, null, 'its thumbnail already is the full image');
    for (const [width, height, expected] of [[1800, 1200, [1800, 1200]], [4000, 3000, [2560, 1920]]]) {
      const item = await upload(`big-${width}`, { width, height });
      await settled();
      const converted = await app.item(item.id);
      assert.match(converted.previewJxlUrl, /^\/thumbs\/.+\.preview\..+\.jxl$/);
      const res = await fetch(app.baseUrl + converted.previewJxlUrl, { headers: { authorization: 'Basic ' + Buffer.from('abacus:secret').toString('base64') } });
      const image = await decode(await res.arrayBuffer());
      assert.deepEqual([image.width, image.height], expected);
    }
  });

  test('previews can be turned off and on again without recomputing the thumbnails', async () => {
    const item = (await app.call('GET', '/api/items?limit=50', undefined, basic)).data.items.find((i) => i.previewJxlUrl);
    const jxlFiles = () => fs.readdirSync(app.dataDir + '/thumbs').filter((f) => f.endsWith('.jxl'));

    let { data } = await app.call('PATCH', '/api/settings/thumbnails', { previews: false }, basic);
    assert.deepEqual([data.jxl, data.previews, data.state], [true, false, 'complete']);
    const off = await app.item(item.id);
    assert.equal(off.previewJxlUrl, null);
    assert.equal(off.thumbJxlUrl, item.thumbJxlUrl, 'the thumbnail is kept');
    assert.deepEqual(jxlFiles().filter((f) => f.includes('.preview.')), []);

    const fresh = await upload('no-preview', { width: 1600, height: 1000 });
    await settled();
    assert.ok((await app.item(fresh.id)).thumbJxlUrl);
    assert.equal((await app.item(fresh.id)).previewJxlUrl, null);

    ({ data } = await app.call('PATCH', '/api/settings/thumbnails', { previews: true }, basic));
    assert.equal(data.previews, true);
    await settled();
    const on = await app.item(item.id);
    assert.match(on.previewJxlUrl, /\.preview\./);
    assert.equal(on.thumbJxlUrl, item.thumbJxlUrl, 'the thumbnail is still not recomputed');
    assert.ok((await app.item(fresh.id)).previewJxlUrl, 'items added meanwhile get one too');
  });

  test('storage usage counts each kind of file', async () => {
    const { status, data } = await app.call('GET', '/api/settings/storage', undefined, basic);
    assert.equal(status, 200);
    const thumbs = fs.readdirSync(app.dataDir + '/thumbs');
    const size = (names) => names.reduce((sum, f) => sum + fs.statSync(app.dataDir + '/thumbs/' + f).size, 0);
    const previews = thumbs.filter((f) => f.includes('.preview.'));
    const jxl = thumbs.filter((f) => f.endsWith('.jxl') && !f.includes('.preview.'));
    assert.deepEqual(data.preview, { bytes: size(previews), count: previews.length });
    assert.deepEqual(data.jxl, { bytes: size(jxl), count: jxl.length });
    assert.equal(data.webp.count, thumbs.filter((f) => f.endsWith('.webp')).length);
    assert.ok(data.preview.count > 0 && data.files.count > 0 && data.db.bytes > 0);
    assert.equal(data.total, data.db.bytes + data.files.bytes + data.webp.bytes + data.jxl.bytes + data.preview.bytes);
    assert.ok(data.disk.free > 0 && data.disk.size >= data.disk.free);
  });

  test('turning them off deletes them', async () => {
    const before = (await app.call('GET', '/api/items?limit=50', undefined, basic)).data.items.find((i) => i.thumbJxlUrl);
    const { data } = await app.call('PATCH', '/api/settings/thumbnails', { jxl: false }, basic);
    assert.deepEqual([data.jxl, data.state, data.processed], [false, 'off', 0]);
    assert.equal((await app.item(before.id)).thumbJxlUrl, null);
    assert.equal(fs.existsSync(app.dataDir + before.thumbJxlUrl), false);
    assert.deepEqual(fs.readdirSync(app.dataDir + '/thumbs').filter((f) => f.endsWith('.jxl')), []);
  });
});
