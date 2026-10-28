import type { Folder, Item } from '../../types';
import type { NewItem } from './index';
import { toBlob } from './media';

// The sample library a first visit to the demo starts with: abstract pictures drawn on a canvas (nothing is
// downloaded), a few folders and tags, and two saved links.

type Ctx = CanvasRenderingContext2D;
type Rand = () => number;

interface Artwork {
  name: string;
  w: number;
  h: number;
  draw: (ctx: Ctx, w: number, h: number, rand: Rand) => void;
  tags: string[];
  folder: 'warm' | 'cool' | 'geometry' | null;
  rating?: number;
  notes?: string;
}

/** A small seeded PRNG, so the sample looks the same every time. */
function mulberry32(seed: number): Rand {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function linear(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, stops: string[]) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

function circle(ctx: Ctx, x: number, y: number, r: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Layered ridges, from the back to the front. */
function ridges(ctx: Ctx, w: number, h: number, rand: Rand, colors: string[], top = 0.35) {
  colors.forEach((color, i) => {
    const base = h * (top + (i / colors.length) * (1 - top));
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += w / 40) {
      const y = base - Math.sin(x / (w / (2 + i)) + i * 1.7) * h * 0.05 - rand() * h * 0.02;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  });
}

const ARTWORKS: Artwork[] = [
  {
    name: 'Dusk over the bay',
    w: 1200,
    h: 1600,
    folder: 'warm',
    tags: ['gradient', 'warm', 'landscape'],
    rating: 5,
    notes: 'Try searching by color: the orange in the sun is #ff9f43.',
    draw: (ctx, w, h, rand) => {
      ctx.fillStyle = linear(ctx, 0, 0, 0, h, ['#2d1b4e', '#6a3093', '#ff7e5f', '#feb47b']);
      ctx.fillRect(0, 0, w, h);
      circle(ctx, w * 0.5, h * 0.62, w * 0.2, '#ff9f43');
      ridges(ctx, w, h, rand, ['#3b2257', '#2a173f', '#1a0f29'], 0.66);
    },
  },
  {
    name: 'Ocean bands',
    w: 1600,
    h: 1000,
    folder: 'cool',
    tags: ['cool', 'waves'],
    rating: 4,
    draw: (ctx, w, h) => {
      const colors = ['#e0f7fa', '#80deea', '#26c6da', '#0097a7', '#006064', '#00363a'];
      colors.forEach((c, i) => {
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x <= w; x += 10) ctx.lineTo(x, (h / colors.length) * i + Math.sin(x / 120 + i) * 28);
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = c;
        ctx.fill();
      });
    },
  },
  {
    name: 'Bauhaus tiles',
    w: 1200,
    h: 1200,
    folder: 'geometry',
    tags: ['geometric', 'bauhaus'],
    rating: 5,
    draw: (ctx, w, h, rand) => {
      const colors = ['#e63946', '#f4a261', '#2a9d8f', '#264653', '#f1faee'];
      const n = 4;
      const s = w / n;
      ctx.fillStyle = '#f1e9da';
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const pick = () => colors[Math.floor(rand() * colors.length)];
          ctx.fillStyle = pick();
          ctx.fillRect(x * s, y * s, s, s);
          const corner = Math.floor(rand() * 4);
          const cx = x * s + (corner % 2) * s;
          const cy = y * s + Math.floor(corner / 2) * s;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x * s, y * s, s, s);
          ctx.clip();
          circle(ctx, cx, cy, s, pick());
          ctx.restore();
        }
      }
    },
  },
  {
    name: 'Mint bubbles',
    w: 1000,
    h: 1400,
    folder: 'cool',
    tags: ['cool', 'circles'],
    draw: (ctx, w, h, rand) => {
      ctx.fillStyle = '#0b3d2e';
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 0.55;
      for (let i = 0; i < 26; i++) {
        const colors = ['#1dd1a1', '#10ac84', '#c7f9cc', '#57cc99'];
        circle(ctx, rand() * w, rand() * h, 60 + rand() * 220, colors[i % colors.length]);
      }
      ctx.globalAlpha = 1;
    },
  },
  {
    name: 'Sunset stripes',
    w: 1600,
    h: 900,
    folder: 'warm',
    tags: ['warm', 'stripes'],
    rating: 3,
    draw: (ctx, w, h) => {
      const colors = ['#ff6b6b', '#ff9f43', '#feca57', '#ff6bcb', '#c44569'];
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(-Math.PI / 6);
      const band = 90;
      for (let i = -20; i < 20; i++) {
        ctx.fillStyle = colors[(i + 20) % colors.length];
        ctx.fillRect(-w * 1.5, i * band, w * 3, band);
      }
      ctx.restore();
    },
  },
  {
    name: 'Night sky',
    w: 1400,
    h: 1000,
    folder: 'cool',
    tags: ['night', 'cool', 'landscape'],
    rating: 4,
    draw: (ctx, w, h, rand) => {
      ctx.fillStyle = linear(ctx, 0, 0, 0, h, ['#020024', '#090979', '#1e3c72']);
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 260; i++) circle(ctx, rand() * w, rand() * h * 0.7, rand() * 2.2, '#ffffff');
      circle(ctx, w * 0.78, h * 0.22, 70, '#fdf6e3');
      circle(ctx, w * 0.8, h * 0.2, 62, '#0f1d5a');
      ridges(ctx, w, h, rand, ['#16224d', '#0d1533', '#060a1c'], 0.6);
    },
  },
  {
    name: 'Terracotta arches',
    w: 1000,
    h: 1300,
    folder: 'geometry',
    tags: ['warm', 'geometric', 'architecture'],
    draw: (ctx, w, h) => {
      ctx.fillStyle = '#f2d0a4';
      ctx.fillRect(0, 0, w, h);
      const colors = ['#c8553d', '#e07a5f', '#f28f3b', '#81b29a'];
      const aw = w / 3;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 4; j++) {
          const x = i * aw + aw * 0.12;
          const y = h * 0.1 + j * aw * 1.2;
          const width = aw * 0.76 - j * aw * 0.12;
          ctx.fillStyle = colors[(i + j) % colors.length];
          ctx.beginPath();
          ctx.moveTo(x + (aw * 0.76 - width) / 2, y + aw);
          ctx.arc(x + aw * 0.38, y + width / 2, width / 2, Math.PI, 0);
          ctx.lineTo(x + (aw * 0.76 + width) / 2, y + aw);
          ctx.fill();
        }
      }
    },
  },
  {
    name: 'Lavender fog',
    w: 1200,
    h: 900,
    folder: null,
    tags: ['gradient', 'soft'],
    rating: 2,
    draw: (ctx, w, h) => {
      ctx.fillStyle = '#e9e4f0';
      ctx.fillRect(0, 0, w, h);
      const spots: [number, number, string][] = [
        [0.2, 0.3, '#a55eea'],
        [0.75, 0.25, '#d6a4ff'],
        [0.55, 0.8, '#7f5af0'],
      ];
      for (const [x, y, c] of spots) {
        const g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, w * 0.5);
        g.addColorStop(0, c);
        g.addColorStop(1, 'rgba(233,228,240,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    },
  },
  {
    name: 'Citrus slices',
    w: 1100,
    h: 1100,
    folder: 'warm',
    tags: ['warm', 'circles', 'food'],
    rating: 4,
    draw: (ctx, w, h, rand) => {
      ctx.fillStyle = '#fff4d6';
      ctx.fillRect(0, 0, w, h);
      const fruit = [
        ['#feca57', '#fff3b0'],
        ['#ff9f43', '#ffd8a8'],
        ['#7bc950', '#d8f3c4'],
      ];
      for (let i = 0; i < 9; i++) {
        const [peel, flesh] = fruit[i % fruit.length];
        const x = ((i % 3) + 0.5) * (w / 3) + (rand() - 0.5) * 40;
        const y = (Math.floor(i / 3) + 0.5) * (h / 3) + (rand() - 0.5) * 40;
        const r = w / 7;
        circle(ctx, x, y, r, peel);
        circle(ctx, x, y, r * 0.86, flesh);
        ctx.strokeStyle = peel;
        ctx.lineWidth = 5;
        for (let k = 0; k < 8; k++) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos((k * Math.PI) / 4) * r * 0.86, y + Math.sin((k * Math.PI) / 4) * r * 0.86);
          ctx.stroke();
        }
      }
    },
  },
  {
    name: 'Forest layers',
    w: 1600,
    h: 1000,
    folder: 'cool',
    tags: ['landscape', 'green'],
    rating: 5,
    draw: (ctx, w, h, rand) => {
      ctx.fillStyle = linear(ctx, 0, 0, 0, h, ['#d8f3dc', '#b7e4c7']);
      ctx.fillRect(0, 0, w, h);
      ridges(ctx, w, h, rand, ['#95d5b2', '#74c69d', '#52b788', '#40916c', '#2d6a4f', '#1b4332'], 0.3);
    },
  },
  {
    name: 'Monochrome rings',
    w: 1000,
    h: 1000,
    folder: 'geometry',
    tags: ['geometric', 'mono'],
    draw: (ctx, w, h) => {
      for (let r = 20, i = 0; r > 0; r--, i++) circle(ctx, w / 2, h / 2, (r / 20) * w * 0.72, i % 2 ? '#f5f5f5' : '#111111');
    },
  },
  {
    name: 'Coral reef',
    w: 900,
    h: 1400,
    folder: null,
    tags: ['circles', 'ocean'],
    rating: 3,
    draw: (ctx, w, h, rand) => {
      ctx.fillStyle = linear(ctx, 0, 0, 0, h, ['#48dbfb', '#0a3d62']);
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 0.85;
      for (let i = 0; i < 40; i++) {
        const colors = ['#ff6b6b', '#ff9f80', '#ffc4a3', '#ff6bcb'];
        circle(ctx, rand() * w, h * 0.55 + rand() * h * 0.45, 20 + rand() * 80, colors[i % colors.length]);
      }
      ctx.globalAlpha = 1;
    },
  },
];

