import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { PNG, startAbacus } from './helpers.js';

const PAGE = 'https://example.com/gallery/1';
let app;
let site;
let base;
let n = 0;
// Fresh image URLs per test, so de-duplication never gets in the way.
const fresh = (kind) => `${base}/${kind}.png?n=${++n}`;

before(async () => {
  app = await startAbacus();
  site = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://site');
    if (pathname === '/ok.png' || (pathname === '/guarded.png' && req.headers.referer === PAGE)) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      return res.end(PNG);
    }
    res.writeHead(pathname === '/guarded.png' ? 403 : 404);
    res.end('nope');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});

after(async () => {
  await app?.stop();
  await new Promise((resolve) => site?.close(resolve));
});

const add = (body) => app.call('POST', '/api/add', body);

describe('pageUrl on link imports', () => {
  test('a hotlink-protected image fails without pageUrl', async () => {
    const res = await add({ url: fresh('guarded') });
    assert.equal(res.status, 502);
    assert.equal(res.data.job.failed, 1);
    assert.match(res.data.error, /HTTP 403/);
  });

  test('pageUrl is sent as the Referer and becomes the item url', async () => {
    const image = fresh('guarded');
    const res = await add({ url: image, pageUrl: PAGE });
    assert.equal(res.status, 201);
    assert.equal(res.data.job.failed, 0);
    const item = await app.item(res.data.items[0].id);
    assert.equal(item.url, PAGE);
    assert.equal(item.mediaUrl, image);
  });

  test('without pageUrl the item url is the image url', async () => {
    const image = fresh('ok');
    const res = await add({ url: image });
    const item = await app.item(res.data.items[0].id);
    assert.equal(item.url, image);
    assert.equal(item.mediaUrl, image);
  });

  test('an image already in the library is skipped by its mediaUrl', async () => {
    const image = fresh('guarded');
    assert.equal((await add({ url: image, pageUrl: PAGE })).data.created, 1);
    const again = await add({ url: image, pageUrl: PAGE });
    assert.equal(again.data.skipped, 1);
    assert.equal(again.data.created, 0);
  });

  test('an invalid pageUrl is a 400', async () => {
    for (const pageUrl of ['javascript:alert(1)', 'not a url']) {
      const res = await add({ url: fresh('ok'), pageUrl });
      assert.equal(res.status, 400);
    }
  });
});

describe('fallbackUrls', () => {
  test('rescue a failing main URL', async () => {
    const fallback = fresh('ok');
    const res = await add({ url: fresh('missing'), fallbackUrls: [fresh('missing'), fallback] });
    assert.equal(res.status, 201);
    assert.equal(res.data.job.failed, 0);
    assert.equal(res.data.job.entries[0].state, 'done');
    assert.equal((await app.item(res.data.items[0].id)).mediaUrl, fallback);
  });

  test('a single string works, and the fallback gets pageUrl too', async () => {
    const fallback = fresh('guarded');
    const res = await add({ url: fresh('missing'), fallbackUrls: fallback, pageUrl: PAGE });
    assert.equal(res.status, 201);
    const item = await app.item(res.data.items[0].id);
    assert.equal(item.mediaUrl, fallback);
    assert.equal(item.url, PAGE);
  });

  test('when everything fails, the main URL error is reported', async () => {
    const main = fresh('missing');
    const res = await add({ url: main, fallbackUrls: [fresh('guarded')] });
    assert.equal(res.status, 502);
    assert.equal(res.data.job.failed, 1);
    assert.match(res.data.error, /HTTP 404/);
    assert.doesNotMatch(res.data.error, /403/);
  });

  test('an already-saved main URL is skipped without trying fallbacks', async () => {
    const main = fresh('ok');
    await add({ url: main });
    const fallback = fresh('ok');
    const res = await add({ url: main, fallbackUrls: [fallback] });
    assert.equal(res.data.skipped, 1);
    assert.equal(res.data.created, 0);
    // the fallback was never imported
    const again = await add({ url: fallback });
    assert.equal(again.data.created, 1);
  });

  test('are ignored when several links are sent', async () => {
    const res = await add({ urls: [fresh('missing'), fresh('ok')], fallbackUrls: [fresh('ok')] });
    assert.equal(res.data.job.total, 2);
    assert.equal(res.data.created, 1);
    assert.equal(res.data.failed, 1);
  });

  test('an invalid fallback URL is a 400', async () => {
    assert.equal((await add({ url: fresh('ok'), fallbackUrls: ['ftp://x/y.png'] })).status, 400);
  });
});

describe('pageUrl on uploads', () => {
  const upload = (fields) => {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'shot.png');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return app.call('POST', '/api/add', form);
  };

  test('is stored as url, with no mediaUrl', async () => {
    const res = await upload({ pageUrl: PAGE });
    assert.equal(res.status, 201);
    const item = await app.item(res.data.items[0].id);
    assert.equal(item.url, PAGE);
    assert.equal(item.mediaUrl, null);
  });

  test('url still wins and keeps its mediaUrl', async () => {
    const image = fresh('ok');
    const res = await upload({ url: image, pageUrl: PAGE });
    const item = await app.item(res.data.items[0].id);
    assert.equal(item.url, image);
    assert.equal(item.mediaUrl, image);
  });

  test('an invalid pageUrl is a 400', async () => {
    assert.equal((await upload({ pageUrl: 'file:///etc/passwd' })).status, 400);
  });
});
