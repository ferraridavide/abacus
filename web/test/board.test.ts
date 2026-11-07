import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrangeFolder, normalizeBoard, parkBeside, rememberSpots, snapshotBoard, tidyKeepingSizes } from '../src/lib/board.ts';

const box = (x: number, y: number, w = 100, h = 80) => ({ x, y, w, h });

test('normalizing a board answers the one shape it is stored in', () => {
  const expected = {
    mode: 'free',
    view: { x: 10, y: -25.5, s: 1.5 },
    spots: {
      a: { x: 1_000_000, y: 20, w: 100.2, h: 80 },
      b: { x: 1, y: 2, w: 8, h: 8 },
    },
    zOrder: ['a', 'b'],
  };
  const messy = {
    mode: 'free',
    view: { x: 10.04, y: -25.46, s: 1.50049 },
    spots: {
      b: box(1, 2, 3, 4),
      a: box(2_500_000, 20, 100.24, 80),
      bad: { x: 'nope', y: 0, w: 10, h: 10 },
      'bad id!': box(0, 0),
    },
    zOrder: ['a', 'a', 7, 'b'],
  };
  const board = normalizeBoard(messy);
  assert.deepEqual(board, expected);
  assert.equal(JSON.stringify(board), JSON.stringify(expected), 'the stored JSON is stable');
  // whatever arrives, a board is a board
  assert.deepEqual(normalizeBoard(null), { mode: 'free', view: null, spots: {}, zOrder: [] });
  assert.equal(normalizeBoard({ mode: 'nonsense' }).mode, 'free');
});

test('images added later are parked beside the saved arrangement, never on top of it', () => {
  const saved = { a: box(0, 20) };
  const auto = [box(0, 0), box(0, 94)];
  const boxes = arrangeFolder(['a', 'b'], auto, [box(0, 0)], saved);
  assert.deepEqual(boxes, [box(0, 20), box(164, 20)]);
});

test('a folder with nothing saved opens exactly as its waterfall', () => {
  const auto = [box(0, 0), box(0, 94), box(114, 0)];
  assert.deepEqual(arrangeFolder(['a', 'b', 'c'], auto, auto, {}), auto);
});

test('a folder with everything saved restores every place and size', () => {
  const saved = { a: box(300, 40, 120, 90), b: box(20, 200, 60, 60) };
  assert.deepEqual(arrangeFolder(['a', 'b'], [box(0, 0), box(0, 94)], [], saved), [
    box(300, 40, 120, 90),
    box(20, 200, 60, 60),
  ]);
});

test('parking an empty block changes nothing', () => {
  assert.deepEqual(parkBeside([box(0, 0)], []), []);
  assert.deepEqual(parkBeside([], [box(0, 0)]), [box(0, 0)]);
});

test('spots of images that left the folder are kept for when they come back', () => {
  const current = { a: box(0, 0) };
  const previous = { a: box(500, 500), gone: box(9, 9) };
  const spots = rememberSpots(['a', 'b'], current, previous);
  assert.deepEqual(Object.keys(spots).sort(), ['a', 'gone']);
  assert.deepEqual(spots.a, box(0, 0), 'the live place wins');
});

test('tidy packs a selection into rows and keeps every size', () => {
  const boxes = [box(10, 40, 100, 20), box(80, 90, 100, 30), box(10, 200, 40, 50)];
  const packed = tidyKeepingSizes(boxes, 14);
  assert.deepEqual(packed.map((b) => ({ w: b.w, h: b.h })), [
    { w: 100, h: 20 },
    { w: 100, h: 30 },
    { w: 40, h: 50 },
  ]);
  assert.equal(packed[0].x, 10);
  assert.equal(packed[0].y, 40);
  // 100 + 14 + 100 does not fit the group's 170px span, so the second image wraps under the first
  assert.equal(packed[1].x, 10);
  assert.equal(packed[1].y, 74);
  // the third is narrower, so it sits beside the second instead of starting another row
  assert.equal(packed[2].x, 124);
  assert.equal(packed[2].y, 74);
  assert.deepEqual(tidyKeepingSizes([box(3, 4, 20, 20)]), [box(3, 4, 20, 20)]);
});

test('a snapshot records the arrangement on screen, in free mode the sizes as shown', () => {
  const boxes = [box(0, 0, 140, 100), box(200, 0, 60, 90)];
  const free = snapshotBoard({
    mode: 'free',
    view: { x: 3, y: 4, s: 1 },
    ids: ['a', 'b'],
    boxes,
    free: {},
    previous: { gone: box(9, 9) },
    zOrder: ['b', 'a'],
  });
  assert.deepEqual(free.spots, { a: box(0, 0, 140, 100), b: box(200, 0, 60, 90), gone: box(9, 9) });
  assert.deepEqual(free.zOrder, ['b', 'a']);

  const waterfall = snapshotBoard({
    mode: 'masonry',
    view: { x: 3, y: 4, s: 1 },
    ids: ['a', 'b'],
    boxes,
    free: { a: box(300, 40) },
    previous: {},
    zOrder: [],
  });
  assert.equal(waterfall.mode, 'masonry');
  assert.deepEqual(waterfall.spots, { a: box(300, 40) }, 'the free arrangement survives a look at the waterfall');
});
