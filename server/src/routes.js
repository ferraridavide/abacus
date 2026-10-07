import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { paths } from './config.js';
import { newId, VIDEO_EXTS } from './util.js';
import * as lib from './library.js';
import { startImport, startArenaImport, getJob } from './jobs.js';
import { readArenaZip } from './importers/arena.js';

const notFound = (reply) => reply.code(404).send({ error: 'Not found' });

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
  app.get('/api/items/ids', async (req) => ({ ids: lib.listItemIds(itemQuery(req.query)) }));

  app.get('/api/items/:id', async (req, reply) => lib.getItem(req.params.id) || notFound(reply));

  app.patch('/api/items/:id', async (req, reply) => {
    if (!lib.getItem(req.params.id)) return notFound(reply);
    return lib.updateItem(req.params.id, req.body || {});
  });

  app.post('/api/items/batch', async (req) => lib.batch(req.body || {}));

  app.delete('/api/trash', async () => lib.emptyTrash());

  app.get('/api/tags', async () => lib.listTags());

  // ---------- folders ----------
  app.get('/api/folders', async () => lib.listFolders());
  app.post('/api/folders', async (req) => lib.createFolder(req.body || {}));
  app.patch('/api/folders/:id', async (req) => lib.updateFolder(req.params.id, req.body || {}));
  app.delete('/api/folders/:id', async (req) => lib.deleteFolder(req.params.id));

  // ---------- upload (one file per request; optional client-generated poster) ----------
  app.post('/api/upload', async (req, reply) => {
    const fields = {};
    let tmp = null;
    let original = null;
    let mime = null;
    let thumbBuffer = null;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname === 'thumb') {
            thumbBuffer = await part.toBuffer();
          } else {
            tmp = path.join(paths.files, `.tmp-${newId()}`);
            original = part.filename;
            mime = part.mimetype;
            await pipeline(part.file, fs.createWriteStream(tmp));
            if (part.file.truncated) throw Object.assign(new Error('File too large'), { statusCode: 413 });
          }
        } else {
          fields[part.fieldname] = part.value;
        }
      }
      if (!tmp) return reply.code(400).send({ error: 'No file' });

      const ext = (path.extname(original || '').slice(1) || '').toLowerCase();
      const base = path.basename(original || 'upload', path.extname(original || ''));
      const isVideo = VIDEO_EXTS.has(ext) || (mime || '').startsWith('video/');
      const common = {
        name: fields.name || base,
        ext,
        mime,
        source: 'upload',
        folderIds: fields.folderId ? [fields.folderId] : [],
        tags: fields.tags ? JSON.parse(fields.tags) : [],
        thumbBuffer,
        width: Number(fields.width) || undefined,
        height: Number(fields.height) || undefined,
        duration: Number(fields.duration) || undefined,
      };
      let item;
      if (isVideo) {
        item = await lib.addItem({ ...common, type: 'video', tempFile: tmp });
      } else {
        const buffer = fs.readFileSync(tmp);
        item = await lib.addItem({ ...common, buffer });
      }
      return item;
    } finally {
      if (tmp) fs.rmSync(tmp, { force: true });
    }
  });

  // ---------- import (X links, image URLs, web pages) ----------
  app.post('/api/import', async (req, reply) => {
    const { text, urls, folderId, tags } = req.body || {};
    const job = startImport({ text: [text, ...(urls || [])].filter(Boolean).join('\n'), folderId, tags });
    if (!job.total) return reply.code(400).send({ error: 'No links found', job });
    return job;
  });

  // Are.na channel export (.zip). Responds 422 if the zip isn't one, so the client can store it as a file instead.
  app.post('/api/import/arena', async (req, reply) => {
    let tmp = null;
    let parentId = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        tmp = path.join(paths.files, `.tmp-${newId()}.zip`);
        await pipeline(part.file, fs.createWriteStream(tmp));
      } else if (part.fieldname === 'folderId') {
        parentId = part.value || null;
      }
    }
    if (!tmp) return reply.code(400).send({ error: 'No file' });
    let channels;
    try {
      channels = readArenaZip(tmp);
    } catch {
      channels = null;
    }
    if (!channels) {
      fs.rmSync(tmp, { force: true });
      return reply.code(422).send({ error: 'Not an Are.na export' });
    }
    // blocks are read lazily from the zip, so keep it until the job finishes
    return startArenaImport(channels, { parentId, onDone: () => fs.rmSync(tmp, { force: true }) });
  });

  app.get('/api/jobs/:id', async (req, reply) => getJob(req.params.id) || notFound(reply));

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
    const r = await fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: url, folderId: p.get('folderId') || undefined }) });
    let job = await r.json();
    if (!r.ok) return done(job.error || 'Nothing to import');
    while (job.status !== 'done') { await new Promise((res) => setTimeout(res, 600)); job = await (await fetch('/api/jobs/' + job.id)).json(); }
    if (job.failed) return done('Failed: ' + (job.entries.find((e) => e.error)?.error || 'unknown error'));
    done(job.imported ? '✓ Saved ' + job.imported + ' item' + (job.imported > 1 ? 's' : '') : 'Already in your library', true);
  } catch (e) { done('Error: ' + e.message); }
})();
</script></body></html>`;
