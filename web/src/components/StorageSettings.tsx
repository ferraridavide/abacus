import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { StorageUsage } from '../types';
import { formatBytes } from '../lib/format';
import { cls } from './ui';
import { DataLocationSettings } from './DataLocationSettings';

type Part = 'db' | 'files' | 'webp' | 'jxl' | 'preview';

// in the order they're stacked in the bar; `group` nests a row under a heading in the list
const PARTS: { key: Part; label: string; unit?: string; group?: 'thumbs' }[] = [
  { key: 'files', label: 'Content', unit: 'file' },
  { key: 'db', label: 'Database' },
  { key: 'webp', label: 'WebP thumbnails', unit: 'file', group: 'thumbs' },
  { key: 'jxl', label: 'JPEG XL thumbnails', unit: 'file', group: 'thumbs' },
  { key: 'preview', label: 'Full-screen previews', unit: 'file', group: 'thumbs' },
];

const share = (bytes: number, total: number) => (total ? (bytes / total) * 100 : 0);
const formatShare = (pct: number) => (pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`);

/** What the library takes on disk, split by kind. */
export function StorageSettings() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      setUsage(await api.storageUsage());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  useEffect(() => {
    void load();
  }, []);

  if (error && !usage) return <div className="provider-status error">{error}</div>;
  if (!usage) return <Loader2 size={16} className="spin dim" />;

  const thumbs = usage.webp.bytes + usage.jxl.bytes + usage.preview.bytes;
  const row = (p: (typeof PARTS)[number]) => {
    const part = usage[p.key];
    return (
      <div key={p.key} className={cls('storage-row', p.group && 'nested')}>
        <span className={cls('storage-dot', `s-${p.key}`)} />
        <span className="storage-label">
          {p.label}
          {p.unit && (
            <span className="storage-count">
              {part.count.toLocaleString()} {p.unit}
              {part.count === 1 ? '' : 's'}
            </span>
          )}
        </span>
        <span className="storage-bytes">{formatBytes(part.bytes)}</span>
        <span className="storage-share">{formatShare(share(part.bytes, usage.total))}</span>
      </div>
    );
  };

  return (
    <div className="semantic">
      {import.meta.env.VITE_DEMO !== 'true' && <DataLocationSettings />}
      <div className="semantic-status storage">
        <div className="semantic-status-head">
          <div className="semantic-count">
            <b>{formatBytes(usage.total)}</b>
            <span>used by the library</span>
          </div>
          <button className="btn ghost sm" disabled={busy} onClick={load} title="Measure again">
            {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
          </button>
        </div>
        <div className="storage-bar" role="img" aria-label="Storage used by each kind of file">
          {PARTS.map((p) => {
            const pct = share(usage[p.key].bytes, usage.total);
            return pct > 0 ? (
              <div
                key={p.key}
                className={cls('storage-segment', `s-${p.key}`)}
                style={{ flexGrow: pct }}
                title={`${p.label}: ${formatBytes(usage[p.key].bytes)}`}
              />
            ) : null;
          })}
        </div>
        {usage.disk && (
          <div className="semantic-note">
            {formatBytes(usage.disk.free)} free of {formatBytes(usage.disk.size)} on the disk that holds the library.
          </div>
        )}
      </div>

      <div className="storage-list">
        {row(PARTS[0])}
        {row(PARTS[1])}
        <div className="storage-row group">
          <span className="storage-dot s-thumbs" />
          <span className="storage-label">Thumbnails</span>
          <span className="storage-bytes">{formatBytes(thumbs)}</span>
          <span className="storage-share">{formatShare(share(thumbs, usage.total))}</span>
        </div>
        {PARTS.filter((p) => p.group === 'thumbs').map(row)}
      </div>
    </div>
  );
}
