export type ItemType = 'image' | 'gif' | 'video' | 'bookmark' | 'file';
export type Source = 'upload' | 'x' | 'social' | 'web' | 'arena' | 'api';

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
  /** Progressive JPEG XL thumbnail, while that setting is on and it has been made. */
  thumbJxlUrl?: string | null;
  /** Screen-sized progressive JPEG XL preview of an image bigger than its thumbnail, under the same setting. */
  previewJxlUrl?: string | null;
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
  description: string | null;
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

/** An enabled import provider and the sites it adds to link imports. */
export interface ActiveProvider {
  id: string;
  name: string;
  sites: string[];
}

export interface ProviderField {
  key: string;
  label: string;
  type: 'url' | 'text' | 'secret' | 'select';
  required: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  /** a heading the form sorts the field under */
  group?: string;
}

/** An import provider's (or the embeddings service's) settings. Secret values come back as whether they're set. */
export interface ProviderSettings {
  id: string;
  name: string;
  description: string;
  docsUrl?: string;
  fields: ProviderField[];
  enabled: boolean;
  values: Record<string, string | boolean>;
}

export interface ProviderTest {
  ok: boolean;
  message: string;
  sites?: string[];
}

/** Background embedding of the library, for semantic search. */
export interface StorageUsage {
  /** bytes, all parts together */
  total: number;
  db: { bytes: number; count: number };
  /** original files */
  files: { bytes: number; count: number };
  webp: { bytes: number; count: number };
  jxl: { bytes: number; count: number };
  /** screen-sized JPEG XL previews */
  preview: { bytes: number; count: number };
  /** the disk holding the library */
  disk: { size: number; free: number } | null;
}

export interface ThumbnailSettings {
  /** progressive JPEG XL thumbnails, next to the webp ones */
  jxl: boolean;
  /** screen-sized JPEG XL previews for the full-screen viewer, while `jxl` is on */
  previews: boolean;
  state: 'off' | 'running' | 'complete';
  /** items with a thumbnail */
  total: number;
  /** of those, ones whose JPEG XL thumbnail (and preview, when on) is made or failed */
  processed: number;
  failed: number;
  lastFailure: string | null;
}

export interface EmbeddingStatus {
  /** 'error': the service can't be reached; it's tried again every minute */
  state: 'off' | 'running' | 'complete' | 'error';
  total: number;
  done: number;
  failed: number;
  pending: number;
  /** embedded images and texts (an item can have both) */
  images: number;
  texts: number;
  error: string | null;
  lastFailure?: string | null;
}

export type EmbeddingKind = 'image' | 'text';

/** How close an item came to a semantic search, and through what. */
export interface SearchScore {
  score: number;
  kind: EmbeddingKind;
  /** it also contains the search words, which ranks it a little higher */
  textMatch: boolean;
}

export interface EmbeddingPart {
  kind: EmbeddingKind;
  state: 'pending' | 'done' | 'failed';
  dimensions?: number;
  error?: string | null;
  at?: number;
}

/** One item's embeddings: its image (when it has one) and its text (when there's any to go by). */
export interface ItemEmbedding {
  state: 'off' | 'pending' | 'done' | 'failed';
  model?: string;
  parts: EmbeddingPart[];
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

export interface ApiKey {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface CreatedApiKey extends ApiKey {
  token: string;
}

export interface AccentPreset {
  id: string;
  label: string;
  hex: string;
}

/** Every colour a surface needs, as custom-property values (`panel2` becomes `--panel-2`). */
export interface Palette {
  bg: string;
  panel: string;
  panel2: string;
  panel3: string;
  raise: string;
  hover: string;
  track: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  textFaint: string;
  overlay: string;
  float: string;
  scrim: string;
  stage: string;
  checkerA: string;
  checkerB: string;
  shadow: string;
  /** multiplies the alpha of the stylesheet's own drop shadows */
  shade: string;
  danger: string;
  ok: string;
}

export type Scheme = 'light' | 'dark' | 'system';

/** The choices, as stored on the server. */
export interface AppearanceChoice {
  scheme: Scheme;
  theme: string;
  corners: 'squared' | 'rounded';
  oled: boolean;
  accent: string;
}

/** A theme in the theme list, with the two preview colours the settings page draws. */
export interface ThemeChoice {
  id: string;
  label: string;
  preview: {
    light: { bg: string; panel: string; text: string };
    dark: { bg: string; panel: string; text: string };
  };
}

/** The instance theme, as returned by the server: the choices plus every palette they resolve to. */
export interface Appearance extends Omit<AppearanceChoice, 'accent'> {
  accent: AccentPreset & { hex2: string; ink: string; soft: string; text: { light: string; dark: string } };
  palettes: { light: Palette; dark: Palette; oled: Palette };
  themes: ThemeChoice[];
  presets: AccentPreset[];
}
