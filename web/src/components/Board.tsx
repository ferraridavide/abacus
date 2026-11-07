import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Columns3, Grid2x2, Hand, Images, Loader2, Minus, MousePointer2, Plus, Scan, Sparkles, SquareDashedMousePointer, X } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import type { BoardSpot, FolderBoard, Item } from '../types';
import { computeLayout, GAP, type Box } from '../lib/layout';
import { arrangeFolder, boardVisual, snapshotBoard, tidyKeepingSizes, type BoardSnapshotInput } from '../lib/board';
import { itemMeta } from '../lib/format';
import { cls, useCompact } from './ui';
import { originalSharper, Thumb, useSettled } from './Thumb';

type Mode = 'masonry' | 'grid' | 'free';
type Tool = 'select' | 'hand';
type Point = { x: number; y: number };
type View = { x: number; y: number; s: number };
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type Placed = { x: number; y: number; w: number; h: number };
type Gesture =
  | { kind: 'pan'; start: Point; view: View; moved: boolean; track: (Point & { t: number })[]; downAt: number; id: string | null }
  | { kind: 'pinch'; center: Point; distance: number; view: View }
  | { kind: 'move'; id: string; ids: string[]; start: Point; origins: Record<string, Placed>; moved: boolean; additive: boolean; downAt: number }
  | { kind: 'marquee'; start: Point; add: boolean; moved: boolean; downAt: number };

const TOOLS: { key: Tool; icon: ReactNode; label: string; hint: string }[] = [
  { key: 'select', icon: <SquareDashedMousePointer size={15} />, label: 'Select', hint: 'V' },
  { key: 'hand', icon: <Hand size={15} />, label: 'Pan', hint: 'H' },
];

