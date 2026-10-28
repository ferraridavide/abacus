import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ExternalLink, Info, X } from 'lucide-react';
import { useStore } from '../store';
import type { Item } from '../types';
import { itemMeta } from '../lib/format';
import { BookmarkFace } from './Card';
import { useCompact } from './ui';

export function Viewer() {
  const viewerId = useStore((s) => s.viewerId);
  const items = useStore((s) => s.items);
  const set = useStore((s) => s.set);
  const compact = useCompact();
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const index = items.findIndex((i) => i.id === viewerId);
  const item = index >= 0 ? items[index] : null;

  useEffect(() => {
    if (!viewerId) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return;
      const s = useStore.getState();
      if (s.details) return; // the details sheet is on top
      const idx = s.items.findIndex((i) => i.id === s.viewerId);
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.set({ viewerId: null });
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const next = s.items[Math.min(s.items.length - 1, idx + 1)];
        if (next) s.set({ viewerId: next.id, selected: new Set([next.id]), anchor: next.id });
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const prev = s.items[Math.max(0, idx - 1)];
        if (prev) s.set({ viewerId: prev.id, selected: new Set([prev.id]), anchor: prev.id });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [viewerId]);

  useEffect(() => {
    if (index >= 0 && index >= items.length - 5) useStore.getState().loadMore();
  }, [index, items.length]);

  if (!item) return null;

  const go = (d: number) => {
    const next = items[index + d];
    if (next) set({ viewerId: next.id, selected: new Set([next.id]), anchor: next.id });
  };

  return createPortal(
    <div className="viewer">
      <div className="viewer-bar">
        <div className="viewer-title">
          <span className="viewer-name">{item.name}</span>
          <span className="viewer-meta">
            {itemMeta(item)} · {index + 1} / {items.length}
          </span>
        </div>
        <div className="viewer-actions">
          {compact && (
            <button
              className="icon-btn"
              title="Details"
              onClick={() => set({ selected: new Set([item.id]), anchor: item.id, details: 'selection' })}
            >
              <Info size={18} />
            </button>
          )}
          {item.url && (
            <a className="icon-btn" href={item.url} target="_blank" rel="noreferrer" title="Open source">
              <ExternalLink size={17} />
            </a>
          )}
          {item.fileUrl && (
            <a className="icon-btn" href={item.fileUrl} download title="Download">
              <Download size={17} />
            </a>
          )}
          <button className="icon-btn" onClick={() => set({ viewerId: null })} title="Close (Esc)">
            <X size={19} />
          </button>
        </div>
      </div>
      <div
        className="viewer-stage"
        onClick={(e) => {
          // a double-click zooms the image, it shouldn't also close the viewer
          if (e.target !== e.currentTarget || e.detail > 1) return;
          set({ viewerId: null });
        }}
        // swipe sideways for the next or previous item; a zoomed image claims
        // the touch for panning and stops it before it gets here
        onPointerDown={(e) => {
          swipe.current = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY } : null;
        }}
        onPointerUp={(e) => {
          const start = swipe.current;
          swipe.current = null;
          if (!start) return;
          const dx = e.clientX - start.x;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - start.y) * 1.5) go(dx < 0 ? 1 : -1);
        }}
      >
        <ViewerMedia key={item.id} item={item} />
      </div>
      {index > 0 && (
        <button className="viewer-nav left" onClick={() => go(-1)}>
          <ChevronLeft size={26} />
        </button>
      )}
      {index < items.length - 1 && (
        <button className="viewer-nav right" onClick={() => go(1)}>
          <ChevronRight size={26} />
        </button>
      )}
    </div>,
    document.body
  );
}

