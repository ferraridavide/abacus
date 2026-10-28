// Settings forms declared as fields, shared by the import providers and the embeddings service:
//   { key, label, type: 'url' | 'text' | 'secret' | 'select', required?, placeholder?, hint?, options?, default?,
//     group? }   group: a heading the form sorts the field under

export const fieldDefaults = (fields) => Object.fromEntries(fields.map((f) => [f.key, f.default ?? '']));

/** Trim a user-entered URL to "scheme://host[/path]" without a trailing slash. Throws if invalid. */
export function normalizeUrl(raw) {
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
export function applyValues(fields, cfg, values = {}) {
  const next = { ...cfg };
  for (const f of fields) {
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

export const missingField = (fields, cfg) => fields.find((f) => f.required && !cfg[f.key]);

/** The fields and values as sent to the client, with secrets replaced by whether they're set. */
export function publicFields(fields, cfg) {
  const values = {};
  for (const f of fields) values[f.key] = f.type === 'secret' ? !!cfg[f.key] : cfg[f.key];
  return {
    fields: fields.map(({ key, label, type, required, placeholder, hint, options, group }) => ({
      key,
      label,
      type,
      required: !!required,
      placeholder,
      hint,
      options,
      group,
    })),
    values,
  };
}
