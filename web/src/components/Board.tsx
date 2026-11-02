import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Columns3, Grid2x2, Images, Maximize2, Minus, MousePointer2, Plus, Scan, Sparkles, X } from 'lucide-react';
import { useStore } from '../store';
import type { Item } from '../types';
import { computeLayout, GAP, type Box } from '../lib/layout';
import { itemMeta } from '../lib/format';
import { cls, useCompact } from './ui';
import { originalSharper, Thumb, useSettled } from './Thumb';

type Mode = 'masonry' | 'grid' | 'free';
type Point = { x: number; y: number };

const MODES: { key: Mode; icon: ReactNode; label: string }[] = [
  { key: 'masonry', icon: <Columns3 size={15} />, label: 'Waterfall' },
  { key: 'grid', icon: <Grid2x2 size={15} />, label: 'Grid' },
  { key: 'free', icon: <MousePointer2 size={15} />, label: 'Free' },
];

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 4;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** The item's visual, if it has one. Bookmarks and videos use their poster thumbnail. */
function visualOf(item: Item) {
  if (item.thumbUrl) return item.thumbUrl;
  if (item.type === 'image' || item.type === 'gif') return item.fileUrl;
  return null;
}

/**
 * A board tile's picture: the thumbnail, and the original faded in over it once zooming in shows the thumbnail bigger
 * than its pixels. `tile` is the tile's size on screen, at the current zoom.
 */
function BoardImage({ item, src, tile, fit }: { item: Item; src: string; tile: { w: number; h: number }; fit: 'cover' | 'contain' }) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [originalLoaded, setOriginalLoaded] = useState(false);
  // settling keeps a zoom gesture passing through from fetching originals; once fetched, they stay
  const showOriginal = useSettled(!!natural && originalSharper(item, natural, tile, fit), 250);
  const style = { background: item.palette[0]?.hex };
  return (
    <>
      {src === item.thumbUrl ? (
        <Thumb
          item={item}
          alt={item.name}
          loading="lazy"
          decoding="async"
          style={style}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
      ) : (
        <img src={src} alt={item.name} draggable={false} loading="lazy" decoding="async" style={style} />
      )}
      {showOriginal && (
        <img
          src={item.fileUrl!}
          alt=""
          draggable={false}
          decoding="async"
          className={cls('original', originalLoaded && 'loaded')}
          onLoad={() => setOriginalLoaded(true)}
        />
      )}
    </>
  );
}

/**
 * A free-form canvas holding the selected references together: the same pictures in one place, for
 * comparing and arranging them. Waterfall and grid lay them out automatically; free leaves every
 * image where you drop it, on a pannable, zoomable surface.
 */
