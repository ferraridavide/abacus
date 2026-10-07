export type ItemType = 'image' | 'gif' | 'video' | 'bookmark' | 'file';
export type Source = 'upload' | 'x' | 'web' | 'arena';

export interface PaletteColor {
  hex: string;
  ratio: number;
}

export interface Item {
  id: string;
  name: string;
  type: ItemType;
  ext: string | null;
  mime: string | null;
  fileUrl: string | null;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  size: number;
  palette: PaletteColor[];
  url: string | null;
  mediaUrl: string | null;
  source: Source;
  author: string | null;
  authorHandle: string | null;
  authorAvatar: string | null;
  text: string | null;
  notes: string | null;
  rating: number;
  postedAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  tags: string[];
  folders: string[];
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  sort: number;
  createdAt: number;
  count: number;
  cover: string | null;
}

export interface TagCount {
  name: string;
  count: number;
}

export interface Stats {
  all: number;
  uncategorized: number;
  untagged: number;
  trash: number;
  totalSize: number;
}

export type View =
  | { kind: 'all' }
  | { kind: 'uncategorized' }
  | { kind: 'untagged' }
  | { kind: 'trash' }
  | { kind: 'folder'; id: string }
  | { kind: 'tag'; tag: string };

export type SortKey = 'created' | 'posted' | 'name' | 'size' | 'dimensions' | 'rating' | 'random';
export type AutoplayMode = 'never' | 'hover' | 'always';
export type LayoutMode = 'masonry' | 'justified' | 'grid';

export interface Filters {
  types: ItemType[];
  source: '' | Source;
  rating: number;
  color: string;
}

export interface JobEntry {
  label: string;
  kind: 'x' | 'url' | 'file';
  state: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  error: string | null;
  itemIds: string[];
}

export interface Job {
  id: string;
  status: 'running' | 'done';
  createdAt: number;
  total: number;
  done: number;
  imported: number;
  skipped: number;
  failed: number;
  entries: JobEntry[];
  kind?: 'import' | 'upload';
}
