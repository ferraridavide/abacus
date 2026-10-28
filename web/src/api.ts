import type {
  ActiveProvider,
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

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `Request failed (${res.status})`);
  return data as T;
}

export type BatchAction =
  | 'trash'
  | 'restore'
  | 'delete'
  | 'addTags'
  | 'removeTags'
  | 'addToFolder'
  | 'moveToFolder'
  | 'removeFromFolder';

export const api = {
  bootstrap: () => request<{ stats: Stats; folders: Folder[]; tags: TagCount[] }>('GET', '/api/bootstrap'),
  items: (params: Record<string, string>) =>
    request<{ items: Item[]; total: number; offset: number; ranking?: 'similarity'; scores?: Record<string, SearchScore> }>(
      'GET',
      '/api/items?' + new URLSearchParams(params).toString()
    ),
  itemIds: (params: Record<string, string>) =>
    request<{ ids: string[] }>('GET', '/api/items/ids?' + new URLSearchParams(params).toString()),
  updateItem: (id: string, patch: Partial<Pick<Item, 'name' | 'description' | 'notes' | 'rating' | 'url' | 'tags' | 'folders'>>) =>
    request<Item>('PATCH', `/api/items/${id}`, patch),
  batch: (body: { ids: string[]; action: BatchAction; tags?: string[]; folderId?: string; fromFolderId?: string }) =>
    request<{ ok: boolean }>('POST', '/api/items/batch', body),
  emptyTrash: () => request<{ ok: boolean }>('DELETE', '/api/trash'),
  createFolder: (body: { name: string; parentId?: string | null; color?: string | null }) =>
    request<Folder>('POST', '/api/folders', body),
  updateFolder: (id: string, patch: Partial<Pick<Folder, 'name' | 'color' | 'parentId' | 'sort'>>) =>
    request<Folder>('PATCH', `/api/folders/${id}`, patch),
  deleteFolder: (id: string) => request<{ ok: boolean }>('DELETE', `/api/folders/${id}`),
  startImport: (body: { text: string; folderId?: string; tags?: string[] }) => request<Job>('POST', '/api/import', body),
  importSources: () => request<{ providers: ActiveProvider[] }>('GET', '/api/import/sources'),
  providerSettings: () => request<ProviderSettings[]>('GET', '/api/settings/providers'),
  updateProvider: (id: string, body: { enabled?: boolean; values?: Record<string, string> }) =>
    request<ProviderSettings>('PATCH', `/api/settings/providers/${id}`, body),
  testProvider: (id: string, values: Record<string, string>) =>
    request<ProviderTest>('POST', `/api/settings/providers/${id}/test`, { values }),
  embeddingSettings: () => request<ProviderSettings>('GET', '/api/settings/embeddings'),
  updateEmbeddings: (body: { enabled?: boolean; values?: Record<string, string> }) =>
    request<ProviderSettings>('PATCH', '/api/settings/embeddings', body),
  testEmbeddings: (values: Record<string, string>) =>
    request<ProviderTest>('POST', '/api/settings/embeddings/test', { values }),
  embeddingStatus: () => request<EmbeddingStatus>('GET', '/api/embeddings/status'),
  reprocessEmbeddings: () => request<EmbeddingStatus>('POST', '/api/embeddings/reprocess'),
  itemEmbedding: (id: string) => request<ItemEmbedding>('GET', `/api/items/${id}/embedding`),
  reprocessItemEmbedding: (id: string) => request<ItemEmbedding>('POST', `/api/items/${id}/embedding`),
  job: (id: string) => request<Job>('GET', `/api/jobs/${id}`),
  /** Returns null when the zip isn't an Are.na export. */
  importArena: async (file: File, folderId?: string): Promise<Job | null> => {
    const form = new FormData();
    if (folderId) form.append('folderId', folderId);
    form.append('file', file, file.name);
    const res = await fetch('/api/import/arena', { method: 'POST', body: form });
    if (res.status === 422) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Import failed (${res.status})`);
    return data;
  },
  upload: async (form: FormData): Promise<Item> => {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
    return data;
  },
};
