import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSuggestionSource, tagSegment } from '../../extensions/chrome/autocomplete.js';

test('suggestions load lazily, share in-flight requests, and reload for changed credentials', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const config = { serverUrl: 'https://library.example', token: 'first' };
  const requests = [];
  let fail = false;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (fail) throw new Error('Unavailable');
    return Response.json({ folders: [{ id: 'parent', name: 'Design' }, { id: 'child', parentId: 'parent', name: 'Logos' }], tags: ['art'] });
  };
  const source = createSuggestionSource(() => config);
  assert.equal(requests.length, 0);
  const [folders, tags] = await Promise.all([source(), source()]);
  assert.deepEqual(folders.folders, ['Design', 'Design / Logos']);
  assert.deepEqual(tags.tags, ['art']);
  assert.equal(requests.length, 1);
  await source();
  assert.equal(requests.length, 1);
  config.token = 'second';
  await source();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers.authorization, 'Bearer second');
  config.serverUrl = 'https://other.example';
  fail = true;
  await assert.rejects(source(), /Cannot reach/);
  fail = false;
  await source();
  assert.equal(requests.length, 4, 'failed suggestions can be retried');
  assert.ok(requests.every(({ url }) => url.endsWith('/api/autocomplete')));
  config.serverUrl = '';
  await assert.rejects(source(), /Configure and save/);
  assert.equal(requests.length, 4, 'unconfigured autocomplete stays offline');
});

test('tag completion isolates the token at the caret, including middle tokens', () => {
  assert.deepEqual(tagSegment({ value: 'art, des, photo', selectionStart: 7 }), { start: 4, end: 8, query: 'des' });
  assert.deepEqual(tagSegment({ value: 'art, ', selectionStart: 5 }), { start: 4, end: 5, query: '' });
  assert.deepEqual(tagSegment({ value: '', selectionStart: 0 }), { start: 0, end: 0, query: '' });
});
