import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { db } from './db.js';
import { paths } from './config.js';
import { getSetting, putSetting } from './settings.js';
import { applyValues, fieldDefaults, missingField, publicFields } from './fields.js';
import { fetchWithTimeout, mapLimit } from './util.js';

/**
 * Semantic search: embeddings from an external service with an OpenAI-style /embeddings endpoint rank search
 * results by meaning. Images and texts are embedded in the background (see "what gets embedded"), so the model
 * must embed both into the same space; searches embed the query text.
 */

const FIELDS = [
  {
    key: 'url',
    label: 'API URL',
    type: 'url',
    required: true,
    group: 'connection',
    placeholder: 'http://192.168.1.10:11434/v1',
    hint: 'The base URL that /embeddings is under.',
  },
  {
    key: 'model',
    label: 'Model',
    type: 'text',
    required: true,
    group: 'connection',
    placeholder: 'embeddinggemma',
    hint: 'It must embed images and text. Changing it re-embeds everything.',
  },
  {
    key: 'apiKey',
    label: 'API key',
    type: 'secret',
    group: 'connection',
    placeholder: 'Optional',
    hint: 'Sent as a Bearer token.',
  },
  {
    key: 'format',
    label: 'Image input',
    type: 'select',
    group: 'connection',
    default: 'objects',
    options: [
      { value: 'objects', label: '{ image } and { text } objects (Ollama, Jina)' },
      { value: 'modality', label: 'Data URLs with a modality field' },
      { value: 'plain', label: 'Data URLs' },
    ],
    hint: 'How images are sent. Test connection finds the one your service reads.',
  },
  {
    key: 'minScore',
    label: 'Minimum similarity',
    type: 'text',
    group: 'ranking',
    placeholder: 'Automatic',
    hint: 'The score a result needs, e.g. 0.6. Empty keeps results near the best match.',
  },
];

const META = {
  id: 'embeddings',
  name: 'Semantic search',
  description:
    'Finds images, GIFs, videos, links and posts by what they are about, using embeddings from a service with an OpenAI-compatible API.',
};

// formats saved under their earlier names
const FORMAT_ALIASES = { jina: 'objects', infinity: 'modality' };

const CONCURRENCY = 2;
const RETRY_MS = 60 * 1000;

function loadConfig() {
  const cfg = getSetting('embeddings', { enabled: false, ...fieldDefaults(FIELDS) });
  return { ...cfg, format: FORMAT_ALIASES[cfg.format] || cfg.format };
}
const isReady = (cfg) => cfg.enabled && !missingField(FIELDS, cfg);

const publicView = (cfg) => ({ ...META, enabled: !!cfg.enabled, ...publicFields(FIELDS, cfg) });

export const embeddingSettings = () => publicView(loadConfig());

export function updateEmbeddings({ enabled, values } = {}) {
  const prev = loadConfig();
  const next = applyValues(FIELDS, prev, values);
  if (enabled !== undefined) next.enabled = !!enabled;
  if (next.minScore && !Number.isFinite(Number(next.minScore))) {
    throw Object.assign(new Error('Minimum similarity must be a number'), { statusCode: 400 });
  }
  if (next.enabled) {
    const missing = missingField(FIELDS, next);
    if (missing) throw Object.assign(new Error(`${missing.label} is required`), { statusCode: 400 });
  }
  putSetting('embeddings', next);
  queryCache.clear();
  lastError = null;
  // vectors made with another image input aren't comparable (they may not even be of the images)
  if (prev.format !== next.format) reprocessAll();
  else kickEmbeddings();
  return publicView(next);
}

