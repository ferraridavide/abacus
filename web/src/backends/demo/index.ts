import { UnavailableError, type Backend, type BatchAction, type FolderPatch, type ItemPatch } from '../../api';
import type { Folder, Item, ItemType, PaletteColor, Source, TagCount } from '../../types';
import { COLOR_MIN_SCORE, colorScore, hexToRgb, parseColor, rgbToOklab } from './color';
import { openDemoDb } from './db';
import { analyzeImage } from './media';
import { seedLibrary } from './seed';

// The demo backend: the whole library lives in this browser. Records and files are kept in IndexedDB, and the
// queries the server runs in SQL run here over the records in memory. What only the server can do — fetching
// links, reading Are.na exports, import providers, semantic search — rejects with an UnavailableError.

/** An item as it's stored: the served item without URLs, plus what queries need. */
interface ItemRecord extends Omit<Item, 'fileUrl' | 'thumbUrl'> {
  /** insertion order, which the random sort shuffles */
  seq: number;
  hasFile: boolean;
  hasThumb: boolean;
  /** when the item was added to each folder; the latest one is the folder's cover */
  folderAt: Record<string, number>;
  /** packed OKLab histogram for colour search */
  hist: number[];
}

type FolderRecord = Omit<Folder, 'count' | 'cover'>;

/** What a new item is made from; the seed library uses it too. */
export interface NewItem {
  name: string;
  type?: ItemType;
  ext?: string | null;
  mime?: string | null;
  source?: Source;
  file?: Blob;
  /** a poster frame, for videos */
  thumb?: Blob;
  width?: number;
  height?: number;
  duration?: number;
  url?: string | null;
  author?: string | null;
  authorHandle?: string | null;
  text?: string | null;
  description?: string | null;
  notes?: string | null;
  rating?: number;
  postedAt?: number | null;
  createdAt?: number;
  tags?: string[];
  folderIds?: string[];
}

const SERVER_ONLY = "isn't available in the demo, which runs entirely in your browser.";
const unavailable = (what: string) => Promise.reject(new UnavailableError(`${what} ${SERVER_ONLY}`));

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv']);
const PAGE_MAX = 1000;

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

