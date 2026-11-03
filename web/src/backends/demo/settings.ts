import type { Backend, ServicePatch } from '../../api';
import type { ApiKey, AppearanceChoice, ProviderField, ProviderSettings, StorageUsage } from '../../types';
import { resolveAppearance } from '../../lib/theme';
import type { DemoDb } from './db';

// Settings for what only the server does — import providers, semantic search, JPEG XL thumbnails, storage, API
// keys — made up, so the demo can show what those pages look like. Changes are kept in the browser like the
// library, but nothing is contacted, converted or embedded: progress is just a clock running.

/** The library's own numbers, which the storage page and progress counts start from. */
export interface LibraryStats {
  files: { bytes: number; count: number };
  thumbs: { bytes: number; count: number };
  /** images bigger than their thumbnail, which would get a full-screen preview */
  previewable: { bytes: number; count: number };
  /** the records, as stored */
  records: { bytes: number; count: number };
  /** items with text or a thumbnail to embed */
  embeddable: { images: number; texts: number; total: number };
}

interface Service {
  enabled: boolean;
  values: Record<string, string>;
}

interface State {
  /** Settings → Appearance: only the choices made. (Not `appearance`: older demo saves stored every field there.) */
  look: Partial<AppearanceChoice>;
  cobalt: Service;
  embeddings: Service & { since: number };
  thumbnails: { jxl: boolean; previews: boolean; since: number };
  apiKeys: ApiKey[];
}

const COBALT = {
  id: 'cobalt',
  name: 'cobalt',
  description: 'Downloads videos, photos, and audio from YouTube, TikTok, Instagram, Reddit, and other sites.',
  docsUrl: 'https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md',
  fields: [
    { key: 'url', label: 'Instance URL', type: 'url', required: true, placeholder: 'http://192.168.1.10:9000', hint: 'Must be reachable from the Abacus server.' },
    { key: 'apiKey', label: 'API key', type: 'secret', required: false, placeholder: 'Optional', hint: 'Only needed if the instance requires API key authentication.' },
    {
      key: 'videoQuality',
      label: 'Video quality',
      type: 'select',
      required: false,
      options: [
        { value: 'max', label: 'Best available' },
        { value: '2160', label: '2160p (4K)' },
        { value: '1440', label: '1440p' },
        { value: '1080', label: '1080p' },
        { value: '720', label: '720p' },
        { value: '480', label: '480p' },
        { value: '360', label: '360p' },
      ],
    },
  ] as ProviderField[],
};

const EMBEDDINGS = {
  id: 'embeddings',
  name: 'Semantic search',
  description:
    'Finds images, GIFs, videos, links and posts by what they are about, using embeddings from a service with an OpenAI-compatible API.',
  fields: [
    { key: 'url', label: 'API URL', type: 'url', required: true, group: 'connection', placeholder: 'http://192.168.1.10:11434/v1', hint: 'The base URL that /embeddings is under.' },
    { key: 'model', label: 'Model', type: 'text', required: true, group: 'connection', placeholder: 'embeddinggemma', hint: 'It must embed images and text. Changing it re-embeds everything.' },
    { key: 'apiKey', label: 'API key', type: 'secret', required: false, group: 'connection', placeholder: 'Optional', hint: 'Sent as a Bearer token.' },
    {
      key: 'format',
      label: 'Image input',
      type: 'select',
      required: false,
      group: 'connection',
      options: [
        { value: 'objects', label: '{ image } and { text } objects (Ollama, Jina)' },
        { value: 'modality', label: 'Data URLs with a modality field' },
        { value: 'plain', label: 'Data URLs' },
      ],
      hint: 'How images are sent. Test connection finds the one your service reads.',
    },
    { key: 'minScore', label: 'Minimum similarity', type: 'text', required: false, group: 'ranking', placeholder: 'Automatic', hint: 'The score a result needs, e.g. 0.6. Empty keeps results near the best match.' },
  ] as ProviderField[],
};

const COBALT_SITES = ['bilibili', 'bluesky', 'dailymotion', 'facebook', 'instagram', 'loom', 'ok', 'pinterest', 'reddit', 'rutube', 'snapchat', 'soundcloud', 'streamable', 'tiktok', 'tumblr', 'twitch clips', 'twitter', 'vimeo', 'vk', 'xiaohongshu', 'youtube'];

const DAY = 24 * 60 * 60 * 1000;
/** how long a pretend conversion or embedding run takes, whatever the library's size */
const RUN_MS = 8000;
/** the fake JPEG XL thumbnails and previews, as a share of the webp thumbnails and the originals */
const JXL_RATIO = 0.8;
const PREVIEW_RATIO = 0.45;

