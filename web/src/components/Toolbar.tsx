import { useEffect, useRef, type ReactNode } from 'react';
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  Columns3,
  Download,
  Folder as FolderIcon,
  Grid2x2,
  Hash,
  Inbox,
  LayoutGrid,
  ListFilter,
  PanelRight,
  Rows3,
  Search,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import type { ItemType, LayoutMode, SortKey } from '../types';
import { cls, Kbd, Popover, XLogo } from './ui';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'created', label: 'Date added' },
  { key: 'posted', label: 'Date posted' },
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'File size' },
  { key: 'dimensions', label: 'Dimensions' },
  { key: 'rating', label: 'Rating' },
  { key: 'random', label: 'Random' },
];

const TYPES: { key: ItemType; label: string }[] = [
  { key: 'image', label: 'Images' },
  { key: 'gif', label: 'GIFs' },
  { key: 'video', label: 'Videos' },
  { key: 'bookmark', label: 'Posts & links' },
  { key: 'file', label: 'Other files' },
];

const LAYOUTS: { key: LayoutMode; icon: ReactNode; label: string }[] = [
  { key: 'masonry', icon: <Columns3 size={15} />, label: 'Waterfall' },
  { key: 'justified', icon: <Rows3 size={15} />, label: 'Justified' },
  { key: 'grid', icon: <Grid2x2 size={15} />, label: 'Grid' },
];

