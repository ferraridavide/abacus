import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import AdmZip from 'adm-zip';
import { PNG, startAbacus, startFixture } from './helpers.js';

let app;
let fixture;
let call;

before(async () => {
  fixture = await startFixture();
  app = await startAbacus();
  call = app.call;
});

after(async () => {
  await app?.stop();
  await fixture?.close();
});

const page = (title) => `${fixture.url}/page/${encodeURIComponent(title)}`;
const pic = (name) => `${fixture.url}/pic/${name}.png`;

function arenaZip(id = 1) {
  const zip = new AdmZip();
  zip.addFile('moodboard-abc12345xyz.csv', Buffer.from(`ID,Filename,Title,Description,Created At,Updated At,Source\n${id},one.png,First block,,,,\n`));
  zip.addFile('one.png', PNG);
  return zip.toBuffer();
}

describe('adding links', () => {
  test('imports an image URL into a folder created by name', async () => {
    const { status, data } = await call('POST', '/api/add', { url: pic('a'), folder: 'API Inbox', tags: ['api', 'test'] });
    assert.equal(status, 201, JSON.stringify(data));
    assert.equal(data.ok, true);
    assert.equal(data.created, 1);
    const item = data.items[0];
    assert.equal(item.source, 'web');
    assert.deepEqual(item.tags.sort(), ['api', 'test']);
    assert.ok(item.thumbUrl);
    const folders = await app.folders();
    assert.ok(folders.some((f) => f.name === 'API Inbox' && f.id === item.folders[0]));
  });

  test('the same URL twice is skipped, not duplicated', async () => {
    await call('POST', '/api/add', { url: pic('dup') });
    const { status, data } = await call('POST', '/api/add', { url: pic('dup') });
    assert.equal(status, 200, JSON.stringify(data));
    assert.deepEqual([data.created, data.skipped], [0, 1]);
  });

  test('name and notes are applied to a newly imported link', async () => {
    const { status, data } = await call('POST', '/api/add', { url: page('Page title'), name: 'My title', notes: 'why I saved it' });
    assert.equal(status, 201, JSON.stringify(data));
    assert.equal(data.items[0].name, 'My title');
    assert.equal(data.items[0].notes, 'why I saved it');
  });

  test('saving again never overwrites the notes of an item already in the library', async () => {
    const first = await call('POST', '/api/add', { url: page('Kept notes'), notes: 'first' });
    const id = first.data.items[0].id;
    await call('PATCH', '/api/items/' + id, { notes: 'written in the app' }, { as: 'basic' });

    const again = await call('POST', '/api/add', { url: page('Kept notes'), name: 'Renamed?', notes: 'from the popup' });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.skipped, 1);
    assert.match(again.data.warnings.join(), /notes were not changed/);
    const item = await app.item(id);
    assert.equal(item.notes, 'written in the app');
    assert.equal(item.name, 'Kept notes');
  });

  test('async imports still get their name and notes when the job finishes', async () => {
    const { status, data } = await call('POST', '/api/add', { url: page('Async page'), name: 'Async title', notes: 'async note', async: true });
    assert.equal(status, 202, JSON.stringify(data));
    const job = await app.waitForJob(data.job.id);
    assert.equal(job.imported, 1);
    const item = await app.item(job.entries[0].itemIds[0]);
    assert.equal(item.name, 'Async title');
    assert.equal(item.notes, 'async note');
  });

  test('a name is ignored when several links are added at once', async () => {
    const { data } = await call('POST', '/api/add', { urls: [page('Many one'), page('Many two')], name: 'Shared' });
    assert.deepEqual(data.items.map((i) => i.name).sort(), ['Many one', 'Many two']);
  });

  test('a failed import is an error, with the reason', async () => {
    const { status, data } = await call('POST', '/api/add', { url: fixture.url + '/missing' });
    assert.equal(status, 502, JSON.stringify(data));
    assert.equal(data.ok, false);
    assert.equal(data.failed, 1);
    assert.match(data.error, /404/);
  });

  test('only http(s) links are accepted', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi']) {
      const { status, data } = await call('POST', '/api/add', { url });
      assert.equal(status, 400, url);
      assert.match(data.error, /http/);
    }
  });
});

