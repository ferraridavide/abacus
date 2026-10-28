import type { PaletteColor } from '../../types';
import { histogram, palette } from './color';

// What the server does with sharp, done with a canvas: size, a WebP thumbnail, the palette and the colour histogram.

const THUMB_WIDTH = 720;

export interface ImageInfo {
  width: number;
  height: number;
  thumb: Blob;
  palette: PaletteColor[];
  hist: number[];
}

/** Null when the browser can't decode the blob as an image. */
export async function analyzeImage(blob: Blob): Promise<ImageInfo | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return null;

    const scale = Math.min(1, THUMB_WIDTH / width);
    const thumb = await toBlob(draw(img, Math.round(width * scale), Math.round(height * scale)));
    const small = draw(img, ...fit(width, height, 56)).getContext('2d')!;
    const medium = draw(img, ...fit(width, height, 128)).getContext('2d')!;
    return {
      width,
      height,
      thumb,
      palette: palette(small.getImageData(0, 0, small.canvas.width, small.canvas.height).data),
      hist: histogram(medium.getImageData(0, 0, medium.canvas.width, medium.canvas.height).data),
    };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fit(w: number, h: number, box: number): [number, number] {
  const s = Math.min(1, box / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function draw(img: CanvasImageSource, w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** WebP where the browser can encode it (Safari falls back to PNG). */
export function toBlob(canvas: HTMLCanvasElement, type = 'image/webp', quality = 0.82) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), type, quality)
  );
}
