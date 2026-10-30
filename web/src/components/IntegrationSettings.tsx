import { useEffect, useState, type FormEvent } from 'react';
import { Copy, KeyRound, Loader2 } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/format';
import { useStore } from '../store';
import type { ApiKey, CreatedApiKey } from '../types';

export function IntegrationSettings() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.apiKeys().then(
      (next) => { if (active) setKeys(next); },
      (e: Error) => { if (active) setError(e.message); }
    );
    return () => { active = false; };
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || created || !keys || !name.trim()) return;
    setBusy('create');
    setError('');
    try {
      const next = await api.createApiKey(name.trim());
      const { token: _token, ...metadata } = next;
      setKeys((list) => [metadata, ...(list ?? [])]);
      setCreated(next);
      setName('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const revoke = async (key: ApiKey) => {
    if (busy) return;
    setBusy(key.id);
    try {
      const confirmed = await useStore.getState().ask({
        title: 'Revoke API key?',
        message: `“${key.name}” will stop working immediately. Extensions and scripts using it will need a new key.`,
        confirmLabel: 'Revoke key',
        danger: true,
      });
      if (!confirmed) return;
      setError('');
      await api.deleteApiKey(key.id);
      setKeys((list) => list?.filter((entry) => entry.id !== key.id) ?? []);
      if (created?.id === key.id) setCreated(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="integration-settings">
      <div>
        <div className="setting-label">API keys</div>
        <div className="setting-hint">
          Connect extensions and scripts to Abacus. Each key can add content, suggest folders and tags, and follow imports.
        </div>
        <form className="api-key-form provider-field" onSubmit={create}>
          <label htmlFor="api-key-name">Key name</label>
          <div className="secret-row">
            <input id="api-key-name" className="text-input" placeholder="e.g. Chrome extension" maxLength={100}
              value={name} onChange={(e) => setName(e.target.value)} disabled={!!busy || !!created || !keys} required />
            <button type="submit" className="btn primary" disabled={!!busy || !!created || !keys || !name.trim()}>
              {busy === 'create' && <Loader2 size={14} className="spin" />} Create key
            </button>
          </div>
        </form>
      </div>
      {created && <NewApiKey apiKey={created} onDone={() => setCreated(null)} />}
      {error && <div className="provider-status error" role="alert">{error}</div>}
      {!keys && !error && <Loader2 size={16} className="spin dim" aria-label="Loading API keys" />}
      {keys?.length === 0 && <div className="api-key-empty"><KeyRound size={22} /><span>No API keys yet</span></div>}
      {!!keys?.length && (
        <ul className="api-key-list" aria-label="API keys">
          {keys.map((key) => (
            <li key={key.id} className="api-key-row">
              <div className="provider-title">
                <span className="provider-name">{key.name}</span>
                <span className="provider-desc">Last used: {key.lastUsedAt === null ? 'Never' : formatDate(key.lastUsedAt)}</span>
              </div>
              <button className="btn danger" disabled={!!busy} onClick={() => revoke(key)} aria-label={`Revoke ${key.name}`}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewApiKey({ apiKey, onDone }: { apiKey: CreatedApiKey; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey.token);
      setCopied(true);
      setError('');
    } catch {
      setError('Select the key above and copy it manually.');
    }
  };
  return (
    <div className="api-key-created" role="region" aria-label="New API key">
      <div className="setting-label">Copy your new key</div>
      <p className="setting-hint">Save this key now. You won’t be able to see it again after leaving this page.</p>
      <input className="text-input api-key-token" aria-label="New API key" value={apiKey.token} readOnly
        onFocus={(e) => e.target.select()} autoComplete="off" spellCheck={false} />
      <div className="api-key-actions">
        <button className="btn" onClick={copy}><Copy size={14} />{copied ? 'Copied' : 'Copy key'}</button>
        <button className="btn" onClick={onDone}>Done</button>
      </div>
      {error && <div className="provider-status error" role="alert">{error}</div>}
    </div>
  );
}