describe('adding notes', () => {
  test('text without links becomes a note', async () => {
    const { status, data } = await call('POST', '/api/add', { name: 'A note', text: 'Remember this', notes: 'n', tags: 'one, two' });
    assert.equal(status, 201, JSON.stringify(data));
    const item = data.items[0];
    assert.deepEqual([item.type, item.source, item.url], ['bookmark', 'api', null]);
    assert.deepEqual(item.tags.sort(), ['one', 'two']);
  });

  test('nothing to add is a 400 with a clear message', async () => {
    const { status, data } = await call('POST', '/api/add', {});
    assert.equal(status, 400);
    assert.match(data.error, /Nothing to add/);
  });

  test('linksOnly refuses text without links instead of making a note', async () => {
    const { status, data } = await call('POST', '/api/add', { text: 'file:///Users/me/doc.pdf', linksOnly: true, async: true });
    assert.equal(status, 400);
    assert.equal(data.error, 'No links found');
  });
});

describe('folders', () => {
  test('a folder path targets nested folders and does not duplicate them', async () => {
    const parent = await call('POST', '/api/folders', { name: 'Design' }, { as: 'basic' });
    const child = await call('POST', '/api/folders', { name: 'Logos', parentId: parent.data.id }, { as: 'basic' });
    const { data } = await call('POST', '/api/add', { name: 'n', text: 'into Logos', folder: 'Design / Logos' });
    assert.equal(data.items[0].folders[0], child.data.id);
    assert.equal((await app.folders()).filter((f) => f.name === 'Logos').length, 1);
  });

  test('missing folders along a path are created', async () => {
    const { data } = await call('POST', '/api/add', { name: 'n', text: 't', folder: 'Trips/2026/Rome' });
    const folders = await app.folders();
    const rome = folders.find((f) => f.id === data.items[0].folders[0]);
    const y2026 = folders.find((f) => f.id === rome.parentId);
    const trips = folders.find((f) => f.id === y2026.parentId);
    assert.deepEqual([rome.name, y2026.name, trips.name, trips.parentId], ['Rome', '2026', 'Trips', null]);
  });

  test('a deleted folderId saves without a folder and warns', async () => {
    const { status, data } = await call('POST', '/api/add', { name: 'n', text: 't', folderId: 'deleted-folder' });
    assert.equal(status, 201, JSON.stringify(data));
    assert.deepEqual(data.items[0].folders, []);
    assert.match(data.warnings.join(), /no longer exists/);
  });

  test('a deleted folderId falls back to the folder name when one is sent', async () => {
    const { data } = await call('POST', '/api/add', { name: 'n', text: 't', folderId: 'deleted-folder', folder: 'Fallback' });
    const folder = (await app.folders()).find((f) => f.id === data.items[0].folders[0]);
    assert.equal(folder.name, 'Fallback');
  });

  test('an unknown parentId is a 400, not a server error', async () => {
    const { status, data } = await call('POST', '/api/add', { name: 'n', text: 't', folder: 'New', parentId: 'nope' });
    assert.equal(status, 400);
    assert.equal(data.error, 'Parent folder not found');
  });
});