const LINKS: NewItem[] = [
  {
    name: 'A perceptual color space for image processing',
    type: 'bookmark',
    source: 'web',
    url: 'https://bottosson.github.io/posts/oklab/',
    description: 'The OKLab colour space, which color search uses to compare colours the way people see them.',
    tags: ['color', 'reading'],
  },
  {
    name: 'Bauhaus',
    type: 'bookmark',
    source: 'web',
    url: 'https://en.wikipedia.org/wiki/Bauhaus',
    description: 'The German art school, operational from 1919 to 1933, that combined crafts and the fine arts.',
    tags: ['reading', 'bauhaus'],
  },
];

export async function seedLibrary({
  addItem,
  createFolder,
}: {
  addItem: (input: NewItem) => Promise<Item>;
  createFolder: (body: { name: string; parentId?: string | null; color?: string | null }) => Promise<Folder>;
}) {
  const inspiration = await createFolder({ name: 'Inspiration', color: '#5b8cff' });
  const folders = {
    warm: await createFolder({ name: 'Warm', parentId: inspiration.id, color: '#ff9f43' }),
    cool: await createFolder({ name: 'Cool', parentId: inspiration.id, color: '#48dbfb' }),
    geometry: await createFolder({ name: 'Geometry', color: '#a55eea' }),
  };
  const reading = await createFolder({ name: 'Reading list', color: '#1dd1a1' });

  // spread over the past weeks, oldest first, so sorting by date means something
  const day = 24 * 60 * 60 * 1000;
  const start = Date.now() - (ARTWORKS.length + LINKS.length) * 2 * day;
  let n = 0;

  for (const [i, art] of ARTWORKS.entries()) {
    const canvas = document.createElement('canvas');
    canvas.width = art.w;
    canvas.height = art.h;
    art.draw(canvas.getContext('2d')!, art.w, art.h, mulberry32(i + 1));
    const file = await toBlob(canvas, 'image/webp', 0.9);
    const ext = file.type === 'image/webp' ? 'webp' : 'png';
    await addItem({
      name: art.name,
      ext,
      mime: file.type,
      file,
      tags: art.tags,
      folderIds: art.folder ? [folders[art.folder].id] : [],
      rating: art.rating,
      notes: art.notes,
      createdAt: start + n++ * 2 * day,
    });
  }
  for (const link of LINKS) {
    await addItem({ ...link, folderIds: [reading.id], createdAt: start + n++ * 2 * day });
  }
}