function ViewerMedia({ item }: { item: Item }) {
  if (item.type === 'bookmark') {
    return (
      <div className="viewer-bookmark">
        <BookmarkFace item={item} large />
        {item.url && (
          <a className="btn primary" href={item.url} target="_blank" rel="noreferrer">
            Open {item.source === 'x' ? 'on X' : 'link'} <ExternalLink size={14} />
          </a>
        )}
      </div>
    );
  }
  if ((item.type === 'video' || (item.type === 'gif' && item.ext !== 'gif')) && item.fileUrl) {
    return (
      <video
        className="viewer-video"
        src={item.fileUrl}
        poster={item.thumbUrl || undefined}
        controls={item.type === 'video'}
        autoPlay
        loop
        muted={item.type === 'gif'}
        playsInline
      />
    );
  }
  if ((item.type === 'image' || item.type === 'gif') && item.fileUrl) return <ZoomImage item={item} />;
  return (
    <div className="viewer-bookmark">
      <div className="file-face big">
        <span>{(item.ext || 'file').toUpperCase()}</span>
      </div>
      {item.fileUrl && (
        <a className="btn primary" href={item.fileUrl} target="_blank" rel="noreferrer">
          Open file <ExternalLink size={14} />
        </a>
      )}
    </div>
  );
}

const MIN_VIEW_SCALE = 0.05;
const PAN_MARGIN = 80;

/** Layout size that fits the image in the stage without scaling it above actual pixels. */
function fittedBox(wrap: HTMLElement, nw: number, nh: number) {
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (!w || !h || !nw || !nh) return null;
  const s = Math.min(w / nw, h / nh, 1);
  return { w: nw * s, h: nh * s };
}

/** Scale is relative to the fitted box. 1 = fit, natural/box = 100% pixels. */
function clampScale(scale: number, actual: number) {
  return Math.min(Math.max(16, actual * 8), Math.max(MIN_VIEW_SCALE, scale));
}