describe('files', () => {
  test('multipart uploads are stored', async () => {
    const form = new FormData();
    form.append('folder', 'Uploads');
    form.append('tags', 'upload,test');
    form.append('notes', 'a pixel');
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'pixel.png');
    const { status, data } = await call('POST', '/api/add', form);
    assert.equal(status, 201, JSON.stringify(data));
    const item = data.items[0];
    assert.deepEqual([item.type, item.source, item.name, item.notes], ['image', 'upload', 'pixel', 'a pixel']);
  });

  test('an Are.na export becomes folders through /api/add', async () => {
    const form = new FormData();
    form.append('folder', 'Imports');
    form.append('file', new Blob([arenaZip()], { type: 'application/zip' }), 'moodboard.zip');
    const { status, data } = await call('POST', '/api/add', form);
    assert.equal(status, 202, JSON.stringify(data));
    const job = await app.waitForJob(data.job.id);
    assert.equal(job.imported, 1);
    const folders = await app.folders();
    const channel = folders.find((f) => f.name === 'moodboard');
    assert.equal(folders.find((f) => f.id === channel.parentId).name, 'Imports');
  });

  test('any other zip is stored as a file', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('PK not arena')], { type: 'application/zip' }), 'notes.zip');
    const { status, data } = await call('POST', '/api/add', form);
    assert.equal(status, 201, JSON.stringify(data));
    assert.equal(data.items[0].type, 'file');
  });

  test('Are.na tags and notes apply to new blocks and leave existing blocks unchanged', async () => {
    const upload = () => {
      const form = new FormData();
      form.append('tags', '["inspiration", "design", "design"]');
      form.append('notes', 'From the API');
      form.append('file', new Blob([arenaZip(2)]), 'metadata.zip');
      return form;
    };
    const first = await call('POST', '/api/add', upload());
    assert.equal(first.status, 202);
    const job = await app.waitForJob(first.data.job.id);
    assert.equal(job.imported, 1);
    const id = job.entries[0].itemIds[0];
    const item = await app.item(id);
    assert.equal(item.notes, 'From the API');
    assert.deepEqual(item.tags, ['design', 'inspiration']);

    await call('PATCH', '/api/items/' + id, { notes: 'Edited later', tags: ['kept'] }, { as: 'basic' });
    const again = await call('POST', '/api/add', upload());
    const skipped = await app.waitForJob(again.data.job.id);
    assert.deepEqual([skipped.imported, skipped.skipped], [0, 1]);
    const kept = await app.item(id);
    assert.equal(kept.notes, 'Edited later');
    assert.deepEqual(kept.tags, ['kept']);
  });

  test('a multipart request without a file says so', async () => {
    const form = new FormData();
    form.append('name', 'no file');
    const { status, data } = await call('POST', '/api/add', form);
    assert.equal(status, 400);
    assert.equal(data.error, 'No file');
  });
});

describe('legacy routes used by older clients', () => {
  test('/api/import returns a job', async () => {
    const { status, data } = await call('POST', '/api/import', { text: page('Legacy import') }, { as: 'basic' });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal((await app.waitForJob(data.id)).imported, 1);
  });

  test('/api/import rejects text without links', async () => {
    const { status } = await call('POST', '/api/import', { text: 'no links here' }, { as: 'basic' });
    assert.equal(status, 400);
  });

  test('/api/upload returns the item', async () => {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'legacy.png');
    const { status, data } = await call('POST', '/api/upload', form, { as: 'basic' });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.name, 'legacy');
  });

  test('/api/upload stores Are.na exports without importing their blocks', async () => {
    const foldersBefore = await app.folders();
    const form = new FormData();
    // The compatibility route must retain file-upload behavior even when auto import is requested.
    form.append('arena', 'auto');
    const zip = arenaZip(777);
    form.append('file', new Blob([zip], { type: 'application/zip' }), 'legacy-export.zip');
    const { status, data } = await call('POST', '/api/upload', form, { as: 'basic' });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.type, 'file');
    assert.equal(data.ext, 'zip');
    assert.equal(data.size, zip.length);
    assert.deepEqual(await app.folders(), foldersBefore);
    const response = await fetch(app.baseUrl + data.fileUrl, {
      headers: { authorization: 'Basic ' + Buffer.from('abacus:secret').toString('base64') },
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), zip);
  });

  test('/api/import/arena imports an export and answers 422 for other zips', async () => {
    const good = new FormData();
    good.append('file', new Blob([arenaZip()]), 'export.zip');
    const ok = await call('POST', '/api/import/arena', good, { as: 'basic' });
    assert.ok(ok.data.id, JSON.stringify(ok.data));

    const bad = new FormData();
    bad.append('file', new Blob([Buffer.from('nope')]), 'other.zip');
    const res = await call('POST', '/api/import/arena', bad, { as: 'basic' });
    assert.equal(res.status, 422);
  });
});
