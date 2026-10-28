import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.BACKEND_URL || 'http://localhost:8080';

const DESCRIPTION =
  'Abacus is a self-hosted library for your images, GIFs, videos, and saved posts. Try the live demo, which runs ' +
  'entirely in your browser.';
const IMAGE_ALT = 'Abacus, a self-hosted library for your images, GIFs, videos, and saved posts, showing its library view.';

/**
 * The demo build's link previews: description and Open Graph / Twitter tags, plus the preview images in
 * public-demo/ (made by `npm run render:preview`), which only this build ships. Crawlers want absolute image URLs,
 * so set DEMO_URL to where the demo is published (the Pages workflow does); without it they're relative.
 */
function demoSite(): Plugin {
  const dir = fileURLToPath(new URL('./public-demo', import.meta.url));
  const site = (process.env.DEMO_URL || '').replace(/\/+$/, '');
  const url = (file: string) => `${site || '.'}/${file}`;
  const meta = (attrs: Record<string, string>): HtmlTagDescriptor => ({ tag: 'meta', attrs, injectTo: 'head' });
  const images = [
    { file: 'preview/og-1200x630.jpg', width: 1200, height: 630 },
    { file: 'preview/square-1200x1200.jpg', width: 1200, height: 1200 },
  ];

  return {
    name: 'demo-site',
    apply: (_, env) => env.command === 'build' && env.mode === 'demo',
    transformIndexHtml: () => [
      meta({ name: 'description', content: DESCRIPTION }),
      meta({ property: 'og:type', content: 'website' }),
      meta({ property: 'og:site_name', content: 'Abacus' }),
      meta({ property: 'og:title', content: 'Abacus' }),
      meta({ property: 'og:description', content: DESCRIPTION }),
      ...(site ? [meta({ property: 'og:url', content: `${site}/` })] : []),
      // the wide image first: most sites use the first one, and a few pick the square one for small cards
      ...images.flatMap((i) => [
        meta({ property: 'og:image', content: url(i.file) }),
        meta({ property: 'og:image:type', content: 'image/jpeg' }),
        meta({ property: 'og:image:width', content: String(i.width) }),
        meta({ property: 'og:image:height', content: String(i.height) }),
        meta({ property: 'og:image:alt', content: IMAGE_ALT }),
      ]),
      meta({ name: 'twitter:card', content: 'summary_large_image' }),
      meta({ name: 'twitter:title', content: 'Abacus' }),
      meta({ name: 'twitter:description', content: DESCRIPTION }),
      meta({ name: 'twitter:image', content: url(images[0].file) }),
      meta({ name: 'twitter:image:alt', content: IMAGE_ALT }),
    ],
    generateBundle() {
      for (const file of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
        const full = path.join(dir, file);
        if (fs.statSync(full).isFile()) {
          this.emitFile({ type: 'asset', fileName: file.split(path.sep).join('/'), source: fs.readFileSync(full) });
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  // the demo is a static site that may be served from a subpath, such as GitHub Pages' /<repo>/
  base: mode === 'demo' ? './' : '/',
  plugins: [react(), demoSite()],
  server: {
    // Tailscale serve proxies to 127.0.0.1, which is not the same socket as ::1.
    host: '127.0.0.1',
    port: 5173,
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': backend,
      '/files': backend,
      '/thumbs': backend,
      '/quick-add': backend,
    },
  },
}));
