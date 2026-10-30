import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { PNG, startAbacus } from './helpers.js';

let app;
let fixture;
let baseUrl;

const GIF = Buffer.from(
  '47494638396101000100800000ff000000ff0021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b',
  'hex'
);

const pages = {
  '/open-graph': '<meta property="og:image" content="/preview.png">',
  '/twitter': '<meta name="twitter:image" content="/preview.png">',
  '/animated-preview': '<meta property="og:image" content="/preview.gif">',
  '/no-preview': '',
  '/broken-preview': '<meta property="og:image" content="/missing.png">',
  '/invalid-preview': '<meta property="og:image" content="/invalid.png">',
  '/page.mp4': '<meta property="og:image" content="/preview.png">',
};

before(async () => {
  fixture = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/preview.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    if (pathname === '/preview.gif') {
      res.writeHead(200, { 'content-type': 'image/gif' });
      return res.end(GIF);
    }
    if (pathname === '/invalid.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end('not an image');
    }
    if (pathname === '/clip.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end('video fixture');
    }
    if (pathname in pages) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(
        '<title>A website</title><meta name="description" content="Page description">' + pages[pathname]
      );
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${fixture.address().port}`;
  app = await startAbacus();
});

after(async () => {
  await app?.stop();
  if (fixture) await new Promise((resolve) => fixture.close(resolve));
});

describe('webpage imports', () => {
  for (const pathname of Object.keys(pages)) {
    test(`${pathname} is saved as a bookmark`, async () => {
      const url = baseUrl + pathname;
      const { status, data } = await app.call('POST', '/api/add', { url, tags: ['website'] });
      assert.equal(status, 201, JSON.stringify(data));
      const item = await app.item(data.items[0].id);
      assert.equal(item.type, 'bookmark');
      assert.equal(item.source, 'web');
      assert.equal(item.url, url);
      assert.equal(item.mediaUrl, url);
      assert.equal(item.name, 'A website');
      assert.equal(item.description, 'Page description');
      assert.deepEqual(item.tags, ['website']);

      if (['/open-graph', '/twitter', '/animated-preview', '/page.mp4'].includes(pathname)) {
        assert.ok(item.thumbUrl, 'the bookmark keeps its preview');
        assert.equal(item.width, 1);
        assert.equal(item.height, 1);
        const preview = await fetch(app.baseUrl + item.thumbUrl, {
          headers: { authorization: 'Basic ' + Buffer.from('abacus:secret').toString('base64') },
        });
        assert.equal(preview.status, 200);
        assert.match(preview.headers.get('content-type'), /image\/webp/);
      } else {
        assert.equal(item.thumbUrl, null);
      }
    });
  }

  test('background imports also save bookmarks with previews', async () => {
    const { status, data } = await app.call('POST', '/api/add', { url: baseUrl + '/open-graph?async', async: true });
    assert.equal(status, 202, JSON.stringify(data));
    const job = await app.waitForJob(data.job.id);
    assert.equal(job.imported, 1);
    const item = await app.item(job.entries[0].itemIds[0]);
    assert.equal(item.type, 'bookmark');
    assert.ok(item.thumbUrl);
  });
});

describe('direct media imports', () => {
  for (const [pathname, type] of [['/preview.png', 'image'], ['/preview.gif', 'gif'], ['/clip.mp4', 'video']]) {
    test(`${pathname} is still saved as ${type}`, async () => {
      const { status, data } = await app.call('POST', '/api/add', { url: baseUrl + pathname });
      assert.equal(status, 201, JSON.stringify(data));
      assert.equal(data.items[0].type, type);
      assert.ok(data.items[0].fileUrl);
    });
  }
});