const MODES: { key: Mode; icon: ReactNode; label: string }[] = [
  { key: 'masonry', icon: <Columns3 size={15} />, label: 'Waterfall' },
  { key: 'grid', icon: <Grid2x2 size={15} />, label: 'Grid' },
  { key: 'free', icon: <MousePointer2 size={15} />, label: 'Free' },
];

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 4;
/** the smallest an image can be dragged down to, in board pixels */
const MIN_TILE = 48;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const normRect = (a: Point, b: Point): Placed => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(b.x - a.x),
  h: Math.abs(b.y - a.y),
});
const overlaps = (a: Placed, b: Placed) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const toggleId = (ids: Set<string>, id: string) => {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

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
 * A free-form canvas for comparing and arranging images. Free leaves every image where you drop it, on a pannable,
 * zoomable surface; waterfall and grid lay them out automatically.
 *
 * Opened on a folder, the canvas holds every image it contains and the folder keeps the arrangement: each image's
 * place and size, the arrangement itself and the camera are saved on the folder, so coming back to it shows the same
 * board. Images added later are laid out and parked beside what is already there. Without a folder (items picked out
 * of the grid) the board lives only as long as it is open.
 */
export function Board() {
  const board = useStore((s) => s.board);
  const boardItems = useStore((s) => s.boardItems);
  const allItems = useStore((s) => s.items);
  const folders = useStore((s) => s.folders);
  const compact = useCompact();

  const folderId = board?.folderId;
  const folderName = folderId ? folders.find((f) => f.id === folderId)?.name : undefined;
  // a board opens as a whole, so this is what tells one board from the next
  const boardKey = folderId ? `folder:${folderId}` : 'selection';

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
  const [hydrated, setHydrated] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  /** free-mode places and sizes, by item id */
  const [spots, setSpots] = useState<Record<string, BoardSpot>>({});
  const [zOrder, setZOrder] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  /** free-mode tool: select images, or pan the canvas. Resize stays on the select tool. */
  const [tool, setTool] = useState<Tool>('select');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<Placed | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  // promoted to its own layer only while the view moves: a layer keeps the bitmap it was drawn at, so leaving it on
  // would show a zoomed-in board as an enlarged low-resolution picture of itself
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    setMoving(true);
    const timer = setTimeout(() => setMoving(false), 150);
    return () => clearTimeout(timer);
  }, [view]);

  // ----- the arrangement that is saved -----
  /** the board as it came from the server, for the places of images that have since left the folder */
  const loaded = useRef<FolderBoard | null>(null);
  /** the JSON last stored, so an unchanged board is never sent again */
  const lastSaved = useRef('');
  /** which save is the latest: a slow answer must not overwrite a newer one */
  const saving = useRef(0);
  /** what the board looks like right now, for a save on the way out */
  const held = useRef<{ folderId: string; input: BoardSnapshotInput } | null>(null);
  /** a saved camera was just restored: frame it next time, don't fit */
  const restoredView = useRef(false);
  /** the frame key last framed, so a resized window doesn't refit a board that was already framed */
  const framed = useRef('');

  const byId = useMemo(() => new Map(allItems.map((item) => [item.id, item])), [allItems]);
  const items = useMemo(() => {
    if (folderId) return boardItems;
    return (board?.ids ?? []).flatMap((id) => {
      const item = byId.get(id);
      return item && boardVisual(item) ? [item] : [];
    });
  }, [folderId, boardItems, board?.ids, byId]);
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

  /** items without a saved place: on a folder board they are the ones that arrived after the arrangement was saved */
  const unplaced = useMemo(
    () => (folderId ? items.filter((item) => !spots[item.id]) : []),
    [folderId, items, spots]
  );

  const boxes = useMemo(() => {
    if (mode === 'grid') return grid.boxes;
    if (mode === 'masonry') return masonry.boxes;
    if (folderId) {
      const fresh = unplaced.length ? computeLayout(unplaced, layoutWidth, 'masonry', tile, 0).boxes : [];
      return arrangeFolder(items.map((i) => i.id), masonry.boxes, fresh, spots);
    }
    return masonry.boxes.map((box, i) => {
      const spot = spots[items[i].id];
      return spot ? { x: spot.x, y: spot.y, w: spot.w, h: spot.h } : box;
    });
  }, [mode, folderId, grid.boxes, masonry.boxes, spots, items, unplaced, layoutWidth, tile]);

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
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

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

  // A board replaces the one before it: restore what the folder saved, or start a picked board from its waterfall.
  // `saved` is read here rather than depended on: the store sets it together with `status`, in one state change.
  useEffect(() => {
    if (!board) return;
    setPicked(new Set());
    setTool('select');
    setMarquee(null);
    if (board.status !== 'ready') {
      // the folder's images are still on their way: keep the canvas hidden until they are all in
      setReady(false);
      setHydrated(false);
      framed.current = '';
      return;
    }
    setReady(false);
    framed.current = '';
    restoredView.current = false;
    if (!board.folderId) {
      held.current = null;
      loaded.current = null;
      setSpots({});
      setZOrder([]);
      setMode('masonry');
      setHydrated(true);
      return;
    }
    const saved = board.saved;
    loaded.current = saved;
    lastSaved.current = JSON.stringify(saved);
    // a folder that already keeps an arrangement says so before anything is touched
    const arranged = !!saved && (saved.mode !== 'free' || !!saved.view || saved.zOrder.length > 0 || Object.keys(saved.spots).length > 0);
    setSaveState(arranged ? 'saved' : 'idle');
    setSpots(saved?.spots ?? {});
    setZOrder(saved?.zOrder ?? []);
    setMode(saved?.mode ?? 'free');
    if (saved?.view) setView(saved.view);
    // the arrangement is framed where it was left, not refitted to this window
    restoredView.current = Boolean(saved?.view);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey, board?.status]);

  // Frame the whole board when it opens, changes arrangement or gets resized. A board opened with a saved
  // camera keeps it. Free-mode drags move `bounds`, so it is deliberately not a dependency: the board
  // shouldn't refit mid-drag.
  useEffect(() => {
    if (!board || board.status !== 'ready' || !hydrated) return;
    if (!stage.w || !stage.h || !boundsRef.current) return;
    const key = `${boardKey}|${mode}|${fitNonce}|${itemKey}`;
    if (framed.current === key) return;
    framed.current = key;
    if (folderId && restoredView.current) restoredView.current = false;
    else fitRef.current();
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, boardKey, mode, stage.w, stage.h, itemKey, fitNonce, hydrated, folderId]);

  // ----- saving -----

  const persist = useCallback((folder: string, input: BoardSnapshotInput) => {
    const next = snapshotBoard(input);
    const body = JSON.stringify(next);
    if (body === lastSaved.current) return;
    // claimed before it is sent, so a debounced save and a closing one don't both send it
    lastSaved.current = body;
    const run = ++saving.current;
    setSaveState('saving');
    api.saveFolderBoard(folder, next).then(
      (stored) => {
        if (run !== saving.current) return;
        lastSaved.current = JSON.stringify(stored);
        loaded.current = stored;
        if (useStore.getState().board?.folderId === folder) setSaveState('saved');
      },
      () => {
        if (run !== saving.current) return;
        // forget the claim, so the next change tries again
        lastSaved.current = '';
        if (useStore.getState().board?.folderId === folder) setSaveState('error');
      }
    );
  }, []);

  const flush = useCallback(() => {
    const now = held.current;
    if (now) persist(now.folderId, now.input);
  }, [persist]);

  const canPersist = !!folderId && board?.status === 'ready' && hydrated && ready && items.length > 0;
  if (canPersist) {
    held.current = {
      folderId: folderId!,
      input: { mode, view, ids: items.map((i) => i.id), boxes, free: spots, previous: loaded.current?.spots ?? {}, zOrder },
    };
  }

  useEffect(() => {
    if (!canPersist) return;
    // a drag or a pan settles first; the arrangement is small, and one save per gesture is enough
    const timer = setTimeout(flush, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPersist, flush, spots, mode, view, zOrder, itemKey]);

  // A folder board starts from its waterfall: freezing the places it is shown at gives the folder an arrangement
  // from its first look. Only missing places are filled, so a drag already under way is never undone.
  useEffect(() => {
    if (!folderId || mode !== 'free' || !ready) return;
    const seed = items.flatMap((item, i) => {
      const box = boxes[i];
      if (!box || spots[item.id]) return [];
      return [{ id: item.id, spot: { x: box.x, y: box.y, w: box.w, h: box.h } }];
    });
    if (!seed.length) return;
    setSpots((p) => {
      const next = { ...p };
      for (const { id, spot } of seed) if (!next[id]) next[id] = spot;
      return next;
    });
    // `boxes` and `spots` are read as rendered; depending on them would loop with the state this writes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, mode, ready, itemKey]);

  // ----- view gestures -----

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

  // Closing saves what is on screen: the last drag may be inside the save delay.
  const close = useCallback(() => {
    flush();
    useStore.getState().closeBoard();
  }, [flush]);

  useEffect(() => {
    if (!board) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
      const s = useStore.getState();
      // a preview or a dialog on top of the board owns Escape
      if (s.viewerId || s.settingsOpen || s.importOpen || s.confirm || s.folderPicker || s.details) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (!e.repeat) setSpaceHeld(true);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (pickedRef.current.size) setPicked(new Set());
        else close();
      } else if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      } else if (e.key === 'v') {
        setTool('select');
      } else if (e.key === 'h') {
        setTool('hand');
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
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp);
      setSpaceHeld(false);
    };
  }, [board, zoomAt, close]);

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
  const toWorld = (point: Point): Point => ({
    x: (point.x - viewRef.current.x) / viewRef.current.s,
    y: (point.y - viewRef.current.y) / viewRef.current.s,
  });

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

  /** Give every image as shown a place of its own, so moving or resizing one leaves the rest untouched. */
  const seedPlaces = () => {
    if (!folderId || !unplaced.length) return;
    setSpots((p) => {
      const next = { ...p };
      items.forEach((item, i) => {
        const current = boxes[i];
        if (current && !next[item.id]) next[item.id] = { x: current.x, y: current.y, w: current.w, h: current.h };
      });
      return next;
    });
  };

  // A corner of an image is dragged with its own listeners: the canvas never sees this gesture, so it can't pan.
  const beginResize = (id: string, box: Box, clientX: number, clientY: number) => {
    stopFling();
    bringToFront(id);
    seedPlaces();
    const start = { x: clientX, y: clientY, w: box.w, h: box.h, s: viewRef.current.s, ox: box.x, oy: box.y };
    setResizingId(id);
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(MIN_TILE, Math.round(start.w + (ev.clientX - start.x) / start.s));
      const h = Math.max(MIN_TILE, Math.round(start.h + (ev.clientY - start.y) / start.s));
      setSpots((p) => ({ ...p, [id]: { x: p[id]?.x ?? start.ox, y: p[id]?.y ?? start.oy, w, h } }));
    };
    const onUp = () => {
      setResizingId(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  const startResize = (e: React.PointerEvent, item: Item, box: Box) => {
    e.preventDefault();
    e.stopPropagation();
    beginResize(item.id, box, e.clientX, e.clientY);
  };

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
    const index = id ? items.findIndex((i) => i.id === id) : -1;
    const box = index >= 0 ? boxes[index] : undefined;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const wantPan = mode !== 'free' || toolRef.current === 'hand' || spaceHeld || e.button === 1 || e.altKey;
    if (mode === 'free' && toolRef.current === 'select' && e.button === 0 && !wantPan && id && box) {
      seedPlaces();
      const selection = pickedRef.current;
      const group = !additive && selection.has(id) ? [...selection] : [id];
      const origins: Record<string, Placed> = {};
      for (const gid of group) {
        const at = items.findIndex((item) => item.id === gid);
        const placed = at >= 0 ? boxes[at] : undefined;
        if (placed) origins[gid] = { x: placed.x, y: placed.y, w: placed.w, h: placed.h };
      }
      gesture.current = { kind: 'move', id, ids: group, start: point, origins, moved: false, additive, downAt: performance.now() };
      bringToFront(id);
      return;
    }
    if (mode === 'free' && toolRef.current === 'select' && e.button === 0 && !wantPan && !id && e.pointerType !== 'touch') {
      gesture.current = { kind: 'marquee', start: toWorld(point), add: additive, moved: false, downAt: performance.now() };
      return;
    }
    gesture.current = startPan(point, false, id);
    if (!itemEl) setPanning(true);
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
    if (g.kind === 'marquee') {
      const rect = normRect(g.start, toWorld(point));
      if (rect.w > 3 || rect.h > 3) g.moved = true;
      setMarquee(rect);
      return;
    }
    if (g.kind === 'move') {
      const dx = point.x - g.start.x;
      const dy = point.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) < (e.pointerType === 'touch' ? 8 : 3)) return;
      if (!g.moved) {
        g.moved = true;
        setPicked(new Set(g.ids));
        setDraggingId(g.id);
        setZOrder((z) => [...z.filter((id) => !g.ids.includes(id)), ...g.ids]);
      }
      const s = viewRef.current.s;
      const wx = dx / s;
      const wy = dy / s;
      setSpots((p) => {
        const next = { ...p };
        // freeze the rest first: a folder board parks images that have no place yet, and that would jump them
        items.forEach((item, i) => {
          const placed = boxes[i];
          if (placed && !next[item.id]) next[item.id] = { x: placed.x, y: placed.y, w: placed.w, h: placed.h };
        });
        for (const id of g.ids) {
          const origin = g.origins[id];
          if (origin) next[id] = { x: origin.x + wx, y: origin.y + wy, w: origin.w, h: origin.h };
        }
        return next;
      });
      return;
    }
    const dx = point.x - g.start.x;
    const dy = point.y - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) < (e.pointerType === 'touch' ? 8 : 3)) return;
    g.moved = true;
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
    if (g.kind === 'marquee') setMarquee(null);
    if (e.type === 'pointercancel') return;

    if (g.kind === 'marquee') {
      if (g.moved) {
        const rect = normRect(g.start, toWorld(point));
        const hits = items.flatMap((item, i) => (boxes[i] && overlaps(boxes[i], rect) ? [item.id] : []));
        setPicked(g.add ? new Set([...pickedRef.current, ...hits]) : new Set(hits));
      } else if (!g.add) {
        setPicked(new Set());
      }
      return;
    }
    if (g.kind === 'move' && !g.moved) {
      setPicked(g.additive ? toggleId(pickedRef.current, g.id) : new Set([g.id]));
      if (e.pointerType === 'touch' && performance.now() - g.downAt < 300) onTap(point, g.id);
      return;
    }
    if (g.kind === 'pan' && g.moved && e.pointerType === 'touch') fling(g.track);
    if (g.kind === 'pan' && !g.moved && e.pointerType === 'touch' && performance.now() - g.downAt < 300) onTap(point, g.id);
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

  const openViewer = (item: Item) => useStore.getState().set({ viewerId: item.id });

  // Taking an image off a picked board is fine; a folder board shows the folder, so its images come and go with it.
  const remove = (id: string) => {
    const s = useStore.getState();
    if (!s.board || s.board.folderId) return;
    const ids = s.board.ids.filter((x) => x !== id);
    if (ids.length) s.set({ board: { ...s.board, ids } });
    else s.closeBoard();
    setZOrder((z) => z.filter((x) => x !== id));
    setPicked((ids) => {
      if (!ids.has(id)) return ids;
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
  };

  const tidyTargets = picked.size > 1 ? items.filter((item) => picked.has(item.id)) : items;

  // Pack the selection (or the whole board) into rows, keeping each image the size it already has.
  const tidy = () => {
    if (tidyTargets.length < 2) return;
    if (mode !== 'free') setMode('free');
    const chosen = new Set(tidyTargets.map((item) => item.id));
    const current = tidyTargets.flatMap((item) => {
      const at = items.findIndex((candidate) => candidate.id === item.id);
      const box = at >= 0 ? boxes[at] : undefined;
      return box ? [box] : [];
    });
    if (current.length < 2) return;
    const packed = tidyKeepingSizes(current, GAP);
    setSpots((prev) => {
      const next = { ...prev };
      items.forEach((item, i) => {
        const box = boxes[i];
        if (!box || chosen.has(item.id)) return;
        next[item.id] = { x: box.x, y: box.y, w: box.w, h: box.h };
      });
      tidyTargets.forEach((item, i) => {
        const box = packed[i];
        if (box) next[item.id] = { x: box.x, y: box.y, w: box.w, h: box.h };
      });
      return next;
    });
    if (picked.size <= 1) setFitNonce((n) => n + 1);
  };

  if (!board) return null;

  const saveLabel =
    board.status !== 'ready'
      ? 'Opening…'
      : saveState === 'saving'
        ? 'Saving…'
        : saveState === 'error'
          ? 'Not saved'
          : saveState === 'saved'
            ? 'Saved'
            : '';
  const count =
    board.ids.length > items.length
      ? `${items.length} of ${board.ids.length}`
      : `${items.length} reference${board.ids.length === 1 ? '' : 's'}`;

  return (
    <div className="board">
      <header className="board-bar">
        <div className="board-title">
          <h2>{folderName || 'Board'}</h2>
          <span
            className="board-count"
            title={board.ids.length > items.length ? 'Some items of this board are still loading' : undefined}
          >
            {picked.size ? `${picked.size} selected` : count}
          </span>
          {folderId && (
            <span
              className={cls('board-save', saveState === 'error' && 'error')}
              title="The folder keeps this arrangement: every image's place, the layout and the view"
            >
              {saveLabel}
            </span>
          )}
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
          {mode === 'free' && (
            <div className="board-seg" role="group" aria-label="Tools">
              {TOOLS.map((entry) => (
                <button
                  key={entry.key}
                  className={cls(tool === entry.key && 'on')}
                  title={`${entry.label} (${entry.hint})`}
                  aria-pressed={tool === entry.key}
                  onClick={() => setTool(entry.key)}
                >
                  {entry.icon}
                  {!compact && <span>{entry.label}</span>}
                </button>
              ))}
            </div>
          )}
          {mode === 'free' && tidyTargets.length > 1 && (
            <button
              className="board-tidy"
              title={
                picked.size > 1
                  ? `Tidy ${picked.size} selected, keeping their sizes`
                  : 'Tidy up, keeping each image’s size'
              }
              onClick={tidy}
            >
              <Sparkles size={14} />
              {!compact && <span>{picked.size > 1 ? 'Tidy selection' : 'Tidy'}</span>}
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
        className={cls(
          'board-stage',
          (panning || spaceHeld || (mode === 'free' && tool === 'hand')) && 'panning',
          mode === 'free' && tool === 'select' && !spaceHeld && 'selecting'
        )}
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
            const src = boardVisual(item);
            if (!box || !src) return null;
            const z = zOrder.indexOf(item.id);
            return (
              <div
                key={item.id}
                className={cls(
                  'board-item',
                  mode === 'grid' && 'grid',
                  mode === 'free' && 'free',
                  draggingId === item.id && 'dragging',
                  resizingId === item.id && 'resizing',
                  picked.has(item.id) && 'picked'
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
                  <button title="Full screen (double-click)" onClick={() => openViewer(item)}>
                    <Scan size={14} />
                  </button>
                  {!folderId && (
                    <button className="danger" title="Remove from board" onClick={() => remove(item.id)}>
                      <X size={14} />
                    </button>
                  )}
                </div>
                {mode === 'free' && tool === 'select' && (
                  <button
                    className="board-item-resize"
                    title="Drag to resize"
                    aria-label={`Resize ${item.name}`}
                    onPointerDown={(e) => startResize(e, item, box)}
                  />
                )}
              </div>
            );
          })}
          {marquee && (
            <div
              className="board-marquee"
              style={{ transform: `translate(${marquee.x}px, ${marquee.y}px)`, width: marquee.w, height: marquee.h }}
            />
          )}
        </div>

        {board.status !== 'ready' && (
          <div className="board-empty">
            <Loader2 size={34} className="spin" strokeWidth={1.6} />
            <h3>Opening the board</h3>
            <p>Loading every image in this folder.</p>
          </div>
        )}
        {board.status === 'ready' && !items.length && (
          <div className="board-empty">
            <Images size={40} strokeWidth={1.3} />
            <h3>Nothing to show</h3>
            <p>{folderId ? 'This folder has no images to arrange yet.' : 'The selected items have no preview images.'}</p>
          </div>
        )}
        {board.status === 'ready' && items.length > 0 && (
          <div className="board-hint">
            {mode === 'free'
              ? tool === 'select'
                ? 'Click or drag to select · Shift adds · Drag a corner to resize · Tidy keeps sizes'
                : 'Drag to pan · V to select · Scroll to zoom'
              : 'Drag to pan · Scroll to zoom'}
          </div>
        )}
      </div>
    </div>
  );
}
