import { useEffect, useState } from 'react';
import { CircleAlert, ImagePlay, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import type { ThumbnailSettings as Settings } from '../types';
import { useJxlSupport } from './Thumb';
import { cls } from './ui';

/** The progressive JPEG XL thumbnail switch, and how far the conversion has got. */
export function ThumbnailSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const jxl = useJxlSupport();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.thumbnailSettings();
        if (!alive) return;
        setSettings(next);
        if (next.state === 'running') timer = setTimeout(poll, 1500);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // polled again after a toggle, which starts a conversion
  }, [settings?.jxl, settings?.previews]);

  if (error) return <div className="provider-status error">{error}</div>;
  if (!settings) return <Loader2 size={16} className="spin dim" />;

  const apply = async (patch: { jxl?: boolean; previews?: boolean }) => {
    setBusy(true);
    try {
      setSettings(await api.updateThumbnails(patch));
      // items in the grid and viewer carry their image URLs, so they're fetched again
      void useStore.getState().refresh();
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
    }
    setBusy(false);
  };

  const togglePreviews = async () => {
    const on = !settings.previews;
    const ok = await useStore.getState().ask(
      on
        ? {
            title: 'Make full-screen previews?',
            message:
              'Every image bigger than its thumbnail gets a screen-sized progressive JPEG XL preview, computed in the background from its original. The thumbnails are kept as they are.',
            confirmLabel: 'Turn on',
          }
        : {
            title: 'Turn off full-screen previews?',
            message:
              'The previews are deleted and the full-screen viewer goes from the thumbnail straight to the original. Turning this on again computes them all again.',
            confirmLabel: 'Turn off',
          }
    );
    if (ok) await apply({ previews: on });
  };

  const toggle = async () => {
    const on = !settings.jxl;
    const ok = await useStore.getState().ask(
      on
        ? {
            title: 'Recompute every thumbnail?',
            message:
              'Each thumbnail is computed again as a progressive JPEG XL image, in the background. On a large library this takes a while and keeps the server busy; until an item’s is ready, it shows the current one.',
            confirmLabel: 'Turn on',
          }
        : {
            title: 'Turn off JPEG XL thumbnails?',
            message:
              'The JPEG XL thumbnails are deleted and the grid goes back to the webp ones. Turning this on again recomputes every thumbnail.',
            confirmLabel: 'Turn off',
          }
    );
    if (ok) await apply({ jxl: on });
  };

  const pct = settings.total ? Math.round((settings.processed / settings.total) * 100) : 100;

  return (
    <div className="semantic">
      <div className={cls('semantic-hero', settings.jxl && 'on')}>
        <span className="semantic-icon">
          <ImagePlay size={18} />
        </span>
        <div className="semantic-intro">
          <div className="semantic-title">Progressive JPEG XL thumbnails</div>
          <p>
            Thumbnails start as a coarse preview while they download and sharpen as the rest arrives. Large grid tiles
            and the full-screen viewer then load the original. Downloads are always the original file.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.jxl}
          className={cls('switch', settings.jxl && 'on')}
          title={settings.jxl ? 'Turn off' : 'Turn on'}
          disabled={busy}
          onClick={toggle}
        />
      </div>

      {settings.jxl && (
        <div className="thumb-option">
          <div className="thumb-option-text">
            <div className="thumb-option-title">Full-screen previews in JPEG XL</div>
            <p>
              On: opening an image full screen shows a progressive JPEG XL preview sized for the screen (up to 2560
              pixels, never bigger than the original) that sharpens while the original downloads. Uses extra disk
              space, about a third to two thirds of each original.
            </p>
            <p>
              Off: JPEG XL is only used for the thumbnails in the grid. Full screen goes from the small thumbnail
              straight to the original.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.previews}
            aria-label="Full-screen previews in JPEG XL"
            className={cls('switch', settings.previews && 'on')}
            title={settings.previews ? 'Turn off' : 'Turn on'}
            disabled={busy}
            onClick={togglePreviews}
          />
        </div>
      )}

      {jxl === false && (
        <div className="semantic-note">
          This browser can’t show JPEG XL images, so it keeps showing the webp thumbnails. The originals still load
          over them.
        </div>
      )}

      {settings.jxl && (
        <div className={cls('semantic-status', settings.state)}>
          <div className="semantic-status-head">
            <span className={cls('state-pill', settings.state)}>
              {settings.state === 'running' ? <Loader2 size={12} className="spin" /> : <span className="state-dot" />}
              {settings.state === 'running' ? 'Converting' : 'Up to date'}
            </span>
          </div>
          <div className="semantic-count">
            <b>{settings.processed.toLocaleString()}</b>
            <span>
              of {settings.total.toLocaleString()} item{settings.total === 1 ? '' : 's'} converted
            </span>
            <span className="semantic-pct">{pct}%</span>
          </div>
          <div className="semantic-bar">
            <div style={{ width: `${pct}%` }} />
          </div>
          {settings.failed > 0 && (
            <div className="semantic-chips">
              <span className="chip danger" title={settings.lastFailure || undefined}>
                <CircleAlert size={12} /> {settings.failed.toLocaleString()} kept as webp
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
