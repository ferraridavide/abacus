import { useEffect, useState } from 'react';
import { Check, ChevronRight, CircleAlert, ExternalLink, Loader2 } from 'lucide-react';
import { api } from '../api';
import type { ProviderField, ProviderSettings, ProviderTest } from '../types';
import { cls } from './ui';

/** The import providers' settings, loaded when the dialog opens. */
export function useProviderSettings() {
  const [list, setList] = useState<ProviderSettings[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.providerSettings().then(setList, (e) => setError(e.message));
  }, []);
  const update = (next: ProviderSettings) => setList((l) => l && l.map((p) => (p.id === next.id ? next : p)));
  return { list, error, update };
}

/** The import providers as a list; each opens its own settings, drawn from the fields it declares. */
export function ImportSourcesSettings({
  providers,
  error,
  onOpen,
}: {
  providers: ProviderSettings[] | null;
  error: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="setting">
      <div className="setting-label">Import providers</div>
      <div className="setting-hint">
        Services that download media from sites Abacus can't import by itself. Links no provider supports are
        saved as web pages.
      </div>
      {error && <div className="provider-status error">{error}</div>}
      {!providers && !error && <Loader2 size={16} className="spin dim" />}
      <div className="provider-list">
        {providers?.map((p) => (
          <button key={p.id} className="provider-row" onClick={() => onOpen(p.id)}>
            <span className={cls('status-dot', p.enabled && 'on')} title={p.enabled ? 'On' : 'Off'} />
            <span className="provider-title">
              <span className="provider-name">{p.name}</span>
              <span className="provider-desc">{summary(p)}</span>
            </span>
            <ChevronRight size={16} className="dim" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** "On · http://…", "Off", or "Not set up", for the provider list. */
function summary(p: ProviderSettings) {
  if (!hasRequired(p)) return 'Not set up';
  const url = p.fields.find((f) => f.type === 'url');
  if (!p.enabled) return 'Off';
  return url ? `On · ${p.values[url.key]}` : 'On';
}

/** One provider's settings; the dialog's title row names it. */
export function ProviderDetail({ provider, onSaved }: { provider: ProviderSettings; onSaved: (next: ProviderSettings) => void }) {
  const [saved, setSaved] = useState(provider);
  const [enabled, setEnabled] = useState(provider.enabled);
  // Plain values for the form; secrets start empty and are only sent when typed or removed.
  const [values, setValues] = useState(() => initialValues(provider));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [status, setStatus] = useState<ProviderTest | null>(null);

  const change = (key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setDirty(true);
    setStatus(null);
    // Filling in a provider that was never set up turns it on.
    if (!saved.enabled && !hasRequired(saved) && key === firstRequired(saved)?.key && value) setEnabled(true);
  };

  const payload = () => {
    const out: Record<string, string> = {};
    for (const f of saved.fields) {
      if (f.type === 'secret' && values[f.key] === '' && !removedSecret(values, f)) continue;
      out[f.key] = removedSecret(values, f) ? '' : values[f.key];
    }
    return out;
  };

  const test = async () => {
    setBusy('test');
    try {
      setStatus(await api.testProvider(saved.id, payload()));
    } catch (e) {
      setStatus({ ok: false, message: (e as Error).message });
    }
    setBusy('');
  };

  const save = async () => {
    setBusy('save');
    try {
      const next = await api.updateProvider(saved.id, { enabled, values: payload() });
      setSaved(next);
      onSaved(next);
      setEnabled(next.enabled);
      setValues(initialValues(next));
      setDirty(false);
      // Check the saved settings right away, so a typo shows up here rather than during an import.
      setStatus(next.enabled ? await api.testProvider(next.id, {}) : { ok: true, message: 'Saved. This provider is off.' });
    } catch (e) {
      setStatus({ ok: false, message: (e as Error).message });
    }
    setBusy('');
  };

  return (
    <div className="provider-detail">
      <div className="provider-head">
        <div className="provider-title">
          <span className="provider-desc">{saved.description}</span>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          className={cls('switch', enabled && 'on')}
          title={enabled ? 'Turn off' : 'Turn on'}
          onClick={() => {
            setEnabled(!enabled);
            setDirty(true);
            setStatus(null);
          }}
        />
      </div>

      <div className="provider-fields">
        {saved.fields.map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            value={values[f.key]}
            secretSet={f.type === 'secret' && saved.values[f.key] === true}
            onChange={(v) => change(f.key, v)}
          />
        ))}
      </div>

      <div className="provider-foot">
        <div className={cls('provider-status', status && (status.ok ? 'ok' : 'error'))}>
          {status && (
            <>
              {status.ok ? <Check size={14} /> : <CircleAlert size={14} />}
              <span>
                {status.message}
                {status.sites?.length ? ` · ${status.sites.length} sites` : ''}
              </span>
            </>
          )}
          {!status && saved.docsUrl && (
            <a href={saved.docsUrl} target="_blank" rel="noreferrer">
              How to run {saved.name} <ExternalLink size={12} />
            </a>
          )}
        </div>
        <button className="btn" disabled={!!busy || !values[firstRequired(saved)?.key ?? '']} onClick={test}>
          {busy === 'test' ? <Loader2 size={14} className="spin" /> : null} Test connection
        </button>
        <button className="btn primary" disabled={!!busy || !dirty} onClick={save}>
          {busy === 'save' ? <Loader2 size={14} className="spin" /> : null} Save
        </button>
      </div>
      {status?.ok && status.sites?.length ? <div className="provider-sites">{status.sites.join(', ')}</div> : null}
    </div>
  );
}

const REMOVED = '\u0000removed';

function FieldInput({
  field,
  value,
  secretSet,
  onChange,
}: {
  field: ProviderField;
  value: string;
  secretSet: boolean;
  onChange: (value: string) => void;
}) {
  const id = `provider-field-${field.key}`;
  let input;
  if (field.type === 'select') {
    input = (
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'secret') {
    const removed = value === REMOVED;
    input = (
      <div className="secret-row">
        <input
          id={id}
          className="text-input"
          type="password"
          autoComplete="off"
          value={removed ? '' : value}
          placeholder={secretSet && !removed ? 'Saved. Type to replace it.' : field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {secretSet && !removed && (
          <button className="btn" onClick={() => onChange(REMOVED)}>
            Remove
          </button>
        )}
      </div>
    );
  } else {
    input = (
      <input
        id={id}
        className="text-input"
        type={field.type === 'url' ? 'url' : 'text'}
        spellCheck={false}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
    );
  }
  return (
    <div className="provider-field">
      <label htmlFor={id}>
        {field.label}
        {field.required && <span className="dim"> · required</span>}
      </label>
      {input}
      {field.hint && <div className="field-hint">{field.hint}</div>}
    </div>
  );
}

function initialValues(p: ProviderSettings) {
  const out: Record<string, string> = {};
  for (const f of p.fields) out[f.key] = f.type === 'secret' ? '' : String(p.values[f.key] ?? '');
  return out;
}

const removedSecret = (values: Record<string, string>, f: ProviderField) => f.type === 'secret' && values[f.key] === REMOVED;
const firstRequired = (p: ProviderSettings) => p.fields.find((f) => f.required);
const hasRequired = (p: ProviderSettings) => p.fields.every((f) => !f.required || p.values[f.key]);
