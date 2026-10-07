import type { Item, LayoutMode } from '../types';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutResult {
  boxes: Box[];
  height: number;
}

export const GAP = 14;

/** Height / width ratio used for layout. */
export function aspectOf(item: Item) {
  if (item.width && item.height) return Math.min(3, Math.max(0.28, item.height / item.width));
  if (item.type === 'bookmark') {
    const len = (item.text || item.name || '').length;
    return Math.min(1.4, 0.55 + len / 320);
  }
  return 1;
}

export function computeLayout(
  items: Item[],
  width: number,
  mode: LayoutMode,
  size: number,
  captionH: number
): LayoutResult {
  if (width <= 0 || !items.length) return { boxes: [], height: 0 };

  if (mode === 'justified') return justified(items, width, size, captionH);

  const cols = Math.max(1, Math.round((width + GAP) / (size + GAP)));
  const colW = (width - GAP * (cols - 1)) / cols;
  const boxes: Box[] = new Array(items.length);

  if (mode === 'grid') {
    const h = colW + captionH;
    items.forEach((_, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      boxes[i] = { x: c * (colW + GAP), y: r * (h + GAP), w: colW, h };
    });
    const rows = Math.ceil(items.length / cols);
    return { boxes, height: rows * (h + GAP) - GAP };
  }

  // masonry: always drop into the shortest column
  const heights = new Array(cols).fill(0);
  items.forEach((item, i) => {
    let c = 0;
    for (let k = 1; k < cols; k++) if (heights[k] < heights[c] - 1) c = k;
    const h = Math.round(colW * aspectOf(item)) + captionH;
    boxes[i] = { x: c * (colW + GAP), y: heights[c], w: colW, h };
    heights[c] += h + GAP;
  });
  return { boxes, height: Math.max(...heights) - GAP };
}

function justified(items: Item[], width: number, size: number, captionH: number): LayoutResult {
  const target = size * 0.8;
  const boxes: Box[] = new Array(items.length);
  let y = 0;
  let row: number[] = [];
  let ratioSum = 0;

  const flush = (last: boolean) => {
    if (!row.length) return;
    const available = width - GAP * (row.length - 1);
    let h = available / ratioSum;
    // the trailing row keeps its natural height instead of being blown up to fill the width
    const stretch = !(last && h > target * 1.25);
    if (!stretch) h = target;
    let x = 0;
    row.forEach((idx, k) => {
      const w = stretch && k === row.length - 1 ? width - x : h / aspectOf(items[idx]);
      boxes[idx] = { x, y, w, h: h + captionH };
      x += w + GAP;
    });
    y += h + captionH + GAP;
    row = [];
    ratioSum = 0;
  };

  items.forEach((item, i) => {
    row.push(i);
    ratioSum += 1 / aspectOf(item);
    if (ratioSum * target + GAP * (row.length - 1) >= width) flush(false);
  });
  flush(true);
  return { boxes, height: Math.max(0, y - GAP) };
}
