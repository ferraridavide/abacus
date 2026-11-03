import { useRef, useState, type ReactNode } from 'react';
import {
  CloudDownload, HardDrive, Image as ImageIcon, KeyRound, MousePointer2, Palette, PauseCircle, PlayCircle, Play, Plus, Sparkles,
} from 'lucide-react';
import { useStore } from '../store';
import type { AutoplayMode } from '../types';
import { SemanticSearchSettings } from './SemanticSearchSettings';
import { ThumbnailSettings } from './ThumbnailSettings';
import { StorageSettings } from './StorageSettings';
import { ImportSourcesSettings, ProviderDetail, useProviderSettings } from './ProviderSettings';
import { IntegrationSettings } from './IntegrationSettings';
import { cls, DialogHead, Modal, PageLink, usePhone } from './ui';

type Section = 'playback' | 'appearance' | 'thumbnails' | 'storage' | 'sources' | 'search' | 'integration';

const SECTIONS: { key: Section; label: string; desc: string; icon: ReactNode }[] = [
  { key: 'playback', label: 'Playback', desc: 'Autoplay of videos and GIFs', icon: <Play size={15} /> },
  { key: 'appearance', label: 'Appearance', desc: 'Theme, accent and corners', icon: <Palette size={15} /> },
  { key: 'thumbnails', label: 'Thumbnails', desc: 'Progressive JPEG XL previews', icon: <ImageIcon size={15} /> },
  { key: 'storage', label: 'Storage', desc: 'Disk space used by the library', icon: <HardDrive size={15} /> },
  { key: 'sources', label: 'Import sources', desc: 'Providers that download media', icon: <CloudDownload size={15} /> },
  { key: 'search', label: 'Semantic search', desc: 'Find anything by what it is about', icon: <Sparkles size={15} /> },
  { key: 'integration', label: 'Integration', desc: 'API keys and documentation', icon: <KeyRound size={15} /> },
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
  const section = picked ?? (phone ? null : 'playback');
  const providers = useProviderSettings(section === 'sources');
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
          <Version />
        </nav>
      )}
      <div className="settings-main">
        <DialogHead title={title} onBack={back} onClose={close} />
        <div className="settings-body page-enter" key={`${section}/${provider?.id ?? ''}`}>
          {!section && (
            <>
              <div className="page-links">
                {SECTIONS.map((s) => (
                  <PageLink key={s.key} icon={s.icon} label={s.label} desc={s.desc} onClick={() => open(s.key)} />
                ))}
              </div>
              <Version />
            </>
          )}
          {section === 'playback' && <PlaybackSettings />}
          {section === 'appearance' && <AppearanceSettings />}
          {section === 'thumbnails' && <ThumbnailSettings />}
          {section === 'storage' && <StorageSettings />}
          {section === 'search' && <SemanticSearchSettings />}
          {section === 'integration' && <IntegrationSettings />}
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

function Version() {
  return (
    <div className="settings-version" title="Running commit">
      {__APP_SHA__}
    </div>
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

const SCHEMES: { key: 'light' | 'dark' | 'system'; label: string }[] = [
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
  { key: 'system', label: 'System' },
];

/** Mirrors `effectiveScheme` in lib/theme: which preview to draw for a theme card. */
function previewScheme(scheme: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (scheme !== 'system') return scheme;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The theme is stored on the server, so the browser extension can match the app it saves to. */
function AppearanceSettings() {
  const appearance = useStore((s) => s.appearance);
  const setAppearance = useStore((s) => s.setAppearance);
  const previewAppearance = useStore((s) => s.previewAppearance);
  const custom = appearance.accent.id === 'custom';
  const mode = previewScheme(appearance.scheme);
  // the colour well fires on every pixel of a drag: paint each one, save once it settles
  const pickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pickAccent = (hex: string) => {
    previewAppearance({ accent: hex });
    clearTimeout(pickTimer.current);
    pickTimer.current = setTimeout(() => setAppearance({ accent: hex }), 200);
  };

  return (
    <div className="appearance">
      <div className="appearance-block">
        <div className="appearance-label">Base color scheme</div>
        <div className="segmented block" role="radiogroup" aria-label="Base color scheme">
          {SCHEMES.map((s) => (
            <button
              key={s.key}
              role="radio"
              aria-checked={appearance.scheme === s.key}
              className={cls(appearance.scheme === s.key && 'on')}
              onClick={() => setAppearance({ scheme: s.key })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-block">
        <div className="appearance-label">Themes</div>
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {appearance.themes.map((theme) => {
            const preview = theme.preview[mode];
            return (
              <button
                key={theme.id}
                role="radio"
                aria-checked={appearance.theme === theme.id}
                className={cls('theme-card', appearance.theme === theme.id && 'on')}
                onClick={() => setAppearance({ theme: theme.id })}
              >
                <span className="theme-preview" style={{ background: preview.bg }}>
                  <span className="theme-preview-panel" style={{ background: preview.panel }} />
                  <span className="theme-preview-line" style={{ background: preview.text }} />
                  <span className="theme-preview-line short" style={{ background: preview.text }} />
                </span>
                <span className="theme-card-label">{theme.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="appearance-block">
        <div className="appearance-label">Accent color</div>
        <div className="accent-row" role="radiogroup" aria-label="Accent color">
          {appearance.presets.map((preset) => (
            <button
              key={preset.id}
              role="radio"
              aria-checked={!custom && appearance.accent.hex === preset.hex}
              className={cls('accent-dot', !custom && appearance.accent.hex === preset.hex && 'on')}
              style={{ background: preset.hex }}
              title={preset.label}
              aria-label={preset.label}
              onClick={() => setAppearance({ accent: preset.hex })}
            />
          ))}
          <label className={cls('accent-dot custom', custom && 'on')} title="Custom accent">
            <input
              type="color"
              className="accent-input"
              value={appearance.accent.hex}
              onChange={(e) => pickAccent(e.target.value)}
              aria-label="Custom accent color"
            />
            <Plus size={12} aria-hidden />
          </label>
        </div>
      </div>

      <div className="appearance-block">
        <div className="appearance-label">Corners</div>
        <div className="segmented block" role="radiogroup" aria-label="Corners">
          <button
            role="radio"
            aria-checked={appearance.corners === 'squared'}
            className={cls(appearance.corners === 'squared' && 'on')}
            onClick={() => setAppearance({ corners: 'squared' })}
          >
            Squared
          </button>
          <button
            role="radio"
            aria-checked={appearance.corners === 'rounded'}
            className={cls(appearance.corners === 'rounded' && 'on')}
            onClick={() => setAppearance({ corners: 'rounded' })}
          >
            Rounded
          </button>
        </div>
      </div>

      <div className="setting-row">
        <span className="setting-row-label">OLED mode</span>
        <button
          role="switch"
          aria-checked={appearance.oled}
          aria-label="OLED mode"
          className={cls('switch', appearance.oled && 'on')}
          disabled={mode === 'light'}
          onClick={() => setAppearance({ oled: !appearance.oled })}
        />
      </div>
    </div>
  );
}