export function Toolbar() {
  const view = useStore((s) => s.view);
  const folders = useStore((s) => s.folders);
  const count = useStore((s) => s.total);
  const query = useStore((s) => s.query);
  const filters = useStore((s) => s.filters);
  const sort = useStore((s) => s.sort);
  const layout = useStore((s) => s.layout);
  const thumbSize = useStore((s) => s.thumbSize);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const showInfo = useStore((s) => s.showInfo);
  const trashCount = useStore((s) => s.stats.trash);
  const { setQuery, setFilters, setSort, setLayout, setThumbSize, set, ask, refresh } = useStore.getState();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, [contenteditable]');
      if (((e.metaKey || e.ctrlKey) && e.key === 'f') || (e.key === '/' && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  let title = 'All';
  let icon = <LayoutGrid size={17} />;
  if (view.kind === 'uncategorized') [title, icon] = ['Uncategorized', <Inbox size={17} />];
  if (view.kind === 'untagged') [title, icon] = ['Untagged', <Tag size={17} />];
  if (view.kind === 'trash') [title, icon] = ['Trash', <Trash2 size={17} />];
  if (view.kind === 'tag') [title, icon] = [view.tag, <Hash size={17} />];
  if (view.kind === 'folder') {
    const f = folders.find((x) => x.id === view.id);
    title = f?.name || 'Folder';
    icon = <FolderIcon size={17} style={{ color: f?.color || undefined }} />;
  }

  const activeFilters =
    filters.types.length + (filters.source ? 1 : 0) + (filters.rating ? 1 : 0) + (filters.color ? 1 : 0);

  return (
    <header className="toolbar">
      <div className="view-title">
        <span className="view-icon">{icon}</span>
        <h1>{title}</h1>
        <span className="view-count">{count.toLocaleString()}</span>
      </div>

      <div className="search">
        <Search size={15} />
        <input
          ref={searchRef}
          value={query}
          placeholder="Search names, notes, tags, @authors…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              e.currentTarget.blur();
            }
          }}
        />
        {query ? (
          <button className="icon-btn xs" onClick={() => setQuery('')}>
            <X size={13} />
          </button>
        ) : (
          <Kbd>/</Kbd>
        )}
      </div>

      <div className="toolbar-right">
        {filters.color && (
          <button className="color-chip" onClick={() => setFilters({ color: '' })} title="Clear colour filter">
            <span style={{ background: filters.color }} />
            <X size={12} />
          </button>
        )}

        <Popover
          align="right"
          width={240}
          trigger={(open, toggle) => (
            <button className={cls('tool-btn', (open || activeFilters > 0) && 'active')} onClick={toggle}>
              <ListFilter size={15} />
              <span>Filter</span>
              {activeFilters > 0 && <span className="pill">{activeFilters}</span>}
            </button>
          )}
        >
          {() => (
            <div className="menu-list">
              <div className="menu-label">Type</div>
              {TYPES.map((t) => {
                const on = filters.types.includes(t.key);
                return (
                  <button
                    key={t.key}
                    className="menu-item"
                    onClick={() =>
                      setFilters({ types: on ? filters.types.filter((x) => x !== t.key) : [...filters.types, t.key] })
                    }
                  >
                    <span className={cls('checkbox', on && 'on')}>{on && <Check size={11} />}</span>
                    {t.label}
                  </button>
                );
              })}
              <div className="menu-sep" />
              <div className="menu-label">Source</div>
              <div className="segmented full">
                {(
                  [
                    ['', 'Any'],
                    ['x', 'X'],
                    ['web', 'Web'],
                    ['arena', 'Are.na'],
                    ['upload', 'Upload'],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={cls(filters.source === k && 'on')} onClick={() => setFilters({ source: k })}>
                    {k === 'x' ? <XLogo size={11} /> : label}
                  </button>
                ))}
              </div>
              <div className="menu-sep" />
              <div className="menu-label">Minimum rating</div>
              <div className="stars-row">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    className={cls('star', n <= filters.rating && 'on')}
                    onClick={() => setFilters({ rating: filters.rating === n ? 0 : n })}
                  >
                    <Star size={16} />
                  </button>
                ))}
              </div>
              {activeFilters > 0 && (
                <>
                  <div className="menu-sep" />
                  <button
                    className="menu-item dim"
                    onClick={() => setFilters({ types: [], source: '', rating: 0, color: '' })}
                  >
                    <X size={14} /> Clear all filters
                  </button>
                </>
              )}
            </div>
          )}
        </Popover>

        <Popover
          align="right"
          width={210}
          trigger={(open, toggle) => (
            <button className={cls('tool-btn', open && 'active')} onClick={toggle} title="Sort">
              {sort.dir === 'desc' ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
              <span>{SORTS.find((s) => s.key === sort.by)?.label}</span>
            </button>
          )}
        >
          {(close) => (
            <div className="menu-list">
              <div className="menu-label">Sort by</div>
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  className="menu-item"
                  onClick={() => {
                    setSort({ by: s.key });
                    close();
                  }}
                >
                  <span className="check-slot">{sort.by === s.key && <Check size={14} />}</span>
                  {s.label}
                </button>
              ))}
              <div className="menu-sep" />
              <div className="segmented full">
                <button className={cls(sort.dir === 'desc' && 'on')} onClick={() => setSort({ dir: 'desc' })}>
                  Descending
                </button>
                <button className={cls(sort.dir === 'asc' && 'on')} onClick={() => setSort({ dir: 'asc' })}>
                  Ascending
                </button>
              </div>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => set({ showInfo: !showInfo })}>
                <span className={cls('checkbox', showInfo && 'on')}>{showInfo && <Check size={11} />}</span>
                Show names & info
              </button>
            </div>
          )}
        </Popover>

        <div className="segmented">
          {LAYOUTS.map((l) => (
            <button key={l.key} className={cls(layout === l.key && 'on')} title={l.label} onClick={() => setLayout(l.key)}>
              {l.icon}
            </button>
          ))}
        </div>

        <input
          className="size-slider"
          type="range"
          min={120}
          max={520}
          step={10}
          value={thumbSize}
          title="Thumbnail size"
          onChange={(e) => setThumbSize(Number(e.target.value))}
        />

        {view.kind === 'trash' && trashCount > 0 && (
          <button
            className="tool-btn danger"
            onClick={async () => {
              const ok = await ask({
                title: 'Empty Trash?',
                message: `${trashCount} item${trashCount > 1 ? 's' : ''} will be permanently deleted from disk.`,
                confirmLabel: 'Empty Trash',
                danger: true,
              });
              if (ok) {
                await api.emptyTrash();
                refresh();
              }
            }}
          >
            <Trash2 size={15} /> Empty
          </button>
        )}

        <button className="btn primary" onClick={() => set({ importOpen: true })}>
          <Download size={15} /> <span>Import</span>
        </button>
        <button
          className={cls('icon-btn', inspectorOpen && 'active')}
          title="Toggle inspector"
          onClick={() => set({ inspectorOpen: !inspectorOpen })}
        >
          <PanelRight size={17} />
        </button>
      </div>
    </header>
  );
}
