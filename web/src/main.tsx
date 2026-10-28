import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { provideBackend } from './api';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

// VITE_DEMO is replaced at build time, so each build keeps only its own branch. The demo build (VITE_DEMO=true)
// keeps the library in the browser and shows the app on a landing page, without the server client; a regular build
// talks to the server, without the demo.
if (import.meta.env.VITE_DEMO === 'true') {
  import('./demo').then(({ startDemo }) => startDemo(root));
} else {
  import('./backends/http').then(({ httpBackend }) => {
    provideBackend(httpBackend);
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  });
}