/** Test unsaved form values (falling back to the stored ones): embed a text and an image and compare them. */
export async function testEmbeddings(values) {
  let cfg;
  try {
    cfg = applyValues(FIELDS, loadConfig(), values);
  } catch (err) {
    return { ok: false, message: err.message };
  }
  const missing = missingField(FIELDS, cfg);
  if (missing) return { ok: false, message: `${missing.label} is required` };
  try {
    const probe = await probeImages(cfg);
    if (probe.ok || !probe.readAsText) return probe;
    // find the image input this service understands, so the message can name it
    for (const o of FIELDS.find((f) => f.key === 'format').options) {
      if (o.value === cfg.format) continue;
      const other = await probeImages({ ...cfg, format: o.value }).catch(() => null);
      if (other?.ok) {
        return { ok: false, message: `${probe.message} It works with "${o.label}": choose that under Image input.` };
      }
    }
    return { ok: false, message: `${probe.message} This model or endpoint doesn't seem to embed images.` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

const SAME = 0.99;

/** Embed a text and an image, and check the image was read as an image. */
async function probeImages(cfg) {
  const [text] = await requestEmbeddings(cfg, 'text', ['a photo of a cat']);
  const jpeg = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#5b8cff' } })
    .jpeg()
    .toBuffer();
  const value = imageValue(cfg, jpeg);
  const [image] = await requestEmbeddings(cfg, 'image', [value]);
  if (text.length !== image.length) {
    return {
      ok: false,
      message: `Text and image embeddings differ in size (${text.length} and ${image.length}). Use a model that embeds both, like CLIP.`,
    };
  }
  // A text-only endpoint embeds an image's base64 like any other words, which makes every image look alike.
  const [asText] = await requestEmbeddings(cfg, 'text', [value]);
  if (dot(image, asText) > SAME) {
    return { ok: false, readAsText: true, message: 'The service read the image as text, so every image looks alike.' };
  }
  return { ok: true, message: `Connected · ${image.length} dimensions` };
}

// ---------- the embeddings API ----------

/** The service can't be used right now (unreachable, auth, server error): stop and retry later. */
class ServiceError extends Error {}

const ITEM_ERRORS = new Set([400, 413, 415, 422]);

function imageValue(cfg, jpeg) {
  const b64 = jpeg.toString('base64');
  return cfg.format === 'objects' ? b64 : `data:image/jpeg;base64,${b64}`;
}

function inputBody(cfg, kind, values) {
  if (cfg.format === 'objects') return { input: values.map((v) => ({ [kind]: v })) };
  if (cfg.format === 'modality') return { input: values, modality: kind };
  return { input: values };
}

/** Embed texts or images (as made by imageValue); resolves to unit-length vectors. */
async function requestEmbeddings(cfg, kind, values) {
  let res;
  try {
    res = await fetchWithTimeout(
      cfg.url + '/embeddings',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: cfg.model, encoding_format: 'float', ...inputBody(cfg, kind, values) }),
      },
      60000
    );
  } catch (err) {
    throw new ServiceError(`Can't reach ${cfg.url}: ${err.cause?.code || err.message}`);
  }
  const body = await res.text();
  let j = null;
  try {
    j = JSON.parse(body);
  } catch {
    /* reported below */
  }
  if (!res.ok) {
    const detail = j?.error?.message || j?.error || j?.detail || j?.message || body.slice(0, 200) || res.statusText;
    const message = `HTTP ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    throw ITEM_ERRORS.has(res.status) ? new Error(message) : new ServiceError(message);
  }
  if (!Array.isArray(j?.data) || j.data.length !== values.length) {
    throw new ServiceError("The response doesn't look like an OpenAI embeddings response");
  }
  return [...j.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => unit(toFloats(d.embedding)));
}

function toFloats(e) {
  if (Array.isArray(e)) return Float32Array.from(e);
  if (typeof e === 'string') {
    const buf = Buffer.from(e, 'base64');
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  throw new ServiceError("The response doesn't look like an OpenAI embeddings response");
}

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---------- what gets embedded ----------

// Each item gets up to two embeddings: its image (a thumbnail: photos, GIFs, video posters, link previews) and its
// text (titles, post text, notes, tags). Uploaded media are named after their files, so their names only count
// when there's no image to go by.
const KINDS = ['image', 'text'];

const HAS_IMAGE = 'i.thumb IS NOT NULL';
const HAS_TEXT = `(i.thumb IS NULL OR i.type = 'bookmark' OR i.source != 'upload'
  OR COALESCE(i.text, '') != '' OR COALESCE(i.notes, '') != ''
  OR EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id))`;
const HAS = { image: HAS_IMAGE, text: HAS_TEXT };

const ROW_COLUMNS = `i.id, i.name, i.type, i.source, i.thumb, i.text, i.notes, i.author,
  (SELECT group_concat(tag, ', ') FROM item_tags t WHERE t.item_id = i.id) AS tags`;

/** The text embedded for an item; never empty for the items HAS_TEXT picks. */
function textFor(row) {
  const parts = [];
  if (!row.thumb || row.type === 'bookmark' || row.source !== 'upload') parts.push(row.name);
  if (row.author) parts.push(`By ${row.author}`);
  if (row.text && row.text !== row.name) parts.push(row.text);
  if (row.notes) parts.push(row.notes);
  if (row.tags) parts.push(`Tags: ${row.tags}`);
  return parts.join('\n').slice(0, 4000);
}

async function thumbJpeg(thumb) {
  const file = path.join(paths.thumbs, thumb);
  if (!fs.existsSync(file)) throw new Error('The thumbnail file is missing');
  return sharp(file)
    .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#fff' })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function inputFor(cfg, kind, row) {
  return kind === 'image' ? imageValue(cfg, await thumbJpeg(row.thumb)) : textFor(row);
}

// ---------- storage ----------

const putRow = db.prepare(
  `INSERT OR REPLACE INTO item_embeddings (item_id, kind, model, vector, error, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);

/** The current model's vectors by kind and item id, read once and kept in step with writes. */
let cache = null;

function vectors(model) {
  if (cache?.model !== model) {
    cache = { model, image: new Map(), text: new Map() };
    const rows = db.prepare('SELECT item_id, kind, vector FROM item_embeddings WHERE model = ? AND vector IS NOT NULL');
    for (const r of rows.iterate(model)) cache[r.kind]?.set(r.item_id, fromBlob(r.vector));
  }
  return cache;
}

const fromBlob = (u8) => new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));

