import { useEffect, useState } from 'react';
import { ArrowUp, ClipboardPaste, Copy, Database, Folder, FolderOpen, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import type { DataLocation, FolderListing } from '../types';
import { cls } from './ui';

const POLL_MS = 1000;

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    useStore.getState().toast('Path copied');
  } catch {
    useStore.getState().toast('The browser blocked the clipboard; select the path and copy it', 'error');
  }
}

/** Where the library is on the server's disks, and moving it to any other folder: a synced one, a network share. */
export function DataLocationSettings() {
  const [location, setLocation] = useState<DataLocation | null>(null);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  // the folder a move is heading to, kept while the server restarts and can't be asked
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.dataLocation();
        if (!alive) return;
        setLocation(next);
        setError('');
        // the library itself is reloaded by the live sync (store.ts), which every open tab runs
        if (target && !next.move) {
          setTarget(null);
          return;
        }
        if (next.move?.state === 'failed') setTarget(null);
      } catch (e) {
        // while the server restarts in the new folder it doesn't answer: keep asking
        if (!alive) return;
        if (!target) return setError((e as Error).message);
      }
      if (target) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [target]);

  if (error && !location) return <div className="provider-status error">{error}</div>;
  if (!location) return <Loader2 size={16} className="spin dim" />;

  const move = location.move;
  const moving = !!target || (!!move && move.state !== 'failed');

  const start = async (path: string, mode: 'copy' | 'open', replace = false) => {
    const { ask, toast } = useStore.getState();
    const ok = await ask(
      mode === 'open'
        ? {
            title: 'Open this library?',
            message: `Abacus switches to the library in ${path}. The current one stays in ${location.path}, unchanged.`,
            confirmLabel: 'Open library',
          }
        : {
            title: replace ? 'Replace the library there?' : 'Copy the library here?',
            message:
              `The database, files and thumbnails are copied to ${path}, then Abacus restarts there. ` +
              (replace ? 'The library already in that folder is overwritten. ' : '') +
              `The current copy stays in ${location.path}; delete it yourself once you’re happy.`,
            confirmLabel: replace ? 'Replace and move' : 'Copy and move',
            danger: replace,
          }
    );
    if (!ok) return;
    try {
      setLocation(await api.moveDataLocation({ path, mode, replace }));
      setTarget(path);
      setPicking(false);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="setting data-location">
      <div className="setting-label">Library folder</div>
      <div className="setting-hint">
        The database, original files and thumbnails, on the server. Any folder works: a synced folder, an external
        drive, a network share. Only one server may use a library at a time.
      </div>
      <div className="data-location-current">
        <Database size={15} className="dim" />
        <code title={location.path}>{location.path}</code>
        <button className="icon-btn sm" title="Copy path" aria-label="Copy path" onClick={() => copyPath(location.path)}>
          <Copy size={13} />
        </button>
        {!picking && (
          <button className="btn sm" disabled={moving} onClick={() => setPicking(true)}>
            Change…
          </button>
        )}
      </div>
      {location.lastError && !move && <div className="provider-status error">{location.lastError}</div>}
      {move && <MoveProgress move={move} />}
      {picking && <FolderPicker start={location.path} onCancel={() => setPicking(false)} onPick={start} />}
    </div>
  );
}

function MoveProgress({ move }: { move: NonNullable<DataLocation['move']> }) {
  if (move.state === 'failed') return <div className="provider-status error">Couldn’t move the library: {move.error}</div>;
  const pct = move.total ? Math.round((move.done / move.total) * 100) : 0;
  return (
    <div className="semantic-status running">
      <div className="semantic-count">
        <Loader2 size={13} className="spin" />
        <span>
          {move.state === 'switching'
            ? 'Restarting in the new folder…'
            : `Copying ${move.done.toLocaleString()} of ${move.total.toLocaleString()} files`}
        </span>
        {move.state === 'copying' && <span className="semantic-pct">{pct}%</span>}
      </div>
      {move.state === 'copying' && (
        <div className="semantic-bar">
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Browse the server's folders, or type a path (a share like \\nas\photos works too). */
function FolderPicker({
  start,
  onCancel,
  onPick,
}: {
  start: string;
  onCancel: () => void;
  onPick: (path: string, mode: 'copy' | 'open', replace?: boolean) => void;
}) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState(start);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const open = async (path?: string) => {
    setBusy(true);
    try {
      const next = await api.browseFolders(path);
      setListing(next);
      setTyped(next.path);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  useEffect(() => {
    void open(start);
  }, [start]);

  const here = listing?.path === typed.trim() ? listing : null;
  const current = here?.path === start;

  return (
    <div className="folder-browser">
      <form
        className="secret-row"
        onSubmit={(e) => {
          e.preventDefault();
          void open(typed.trim());
        }}
      >
        <input
          className="text-input"
          spellCheck={false}
          value={typed}
          aria-label="Folder path"
          placeholder="/mnt/nas/abacus or \\nas\share\abacus"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          onPaste={(e) => {
            // a pasted path replaces what was there and opens right away
            const text = e.clipboardData.getData('text').trim();
            if (!text) return;
            e.preventDefault();
            e.stopPropagation();
            setTyped(text);
            void open(text);
          }}
        />
        <button
          type="button"
          className="btn"
          title="Paste a path"
          aria-label="Paste a path"
          disabled={busy}
          onClick={async () => {
            try {
              const text = (await navigator.clipboard.readText()).trim();
              if (!text) return;
              setTyped(text);
              void open(text);
            } catch {
              setError('The browser blocked reading the clipboard; paste into the field with Ctrl+V');
            }
          }}
        >
          <ClipboardPaste size={14} />
        </button>
        <button type="submit" className="btn" disabled={busy || !typed.trim()}>
          Go
        </button>
      </form>
      {listing && (
        <div className="folder-places">
          {listing.places.map((p) => (
            <button key={p.label + p.path} className="btn ghost sm" onClick={() => open(p.path)} title={p.path}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      {error && <div className="provider-status error">{error}</div>}
      {listing && (
        <div className="folder-list" role="listbox" aria-label="Folders">
          {listing.parent && (
            <button className="folder-entry" onClick={() => open(listing.parent!)}>
              <ArrowUp size={14} /> <span>..</span>
            </button>
          )}
          {listing.folders.map((f) => (
            <button key={f.path} className={cls('folder-entry', f.library && 'library')} onClick={() => open(f.path)}>
              {f.library ? <FolderOpen size={14} /> : <Folder size={14} />}
              <span>{f.name}</span>
              {f.library && <span className="chip">Library</span>}
            </button>
          ))}
          {!listing.folders.length && <div className="folder-empty dim">No folders here</div>}
        </div>
      )}
      <div className="setting-hint">
        {current
          ? 'The library is in this folder.'
          : here?.library
            ? 'This folder holds a library. Open it, or replace it with this one.'
            : 'A folder that doesn’t exist yet is created.'}
      </div>
      <div className="provider-foot">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        {here?.library && !current ? (
          <>
            <button className="btn danger" disabled={busy} onClick={() => onPick(typed.trim(), 'copy', true)}>
              Replace with this library
            </button>
            <button className="btn primary" disabled={busy} onClick={() => onPick(typed.trim(), 'open')}>
              Open this library
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={busy || current || !typed.trim()} onClick={() => onPick(typed.trim(), 'copy')}>
            Move library here
          </button>
        )}
      </div>
    </div>
  );
}
