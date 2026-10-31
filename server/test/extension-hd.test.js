import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import '../../extensions/chrome/hd.js';

const hd = globalThis.__abacusHd;
const base = 'https://example.com/gallery/';

describe('high-resolution image candidates', () => {
  test('srcset: the widest entry wins, URLs with commas survive', () => {
    const srcset = 'a-300.jpg 300w, /img/a,b-1200.jpg 1200w, a-600.jpg 600w';
    assert.equal(hd.largestSource(srcset, base), 'https://example.com/img/a,b-1200.jpg');
    assert.equal(hd.largestSource('a.jpg 1x, b.jpg 2x', base), 'https://example.com/gallery/b.jpg');
    assert.equal(hd.largestSource('', base), '');
  });

  test('explicit full-size attributes and image links come before the displayed file', () => {
    const list = hd.candidates({
      src: '/t/small.jpg',
      attrs: { 'data-orig-file': '/o/original.jpg' },
      link: '/o/linked.png',
      srcset: '/t/small.jpg 300w, /t/medium.jpg 900w',
      base,
    });
    assert.deepEqual(list, [
      'https://example.com/o/original.jpg',
      'https://example.com/o/linked.png',
      'https://example.com/t/medium.jpg',
      'https://example.com/t/small.jpg',
    ]);
  });

  test('a link to a web page is not mistaken for the image', () => {
    const list = hd.candidates({ src: '/t/small.jpg', link: '/post/42', base });
    assert.deepEqual(list, ['https://example.com/t/small.jpg']);
  });

  test('known CDNs are rewritten to the original, keeping the shown URL as the fallback', () => {
    assert.deepEqual(hd.candidates({ src: 'https://pbs.twimg.com/media/AbC?format=jpg&name=small' }), [
      'https://pbs.twimg.com/media/AbC?format=jpg&name=orig',
      'https://pbs.twimg.com/media/AbC?format=jpg&name=small',
    ]);
    assert.equal(hd.upgradeUrl('https://i.pinimg.com/236x/ab/cd/ef.jpg')[0], 'https://i.pinimg.com/originals/ab/cd/ef.jpg');
    assert.equal(
      hd.upgradeUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cat.jpg/300px-Cat.jpg')[0],
      'https://upload.wikimedia.org/wikipedia/commons/a/ab/Cat.jpg'
    );
    assert.equal(hd.upgradeUrl('https://lh3.googleusercontent.com/abc=w800-h600-no')[0], 'https://lh3.googleusercontent.com/abc=s0');
    assert.equal(hd.upgradeUrl('https://i.imgur.com/AbCdEfGm.jpg')[0], 'https://i.imgur.com/AbCdEfG.jpg');
    assert.equal(hd.upgradeUrl('https://site.com/wp-content/uploads/photo-300x200.jpg')[0], 'https://site.com/wp-content/uploads/photo.jpg');
    assert.equal(
      hd.upgradeUrl('https://res.cloudinary.com/demo/image/upload/w_300,c_fill/v123/sample.jpg')[0],
      'https://res.cloudinary.com/demo/image/upload/v123/sample.jpg'
    );
    assert.deepEqual(hd.upgradeUrl('https://example.com/plain.jpg'), []);
  });

  test('turning high resolution off keeps only the displayed image', () => {
    const list = hd.candidates({ src: 'https://pbs.twimg.com/media/AbC?name=small', link: '/big.jpg', base }, { hd: false });
    assert.deepEqual(list, ['https://pbs.twimg.com/media/AbC?name=small']);
  });

  test('non-http sources never become candidates', () => {
    assert.deepEqual(hd.candidates({ src: 'data:image/png;base64,AAAA', attrs: { 'data-src': 'javascript:alert(1)' }, base }), []);
  });
});
