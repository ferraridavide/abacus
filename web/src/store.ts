import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, type BatchAction, type FolderPatch, type ItemPatch } from './api';
import type {
  Appearance,
  AppearanceChoice,
  AutoplayMode,
  Filters,
  Folder,
  FolderBoard,
  Item,
  Job,
  LayoutMode,
  SearchScore,
  SortKey,
  Stats,
  TagCount,
  View,
} from './types';
import { isVideoFile, probeVideo } from './lib/upload';
import { boardVisual } from './lib/board';
import { applyAppearance, cacheAppearance, cachedAppearance, resolveAppearance } from './lib/theme';

export interface Toast {
  id: number;
  message: string;
  /** 'demo': something the demo can't do */
  kind: 'info' | 'success' | 'error' | 'demo';
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
  /** the sidebar collapsed on wide screens (narrow screens use the drawer) */
  sidebarHidden: boolean;
  tagsOpen: boolean;
  autoplay: AutoplayMode;
  /** the instance theme, owned by the server so the extension can mirror it */
  appearance: Appearance;

  // library
  view: View;
  query: string;
  filters: Filters;
  seed: number;
  items: Item[];
  /** matches on the server; `items` holds the pages loaded so far */
  total: number;
  /** 'similarity' when semantic search ranked the results, overriding the sort */
  ranking: 'similarity' | null;
  /** semantic search scores of the loaded items, by id */
  scores: Record<string, SearchScore>;
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
  /** the sidebar as a drawer, on narrow screens */
  sidebarOpen: boolean;
  /** the inspector as a bottom sheet, on narrow screens: the selection, or the current folder or library */
  details: 'selection' | 'view' | null;
  folderPicker: { mode: 'add' | 'move'; ids: string[] } | null;
  contextMenu: ContextMenuState | null;
  /**
   * The board on screen: the items picked for it, or a whole folder with the arrangement saved on it.
   * A folder board loads its items (`status: 'loading'`) before the canvas can show them.
   */
  board: { ids: string[]; folderId?: string; status: 'loading' | 'ready'; saved: FolderBoard | null } | null;
  /** the images a folder board shows, in folder order */
  boardItems: Item[];
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
  /** Read the theme from the server (or the demo's storage) and paint it. */
  refreshAppearance: () => Promise<void>;
  /** Paint a theme change right away without saving it (the custom accent while its colour well is dragged). */
  previewAppearance: (patch: Partial<AppearanceChoice>) => void;
  /** Change the instance theme: patched on the server, cached here, painted immediately. */
  setAppearance: (patch: Partial<AppearanceChoice>) => Promise<void>;
  refresh: () => Promise<void>;
  /** 'reset' starts again from page one; 'keep' re-fetches the pages already loaded (after edits, imports). */
  refreshItems: (mode?: 'reset' | 'keep') => Promise<void>;
  loadMore: () => Promise<void>;
  refreshMeta: () => Promise<void>;

  select: (id: string, mode?: 'single' | 'toggle' | 'range') => void;
  setSelection: (ids: string[]) => void;
  selectAll: () => Promise<void>;
  clearSelection: () => void;
  /** Open the board; defaults to the current selection, in grid order. */
  openBoard: (ids?: string[]) => void;
  /** Open a folder's board: every image it holds, arranged as it was last left and saved. */
  openFolderBoard: (folderId: string) => Promise<void>;
  closeBoard: () => void;

  updateItem: (id: string, patch: ItemPatch) => Promise<void>;
  batch: (action: BatchAction, ids: string[], extra?: { tags?: string[]; folderId?: string; fromFolderId?: string }) => Promise<void>;
  trashSelected: () => Promise<void>;

  createFolder: (parentId?: string | null) => Promise<Folder | null>;
  updateFolder: (id: string, patch: FolderPatch) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;

  importText: (text: string, folderId?: string) => Promise<boolean>;
  uploadFiles: (files: File[], folderId?: string) => Promise<void>;

