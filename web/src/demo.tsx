import { StrictMode, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import App from './App';
import { provideBackend } from './api';
import { createDemoBackend } from './backends/demo';
import { DemoBadge } from './components/DemoBadge';
import { Landing } from './components/Landing';
import { useStore } from './store';
import './demo.css';

/**
 * The demo build's entry: the app on a landing page, with a library kept in the browser instead of on the server.
 * main.tsx imports this module only when VITE_DEMO is 'true', so everything here, styles included, is one chunk
 * that a regular build leaves out.
 */
export async function startDemo(root: Root) {
  const show = (screen: ReactNode) =>
    root.render(
      <StrictMode>
        <Landing>{screen}</Landing>
      </StrictMode>
    );
  // the first visit draws the sample library, which takes a moment
  show(<div className="demo-boot">Preparing the demo library…</div>);
  const { backend, reset } = await createDemoBackend();
  provideBackend(backend, { onUnavailable: (message) => useStore.getState().toast(message, 'demo') });
  show(
    <>
      <App />
      <DemoBadge onReset={reset} />
    </>
  );
}
