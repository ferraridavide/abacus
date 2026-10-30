import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { getConfig, setConfig } from '../../extensions/chrome/lib.js';

test('context menus and shortcuts are opt-in and retain preferences across startup', async (t) => {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, previous));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let tabQueries = 0;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, payload: JSON.parse(options.body) });
    return Response.json({ created: 1 });
  };
  const stored = { config: { serverUrl: 'https://abacus.example', token: 'secret', folder: 'Inbox' } };
  const listeners = {};
  const menus = new Map();
  const errors = [];
  const event = (name) => ({ addListener: (listener) => { listeners[name] = listener; } });
  globalThis.chrome = {
    runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
    storage: {
      onChanged: event('changed'),
      local: {
        get: async (key) => structuredClone(key === null ? stored : { [key]: stored[key] }),
        set: async (values) => {
          const oldValue = structuredClone(stored.config);
          Object.assign(stored, structuredClone(values));
          listeners.changed({ config: { oldValue, newValue: stored.config } }, 'local');
        },
      },
    },
    contextMenus: {
      removeAll: async () => { await setImmediate(); menus.clear(); },
      create: (menu) => {
        assert.ok(!menus.has(menu.id), `Duplicate menu: ${menu.id}`);
        menus.set(menu.id, menu);
      },
      onClicked: event('clicked'),
    },
    alarms: { onAlarm: event('alarm') },
    commands: { onCommand: event('command') },
    tabs: { query: async () => { tabQueries++; return [{ url: 'https://example.com', title: 'Example' }]; } },
    notifications: { create: async (notification) => errors.push(notification) },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
  };
  await import('../../extensions/chrome/background.js');
  const waitForMenus = async (count) => {
    for (let i = 0; i < 20; i++) {
      await setImmediate();
      if (menus.size === count) return;
    }
    assert.equal(menus.size, count);
  };

  assert.equal((await getConfig()).contextMenuEnabled, false);
  assert.equal((await getConfig()).keyboardShortcutEnabled, false);
  listeners.installed({ reason: 'update' });
  for (let i = 0; i < 5; i++) await setImmediate();
  assert.equal(menus.size, 0);
  await listeners.command('save-page');
  assert.equal(tabQueries, 0);
  assert.deepEqual(requests, []);

  // Honor explicitly saved preferences from the earlier page-menu setting.
  stored.config.pageContextMenuEnabled = true;
  assert.equal((await getConfig()).contextMenuEnabled, true);
  delete stored.config.pageContextMenuEnabled;
  await setConfig({ contextMenuEnabled: true });
  await waitForMenus(4);
  assert.equal(menus.get('abacus-page').title, 'Save to Abacus');

  await setConfig({ contextMenuEnabled: false });
  await waitForMenus(0);
  assert.equal(menus.has('abacus-page'), false);
  assert.deepEqual([...menus.keys()], []);
  assert.equal(stored.config.token, 'secret');
  assert.equal(stored.config.folder, 'Inbox');

  menus.clear();
  listeners.startup();
  await waitForMenus(0);
  assert.equal(menus.has('abacus-page'), false);
  await setConfig({ tags: 'design' });
  assert.equal((await getConfig()).contextMenuEnabled, false);

  // Rapid changes and browser startup must not race menu creation.
  await setConfig({ contextMenuEnabled: true });
  listeners.startup();
  await setConfig({ contextMenuEnabled: false });
  await setConfig({ contextMenuEnabled: true });
  await waitForMenus(4);
  for (let i = 0; i < 10; i++) await setImmediate();
  assert.equal(menus.size, 4);
  assert.equal(menus.get('abacus-page').title, 'Save to Abacus');
  assert.deepEqual(errors, []);

  await setConfig({ keyboardShortcutEnabled: true });
  await listeners.command('save-page');
  assert.equal(tabQueries, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.url, 'https://example.com');
  await setConfig({ keyboardShortcutEnabled: false });
  listeners.startup();
  await listeners.command('save-page');
  assert.equal(tabQueries, 1);
  assert.equal(requests.length, 1);
  assert.equal((await getConfig()).contextMenuEnabled, true);

  await Promise.all([
    setConfig({ contextMenuEnabled: false }),
    setConfig({ keyboardShortcutEnabled: true }),
  ]);
  assert.equal((await getConfig()).contextMenuEnabled, false);
  assert.equal((await getConfig()).keyboardShortcutEnabled, true);

  const manifest = JSON.parse(await readFile(new URL('../../extensions/chrome/manifest.json', import.meta.url)));
  assert.equal(manifest.commands['save-page'].suggested_key, undefined);
});
