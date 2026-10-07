import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, type BatchAction } from './api';
import type { AutoplayMode, Filters, Folder, Item, Job, LayoutMode, SortKey, Stats, TagCount, View } from './types';
import { isVideoFile, probeVideo } from './lib/upload';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

export interface ContextMenuState {
  x: number;
  y: number;
  kind: 'item' | 'folder' | 'grid';
  id?: string;
}

export interface ConfirmState {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

interface State {
  // preferences (persisted)
  layout: LayoutMode;
  thumbSize: number;
  showInfo: boolean;
  sort: { by: SortKey; dir: 'asc' | 'desc' };
  expanded: Record<string, boolean>;
  inspectorOpen: boolean;
  tagsOpen: boolean;
  autoplay: AutoplayMode;

  // library
  view: View;
  query: string;
  filters: Filters;
  seed: number;
  items: Item[];
  /** matches on the server; `items` holds the pages loaded so far */
  total: number;
  loading: boolean;
  loadingMore: boolean;
  folders: Folder[];
  tags: TagCount[];
  stats: Stats;

  // ui
  selected: Set<string>;
  anchor: string | null;
  viewerId: string | null;
  importOpen: boolean;
  settingsOpen: boolean;
  folderPicker: { mode: 'add' | 'move'; ids: string[] } | null;
  contextMenu: ContextMenuState | null;
  confirm: ConfirmState | null;
  renamingFolderId: string | null;
  jobs: Job[];
  toasts: Toast[];

  // actions
  setView: (view: View) => void;
  setQuery: (q: string) => void;
  setFilters: (f: Partial<Filters>) => void;
  setSort: (s: Partial<State['sort']>) => void;
  setLayout: (l: LayoutMode) => void;
  setThumbSize: (n: number) => void;
  set: (patch: Partial<State>) => void;
  refresh: () => Promise<void>;
  /** 'reset' starts again from page one; 'keep' re-fetches the pages already loaded (after edits, imports). */
  refreshItems: (mode?: 'reset' | 'keep') => Promise<void>;
  loadMore: () => Promise<void>;
  refreshMeta: () => Promise<void>;

  select: (id: string, mode?: 'single' | 'toggle' | 'range') => void;
  setSelection: (ids: string[]) => void;
  selectAll: () => Promise<void>;
  clearSelection: () => void;

  updateItem: (id: string, patch: Parameters<typeof api.updateItem>[1]) => Promise<void>;
  batch: (action: BatchAction, ids: string[], extra?: { tags?: string[]; folderId?: string; fromFolderId?: string }) => Promise<void>;
  trashSelected: () => Promise<void>;

  createFolder: (parentId?: string | null) => Promise<Folder | null>;
  updateFolder: (id: string, patch: Parameters<typeof api.updateFolder>[1]) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;

  importText: (text: string, folderId?: string) => Promise<boolean>;
  uploadFiles: (files: File[], folderId?: string) => Promise<void>;

  toast: (message: string, kind?: Toast['kind']) => void;
  ask: (opts: Omit<ConfirmState, 'resolve'>) => Promise<boolean>;
}

let itemsRequest = 0;
const PAGE = 200;

/** Query-string for the current view, search, filters and sort. */
function queryParams(s: Pick<State, 'view' | 'query' | 'filters' | 'sort' | 'seed'>) {
  const { view, query, filters, sort, seed } = s;
  const params: Record<string, string> = { view: view.kind, sort: sort.by, dir: sort.dir, seed: String(seed) };
  if (view.kind === 'folder') params.folderId = view.id;
  if (view.kind === 'tag') params.tag = view.tag;
  if (query.trim()) params.q = query.trim();
  if (filters.types.length) params.types = filters.types.join(',');
  if (filters.source) params.source = filters.source;
  if (filters.rating) params.rating = String(filters.rating);
  if (filters.color) params.color = filters.color;
  return params;
}
let toastId = 0;

export const currentFolderId = (view: View) => (view.kind === 'folder' ? view.id : undefined);

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      layout: 'masonry',
      thumbSize: 240,
      showInfo: true,
      sort: { by: 'created', dir: 'desc' },
      expanded: {},
      inspectorOpen: true,
      tagsOpen: true,
      autoplay: 'hover',