export function Board() {
  const board = useStore((s) => s.board);
  const allItems = useStore((s) => s.items);
  const compact = useCompact();

  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [mode, setMode] = useState<Mode>('masonry');
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const [ready, setReady] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);
  /** free-mode positions, by item id; missing items keep their place in the waterfall */
  const [spots, setSpots] = useState<Record<string, Point>>({});
  const [zOrder, setZOrder] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  // promoted to its own layer only while the view moves: a layer keeps the bitmap it was drawn at, so leaving it on
  // would show a zoomed-in board as an enlarged low-resolution picture of itself
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    setMoving(true);
    const timer = setTimeout(() => setMoving(false), 150);
    return () => clearTimeout(timer);
  }, [view]);

  const byId = useMemo(() => new Map(allItems.map((item) => [item.id, item])), [allItems]);
  const items = useMemo(
    () =>
      (board?.ids ?? []).flatMap((id) => {
        const item = byId.get(id);
        return item && visualOf(item) ? [item] : [];
      }),
    [board?.ids, byId]
  );
  const itemKey = items.map((i) => i.id).join('|');

  // One wide canvas of tiles: roughly as many columns as the screen affords, capped so images stay useful.
  const baseWidth = Math.min(1560, Math.max(320, stage.w || 1200));
  const wanted = items.length <= 1 ? 1 : Math.ceil(Math.sqrt(items.length * 1.1));
  const fits = Math.max(1, Math.floor((baseWidth + GAP) / (170 + GAP)));
  const cols = Math.max(1, Math.min(items.length || 1, wanted, fits));
  const tile = Math.min(460, Math.max(160, Math.floor((baseWidth - GAP * (cols - 1)) / cols)));
  const layoutWidth = cols * tile + GAP * (cols - 1);

  const masonry = useMemo(() => computeLayout(items, layoutWidth, 'masonry', tile, 0), [items, layoutWidth, tile]);
  const grid = useMemo(() => computeLayout(items, layoutWidth, 'grid', tile, 0), [items, layoutWidth, tile]);

  const boxes = useMemo(() => {
    if (mode === 'grid') return grid.boxes;
    if (mode === 'masonry') return masonry.boxes;
    return masonry.boxes.map((box, i) => {
      const spot = spots[items[i].id];
      return spot ? { ...box, x: spot.x, y: spot.y } : box;
    });
  }, [mode, grid.boxes, masonry.boxes, spots, items]);

  const bounds = useMemo(() => {
    if (!boxes.length) return null;
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const b of boxes) {
      x1 = Math.min(x1, b.x);
      y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.w);
      y2 = Math.max(y2, b.y + b.h);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }, [boxes]);

  const measure = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    setStage((s) => (s.w === w && s.h === h ? s : { w, h }));
  }, []);

  useLayoutEffect(() => {
    if (!board) return;
    measure();
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [board, measure]);

  const fit = useCallback(() => {
    if (!bounds || !stage.w || !stage.h) return;
    const pad = stage.w < 620 ? 20 : 56;
    const s = clamp(Math.min((stage.w - pad * 2) / Math.max(1, bounds.w), (stage.h - pad * 2) / Math.max(1, bounds.h)), MIN_ZOOM, 1.5);
    setView({
      s,
      x: (stage.w - bounds.w * s) / 2 - bounds.x * s,
      y: (stage.h - bounds.h * s) / 2 - bounds.y * s,
    });
  }, [bounds, stage.w, stage.h]);

  const fitRef = useRef(fit);
  fitRef.current = fit;

  // Frame the whole board whenever it opens, changes arrangement or gets resized. Free-mode drags
  // move `bounds`, so it is deliberately not a dependency: the board shouldn't refit mid-drag.
  useEffect(() => {
    if (!board || !stage.w || !stage.h || !bounds) return;
    fitRef.current();
    setReady(true);
  }, [board, itemKey, mode, stage.w, stage.h, fitNonce]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = stageRef.current;
    const px = cx ?? (el ? el.clientWidth / 2 : 0);
    const py = cy ?? (el ? el.clientHeight / 2 : 0);
    setView((v) => {
      const s = clamp(v.s * factor, MIN_ZOOM, MAX_ZOOM);
      const k = s / v.s;
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  const zoomTo = useCallback((target: number) => {
    const el = stageRef.current;
    const px = el ? el.clientWidth / 2 : 0;
    const py = el ? el.clientHeight / 2 : 0;
    setView((v) => {
      const s = clamp(target, MIN_ZOOM, MAX_ZOOM);
      const k = s / v.s;
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  // Wheel zooms around the pointer; trackpad pinches arrive as ctrl+wheel.
  useEffect(() => {
    if (!board) return;
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [board, zoomAt]);

  useEffect(() => {
    if (!board) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
      const s = useStore.getState();
      // a preview or a dialog on top of the board owns Escape
      if (s.viewerId || s.settingsOpen || s.importOpen || s.confirm || s.folderPicker || s.details) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.set({ board: null });
      } else if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomAt(1.25);
      } else if (e.key === '-') {
        e.preventDefault();
        zoomAt(0.8);
      } else if (e.key === '0') {
        e.preventDefault();
        fitRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [board, zoomAt]);

  // ----- panning -----
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Images own their pointer: dragging moves them in free mode, and clicks/double-clicks preview them.
    if ((e.target as HTMLElement).closest('.board-item')) return;
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    setPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onStagePointerMove = (e: React.PointerEvent) => {
    const p = panRef.current;
    if (!p) return;
    setView((v) => ({ ...v, x: p.ox + e.clientX - p.sx, y: p.oy + e.clientY - p.sy }));
  };

  const endPan = (e: React.PointerEvent) => {
    if (!panRef.current) return;
    panRef.current = null;
    setPanning(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
  };

  // ----- moving one image in free mode -----
  const dragRef = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  const bringToFront = (id: string) => setZOrder((z) => [...z.filter((x) => x !== id), id]);

  const onItemPointerDown = (e: React.PointerEvent, item: Item, box: Box) => {
    if (mode !== 'free' || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.stopPropagation();
    dragRef.current = { id: item.id, sx: e.clientX, sy: e.clientY, ox: box.x, oy: box.y, moved: false };
    setDraggingId(item.id);
    bringToFront(item.id);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onItemPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    setSpots((p) => ({ ...p, [d.id]: { x: d.ox + dx / view.s, y: d.oy + dy / view.s } }));
  };

  const endItemDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDraggingId(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
  };

  const close = () => useStore.getState().set({ board: null });
  const openViewer = (item: Item) => useStore.getState().set({ viewerId: item.id });

  const remove = (id: string) => {
    const s = useStore.getState();
    if (!s.board) return;
    const ids = s.board.ids.filter((x) => x !== id);
    s.set({ board: ids.length ? { ...s.board, ids } : null });
    setSpots((p) => {
      const next = { ...p };
      delete next[id];
      return next;
    });
    setZOrder((z) => z.filter((x) => x !== id));
  };

  const tidy = () => {
    setSpots({});
    setFitNonce((n) => n + 1);
  };

  if (!board) return null;

  return (
    <div className="board">
      <header className="board-bar">
        <div className="board-title">
          <h2>Moodboard</h2>
          <span
            className="board-count"
            title={board.ids.length > items.length ? 'Some selected items have not loaded in the grid yet' : undefined}
          >
            {board.ids.length > items.length ? `${items.length} of ${board.ids.length}` : items.length} reference
            {board.ids.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="board-tools">
          <div className="board-seg" role="group" aria-label="Arrangement">
            {MODES.map((m) => (
              <button
                key={m.key}
                className={cls(mode === m.key && 'on')}
                title={m.label}
                aria-pressed={mode === m.key}
                onClick={() => setMode(m.key)}
              >
                {m.icon}
                {!compact && <span>{m.label}</span>}
              </button>
            ))}
          </div>
          {mode === 'free' && items.length > 1 && (
            <button className="board-tidy" title="Tidy up" onClick={tidy}>
              <Sparkles size={14} />
              {!compact && <span>Tidy</span>}
            </button>
          )}
          <div className="board-zoom">
            <button className="icon-btn" title="Zoom out (−)" onClick={() => zoomAt(0.8)}>
              <Minus size={15} />
            </button>
            <button className="board-zoom-level" title="Zoom to 100%" onClick={() => zoomTo(1)}>
              {Math.round(view.s * 100)}%
            </button>
            <button className="icon-btn" title="Zoom in (+)" onClick={() => zoomAt(1.25)}>
              <Plus size={15} />
            </button>
            <button className="icon-btn" title="Fit to screen (0)" onClick={() => fitRef.current()}>
              <Scan size={15} />
            </button>
          </div>
          <button className="icon-btn board-close" title="Close (Esc)" onClick={close}>
            <X size={18} />
          </button>
        </div>
      </header>

      <div
        ref={stageRef}
        className={cls('board-stage', panning && 'panning')}
        style={{ backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className="board-world"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
            willChange: moving ? 'transform' : undefined,
            visibility: ready ? 'visible' : 'hidden',
          }}
        >
          {items.map((item, i) => {
            const box = boxes[i];
            const src = visualOf(item);
            if (!box || !src) return null;
            const z = zOrder.indexOf(item.id);
            return (
              <div
                key={item.id}
                className={cls(
                  'board-item',
                  mode === 'grid' && 'grid',
                  mode === 'free' && 'free',
                  draggingId === item.id && 'dragging'
                )}
                style={{
                  transform: `translate3d(${box.x}px, ${box.y}px, 0)`,
                  width: box.w,
                  height: box.h,
                  zIndex: z >= 0 ? z + 1 : 1,
                }}
                onPointerDown={(e) => onItemPointerDown(e, item, box)}
                onPointerMove={onItemPointerMove}
                onPointerUp={endItemDrag}
                onPointerCancel={endItemDrag}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  openViewer(item);
                }}
              >
                <BoardImage
                  item={item}
                  src={src}
                  tile={{ w: box.w * view.s, h: box.h * view.s }}
                  fit={mode === 'grid' ? 'cover' : 'contain'}
                />
                <div className="board-item-info">
                  <div className="bi-name" title={item.name}>
                    {item.name}
                  </div>
                  <div className="bi-meta">{itemMeta(item)}</div>
                </div>
                <div className="board-item-actions" onPointerDown={(e) => e.stopPropagation()}>
                  <button title="Open preview (double-click)" onClick={() => openViewer(item)}>
                    <Maximize2 size={14} />
                  </button>
                  <button className="danger" title="Remove from moodboard" onClick={() => remove(item.id)}>
                    <X size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {!items.length && (
          <div className="board-empty">
            <Images size={40} strokeWidth={1.3} />
            <h3>Nothing to show</h3>
            <p>The selected items have no preview images.</p>
          </div>
        )}
        {items.length > 0 && (
          <div className="board-hint">
            {mode === 'free' ? 'Drag images to arrange · Drag the canvas to pan · Scroll to zoom' : 'Drag to pan · Scroll to zoom'}
          </div>
        )}
      </div>
    </div>
  );
}
