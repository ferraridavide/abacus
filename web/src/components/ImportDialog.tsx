import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bookmark, Globe, Grid2x2, Link2, Upload } from 'lucide-react';
import { api } from '../api';
import { useStore, currentFolderId } from '../store';
import type { ActiveProvider, Folder } from '../types';
import { countLinks } from '../lib/format';
import { cls, DialogHead, Modal, PageLink, usePhone, XLogo } from './ui';

type Tab = 'links' | 'files' | 'arena' | 'bookmarklet';

const TABS: { key: Tab; label: string; desc: string; icon: ReactNode }[] = [
  { key: 'links', label: 'Links', desc: 'X posts, image and video URLs, web pages', icon: <Link2 size={14} /> },
  { key: 'files', label: 'Files', desc: 'Photos, videos and other files from this device', icon: <Upload size={14} /> },
  { key: 'arena', label: 'Are.na', desc: 'A channel export (.zip)', icon: <Grid2x2 size={14} /> },
  { key: 'bookmarklet', label: 'Bookmarklet', desc: 'Save pages from any browser', icon: <Bookmark size={14} /> },
];

export function ImportDialog() {
  const open = useStore((s) => s.importOpen);
  if (!open) return null;
  return <ImportDialogInner />;
}

function ImportDialogInner() {
  const view = useStore((s) => s.view);
  const { set, importText, uploadFiles } = useStore.getState();
  const phone = usePhone();
  // phones start on the list of import methods, one page each; wider screens show them as tabs
  const [picked, setTab] = useState<Tab | null>(null);
  const tab = picked ?? (phone ? null : 'links');
  const [text, setText] = useState('');
  const [folderId, setFolderId] = useState(currentFolderId(view) || '');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const counts = useMemo(() => countLinks(text), [text]);
  const providers = useProviders();
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
    <Modal onClose={close} className="import-modal page">
      <DialogHead
        title={phone && tab ? TABS.find((t) => t.key === tab)?.label : 'Import'}
        onBack={phone && tab ? () => setTab(null) : undefined}
        onClose={close}
      />
      {!phone && (
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={cls(tab === t.key && 'on')} onClick={() => setTab(t.key)}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      )}

      {!tab && (
        <div className="modal-body">
          <div className="page-links">
            {TABS.map((t) => (
              <PageLink key={t.key} icon={t.icon} label={t.label} desc={t.desc} onClick={() => setTab(t.key)} />
            ))}
          </div>
        </div>
      )}

      {tab === 'links' && (
        <div className="modal-body page-enter">
          <p className="hint">
            Paste X post links (one or many — any text works, links are detected automatically). Photos, videos and
            GIFs are downloaded in full quality; text-only posts are saved as cards. Direct image/video URLs and web
            pages (their preview image) work too.
          </p>
          {providers.map((p) => (
            <p key={p.id} className="hint small">
              Videos, photos and audio are also downloaded from {p.sites.join(', ')} (through {p.name}).
            </p>
          ))}
          <textarea
            className="links-input"
            autoFocus={!phone}
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
        <div className="modal-body page-enter">
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
            <div className="dz-title">{phone ? 'Choose files' : 'Drop files here or click to browse'}</div>
            <div className="dz-sub">Images, GIFs, videos, SVG, and any other file</div>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </div>
          {!phone && (
            <p className="hint small">Tip: you can also drop files anywhere in the window, or paste images with ⌘V.</p>
          )}
        </div>
      )}

      {tab === 'arena' && (
        <div className="modal-body page-enter">
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
            <div className="dz-title">{phone ? 'Choose an Are.na export (.zip)' : 'Drop an Are.na export (.zip)'}</div>
            {!phone && <div className="dz-sub">or click to choose one — you can also drop it anywhere in the window</div>}
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

/** Enabled import providers with the sites they download from (empty when none are set up). */
function useProviders() {
  const [providers, setProviders] = useState<ActiveProvider[]>([]);
  useEffect(() => {
    api
      .importSources()
      .then((s) => setProviders(s.providers.filter((p) => p.sites.length)))
      .catch(() => {});
  }, []);
  return providers;
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
    <div className="modal-body page-enter">
      <p className="hint">
        Drag this button to your bookmarks bar. While viewing an X post, a video, or any page or image, click it to
        save it straight into Abacus — no extension needed.
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
