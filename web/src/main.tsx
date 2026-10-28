import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { provideBackend } from './api';
import { DemoBadge } from './components/DemoBadge';
import { useStore } from './store';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
const render = (extra?: ReactNode) =>
  root.render(
    <StrictMode>
      <App />
      {extra}
    </StrictMode>
  );

// The demo build (VITE_DEMO=true) keeps the library in the browser instead of talking to the server. Each backend is
// its own chunk, so a regular build doesn't ship the demo, and the demo doesn't ship the server client.
if (import.meta.env.VITE_DEMO === 'true') {
  // the first visit draws the sample library, which takes a moment
  root.render(<div className="demo-boot">Preparing the demo library…</div>);
  import('./backends/demo').then(async ({ createDemoBackend }) => {
    const { backend, reset } = await createDemoBackend();
    provideBackend(backend, { onUnavailable: (message) => useStore.getState().toast(message, 'demo') });
    render(<DemoBadge onReset={reset} />);
  });
} else {
  import('./backends/http').then(({ httpBackend }) => {
    provideBackend(httpBackend);
    render();
  });
}
