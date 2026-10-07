import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { useStore, currentFolderId } from './store';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { Grid } from './components/Grid';
import { Inspector } from './components/Inspector';
import { Viewer } from './components/Viewer';
import { ImportDialog } from './components/ImportDialog';
import { SettingsDialog } from './components/Settings';
import { ConfirmDialog, ContextMenu, FolderPicker, Notifications } from './components/Overlays';
import { dragKind } from './lib/dnd';
import { countLinks } from './lib/format';
import { cls } from './components/ui';

const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]');

export default function App() {
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const folders = useStore((s) => s.folders);
  const view = useStore((s) => s.view);
  const [fileDrag, setFileDrag] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    useStore.getState().refresh();
  }, []);

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        s.set({ settingsOpen: !s.settingsOpen });
        return;
      }
      if (isTyping(e.target) || s.settingsOpen || s.importOpen || s.folderPicker || s.confirm || s.viewerId) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'a') {
        e.preventDefault();
        s.selectAll();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        s.trashSelected();
      } else if ((e.key === ' ' || e.key === 'Enter') && s.selected.size) {
        e.preventDefault();
        const id = s.anchor && s.selected.has(s.anchor) ? s.anchor : [...s.selected][0];
        s.set({ viewerId: id });
      } else if (e.key === 'Escape') {
        s.clearSelection();
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        s.setThumbSize(Math.min(520, s.thumbSize + 40));
      } else if (mod && e.key === '-') {
        e.preventDefault();
        s.setThumbSize(Math.max(120, s.thumbSize - 40));
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && s.items.length) {
        e.preventDefault();
        const idx = s.items.findIndex((i) => i.id === s.anchor);
        const next = s.items[Math.max(0, Math.min(s.items.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1)))];
        if (next) {
          s.select(next.id, 'single');
          document.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // paste images or links anywhere
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const s = useStore.getState();
      if (s.importOpen || s.folderPicker) return;
      const files = Array.from(e.clipboardData?.files || []);
      const folderId = currentFolderId(s.view);
      if (files.length) {
        e.preventDefault();
        // browsers name every pasted screenshot "image.png" — give them a readable, unique name
        const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
        const named = files.map((f, i) => {
          if (f.name && f.name !== 'image.png') return f;
          const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          return new File([f], `Pasted ${stamp}${files.length > 1 ? ` (${i + 1})` : ''}.${ext}`, { type: f.type });
        });
        s.uploadFiles(named, folderId);
        return;
      }
      const text = e.clipboardData?.getData('text') || '';
      const { total, tweets } = countLinks(text);
      if (total) {
        e.preventDefault();
        s.importText(text, folderId);
        s.toast(`Importing ${tweets ? `${tweets} X post${tweets > 1 ? 's' : ''}` : ''}${tweets && total > tweets ? ' + ' : ''}${total > tweets ? `${total - tweets} link${total - tweets > 1 ? 's' : ''}` : ''}…`);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // OS file drag & drop anywhere in the window
  const onDragEnter = (e: React.DragEvent) => {
    if (dragKind(e) !== 'files') return;
    dragDepth.current++;
    setFileDrag(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (dragKind(e) !== 'files') return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setFileDrag(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (dragKind(e) === 'files') e.preventDefault();
  };
  const onDrop = (e: React.DragEvent) => {
    dragDepth.current = 0;
    setFileDrag(false);
    if (dragKind(e) !== 'files' || e.defaultPrevented) return;
    e.preventDefault();
    const s = useStore.getState();
    const uriList = e.dataTransfer.getData('text/uri-list');
    if (e.dataTransfer.files.length) s.uploadFiles(Array.from(e.dataTransfer.files), currentFolderId(s.view));
    else if (uriList) s.importText(uriList, currentFolderId(s.view));
  };

  const folderName = view.kind === 'folder' ? folders.find((f) => f.id === view.id)?.name : null;

  return (
    <div
      className={cls('app', !inspectorOpen && 'no-inspector')}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <Sidebar />
      <main className="main">
        <Toolbar />
        <Grid />
      </main>
      {inspectorOpen && <Inspector />}

      {fileDrag && (
        <div className="drop-overlay">
          <div className="drop-card">
            <Upload size={34} strokeWidth={1.5} />
            <div>
              Drop to import{folderName ? ' into ' : ''}
              {folderName && <b>{folderName}</b>}
            </div>
            <span>or drop onto a folder in the sidebar</span>
          </div>
        </div>
      )}

      <Viewer />
      <ImportDialog />
      <SettingsDialog />
      <FolderPicker />
      <ConfirmDialog />
      <ContextMenu />
      <Notifications />
    </div>
  );
}
