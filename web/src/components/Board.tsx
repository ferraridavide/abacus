import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Columns3, Grid2x2, Images, Maximize2, Minus, MousePointer2, Plus, Scan, Sparkles, X } from 'lucide-react';
import { useStore } from '../store';
import type { Item } from '../types';
import { computeLayout, GAP } from '../lib/layout';
import { itemMeta } from '../lib/format';
import { cls, useCompact } from './ui';
import { originalSharper, Thumb, useSettled } from './Thumb';

type Mode = 'masonry' | 'grid' | 'free';
type Point = { x: number; y: number };
type View = { x: number; y: number; s: number };
type Gesture =
  | { kind: 'pan'; start: Point; view: View; moved: boolean; track: (Point & { t: number })[]; downAt: number; id: string | null }
  | { kind: 'pinch'; center: Point; distance: number; view: View }
  | { kind: 'item'; id: string; start: Point; origin: Point; moved: boolean; downAt: number };

const MODES: { key: Mode; icon: ReactNode; label: string }[] = [
  { key: 'masonry', icon: <Columns3 size={15} />, label: 'Waterfall' },
  { key: 'grid', icon: <Grid2x2 size={15} />, label: 'Grid' },
  { key: 'free', icon: <MousePointer2 size={15} />, label: 'Free' },
];

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 4;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

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
  const [view, setView] = useState<View>({ x: 0, y: 0, s: 1 });
  // the view as last rendered, for gestures that start between renders
  const viewRef = useRef(view);
  viewRef.current = view;
  // a flicked pan gliding to a stop; anything else that moves the view stops it
  const flingRef = useRef(0);
  const stopFling = useCallback(() => {
    cancelAnimationFrame(flingRef.current);
    flingRef.current = 0;
  }, []);
  useEffect(() => stopFling, [stopFling]);
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
    stopFling();
    const pad = stage.w < 620 ? 20 : 56;
    const s = clamp(Math.min((stage.w - pad * 2) / Math.max(1, bounds.w), (stage.h - pad * 2) / Math.max(1, bounds.h)), MIN_ZOOM, 1.5);
    setView({
      s,
      x: (stage.w - bounds.w * s) / 2 - bounds.x * s,
      y: (stage.h - bounds.h * s) / 2 - bounds.y * s,
    });
  }, [bounds, stage.w, stage.h, stopFling]);

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
    stopFling();
    setView((v) => {
      const s = clamp(v.s * factor, MIN_ZOOM, MAX_ZOOM);
      const k = s / v.s;
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, [stopFling]);

  const zoomTo = useCallback((target: number) => {
    const el = stageRef.current;
    const px = el ? el.clientWidth / 2 : 0;
    const py = el ? el.clientHeight / 2 : 0;
    stopFling();
    setView((v) => {
      const s = clamp(target, MIN_ZOOM, MAX_ZOOM);
      const k = s / v.s;
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, [stopFling]);

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

  // ----- gestures -----
  // Every pointer down on the stage is tracked, on an image or not. One pans the canvas (or, in free mode, moves the
  // image it started on); a second one turns it into a pinch that zooms and pans around the fingers' midpoint.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ at: number; point: Point; id: string | null } | null>(null);
  const lastTouch = useRef(0);

  const localPoint = (e: { clientX: number; clientY: number }): Point => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const startPan = (point: Point, moved: boolean, id: string | null = null): Gesture => ({
    kind: 'pan',
    start: point,
    view: viewRef.current,
    moved,
    track: [{ ...point, t: performance.now() }],
    downAt: performance.now(),
    id,
  });

  const startPinch = (): Gesture => {
    const [a, b] = [...pointers.current.values()];
    return { kind: 'pinch', center: midpoint(a, b), distance: Math.max(1, distance(a, b)), view: viewRef.current };
  };

  const bringToFront = (id: string) => setZOrder((z) => [...z.filter((x) => x !== id), id]);

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') || pointers.current.size >= 2) return;
    stopFling();
    if (e.pointerType === 'touch') lastTouch.current = Date.now();
    const point = localPoint(e);
    pointers.current.set(e.pointerId, point);
    // captured by the image it started on, if any, so double-clicks still land on it; moves bubble up here either way
    const itemEl = target.closest<HTMLElement>('.board-item');
    (itemEl ?? e.currentTarget).setPointerCapture(e.pointerId);

    if (pointers.current.size === 2) {
      gesture.current = startPinch();
      setDraggingId(null);
      setPanning(true);
      return;
    }
    const id = itemEl?.dataset.id ?? null;
    const box = id ? boxes[items.findIndex((i) => i.id === id)] : undefined;
    if (mode === 'free' && id && box && e.button === 0) {
      gesture.current = { kind: 'item', id, start: point, origin: { x: box.x, y: box.y }, moved: false, downAt: performance.now() };
      setDraggingId(id);
      bringToFront(id);
    } else {
      gesture.current = startPan(point, false, id);
      if (!itemEl) setPanning(true);
    }
  };

  const onStagePointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const point = localPoint(e);
    pointers.current.set(e.pointerId, point);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      const c = midpoint(a, b);
      const sc = clamp((g.view.s * distance(a, b)) / g.distance, MIN_ZOOM, MAX_ZOOM);
      // the world point that was under the fingers' midpoint stays under it
      const wx = (g.center.x - g.view.x) / g.view.s;
      const wy = (g.center.y - g.view.y) / g.view.s;
      setView({ s: sc, x: c.x - wx * sc, y: c.y - wy * sc });
      return;
    }
    const dx = point.x - g.start.x;
    const dy = point.y - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) < (e.pointerType === 'touch' ? 8 : 3)) return;
    g.moved = true;
    if (g.kind === 'item') {
      const s = viewRef.current.s;
      setSpots((p) => ({ ...p, [g.id]: { x: g.origin.x + dx / s, y: g.origin.y + dy / s } }));
      return;
    }
    setPanning(true);
    const t = performance.now();
    g.track = [...g.track.filter((q) => t - q.t < 100), { ...point, t }];
    setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
  };

  const onStagePointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const point = localPoint(e);
    pointers.current.delete(e.pointerId);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    const g = gesture.current;
    if (!g) return;

    // lifting one finger of a pinch carries on as a pan with the other, from where it is
    if (g.kind === 'pinch') {
      const rest = [...pointers.current.values()][0];
      gesture.current = rest ? startPan(rest, true) : null;
      if (!rest) setPanning(false);
      return;
    }
    if (pointers.current.size) return;
    gesture.current = null;
    setPanning(false);
    setDraggingId(null);
    if (e.type === 'pointercancel') return;

    if (g.kind === 'pan' && g.moved && e.pointerType === 'touch') fling(g.track);
    if (!g.moved && e.pointerType === 'touch' && performance.now() - g.downAt < 300) onTap(point, g.id);
  };

  // Touch screens don't reliably send double-clicks, so double taps are told apart here: on an image it opens the
  // preview, like a double-click; on the canvas it zooms in there, or back out to the whole board once zoomed in.
  const onTap = (point: Point, id: string | null) => {
    const prev = lastTap.current;
    const now = performance.now();
    if (prev && now - prev.at < 320 && prev.id === id && Math.hypot(point.x - prev.point.x, point.y - prev.point.y) < 32) {
      lastTap.current = null;
      if (id) {
        const item = items.find((i) => i.id === id);
        if (item) openViewer(item);
      } else if (viewRef.current.s >= 1.5) {
        fitRef.current();
      } else {
        zoomAt(2, point.x, point.y);
      }
      return;
    }
    lastTap.current = { at: now, point, id };
  };

  const fling = (track: { x: number; y: number; t: number }[]) => {
    const first = track[0];
    const last = track[track.length - 1];
    const dt = last.t - first.t;
    if (track.length < 2 || dt <= 0 || performance.now() - last.t > 60) return;
    let vx = (last.x - first.x) / dt;
    let vy = (last.y - first.y) / dt;
    if (Math.hypot(vx, vy) < 0.25) return;
    let prev = performance.now();
    const step = (t: number) => {
      const elapsed = Math.min(32, t - prev);
      prev = t;
      const decay = Math.pow(0.996, elapsed);
      vx *= decay;
      vy *= decay;
      setView((v) => ({ ...v, x: v.x + vx * elapsed, y: v.y + vy * elapsed }));
      flingRef.current = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    flingRef.current = requestAnimationFrame(step);
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
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
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
                data-id={item.id}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  // touch double taps are handled by the gestures; some browsers also send a double-click for them
                  if (Date.now() - lastTouch.current < 800) return;
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
