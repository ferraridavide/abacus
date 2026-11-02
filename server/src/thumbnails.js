import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { paths } from './config.js';
import { makeJxl, THUMB_WIDTH } from './media.js';
import { getSetting, putSetting } from './settings.js';
import { bumpRevision } from './revision.js';

// Progressive JPEG XL thumbnails, an opt-in setting. When it's on, every item with a (webp) thumbnail also gets a
// JPEG XL one, made in the background; clients that decode JPEG XL load it instead of the webp. Images bigger than
// the thumbnail also get a screen-sized JPEG XL preview, which the full-screen viewer shows before the original.
// Turning the setting on computes them all again, turning it off deletes them.

// `previews`: the screen-sized previews, on by default; only in effect while `jxl` is on.
const DEFAULTS = { jxl: false, previews: true };
let settings = getSetting('thumbnails', DEFAULTS);

// Bumped whenever a setting is toggled: a pass started before stops, and its in-flight result is thrown away.
let generation = 0;
let running = false;
let lastFailure = null;

export const jxlThumbsEnabled = () => settings.jxl;
export const jxlPreviewsEnabled = () => settings.jxl && settings.previews;

// Items still to convert: no JPEG XL thumbnail yet, or (with previews on) no preview yet. '' counts as done.
const pending = () =>
  `thumb IS NOT NULL AND (thumb_jxl IS NULL${jxlPreviewsEnabled() ? ' OR preview_jxl IS NULL' : ''})`;

export function thumbnailSettings() {
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN ${pending()} THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN thumb_jxl = '' THEN 1 ELSE 0 END) AS failed
       FROM items WHERE thumb IS NOT NULL`
    )
    .get();
  const processed = counts.total - (counts.pending || 0);
  return {
    jxl: settings.jxl,
    previews: settings.previews,
    state: !settings.jxl ? 'off' : running || processed < counts.total ? 'running' : 'complete',
    total: counts.total,
    processed: settings.jxl ? processed : 0,
    failed: settings.jxl ? counts.failed || 0 : 0,
    lastFailure: settings.jxl ? lastFailure : null,
  };
}

export function updateThumbnails(patch) {
  const jxl = typeof patch.jxl === 'boolean' && patch.jxl !== settings.jxl;
  const previews = typeof patch.previews === 'boolean' && patch.previews !== settings.previews;
  if (!jxl && !previews) return thumbnailSettings();
  settings = {
    ...settings,
    ...(jxl ? { jxl: patch.jxl } : {}),
    ...(previews ? { previews: patch.previews } : {}),
  };
  putSetting('thumbnails', settings);
  generation++;
  lastFailure = null;
  // Turning JPEG XL on or off starts over; previews on their own are made or deleted without touching thumbnails.
  if (jxl) removeJxlFiles('thumb_jxl', 'preview_jxl');
  else if (!settings.previews) removeJxlFiles('preview_jxl');
  bumpRevision();
  kickJxlThumbs();
  return thumbnailSettings();
}

const removeFiles = (...names) => {
  for (const name of names) if (name) fs.rmSync(path.join(paths.thumbs, name), { force: true });
};

function removeJxlFiles(...columns) {
  const any = columns.map((c) => `${c} IS NOT NULL`).join(' OR ');
  for (const row of db.prepare(`SELECT ${columns.join(', ')} FROM items WHERE ${any}`).all()) {
    removeFiles(...columns.map((c) => row[c]));
  }
  db.exec(`UPDATE items SET ${columns.map((c) => `${c} = NULL`).join(', ')} WHERE ${any}`);
}

/**
 * Make the missing JPEG XL thumbnails and previews in the background (new items, a fresh conversion, one cut short,
 * previews just turned on, or items converted before previews existed).
 */
export function kickJxlThumbs() {
  if (running || !settings.jxl) return;
  running = true;
  const mine = generation;
  const next = db.prepare(`SELECT id, type, file, thumb, width, thumb_jxl, preview_jxl FROM items WHERE ${pending()} LIMIT 20`);
  const save = db.prepare('UPDATE items SET thumb_jxl = ?, preview_jxl = ? WHERE id = ?');
  (async () => {
    try {
      while (settings.jxl && generation === mine) {
        const rows = next.all();
        if (!rows.length) break;
        for (const row of rows) {
          const made = await convert(row, mine);
          if (!made) return;
          const thumb = made.thumb ?? row.thumb_jxl;
          const preview = made.preview ?? row.preview_jxl;
          // the item may have been deleted meanwhile; then don't leave its files behind
          if (!save.run(thumb, preview, row.id).changes) removeFiles(made.thumb, made.preview);
        }
        bumpRevision();
      }
    } finally {
      running = false;
      // toggled while this pass ran: start over under the new settings
      if (generation !== mine) kickJxlThumbs();
    }
  })();
}

/**
 * Make what an item is missing: its JPEG XL thumbnail, and (with previews on) its preview. Resolves to the new names,
 * undefined for one not made this time and '' for one that couldn't be made or isn't needed; or to null when a
 * setting was toggled meanwhile and the result is thrown away.
 *
 * An image's original gives the sharpest thumbnail, and the only preview: anything else (video posters, link
 * previews) kept just its webp thumbnail, and so did an original sharp can't decode.
 */
async function convert(row, mine) {
  const needThumb = row.thumb_jxl === null;
  const needPreview = jxlPreviewsEnabled() && row.preview_jxl === null;
  let original = null;
  if ((row.type === 'image' || row.type === 'gif') && row.file) {
    original = await fs.promises.readFile(path.join(paths.files, row.file)).catch(() => null);
  }
  const made = {};
  const write = async (buffer, kind) => {
    const out = await makeJxl(buffer, kind);
    if (generation !== mine) throw Object.assign(new Error('toggled'), { toggled: true });
    // a new name per conversion: thumbnails are served as immutable
    const name = `${row.id}.${kind === 'preview' ? 'preview.' : ''}${Date.now().toString(36)}.jxl`;
    fs.writeFileSync(path.join(paths.thumbs, name), out);
    return name;
  };
  const webp = () => fs.promises.readFile(path.join(paths.thumbs, row.thumb));
  try {
    if (needThumb) {
      made.thumb = '';
      try {
        made.thumb = await write(original ?? (await webp()), 'thumb');
      } catch (err) {
        if (err.toggled || !original) throw err;
        original = null;
        made.thumb = await write(await webp(), 'thumb');
      }
    }
    if (needPreview) {
      made.preview = '';
      // the thumbnail already shows a small original at full size
      if (original && row.width > THUMB_WIDTH * 1.15) made.preview = await write(original, 'preview');
    }
  } catch (err) {
    if (err.toggled) {
      removeFiles(made.thumb, made.preview);
      return null;
    }
    lastFailure = err.message;
    // marked as done either way, or the pass would pick the item up again forever
    if (needPreview) made.preview ??= '';
  }
  return made;
}