      view: { kind: 'all' },
      query: '',
      filters: { types: [], source: '', rating: 0, color: '' },
      seed: 1,
      items: [],
      total: 0,
      loadingMore: false,
      loading: true,
      folders: [],
      tags: [],
      stats: { all: 0, uncategorized: 0, untagged: 0, trash: 0, totalSize: 0 },

      selected: new Set(),
      anchor: null,
      viewerId: null,
      importOpen: false,
      settingsOpen: false,
      folderPicker: null,
      contextMenu: null,
      confirm: null,
      renamingFolderId: null,
      jobs: [],
      toasts: [],

      set: (patch) => set(patch),

      setView: (view) => {
        set({ view, selected: new Set(), anchor: null, items: [], total: 0, loading: true });
        get().refreshItems();
      },
      setQuery: (query) => {
        set({ query });
        debouncedRefresh();
      },
      setFilters: (f) => {
        set({ filters: { ...get().filters, ...f } });
        get().refreshItems();
      },
      setSort: (s) => {
        set({ sort: { ...get().sort, ...s }, seed: Math.floor(Math.random() * 1e6) });
        get().refreshItems();
      },
      setLayout: (layout) => set({ layout }),
      setThumbSize: (thumbSize) => set({ thumbSize }),

      refresh: async () => {
        await Promise.all([get().refreshItems('keep'), get().refreshMeta()]);
      },

      refreshItems: async (mode = 'reset') => {
        const req = ++itemsRequest;
        const limit = mode === 'keep' ? Math.min(1000, Math.max(PAGE, get().items.length)) : PAGE;
        try {
          const { items, total } = await api.items({ ...queryParams(get()), offset: '0', limit: String(limit) });
          if (req !== itemsRequest) return;
          const ids = new Set(items.map((i) => i.id));
          // in 'keep' mode, selected items beyond the re-fetched window stay selected
          const selected = mode === 'keep' ? get().selected : new Set([...get().selected].filter((id) => ids.has(id)));
          set({ items, total, loading: false, loadingMore: false, selected });
        } catch (e) {
          if (req === itemsRequest) set({ loading: false });
          get().toast((e as Error).message, 'error');
        }
      },

      loadMore: async () => {
        const { items, total, loadingMore, loading } = get();
        if (loading || loadingMore || items.length >= total) return;
        const req = itemsRequest;
        set({ loadingMore: true });
        try {
          const page = await api.items({ ...queryParams(get()), offset: String(items.length), limit: String(PAGE) });
          if (req !== itemsRequest) return; // the view changed meanwhile
          const have = new Set(get().items.map((i) => i.id));
          set({ items: [...get().items, ...page.items.filter((i) => !have.has(i.id))], total: page.total, loadingMore: false });
        } catch (e) {
          set({ loadingMore: false });
          get().toast((e as Error).message, 'error');
        }
      },

      refreshMeta: async () => {
        try {
          const { stats, folders, tags } = await api.bootstrap();
          set({ stats, folders, tags });
          const { view } = get();
          if (view.kind === 'folder' && !folders.some((f) => f.id === view.id)) get().setView({ kind: 'all' });
        } catch (e) {
          get().toast((e as Error).message, 'error');
        }
      },

