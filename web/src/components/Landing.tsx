import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { cls, Logo } from './ui';

/**
 * The demo's landing page: the name and slogan fill the screen, with the app peeking in below. Scrolling down
 * brings the app up and zooms it in until it fills the screen inside a margin. Until then it's a preview and
 * clicking it scrolls there.
 *
 * Scrolling sets `--e` (0 → 1) on the page, and the frame's transform is computed from it in CSS. Once the app
 * fills the screen the transform is dropped, since a transformed ancestor would shift the app's fixed-position
 * menus away from the pointer.
 */
export function Landing({ children }: { children: ReactNode }) {
  const page = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('landing-page');
    let frame = 0;
    const update = () => {
      frame = 0;
      const travel = html.scrollHeight - window.innerHeight;
      const p = travel > 0 ? Math.min(1, Math.max(0, window.scrollY / travel)) : 1;
      page.current?.style.setProperty('--e', String(p * p * (3 - 2 * p)));
      setLive(p >= 0.999);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      html.classList.remove('landing-page');
    };
  }, []);

  const enter = () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });

  return (
    <div className="landing" ref={page}>
      <header className="landing-hero">
        <Logo size={84} />
        <h1>Abacus</h1>
        <p>Abacus is a self-hosted digital asset management (DAM) system for images, GIFs, videos, and saved posts. It runs as a web app with a Node.js backend and a SQLite database, and ships as a single Docker image.</p>
        <div className="landing-actions">
          <a
            className="landing-cta primary"
            href="https://github.com/ferraridavide/abacus"
            target="_blank"
            rel="noreferrer"
            tabIndex={live ? -1 : 0}
          >
            Get started <ArrowUpRight size={14} />
          </a>
          <button className="landing-cta" onClick={enter} tabIndex={live ? -1 : 0}>
            Try the live demo <ChevronDown size={14} className="landing-nudge" />
          </button>
        </div>
      </header>

      {/* a snap point at each end, so the page settles on the hero or on the app */}
      <div className="landing-track">
        <div className="landing-snap" />
        <div className="landing-snap end" />
      </div>

      <div
        className={cls('landing-frame', live && 'live')}
        onClick={live ? undefined : enter}
        aria-label={live ? undefined : 'Open the demo'}
      >
        <div className="landing-screen" inert={!live}>
          {children}
        </div>
      </div>
    </div>
  );
}
