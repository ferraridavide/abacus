import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  ChevronDown,
  Columns3,
  Download,
  Folder as FolderIcon,
  Grid2x2,
  Hash,
  Inbox,
  LayoutGrid,
  ListFilter,
  Menu,
  PanelLeft,
  PanelRight,
  Rows3,
  Search,
  SlidersHorizontal,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import type { ItemType, LayoutMode, SortKey } from '../types';
import { cls, Kbd, Popover, useCompact, usePhone, XLogo } from './ui';

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

/**
 * Suggested swatches — a short starting set; the chevron opens a picker for
 * any other colour. Matching always runs against the pixels in each image.
 */
const RECOMMENDED_COLORS = [
  '#ffffff',
  '#808080',
  '#000000',
  '#e53935',
  '#fb8c00',
  '#43a047',
  '#1e88e5',
  '#8e24aa',
];

function hexToHsv(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex(h: number, s: number, v: number) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const byte = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return '#' + byte(r) + byte(g) + byte(b);
}

/** #RGB, #RRGGBB, or rgb(r, g, b) → #rrggbb. */
function parseColorInput(input: string): string | null {
  const raw = input.trim();
  const rgb = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) {
    const parts = rgb.slice(1, 4).map(Number);
    if (parts.some((n) => n > 255)) return null;
    return (
      '#' +
      parts
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('')
    );
  }
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) return '#' + hex.split('').map((c) => c + c).join('').toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(hex)) return '#' + hex.toLowerCase();
  return null;
}

const LAYOUTS: { key: LayoutMode; icon: ReactNode; label: string }[] = [
  { key: 'masonry', icon: <Columns3 size={15} />, label: 'Waterfall' },
  { key: 'justified', icon: <Rows3 size={15} />, label: 'Justified' },
  { key: 'grid', icon: <Grid2x2 size={15} />, label: 'Grid' },
];

/**
 * The classic image-editor colour dropdown: a saturation/value field, a hue
 * slider, and a readout of the colour number. Dragging previews the colour and
 * applies it when the gesture ends — a search is a database query, so one per
 * pixel of dragging would leave the grid minutes behind the cursor.
 */