      select: (id, mode = 'single') => {
        const { selected, anchor, items } = get();
        if (mode === 'toggle') {
          const next = new Set(selected);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          set({ selected: next, anchor: id });
        } else if (mode === 'range' && anchor) {
          const a = items.findIndex((i) => i.id === anchor);
          const b = items.findIndex((i) => i.id === id);
          if (a < 0 || b < 0) return set({ selected: new Set([id]), anchor: id });
          const [lo, hi] = a < b ? [a, b] : [b, a];
          set({ selected: new Set(items.slice(lo, hi + 1).map((i) => i.id)) });
        } else {
          set({ selected: new Set([id]), anchor: id });
        }
      },
      setSelection: (ids) => set({ selected: new Set(ids) }),
      selectAll: async () => {
        const { items, total } = get();
        if (items.length >= total) {
          set({ selected: new Set(items.map((i) => i.id)) });
          return;
        }
        const { ids } = await api.itemIds(queryParams(get()));
        set({ selected: new Set(ids) });
      },
      clearSelection: () => set({ selected: new Set(), anchor: null }),

      updateItem: async (id, patch) => {
        set({ items: get().items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
        try {
          const updated = await api.updateItem(id, patch);
          set({ items: get().items.map((i) => (i.id === id ? updated : i)) });
          if (patch.tags || patch.folders) get().refreshMeta();
        } catch (e) {
          get().toast((e as Error).message, 'error');
          get().refreshItems('keep');
        }
      },

      batch: async (action, ids, extra = {}) => {
        if (!ids.length) return;
        try {
          await api.batch({ ids, action, ...extra });
          await get().refresh();
        } catch (e) {
          get().toast((e as Error).message, 'error');
        }
      },

      trashSelected: async () => {
        const { selected, view, batch, ask, toast } = get();
        const ids = [...selected];
        if (!ids.length) return;
        if (view.kind === 'trash') {
          const ok = await ask({
            title: `Delete ${ids.length} item${ids.length > 1 ? 's' : ''} permanently?`,
            message: 'Files will be removed from disk. This cannot be undone.',
            confirmLabel: 'Delete forever',
            danger: true,
          });
          if (ok) await batch('delete', ids);
        } else {
          await batch('trash', ids);
          toast(`Moved ${ids.length} item${ids.length > 1 ? 's' : ''} to Trash`);
        }
      },

      createFolder: async (parentId = null) => {
        try {
          const folder = await api.createFolder({ name: 'New Folder', parentId });
          if (parentId) set({ expanded: { ...get().expanded, [parentId]: true } });
          await get().refreshMeta();
          set({ renamingFolderId: folder.id });
          return folder;
        } catch (e) {
          get().toast((e as Error).message, 'error');
          return null;
        }
      },
      updateFolder: async (id, patch) => {
        set({ folders: get().folders.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
        try {
          await api.updateFolder(id, patch);
        } catch (e) {
          get().toast((e as Error).message, 'error');
        }
        await get().refreshMeta();
      },
      deleteFolder: async (id) => {
        const folder = get().folders.find((f) => f.id === id);
        const ok = await get().ask({
          title: `Delete “${folder?.name}”?`,
          message: 'The folder and its subfolders will be removed. Items inside stay in your library.',
          confirmLabel: 'Delete folder',
          danger: true,
        });
        if (!ok) return;
        await api.deleteFolder(id);
        await get().refresh();
      },

      importText: async (text, folderId) => {
        try {
          const job = await api.startImport({ text, folderId });
          set({ jobs: [...get().jobs, { ...job, kind: 'import' }] });
          pollJob(job.id);
          return true;
        } catch (e) {
          get().toast((e as Error).message, 'error');
          return false;
        }
      },

      uploadFiles: async (files, folderId) => {
        // .zip files that turn out to be Are.na exports are imported as channels; anything else is stored as-is
        const rest: File[] = [];
        for (const f of files) {
          if (!/\.zip$/i.test(f.name)) {
            rest.push(f);
            continue;
          }
          try {
            const job = await api.importArena(f, folderId);
            if (!job) {
              rest.push(f);
              continue;
            }
            set({ jobs: [...get().jobs, { ...job, kind: 'import' }] });
            get().toast(`Importing Are.na export “${f.name}”…`);
            pollJob(job.id);
          } catch (e) {
            get().toast((e as Error).message, 'error');
          }
        }
        files = rest;
        if (!files.length) return;
        const job: Job = {
          id: 'upload-' + Date.now(),
          kind: 'upload',
          status: 'running',
          createdAt: Date.now(),
          total: files.length,
          done: 0,
          imported: 0,
          skipped: 0,
          failed: 0,
          entries: files.map((f) => ({ label: f.name, kind: 'file', state: 'pending', error: null, itemIds: [] })),
        };
        set({ jobs: [...get().jobs, job] });
        const patchJob = (fn: (j: Job) => Job) =>
          set({ jobs: get().jobs.map((j) => (j.id === job.id ? fn(j) : j)) });

        let next = 0;
        let lastRefresh = 0;
        const worker = async () => {
          while (next < files.length) {
            const idx = next++;
            const file = files[idx];
            const form = new FormData();
            if (folderId) form.append('folderId', folderId);
            if (isVideoFile(file)) {
              const meta = await probeVideo(file);
              if (meta.width) form.append('width', String(meta.width));
              if (meta.height) form.append('height', String(meta.height));
              if (meta.duration) form.append('duration', String(meta.duration));
              if (meta.thumb) form.append('thumb', meta.thumb, 'thumb.jpg');
            }
            form.append('file', file, file.name);
            try {
              const item = await api.upload(form);
              patchJob((j) => ({
                ...j,
                done: j.done + 1,
                imported: j.imported + 1,
                entries: j.entries.map((e, i) => (i === idx ? { ...e, state: 'done', itemIds: [item.id] } : e)),
              }));
            } catch (e) {
              patchJob((j) => ({
                ...j,
                done: j.done + 1,
                failed: j.failed + 1,
                entries: j.entries.map((en, i) =>
                  i === idx ? { ...en, state: 'error', error: (e as Error).message } : en
                ),
              }));
            }
            if (Date.now() - lastRefresh > 1200) {
              lastRefresh = Date.now();
              get().refreshItems('keep');
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
        patchJob((j) => ({ ...j, status: 'done' }));
        await get().refresh();
        scheduleJobDismiss(job.id);
      },

      toast: (message, kind = 'info') => {
        const id = ++toastId;
        set({ toasts: [...get().toasts, { id, message, kind }] });
        setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 6000 : 3200);
      },

      ask: (opts) => new Promise((resolve) => set({ confirm: { ...opts, resolve } })),
    }),
    {
      name: 'abacus-prefs',
      partialize: (s) => ({
        layout: s.layout,
        thumbSize: s.thumbSize,
        showInfo: s.showInfo,
        sort: s.sort,
        expanded: s.expanded,
        inspectorOpen: s.inspectorOpen,
        tagsOpen: s.tagsOpen,
        autoplay: s.autoplay,
      }),
    }
  )
);

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
function debouncedRefresh() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => useStore.getState().refreshItems(), 180);
}

function scheduleJobDismiss(id: string) {
  setTimeout(() => {
    const { jobs, set } = useStore.getState();
    const job = jobs.find((j) => j.id === id);
    if (job && !job.failed) set({ jobs: jobs.filter((j) => j.id !== id) });
  }, 4500);
}

async function pollJob(id: string) {
  let lastImported = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    let job: Job;
    try {
      job = await api.job(id);
    } catch {
      return;
    }
    const { jobs, set, refreshItems, refresh } = useStore.getState();
    set({ jobs: jobs.map((j) => (j.id === id ? { ...job, kind: 'import' } : j)) });
    if (job.imported !== lastImported) {
      lastImported = job.imported;
      refreshItems('keep');
    }
    if (job.status === 'done') {
      await refresh();
      scheduleJobDismiss(id);
      return;
    }
  }
}
