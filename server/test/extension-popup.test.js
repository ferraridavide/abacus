import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

test('popup stays offline until save and allows retry after a failed request', async (t) => {
  const previous = { chrome: globalThis.chrome, document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, previous));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = {};
  const elements = new Map();
  for (const id of ['folder', 'tags', 'open-app', 'save', 'url', 'name', 'notes', 'form', 'options', 'url-error', 'notes-error']) {
    elements.set(id, {
      value: '', disabled: id === 'save', hidden: true, dataset: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      focus() { this.focused = true; },
      addEventListener: (event, callback) => { listeners[`${id}:${event}`] = callback; },
    });
  }
  const requests = [];
  const opened = [];
  let failRequest = true;
  globalThis.document = { getElementById: (id) => elements.get(id) };
  globalThis.window = { close: () => {} };
  globalThis.chrome = {
    storage: { local: { get: async () => ({ config: { serverUrl: 'https://library.example', token: 'test-token', folder: 'Inbox' } }) } },
    tabs: {
      query: async () => [{ url: 'https://example.com', title: 'Example page' }],
      create: async (options) => opened.push(options.url),
    },
    runtime: { openOptionsPage: () => {} },
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (failRequest) throw new Error('Offline');
    return Response.json({ created: 1 });
  };
  await import('../../extensions/chrome/popup.js');
  await setImmediate();
  assert.equal(elements.get('url').value, 'https://example.com');
  assert.equal(elements.get('folder').value, 'Inbox');
  assert.equal(elements.get('save').disabled, false);
  await listeners['open-app:click']();
  assert.deepEqual(opened, ['https://library.example']);
  assert.deepEqual(requests, []);

  elements.get('url').value = '';
  await listeners['form:submit']({ preventDefault() {} });
  assert.deepEqual(requests, [], 'invalid input must not contact the API');
  assert.equal(elements.get('url').attributes['aria-invalid'], 'true');
  assert.equal(elements.get('url').focused, true);
  elements.get('url').value = 'https://';
  await listeners['form:submit']({ preventDefault() {} });
  assert.equal(requests.length, 0);
  assert.match(elements.get('url-error').textContent, /valid http/);
  elements.get('url').value = '';
  elements.get('notes').value = 'A thought';
  await listeners['form:submit']({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(elements.get('save').disabled, false);
  assert.match(elements.get('notes-error').textContent, /Offline/);
  assert.equal(elements.get('notes-error').hidden, false);
  assert.equal(elements.get('save').attributes['aria-busy'], 'false');

  failRequest = false;
  await listeners['form:submit']({ preventDefault() {} });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ url, options }) => url.endsWith('/api/add') && options.method === 'POST'));
  assert.equal(JSON.parse(requests[1].options.body).notes, 'A thought');
  assert.equal(elements.get('save').textContent, 'Saved');
  assert.equal(elements.get('save').dataset.state, 'saved');
  assert.equal(elements.get('notes-error').hidden, true);
  listeners['form:input']();
  assert.equal(elements.get('save').disabled, false);
  assert.equal(elements.get('save').textContent, 'Save to Abacus');
});
