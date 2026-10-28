import { getSetting, putSetting } from '../settings.js';
import { applyValues, fieldDefaults, missingField, publicFields } from '../fields.js';
import { ProviderUnsupported } from './errors.js';
import cobalt from './cobalt.js';

/**
 * Import providers: external services that download media from sites Abacus has no importer of its own for.
 * Links that no provider takes are imported by the web importer. Each provider module exports:
 *
 *   id, name, description, docsUrl
 *   fields       settings shown in the Settings dialog (see fields.js)
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

const defaults = (p) => ({ enabled: false, ...fieldDefaults(p.fields) });
const loadConfig = (p) => getSetting('provider.' + p.id, defaults(p));
const isReady = (p, cfg) => cfg.enabled && !missingField(p.fields, cfg);

/** A provider's settings as sent to the client, with secrets replaced by whether they're set. */
function publicView(p, cfg) {
  const { id, name, description, docsUrl } = p;
  return { id, name, description, docsUrl, enabled: !!cfg.enabled, ...publicFields(p.fields, cfg) };
}

export const listProviderSettings = () => PROVIDERS.map((p) => publicView(p, loadConfig(p)));

export function updateProvider(id, { enabled, values } = {}) {
  const p = byId(id);
  const next = applyValues(p.fields, loadConfig(p), values);
  if (enabled !== undefined) next.enabled = !!enabled;
  if (next.enabled) {
    const missing = missingField(p.fields, next);
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
    cfg = applyValues(p.fields, loadConfig(p), values);
  } catch (err) {
    return { ok: false, message: err.message };
  }
  const missing = missingField(p.fields, cfg);
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
