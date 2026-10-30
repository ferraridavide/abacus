export interface Point {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface ImageTransform extends Point {
  scale: number;
}

export const FIT_TRANSFORM: ImageTransform = { scale: 1, x: 0, y: 0 };
export const MIN_VIEW_SCALE = 0.05;

/** Fit inside the viewport without enlarging small originals. */
export function fittedBox(bounds: Size, natural: Size): Size | null {
  if (!bounds.w || !bounds.h || !natural.w || !natural.h) return null;
  const scale = Math.min(bounds.w / natural.w, bounds.h / natural.h, 1);
  return { w: natural.w * scale, h: natural.h * scale };
}

export function maxScale(actual: number) {
  return Math.max(16, actual * 8);
}

export function clampScale(scale: number, actual: number) {
  return Math.min(maxScale(actual), Math.max(MIN_VIEW_SCALE, scale));
}

export function panLimits(scale: number, box: Size, bounds: Size): Point {
  return {
    x: Math.max(0, (box.w * scale - bounds.w) / 2),
    y: Math.max(0, (box.h * scale - bounds.h) / 2),
  };
}

/** Center axes that fit, and keep the viewport covered on axes that can pan. */
export function clampPan(point: Point, scale: number, box: Size, bounds: Size): Point {
  const { x: maxX, y: maxY } = panLimits(scale, box, bounds);
  return {
    x: maxX ? Math.min(maxX, Math.max(-maxX, point.x)) : 0,
    y: maxY ? Math.min(maxY, Math.max(-maxY, point.y)) : 0,
  };
}

/** Preserve the image point under the cursor (coordinates relative to viewport center). */
export function zoomAtPoint(previous: ImageTransform, point: Point, scale: number): ImageTransform {
  const ratio = scale / previous.scale;
  return {
    scale,
    x: point.x - (point.x - previous.x) * ratio,
    y: point.y - (point.y - previous.y) * ratio,
  };
}

export function isAtFit(transform: ImageTransform) {
  return Math.abs(transform.scale - 1) < 0.001 && Math.hypot(transform.x, transform.y) < 0.5;
}

export function pixelRatio(scale: number, box: Size, natural: Size) {
  return scale * box.w / natural.w;
}

export function formatZoom(ratio: number) {
  const percent = ratio * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}
