import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import type { Item } from '../types';

/**
 * An item's thumbnail. With JPEG XL thumbnails turned on, browsers that decode JPEG XL pick the progressive one, which
 * shows a coarse version as soon as its first bytes arrive; the others keep the webp one.
 */
export function Thumb({ item, ...img }: { item: Item } & ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <picture>
      {item.thumbJxlUrl && <source srcSet={item.thumbJxlUrl} type="image/jxl" />}
      <img src={item.thumbUrl ?? undefined} alt="" draggable={false} {...img} />
    </picture>
  );
}

/**
 * True when the browser shows this item's progressive JPEG XL thumbnail. That one is drawn pass by pass while it
 * downloads, so it shouldn't be hidden (faded in on load, blurred) until it's complete; the webp one can be.
 */
export function useProgressiveThumb(item: Item) {
  return useJxlSupport() === true && !!item.thumbJxlUrl;
}

// Formats a browser can show as an <img> (not HEIC, TIFF, PSD…). GIFs are left alone: they animate on their own terms.
const WEB_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'svg', 'jxl']);
// how far a thumbnail may be stretched before the original is worth fetching
const STRETCH = 1.15;

/**
 * True when a grid tile shows its thumbnail bigger than its pixels (a large thumbnail size, a high-density screen)
 * and the original has more of them. Only while JPEG XL thumbnails are on: that setting stands for
 * "thumbnail first, then the original".
 */
export function needsOriginal(
  item: Item,
  natural: { w: number; h: number },
  tile: { w: number; h: number },
  fit: 'cover' | 'contain'
) {
  return !!item.thumbJxlUrl && originalSharper(item, natural, tile, fit);
}

/** True when `tile` (in screen pixels) shows the thumbnail stretched and the original has more pixels to show. */
export function originalSharper(
  item: Item,
  natural: { w: number; h: number },
  tile: { w: number; h: number },
  fit: 'cover' | 'contain'
) {
  if (item.type !== 'image' || !item.fileUrl || !WEB_IMAGE_EXTS.has(item.ext ?? '')) return false;
  if (!item.width || item.width <= natural.w * STRETCH) return false;
  const scale = (fit === 'cover' ? Math.max : Math.min)(tile.w / natural.w, tile.h / natural.h);
  return scale * (window.devicePixelRatio || 1) > STRETCH;
}

/** `value`, once it has stayed true for `ms`; it stays true afterwards. Keeps fast scrolling from fetching originals. */
export function useSettled(value: boolean, ms: number) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!value || settled) return;
    const timer = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}

// A 1×1 lossless JPEG XL image
const JXL_PROBE = 'data:image/jxl;base64,/woAELASCAgQADAASxiLFcJJQR5ApH9/';
let jxlProbe: Promise<boolean> | null = null;
let jxlDecodes: boolean | null = null;

/** Whether this browser decodes JPEG XL; null until it's known. */
export function useJxlSupport() {
  const [ok, setOk] = useState(jxlDecodes);
  useEffect(() => {
    if (ok !== null) return;
    jxlProbe ??= new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth === 1);
      img.onerror = () => resolve(false);
      img.src = JXL_PROBE;
    }).then((result) => (jxlDecodes = result));
    let alive = true;
    void jxlProbe.then((result) => alive && setOk(result));
    return () => {
      alive = false;
    };
  }, [ok]);
  return ok;
}
