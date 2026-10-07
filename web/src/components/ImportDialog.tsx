import { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, Globe, Grid2x2, Link2, Upload, X } from 'lucide-react';
import { useStore, currentFolderId } from '../store';
import type { Folder } from '../types';
import { countLinks } from '../lib/format';
import { cls, Modal, XLogo } from './ui';

type Tab = 'links' | 'files' | 'arena' | 'bookmarklet';

export function ImportDialog() {
  const open = useStore((s) => s.importOpen);
  if (!open) return null;
  return <ImportDialogInner />;
}

function ImportDialogInner() {
  const view = useStore((s) => s.view);
  const { set, importText, uploadFiles } = useStore.getState();
  const [tab, setTab] = useState<Tab>('links');
  const [text, setText] = useState('');
  const [folderId, setFolderId] = useState(currentFolderId(view) || '');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const counts = useMemo(() => countLinks(text), [text]);
  const close = () => set({ importOpen: false });

  const submit = async () => {
    if (!counts.total) return;
    setBusy(true);
    const ok = await importText(text, folderId || undefined);
    setBusy(false);
    if (ok) close();
  };

  const onFiles = (files: FileList | null) => {
    if (!files?.length) return;
    uploadFiles(Array.from(files), folderId || undefined);
    close();
  };

  return (
    <Modal onClose={close} className="import-modal">
      <div className="modal-head">
        <h2>Import</h2>
        <button className="icon-btn" onClick={close}>
          <X size={18} />
        </button>
      </div>
      <div className="tabs">
        <button className={cls(tab === 'links' && 'on')} onClick={() => setTab('links')}>
          <Link2 size={14} /> Links
        </button>
        <button className={cls(tab === 'files' && 'on')} onClick={() => setTab('files')}>
          <Upload size={14} /> Files
        </button>
        <button className={cls(tab === 'arena' && 'on')} onClick={() => setTab('arena')}>
          <Grid2x2 size={14} /> Are.na
        </button>
        <button className={cls(tab === 'bookmarklet' && 'on')} onClick={() => setTab('bookmarklet')}>
          <Bookmark size={14} /> Bookmarklet
        </button>
      </div>

      {tab === 'links' && (
        <div className="modal-body">
          <p className="hint">
            Paste X post links (one or many — any text works, links are detected automatically). Photos, videos and
            GIFs are downloaded in full quality; text-only posts are saved as cards. Direct image/video URLs and web
            pages (their preview image) work too.
          </p>
          <textarea
            className="links-input"
            autoFocus
            value={text}
            spellCheck={false}
            placeholder={'https://x.com/someone/status/1234567890\nhttps://twitter.com/another/status/9876543210\nhttps://example.com/photo.jpg'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          <div className="detected">
            <span className={cls('det', counts.tweets > 0 && 'on')}>
              <XLogo size={11} /> {counts.tweets} post{counts.tweets === 1 ? '' : 's'}
            </span>
            <span className={cls('det', counts.urls > 0 && 'on')}>
              <Globe size={12} /> {counts.urls} other link{counts.urls === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      )}

      {tab === 'files' && (
        <div className="modal-body">
          <div
            className={cls('dropzone', dragOver && 'over')}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOver(false);
              onFiles(e.dataTransfer.files);
            }}
          >
            <Upload size={28} strokeWidth={1.5} />
            <div className="dz-title">Drop files here or click to browse</div>
            <div className="dz-sub">Images, GIFs, videos, SVG, and any other file</div>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </div>
          <p className="hint small">Tip: you can also drop files anywhere in the window, or paste images with ⌘V.</p>
        </div>
      )}

      {tab === 'arena' && (
        <div className="modal-body">
          <p className="hint">
            On Are.na, open a channel → ⋯ → <b>Export</b>, then drop the .zip here. Each channel becomes a folder
            {folderId ? ' inside the selected one' : ''}; titles, descriptions, source links and dates are kept, and
            X posts get their author attached. Re-importing the same export skips blocks you already have.
          </p>
          <div
            className={cls('dropzone', dragOver && 'over')}
            onClick={() => zipRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOver(false);
              onFiles(e.dataTransfer.files);
            }}
          >
            <Grid2x2 size={28} strokeWidth={1.5} />
            <div className="dz-title">Drop an Are.na export (.zip)</div>
            <div className="dz-sub">or click to choose one — you can also drop it anywhere in the window</div>
            <input ref={zipRef} type="file" accept=".zip,application/zip" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </div>
        </div>
      )}

      {tab === 'bookmarklet' && <BookmarkletTab folderId={folderId} />}

      <div className="modal-foot">
        <label className="folder-select">
          <span>Save to</span>
          <FolderSelect value={folderId} onChange={setFolderId} />
        </label>
        {tab === 'links' && (
          <button className="btn primary" disabled={!counts.total || busy} onClick={submit}>
            {busy ? 'Starting…' : `Import ${counts.total || ''}`.trim()}
          </button>
        )}
      </div>
    </Modal>
  );
}

function BookmarkletTab({ folderId }: { folderId: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const code = useMemo(() => {
    const target = `${location.origin}/quick-add?url=`;
    const folder = folderId ? `+'&folderId=${folderId}'` : '';
    return `javascript:(()=>{window.open('${target}'+encodeURIComponent(location.href)${folder},'abacus','width=420,height=300')})()`;
  }, [folderId]);
  // React refuses javascript: URLs in JSX, so set it directly on the element.
  useEffect(() => {
    ref.current?.setAttribute('href', code);
  }, [code]);
  return (
    <div className="modal-body">
      <p className="hint">
        Drag this button to your bookmarks bar. While viewing an X post (or any page / image), click it to save it
        straight into Abacus — no extension needed.
      </p>
      <div className="bookmarklet-row">
        <a ref={ref} className="bookmarklet" onClick={(e) => e.preventDefault()} draggable>
          <XLogo size={12} /> Save to Abacus
        </a>
        <span className="hint small">← drag me to your bookmarks bar</span>
      </div>
    </div>
  );
}

export function FolderSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const folders = useStore((s) => s.folders);
  const ordered = useMemo(() => flattenFolders(folders), [folders]);
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Library (no folder)</option>
      {ordered.map(({ folder, depth }) => (
        <option key={folder.id} value={folder.id}>
          {'   '.repeat(depth) + folder.name}
        </option>
      ))}
    </select>
  );
}

export function flattenFolders(folders: Folder[]) {
  const out: { folder: Folder; depth: number }[] = [];
  const ids = new Set(folders.map((f) => f.id));
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders) {
      const p = f.parentId && ids.has(f.parentId) ? f.parentId : null;
      if (p === parent) {
        out.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    }
  };
  walk(null, 0);
  return out;
}
