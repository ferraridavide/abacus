import { getConfig, mediaPayload, parseTagList, rememberFolder, submitToAbacus, waitForJob } from './lib.js';
import { initTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const FILTER_KEY = 'abacus-batch-filter';
const CONCURRENCY = 4;
// Small images are almost always icons and tracking pixels, so they start filtered out.
const DEFAULT_FILTER = { minWidth: 200, minHeight: 200, formats: null };

let data = null;
let config = null;
const off = new Set(); // image keys the user unticked
let formatsOn = null; // Set of enabled formats, null until the page is built
let saving = false;

const keyOf = (image) => image.candidates[0];

function loadFilter() {
  try {
    return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_FILTER };
  }
}

function passes(image) {
  const width = Number($('minWidth').value) || 0;
  const height = Number($('minHeight').value) || 0;
  // A file whose size the browser doesn't know yet is kept: only measured, small images are dropped.
  if (image.width && image.width < width) return false;
  if (image.height && image.height < height) return false;
  return formatsOn.has(image.format);
}

function chosen() {
  return data.images.filter((image) => passes(image) && !off.has(keyOf(image)));
}

const cards = new Map();

function refresh() {
  let visible = 0;
  for (const image of data.images) {
    const card = cards.get(keyOf(image));
    const show = passes(image);
    card.hidden = !show;
    card.classList.toggle('on', !off.has(keyOf(image)));
    card.setAttribute('aria-pressed', String(!off.has(keyOf(image))));
    if (show) visible++;
  }
  const picked = chosen().length;
  $('count').textContent = `${visible} of ${data.images.length} images match · ${picked} selected`;
  $('save').disabled = saving || !picked;
  $('save').textContent = picked ? `Save ${picked} image${picked > 1 ? 's' : ''}` : 'Nothing selected';
  localStorage.setItem(FILTER_KEY, JSON.stringify({
    minWidth: Number($('minWidth').value) || 0,
    minHeight: Number($('minHeight').value) || 0,
    formats: [...formatsOn],
  }));
}

function buildCard(image) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card on';
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.alt = image.title || '';
  img.src = image.preview;
  img.addEventListener('load', () => {
    // Measure what the page didn't tell us (lazy images are scanned before they load).
    if (!image.upgraded && (!image.width || !image.height)) {
      image.width = img.naturalWidth;
      image.height = img.naturalHeight;
      refresh();
    }
    const label = card.querySelector('.size');
    if (label && !image.upgraded) label.textContent = image.width ? `${image.width}×${image.height}` : '';
  });
  thumb.append(img);
  const tick = document.createElement('span');
  tick.className = 'tick';
  tick.textContent = '✓';
  const meta = document.createElement('span');
  meta.className = 'meta';
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = image.upgraded ? 'Full size' : image.width ? `${image.width}×${image.height}` : '';
  size.title = image.upgraded ? 'Saved from a larger original than the one shown' : '';
  const format = document.createElement('span');
  format.textContent = image.format === 'other' ? '' : image.format;
  meta.append(size, format);
  card.append(thumb, tick, meta);
  card.addEventListener('click', () => {
    const key = keyOf(image);
    if (off.has(key)) off.delete(key);
    else off.add(key);
    refresh();
  });
  return card;
}

function buildFormats(filter) {
  const counts = new Map();
  for (const image of data.images) counts.set(image.format, (counts.get(image.format) || 0) + 1);
  const present = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  formatsOn = new Set(filter.formats ? present.filter((f) => filter.formats.includes(f)) : present);
  if (!formatsOn.size) formatsOn = new Set(present);
  for (const format of present) {
    const label = document.createElement('label');
    label.className = 'chip';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = formatsOn.has(format);
    input.addEventListener('change', () => {
      if (input.checked) formatsOn.add(format);
      else formatsOn.delete(format);
      refresh();
    });
    const text = document.createElement('span');
    text.textContent = format === 'other' ? 'other' : format;
    const count = document.createElement('small');
    count.textContent = counts.get(format);
    label.append(input, text, count);
    $('formats').append(label);
  }
}

