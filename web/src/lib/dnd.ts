import type React from 'react';
import { useStore, currentFolderId } from '../store';

export const ITEM_MIME = 'application/x-abacus-items';
export const FOLDER_MIME = 'application/x-abacus-folder';

export type DragKind = 'items' | 'folder' | 'files' | null;

export function dragKind(e: React.DragEvent | DragEvent): DragKind {
  const types = Array.from(e.dataTransfer?.types || []);
  if (types.includes(ITEM_MIME)) return 'items';
  if (types.includes(FOLDER_MIME)) return 'folder';
  if (types.includes('Files')) return 'files';
  return null;
}

/** Build a little "stack of N" drag image. */
export function setItemDragImage(e: React.DragEvent, thumbs: (string | null)[], count: number) {
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  thumbs
    .filter(Boolean)
    .slice(0, 3)
    .forEach((src, i) => {
      const img = document.createElement('img');
      img.src = src!;
      img.style.transform = `rotate(${(i - 1) * 6}deg)`;
      ghost.appendChild(img);
    });
  const badge = document.createElement('span');
  badge.textContent = String(count);
  ghost.appendChild(badge);
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 40, 40);
  setTimeout(() => ghost.remove(), 0);
}

/** Drop items / folders / OS files onto a folder (null = library root). */
export async function dropOnFolder(e: React.DragEvent, folderId: string | null) {
  e.preventDefault();
  const s = useStore.getState();
  const kind = dragKind(e);
  if (kind === 'items' && folderId) {
    const ids: string[] = JSON.parse(e.dataTransfer.getData(ITEM_MIME) || '[]');
    const folder = s.folders.find((f) => f.id === folderId);
    const from = currentFolderId(s.view);
    if (e.altKey && from !== folderId) {
      await s.batch('moveToFolder', ids, { folderId, fromFolderId: from });
      s.toast(`Moved ${ids.length} item${ids.length > 1 ? 's' : ''} to ${folder?.name}`, 'success');
    } else {
      await s.batch('addToFolder', ids, { folderId });
      s.toast(`Added ${ids.length} item${ids.length > 1 ? 's' : ''} to ${folder?.name}`, 'success');
    }
  } else if (kind === 'folder') {
    const id = e.dataTransfer.getData(FOLDER_MIME);
    if (id && id !== folderId) {
      await s.updateFolder(id, { parentId: folderId });
      if (folderId) s.set({ expanded: { ...s.expanded, [folderId]: true } });
    }
  } else if (kind === 'files') {
    await s.uploadFiles(Array.from(e.dataTransfer.files), folderId || undefined);
  }
}
