import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import {
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  Hash,
  Inbox,
  LayoutGrid,
  Plus,
  Settings,
  Tag,
  Trash2,
} from 'lucide-react';
import { useStore } from '../store';
import type { Folder, View } from '../types';
import { cls, Logo } from './ui';
import { dragKind, dropOnFolder, FOLDER_MIME, ITEM_MIME } from '../lib/dnd';
import { formatBytes } from '../lib/format';

function sameView(a: View, b: View) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'folder' && b.kind === 'folder') return a.id === b.id;
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag.toLowerCase() === b.tag.toLowerCase();
  return true;
}

export function Sidebar() {
  const stats = useStore((s) => s.stats);
  const folders = useStore((s) => s.folders);
  const tags = useStore((s) => s.tags);
  const tagsOpen = useStore((s) => s.tagsOpen);
  const set = useStore((s) => s.set);
  const createFolder = useStore((s) => s.createFolder);
  const [rootDrop, setRootDrop] = useState(false);

  const children = useMemo(() => {
    const map = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const key = f.parentId && folders.some((p) => p.id === f.parentId) ? f.parentId : null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return map;
  }, [folders]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo size={26} />
        <div>
          <div className="brand-name">Abacus</div>
          <div className="brand-sub">
            {stats.all.toLocaleString()} items · {formatBytes(stats.totalSize)}
          </div>
        </div>
        <button className="icon-btn sm brand-settings" title="Settings (⌘,)" onClick={() => set({ settingsOpen: true })}>
          <Settings size={15} />
        </button>
      </div>

      <nav className="side-scroll">
        <div className="nav-group">
          <NavRow view={{ kind: 'all' }} icon={<LayoutGrid size={16} />} label="All" count={stats.all} />
          <NavRow
            view={{ kind: 'uncategorized' }}
            icon={<Inbox size={16} />}
            label="Uncategorized"
            count={stats.uncategorized}
          />
          <NavRow view={{ kind: 'untagged' }} icon={<Tag size={16} />} label="Untagged" count={stats.untagged} />
          <NavRow view={{ kind: 'trash' }} icon={<Trash2 size={16} />} label="Trash" count={stats.trash} trashTarget />
        </div>

        <div
          className={cls('section-head', rootDrop && 'drop-target')}
          onDragOver={(e) => {
            if (dragKind(e) === 'folder') {
              e.preventDefault();
              setRootDrop(true);
            }
          }}
          onDragLeave={() => setRootDrop(false)}
          onDrop={(e) => {
            setRootDrop(false);
            dropOnFolder(e, null);
          }}
        >
          <span>Folders</span>
          <span className="section-count">{folders.length || ''}</span>
          <button className="icon-btn sm" title="New folder" onClick={() => createFolder(null)}>
            <Plus size={14} />
          </button>
        </div>
        <div className="folder-tree">
          {(children.get(null) || []).map((f) => (
            <FolderRow key={f.id} folder={f} depth={0} childMap={children} />
          ))}
          {!folders.length && (
            <button className="empty-folders" onClick={() => createFolder(null)}>
              <Plus size={14} /> Create your first folder
            </button>
          )}
        </div>

        <div className="section-head clickable" onClick={() => set({ tagsOpen: !tagsOpen })}>
          <ChevronRight size={13} className={cls('chev', tagsOpen && 'open')} />
          <span>Tags</span>
          <span className="section-count">{tags.length || ''}</span>
        </div>
        {tagsOpen && (
          <div className="tag-list">
            {tags.slice(0, 200).map((t) => (
              <TagRow key={t.name} name={t.name} count={t.count} />
            ))}
            {!tags.length && <div className="side-hint">Tags you add to items show up here.</div>}
          </div>
        )}
      </nav>
    </aside>
  );
}