function setResult(text, kind = '') {
  const el = $('result');
  el.textContent = text;
  el.className = `status ${kind}`;
  el.hidden = !text;
}

async function save() {
  const images = chosen();
  if (!images.length || saving) return;
  saving = true;
  $('save').disabled = true;
  $('progress').hidden = false;
  $('progress').max = images.length;
  $('progress').value = 0;
  setResult('');
  const folder = $('folder').value.trim();
  const tags = parseTagList($('tags').value);
  const totals = { created: 0, skipped: 0, failed: 0, pending: 0 };
  let firstError = '';
  let next = 0;
  const worker = async () => {
    while (next < images.length) {
      const image = images[next++];
      try {
        const media = { candidates: image.candidates, pageUrl: data.pageUrl };
        const added = await submitToAbacus({ ...mediaPayload(media, { folder, tags }), ...(image.title ? { name: image.title } : {}) }, config);
        const result = await waitForJob(config, added, { timeoutMs: 60_000 });
        if (!result) totals.pending++;
        else if (result.created) totals.created++;
        else if (result.skipped) totals.skipped++;
        else totals.failed++;
      } catch (err) {
        totals.failed++;
        firstError ||= err.message;
      }
      $('progress').value++;
      setResult(`Saving… ${$('progress').value} of ${images.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, images.length) }, worker));
  if (folder && (totals.created || totals.pending)) await rememberFolder(folder).catch(() => {});
  const parts = [];
  if (totals.created) parts.push(`${totals.created} saved`);
  if (totals.skipped) parts.push(`${totals.skipped} already in your library`);
  if (totals.pending) parts.push(`${totals.pending} still importing in Abacus`);
  if (totals.failed) parts.push(`${totals.failed} failed${firstError ? ` (${firstError})` : ''}`);
  setResult(parts.join(' · ') || 'Done', totals.failed ? 'error' : 'ok');
  saving = false;
  refresh();
}

function notice(html) {
  const el = $('notice');
  el.replaceChildren(...html);
  el.hidden = false;
}

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  config = await getConfig();
  const stored = id ? (await chrome.storage.session.get(`batch:${id}`))[`batch:${id}`] : null;
  if (!stored?.images?.length) {
    return notice([document.createTextNode('This list has expired. Use “Save all images on this page” again.')]);
  }
  if (!config.serverUrl) {
    const link = document.createElement('a');
    link.href = 'options.html';
    link.textContent = 'extension settings';
    return notice([document.createTextNode('Connect your Abacus server in the '), link, document.createTextNode(' first.')]);
  }
  data = stored;
  $('source').textContent = stored.title ? `${stored.title} — ${stored.pageUrl}` : stored.pageUrl;
  $('source').title = stored.pageUrl;
  document.title = `Save images — ${stored.title || stored.pageUrl}`;
  const filter = loadFilter();
  $('minWidth').value = filter.minWidth;
  $('minHeight').value = filter.minHeight;
  $('folder').value = config.folder;
  $('tags').value = config.tags;
  buildFormats(filter);
  const fragment = document.createDocumentFragment();
  for (const image of data.images) {
    const card = buildCard(image);
    cards.set(keyOf(image), card);
    fragment.append(card);
  }
  $('grid').append(fragment);
  $('workspace').hidden = false;
  refresh();
}

$('minWidth').addEventListener('input', () => data && refresh());
$('minHeight').addEventListener('input', () => data && refresh());
$('select-all').addEventListener('click', () => {
  for (const image of data.images) if (passes(image)) off.delete(keyOf(image));
  refresh();
});
$('select-none').addEventListener('click', () => {
  for (const image of data.images) if (passes(image)) off.add(keyOf(image));
  refresh();
});
$('save').addEventListener('click', save);

initTheme().catch(() => {});

init().catch((err) => notice([document.createTextNode(`Could not load the list: ${err.message}`)]));
