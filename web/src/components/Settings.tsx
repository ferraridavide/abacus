import { useState, type ReactNode } from 'react';
import { MousePointer2, PauseCircle, PlayCircle, Play, X } from 'lucide-react';
import { useStore } from '../store';
import type { AutoplayMode } from '../types';
import { cls, Modal } from './ui';

type Section = 'playback';

const SECTIONS: { key: Section; label: string; icon: ReactNode }[] = [
  { key: 'playback', label: 'Playback', icon: <Play size={15} /> },
];

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  if (!open) return null;
  return <SettingsInner />;
}

function SettingsInner() {
  const set = useStore((s) => s.set);
  const [section, setSection] = useState<Section>('playback');
  const close = () => set({ settingsOpen: false });

  return (
    <Modal onClose={close} className="settings-modal">
      <nav className="settings-nav">
        <div className="settings-heading">Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.key} className={cls('nav-row', section === s.key && 'active')} onClick={() => setSection(s.key)}>
            <span className="nav-icon">{s.icon}</span>
            <span className="nav-label">{s.label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-main">
        <div className="modal-head">
          <h2>{SECTIONS.find((s) => s.key === section)?.label}</h2>
          <button className="icon-btn" onClick={close} title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
        <div className="settings-body">{section === 'playback' && <PlaybackSettings />}</div>
      </div>
    </Modal>
  );
}

const AUTOPLAY: { key: AutoplayMode; label: string; desc: string; icon: ReactNode }[] = [
  { key: 'never', label: 'Never', desc: 'Show the still thumbnail. Open an item to play it.', icon: <PauseCircle size={20} /> },
  { key: 'hover', label: 'While hovering', desc: 'Play a muted preview when the pointer rests on an item.', icon: <MousePointer2 size={20} /> },
  { key: 'always', label: 'Always', desc: 'Loop every video and GIF that is on screen. Uses more bandwidth and CPU.', icon: <PlayCircle size={20} /> },
];

function PlaybackSettings() {
  const autoplay = useStore((s) => s.autoplay);
  const set = useStore((s) => s.set);
  return (
    <div className="setting">
      <div className="setting-label">Autoplay videos & GIFs in the grid</div>
      <div className="setting-hint">Previews are always muted. The full-screen viewer always plays.</div>
      <div className="choice-list" role="radiogroup">
        {AUTOPLAY.map((o) => (
          <button
            key={o.key}
            role="radio"
            aria-checked={autoplay === o.key}
            className={cls('choice', autoplay === o.key && 'on')}
            onClick={() => set({ autoplay: o.key })}
          >
            <span className="choice-icon">{o.icon}</span>
            <span className="choice-text">
              <span className="choice-title">{o.label}</span>
              <span className="choice-desc">{o.desc}</span>
            </span>
            <span className="radio" />
          </button>
        ))}
      </div>
    </div>
  );
}