function NavRow({
  view,
  icon,
  label,
  count,
  trashTarget,
}: {
  view: View;
  icon: ReactNode;
  label: string;
  count: number;
  trashTarget?: boolean;
}) {
  const active = useStore((s) => sameView(s.view, view));
  const setView = useStore((s) => s.setView);
  const [over, setOver] = useState(false);
  return (
    <div
      className={cls('nav-row', active && 'active', over && 'drop-target')}
      onClick={() => setView(view)}
      onDragOver={(e) => {
        if (trashTarget && dragKind(e) === 'items') {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        setOver(false);
        if (!trashTarget) return;
        e.preventDefault();
        const ids: string[] = JSON.parse(e.dataTransfer.getData(ITEM_MIME) || '[]');
        const s = useStore.getState();
        await s.batch('trash', ids);
        s.toast(`Moved ${ids.length} item${ids.length > 1 ? 's' : ''} to Trash`);
      }}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      <span className="nav-count">{count || ''}</span>
    </div>
  );
}

function FolderRow({
  folder,
  depth,
  childMap,
}: {
  folder: Folder;
  depth: number;
  childMap: Map<string | null, Folder[]>;
}) {
  const active = useStore((s) => s.view.kind === 'folder' && s.view.id === folder.id);
  const expanded = useStore((s) => !!s.expanded[folder.id]);
  const renaming = useStore((s) => s.renamingFolderId === folder.id);
  const { setView, set, updateFolder } = useStore.getState();
  const [over, setOver] = useState(false);
  const kids = childMap.get(folder.id) || [];

  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    const s = useStore.getState();
    s.set({ expanded: { ...s.expanded, [folder.id]: !expanded } });
  };

  return (
    <>
      <div
        className={cls('nav-row folder-row', active && 'active', over && 'drop-target')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setView({ kind: 'folder', id: folder.id })}
        onDoubleClick={() => set({ renamingFolderId: folder.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          set({ contextMenu: { x: e.clientX, y: e.clientY, kind: 'folder', id: folder.id } });
        }}
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(FOLDER_MIME, folder.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          const k = dragKind(e);
          if (k) {
            e.preventDefault();
            e.dataTransfer.dropEffect = k === 'items' && !e.altKey ? 'copy' : 'move';
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.stopPropagation();
          setOver(false);
          dropOnFolder(e, folder.id);
        }}
      >
        <span className={cls('chev-btn', !kids.length && 'hidden')} onClick={toggle}>
          <ChevronRight size={13} className={cls('chev', expanded && 'open')} />
        </span>
        <span className="nav-icon" style={{ color: folder.color || undefined }}>
          {active ? <FolderOpen size={16} /> : <FolderIcon size={16} />}
        </span>
        {renaming ? (
          <input
            className="rename-input"
            autoFocus
            defaultValue={folder.name}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const name = e.currentTarget.value.trim();
              set({ renamingFolderId: null });
              if (name && name !== folder.name) updateFolder(folder.id, { name });
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.currentTarget.value = folder.name;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span className="nav-label">{folder.name}</span>
        )}
        <span className="nav-count">{folder.count || ''}</span>
      </div>
      {expanded && kids.map((k) => <FolderRow key={k.id} folder={k} depth={depth + 1} childMap={childMap} />)}
    </>
  );
}

function TagRow({ name, count }: { name: string; count: number }) {
  const active = useStore((s) => s.view.kind === 'tag' && s.view.tag.toLowerCase() === name.toLowerCase());
  const [over, setOver] = useState(false);
  return (
    <div
      className={cls('nav-row tag-row', active && 'active', over && 'drop-target')}
      onClick={() => useStore.getState().setView({ kind: 'tag', tag: name })}
      onDragOver={(e) => {
        if (dragKind(e) === 'items') {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setOver(false);
        const ids: string[] = JSON.parse(e.dataTransfer.getData(ITEM_MIME) || '[]');
        const s = useStore.getState();
        await s.batch('addTags', ids, { tags: [name] });
        s.toast(`Tagged ${ids.length} item${ids.length > 1 ? 's' : ''} with #${name}`, 'success');
      }}
    >
      <span className="nav-icon">
        <Hash size={14} />
      </span>
      <span className="nav-label">{name}</span>
      <span className="nav-count">{count}</span>
    </div>
  );
}