  toast: (message: string, kind?: Toast['kind']) => void;
  ask: (opts: Omit<ConfirmState, 'resolve'>) => Promise<boolean>;
}

let itemsRequest = 0;
let appearanceRequest = 0;
const PAGE = 200;
/** bumps whenever the board is opened or closed, so a folder's items can't land on a board that moved on */
let boardLoad = 0;
const BOARD_PAGE = 1000;

/** Every item in a folder, oldest first: a new board's waterfall then looks the same from one visit to the next. */
async function folderBoardItems(folderId: string): Promise<Item[]> {
  const all: Item[] = [];
  for (;;) {
    const page = await api.items({
      view: 'folder',
      folderId,
      sort: 'created',
      dir: 'asc',
      limit: String(BOARD_PAGE),
      offset: String(all.length),
    });
    all.push(...page.items);
    if (!page.items.length || all.length >= page.total) return all;
  }
}

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
      // two columns on a phone, until the size is changed
      thumbSize: window.matchMedia('(max-width: 760px)').matches ? 150 : 240,
      showInfo: true,
      sort: { by: 'created', dir: 'desc' },
      expanded: {},
      inspectorOpen: true,
      sidebarHidden: false,
      tagsOpen: true,
      autoplay: 'hover',
      appearance: cachedAppearance() ?? resolveAppearance(),

      view: { kind: 'all' },
      query: '',
      filters: { types: [], source: '', rating: 0, color: '' },
      seed: 1,
      items: [],
      total: 0,
      ranking: null,
      scores: {},
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
      sidebarOpen: false,
      details: null,
      folderPicker: null,
      contextMenu: null,
      board: null,
      boardItems: [],
      confirm: null,
      renamingFolderId: null,
      jobs: [],
      toasts: [],

      set: (patch) => set(patch),

      setView: (view) => {
        set({ view, selected: new Set(), anchor: null, items: [], total: 0, loading: true, sidebarOpen: false });
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

      refreshAppearance: async () => {
        try {
          const appearance = await api.appearance();
          applyAppearance(appearance);
          cacheAppearance(appearance);
          set({ appearance });
        } catch {
          // offline or a stale build: keep the cached theme rather than flashing the default
        }
      },

      previewAppearance: (patch) => {
        const current = get().appearance;
        const local = resolveAppearance({
          scheme: patch.scheme ?? current.scheme,
          theme: patch.theme ?? current.theme,
          corners: patch.corners ?? current.corners,
          oled: patch.oled ?? current.oled,
          accent: patch.accent ?? current.accent.hex,
        });
        applyAppearance(local);
        set({ appearance: local });
      },

      setAppearance: async (patch) => {
        get().previewAppearance(patch);
        const req = ++appearanceRequest;
        try {
          const appearance = await api.updateAppearance(patch);
          // a newer change is already on its way: its answer is the one to paint
          if (req !== appearanceRequest) return;
          applyAppearance(appearance);
          cacheAppearance(appearance);
          set({ appearance });
        } catch (e) {
          if (req !== appearanceRequest) return;
          get().toast((e as Error).message, 'error');
          await get().refreshAppearance();
        }
      },

      refreshItems: async (mode = 'reset') => {
        const req = ++itemsRequest;
        const limit = mode === 'keep' ? Math.min(1000, Math.max(PAGE, get().items.length)) : PAGE;
        try {
          const { items, total, ranking, scores } = await api.items({
            ...queryParams(get()),
            offset: '0',
            limit: String(limit),
          });
          if (req !== itemsRequest) return;
          const ids = new Set(items.map((i) => i.id));
          // in 'keep' mode, selected items beyond the re-fetched window stay selected
          const selected = mode === 'keep' ? get().selected : new Set([...get().selected].filter((id) => ids.has(id)));
          set({ items, total, ranking: ranking ?? null, scores: scores ?? {}, loading: false, loadingMore: false, selected });
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
          set({
            items: [...get().items, ...page.items.filter((i) => !have.has(i.id))],
            total: page.total,
            scores: page.scores ? { ...get().scores, ...page.scores } : get().scores,
            loadingMore: false,
          });
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

      openBoard: (ids) => {
        const list = ids ?? [...get().selected];
        if (!list.length) return;
        boardLoad++;
        const order = new Map(get().items.map((item, i) => [item.id, i]));
        const ordered = [...list].sort(
          (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER)
        );
        set({
          board: { ids: ordered, status: 'ready', saved: null },
          boardItems: [],
          contextMenu: null,
          viewerId: null,
          details: null,
          sidebarOpen: false,
        });
      },

      openFolderBoard: async (folderId) => {
        const token = ++boardLoad;
        set({
          board: { ids: [], folderId, status: 'loading', saved: null },
          boardItems: [],
          selected: new Set(),
          anchor: null,
          contextMenu: null,
          viewerId: null,
          details: null,
          sidebarOpen: false,
        });
        try {
          const [items, saved] = await Promise.all([folderBoardItems(folderId), api.folderBoard(folderId)]);
          if (token !== boardLoad) return;
          const visuals = items.filter((item) => boardVisual(item));
          set({ boardItems: visuals, board: { ids: visuals.map((i) => i.id), folderId, status: 'ready', saved } });
        } catch (e) {
          if (token !== boardLoad) return;
          set({ board: null, boardItems: [] });
          get().toast((e as Error).message, 'error');
        }
      },

      closeBoard: () => {
        boardLoad++;
        set({ board: null, boardItems: [] });
      },

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
        // the same message twice at once says nothing new (a failed call can be reported by the backend and the caller)
        if (get().toasts.some((t) => t.message === message)) return;
        const id = ++toastId;
        set({ toasts: [...get().toasts, { id, message, kind }] });
        setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'info' || kind === 'success' ? 3200 : 6000);
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
        sidebarHidden: s.sidebarHidden,
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

const LIVE_SYNC_MS = 2000;

/**
 * Keep the library fresh when something else adds to it (the browser extension, scripts): watch the server's change
 * token while the tab is visible and refresh when it changes. Returns a function that stops watching.
 */
export function startLiveSync(): () => void {
  // the demo library lives in this tab, so nothing can change behind its back
  if (import.meta.env.MODE === 'demo' || import.meta.env.VITE_DEMO === 'true') return () => {};
  let baseline: string | null = null;
  let library: string | undefined;
  let busy = false;
  let stopped = false;

  const check = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const next = await api.revision();
      const { revision } = next;
      if (stopped) return;
      if (baseline === null) {
        baseline = revision;
        library = next.library;
        return;
      }
      if (next.library !== library) {
        // another library entirely: nothing on screen belongs to it any more
        library = next.library;
        baseline = revision;
        useStore.getState().set({ viewerId: null, board: null, boardItems: [], contextMenu: null, folderPicker: null });
        useStore.getState().setView({ kind: 'all' });
        await useStore.getState().refreshMeta();
        useStore.getState().toast(`Library switched to ${library}`, 'success');
        return;
      }
      if (revision === baseline) return;
      baseline = revision;
      const before = useStore.getState().stats.all;
      await useStore.getState().refresh();
      const { stats, jobs, toast } = useStore.getState();
      const added = stats.all - before;
      // a running local import or upload announces itself, so only outside additions get a toast
      if (added > 0 && !jobs.some((j) => j.status !== 'done')) toast(`${added} new item${added > 1 ? 's' : ''} added`, 'success');
    } catch {
      /* offline or restarting: try again on the next tick, without nagging */
    } finally {
      busy = false;
    }
  };
  const checkIfVisible = () => {
    if (document.visibilityState === 'visible') void check();
  };

  void check();
  const timer = setInterval(checkIfVisible, LIVE_SYNC_MS);
  document.addEventListener('visibilitychange', checkIfVisible);
  window.addEventListener('focus', checkIfVisible);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', checkIfVisible);
    window.removeEventListener('focus', checkIfVisible);
  };
}
