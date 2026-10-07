import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Folder as FolderIcon,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Loader2,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SquareCheck,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useStore, currentFolderId } from '../store';
import { FOLDER_COLORS } from '../lib/format';
import { cls, Modal, useClampedPosition, XLogo } from './ui';
import { flattenFolders } from './ImportDialog';

// ---------------- context menu ----------------

export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const set = useStore((s) => s.set);
  useEffect(() => {
    if (!menu) return;
    const close = () => set({ contextMenu: null });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [menu, set]);
  if (!menu) return null;
  return <MenuBody key={`${menu.x},${menu.y},${menu.id}`} />;
}

function MenuBody() {
  const menu = useStore((s) => s.contextMenu)!;
  const { ref, pos } = useClampedPosition(menu.x, menu.y);
  const content = menu.kind === 'item' ? <ItemMenu /> : menu.kind === 'folder' ? <FolderMenu id={menu.id!} /> : <GridMenu />;
  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.menu-item')) useStore.getState().set({ contextMenu: null });
      }}
    >
      {content}
    </div>
  );
}

function MI({ icon, label, onClick, danger, hint }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean; hint?: string }) {
  return (
    <button className={cls('menu-item', danger && 'danger')} onClick={onClick}>
      <span className="mi-icon">{icon}</span>
      <span className="mi-label">{label}</span>
      {hint && <span className="mi-hint">{hint}</span>}
    </button>
  );
}

function ItemMenu() {
  const s = useStore.getState();
  const ids = [...s.selected];
  const first = s.items.find((i) => i.id === ids[0]);
  if (!first) return null;
  const inFolder = currentFolderId(s.view);
  const trashed = s.view.kind === 'trash';
  const n = ids.length;

  if (trashed) {
    return (
      <>
        <MI icon={<RotateCcw size={14} />} label={`Restore${n > 1 ? ` ${n} items` : ''}`} onClick={() => s.batch('restore', ids)} />
        <div className="menu-sep" />
        <MI icon={<Trash2 size={14} />} label="Delete forever" danger onClick={() => s.trashSelected()} hint="⌫" />
      </>
    );
  }

  return (
    <>
      {n === 1 && <MI icon={<Eye size={14} />} label="Preview" hint="Space" onClick={() => s.set({ viewerId: first.id })} />}
      {n === 1 && first.url && (
        <MI
          icon={first.source === 'x' ? <XLogo size={12} /> : <ExternalLink size={14} />}
          label={first.source === 'x' ? 'Open post on X' : 'Open source page'}
          onClick={() => window.open(first.url!, '_blank', 'noopener')}
        />
      )}
      {n === 1 && first.fileUrl && (
        <MI
          icon={<Download size={14} />}
          label="Download original"
          onClick={() => {
            const a = document.createElement('a');
            a.href = first.fileUrl!;
            a.download = '';
            a.click();
          }}
        />
      )}
      {n === 1 && (first.url || first.fileUrl) && (
        <MI
          icon={<Copy size={14} />}
          label="Copy link"
          onClick={() => {
            navigator.clipboard?.writeText(first.url || location.origin + first.fileUrl);
            s.toast('Link copied');
          }}
        />
      )}
      {n === 1 && <div className="menu-sep" />}
      <MI icon={<FolderPlus size={14} />} label="Add to folder…" onClick={() => s.set({ folderPicker: { mode: 'add', ids } })} />
      <MI icon={<FolderInput size={14} />} label="Move to folder…" onClick={() => s.set({ folderPicker: { mode: 'move', ids } })} />
      {inFolder && (
        <MI
          icon={<FolderMinus size={14} />}
          label="Remove from this folder"
          onClick={() => s.batch('removeFromFolder', ids, { folderId: inFolder })}
        />
      )}
      <div className="menu-sep" />
      <MI icon={<SquareCheck size={14} />} label="Select all" hint="⌘A" onClick={() => s.selectAll()} />
      <MI
        icon={<Trash2 size={14} />}
        label={`Move ${n > 1 ? `${n} items ` : ''}to Trash`}
        hint="⌫"
        danger
        onClick={() => s.trashSelected()}
      />
    </>
  );
}

function FolderMenu({ id }: { id: string }) {
  const s = useStore.getState();
  const folder = s.folders.find((f) => f.id === id);
  if (!folder) return null;
  return (
    <>
      <MI icon={<Plus size={14} />} label="New subfolder" onClick={() => s.createFolder(id)} />
      <MI icon={<Pencil size={14} />} label="Rename" onClick={() => s.set({ renamingFolderId: id })} />
      <div className="menu-colors">
        <Palette size={14} />
        <button className={cls('dot none', !folder.color && 'on')} onClick={() => s.updateFolder(id, { color: null })} />
        {FOLDER_COLORS.map((c) => (
          <button
            key={c}
            className={cls('dot', folder.color === c && 'on')}
            style={{ background: c }}
            onClick={() => {
              s.updateFolder(id, { color: c });
              s.set({ contextMenu: null });
            }}
          />
        ))}
      </div>
      {folder.parentId && (
        <MI icon={<FolderIcon size={14} />} label="Move to top level" onClick={() => s.updateFolder(id, { parentId: null })} />
      )}
      <div className="menu-sep" />
      <MI icon={<Trash2 size={14} />} label="Delete folder" danger onClick={() => s.deleteFolder(id)} />
    </>
  );
}

function GridMenu() {
  const s = useStore.getState();
  return (
    <>
      <MI icon={<Download size={14} />} label="Import…" onClick={() => s.set({ importOpen: true })} />
      <MI icon={<FolderPlus size={14} />} label="New folder" onClick={() => s.createFolder(currentFolderId(s.view) || null)} />
      <MI icon={<SquareCheck size={14} />} label="Select all" hint="⌘A" onClick={() => s.selectAll()} />
    </>
  );
}

