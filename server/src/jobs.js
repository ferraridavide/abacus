import { config } from './config.js';
import { newId, mapLimit } from './util.js';
import { extractTweets, importTweet } from './importers/x.js';
import { extractUrls, importUrl } from './importers/web.js';
import { ensureFolder, importBlock } from './importers/arena.js';
import { importWithProviders } from './providers/index.js';

const jobs = new Map();
const MAX_JOBS = 50;

/** Turn pasted text (any mix of X links and other URLs) into import targets. */
export function parseTargets(text) {
  const targets = [];
  const seen = new Set();
  const tweets = extractTweets(text);
  for (const t of tweets) {
    if (seen.has('x:' + t.id)) continue;
    seen.add('x:' + t.id);
    targets.push({ kind: 'x', id: t.id, label: t.match.replace(/^https?:\/\//, '') });
  }
  const tweetMatches = new Set(tweets.map((t) => t.match.replace(/^https?:\/\//, '')));
  for (const url of extractUrls(text)) {
    const bare = url.replace(/^https?:\/\//, '');
    if ([...tweetMatches].some((m) => bare.startsWith(m))) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    targets.push({ kind: 'url', url, label: bare });
  }
  return targets;
}

/**
 * Run `work(target)` for each target in the background and track progress.
 * `work` resolves to [{ status: 'imported', item } | { status: 'skipped', id }].
 * Returns the live job (safe to poll / serialize) and a promise that resolves with
 * it once every target has been processed. The promise never rejects: unexpected
 * failures are recorded on `job.error` so fire-and-forget callers stay quiet.
 */
function createJob(targets, work, { onDone } = {}) {
  const job = {
    id: newId(),
    status: targets.length ? 'running' : 'done',
    createdAt: Date.now(),
    total: targets.length,
    done: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    entries: targets.map((t) => ({ label: t.label, kind: t.kind, state: 'pending', error: null, itemIds: [] })),
  };
  // Ids of the items this job created (not ones that were already in the library). Kept off the job object,
  // which is sent to clients as-is.
  const createdIds = [];
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);

  const done = (async () => {
    try {
      await mapLimit(targets, config.importConcurrency, async (t, i) => {
        const entry = job.entries[i];
        entry.state = 'running';
        try {
          const results = await work(t);
          for (const r of results) {
            if (r.status === 'imported') {
              job.imported++;
              entry.itemIds.push(r.item.id);
              createdIds.push(r.item.id);
            } else {
              job.skipped++;
              entry.itemIds.push(r.id);
            }
          }
          entry.state = results.every((r) => r.status === 'skipped') ? 'skipped' : 'done';
        } catch (err) {
          job.failed++;
          entry.state = 'error';
          entry.error = err.message;
        } finally {
          job.done++;
        }
      });
    } catch (err) {
      job.error = err.message;
    } finally {
      job.status = 'done';
      job.finishedAt = Date.now();
      try {
        onDone?.();
      } catch {
        /* cleanup is best-effort */
      }
    }
    return job;
  })();

  return { job, done, createdIds };
}

/** Import a non-X link: through an import provider that supports the site, else as a direct file or web page. */
async function importLink(url, opts) {
  return (await importWithProviders(url, opts)) || importUrl(url, opts);
}

/**
 * Start a tracked import for already-parsed targets. `onDone(job, createdIds)` runs once every target has been
 * processed, also when the caller doesn't wait for the job.
 */
export function startTargets(targets, { folderIds = [], tags = [], onDone } = {}) {
  const run = createJob(
    targets,
    (t) => (t.kind === 'x' ? importTweet(t.id, { folderIds, tags }) : importLink(t.url, { folderIds, tags })),
    { onDone: () => onDone?.(run.job, run.createdIds) }
  );
  return run;
}

/** Import an Are.na export; each channel becomes a folder (under `parentId` if given). */
export function startArenaImport(channels, { parentId = null, onDone } = {}) {
  const targets = [];
  for (const ch of channels) {
    const folder = ensureFolder(ch.name, parentId);
    for (const block of ch.blocks) {
      targets.push({ kind: 'arena', block, folderId: folder.id, label: block.title || block.filename || `Block ${block.id}` });
    }
  }
  return createJob(targets, (t) => importBlock(t.block, { folderIds: [t.folderId] }), { onDone }).job;
}

export const getJob = (id) => jobs.get(id) || null;
