import { useEffect, useState } from 'react';
import {
  ExternalLink,
  Folder as FolderIcon,
  FolderPlus,
  Layers,
  Maximize2,
  RotateCcw,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useStore } from '../store';
import type { Item } from '../types';
import { formatBytes, formatDate, formatDuration, FOLDER_COLORS, hostOf } from '../lib/format';
import { Avatar, BookmarkFace } from './Card';
import { TagInput } from './TagInput';
import { cls, XLogo } from './ui';

export function Inspector() {
  const selected = useStore((s) => s.selected);
  const items = useStore((s) => s.items);
  const sel = items.filter((i) => selected.has(i.id));

  return (
    <aside className="inspector">
      {selected.size === 1 && sel.length === 1 ? (
        <SingleInspector key={sel[0].id} item={sel[0]} />
      ) : selected.size > 1 ? (
        // "select all" can include items whose pages aren't loaded yet: act on ids, preview what's loaded
        <MultiInspector items={sel} ids={[...selected]} />
      ) : (
        <EmptyInspector />
      )}
    </aside>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="insp-section">
      <div className="insp-title">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

function SingleInspector({ item }: { item: Item }) {
  const { updateItem, set, setFilters, batch, toast } = useStore.getState();
  const folders = useStore((s) => s.folders);
  const [name, setName] = useState(item.name);
  const [notes, setNotes] = useState(item.notes || '');
  const [url, setUrl] = useState(item.url || '');

  useEffect(() => setName(item.name), [item.name]);
  useEffect(() => setNotes(item.notes || ''), [item.notes]);
  useEffect(() => setUrl(item.url || ''), [item.url]);

  const itemFolders = folders.filter((f) => item.folders.includes(f.id));
  const trashed = !!item.deletedAt;

  return (
    <div className="insp-body">
      <div className="insp-preview" onDoubleClick={() => set({ viewerId: item.id })}>
        {item.thumbUrl ? (
          <img src={item.thumbUrl} alt="" draggable={false} />
        ) : item.type === 'bookmark' ? (
          <BookmarkFace item={item} />
        ) : item.type === 'video' && item.fileUrl ? (
          <video src={item.fileUrl + '#t=0.5'} preload="metadata" muted />
        ) : (
          <div className="file-face">
            <span>{(item.ext || 'file').toUpperCase()}</span>
          </div>
        )}
        <button className="icon-btn floating" title="Open preview (Space)" onClick={() => set({ viewerId: item.id })}>
          <Maximize2 size={14} />
        </button>
      </div>

      {item.palette.length > 0 && (
        <div className="palette">
          {item.palette.map((p) => (
            <button
              key={p.hex}
              className="swatch"
              style={{ background: p.hex, flexGrow: Math.max(0.6, p.ratio * 10) }}
              title={`${p.hex} · ${Math.round(p.ratio * 100)}% — click to find similar colours, ⌥-click to copy`}
              onClick={(e) => {
                if (e.altKey) {
                  navigator.clipboard?.writeText(p.hex);
                  toast(`Copied ${p.hex}`);
                } else {
                  setFilters({ color: p.hex });
                }
              }}
            />
          ))}
        </div>
      )}

      <input
        className="insp-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== item.name && updateItem(item.id, { name: name.trim() })}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />

      <div className="rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className={cls('star', n <= item.rating && 'on')}
            onClick={() => updateItem(item.id, { rating: item.rating === n ? 0 : n })}
          >
            <Star size={15} />
          </button>
        ))}
      </div>

      {item.source === 'x' && (
        <div className="tweet-block">
          <div className="tweet-head">
            <Avatar src={item.authorAvatar} name={item.author || '?'} size={34} />
            <div className="tweet-who">
              <div className="tweet-name">{item.author}</div>
              <a
                className="tweet-handle"
                href={`https://x.com/${item.authorHandle}`}
                target="_blank"
                rel="noreferrer"
              >
                @{item.authorHandle}
              </a>
            </div>
            <XLogo size={15} />
          </div>
          {item.text && item.type !== 'bookmark' && <p className="tweet-text">{item.text}</p>}
          {item.url && (
            <a className="tweet-link" href={item.url} target="_blank" rel="noreferrer">
              View post <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}

      <Section title="Notes">
        <textarea
          className="insp-notes"
          placeholder="Add a note…"
          value={notes}
          rows={Math.min(8, Math.max(2, notes.split('\n').length))}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (item.notes || '') && updateItem(item.id, { notes })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Section>

      <Section title="Tags">
        <TagInput
          value={item.tags}
          onAdd={(t) => updateItem(item.id, { tags: [...item.tags, t] })}
          onRemove={(t) => updateItem(item.id, { tags: item.tags.filter((x) => x !== t) })}
        />
      </Section>

      <Section
        title="Folders"
        right={
          <button
            className="icon-btn xs"
            title="Add to folder"
            onClick={() => set({ folderPicker: { mode: 'add', ids: [item.id] } })}
          >
            <FolderPlus size={14} />
          </button>
        }
      >
        <div className="folder-chips">
          {itemFolders.map((f) => (
            <span key={f.id} className="folder-chip" onClick={() => useStore.getState().setView({ kind: 'folder', id: f.id })}>
              <FolderIcon size={12} style={{ color: f.color || undefined }} />
              {f.name}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  updateItem(item.id, { folders: item.folders.filter((x) => x !== f.id) });
                }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {!itemFolders.length && (
            <button className="add-chip" onClick={() => set({ folderPicker: { mode: 'add', ids: [item.id] } })}>
              <FolderPlus size={12} /> Add to folder
            </button>
          )}
        </div>
      </Section>

      <Section title="Source">
        <div className="url-field">
          <input
            value={url}
            placeholder="https://"
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => url !== (item.url || '') && updateItem(item.id, { url })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          {item.url && (
            <a className="icon-btn xs" href={item.url} target="_blank" rel="noreferrer" title={`Open ${hostOf(item.url)}`}>
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </Section>

      <Section title="Information">
        <dl className="info">
          {item.width && item.height ? (
            <>
              <dt>Dimensions</dt>
              <dd>
                {item.width} × {item.height}
              </dd>
            </>
          ) : null}
          {item.duration ? (
            <>
              <dt>Duration</dt>
              <dd>{formatDuration(item.duration)}</dd>
            </>
          ) : null}
          {item.size > 0 && (
            <>
              <dt>Size</dt>
              <dd>{formatBytes(item.size)}</dd>
            </>
          )}
          <dt>Type</dt>
          <dd>
            {item.type === 'bookmark' ? 'Bookmark' : (item.ext || item.type).toUpperCase()}
          </dd>
          <dt>Imported</dt>
          <dd>{formatDate(item.createdAt)}</dd>
          {item.postedAt && (
            <>
              <dt>Posted</dt>
              <dd>{formatDate(item.postedAt)}</dd>
            </>
          )}
          <dt>Source</dt>
          <dd>{{ x: 'X (Twitter)', web: 'Web', upload: 'Upload', arena: 'Are.na' }[item.source]}</dd>
        </dl>
      </Section>

      <div className="insp-actions">
        {trashed ? (
          <>
            <button className="btn" onClick={() => batch('restore', [item.id])}>
              <RotateCcw size={14} /> Restore
            </button>
            <button className="btn danger" onClick={() => useStore.getState().trashSelected()}>
              <Trash2 size={14} /> Delete forever
            </button>
          </>
        ) : (
          <button className="btn ghost-danger" onClick={() => useStore.getState().trashSelected()}>
            <Trash2 size={14} /> Move to Trash
          </button>
        )}
      </div>
    </div>
  );
}

function MultiInspector({ items, ids }: { items: Item[]; ids: string[] }) {
  const { batch, set, toast } = useStore.getState();
  const total = items.reduce((s, i) => s + i.size, 0);
  const common = items.reduce<string[]>(
    (acc, it, idx) => (idx === 0 ? it.tags : acc.filter((t) => it.tags.includes(t))),
    []
  );
  const trashed = items.every((i) => i.deletedAt);
  const stack = items.filter((i) => i.thumbUrl).slice(0, 3);

  return (
    <div className="insp-body">
      <div className="insp-stack">
        {stack.map((it, i) => (
          <img
            key={it.id}
            src={it.thumbUrl!}
            alt=""
            draggable={false}
            style={{ transform: `rotate(${(i - (stack.length - 1) / 2) * 7}deg) translateY(${Math.abs(i - 1) * 4}px)`, zIndex: i === 1 ? 2 : 1 }}
          />
        ))}
        {!stack.length && <Layers size={40} strokeWidth={1.2} />}
      </div>
      <div className="multi-title">{ids.length.toLocaleString()} items selected</div>
      {items.length === ids.length && <div className="multi-sub">{formatBytes(total)}</div>}

      <Section title="Tags in common">
        <TagInput
          value={common}
          placeholder="Add tag to all…"
          onAdd={async (t) => {
            await batch('addTags', ids, { tags: [t] });
            toast(`Tagged ${ids.length} items with #${t}`, 'success');
          }}
          onRemove={(t) => batch('removeTags', ids, { tags: [t] })}
        />
      </Section>

      <div className="insp-actions column">
        <button className="btn" onClick={() => set({ folderPicker: { mode: 'add', ids } })}>
          <FolderPlus size={14} /> Add to folder…
        </button>
        <button className="btn" onClick={() => set({ folderPicker: { mode: 'move', ids } })}>
          <FolderIcon size={14} /> Move to folder…
        </button>
        {trashed ? (
          <>
            <button className="btn" onClick={() => batch('restore', ids)}>
              <RotateCcw size={14} /> Restore all
            </button>
            <button className="btn danger" onClick={() => useStore.getState().trashSelected()}>
              <Trash2 size={14} /> Delete forever
            </button>
          </>
        ) : (
          <button className="btn ghost-danger" onClick={() => useStore.getState().trashSelected()}>
            <Trash2 size={14} /> Move to Trash
          </button>
        )}
      </div>
    </div>
  );
}

function EmptyInspector() {
  const view = useStore((s) => s.view);
  const folders = useStore((s) => s.folders);
  const stats = useStore((s) => s.stats);
  const count = useStore((s) => s.items.length);
  const { updateFolder } = useStore.getState();
  const folder = view.kind === 'folder' ? folders.find((f) => f.id === view.id) : null;
  const [name, setName] = useState(folder?.name || '');
  useEffect(() => setName(folder?.name || ''), [folder?.name]);

  if (folder) {
    return (
      <div className="insp-body">
        <div className="folder-hero" style={{ ['--fc' as string]: folder.color || 'var(--accent)' }}>
          {folder.cover ? <img src={folder.cover} alt="" /> : <FolderIcon size={44} strokeWidth={1.2} />}
        </div>
        <input
          className="insp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== folder.name && updateFolder(folder.id, { name: name.trim() })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <div className="multi-sub">{count} items</div>
        <Section title="Colour">
          <div className="color-dots">
            <button
              className={cls('dot none', !folder.color && 'on')}
              onClick={() => updateFolder(folder.id, { color: null })}
              title="Default"
            />
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                className={cls('dot', folder.color === c && 'on')}
                style={{ background: c }}
                onClick={() => updateFolder(folder.id, { color: c })}
              />
            ))}
          </div>
        </Section>
        <Section title="Information">
          <dl className="info">
            <dt>Created</dt>
            <dd>{formatDate(folder.createdAt)}</dd>
            <dt>Subfolders</dt>
            <dd>{folders.filter((f) => f.parentId === folder.id).length}</dd>
          </dl>
        </Section>
      </div>
    );
  }

  return (
    <div className="insp-body insp-empty">
      <div className="stat-grid">
        <div>
          <b>{stats.all.toLocaleString()}</b>
          <span>Items</span>
        </div>
        <div>
          <b>{folders.length}</b>
          <span>Folders</span>
        </div>
        <div>
          <b>{formatBytes(stats.totalSize)}</b>
          <span>On disk</span>
        </div>
        <div>
          <b>{stats.uncategorized}</b>
          <span>Unsorted</span>
        </div>
      </div>
      <div className="shortcuts">
        <div className="insp-title">
          <span>Shortcuts</span>
        </div>
        {[
          ['Space', 'Preview'],
          ['⌘A', 'Select all'],
          ['⌫', 'Move to trash'],
          ['⌘V', 'Paste links or images'],
          ['/', 'Search'],
          ['⌥ + drop', 'Move instead of add'],
          ['⌘ + / −', 'Zoom thumbnails'],
        ].map(([k, l]) => (
          <div key={k} className="shortcut">
            <span>{l}</span>
            <kbd className="kbd">{k}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
