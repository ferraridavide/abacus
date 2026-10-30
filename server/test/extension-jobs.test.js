import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImportTracker } from '../../extensions/chrome/pending-jobs.js';
import { POLL_LIMIT_MS } from '../../extensions/chrome/lib.js';

const config = { serverUrl: 'https://abacus.example', token: 'original-token' };
const running = (id) => ({ id, status: 'running', imported: 0, skipped: 0, failed: 0, entries: [] });
const completed = (id) => ({ ...running(id), status: 'done', imported: 1 });
const data = (id) => ({ pending: true, warnings: ['Folder warning'], job: running(id) });

function setup(t) {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, previous));
  const stored = {};
  const alarms = new Map();
  const jobs = new Map();
  const requests = [];
  const finished = [];
  const errors = [];
  const scheduled = [];

  globalThis.chrome = {
    storage: { local: {
      get: async (key) => structuredClone(key === null ? stored : { [key]: stored[key] }),
      set: async (values) => Object.assign(stored, structuredClone(values)),
      remove: async (key) => { delete stored[key]; },
    } },
    alarms: {
      get: async (name) => alarms.get(name),
      create: async (name, options) => { alarms.set(name, options); scheduled.push(name); },
      clear: async (name) => alarms.delete(name),
    },
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const job = jobs.get(new URL(url).pathname.split('/').pop());
    if (job instanceof Error) throw job;
    return Response.json(job, { status: job.httpStatus || 200 });
  };
  const tracker = () => createImportTracker({
    onComplete: async (result) => finished.push(result),
    onError: async (error) => errors.push(error.message),
  });
  return { stored, alarms, jobs, requests, finished, errors, scheduled, tracker };
}

test('a fresh worker resumes stored imports and recreates missing alarms', async (t) => {
  const h = setup(t);
  h.jobs.set('one', running('one'));
  const originalConfig = { ...config };
  await h.tracker().track(data('one'), originalConfig);
  assert.equal(h.finished.length, 0);
  assert.equal(Object.keys(h.stored).length, 1);
  assert.equal(h.alarms.size, 1);

  originalConfig.serverUrl = 'https://other.example';
  originalConfig.token = 'changed-token';
  h.alarms.clear(); // Chrome may clear alarms on a browser restart.
  h.jobs.set('one', completed('one'));
  await h.tracker().resume();

  assert.equal(h.scheduled.length, 2);
  assert.equal(h.finished.length, 1);
  assert.equal(h.finished[0].created, 1);
  assert.deepEqual(h.finished[0].warnings, ['Folder warning']);
  assert.equal(h.requests.at(-1).url, config.serverUrl + '/api/jobs/one');
  assert.equal(h.requests.at(-1).options.headers.authorization, 'Bearer original-token');
  assert.ok(h.requests.every(({ options }) => !options.method || options.method === 'GET'));
  assert.deepEqual(h.stored, {});
  assert.equal(h.alarms.size, 0);
});

test('concurrent saves survive restart without losing either pending job', async (t) => {
  const h = setup(t);
  h.jobs.set('one', running('one'));
  h.jobs.set('two', running('two'));
  const tracker = h.tracker();
  await Promise.all([tracker.track(data('one'), config), tracker.track(data('two'), config)]);
  assert.equal(Object.keys(h.stored).length, 2);
  h.jobs.set('one', completed('one'));
  h.jobs.set('two', completed('two'));
  await h.tracker().resume();
  assert.deepEqual(h.finished.map((result) => result.job.id).sort(), ['one', 'two']);
  assert.deepEqual(h.stored, {});
});

test('temporary network and server errors retain jobs for a later alarm', async (t) => {
  const h = setup(t);
  h.jobs.set('one', new Error('Network offline'));
  const tracker = h.tracker();
  await tracker.track(data('one'), config);
  assert.equal(h.alarms.size, 1);
  h.jobs.set('one', { httpStatus: 503, error: 'Unavailable' });
  await tracker.resume();
  assert.equal(Object.keys(h.stored).length, 1);
  assert.deepEqual(h.errors, []);
  h.jobs.set('one', completed('one'));
  await tracker.resume();
  assert.equal(h.finished.length, 1);
});

test('failed imports notify once and remove their alarm and stored job', async (t) => {
  const h = setup(t);
  h.jobs.set('one', running('one'));
  await h.tracker().track(data('one'), config);
  h.jobs.set('one', { ...running('one'), status: 'done', failed: 1, entries: [{ error: 'HTTP 404' }] });
  const restarted = h.tracker();
  await restarted.resume();
  await restarted.resume();
  assert.deepEqual(h.errors, ['HTTP 404']);
  assert.deepEqual(h.stored, {});
  assert.equal(h.alarms.size, 0);
});

test('expired imports time out across worker restarts', async (t) => {
  const h = setup(t);
  h.jobs.set('one', running('one'));
  await h.tracker().track(data('one'), config);
  Object.values(h.stored)[0].startedAt = Date.now() - POLL_LIMIT_MS - 1;
  await h.tracker().resume();
  assert.match(h.errors[0], /15 minutes/);
  assert.deepEqual(h.stored, {});
  assert.equal(h.alarms.size, 0);
});

test('missing server jobs fail clearly instead of polling forever', async (t) => {
  const h = setup(t);
  h.jobs.set('one', { httpStatus: 404, error: 'Not found' });
  await h.tracker().track(data('one'), config);
  assert.deepEqual(h.errors, ['Not found']);
  assert.deepEqual(h.stored, {});
  assert.equal(h.alarms.size, 0);
});

test('the background entry point accepts popup jobs and resumes them in a fresh worker', async (t) => {
  const h = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = {};
  const event = (name) => ({ addListener: (listener) => { listeners[name] = listener; } });
  const notices = [];
  const badges = [];
  let resolveNotice;
  const notified = new Promise((resolve) => { resolveNotice = resolve; });
  Object.assign(chrome, {
    runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
    contextMenus: { onClicked: event('menu') },
    commands: { onCommand: event('command') },
    notifications: { create: async (notice) => { notices.push(notice); resolveNotice(); } },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async (badge) => badges.push(badge.text) },
  });
  chrome.alarms.onAlarm = event('alarm');
  chrome.storage.onChanged = event('storage');
  h.jobs.set('popup', running('popup'));
  await import('../../extensions/chrome/background.js?worker=first');
  const response = await new Promise((respond) => {
    assert.equal(listeners.message({ type: 'track-import', data: data('popup'), config }, {}, respond), true);
  });
  assert.deepEqual(response, { ok: true });
  assert.equal(h.alarms.size, 1);

  h.jobs.set('popup', completed('popup'));
  await import('../../extensions/chrome/background.js?worker=restarted');
  await notified;
  await new Promise(setImmediate);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /1 saved/);
  assert.deepEqual(badges, ['✓']);
  assert.deepEqual(h.stored, {});
  assert.equal(h.alarms.size, 0);
});
