import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Folder as FolderIcon, ImagePlus, SearchX, Trash2, Upload } from 'lucide-react';
import { useStore } from '../store';
import type { Item } from '../types';
import { computeLayout, type Box } from '../lib/layout';
import { dragKind, dropOnFolder, ITEM_MIME, setItemDragImage } from '../lib/dnd';
import { Card } from './Card';
import { cls, useMediaQuery, XLogo } from './ui';

const OVERSCAN = 900;
const STEP = 300;
const LONG_PRESS = 450;

export function Grid() {
  const items = useStore((s) => s.items);
  const loading = useStore((s) => s.loading);
  const layout = useStore((s) => s.layout);
  const thumbSize = useStore((s) => s.thumbSize);
  const showInfo = useStore((s) => s.showInfo);
  const selected = useStore((s) => s.selected);
  const view = useStore((s) => s.view);
  const scores = useStore((s) => (s.ranking ? s.scores : null));

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const measure = () => {
      const cs = getComputedStyle(el);
      setWidth(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
      setViewport((v) => ({ ...v, height: el.clientHeight }));
    };
    measure(); // don't wait for the first ResizeObserver callback (it never fires in a background tab)
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // reset scroll when the view changes
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [view]);

  const captionH = showInfo ? 46 : 0;
  const { boxes, height } = useMemo(
    () => computeLayout(items, width, layout, thumbSize, captionH),
    [items, width, layout, thumbSize, captionH]
  );

  // Only re-render when the scroll position crosses a STEP boundary; OVERSCAN keeps the edges covered.
  const onScroll = useCallback(() => {
    const el = scrollRef.current!;
    const top = Math.floor(el.scrollTop / STEP) * STEP;
    setViewport((v) => (v.top === top && v.height === el.clientHeight ? v : { top, height: el.clientHeight }));
  }, []);

  const offsetTop = contentRef.current?.offsetTop ?? 0;
  const visible = useMemo(() => {
    const top = viewport.top - offsetTop - OVERSCAN;
    const bottom = viewport.top - offsetTop + viewport.height + OVERSCAN;
    const out: number[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b && b.y + b.h >= top && b.y <= bottom) out.push(i);
    }
    return out;
  }, [boxes, viewport, offsetTop]);

  // infinite loading: fetch the next page when within ~2 screens of the end of what's loaded
  const total = useStore((s) => s.total);
  const loadingMore = useStore((s) => s.loadingMore);
  useEffect(() => {
    if (items.length >= total || !width) return;
    if (viewport.top + viewport.height * 3 + STEP > offsetTop + height) useStore.getState().loadMore();
  }, [viewport, height, offsetTop, items.length, total, width]);

  // ----- interactions -----
  // Touch works like a phone's photo library: a tap opens the viewer, a long press starts a selection,
  // and while something is selected taps add to it or take away from it.
  const fine = useMediaQuery('(pointer: fine)');
  const pointerType = useRef('mouse');
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const pressed = useRef(false);

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    pointerType.current = e.pointerType;
    pressed.current = false;
    cancelPress();
    const id = (e.target as HTMLElement).closest<HTMLElement>('.card')?.dataset.id;
    if (e.pointerType === 'mouse' || !id) return;
    const timer = setTimeout(() => {
      press.current = null;
      pressed.current = true;
      const s = useStore.getState();
      if (!s.selected.has(id)) s.select(id, 'toggle');
      navigator.vibrate?.(10);
    }, LONG_PRESS);
    press.current = { timer, x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
  };

  const onCardClick = useCallback((e: React.MouseEvent, item: Item) => {
    e.stopPropagation();
    const { select, set, selected } = useStore.getState();
    if (pointerType.current !== 'mouse') {
      if (pressed.current) pressed.current = false; // the click that ends a long press
      else if (selected.size) select(item.id, 'toggle');
      else set({ viewerId: item.id });
      return;
    }
    if (e.metaKey || e.ctrlKey) select(item.id, 'toggle');
    else if (e.shiftKey) select(item.id, 'range');
    else select(item.id, 'single');
  }, []);

  const onCardDouble = useCallback((item: Item) => useStore.getState().set({ viewerId: item.id }), []);

  const onCardContext = useCallback((e: React.MouseEvent, item: Item) => {
    e.preventDefault();
    e.stopPropagation();
    if (pointerType.current !== 'mouse') return; // a long press selects instead
    const s = useStore.getState();
    if (!s.selected.has(item.id)) s.select(item.id, 'single');
    s.set({ contextMenu: { x: e.clientX, y: e.clientY, kind: 'item', id: item.id } });
  }, []);

  const onCardDragStart = useCallback((e: React.DragEvent, item: Item) => {
    const s = useStore.getState();
    let ids = [...s.selected];
    if (!s.selected.has(item.id)) {
      s.select(item.id, 'single');
      ids = [item.id];
    }
    e.dataTransfer.setData(ITEM_MIME, JSON.stringify(ids));
    if (item.fileUrl) e.dataTransfer.setData('text/uri-list', new URL(item.fileUrl, location.href).href);
    e.dataTransfer.effectAllowed = 'copyMove';
    const thumbs = ids.slice(0, 3).map((id) => s.items.find((i) => i.id === id)?.thumbUrl ?? null);
    setItemDragImage(e, thumbs, ids.length);
  }, []);

  // rubber-band selection
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || pointerType.current !== 'mouse') return;
    const scroller = scrollRef.current!;
    if ((e.target as HTMLElement).closest('.card, .subfolder')) return;
    if (e.nativeEvent.offsetX > scroller.clientWidth && e.target === scroller) return; // scrollbar
    const additive = e.metaKey || e.ctrlKey || e.shiftKey;
    const s = useStore.getState();
    const base = additive ? new Set(s.selected) : new Set<string>();
    if (!additive) s.clearSelection();
    const origin = toContent(e.clientX, e.clientY);
    let moved = false;

    const move = (ev: MouseEvent) => {
      const p = toContent(ev.clientX, ev.clientY);
      const rect = {
        x: Math.min(origin.x, p.x),
        y: Math.min(origin.y, p.y),
        w: Math.abs(p.x - origin.x),
        h: Math.abs(p.y - origin.y),
      };
      if (!moved && rect.w + rect.h < 5) return;
      moved = true;
      setBand(rect);
      const hit = new Set(base);
      const { items: list } = useStore.getState();
      boxesRef.current.forEach((b, i) => {
        if (b && intersects(b, rect)) hit.add(list[i].id);
      });
      useStore.getState().setSelection([...hit]);
      // edge auto-scroll
      const sr = scroller.getBoundingClientRect();
      if (ev.clientY > sr.bottom - 40) scroller.scrollTop += 18;
      else if (ev.clientY < sr.top + 40) scroller.scrollTop -= 18;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setBand(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const boxesRef = useRef<Box[]>(boxes);
  boxesRef.current = boxes;

  function toContent(cx: number, cy: number) {
    const r = contentRef.current!.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  }

  const onGridContext = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.card, .subfolder')) return;
    e.preventDefault();
    useStore.getState().set({ contextMenu: { x: e.clientX, y: e.clientY, kind: 'grid' } });
  };

  const fit = layout === 'grid' ? 'contain' : 'cover';

  return (
    <div
      className="grid-scroll"
      ref={scrollRef}
      onScroll={onScroll}
      onMouseDown={onMouseDown}
      onContextMenu={onGridContext}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
    >
      <SubfolderStrip />
      <div className="grid-content" ref={contentRef} style={{ height: Math.max(height, 0) }}>
        {visible.map((i) => (
          <Card
            key={items[i].id}
            item={items[i]}
            box={boxes[i]}
            selected={selected.has(items[i].id)}
            score={scores?.[items[i].id]}
            showInfo={showInfo}
            captionH={captionH}
            fit={fit}
            draggable={fine}
            onClick={onCardClick}
            onDoubleClick={onCardDouble}
            onContextMenu={onCardContext}
            onDragStart={onCardDragStart}
          />
        ))}
        {loadingMore && <div className="load-more" style={{ top: height + 12 }} />}
        {band && (
          <div className="rubber-band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }} />
        )}
      </div>
      {!loading && !items.length && <EmptyState />}
    </div>
  );
}

