import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react';
import { useStore } from '../store';
import type { Item } from '../types';
import { itemMeta } from '../lib/format';
import { BookmarkFace } from './Card';

export function Viewer() {
  const viewerId = useStore((s) => s.viewerId);
  const items = useStore((s) => s.items);
  const set = useStore((s) => s.set);
  const index = items.findIndex((i) => i.id === viewerId);
  const item = index >= 0 ? items[index] : null;

  useEffect(() => {
    if (!viewerId) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return;
      const s = useStore.getState();
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
      <div className="viewer-stage" onClick={(e) => e.target === e.currentTarget && set({ viewerId: null })}>
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

/** Image with wheel-zoom around the cursor, drag-to-pan and double-click to toggle 100%. */
function ZoomImage({ item }: { item: Item }) {
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2;
      const cy = e.clientY - r.top - r.height / 2;
      setT((prev) => {
        const scale = Math.min(12, Math.max(1, prev.scale * Math.exp(-e.deltaY * 0.0022)));
        const k = scale / prev.scale;
        if (scale === 1) return { scale: 1, x: 0, y: 0 };
        return { scale, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    if (t.scale === 1) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y };
    const move = (ev: MouseEvent) =>
      setT((p) => ({ ...p, x: start.ox + ev.clientX - start.x, y: start.oy + ev.clientY - start.y }));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onDouble = (e: React.MouseEvent) => {
    if (t.scale !== 1) return setT({ scale: 1, x: 0, y: 0 });
    const img = imgRef.current;
    if (!img) return;
    const natural = img.naturalWidth / img.getBoundingClientRect().width;
    const scale = Math.max(2, natural);
    const r = ref.current!.getBoundingClientRect();
    const cx = e.clientX - r.left - r.width / 2;
    const cy = e.clientY - r.top - r.height / 2;
    setT({ scale, x: -cx * (scale - 1), y: -cy * (scale - 1) });
  };

  return (
    <div
      ref={ref}
      className="zoom-wrap"
      style={{ cursor: t.scale > 1 ? 'grab' : 'zoom-in' }}
      onMouseDown={onMouseDown}
      onDoubleClick={onDouble}
    >
      {!loaded && item.thumbUrl && <img className="zoom-img placeholder" src={item.thumbUrl} alt="" draggable={false} />}
      <img
        ref={imgRef}
        className="zoom-img"
        src={item.fileUrl!}
        alt={item.name}
        draggable={false}
        onLoad={() => setLoaded(true)}
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          opacity: loaded ? 1 : 0,
        }}
      />
      {t.scale > 1 && <div className="zoom-level">{Math.round(t.scale * 100)}%</div>}
    </div>
  );
}