function save(itemId, kind, model, vector, error) {
  // an item hard-deleted while it was being embedded has no row to point at any more
  if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId)) return;
  putRow.run(itemId, kind, model, vector ? new Uint8Array(vector.buffer) : null, error, Date.now());
  if (cache?.model === model) {
    if (vector) cache[kind].set(itemId, vector);
    else cache[kind].delete(itemId);
  }
}

/**
 * Embed one of an item's kinds and store the vector, or the error when the service rejects that input. `gen` is
 * the generation `cfg` was read in.
 */
async function embedOne(row, kind, cfg, gen) {
  let vector = null;
  let error = null;
  try {
    [vector] = await requestEmbeddings(cfg, kind, [await inputFor(cfg, kind, row)]);
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    error = err.message;
  }
  // "Re-process all" or a settings change came since cfg was read: this result belongs to the cleared run
  if (gen === generation) save(row.id, kind, cfg.model, vector, error);
}

/** An item's text changed (name, notes, tags): embed it again. */
export function textChanged(ids) {
  if (!ids.length) return;
  const del = db.prepare("DELETE FROM item_embeddings WHERE item_id = ? AND kind = 'text'");
  for (const id of ids) {
    del.run(id);
    cache?.text.delete(id);
  }
  kickEmbeddings();
}

// ---------- background worker ----------

let running = false;
let lastError = null;
let retryTimer = null;
/** Bumped by "re-process all" (and so by changing the image input), so results from before it are dropped. */
let generation = 0;

const nextRows = Object.fromEntries(
  KINDS.map((kind) => [
    kind,
    db.prepare(
      `SELECT ${ROW_COLUMNS} FROM items i
       WHERE i.deleted_at IS NULL AND ${HAS[kind]}
         AND NOT EXISTS (SELECT 1 FROM item_embeddings e WHERE e.item_id = i.id AND e.kind = '${kind}' AND e.model = ?)
       ORDER BY i.created_at DESC LIMIT ?`
    ),
  ])
);

