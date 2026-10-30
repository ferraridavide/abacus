import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ExternalLink, Info, X } from 'lucide-react';
import { useStore } from '../store';
import type { Item } from '../types';
import { itemMeta, safeHref } from '../lib/format';
import { BookmarkFace } from './Card';
import { useCompact } from './ui';
import { ZoomImage } from './ZoomImage';

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
      if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return;
      const s = useStore.getState();
      if (s.details || s.settingsOpen || s.importOpen || s.confirm || s.folderPicker) return;
      const idx = s.items.findIndex((i) => i.id === s.viewerId);
      if (e.key === ' ' && (e.target as HTMLElement)?.closest('button, a')) return;
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
            <a className="icon-btn" href={safeHref(item.url) ?? undefined} target="_blank" rel="noreferrer" title="Open source">
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
          swipe.current = e.pointerType === 'touch' && e.isPrimary ? { x: e.clientX, y: e.clientY } : null;
        }}
        onPointerCancel={() => { swipe.current = null; }}
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
        <button className="viewer-nav left" aria-label="Previous item" onClick={() => go(-1)}>
          <ChevronLeft size={26} />
        </button>
      )}
      {index < items.length - 1 && (
        <button className="viewer-nav right" aria-label="Next item" onClick={() => go(1)}>
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
        {item.thumbUrl && <img className="viewer-bookmark-image" src={item.thumbUrl} alt="" draggable={false} />}
        <BookmarkFace item={item} large />
        {item.url && (
          <a className="btn primary" href={safeHref(item.url) ?? undefined} target="_blank" rel="noreferrer">
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
