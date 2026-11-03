import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { startAbacus } from './helpers.js';

let app;

before(async () => {
  app = await startAbacus({ API_TOKEN: '', ABACUS_API_TOKEN: '' });
});
after(async () => {
  await app?.stop();
});

const get = () => app.call('GET', '/api/settings/appearance', undefined, { as: 'basic' });
const patch = (body) => app.call('PATCH', '/api/settings/appearance', body, { as: 'basic' });

describe('appearance', () => {
  test('starts as the original look: dark Classic, rounded, no OLED, blue accent', async () => {
    const { status, data, headers } = await get();
    assert.equal(status, 200);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.equal(data.scheme, 'dark');
    assert.equal(data.theme, 'classic');
    assert.equal(data.corners, 'rounded');
    assert.equal(data.oled, false);
    assert.equal(data.accent.id, 'blue');
    assert.equal(data.accent.hex, '#5b8cff');
    // Classic dark is the original palette, value for value
    assert.equal(data.palettes.dark.bg, '#121316');
    assert.equal(data.palettes.dark.text, '#ececef');
    assert.ok(data.presets.length >= 4);
    assert.ok(data.presets.every((p) => p.id && p.label && /^#[0-9a-f]{6}$/i.test(p.hex)));
    assert.deepEqual(data.themes.map((t) => t.id), ['classic', 'graphite', 'slate', 'sepia']);
  });

  test('stores only the choices made, so the rest keeps following the default', async () => {
    await patch({ corners: 'squared' });
    const db = new DatabaseSync(path.join(app.dataDir, 'library.db'), { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'appearance'").get();
      assert.deepEqual(JSON.parse(row.value), { corners: 'squared' });
    } finally {
      db.close();
    }
  });

  test('resolves ink that stays readable on the accent', async () => {
    const { data } = await patch({ accent: 'blue' });
    assert.equal(data.accent.hex, '#5b8cff');
    // white on the blue, as the app always had it, and the violet second stop of its gradients
    assert.equal(data.accent.ink, '#ffffff');
    assert.equal(data.accent.soft, 'rgba(91, 140, 255, 0.16)');
    assert.equal(data.accent.hex2, '#8a5bff');
    // and as ink on light surfaces it darkens, while dark surfaces keep the raw hue
    assert.equal(data.accent.text.dark, '#5b8cff');
    assert.notEqual(data.accent.text.light, '#5b8cff');

    const { data: gray } = await patch({ accent: '#f2efe6' });
    assert.equal(gray.accent.id, 'custom');
    assert.equal(gray.accent.ink, '#14120d');

    const { data: night } = await patch({ accent: '#101014' });
    assert.equal(night.accent.ink, '#ffffff');

    // a light accent drops under 3:1 with white, so it takes the dark ink
    const { data: amber } = await patch({ accent: 'amber' });
    assert.equal(amber.accent.ink, '#14120d');
  });

  test('switches corners and keeps the accent across a reload-sized read', async () => {
    await patch({ corners: 'rounded', accent: 'violet' });
    const { data } = await get();
    assert.equal(data.corners, 'rounded');
    assert.equal(data.accent.id, 'violet');
    assert.equal(data.accent.hex, '#a78bfa');
  });

  test('resolves one palette per scheme from the theme', async () => {
    for (const theme of ['graphite', 'slate', 'sepia']) {
      const { data } = await patch({ theme });
      for (const scheme of ['light', 'dark', 'oled']) {
        const palette = data.palettes[scheme];
        assert.match(palette.bg, /^hsl\(/, `${theme}/${scheme}`);
        assert.ok(palette.text && palette.panel && palette.border && palette.overlay && palette.shade, `${theme}/${scheme}`);
      }
    }
    const { data } = await patch({ theme: 'graphite' });
    // OLED is the dark ladder with the surfaces dropped to black, not a filter over the dark palette
    assert.equal(data.palettes.oled.bg, 'hsl(40 6% 0%)');
    assert.notEqual(data.palettes.oled.panel, data.palettes.dark.panel);
    // light flips the text ramp and softens the drop shadows
    assert.equal(data.palettes.light.text, 'hsl(40 6% 12%)');
    assert.equal(data.palettes.light.shade, '0.35');
    assert.equal(data.palettes.dark.shade, '1');
  });

  test('stores scheme, theme and OLED', async () => {
    const { data } = await patch({ scheme: 'light', theme: 'sepia', oled: true });
    assert.equal(data.scheme, 'light');
    assert.equal(data.theme, 'sepia');
    assert.equal(data.oled, true);
    assert.equal((await get()).data.scheme, 'light');

    await patch({ scheme: 'dark', theme: 'classic', oled: false });
    const { data: reset } = await get();
    assert.equal(reset.scheme, 'dark');
    assert.equal(reset.oled, false);
  });

  test('ignores values it cannot use instead of storing them', async () => {
    await patch({ corners: 'squared', accent: 'amber' });
    const { data } = await patch({ corners: 'squiggly', accent: 'chartreuse', scheme: 'sepia', theme: 'nope' });
    assert.equal(data.corners, 'squared');
    assert.equal(data.accent.id, 'amber');
    assert.equal(data.scheme, 'dark');
    assert.equal(data.theme, 'classic');
    // and an invalid hex does not overwrite a good one either
    const { data: after } = await patch({ accent: '#12345' });
    assert.equal(after.accent.hex, '#e8a33d');
  });

  test('an extension API key can read the theme but not change it', async () => {
    const created = await app.call('POST', '/api/settings/api-keys', { name: 'Chrome extension' }, { as: 'basic' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const key = { as: 'none', headers: { authorization: `Bearer ${created.data.token}` } };

    const read = await app.call('GET', '/api/settings/appearance', undefined, key);
    assert.equal(read.status, 200);
    assert.ok(read.data.accent && typeof read.data.accent.hex === 'string');
    assert.ok(read.data.palettes.dark.bg);

    const write = await app.call('PATCH', '/api/settings/appearance', { corners: 'rounded' }, key);
    assert.equal(write.status, 403);
  });
});