const initialState = (): State => ({
  look: {},
  cobalt: { enabled: true, values: { url: 'http://192.168.1.10:9000', apiKey: '', videoQuality: '1080' } },
  embeddings: {
    enabled: true,
    values: { url: 'http://192.168.1.10:11434/v1', model: 'embeddinggemma', apiKey: '', format: 'objects', minScore: '' },
    since: 0,
  },
  thumbnails: { jxl: true, previews: true, since: 0 },
  apiKeys: [{ id: 'demo-key', name: 'Chrome extension', createdAt: Date.now() - 12 * DAY, lastUsedAt: Date.now() - 2 * 60 * 60 * 1000 }],
});

const newToken = () =>
  'abacus_' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** How far a run started at `since` has got through `total`. */
const progress = (since: number, total: number) => (total ? Math.min(total, Math.floor(((Date.now() - since) / RUN_MS) * total)) : 0);

export async function createDemoSettings(db: DemoDb, library: () => LibraryStats) {
  const saved = (await db.entries<State>('meta')).find(([k]) => k === 'settings')?.[1];
  const state: State = { ...initialState(), ...saved };
  const save = () => db.put('meta', 'settings', state);

  /** As the server sends them: secrets come back as whether they're set. */
  const serialize = (meta: Omit<ProviderSettings, 'enabled' | 'values'>, s: Service): ProviderSettings => ({
    ...meta,
    enabled: s.enabled,
    values: Object.fromEntries(meta.fields.map((f) => [f.key, f.type === 'secret' ? !!s.values[f.key] : (s.values[f.key] ?? '')])),
  });

  const missing = (fields: ProviderField[], values: Record<string, string>) => fields.find((f) => f.required && !values[f.key]?.trim());

  /** Saved values with the patch over them; a secret left out stays as it was. */
  const merged = (fields: ProviderField[], s: Service, values: Record<string, string> = {}) => {
    const out = { ...s.values };
    for (const f of fields) if (values[f.key] !== undefined) out[f.key] = String(values[f.key]).trim();
    return out;
  };

  const apply = (fields: ProviderField[], s: Service, { enabled, values }: ServicePatch) => {
    const next = merged(fields, s, values);
    const gap = missing(fields, next);
    if (enabled && gap) throw new Error(`${gap.label} is required`);
    s.values = next;
    if (enabled !== undefined) s.enabled = enabled;
  };

  const test = (fields: ProviderField[], s: Service, values: Record<string, string>, ok: string) => {
    const gap = missing(fields, merged(fields, s, values));
    return gap ? { ok: false, message: `${gap.label} is required` } : { ok: true, message: `${ok} (Demo: nothing was contacted.)` };
  };

  const embeddingStatus = () => {
    const { images, texts, total } = library().embeddable;
    if (!state.embeddings.enabled) return { state: 'off' as const, total: 0, done: 0, failed: 0, pending: 0, images: 0, texts: 0, error: null };
    const done = progress(state.embeddings.since, total);
    const share = (n: number) => Math.round((n * done) / (total || 1));
    return {
      state: done < total ? ('running' as const) : ('complete' as const),
      total,
      done,
      failed: 0,
      pending: total - done,
      images: share(images),
      texts: share(texts),
      error: null,
      lastFailure: null,
    };
  };

  const thumbnailSettings = () => {
    const { jxl, previews, since } = state.thumbnails;
    const total = library().thumbs.count;
    const processed = jxl ? progress(since, total) : 0;
    return {
      jxl,
      previews,
      state: !jxl ? ('off' as const) : processed < total ? ('running' as const) : ('complete' as const),
      total,
      processed,
      failed: 0,
      lastFailure: null,
    };
  };

  const settings: Pick<
    Backend,
    | 'appearance'
    | 'updateAppearance'
    | 'apiKeys'
    | 'createApiKey'
    | 'deleteApiKey'
    | 'providerSettings'
    | 'updateProvider'
    | 'testProvider'
    | 'embeddingSettings'
    | 'updateEmbeddings'
    | 'testEmbeddings'
    | 'embeddingStatus'
    | 'reprocessEmbeddings'
    | 'itemEmbedding'
    | 'reprocessItemEmbedding'
    | 'storageUsage'
    | 'thumbnailSettings'
    | 'updateThumbnails'
  > = {
    // the theme is a server setting, so the demo keeps it like the library: in this browser, and only what was chosen
    appearance: async () => resolveAppearance(state.look),
    async updateAppearance(patch) {
      const chosen = Object.entries(patch).filter(([, value]) => value !== undefined);
      state.look = { ...state.look, ...Object.fromEntries(chosen) };
      await save();
      return resolveAppearance(state.look);
    },
    apiKeys: async () => state.apiKeys.map((k) => ({ ...k })),
    async createApiKey(name) {
      const key: ApiKey = { id: crypto.randomUUID(), name: name.trim().slice(0, 100), createdAt: Date.now(), lastUsedAt: null };
      state.apiKeys = [key, ...state.apiKeys];
      await save();
      return { ...key, token: newToken() };
    },
    async deleteApiKey(id) {
      state.apiKeys = state.apiKeys.filter((k) => k.id !== id);
      await save();
      return { ok: true };
    },

    providerSettings: async () => [serialize(COBALT, state.cobalt)],
    async updateProvider(id, body) {
      if (id !== COBALT.id) throw new Error('Not found');
      apply(COBALT.fields, state.cobalt, body);
      await save();
      return serialize(COBALT, state.cobalt);
    },
    async testProvider(id, values) {
      if (id !== COBALT.id) throw new Error('Not found');
      return { ...test(COBALT.fields, state.cobalt, values, 'Connected to cobalt.'), sites: COBALT_SITES };
    },

    embeddingSettings: async () => serialize(EMBEDDINGS, state.embeddings),
    async updateEmbeddings(body) {
      const wasOn = state.embeddings.enabled;
      const before = state.embeddings.values;
      apply(EMBEDDINGS.fields, state.embeddings, body);
      // turning it on, or another service or model, embeds the library again
      const { url, model } = state.embeddings.values;
      if (state.embeddings.enabled && (!wasOn || before.url !== url || before.model !== model)) state.embeddings.since = Date.now();
      await save();
      return serialize(EMBEDDINGS, state.embeddings);
    },
    testEmbeddings: async (values) => {
      const model = merged(EMBEDDINGS.fields, state.embeddings, values).model;
      return test(EMBEDDINGS.fields, state.embeddings, values, `Connected. ${model} embeds images and text.`);
    },
    embeddingStatus: async () => embeddingStatus(),
    async reprocessEmbeddings() {
      state.embeddings.since = Date.now();
      await save();
      return embeddingStatus();
    },
    itemEmbedding: async () => {
      if (!state.embeddings.enabled) return { state: 'off', parts: [] };
      const at = state.embeddings.since || Date.now() - DAY;
      return {
        state: 'done',
        model: state.embeddings.values.model,
        parts: [
          { kind: 'image', state: 'done', dimensions: 768, at },
          { kind: 'text', state: 'done', dimensions: 768, at },
        ],
      };
    },
    reprocessItemEmbedding: async () => ({
      state: 'done',
      model: state.embeddings.values.model,
      parts: [
        { kind: 'image', state: 'done', dimensions: 768, at: Date.now() },
        { kind: 'text', state: 'done', dimensions: 768, at: Date.now() },
      ],
    }),

    thumbnailSettings: async () => thumbnailSettings(),
    async updateThumbnails({ jxl, previews }) {
      const t = state.thumbnails;
      // turning either on starts a conversion; turning one off just drops those files
      if ((jxl && !t.jxl) || (previews && !t.previews && t.jxl)) t.since = Date.now();
      if (jxl !== undefined) t.jxl = jxl;
      if (previews !== undefined) t.previews = previews;
      await save();
      return thumbnailSettings();
    },

    async storageUsage() {
      const lib = library();
      const thumbs = thumbnailSettings();
      const converted = thumbs.total ? thumbs.processed / thumbs.total : 0;
      const jxl = { bytes: Math.round(lib.thumbs.bytes * JXL_RATIO * converted), count: thumbs.processed };
      const preview =
        thumbs.jxl && thumbs.previews
          ? { bytes: Math.round(lib.previewable.bytes * PREVIEW_RATIO * converted), count: Math.round(lib.previewable.count * converted) }
          : { bytes: 0, count: 0 };
      // the database also holds the embeddings, 768 floats each
      const embedded = embeddingStatus();
      const db = { bytes: lib.records.bytes + (embedded.images + embedded.texts) * 768 * 4, count: lib.records.count };
      const usage: StorageUsage = {
        total: db.bytes + lib.files.bytes + lib.thumbs.bytes + jxl.bytes + preview.bytes,
        db,
        files: lib.files,
        webp: lib.thumbs,
        jxl,
        preview,
        disk: null,
      };
      // what this browser lets the demo keep stands in for the disk
      try {
        const { quota, usage: used } = await navigator.storage.estimate();
        if (quota) usage.disk = { size: quota, free: Math.max(0, quota - (used ?? 0)) };
      } catch {
        // no estimate in this browser
      }
      return usage;
    },
  };

  return settings;
}
