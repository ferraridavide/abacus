import { getSetting, putSetting } from '../settings.js';
import { ProviderUnsupported } from './errors.js';
import cobalt from './cobalt.js';

/**
 * Import providers: external services that download media from sites Abacus has no importer of its own for.
 * Links that no provider takes are imported by the web importer. Each provider module exports:
 *
 *   id, name, description, docsUrl
 *   fields       settings shown in the Settings dialog: { key, label, type: 'url' | 'text' | 'secret' | 'select',
 *                required?, placeholder?, hint?, options?: [{ value, label }], default? }
 *   test(cfg)    check the service with these settings: { ok, message, sites? }
 *   sites(cfg)   display names of the sites it can download from
 *   import(url, cfg, opts)  like the other importers; throws ProviderUnsupported to pass the link on
 */
export const PROVIDERS = [cobalt];

const byId = (id) => {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw Object.assign(new Error('Unknown provider'), { statusCode: 404 });
  return p;
};

const defaults = (p) => ({ enabled: false, ...Object.fromEntries(p.fields.map((f) => [f.key, f.default ?? ''])) });
const loadConfig = (p) => getSetting('provider.' + p.id, defaults(p));
const isReady = (p, cfg) => cfg.enabled && p.fields.every((f) => !f.required || cfg[f.key]);

/** Trim a user-entered URL to "scheme://host[/path]" without a trailing slash. Throws if invalid. */
function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'http://' + s);
  } catch {
    throw Object.assign(new Error('Enter a valid URL, like http://192.168.1.10:9000'), { statusCode: 400 });
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw Object.assign(new Error('The URL must start with http:// or https://'), { statusCode: 400 });
  }
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/**
 * Merge form values into a config. Secrets are write-only: a string replaces the stored one ('' removes it),
 * and a missing value keeps it.
 */
function applyValues(p, cfg, values = {}) {
  const next = { ...cfg };
  for (const f of p.fields) {
    const v = values[f.key];
    if (v === undefined || v === null) continue;
    if (f.type === 'url') next[f.key] = normalizeUrl(v);
    else if (f.type === 'select') {
      if (!f.options.some((o) => o.value === String(v))) {
        throw Object.assign(new Error(`Unknown value for ${f.label}`), { statusCode: 400 });
      }
      next[f.key] = String(v);
    } else next[f.key] = String(v).trim();
  }
  return next;
}

/** A provider's settings as sent to the client, with secrets replaced by whether they're set. */
function publicView(p, cfg) {
  const values = {};
  for (const f of p.fields) values[f.key] = f.type === 'secret' ? !!cfg[f.key] : cfg[f.key];
  const fields = p.fields.map(({ key, label, type, required, placeholder, hint, options }) => ({
    key,
    label,
    type,
    required: !!required,
    placeholder,
    hint,
    options,
  }));
  return { id: p.id, name: p.name, description: p.description, docsUrl: p.docsUrl, fields, enabled: !!cfg.enabled, values };
}

export const listProviderSettings = () => PROVIDERS.map((p) => publicView(p, loadConfig(p)));

export function updateProvider(id, { enabled, values } = {}) {
  const p = byId(id);
  const next = applyValues(p, loadConfig(p), values);
  if (enabled !== undefined) next.enabled = !!enabled;
  if (next.enabled) {
    const missing = p.fields.find((f) => f.required && !next[f.key]);
    if (missing) throw Object.assign(new Error(`${missing.label} is required`), { statusCode: 400 });
  }
  putSetting('provider.' + p.id, next);
  sitesCache.delete(p.id);
  return publicView(p, next);
}

/** Test unsaved form values (falling back to the stored ones) without saving them. */
export async function testProvider(id, values) {
  const p = byId(id);
  let cfg;
  try {
    cfg = applyValues(p, loadConfig(p), values);
  } catch (err) {
    return { ok: false, message: err.message };
  }
  const missing = p.fields.find((f) => f.required && !cfg[f.key]);
  if (missing) return { ok: false, message: `${missing.label} is required` };
  try {
    return await p.test(cfg);
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

const sitesCache = new Map();

/** Enabled providers and the sites they download from, for the import dialog. Cached for a few minutes. */
export async function activeProviders() {
  const out = [];
  for (const p of PROVIDERS) {
    const cfg = loadConfig(p);
    if (!isReady(p, cfg)) continue;
    let hit = sitesCache.get(p.id);
    if (!hit || Date.now() - hit.at > 5 * 60 * 1000) {
      let sites = [];
      try {
        sites = await p.sites(cfg);
      } catch {
        /* offline: the dialog just doesn't list its sites */
      }
      hit = { at: Date.now(), sites };
      sitesCache.set(p.id, hit);
    }
    out.push({ id: p.id, name: p.name, sites: hit.sites });
  }
  return out;
}

/** Offer a link to each enabled provider in turn. Returns null when none of them takes it. */
export async function importWithProviders(url, opts) {
  for (const p of PROVIDERS) {
    const cfg = loadConfig(p);
    if (!isReady(p, cfg)) continue;
    try {
      return await p.import(url, cfg, opts);
    } catch (err) {
      if (!(err instanceof ProviderUnsupported)) throw err;
    }
  }
  return null;
}
