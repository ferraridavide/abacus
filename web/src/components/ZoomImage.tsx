import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useStore } from '../store';
import type { Item } from '../types';
import { cls } from './ui';
import {
  FIT_TRANSFORM,
  MIN_VIEW_SCALE,
  clampPan,
  clampScale,
  fittedBox,
  formatZoom,
  isAtFit,
  maxScale,
  panLimits,
  pixelRatio,
  zoomAtPoint,
  type ImageTransform,
  type Point,
  type Size,
} from '../lib/imageZoom';

interface Gesture {
  start: Point;
  transform: ImageTransform;
  distance: number;
  pan: boolean;
}

function pointerCenter(points: Point[]) {
  const [a, b = a] = points;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function pointerDistance(points: Point[]) {
  return points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

export function ZoomImage({ item }: { item: Item }) {
  const [transform, setTransform] = useState(FIT_TRANSFORM);
  const [box, setBox] = useState<Size | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const transformRef = useRef(transform);
  const boxRef = useRef(box);
  const naturalRef = useRef(natural);
  const fittedRef = useRef(true);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);

  // Event bursts (wheel, pinch, resize) must read the latest transform before React renders.
  const updateTransform = (next: ImageTransform, fitted = isAtFit(next)) => {
    transformRef.current = next;
    fittedRef.current = fitted;
    setTransform(next);
  };

  const bounds = (): Size => ({ w: ref.current!.clientWidth, h: ref.current!.clientHeight });
  const relativePoint = (point: Point): Point => {
    const rect = ref.current!.getBoundingClientRect();
    return { x: point.x - rect.left - rect.width / 2, y: point.y - rect.top - rect.height / 2 };
  };
  const fit = () => updateTransform(FIT_TRANSFORM, true);

  const zoom = (nextScale: number, point: Point = { x: 0, y: 0 }) => {
    const layout = boxRef.current;
    const original = naturalRef.current;
    if (!layout || !original || !ref.current) return;
    const scale = clampScale(nextScale, original.w / layout.w);
    const next = zoomAtPoint(transformRef.current, point, scale);
    updateTransform({ scale, ...clampPan(next, scale, layout, bounds()) });
  };
  const step = (factor: number) => zoom(transformRef.current.scale * factor);
  const actualSize = () => {
    if (naturalRef.current && boxRef.current) zoom(naturalRef.current.w / boxRef.current.w);
  };

  useEffect(() => {
    const element = ref.current!;
    const onWheel = (event: WheelEvent) => {
      // Also prevent browser/page zoom while an original is loading.
      event.preventDefault();
      if ((event.target as HTMLElement).closest('.zoom-controls')) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      zoom(transformRef.current.scale * Math.exp(-delta * 0.0016), relativePoint({ x: event.clientX, y: event.clientY }));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const element = ref.current!;
    const observer = new ResizeObserver(() => {
      const original = naturalRef.current;
      if (!original) return;
      const next = fittedBox(bounds(), original);
      if (!next) return;
      const previous = boxRef.current;
      boxRef.current = next;
      setBox(next);
      if (!previous || fittedRef.current) return fit();
      // Preserve actual pixel magnification when the viewport or orientation changes.
      const current = transformRef.current;
      const scale = clampScale(current.scale * previous.w / next.w, original.w / next.w);
      updateTransform({ scale, ...clampPan(current, scale, next, bounds()) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const state = useStore.getState();
      if (
        target?.closest('input, textarea, select, [contenteditable]') || state.details || state.settingsOpen ||
        state.importOpen || state.confirm || state.folderPicker || event.metaKey || event.ctrlKey || event.altKey
      ) return;
      const actions: Record<string, () => void> = {
        '0': fit,
        '1': actualSize,
        '+': () => step(1.25),
        '=': () => step(1.25),
        ']': () => step(1.25),
        '-': () => step(1 / 1.25),
        '[': () => step(1 / 1.25),
      };
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      action();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const startGesture = (pan: boolean) => {
    const points = [...pointers.current.values()].slice(0, 2);
    gesture.current = {
      start: pointerCenter(points), distance: pointerDistance(points),
      transform: transformRef.current, pan,
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.zoom-controls') || !boxRef.current) return;
    if (event.pointerType !== 'touch' && event.button !== 0 && event.button !== 1) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 1) suppressClick.current = false;
    const limits = panLimits(transformRef.current.scale, boxRef.current, bounds());
    const pan = limits.x > 0 || limits.y > 0 || pointers.current.size > 1;
    startGesture(pan);
    setDragging(pan);
    if (pointers.current.size > 1) suppressClick.current = true;
    // Let the stage see touch starts so a second finger cancels item navigation.
    if (event.pointerType !== 'touch') {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const start = gesture.current;
    const layout = boxRef.current;
    const original = naturalRef.current;
    if (!start?.pan || !layout || !original) return;
    event.preventDefault();
    event.stopPropagation();
    const points = [...pointers.current.values()].slice(0, 2);
    const center = pointerCenter(points);
    const dx = center.x - start.start.x;
    const dy = center.y - start.start.y;
    const distance = pointerDistance(points);
    if (Math.hypot(dx, dy) > 3 || points.length > 1) suppressClick.current = true;
    if (!suppressClick.current) return;
    const ratio = start.distance > 0 && points.length > 1 ? distance / start.distance : 1;
    const scale = clampScale(start.transform.scale * ratio, original.w / layout.w);
    const next = zoomAtPoint(start.transform, relativePoint(start.start), scale);
    updateTransform({ scale, ...clampPan({ x: next.x + dx, y: next.y + dy }, scale, layout, bounds()) });
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (gesture.current?.pan) event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (pointers.current.size) {
      startGesture(true);
      return;
    }
    gesture.current = null;
    setDragging(false);
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('.zoom-controls')) return;
    event.stopPropagation();
    const layout = boxRef.current;
    const original = naturalRef.current;
    if (!layout || !original) return;
    if (!isAtFit(transformRef.current)) return fit();
    const actual = original.w / layout.w;
    zoom(Math.abs(actual - 1) < 0.04 ? 2 : actual, relativePoint({ x: event.clientX, y: event.clientY }));
  };

  const onLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    if (!image.naturalWidth) return;
    const original = { w: image.naturalWidth, h: image.naturalHeight };
    naturalRef.current = original;
    boxRef.current = fittedBox(bounds(), original);
    setNatural(original);
    setBox(boxRef.current);
    fit();
  };

  const magnification = natural && box ? pixelRatio(transform.scale, box, natural) : 1;
  const atFit = isAtFit(transform);
  const loaded = !!natural && !!box;
  const limits = loaded ? panLimits(transform.scale, box, bounds()) : { x: 0, y: 0 };
  const pannable = limits.x > 0 || limits.y > 0;
  return (
    <div
      ref={ref}
      className={cls('zoom-wrap', pannable && 'pannable', dragging && 'dragging')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onClick={(event) => { if (suppressClick.current) event.stopPropagation(); }}
      onDoubleClick={onDoubleClick}
    >
      {!loaded && item.thumbUrl && <img className="zoom-img placeholder" src={item.thumbUrl} alt="" draggable={false} />}
      <img
        className="zoom-img"
        src={item.fileUrl!}
        alt={item.name}
        draggable={false}
        onLoad={onLoad}
        style={{
          width: box?.w,
          height: box?.h,
          maxWidth: box ? 'none' : '100%',
          maxHeight: box ? 'none' : '100%',
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          opacity: loaded ? 1 : 0,
        }}
      />
      <div
        className="zoom-controls"
        role="group"
        aria-label="Image zoom"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out (− or [)"
          disabled={!loaded || transform.scale <= MIN_VIEW_SCALE}
          onClick={() => step(1 / 1.25)}
        >
          <Minus size={16} />
        </button>
        <output className="zoom-level" aria-label="Zoom level">{loaded ? formatZoom(magnification) : '…'}</output>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in (+ or ])"
          disabled={!loaded || transform.scale >= maxScale(natural!.w / box!.w)}
          onClick={() => step(1.25)}
        >
          <Plus size={16} />
        </button>
        <span className="zoom-divider" />
        <button type="button" title="Fit image (0)" aria-pressed={atFit} disabled={!loaded} onClick={fit}>Fit</button>
        <button
          type="button"
          title="Actual size (1)"
          aria-pressed={Math.abs(magnification - 1) < 0.001}
          disabled={!loaded}
          onClick={actualSize}
        >
          100%
        </button>
      </div>
    </div>
  );
}
