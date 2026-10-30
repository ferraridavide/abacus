import * as lib from './library.js';
import { addContent, addUpload } from './add.js';
import { getJob } from './jobs.js';
import { activeProviders, listProviderSettings, testProvider, updateProvider } from './providers/index.js';
import * as embeddings from './embeddings.js';

const notFound = (reply) => reply.code(404).send({ error: 'Not found' });

const notAnItem = () => {
  throw Object.assign(new Error('Are.na exports go to /api/add or /api/import/arena'), { statusCode: 400 });
};

/** The /api/add response: counts, the items (when finished), the job (for links), and any warnings. */
function addResponse({ job, items, warnings = [] }) {
  const created = job ? job.imported : items.length;
  const skipped = job ? job.skipped : 0;
  const failed = job ? job.failed : 0;
  const errors = job ? job.entries.filter((e) => e.error).map((e) => `${e.label}: ${e.error}`) : [];
  return {
    ok: failed === 0,
    pending: !!(job && job.status !== 'done'),
    created,
    skipped,
    failed,
    error: errors.length ? errors.join('; ') : undefined,
    warnings,
    items,
    job,
  };
}

export async function routes(app) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/bootstrap', async () => ({
    stats: lib.getStats(),
    folders: lib.listFolders(),
    tags: lib.listTags(),
  }));

  // ---------- items ----------
  const itemQuery = (q) => ({
    view: q.view,
    folderId: q.folderId,
    tag: q.tag,
    q: q.q,
    types: q.types ? String(q.types).split(',').filter(Boolean) : [],
    source: q.source,
    rating: q.rating,
    sort: q.sort,
    dir: q.dir,
    seed: q.seed,
    color: q.color,
    limit: q.limit,
    offset: q.offset,
  });
  app.get('/api/items', async (req) => lib.listItems(itemQuery(req.query)));
  app.get('/api/items/ids', async (req) => ({ ids: await lib.listItemIds(itemQuery(req.query)) }));

  app.get('/api/items/:id', async (req, reply) => lib.getItem(req.params.id) || notFound(reply));

  app.patch('/api/items/:id', async (req, reply) => {
    if (!lib.getItem(req.params.id)) return notFound(reply);
    return lib.updateItem(req.params.id, req.body || {});
  });

  // Whether the item has an embedding for semantic search; POST computes it again.
  app.get('/api/items/:id/embedding', async (req, reply) => embeddings.itemEmbedding(req.params.id) || notFound(reply));
  app.post('/api/items/:id/embedding', async (req, reply) => (await embeddings.reprocessItem(req.params.id)) || notFound(reply));

  app.post('/api/items/batch', async (req) => lib.batch(req.body || {}));

  app.delete('/api/trash', async () => lib.emptyTrash());

  app.get('/api/tags', async () => lib.listTags());

  // ---------- folders ----------
  app.get('/api/folders', async () => lib.listFolders());
  app.post('/api/folders', async (req) => lib.createFolder(req.body || {}));
  app.patch('/api/folders/:id', async (req) => lib.updateFolder(req.params.id, req.body || {}));
  app.delete('/api/folders/:id', async (req) => lib.deleteFolder(req.params.id));

  // ---------- add: the one content-ingestion API ----------
  // JSON: links, several URLs, or a note. Multipart: one file plus fields (Are.na exports become folders).
  // The web app, the bookmarklet, and the Chrome extension all add content through it.
  const handleAdd = async (req, reply) => {
    if (req.isMultipart()) {
      const { item, job, warnings } = await addUpload(req);
      if (job) return reply.code(202).send(addResponse({ job, items: [], warnings }));
      return reply.code(201).send(addResponse({ job: null, items: [item], warnings }));
    }
    const input = { ...(req.body || {}) };
    const queryAsync = req.query?.async;
    if (queryAsync && queryAsync !== 'false' && queryAsync !== '0') input.async = true;
    const result = await addContent(input);
    if (!result.job && !result.items.length) return reply.code(400).send({ error: 'No links found' });
    const body = addResponse(result);
    if (body.pending) return reply.code(202).send(body);
    // Nothing saved and nothing already there: the import failed, so answer with an error clients can't miss.
    if (body.failed && !body.created && !body.skipped) return reply.code(502).send(body);
    return reply.code(body.created ? 201 : 200).send(body);
  };
  app.post('/api/add', handleAdd);
  app.post('/api/v1/add', handleAdd);

  // ---------- legacy wrappers over /api/add, kept for older clients ----------
  app.post('/api/upload', async (req) => (await addUpload(req)).item ?? notAnItem());

  app.post('/api/import', async (req, reply) => {
    const { text, urls, folderId, folder, tags } = req.body || {};
    const result = await addContent({ text, urls, folderId, folder, tags, async: true, linksOnly: true });
    if (!result.job) return reply.code(400).send({ error: 'No links found' });
    return result.job;
  });

  // Responds 422 if the zip isn't an Are.na export, so the client can store it as a file instead.
  app.post('/api/import/arena', async (req) => (await addUpload(req, { arena: 'only' })).job);

  // Enabled import providers and the sites they add to link imports.
  app.get('/api/import/sources', async () => ({ providers: await activeProviders() }));

  app.get('/api/jobs/:id', async (req, reply) => getJob(req.params.id) || notFound(reply));

  // ---------- settings (import providers) ----------
  app.get('/api/settings/providers', async () => listProviderSettings());
  app.patch('/api/settings/providers/:id', async (req) => updateProvider(req.params.id, req.body || {}));
  // Checks the given (unsaved) values; missing values fall back to the saved ones.
  app.post('/api/settings/providers/:id/test', async (req) => testProvider(req.params.id, req.body?.values));

  // ---------- settings (semantic search embeddings) ----------
  app.get('/api/settings/embeddings', async () => embeddings.embeddingSettings());
  app.patch('/api/settings/embeddings', async (req) => embeddings.updateEmbeddings(req.body || {}));
  app.post('/api/settings/embeddings/test', async (req) => embeddings.testEmbeddings(req.body?.values));
  app.get('/api/embeddings/status', async () => embeddings.embeddingStatus());
  app.post('/api/embeddings/reprocess', async () => embeddings.reprocessAll());

  // ---------- bookmarklet landing page ----------
  app.get('/quick-add', async (req, reply) => {
    reply.type('text/html').send(QUICK_ADD_HTML);
  });
}