/** Embed everything that has no embedding for the current model yet. Safe to call often. */
export function kickEmbeddings() {
  if (running) return;
  clearTimeout(retryTimer);
  run();
}

async function run() {
  running = true;
  try {
    for (;;) {
      const cfg = loadConfig();
      const gen = generation;
      if (!isReady(cfg)) break;
      const jobs = KINDS.flatMap((kind) => nextRows[kind].all(cfg.model, CONCURRENCY * 4).map((row) => ({ row, kind })));
      if (!jobs.length) break;
      await mapLimit(jobs, CONCURRENCY, (j) => (gen === generation ? embedOne(j.row, j.kind, cfg, gen) : null));
      lastError = null;
    }
  } catch (err) {
    lastError = err.message;
    console.warn(`embeddings: ${err.message}; retrying in ${RETRY_MS / 1000}s`);
    retryTimer = setTimeout(kickEmbeddings, RETRY_MS);
    retryTimer.unref();
  } finally {
    running = false;
  }
}

/** Forget every embedding and compute them again. */
export function reprocessAll() {
  generation++;
  db.exec('DELETE FROM item_embeddings');
  cache = null;
  lastError = null;
  kickEmbeddings();
  return embeddingStatus();
}

/** Each library item's state per kind, as SQL: whether it needs one, has a row, and has a vector. */
const PER_ITEM = `
  SELECT ${HAS_IMAGE} AS img, ${HAS_TEXT} AS txt,
    ei.item_id IS NOT NULL AS img_row, ei.vector IS NOT NULL AS img_ok,
    et.item_id IS NOT NULL AS txt_row, et.vector IS NOT NULL AS txt_ok
  FROM items i
  LEFT JOIN item_embeddings ei ON ei.item_id = i.id AND ei.kind = 'image' AND ei.model = ?
  LEFT JOIN item_embeddings et ON et.item_id = i.id AND et.kind = 'text' AND et.model = ?
  WHERE i.deleted_at IS NULL`;

/** Progress over the library's items; an item is done once all of its embeddings are. */
export function embeddingStatus() {
  const cfg = loadConfig();
  if (!isReady(cfg)) return { state: 'off', total: 0, done: 0, failed: 0, pending: 0, images: 0, texts: 0, error: null };
  const c = db
    .prepare(
      `SELECT COUNT(*) AS total,
         SUM(failed) AS failed,
         SUM(NOT failed AND ((img AND NOT img_row) OR (txt AND NOT txt_row))) AS pending,
         SUM(img AND img_ok) AS images, SUM(txt AND txt_ok) AS texts
       FROM (SELECT *, (img AND img_row AND NOT img_ok) OR (txt AND txt_row AND NOT txt_ok) AS failed FROM (${PER_ITEM}))`
    )
    .get(cfg.model, cfg.model);
  const [total, failed, pending] = [c.total, c.failed || 0, c.pending || 0];
  const lastFailure = failed
    ? db
        .prepare('SELECT error FROM item_embeddings WHERE model = ? AND vector IS NULL ORDER BY created_at DESC LIMIT 1')
        .get(cfg.model)?.error
    : null;
  const state = lastError ? 'error' : running || pending ? 'running' : 'complete';
  return {
    state,
    total,
    done: total - failed - pending,
    failed,
    pending,
    images: c.images || 0,
    texts: c.texts || 0,
    error: lastError,
    lastFailure,
  };
}

// ---------- single items ----------

