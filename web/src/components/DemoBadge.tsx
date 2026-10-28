import { FlaskConical } from 'lucide-react';
import { useStore } from '../store';

/** Always on screen in the demo build. Clicking it explains the demo and offers to start over. */
export function DemoBadge({ onReset }: { onReset: () => Promise<void> }) {
  const reset = async () => {
    const ok = await useStore.getState().ask({
      title: 'This is a demo',
      message:
        'Your library is kept in this browser only, and nothing is sent to a server. Importing links, Are.na ' +
        'exports, import providers and semantic search need the Abacus server. Starting over deletes everything ' +
        'you added here and brings back the sample library.',
      confirmLabel: 'Start over',
      danger: true,
    });
    if (!ok) return;
    await onReset();
    location.reload();
  };

  return (
    <button className="demo-badge" onClick={reset} title="Demo mode: your library is kept in this browser">
      <FlaskConical size={13} />
      Demo
    </button>
  );
}