/** Keep a grab edge on screen so a zoomed-out image can still be dragged back. */
function clampPan(
  x: number,
  y: number,
  scale: number,
  layout: { w: number; h: number },
  wrap: HTMLElement
) {
  const maxX = Math.max(0, (layout.w * scale) / 2 + wrap.clientWidth / 2 - PAN_MARGIN);
  const maxY = Math.max(0, (layout.h * scale) / 2 + wrap.clientHeight / 2 - PAN_MARGIN);
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

function formatZoom(ratio: number) {
  const pct = ratio * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/**
 * Eagle-style canvas: the image opens fitted, never above actual pixels.
 * Wheel zooms in or out around the cursor, drag pans at every zoom, double-click
 * toggles fit and actual pixels.
 */
function ZoomImage({ item }: { item: Item }) {
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const tRef = useRef(t);
  const boxRef = useRef(box);
  const naturalRef = useRef(natural);
  const fittedRef = useRef(true);
  tRef.current = t;
  boxRef.current = box;
  naturalRef.current = natural;

  const zoomAt = (clientX: number, clientY: number, nextScale: number) => {
    const wrap = ref.current;
    const layout = boxRef.current;
    const n = naturalRef.current;
    if (!wrap || !layout || !n) return;
    const actual = n.w / layout.w;
    const scale = clampScale(nextScale, actual);
    const r = wrap.getBoundingClientRect();
    const cx = clientX - r.left - r.width / 2;
    const cy = clientY - r.top - r.height / 2;
    const prev = tRef.current;
    const k = scale / prev.scale;
    const panned = clampPan(cx - (cx - prev.x) * k, cy - (cy - prev.y) * k, scale, layout, wrap);
    fittedRef.current = false;
    setT({ scale, ...panned });
  };

  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      if (!boxRef.current) return;
      e.preventDefault();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
      zoomAt(e.clientX, e.clientY, tRef.current.scale * Math.exp(-delta * 0.0016));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const n = naturalRef.current;
      if (!n) return;
      const next = fittedBox(el, n.w, n.h);
      if (!next) return;
      const prev = boxRef.current;
      if (!prev || fittedRef.current) {
        setBox(next);
        setT({ scale: 1, x: 0, y: 0 });
        return;
      }
      if (Math.abs(prev.w - next.w) < 0.5 && Math.abs(prev.h - next.h) < 0.5) return;
      const k = prev.w / next.w;
      setBox(next);
      setT((p) => {
        const scale = clampScale(p.scale * k, n.w / next.w);
        return { scale, ...clampPan(p.x, p.y, scale, next, el) };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return;
      if (e.key === '0') {
        e.preventDefault();
        e.stopPropagation();
        fittedRef.current = true;
        setT({ scale: 1, x: 0, y: 0 });
      } else if (e.key === ']') {
        e.preventDefault();
        e.stopPropagation();
        const wrap = ref.current;
        if (!wrap) return;
        const r = wrap.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, tRef.current.scale * 1.25);
      } else if (e.key === '[') {
        e.preventDefault();
        e.stopPropagation();
        const wrap = ref.current;
        if (!wrap) return;
        const r = wrap.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, tRef.current.scale / 1.25);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (!boxRef.current) return;
    // On a touch screen a fitted image leaves the gesture to the stage, which
    // swipes to the next item; once zoomed, one finger pans the image instead.
    const t0 = tRef.current;
    const atFit = Math.abs(t0.scale - 1) < 0.02 && Math.hypot(t0.x, t0.y) < 4;
    if (e.pointerType === 'touch' && atFit) return;
    e.stopPropagation();
    e.preventDefault();
    const wrap = e.currentTarget;
    wrap.setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, y: e.clientY };
    const start = { x: e.clientX, y: e.clientY, ox: tRef.current.x, oy: tRef.current.y, moved: false };
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (dx * dx + dy * dy > 9) start.moved = true;
      const layout = boxRef.current;
      if (!layout) return;
      const scale = tRef.current.scale;
      setT({ scale, ...clampPan(start.ox + dx, start.oy + dy, scale, layout, wrap) });
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      wrap.removeEventListener('pointermove', onMove);
      wrap.removeEventListener('pointerup', onUp);
      wrap.removeEventListener('pointercancel', onUp);
      setDragging(false);
      if (start.moved) fittedRef.current = false;
    };
    wrap.addEventListener('pointermove', onMove);
    wrap.addEventListener('pointerup', onUp);
    // a pinch hands the touch to the browser, which cancels the pointer
    wrap.addEventListener('pointercancel', onUp);
  };

  const onClick = (e: React.MouseEvent) => {
    if (Math.hypot(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y) > 4) e.stopPropagation();
  };

  const onDouble = (e: React.MouseEvent) => {
    const wrap = ref.current;
    const layout = boxRef.current;
    const n = naturalRef.current;
    if (!wrap || !layout || !n) return;
    const atFit = Math.abs(t.scale - 1) < 0.02 && Math.hypot(t.x, t.y) < 4;
    if (!atFit) {
      fittedRef.current = true;
      setT({ scale: 1, x: 0, y: 0 });
      return;
    }
    const actual = n.w / layout.w;
    const scale = Math.abs(actual - 1) < 0.04 ? 2 : actual;
    zoomAt(e.clientX, e.clientY, scale);
  };

  const onLoad = () => {
    const img = imgRef.current;
    const wrap = ref.current;
    if (!img || !wrap || !img.naturalWidth) return;
    const n = { w: img.naturalWidth, h: img.naturalHeight };
    setNatural(n);
    setBox(fittedBox(wrap, n.w, n.h));
    fittedRef.current = true;
    setT({ scale: 1, x: 0, y: 0 });
    setLoaded(true);
  };

  const pixel = natural && box ? (t.scale * natural.w) / box.w : t.scale;
  const offFit = Math.abs(t.scale - 1) > 0.015 || Math.hypot(t.x, t.y) > 4;

  return (
    <div
      ref={ref}
      className={dragging ? 'zoom-wrap dragging' : 'zoom-wrap'}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDouble}
    >
      {!loaded && item.thumbUrl && <img className="zoom-img placeholder" src={item.thumbUrl} alt="" draggable={false} />}
      <img
        ref={imgRef}
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
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          opacity: loaded ? 1 : 0,
        }}
      />
      {loaded && offFit && <div className="zoom-level">{formatZoom(pixel)}</div>}
    </div>
  );
}
