import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampPan, clampScale, fittedBox, formatZoom, pixelRatio, zoomAtPoint } from '../src/lib/imageZoom.ts';

test('fit preserves aspect ratio and never enlarges small originals', () => {
  assert.deepEqual(fittedBox({ w: 1000, h: 600 }, { w: 2000, h: 1000 }), { w: 1000, h: 500 });
  assert.deepEqual(fittedBox({ w: 1000, h: 600 }, { w: 1000, h: 2000 }), { w: 300, h: 600 });
  assert.deepEqual(fittedBox({ w: 1000, h: 600 }, { w: 200, h: 100 }), { w: 200, h: 100 });
  assert.equal(fittedBox({ w: 0, h: 600 }, { w: 200, h: 100 }), null);
});

test('zoom keeps the same image point under an off-center cursor after panning', () => {
  const previous = { scale: 2, x: 80, y: -50 };
  const cursor = { x: -170, y: 130 };
  const next = zoomAtPoint(previous, cursor, 3.5);
  assert.equal((cursor.x - previous.x) / previous.scale, (cursor.x - next.x) / next.scale);
  assert.equal((cursor.y - previous.y) / previous.scale, (cursor.y - next.y) / next.scale);
});

test('zooming in and out around the same point restores the transform', () => {
  const previous = { scale: 1, x: 40, y: 20 };
  const point = { x: 100, y: 80 };
  assert.deepEqual(zoomAtPoint(zoomAtPoint(previous, point, 4), point, 1), previous);
});

test('scale limits allow actual size for very large originals and bound wheel extremes', () => {
  assert.equal(clampScale(0, 100), 0.05);
  assert.equal(clampScale(Infinity, 100), 800);
  assert.equal(clampScale(100, 100), 100);
  assert.equal(clampScale(1000, 1), 16);
});

test('panning a large image stops at its edges', () => {
  const bounds = { w: 1000, h: 600 };
  assert.deepEqual(clampPan({ x: 5000, y: -5000 }, 2, { w: 1000, h: 500 }, bounds), { x: 500, y: -200 });
});

test('images that fit remain centered, including when zoomed out', () => {
  const box = { w: 100, h: 100 };
  const bounds = { w: 1000, h: 600 };
  assert.deepEqual(clampPan({ x: 5000, y: -5000 }, 0.05, box, bounds), { x: 0, y: 0 });
  assert.deepEqual(clampPan({ x: 100, y: 100 }, 1, bounds, bounds), { x: 0, y: 0 });
});

test('panning is allowed only on axes where the image exceeds the viewport', () => {
  const bounds = { w: 1000, h: 600 };
  assert.deepEqual(clampPan({ x: 100, y: 100 }, 1, { w: 400, h: 1000 }, bounds), { x: 0, y: 100 });
  assert.deepEqual(clampPan({ x: 100, y: 100 }, 1, { w: 1400, h: 300 }, bounds), { x: 100, y: 0 });
});

test('zoom labels show actual pixel magnification, including small percentages', () => {
  const natural = { w: 2000, h: 1000 };
  const box = fittedBox({ w: 1000, h: 600 }, natural)!;
  assert.equal(formatZoom(pixelRatio(1, box, natural)), '50%');
  assert.equal(formatZoom(pixelRatio(2, box, natural)), '100%');
  assert.equal(formatZoom(pixelRatio(0.05, box, natural)), '2.5%');
});