function intersects(b: Box, r: { x: number; y: number; w: number; h: number }) {
  return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
}

function SubfolderStrip() {
  const view = useStore((s) => s.view);
  const folders = useStore((s) => s.folders);
  const [over, setOver] = useState<string | null>(null);
  if (view.kind !== 'folder') return null;
  const subs = folders.filter((f) => f.parentId === view.id);
  if (!subs.length) return null;
  return (
    <div className="subfolders">
      {subs.map((f) => (
        <div
          key={f.id}
          className={cls('subfolder', over === f.id && 'drop-target')}
          onClick={() => useStore.getState().setView({ kind: 'folder', id: f.id })}
          onContextMenu={(e) => {
            e.preventDefault();
            useStore.getState().set({ contextMenu: { x: e.clientX, y: e.clientY, kind: 'folder', id: f.id } });
          }}
          onDragOver={(e) => {
            if (dragKind(e)) {
              e.preventDefault();
              setOver(f.id);
            }
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            setOver(null);
            dropOnFolder(e, f.id);
          }}
        >
          <div className="subfolder-cover">
            {f.cover ? <img src={f.cover} alt="" draggable={false} /> : <FolderIcon size={26} strokeWidth={1.4} />}
          </div>
          <div className="subfolder-info">
            <FolderIcon size={13} style={{ color: f.color || undefined }} />
            <span className="subfolder-name">{f.name}</span>
            <span className="subfolder-count">{f.count}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const view = useStore((s) => s.view);
  const query = useStore((s) => s.query);
  const filters = useStore((s) => s.filters);
  const set = useStore((s) => s.set);
  const filtered = !!query || filters.types.length > 0 || !!filters.source || !!filters.rating || !!filters.color;

  if (filtered)
    return (
      <div className="empty">
        <SearchX size={40} strokeWidth={1.2} />
        <h2>No matches</h2>
        <p>Try a different search or clear your filters.</p>
      </div>
    );
  if (view.kind === 'trash')
    return (
      <div className="empty">
        <Trash2 size={40} strokeWidth={1.2} />
        <h2>Trash is empty</h2>
        <p>Deleted items stay here until you empty the trash.</p>
      </div>
    );
  return (
    <div className="empty">
      <div className="empty-art">
        <ImagePlus size={30} strokeWidth={1.4} />
        <XLogo size={22} />
      </div>
      <h2>{view.kind === 'folder' ? 'This folder is empty' : 'Your library is empty'}</h2>
      <p>
        Drop images or videos anywhere, paste X post links with <kbd className="kbd">⌘V</kbd>, or drag items here from
        another folder.
      </p>
      <button className="btn primary lg" onClick={() => set({ importOpen: true })}>
        <Upload size={16} /> Import
      </button>
    </div>
  );
}
