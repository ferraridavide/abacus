import { memo, useEffect, useRef, useState } from 'react';
import { Check, FileIcon, Globe, Link2, Play, Star } from 'lucide-react';
import type { Item } from '../types';
import type { Box } from '../lib/layout';
import { formatDate, formatDuration, hostOf, itemMeta } from '../lib/format';
import { cls, XLogo } from './ui';
import { useStore } from '../store';

interface Props {
  item: Item;
  box: Box;
  selected: boolean;
  showInfo: boolean;
  captionH: number;
  fit: 'cover' | 'contain';
  onClick: (e: React.MouseEvent, item: Item) => void;
  onDoubleClick: (item: Item) => void;
  onContextMenu: (e: React.MouseEvent, item: Item) => void;
  onDragStart: (e: React.DragEvent, item: Item) => void;
}

export const Card = memo(function Card({
  item,
  box,
  selected,
  showInfo,
  captionH,
  fit,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
}: Props) {
  const [hover, setHover] = useState(false);
  const [preview, setPreview] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const thumbH = box.h - captionH;
  const isMotion = item.type === 'video' || item.type === 'gif';
  const autoplay = useStore((s) => s.autoplay);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, autoplay === 'always' && isMotion);

  useEffect(() => {
    clearTimeout(timer.current);
    const canPlay = isMotion && !!item.fileUrl;
    if (canPlay && autoplay === 'always') setPreview(inView);
    else if (canPlay && autoplay === 'hover' && hover) timer.current = setTimeout(() => setPreview(true), 280);
    else setPreview(false);
    return () => clearTimeout(timer.current);
  }, [hover, inView, autoplay, isMotion, item.fileUrl]);

  const bg = item.palette[0]?.hex;

  return (
    <div
      ref={ref}
      className={cls('card', selected && 'selected', `t-${item.type}`)}
      style={{ transform: `translate3d(${box.x}px, ${box.y}px, 0)`, width: box.w, height: box.h }}
      data-id={item.id}
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      onClick={(e) => onClick(e, item)}
      onDoubleClick={() => onDoubleClick(item)}
      onContextMenu={(e) => onContextMenu(e, item)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="thumb" style={{ height: thumbH, background: item.type === 'bookmark' ? undefined : bg }}>
        {item.type === 'bookmark' && !item.thumbUrl ? (
          <BookmarkFace item={item} />
        ) : item.thumbUrl ? (
          <img
            src={item.thumbUrl}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            className={cls(loaded && 'loaded')}
            style={{ objectFit: fit }}
            onLoad={() => setLoaded(true)}
          />
        ) : item.type === 'video' && item.fileUrl ? (
          <video src={item.fileUrl + '#t=0.5'} preload="metadata" muted playsInline className="loaded" style={{ objectFit: fit }} />
        ) : (
          <div className="file-face">
            <FileIcon size={34} strokeWidth={1.4} />
            <span>{(item.ext || 'file').toUpperCase()}</span>
          </div>
        )}

        {preview &&
          item.fileUrl &&
          (item.ext === 'gif' ? (
            <img src={item.fileUrl} alt="" draggable={false} className="loaded preview" style={{ objectFit: fit }} />
          ) : (
            <video
              src={item.fileUrl}
              autoPlay
              muted
              loop
              playsInline
              className="loaded preview"
              style={{ objectFit: fit }}
            />
          ))}

        <div className="badges">
          {item.type === 'video' && (
            <span className="badge">
              <Play size={9} fill="currentColor" /> {formatDuration(item.duration) || 'Video'}
            </span>
          )}
          {item.type === 'gif' && <span className="badge">GIF</span>}
        </div>
        {item.source === 'x' && item.type !== 'bookmark' && (
          <span className="source-badge" title={'@' + item.authorHandle}>
            <XLogo size={10} />
          </span>
        )}
        {item.rating > 0 && (
          <span className="rating-badge">
            <Star size={10} fill="currentColor" /> {item.rating}
          </span>
        )}
        <span className="check">
          <Check size={12} strokeWidth={3} />
        </span>
      </div>
      {showInfo && (
        <div className="caption" style={{ height: captionH }}>
          <div className="caption-name" title={item.name}>
            {item.name}
          </div>
          <div className="caption-meta">{itemMeta(item)}</div>
        </div>
      )}
    </div>
  );
});

export function BookmarkFace({ item, large }: { item: Item; large?: boolean }) {
  if (item.source === 'x') {
    return (
      <div className={cls('bookmark-face tweet', large && 'large')}>
        <div className="bm-head">
          <Avatar src={item.authorAvatar} name={item.author || item.authorHandle || '?'} />
          <div className="bm-who">
            <div className="bm-name">{item.author}</div>
            <div className="bm-handle">@{item.authorHandle}</div>
          </div>
          <XLogo size={large ? 18 : 13} />
        </div>
        <div className="bm-text">{item.text || item.name}</div>
        <div className="bm-foot">{formatDate(item.postedAt, false)}</div>
      </div>
    );
  }
  return (
    <div className={cls('bookmark-face web', large && 'large')}>
      <div className="bm-site">
        <Globe size={13} /> {item.author || hostOf(item.url)}
      </div>
      <div className="bm-title">{item.name}</div>
      {item.text && <div className="bm-text dim">{item.text}</div>}
      <div className="bm-foot">
        <Link2 size={12} /> {hostOf(item.url)}
      </div>
    </div>
  );
}

export function Avatar({ src, name, size = 30 }: { src: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed)
    return (
      <span className="avatar fallback" style={{ width: size, height: size }}>
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  return (
    <img
      className="avatar"
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** True while the element is on screen (only observed when `enabled`, so hover mode costs nothing). */
function useInView(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return setInView(false);
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, enabled]);
  return inView;
}