const QUICK_ADD_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Abacus · Saving…</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  html,body{margin:0;height:100%;background:#16171a;color:#e8e8ea;font:14px/1.4 -apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;box-sizing:border-box;text-align:center}
  .logo{font-size:44px;line-height:1}
  .msg{font-weight:600}.sub{color:#8b8d94;font-size:12px;word-break:break-all;max-width:360px}
  .spin{width:18px;height:18px;border:2px solid #333;border-top-color:#5b8cff;border-radius:50%;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap">
<div class="logo">🧮</div><div class="spin" id="spin"></div><div class="msg" id="msg">Saving to Abacus…</div><div class="sub" id="sub"></div>
</div><script>
(async () => {
  const p = new URLSearchParams(location.search);
  const url = p.get('url') || '';
  const $ = (id) => document.getElementById(id);
  $('sub').textContent = url;
  const done = (m, ok) => { $('spin').remove(); $('msg').textContent = m; if (ok) setTimeout(() => window.close(), 1400); };
  try {
    const r = await fetch('/api/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, folderId: p.get('folderId') || undefined, async: true, linksOnly: true }) });
    const data = await r.json();
    if (!r.ok) return done(data.error || 'Nothing to import');
    let job = data.job;
    if (!job) return done(data.items?.length ? '✓ Saved' : 'Nothing to import', true);
    while (job.status !== 'done') { await new Promise((res) => setTimeout(res, 600)); job = await (await fetch('/api/jobs/' + job.id)).json(); }
    if (job.failed) return done('Failed: ' + (job.entries.find((e) => e.error)?.error || 'unknown error'));
    done(job.imported ? '✓ Saved ' + job.imported + ' item' + (job.imported > 1 ? 's' : '') : 'Already in your library', true);
  } catch (e) { done('Error: ' + e.message); }
})();
</script></body></html>`;
