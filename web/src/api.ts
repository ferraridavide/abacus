import type {
  ActiveProvider,
  ApiKey,
  CreatedApiKey,
  EmbeddingStatus,
  Folder,
  Item,
  ItemEmbedding,
  Job,
  ProviderSettings,
  ProviderTest,
  SearchScore,
  Stats,
  TagCount,
} from './types';

export type BatchAction =
  | 'trash'
  | 'restore'
  | 'delete'
  | 'addTags'
  | 'removeTags'
  | 'addToFolder'
  | 'moveToFolder'
  | 'removeFromFolder';

export type ItemPatch = Partial<Pick<Item, 'name' | 'description' | 'notes' | 'rating' | 'url' | 'tags' | 'folders'>>;
export type FolderPatch = Partial<Pick<Folder, 'name' | 'color' | 'parentId' | 'sort'>>;
export type ServicePatch = { enabled?: boolean; values?: Record<string, string> };

/**
 * Everything the app asks of a library. The Abacus server is one implementation (backends/http); the demo, which
 * keeps the library in the browser, is another (backends/demo). main.tsx picks one and provides it before rendering.
 */
export interface Backend {
  bootstrap(): Promise<{ stats: Stats; folders: Folder[]; tags: TagCount[] }>;
  items(params: Record<string, string>): Promise<{
    items: Item[];
    total: number;
    offset: number;
    ranking?: 'similarity';
    scores?: Record<string, SearchScore>;
  }>;
  itemIds(params: Record<string, string>): Promise<{ ids: string[] }>;
  updateItem(id: string, patch: ItemPatch): Promise<Item>;
  batch(body: { ids: string[]; action: BatchAction; tags?: string[]; folderId?: string; fromFolderId?: string }): Promise<{ ok: boolean }>;
  emptyTrash(): Promise<{ ok: boolean }>;
  createFolder(body: { name: string; parentId?: string | null; color?: string | null }): Promise<Folder>;
  updateFolder(id: string, patch: FolderPatch): Promise<Folder>;
  deleteFolder(id: string): Promise<{ ok: boolean }>;
  startImport(body: { text: string; folderId?: string; tags?: string[] }): Promise<Job>;
  importSources(): Promise<{ providers: ActiveProvider[] }>;
  apiKeys(): Promise<ApiKey[]>;
  createApiKey(name: string): Promise<CreatedApiKey>;
  deleteApiKey(id: string): Promise<{ ok: boolean }>;
  providerSettings(): Promise<ProviderSettings[]>;
  updateProvider(id: string, body: ServicePatch): Promise<ProviderSettings>;
  testProvider(id: string, values: Record<string, string>): Promise<ProviderTest>;
  embeddingSettings(): Promise<ProviderSettings>;
  updateEmbeddings(body: ServicePatch): Promise<ProviderSettings>;
  testEmbeddings(values: Record<string, string>): Promise<ProviderTest>;
  embeddingStatus(): Promise<EmbeddingStatus>;
  reprocessEmbeddings(): Promise<EmbeddingStatus>;
  itemEmbedding(id: string): Promise<ItemEmbedding>;
  reprocessItemEmbedding(id: string): Promise<ItemEmbedding>;
  job(id: string): Promise<Job>;
  /** Resolves to null when the zip isn't an Are.na export. */
  importArena(file: File, folderId?: string): Promise<Job | null>;
  upload(form: FormData): Promise<Item>;
}

/** A backend rejects with this when it can't do what was asked at all, such as importing links in the demo. */
export class UnavailableError extends Error {
  readonly unavailable = true;
}

let provided: Backend | null = null;
let onUnavailable: (message: string) => void = () => {};

/** Choose the backend the app talks to. Call it once, before the app renders. */
export function provideBackend(backend: Backend, opts: { onUnavailable?: (message: string) => void } = {}) {
  provided = backend;
  if (opts.onUnavailable) onUnavailable = opts.onUnavailable;
}

/**
 * The provided backend. Each method is looked up when it's called, so modules may hold on to `api.x` before
 * provideBackend() runs. An UnavailableError is reported through `onUnavailable` and then rejected as usual.
 */
export const api = new Proxy({} as Backend, {
  get(_, key: keyof Backend) {
    return (...args: unknown[]) => {
      if (!provided) throw new Error('No backend provided');
      return (provided[key] as (...a: unknown[]) => Promise<unknown>)(...args).catch((e: unknown) => {
        if (e instanceof UnavailableError) onUnavailable(e.message);
        throw e;
      });
    };
  },
});