// ---------------- folder picker (command-palette style) ----------------

export function FolderPicker() {
  const picker = useStore((s) => s.folderPicker);
  const folders = useStore((s) => s.folders);
  const set = useStore((s) => s.set);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const flat = useMemo(() => flattenFolders(folders), [folders]);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? flat.filter((f) => f.folder.name.toLowerCase().includes(t)) : flat;
  }, [flat, q]);

  useEffect(() => {
    setQ('');
    setHi(0);
  }, [picker]);

  if (!picker) return null;
  const close = () => set({ folderPicker: null });

  const choose = async (folderId: string) => {
    const s = useStore.getState();
    const name = s.folders.find((f) => f.id === folderId)?.name;
    close();
    if (picker.mode === 'move') await s.batch('moveToFolder', picker.ids, { folderId });
    else await s.batch('addToFolder', picker.ids, { folderId });
    s.toast(`${picker.mode === 'move' ? 'Moved' : 'Added'} ${picker.ids.length} item${picker.ids.length > 1 ? 's' : ''} to ${name}`, 'success');
  };

  const createAndChoose = async () => {
    const s = useStore.getState();
    const f = await api.createFolder({ name: q.trim() || 'New Folder' });
    await s.refreshMeta();
    await choose(f.id);
  };

  return (
    <Modal onClose={close} className="picker-modal">
      <div className="picker-search">
        <Search size={16} />
        <input
          autoFocus
          value={q}
          placeholder={picker.mode === 'move' ? 'Move to folder…' : 'Add to folder…'}
          onChange={(e) => {
            setQ(e.target.value);
            setHi(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHi((h) => Math.min(matches.length, h + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHi((h) => Math.max(0, h - 1));
            } else if (e.key === 'Enter') {
              if (hi < matches.length) choose(matches[hi].folder.id);
              else createAndChoose();
            } else if (e.key === 'Escape') close();
          }}
        />
      </div>
      <div className="picker-list">
        {matches.map(({ folder, depth }, i) => (
          <button
            key={folder.id}
            className={cls('picker-item', i === hi && 'hi')}
            style={{ paddingLeft: 14 + (q ? 0 : depth * 16) }}
            onMouseEnter={() => setHi(i)}
            onClick={() => choose(folder.id)}
          >
            <FolderIcon size={15} style={{ color: folder.color || undefined }} />
            <span>{folder.name}</span>
            <span className="dim">{folder.count}</span>
          </button>
        ))}
        <button
          className={cls('picker-item create', hi === matches.length && 'hi')}
          onMouseEnter={() => setHi(matches.length)}
          onClick={createAndChoose}
        >
          <Plus size={15} />
          <span>{q.trim() ? `Create “${q.trim()}”` : 'Create new folder'}</span>
        </button>
      </div>
    </Modal>
  );
}

// ---------------- confirm ----------------

export function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const set = useStore((s) => s.set);
  if (!confirm) return null;
  const done = (ok: boolean) => {
    confirm.resolve(ok);
    set({ confirm: null });
  };
  return (
    <Modal onClose={() => done(false)} className="confirm-modal">
      <h3>{confirm.title}</h3>
      <p>{confirm.message}</p>
      <div className="confirm-actions">
        <button className="btn" onClick={() => done(false)}>
          Cancel
        </button>
        <button className={cls('btn', confirm.danger ? 'danger' : 'primary')} autoFocus onClick={() => done(true)}>
          {confirm.confirmLabel || 'OK'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------- toasts + import progress ----------------

export function Notifications() {
  const toasts = useStore((s) => s.toasts);
  const jobs = useStore((s) => s.jobs);
  const set = useStore((s) => s.set);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="notifications">
      {jobs.map((job) => {
        const pct = job.total ? Math.round((job.done / job.total) * 100) : 100;
        const running = job.status === 'running';
        const label = job.kind === 'upload' ? 'Uploading' : 'Importing';
        return (
          <div key={job.id} className="job-card">
            <div className="job-head" onClick={() => setExpanded(expanded === job.id ? null : job.id)}>
              {running ? (
                <Loader2 size={16} className="spin" />
              ) : job.failed ? (
                <AlertCircle size={16} className="err" />
              ) : (
                <CheckCircle2 size={16} className="ok" />
              )}
              <div className="job-text">
                <div className="job-title">
                  {running ? `${label} ${job.done}/${job.total}…` : job.failed ? `Finished with ${job.failed} error${job.failed > 1 ? 's' : ''}` : 'Import complete'}
                </div>
                <div className="job-sub">
                  {job.imported} added
                  {job.skipped ? ` · ${job.skipped} already saved` : ''}
                  {job.failed ? ` · ${job.failed} failed` : ''}
                </div>
              </div>
              {!running && (
                <button
                  className="icon-btn xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    set({ jobs: useStore.getState().jobs.filter((j) => j.id !== job.id) });
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
            {(expanded === job.id || (!running && job.failed > 0)) && (
              <div className="job-entries">
                {job.entries.map((e, i) => (
                  <div key={i} className={cls('job-entry', e.state)}>
                    <span className="je-dot" />
                    <span className="je-label" title={e.label}>
                      {e.label}
                    </span>
                    {e.error && <span className="je-error" title={e.error}>{e.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {toasts.map((t) => (
        <div key={t.id} className={cls('toast', t.kind)}>
          {t.kind === 'success' ? <CheckCircle2 size={15} /> : t.kind === 'error' ? <AlertCircle size={15} /> : null}
          {t.message}
        </div>
      ))}
    </div>
  );
}
