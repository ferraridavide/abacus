import { useEffect, useState } from 'react';
import { Check, CircleAlert, Image as ImageIcon, Loader2, PlugZap, RefreshCw, SlidersHorizontal, Sparkles, Type } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import type { EmbeddingStatus, ProviderField, ProviderSettings } from '../types';
import { FieldInput, useServiceForm, type SettingsService } from './ProviderSettings';
import { cls } from './ui';

const SERVICE: SettingsService = { test: api.testEmbeddings, update: api.updateEmbeddings };

const GROUPS: { key: string; label: string; desc: string; icon: React.ReactNode }[] = [
  { key: 'connection', label: 'Connection', desc: 'The embeddings service and model', icon: <PlugZap size={14} /> },
  { key: 'ranking', label: 'Ranking', desc: 'Which results a search keeps', icon: <SlidersHorizontal size={14} /> },
];

/** URLs and choices take a whole row; short fields share one. */
const isWide = (f: ProviderField) => f.type === 'url' || f.type === 'select';

/** The embeddings service's settings, and how far it has got through the library. */
export function SemanticSearchSettings() {
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.embeddingSettings().then(setSettings, (e) => setError(e.message));
  }, []);

  if (error) return <div className="provider-status error">{error}</div>;
  if (!settings) return <Loader2 size={16} className="spin dim" />;
  return <SemanticSearchForm settings={settings} onSaved={setSettings} />;
}

function SemanticSearchForm({ settings, onSaved }: { settings: ProviderSettings; onSaved: (s: ProviderSettings) => void }) {
  // bumped on save, so the progress is read again right away
  const [saves, setSaves] = useState(0);
  const form = useServiceForm(settings, SERVICE, (next) => {
    onSaved(next);
    setSaves((n) => n + 1);
  });
  const { saved, enabled, toggle, values, change, dirty, busy, status, test, save, canTest } = form;

  return (
    <div className="semantic">
      <div className={cls('semantic-hero', enabled && 'on')}>
        <span className="semantic-icon">
          <Sparkles size={18} />
        </span>
        <div className="semantic-intro">
          <div className="semantic-title">Search by meaning</div>
          <p>{saved.description}</p>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          className={cls('switch', enabled && 'on')}
          title={enabled ? 'Turn off' : 'Turn on'}
          onClick={toggle}
        />
      </div>

      {saved.enabled && <EmbeddingProgress refreshKey={saves} />}

      {GROUPS.map((g) => {
        const fields = saved.fields.filter((f) => f.group === g.key);
        if (!fields.length) return null;
        return (
          <section key={g.key} className="form-group">
            <div className="form-group-head">
              <span className="form-group-icon">{g.icon}</span>
              <span className="form-group-label">{g.label}</span>
              <span className="form-group-desc">{g.desc}</span>
            </div>
            <div className="form-group-card">
              {fields.map((f) => (
                <div key={f.key} className={cls('form-cell', isWide(f) && 'wide')}>
                  <FieldInput
                    field={f}
                    value={values[f.key]}
                    secretSet={f.type === 'secret' && saved.values[f.key] === true}
                    onChange={(v) => change(f.key, v)}
                  />
                </div>
              ))}
            </div>
          </section>
        );
      })}

      <div className="semantic-foot">
        <div className={cls('provider-status', status && (status.ok ? 'ok' : 'error'))}>
          {status && (
            <>
              {status.ok ? <Check size={14} /> : <CircleAlert size={14} />}
              <span>{status.message}</span>
            </>
          )}
          {!status && dirty && <span>Unsaved changes</span>}
        </div>
        <button className="btn" disabled={!canTest} onClick={test}>
          {busy === 'test' ? <Loader2 size={14} className="spin" /> : null} Test connection
        </button>
        <button className="btn primary" disabled={!!busy || !dirty} onClick={save}>
          {busy === 'save' ? <Loader2 size={14} className="spin" /> : null} Save
        </button>
      </div>
    </div>
  );
}

const STATE_LABEL: Record<EmbeddingStatus['state'], string> = {
  off: 'Off',
  running: 'Processing',
  complete: 'Up to date',
  error: 'Paused',
};

function EmbeddingProgress({ refreshKey }: { refreshKey: number }) {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const { ask, toast } = useStore.getState();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.embeddingStatus();
        if (!alive) return;
        setStatus(next);
        timer = setTimeout(poll, next.state === 'running' ? 1500 : 5000);
      } catch {
        if (alive) timer = setTimeout(poll, 5000);
      }
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refreshKey]);

  if (!status || status.state === 'off') return null;

  const reprocess = async () => {
    const ok = await ask({
      title: 'Re-process everything?',
      message: 'Every embedding is computed again. Until that finishes, search finds fewer items by meaning.',
      confirmLabel: 'Re-process',
    });
    if (!ok) return;
    setBusy(true);
    try {
      setStatus(await api.reprocessEmbeddings());
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setBusy(false);
  };

  const processed = status.done + status.failed;
  const pct = status.total ? Math.round((processed / status.total) * 100) : 100;

  return (
    <div className={cls('semantic-status', status.state)}>
      <div className="semantic-status-head">
        <span className={cls('state-pill', status.state)}>
          {status.state === 'running' ? <Loader2 size={12} className="spin" /> : <span className="state-dot" />}
          {STATE_LABEL[status.state]}
        </span>
        <button className="btn ghost sm" disabled={busy} onClick={reprocess} title="Compute every embedding again">
          {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Re-process all
        </button>
      </div>
      <div className="semantic-count">
        <b>{processed.toLocaleString()}</b>
        <span>
          of {status.total.toLocaleString()} item{status.total === 1 ? '' : 's'} processed
        </span>
        <span className="semantic-pct">{pct}%</span>
      </div>
      <div className="semantic-bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="semantic-chips">
        <span className="chip">
          <ImageIcon size={12} /> {status.images.toLocaleString()} image{status.images === 1 ? '' : 's'}
        </span>
        <span className="chip">
          <Type size={12} /> {status.texts.toLocaleString()} text{status.texts === 1 ? '' : 's'}
        </span>
        {status.failed > 0 && (
          <span className="chip danger" title={status.lastFailure || undefined}>
            <CircleAlert size={12} /> {status.failed.toLocaleString()} failed
          </span>
        )}
      </div>
      {status.state === 'error' && (
        <div className="semantic-note error">
          {status.error}. Trying again every minute.
        </div>
      )}
      {status.failed > 0 && status.lastFailure && status.state !== 'error' && (
        <div className="semantic-note">Latest failure: {status.lastFailure}</div>
      )}
    </div>
  );
}
