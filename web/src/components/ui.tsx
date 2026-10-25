import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

export const cls = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export function XLogo({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-label="X">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo" role="img" aria-label="Abacus" style={{ fontSize: size * 0.95, width: size, height: size }}>
      🧮
    </span>
  );
}

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches
  );
}

/** Phone-sized: dialogs fill the screen and menus open as bottom sheets. Matches the 760px breakpoint in styles.css. */
export const usePhone = () => useMediaQuery('(max-width: 760px)');
/** No room for the side panels: the sidebar is a drawer and the inspector a sheet. Matches the 860px breakpoint. */
export const useCompact = () => useMediaQuery('(max-width: 860px)');

/** A click-to-open floating panel anchored under its trigger; a bottom sheet on phones. */
export function Popover({
  trigger,
  children,
  align = 'left',
  width,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  useEffect(() => {
    if (!open || phone) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      // a dropdown portaled to <body> (the colour picker) belongs to this menu
      if (!ref.current?.contains(target) && !target?.closest('[data-popover-child]')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, phone]);
  return (
    <div className="popover-wrap" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && phone && <Sheet onClose={() => setOpen(false)}>{children(() => setOpen(false))}</Sheet>}
      {open && !phone && (
        <div className={cls('popover', align === 'right' && 'right')} style={{ width }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Modal({
  onClose,
  children,
  className,
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cls('modal', className)}>{children}</div>
    </div>,
    document.body
  );
}

/** A panel that slides up from the bottom of the screen. Tap outside, press Escape or drag it down to close it. */
export function Sheet({ onClose, children, className }: { onClose: () => void; children: ReactNode; className?: string }) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cls('sheet', className)} style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}>
        <div
          className="sheet-handle"
          onPointerDown={(e) => {
            start.current = e.clientY;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => start.current !== null && setDrag(Math.max(0, e.clientY - start.current))}
          onPointerUp={() => {
            start.current = null;
            if (drag > 80) onClose();
            setDrag(0);
          }}
          onPointerCancel={() => {
            start.current = null;
            setDrag(0);
          }}
        />
        {children}
      </div>
    </div>,
    document.body
  );
}

/** Title row of a dialog, with a back button when it shows a page below the first one. */
export function DialogHead({ title, onBack, onClose }: { title: ReactNode; onBack?: () => void; onClose: () => void }) {
  return (
    <div className={cls('modal-head', onBack && 'has-back')}>
      {onBack && (
        <button className="icon-btn" onClick={onBack} title="Back">
          <ChevronLeft size={20} />
        </button>
      )}
      <h2>{title}</h2>
      <button className="icon-btn" onClick={onClose} title="Close (Esc)">
        <X size={18} />
      </button>
    </div>
  );
}

/** A row that opens a page of a dialog: icon, label, description and a chevron. */
export function PageLink({ icon, label, desc, onClick }: { icon: ReactNode; label: string; desc?: ReactNode; onClick: () => void }) {
  return (
    <button className="page-link" onClick={onClick}>
      {icon && <span className="page-link-icon">{icon}</span>}
      <span className="page-link-text">
        <span className="page-link-label">{label}</span>
        {desc && <span className="page-link-desc">{desc}</span>}
      </span>
      <ChevronRight size={16} className="dim" />
    </button>
  );
}

/** Keep a floating element inside the viewport. */
export function useClampedPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y]);
  return { ref, pos };
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