function ColorPicker({ color, onPick }: { color: string; onPick: (hex: string) => void }) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState(() => hexToHsv(color || '#ff0000'));
  // the colour under the cursor during a drag, before it is applied
  const [draft, setDraft] = useState<string | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  const drag = useRef<'field' | 'hue' | null>(null);
  const dragged = useRef<string | null>(null);
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    setHsv(hexToHsv(color || '#ff0000'));
    setDraft(null);
  }, [color]);

  // The filter menu sits over the grid, so an in-flow dropdown is painted over
  // and looks like the chevron did nothing. Float the picker above everything.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = wrap.current?.getBoundingClientRect();
      const box = panel.current;
      if (!anchor || !box) return;
      const width = box.offsetWidth;
      const height = box.offsetHeight;
      // Sit beside the filter menu, never over the preset swatches inside it.
      const menu = wrap.current?.closest('.popover')?.getBoundingClientRect();
      const beside = (menu?.right ?? anchor.right) + 8;
      const left = beside + width <= window.innerWidth - 8 ? beside : Math.max(8, (menu?.left ?? anchor.left) - width - 8);
      const top = Math.min(Math.max(8, menu?.top ?? anchor.top), window.innerHeight - height - 8);
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      // a preset swatch picks its colour and keeps the picker open
      if (target?.closest('.color-swatch')) return;
      if (!wrap.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // capture: the preset button stops the event, so a bubble listener never sees it
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A click has to count too, not only a drag: pointerdown starts the gesture
  // and the same handler reads the position, so one click picks that colour.
  const pickAt = (e: PointerEvent) => {
    if (!drag.current) return;
    const box = (drag.current === 'field' ? field.current : hue.current)?.getBoundingClientRect();
    if (!box) return;
    const next = { ...hsvRef.current };
    if (drag.current === 'field') {
      next.s = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
      next.v = Math.min(1, Math.max(0, 1 - (e.clientY - box.top) / box.height));
    } else {
      next.h = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * 360;
    }
    setHsv(next);
    dragged.current = hsvToHex(next.h, next.s, next.v);
    setDraft(dragged.current);
  };
  useEffect(() => {
    const move = (e: PointerEvent) => pickAt(e);
    // One search per gesture: apply the colour the drag ended on.
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      const hex = dragged.current;
      dragged.current = null;
      if (hex) onPickRef.current(hex);
    };
    const cancel = () => {
      drag.current = null;
      dragged.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, []);

  const shown = draft || color || '#000000';
  return (
    <div className="color-picker-wrap" ref={wrap}>
      <button
        className={cls('color-picker-btn', open && 'open')}
        title="Pick a color"
        aria-label="Pick a color"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ background: shown }} />
        <ChevronDown size={13} />
      </button>
      {open &&
        createPortal(
        <div
          className="color-dropdown"
          data-popover-child=""
          ref={panel}
          style={{ top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="color-field"
            ref={field}
            style={{ background: hsvToHex(hsv.h, 1, 1) }}
            onPointerDown={(e) => {
              drag.current = 'field';
              pickAt(e.nativeEvent);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
          >
            <span className="color-field-white" />
            <span className="color-field-black" />
            <i style={{ left: hsv.s * 100 + '%', top: (1 - hsv.v) * 100 + '%' }} />
          </div>
          <div
            className="color-hue"
            ref={hue}
            onPointerDown={(e) => {
              drag.current = 'hue';
              pickAt(e.nativeEvent);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
          >
            <i style={{ left: (hsv.h / 360) * 100 + '%' }} />
          </div>
          <div className="color-dropdown-readout">
            <span style={{ background: shown }} />
            <code>{shown}</code>
          </div>
        </div>,
        document.body,
        )}
    </div>
  );
}

/** Colour filter: recommended swatches, a custom colour, or a typed colour number. */
function ColorSearch({ color, onPick }: { color: string; onPick: (hex: string) => void }) {
  const [text, setText] = useState(color);
  const [invalid, setInvalid] = useState(false);
  const editing = useRef(false);
  // Text typed but not applied yet. The filter menu closes on mousedown, which
  // removes the field before it can blur, so a code typed and then abandoned by
  // clicking outside used to be thrown away without ever searching.
  const pending = useRef<string | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!editing.current) setText(color);
  }, [color]);

  useEffect(
    () => () => {
      const raw = pending.current;
      if (raw == null) return;
      if (!raw.trim()) {
        onPickRef.current('');
        return;
      }
      const next = parseColorInput(raw);
      if (next) onPickRef.current(next);
    },
    [],
  );

  const apply = (raw: string) => {
    pending.current = null;
    const next = parseColorInput(raw);
    if (!next) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(next);
    if (next !== color) onPickRef.current(next);
  };

  // A focused field should be applied as soon as the menu goes away, whether
  // that is a click outside, Escape, or a click on one of the preset swatches.
  const commitTyped = () => {
    editing.current = false;
    if (!text.trim()) {
      pending.current = null;
      setInvalid(false);
      onPickRef.current('');
      return;
    }
    apply(text);
  };

  return (
    <div className="color-search">
      <div className="menu-label">Search by color</div>
      <div className="color-swatches">
        {RECOMMENDED_COLORS.map((hex) => (
          <button
            key={hex}
            className={cls('color-swatch', color === hex && 'on')}
            style={{ background: hex }}
            title={hex}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              editing.current = false;
              pending.current = null;
              setInvalid(false);
              setText(hex);
              onPick(hex);
            }}
          />
        ))}
      </div>
      <div className="color-custom">
        <ColorPicker
          color={parseColorInput(text) || color || '#ff0000'}
          onPick={(hex) => {
            editing.current = false;
            pending.current = null;
            setInvalid(false);
            setText(hex);
            onPick(hex);
          }}
        />
        <input
          className={cls('color-number', invalid && 'invalid')}
          value={text}
          spellCheck={false}
          placeholder="Color number, e.g. #1e88e5"
          aria-label="Color number"
          onFocus={() => (editing.current = true)}
          onChange={(e) => {
            pending.current = e.target.value;
            setText(e.target.value);
            setInvalid(false);
          }}
          onBlur={commitTyped}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitTyped();
            }
          }}
        />
        {color && (
          <button
            className="icon-btn xs"
            title="Clear colour"
            onClick={() => {
              editing.current = false;
              pending.current = null;
              setInvalid(false);
              setText('');
              onPick('');
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

export function Toolbar() {
  const view = useStore((s) => s.view);
  const folders = useStore((s) => s.folders);
  const count = useStore((s) => s.total);
  const query = useStore((s) => s.query);
  const filters = useStore((s) => s.filters);
  const sort = useStore((s) => s.sort);
  const ranking = useStore((s) => s.ranking);
  const layout = useStore((s) => s.layout);
  const thumbSize = useStore((s) => s.thumbSize);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const sidebarHidden = useStore((s) => s.sidebarHidden);
  const trashCount = useStore((s) => s.stats.trash);
  const { setQuery, setFilters, setLayout, setThumbSize, set, ask, refresh } = useStore.getState();
  const searchRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const compact = useCompact();
  const phone = usePhone();

  // on narrow screens the toolbar is fixed (see styles.css); the main column keeps room for it
  useEffect(() => {
    const el = toolbarRef.current!;
    const ro = new ResizeObserver(() =>
      document.documentElement.style.setProperty('--toolbar-h', `${el.offsetHeight}px`),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    <header className="toolbar" ref={toolbarRef}>
      {compact ? (
        <button className="icon-btn menu-btn" title="Folders and tags" onClick={() => set({ sidebarOpen: true })}>
          <Menu size={19} />
        </button>
      ) : (
        <button
          className={cls('icon-btn', !sidebarHidden && 'active')}
          title="Toggle sidebar"
          onClick={() => set({ sidebarHidden: !sidebarHidden })}
        >
          <PanelLeft size={17} />
        </button>
      )}
      {/* with no inspector beside the grid, the title opens the folder's or library's details */}
      <div
        className={cls('view-title', compact && 'clickable')}
        role={compact ? 'button' : undefined}
        onClick={compact ? () => set({ details: 'view' }) : undefined}
      >
        <span className="view-icon">{icon}</span>
        <h1>{title}</h1>
        <span className="view-count">{count.toLocaleString()}</span>
        {compact && <ChevronDown size={14} className="dim" />}
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
            <em>{filters.color}</em>
            <X size={12} />
          </button>
        )}

        <Popover
          align="right"
          width={312}
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
                    ['social', 'Social'],
                    ['web', 'Web'],
                    ['arena', 'Are.na'],
                    ['upload', 'Upload'],
                    ['api', 'API'],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={cls(filters.source === k && 'on')} onClick={() => setFilters({ source: k })}>
                    {k === 'x' ? <XLogo size={11} /> : label}
                  </button>
                ))}
              </div>
              <div className="menu-sep" />
              <ColorSearch color={filters.color} onPick={(color) => setFilters({ color })} />
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

        {phone ? (
          <Popover
            align="right"
            trigger={(open, toggle) => (
              <button className={cls('tool-btn', open && 'active')} onClick={toggle} title="View options">
                <SlidersHorizontal size={15} />
              </button>
            )}
          >
            {(close) => (
              <div className="menu-list">
                <div className="menu-label">Layout</div>
                <div className="segmented full">
                  {LAYOUTS.map((l) => (
                    <button key={l.key} className={cls(layout === l.key && 'on')} onClick={() => setLayout(l.key)}>
                      {l.icon} {l.label}
                    </button>
                  ))}
                </div>
                <div className="menu-label">Thumbnail size</div>
                <input
                  className="size-slider full"
                  type="range"
                  min={80}
                  max={400}
                  step={10}
                  value={thumbSize}
                  onChange={(e) => setThumbSize(Number(e.target.value))}
                />
                <div className="menu-sep" />
                <SortOptions close={close} />
              </div>
            )}
          </Popover>
        ) : (
          <>
            <Popover
              align="right"
              width={210}
              trigger={(open, toggle) => (
                <button className={cls('tool-btn', open && 'active')} onClick={toggle} title="Sort">
                  {sort.dir === 'desc' ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
                  <span>{ranking ? 'Relevance' : SORTS.find((s) => s.key === sort.by)?.label}</span>
                </button>
              )}
            >
              {(close) => (
                <div className="menu-list">
                  <SortOptions close={close} />
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
          </>
        )}

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
        {!compact && (
          <button
            className={cls('icon-btn', inspectorOpen && 'active')}
            title="Toggle inspector"
            onClick={() => set({ inspectorOpen: !inspectorOpen })}
          >
            <PanelRight size={17} />
          </button>
        )}
      </div>
    </header>
  );
}

/** Sort key and direction, and whether cards show their names. */
function SortOptions({ close }: { close: () => void }) {
  const sort = useStore((s) => s.sort);
  const showInfo = useStore((s) => s.showInfo);
  const ranking = useStore((s) => s.ranking);
  const { setSort, set } = useStore.getState();
  return (
    <>
      {ranking && (
        <div className="menu-note">Semantic search ranks these results by similarity. The sort applies once you clear the search.</div>
      )}
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
    </>
  );
}