function safeName(name: unknown, max = 80) {
  const cleaned = String(name ?? '')
    .normalize('NFKC')
    .replace(/[/\\?%*:|"<>\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || 'untitled';
}

const normalizeTag = (tag: unknown) => String(tag ?? '').replace(/\s+/g, ' ').trim().slice(0, 64);
const uniqueTags = (tags: unknown[]) => [...new Set(tags.map(normalizeTag).filter(Boolean))].sort();

export async function createDemoBackend() {
  const db = await openDemoDb();
  const items = new Map<string, ItemRecord>();
  const folders = new Map<string, FolderRecord>();
  /** object URLs of the stored blobs, by blob key */
  const urls = new Map<string, string>();
  let seq = 0;

  for (const r of await db.all<ItemRecord>('items')) {
    items.set(r.id, r);
    seq = Math.max(seq, r.seq);
  }
  for (const f of await db.all<FolderRecord>('folders')) folders.set(f.id, f);
  for (const [key, blob] of await db.entries<Blob>('blobs')) urls.set(key, URL.createObjectURL(blob));

  const fileKey = (id: string) => `${id}/file`;
  const thumbKey = (id: string) => `${id}/thumb`;

  const putBlob = async (key: string, blob: Blob) => {
    await db.put('blobs', key, blob);
    const old = urls.get(key);
    if (old) URL.revokeObjectURL(old);
    urls.set(key, URL.createObjectURL(blob));
  };
  const saveItem = (r: ItemRecord) => db.put('items', r.id, r);
  const saveFolder = (f: FolderRecord) => db.put('folders', f.id, f);

  function serialize(r: ItemRecord): Item {
    const { seq: _seq, hasFile, hasThumb, folderAt: _at, hist: _hist, ...item } = r;
    return {
      ...item,
      fileUrl: hasFile ? (urls.get(fileKey(r.id)) ?? null) : null,
      thumbUrl: hasThumb ? (urls.get(thumbKey(r.id)) ?? null) : null,
      tags: [...r.tags],
      folders: [...r.folders],
    };
  }

  const get = (id: string) => {
    const r = items.get(id);
    if (!r) throw new Error('Not found');
    return r;
  };

  // ---------- items ----------

  async function addItem(input: NewItem): Promise<Item> {
    const id = newId();
    const now = Date.now();
    const ext = (input.ext || '').toLowerCase().replace(/^\./, '') || null;
    const mime = input.mime || input.file?.type || null;
    const isVideo = input.type === 'video' || VIDEO_EXTS.has(ext || '') || (mime || '').startsWith('video/');

    // images are read from the file itself; videos from their poster frame
    const source = isVideo ? input.thumb : (input.thumb ?? input.file);
    const info = source ? await analyzeImage(source) : null;
    let type = input.type;
    if (!type) {
      if (isVideo) type = 'video';
      else if (info && input.file) type = mime === 'image/gif' ? 'gif' : 'image';
      else type = input.file ? 'file' : 'bookmark';
    }

    if (input.file) await putBlob(fileKey(id), input.file);
    if (info) await putBlob(thumbKey(id), info.thumb);

    const folderAt: Record<string, number> = {};
    for (const fid of input.folderIds || []) if (folders.has(fid)) folderAt[fid] = now;
    const record: ItemRecord = {
      id,
      name: safeName(input.name, 120),
      type,
      ext,
      mime,
      width: input.width || (isVideo ? null : info?.width) || null,
      height: input.height || (isVideo ? null : info?.height) || null,
      duration: input.duration || null,
      size: input.file?.size ?? 0,
      palette: info?.palette ?? [],
      url: input.url ?? null,
      mediaUrl: null,
      source: input.source ?? 'upload',
      author: input.author ?? null,
      authorHandle: input.authorHandle ?? null,
      authorAvatar: null,
      text: input.text ?? null,
      description: input.description ?? null,
      notes: input.notes ?? null,
      rating: input.rating ?? 0,
      postedAt: input.postedAt ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      tags: uniqueTags(input.tags || []),
      folders: Object.keys(folderAt),
      seq: ++seq,
      hasFile: !!input.file,
      hasThumb: !!info,
      folderAt,
      hist: info?.hist ?? [],
    };
    // a video's poster may be smaller than the video; fall back to it only when the size is unknown
    if (isVideo && info && (!record.width || !record.height)) {
      record.width = info.width;
      record.height = info.height;
    }
    items.set(id, record);
    await saveItem(record);
    return serialize(record);
  }

  /** The matching records, in the order asked for (by match, when a colour was searched). */
  function query(params: Record<string, string>): ItemRecord[] {
    const trash = params.view === 'trash';
    const types = params.types ? params.types.split(',').filter(Boolean) : [];
    const rating = Number(params.rating) || 0;
    const tokens = (params.q || '').split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());

    const matches = (r: ItemRecord) => {
      if (trash !== (r.deletedAt !== null)) return false;
      if (params.view === 'uncategorized' && r.folders.length) return false;
      if (params.view === 'untagged' && r.tags.length) return false;
      if (params.view === 'folder' && params.folderId && !r.folders.includes(params.folderId)) return false;
      if (params.view === 'tag' && params.tag && !r.tags.includes(params.tag)) return false;
      if (types.length && !types.includes(r.type)) return false;
      if (params.source && r.source !== params.source) return false;
      if (rating && r.rating < rating) return false;
      for (const token of tokens) {
        if (token.startsWith('#') && token.length > 1) {
          if (!r.tags.some((t) => t.toLowerCase().startsWith(token.slice(1)))) return false;
          continue;
        }
        const fields = [r.name, r.notes, r.text, r.description, r.author, r.authorHandle, r.url, ...r.tags];
        if (!fields.some((f) => f?.toLowerCase().includes(token)) && (r.ext || '').toLowerCase() !== token) return false;
      }
      return true;
    };
    const found = [...items.values()].filter(matches);

    const hex = parseColor(params.color);
    if (hex) {
      const lab = rgbToOklab(...hexToRgb(hex)!);
      return found
        .map((r) => ({ r, score: colorScore(r.hist.length ? r.hist : paletteAsHist(r.palette), lab) }))
        .filter((x) => x.score >= COLOR_MIN_SCORE)
        .sort((x, y) => y.score - x.score || y.r.createdAt - x.r.createdAt)
        .map((x) => x.r);
    }

    if (trash) return found.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    if (params.sort === 'random') {
      const seed = Math.floor(Number(params.seed) || 1) % 1000003;
      const key = (r: ItemRecord) => (r.seq * 2654435761 + seed) % 4294967291;
      return found.sort((a, b) => key(a) - key(b));
    }
    const dir = params.dir === 'asc' ? 1 : -1;
    const by: (r: ItemRecord) => number | string =
      {
        posted: (r: ItemRecord) => r.postedAt ?? r.createdAt,
        name: (r: ItemRecord) => r.name.toLowerCase(),
        size: (r: ItemRecord) => r.size,
        dimensions: (r: ItemRecord) => (r.width ?? 0) * (r.height ?? 0),
        rating: (r: ItemRecord) => r.rating,
      }[params.sort] ?? ((r: ItemRecord) => r.createdAt);
    return found.sort((a, b) => {
      const x = by(a);
      const y = by(b);
      return (x < y ? -dir : x > y ? dir : 0) || b.createdAt - a.createdAt;
    });
  }

  async function removeItems(ids: string[]) {
    const keys = ids.flatMap((id) => [fileKey(id), thumbKey(id)]);
    for (const k of keys) {
      const url = urls.get(k);
      if (url) URL.revokeObjectURL(url);
      urls.delete(k);
    }
    for (const id of ids) items.delete(id);
    await db.remove('blobs', keys);
    await db.remove('items', ids);
  }

  // ---------- folders ----------

  function listFolders(): Folder[] {
    const live = [...items.values()].filter((r) => r.deletedAt === null);
    return [...folders.values()]
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((f) => {
        const inside = live.filter((r) => r.folders.includes(f.id));
        const cover = inside
          .filter((r) => r.hasThumb)
          .sort((a, b) => (b.folderAt[f.id] ?? 0) - (a.folderAt[f.id] ?? 0))[0];
        return { ...f, count: inside.length, cover: cover ? (urls.get(thumbKey(cover.id)) ?? null) : null };
      });
  }

  const folderOut = (id: string) => listFolders().find((f) => f.id === id)!;

  function linkFolder(r: ItemRecord, folderId: string | undefined, at: number) {
    if (!folderId || !folders.has(folderId) || r.folders.includes(folderId)) return;
    r.folders = [...r.folders, folderId];
    r.folderAt = { ...r.folderAt, [folderId]: at };
  }
  function unlinkFolder(r: ItemRecord, folderId: string | undefined) {
    r.folders = r.folders.filter((f) => f !== folderId);
    const { [folderId ?? '']: _, ...rest } = r.folderAt;
    r.folderAt = rest;
  }

  async function createFolder({ name, parentId = null, color = null }: { name: string; parentId?: string | null; color?: string | null }) {
    const id = newId();
    const sort = Math.max(0, ...[...folders.values()].map((f) => f.sort)) + 1;
    const f: FolderRecord = { id, name: safeName(name || 'New Folder', 80), parentId: parentId || null, color, sort, createdAt: Date.now() };
    folders.set(id, f);
    await saveFolder(f);
    return folderOut(id);
  }

  // ---------- the backend ----------

  const backend: Backend = {
    async bootstrap() {
      const live = [...items.values()].filter((r) => r.deletedAt === null);
      const tags = new Map<string, TagCount>();
      for (const r of live) {
        for (const t of r.tags) {
          const k = t.toLowerCase();
          const tag = tags.get(k) ?? { name: t, count: 0 };
          tag.count++;
          tags.set(k, tag);
        }
      }
      return {
        stats: {
          all: live.length,
          uncategorized: live.filter((r) => !r.folders.length).length,
          untagged: live.filter((r) => !r.tags.length).length,
          trash: items.size - live.length,
          totalSize: live.reduce((n, r) => n + r.size, 0),
        },
        folders: listFolders(),
        tags: [...tags.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      };
    },

    async items(params) {
      const limit = Math.min(PAGE_MAX, Math.max(1, Number(params.limit) || 200));
      const offset = Math.max(0, Number(params.offset) || 0);
      const found = query(params);
      return { items: found.slice(offset, offset + limit).map(serialize), total: found.length, offset };
    },

    async itemIds(params) {
      return { ids: query(params).map((r) => r.id) };
    },

    async updateItem(id, patch: ItemPatch) {
      const r = get(id);
      if (patch.name !== undefined) r.name = safeName(patch.name, 120);
      if (patch.description !== undefined) r.description = patch.description;
      if (patch.notes !== undefined) r.notes = patch.notes;
      if (patch.url !== undefined) r.url = patch.url;
      if (patch.rating !== undefined) r.rating = Math.max(0, Math.min(5, Number(patch.rating) || 0));
      if (Array.isArray(patch.tags)) r.tags = uniqueTags(patch.tags);
      if (Array.isArray(patch.folders)) {
        const now = Date.now();
        const keep = patch.folders.filter((f) => folders.has(f));
        r.folderAt = Object.fromEntries(keep.map((f) => [f, r.folderAt[f] ?? now]));
        r.folders = [...new Set(keep)];
      }
      r.updatedAt = Date.now();
      await saveItem(r);
      return serialize(r);
    },

    async batch({ ids, action, tags = [], folderId, fromFolderId }) {
      const now = Date.now();
      const records = ids.map((id) => items.get(id)).filter((r): r is ItemRecord => !!r);
      if (action === 'delete') {
        await removeItems(records.map((r) => r.id));
        return { ok: true };
      }
      const apply: Record<Exclude<BatchAction, 'delete'>, (r: ItemRecord) => void> = {
        trash: (r) => (r.deletedAt = now),
        restore: (r) => (r.deletedAt = null),
        addTags: (r) => (r.tags = uniqueTags([...r.tags, ...tags])),
        removeTags: (r) => (r.tags = r.tags.filter((t) => !tags.includes(t))),
        addToFolder: (r) => linkFolder(r, folderId, now),
        moveToFolder: (r) => {
          if (fromFolderId) unlinkFolder(r, fromFolderId);
          else (r.folders = []), (r.folderAt = {});
          linkFolder(r, folderId, now);
        },
        removeFromFolder: (r) => unlinkFolder(r, folderId),
      };
      if (!apply[action]) throw new Error('Unknown action ' + action);
      for (const r of records) {
        apply[action](r);
        r.updatedAt = now;
        await saveItem(r);
      }
      return { ok: true };
    },

    async emptyTrash() {
      await removeItems([...items.values()].filter((r) => r.deletedAt !== null).map((r) => r.id));
      return { ok: true };
    },

    createFolder,

    async updateFolder(id, patch: FolderPatch) {
      const f = folders.get(id);
      if (!f) throw new Error('Not found');
      if (patch.parentId) {
        // no cycles: walk up from the new parent
        for (let cur: string | null = patch.parentId; cur; cur = folders.get(cur)?.parentId ?? null) {
          if (cur === id) throw new Error('Cannot move a folder into itself');
        }
      }
      if (patch.name !== undefined) f.name = safeName(patch.name, 80);
      if (patch.color !== undefined) f.color = patch.color;
      if (patch.parentId !== undefined) f.parentId = patch.parentId || null;
      if (patch.sort !== undefined) f.sort = Number(patch.sort);
      await saveFolder(f);
      return folderOut(id);
    },

    async deleteFolder(id) {
      // subfolders go too, as in the server's ON DELETE CASCADE
      const gone = new Set([id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const f of folders.values()) {
          if (f.parentId && gone.has(f.parentId) && !gone.has(f.id)) {
            gone.add(f.id);
            grew = true;
          }
        }
      }
      for (const fid of gone) folders.delete(fid);
      await db.remove('folders', [...gone]);
      for (const r of items.values()) {
        if (!r.folders.some((f) => gone.has(f))) continue;
        for (const fid of gone) unlinkFolder(r, fid);
        await saveItem(r);
      }
      return { ok: true };
    },

    async upload(form) {
      const file = form.get('file');
      if (!(file instanceof File)) throw new Error('No file');
      const thumb = form.get('thumb');
      const dot = file.name.lastIndexOf('.');
      const field = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string) : '');
      return addItem({
        name: field('name') || (dot > 0 ? file.name.slice(0, dot) : file.name) || 'upload',
        ext: dot > 0 ? file.name.slice(dot + 1) : null,
        mime: file.type || null,
        file,
        thumb: thumb instanceof Blob ? thumb : undefined,
        width: Number(field('width')) || undefined,
        height: Number(field('height')) || undefined,
        duration: Number(field('duration')) || undefined,
        tags: field('tags') ? JSON.parse(field('tags')) : [],
        folderIds: field('folderId') ? [field('folderId')] : [],
      });
    },

    // links are fetched and read by the server
    startImport: () => unavailable('Importing links'),
    importArena: () => unavailable('Importing Are.na exports'),
    job: () => Promise.reject(new Error('Not found')),
    // no providers: the import dialog just lists the built-in sources
    importSources: async () => ({ providers: [] }),
    providerSettings: () => unavailable('Setting up import providers'),
    updateProvider: () => unavailable('Setting up import providers'),
    testProvider: () => unavailable('Setting up import providers'),

    // semantic search needs an embeddings service; it reads as off, and setting it up is unavailable
    embeddingSettings: () => unavailable('Semantic search'),
    updateEmbeddings: () => unavailable('Semantic search'),
    testEmbeddings: () => unavailable('Semantic search'),
    embeddingStatus: async () => ({ state: 'off', total: 0, done: 0, failed: 0, pending: 0, images: 0, texts: 0, error: null }),
    reprocessEmbeddings: () => unavailable('Semantic search'),
    itemEmbedding: async () => ({ state: 'off', parts: [] }),
    reprocessItemEmbedding: () => unavailable('Semantic search'),
  };

  // a first visit starts with a small sample library, so there's something to look at
  if (!(await db.all('meta')).length) {
    if (!items.size && !folders.size) await seedLibrary({ addItem, createFolder });
    await db.put('meta', 'seeded', Date.now());
  }

  return {
    backend,
    /** Forget the demo library; the next load starts again from the sample. */
    reset: () => db.clear(),
  };
}

/** Dominant-colour swatches as a coarse histogram, for items without one. */
function paletteAsHist(palette: PaletteColor[]) {
  return palette.flatMap((p) => {
    const rgb = hexToRgb(p.hex);
    return rgb ? [...rgbToOklab(...rgb), p.ratio] : [];
  });
}
