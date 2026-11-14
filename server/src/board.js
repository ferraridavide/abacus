// The board's storage format, mirroring web/src/lib/board.ts. The web client sends a board in
// this shape and the server answers with what it stored, so the two normalizers have to agree: a
// difference between them would show up as a board that keeps saving itself.

export const MAX_SPOTS = 8000;
const SPAN = 1_000_000;
const MIN_SIZE = 8;
const MAX_SIZE = 8000;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 4;
const ID = /^[\w-]{1,80}$/;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;

/** A board with nothing saved in it: free placement, no camera, and the folder's waterfall on show. */
export const emptyBoard = () => ({ mode: 'free', view: null, spots: {}, zOrder: [] });

function readView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const values = [raw.x, raw.y, raw.s].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [x, y, s] = values;
  return {
    x: round1(clamp(x, -SPAN, SPAN)),
    y: round1(clamp(y, -SPAN, SPAN)),
    s: round3(clamp(s, MIN_ZOOM, MAX_ZOOM)),
  };
}

function readSpot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const values = [raw.x, raw.y, raw.w, raw.h].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [x, y, w, h] = values;
  if (w <= 0 || h <= 0) return null;
  return {
    x: round1(clamp(x, -SPAN, SPAN)),
    y: round1(clamp(y, -SPAN, SPAN)),
    w: round1(clamp(w, MIN_SIZE, MAX_SIZE)),
    h: round1(clamp(h, MIN_SIZE, MAX_SIZE)),
  };
}

/** Accept whatever a client stored, and answer with the one shape a board is kept in. */
export function normalizeBoard(input) {
  const source = input && typeof input === 'object' ? input : {};
  const mode = source.mode === 'masonry' || source.mode === 'grid' || source.mode === 'free' ? source.mode : 'free';

  const rawSpots = source.spots && typeof source.spots === 'object' ? source.spots : {};
  const spots = {};
  let kept = 0;
  for (const id of Object.keys(rawSpots).sort()) {
    if (kept >= MAX_SPOTS) break;
    if (!ID.test(id)) continue;
    const spot = readSpot(rawSpots[id]);
    if (!spot) continue;
    spots[id] = spot;
    kept++;
  }

  const zOrder = [];
  if (Array.isArray(source.zOrder)) {
    for (const id of source.zOrder) {
      if (typeof id === 'string' && ID.test(id) && !zOrder.includes(id)) zOrder.push(id);
    }
  }

  return { mode, view: readView(source.view), spots, zOrder };
}