/** An item's embeddings, per kind it has: pending | done | failed. */
export function itemEmbedding(id) {
  const cfg = loadConfig();
  if (!isReady(cfg)) return { state: 'off', parts: [] };
  const item = db.prepare(`SELECT ${HAS_IMAGE} AS image, ${HAS_TEXT} AS text FROM items i WHERE i.id = ?`).get(id);
  if (!item) return null;
  const rows = db
    .prepare('SELECT kind, vector, error, created_at FROM item_embeddings WHERE item_id = ? AND model = ?')
    .all(id, cfg.model);
  const parts = KINDS.filter((k) => item[k]).map((kind) => {
    const row = rows.find((r) => r.kind === kind);
    if (!row) return { kind, state: 'pending' };
    if (!row.vector) return { kind, state: 'failed', error: row.error, at: row.created_at };
    return { kind, state: 'done', dimensions: row.vector.byteLength / 4, at: row.created_at };
  });
  const state = parts.some((p) => p.state === 'failed')
    ? 'failed'
    : parts.some((p) => p.state === 'pending')
      ? 'pending'
      : 'done';
  return { state, model: cfg.model, parts };
}

export async function reprocessItem(id) {
  const cfg = loadConfig();
  if (!isReady(cfg)) throw Object.assign(new Error('Semantic search is off'), { statusCode: 400 });
  const row = db
    .prepare(`SELECT ${ROW_COLUMNS}, ${HAS_IMAGE} AS has_image, ${HAS_TEXT} AS has_text FROM items i WHERE i.id = ?`)
    .get(id);
  if (!row) return null;
  try {
    for (const kind of KINDS) if (row['has_' + kind]) await embedOne(row, kind, cfg, generation);
  } catch (err) {
    throw Object.assign(new Error(err.message), { statusCode: 502 });
  }
  return itemEmbedding(id);
}

// ---------- search ----------

const queryCache = new Map();
const QUERY_CACHE_MAX = 200;
// Below this many vectors of each kind there's too little to compare the kinds' scores by.
const CALIBRATE_MIN = 8;

/**
 * Score items against a search text. Resolves to null when embeddings are off or the service can't be
 * reached, so search falls back to matching text.
 *
 * Text-to-text similarities run higher than text-to-image ones (with every model: unrelated texts already score
 * near what a matching image does), so text scores are moved onto the images' scale: the same distance from the
 * typical score, in the same spread, as the library's images have for this query.
 */
export async function similarityTo(text) {
  const cfg = loadConfig();
  if (!isReady(cfg)) return null;
  const key = cfg.model + '\0' + text;
  let query = queryCache.get(key);
  if (!query) {
    try {
      [query] = await requestEmbeddings(cfg, 'text', [text]);
    } catch (err) {
      console.warn(`embeddings: search for "${text}" fell back to text matching: ${err.message}`);
      return null;
    }
    queryCache.set(key, query);
    if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
  }

  const all = vectors(cfg.model);
  const raw = {};
  const stats = {};
  for (const kind of KINDS) {
    raw[kind] = new Map();
    let sum = 0;
    let sq = 0;
    for (const [id, v] of all[kind]) {
      if (v.length !== query.length) continue;
      const s = dot(v, query);
      raw[kind].set(id, s);
      sum += s;
      sq += s * s;
    }
    const n = raw[kind].size;
    const mean = n ? sum / n : 0;
    stats[kind] = { n, mean, sd: n ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0 };
  }
  const { image: si, text: st } = stats;
  const calibrate = si.n >= CALIBRATE_MIN && st.n >= CALIBRATE_MIN && st.sd > 0;
  const onImageScale = (s) => (calibrate ? si.mean + ((s - st.mean) / st.sd) * si.sd : s);

  const minScore = cfg.minScore === '' ? null : Number(cfg.minScore);
  return {
    /** The item's best match: { score, kind }, or null when it has no embedding yet. */
    score: (id) => {
      const img = raw.image.get(id);
      const txt = raw.text.get(id);
      const t = txt === undefined ? undefined : onImageScale(txt);
      if (img === undefined && t === undefined) return null;
      return img !== undefined && (t === undefined || img >= t) ? { score: img, kind: 'image' } : { score: t, kind: 'text' };
    },
    minScore: Number.isFinite(minScore) ? minScore : null,
  };
}
