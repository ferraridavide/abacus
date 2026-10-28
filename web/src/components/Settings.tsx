import { useState, type ReactNode } from 'react';
import { CloudDownload, MousePointer2, PauseCircle, PlayCircle, Play, Sparkles } from 'lucide-react';
import { useStore } from '../store';
import type { AutoplayMode } from '../types';
import { SemanticSearchSettings } from './SemanticSearchSettings';
import { ImportSourcesSettings, ProviderDetail, useProviderSettings } from './ProviderSettings';
import { cls, DialogHead, Modal, PageLink, usePhone } from './ui';

type Section = 'playback' | 'sources' | 'search';

const SECTIONS: { key: Section; label: string; desc: string; icon: ReactNode }[] = [
  { key: 'playback', label: 'Playback', desc: 'Autoplay of videos and GIFs', icon: <Play size={15} /> },
  { key: 'sources', label: 'Import sources', desc: 'Providers that download media', icon: <CloudDownload size={15} /> },
  { key: 'search', label: 'Semantic search', desc: 'Find anything by what it is about', icon: <Sparkles size={15} /> },
];

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  if (!open) return null;
  return <SettingsInner />;
}

/**
 * Settings are pages: sections, then a provider inside "Import sources". Wider screens keep the
 * section list beside the page; phones show one page at a time, starting from the section list.
 */
function SettingsInner() {
  const set = useStore((s) => s.set);
  const phone = usePhone();
  const [picked, setPicked] = useState<Section | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const providers = useProviderSettings();
  const section = picked ?? (phone ? null : 'playback');
  const provider = section === 'sources' ? providers.list?.find((p) => p.id === providerId) : undefined;
  const close = () => set({ settingsOpen: false });
  const open = (key: Section) => {
    setPicked(key);
    setProviderId(null);
  };

  const title = provider?.name ?? SECTIONS.find((s) => s.key === section)?.label ?? 'Settings';
  const back = provider ? () => setProviderId(null) : phone && section ? () => setPicked(null) : undefined;

  return (
    <Modal onClose={close} className="settings-modal page">
      {!phone && (
        <nav className="settings-nav">
          <div className="settings-heading">Settings</div>
          {SECTIONS.map((s) => (
            <button key={s.key} className={cls('nav-row', section === s.key && 'active')} onClick={() => open(s.key)}>
              <span className="nav-icon">{s.icon}</span>
              <span className="nav-label">{s.label}</span>
            </button>
          ))}
        </nav>
      )}
      <div className="settings-main">
        <DialogHead title={title} onBack={back} onClose={close} />
        <div className="settings-body page-enter" key={`${section}/${provider?.id ?? ''}`}>
          {!section && (
            <div className="page-links">
              {SECTIONS.map((s) => (
                <PageLink key={s.key} icon={s.icon} label={s.label} desc={s.desc} onClick={() => open(s.key)} />
              ))}
            </div>
          )}
          {section === 'playback' && <PlaybackSettings />}
          {section === 'search' && <SemanticSearchSettings />}
          {section === 'sources' &&
            (provider ? (
              <ProviderDetail provider={provider} onSaved={providers.update} />
            ) : (
              <ImportSourcesSettings providers={providers.list} error={providers.error} onOpen={setProviderId} />
            ))}
        </div>
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
