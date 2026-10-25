import { CheckCheck, FolderPlus, Info, RotateCcw, Trash2, X } from 'lucide-react';
import { useStore } from '../store';

/** On narrow screens the inspector is hidden: this bar holds the selection's actions and opens its details. */
export function SelectionBar() {
  const selected = useStore((s) => s.selected);
  const total = useStore((s) => s.total);
  const trash = useStore((s) => s.view.kind === 'trash');
  const { set, clearSelection, selectAll, batch, trashSelected } = useStore.getState();
  const ids = [...selected];

  return (
    <div className="selection-bar">
      <button className="icon-btn" title="Clear selection" onClick={clearSelection}>
        <X size={18} />
      </button>
      <span className="selection-count">{ids.length.toLocaleString()} selected</span>
      {ids.length < total && (
        <button className="icon-btn" title="Select all" onClick={selectAll}>
          <CheckCheck size={18} />
        </button>
      )}
      <button className="icon-btn" title="Details" onClick={() => set({ details: 'selection' })}>
        <Info size={18} />
      </button>
      {trash ? (
        <button className="icon-btn" title="Restore" onClick={() => batch('restore', ids)}>
          <RotateCcw size={18} />
        </button>
      ) : (
        <button className="icon-btn" title="Add to folder" onClick={() => set({ folderPicker: { mode: 'add', ids } })}>
          <FolderPlus size={18} />
        </button>
      )}
      <button className="icon-btn danger" title={trash ? 'Delete forever' : 'Move to Trash'} onClick={trashSelected}>
        <Trash2 size={18} />
      </button>
    </div>
  );
}
