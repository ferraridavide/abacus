// Renders the demo's link preview images: npm run render:preview
//
// Builds the demo, opens it in headless Chrome and captures the app with an item selected, then renders
// template.html around that capture at each size below and saves them as JPEGs in public-demo/preview/, which
// only the demo build ships. Uses Chrome's DevTools Protocol directly, so it needs nothing but Node 22+ and Chrome
// (set CHROME to its path if it isn't found).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMATS = [
  { name: 'landscape', file: 'og-1200x630.jpg', width: 1200, height: 630 },
  { name: 'square', file: 'square-1200x1200.jpg', width: 1200, height: 1200 },
  { name: 'portrait', file: 'portrait-1080x1350.jpg', width: 1080, height: 1350 },
];
/** the app's size in the capture, in CSS pixels; it's captured at twice that */
const APP = { width: 1440, height: 900 };
/** the item shown in the inspector */
const SELECTED = 'Coral reef';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const out = path.join(web, 'public-demo', 'preview');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abacus-preview-'));

const CHROME_PATHS = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium',
  'chromium-browser',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the demo build and a server for it ----------

function buildDemo(dir) {
  const res = spawnSync('npx', ['vite', 'build', '--mode', 'demo', '--outDir', dir, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: web,
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('The demo build failed');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

/** Serves the demo build at /demo/ and this folder at /preview/. */
function serve(demoDir) {
  const roots = { demo: demoDir, preview: here };
  const server = http.createServer((req, res) => {
    const [, root, ...rest] = decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/');
    const base = roots[root];
    let file = base && path.join(base, ...rest);
    if (file && !file.startsWith(base)) file = null;
    if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- Chrome ----------

async function launchChrome() {
  for (const bin of CHROME_PATHS) {
    const chrome = spawn(
      bin,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${path.join(tmp, 'profile')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--force-color-profile=srgb',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    const url = await new Promise((resolve) => {
      let log = '';
      chrome.on('error', () => resolve(null));
      chrome.stderr.on('data', (d) => {
        log += d;
        const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      chrome.on('exit', () => resolve(null));
    });
    if (url) return { chrome, url };
  }
  throw new Error('Chrome not found; set CHROME to its path');
}

/** A minimal DevTools Protocol client over one page. */
async function openPage(browserUrl) {
  const ws = new WebSocket(browserUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => call(method, params, sessionId);
  // a background page gets no animation frames, which the landing page's scroll handling waits for
  await send('Page.bringToFront');

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const waitFor = async (expression, what, timeout = 30000) => {
    for (const start = Date.now(); Date.now() - start < timeout; await sleep(150)) {
      if (await evaluate(`!!(${expression})`).catch(() => false)) return;
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  return {
    send,
    evaluate,
    waitFor,
    viewport: (width, height, deviceScaleFactor) =>
      send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false }),
    goto: async (url) => {
      await send('Page.navigate', { url });
      await waitFor("document.readyState === 'complete'", url);
    },
    close: () => ws.close(),
  };
}

// ---------- rendering ----------

async function captureApp(page, origin) {
  const enter = async () => {
    await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
    await page.waitFor("document.querySelector('.landing-frame.live')", 'the app to fill the screen');
  };
  await page.viewport(APP.width, APP.height, 2);
  await page.goto(`${origin}/demo/`);
  // the first visit draws the sample library
  await page.waitFor("document.querySelectorAll('[data-id]').length >= 12", 'the sample library');
  await enter();
  // the landing frame keeps a margin and a border around the app; grow the window so the app itself is APP
  const inset = await page.evaluate("document.querySelector('.landing-screen').getBoundingClientRect().left");
  await page.viewport(APP.width + inset * 2, APP.height + inset * 2, 2);
  await enter();

  await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('[data-id]')].find((c) => c.textContent.includes(${JSON.stringify(SELECTED)}));
    card?.click();
    document.querySelector('.demo-badge')?.remove();
  })()`);
  await page.waitFor(
    "[...document.images].every((i) => i.complete) && !document.querySelector('.toast')",
    'the thumbnails'
  );
  await sleep(600); // let the selection and fade-ins settle

  // the clip is in page coordinates, so the scroll offset counts
  const clip = await page.evaluate(
    "(() => { const r = document.querySelector('.landing-screen').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, scale: 1 }; })()"
  );
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip });
  return `data:image/png;base64,${data}`;
}

async function renderFormat(page, origin, app, format) {
  await page.viewport(format.width, format.height, 1);
  await page.goto(`${origin}/preview/template.html?format=${format.name}`);
  await page.evaluate(`window.render(${JSON.stringify(app)})`);
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.writeFileSync(path.join(out, format.file), Buffer.from(data, 'base64'));
  console.log(`  ${path.relative(web, path.join(out, format.file))}`);
}

let chrome;
let server;
try {
  console.log('Building the demo…');
  buildDemo(path.join(tmp, 'demo'));
  server = await serve(path.join(tmp, 'demo'));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const launched = await launchChrome();
  chrome = launched.chrome;
  const page = await openPage(launched.url);

  console.log('Capturing the app…');
  const app = await captureApp(page, origin);
  console.log('Rendering:');
  fs.mkdirSync(out, { recursive: true });
  for (const format of FORMATS) await renderFormat(page, origin, app, format);
  page.close();
} finally {
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await exited;
  }
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
