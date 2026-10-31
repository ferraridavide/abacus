import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clampRegion, fitScale, fitsViewport, planTiles } from '../../extensions/chrome/screenshot.js';

const view = { innerWidth: 1000, innerHeight: 800, scrollWidth: 1000, scrollHeight: 2500 };

describe('screenshot geometry', () => {
  test('a tall page is covered by strips, the last one clamped to the page end', () => {
    const tiles = planTiles({ x: 0, y: 0, w: 1000, h: 2500 }, view);
    assert.deepEqual(tiles, [{ x: 0, y: 0 }, { x: 0, y: 800 }, { x: 0, y: 1600 }, { x: 0, y: 1700 }]);
  });

  test('a wide and tall region is tiled row by row', () => {
    const tiles = planTiles({ x: 0, y: 0, w: 1800, h: 900 }, { ...view, scrollWidth: 1800, scrollHeight: 900 });
    assert.deepEqual(tiles, [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 0, y: 100 }, { x: 800, y: 100 }]);
  });

  test('a region inside the viewport needs one capture', () => {
    const scrolled = { ...view, scrollX: 0, scrollY: 400 };
    assert.equal(fitsViewport({ x: 10, y: 450, w: 300, h: 200 }, scrolled), true);
    assert.equal(fitsViewport({ x: 10, y: 900, w: 300, h: 600 }, scrolled), false);
    assert.equal(planTiles({ x: 10, y: 450, w: 300, h: 200 }, view).length, 1);
  });

  test('regions are clamped to the page and empty ones rejected', () => {
    assert.deepEqual(clampRegion({ x: -5, y: 10.4, w: 100, h: 50 }, view), { x: 0, y: 10, w: 95, h: 51 });
    assert.deepEqual(clampRegion({ x: 900, y: 2400, w: 500, h: 500 }, view), { x: 900, y: 2400, w: 100, h: 100 });
    assert.equal(clampRegion({ x: 2000, y: 0, w: 10, h: 10 }, view), null);
  });

  test('huge pages are scaled down instead of exceeding canvas limits', () => {
    assert.equal(fitScale(1000, 800, 2), 2);
    const scale = fitScale(1200, 60000, 2);
    assert.ok(scale < 0.3 && scale > 0.2);
    assert.ok(1200 * scale * 60000 * scale <= 120_000_000);
  });
});
