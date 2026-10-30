import { apiFetch, POLL_LIMIT_MS, resultFromJob } from './lib.js';

const PREFIX = 'pending-import:';

/** Each job has its own storage key and alarm so concurrent saves cannot overwrite one another. */
export function createImportTracker({ onComplete, onError }) {
  const checking = new Set();

  async function finish(name, result, error) {
    if (error) await onError(error);
    else await onComplete(result);
    await chrome.storage.local.remove(name);
    await chrome.alarms.clear(name);
  }

  async function poll(name) {
    if (!name.startsWith(PREFIX) || checking.has(name)) return;
    checking.add(name);
    try {
      const { [name]: pending } = await chrome.storage.local.get(name);
      if (!pending) return await chrome.alarms.clear(name);
      if (Date.now() - pending.startedAt > POLL_LIMIT_MS) {
        return await finish(name, null, new Error('Still importing after 15 minutes; check Abacus later.'));
      }
      let job;
      try {
        job = await apiFetch(pending.config, '/api/jobs/' + pending.data.job.id);
      } catch (err) {
        // Retry temporary network/server failures at the next alarm, without submitting the import again.
        if (err.status && err.status < 500) await finish(name, null, err);
        return;
      }
      if (job.status !== 'done') return;
      let result;
      try {
        result = resultFromJob(pending.data, job);
      } catch (err) {
        return await finish(name, null, err);
      }
      await finish(name, result);
    } finally {
      checking.delete(name);
    }
  }

  async function ensureAlarm(name) {
    if (!(await chrome.alarms.get(name))) {
      await chrome.alarms.create(name, { delayInMinutes: 1, periodInMinutes: 1 });
    }
  }

  async function track(data, config) {
    if (!data.job || data.job.status === 'done') {
      await onComplete(data.job ? resultFromJob(data, data.job) : data);
      return;
    }
    const name = PREFIX + data.job.id;
    // Preserve the original server and credentials even if the user changes extension settings mid-import.
    await chrome.storage.local.set({ [name]: { data, config, startedAt: Date.now() } });
    await ensureAlarm(name);
    await poll(name);
  }

  async function resume() {
    const stored = await chrome.storage.local.get(null);
    await Promise.all(Object.keys(stored).filter((name) => name.startsWith(PREFIX)).map(async (name) => {
      await ensureAlarm(name);
      await poll(name);
    }));
  }

  return { track, poll, resume };
}
