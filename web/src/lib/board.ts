import type { Item } from '../types';
import type { BoardMode, BoardSpot, BoardView, FolderBoard } from '../types';
import type { Box } from './layout';

// The board's storage format and the arithmetic behind keeping a folder's arrangement stable:
// every image keeps the place (and size) it was left in, and images added later settle in beside
// what is already there instead of pushing the saved ones around.
//
// normalizeBoard() and the server's copy in server/src/board.js must stay in step: the server stores
// what this sends and answers with what it parsed, so a difference between them would show up as a
// board that keeps saving itself.

export const MAX_SPOTS = 8000;
/** Free space left between the saved arrangement and images that arrived after it. */
export const PARK_GAP = 64;
export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 4;

const SPAN = 1_000_000;
const MIN_SIZE = 8;
const MAX_SIZE = 8000;
const ID = /^[\w-]{1,80}$/;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const EMPTY_BOARD: FolderBoard = { mode: 'free', view: null, spots: {}, zOrder: [] };

/** The picture a board shows for an item, if it has one. */
export function boardVisual(item: Item): string | null {
  if (item.thumbUrl) return item.thumbUrl;
  if (item.previewUrl) return item.previewUrl;
  if (item.type === 'image' || item.type === 'gif') return item.fileUrl;
  return null;
}

export const spotBox = (spot: BoardSpot): Box => ({ x: spot.x, y: spot.y, w: spot.w, h: spot.h });

function readView(raw: unknown): BoardView | null {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, s } = raw as Record<string, unknown>;
  const values = [x, y, s].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [vx, vy, vs] = values;
  return {
    x: round1(clamp(vx, -SPAN, SPAN)),
    y: round1(clamp(vy, -SPAN, SPAN)),
    s: round3(clamp(vs, MIN_ZOOM, MAX_ZOOM)),
  };
}

function readSpot(raw: unknown): BoardSpot | null {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, w, h } = raw as Record<string, unknown>;
  const values = [x, y, w, h].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [sx, sy, sw, sh] = values;
  if (sw <= 0 || sh <= 0) return null;
  return {
    x: round1(clamp(sx, -SPAN, SPAN)),
    y: round1(clamp(sy, -SPAN, SPAN)),
    w: round1(clamp(sw, MIN_SIZE, MAX_SIZE)),
    h: round1(clamp(sh, MIN_SIZE, MAX_SIZE)),
  };
}

/** Accept whatever a client stored, and answer with the one shape a board is kept in. */
export function normalizeBoard(input: unknown): FolderBoard {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const mode: BoardMode = source.mode === 'masonry' || source.mode === 'grid' || source.mode === 'free' ? source.mode : 'free';

  const rawSpots = source.spots && typeof source.spots === 'object' ? (source.spots as Record<string, unknown>) : {};
  const spots: Record<string, BoardSpot> = {};
  let kept = 0;
  for (const id of Object.keys(rawSpots).sort()) {
    if (kept >= MAX_SPOTS) break;
    if (!ID.test(id)) continue;
    const spot = readSpot(rawSpots[id]);
    if (!spot) continue;
    spots[id] = spot;
    kept++;
  }

  const zOrder: string[] = [];
  if (Array.isArray(source.zOrder)) {
    for (const id of source.zOrder) {
      if (typeof id === 'string' && ID.test(id) && !zOrder.includes(id)) zOrder.push(id);
    }
  }

  return { mode, view: readView(source.view), spots, zOrder };
}

/**
 * Move a block of freshly laid-out images clear of what is already on the board, so nothing saved
 * is ever pushed aside by something added later. Tops align, a gap separates the two blocks.
 */
export function parkBeside(occupied: Box[], incoming: Box[]): Box[] {
  if (!occupied.length || !incoming.length) return incoming;
  const right = Math.max(...occupied.map((b) => b.x + b.w));
  const top = Math.min(...occupied.map((b) => b.y));
  const dx = right + PARK_GAP - Math.min(...incoming.map((b) => b.x));
  const dy = top - Math.min(...incoming.map((b) => b.y));
  return incoming.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy }));
}

/**
 * Free-mode boxes for a folder board: saved spots keep their place and size; images without one are
 * laid out as a waterfall and parked beside the saved arrangement.
 *
 * `auto` is the waterfall for every item, `incoming` the waterfall for just the items without a spot
 * (in the same order they appear in it) — with no saved spots at all the two coincide, and the board
 * opens exactly as the folder's waterfall.
 */
export function arrangeFolder(ids: string[], auto: Box[], incoming: Box[], saved: Record<string, BoardSpot>): Box[] {
  const parked = parkBeside(
    ids.flatMap((id) => (saved[id] ? [spotBox(saved[id])] : [])),
    incoming
  );
  let next = 0;
  return ids.map((id, i) => {
    const spot = saved[id];
    if (spot) return spotBox(spot);
    return parked[next++] ?? auto[i];
  });
}

/**
 * A board's spots, keeping the places of images that are no longer in it (trashed, moved out) so
 * restoring them later puts them back where they were. Live images win, and the total stays bounded.
 */
export function rememberSpots(liveIds: string[], current: Record<string, BoardSpot>, previous: Record<string, BoardSpot>): Record<string, BoardSpot> {
  const merged: Record<string, BoardSpot> = {};
  let count = 0;
  const live = new Set(liveIds);
  for (const id of liveIds) {
    const spot = current[id];
    if (!spot) continue;
    merged[id] = spot;
    count++;
  }
  for (const [id, spot] of Object.entries(previous)) {
    if (count >= MAX_SPOTS) break;
    if (live.has(id) || merged[id]) continue;
    merged[id] = spot;
    count++;
  }
  return merged;
}

export interface BoardSnapshotInput {
  mode: BoardMode;
  view: BoardView;
  ids: string[];
  /** the boxes as rendered, in `ids` order */
  boxes: Box[];
  /** manually placed spots, whatever the mode; they keep the free arrangement for later */
  free: Record<string, BoardSpot>;
  /** the spots last loaded or saved, for the place of images that have left */
  previous: Record<string, BoardSpot>;
  zOrder: string[];
}

/**
 * Pack images into rows without changing their sizes. The group stays anchored at its current
 * top-left, so tidying a selection rearranges it in place instead of dragging it across the board.
 */
export function tidyKeepingSizes(boxes: Box[], gap = 14): Box[] {
  if (boxes.length <= 1) return boxes.map((b) => ({ ...b }));
  const originX = Math.min(...boxes.map((b) => b.x));
  const originY = Math.min(...boxes.map((b) => b.y));
  const span = Math.max(...boxes.map((b) => b.x + b.w)) - originX;
  const rowWidth = Math.max(span, ...boxes.map((b) => b.w));
  const placed: Box[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w > rowWidth + 0.5) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    placed.push({ x: originX + x, y: originY + y, w: b.w, h: b.h });
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return placed;
}

/** What to store for a board as it is on screen. */
export function snapshotBoard({ mode, view, ids, boxes, free, previous, zOrder }: BoardSnapshotInput): FolderBoard {
  const current: Record<string, BoardSpot> = {};
  if (mode === 'free') {
    ids.forEach((id, i) => {
      const box = boxes[i];
      if (box) current[id] = { x: box.x, y: box.y, w: box.w, h: box.h };
    });
  } else {
    for (const id of ids) if (free[id]) current[id] = free[id];
  }
  return normalizeBoard({ mode, view, spots: rememberSpots(ids, current, previous), zOrder });
}
