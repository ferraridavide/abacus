import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const SERVER_DIR = path.resolve(import.meta.dirname, '..');

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(url, timeout = 20000, describeLog = () => '') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}\n${describeLog()}`);
}

/** Start a throwaway Abacus server on a free local port. */
export async function startAbacus(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abacus-test-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let log = '';

  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      WEB_DIST: path.join(dataDir, 'web-dist'),
      AUTH_USER: 'abacus',
      AUTH_PASSWORD: 'secret',
      API_TOKEN: 'test-token',
      LOG_LEVEL: 'silent',
      IMPORT_CONCURRENCY: '2',
      COBALT_URL: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => (log += chunk));
  server.stderr.on('data', (chunk) => (log += chunk));

  try {
    await waitFor(baseUrl + '/api/health', 20000, () => log);
  } catch (err) {
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }

  /**
   * Call the API. `as` picks the credentials: 'token' (the API token, default), 'basic' (the web login), or 'none'.
   * A FormData body is sent as multipart. Resolves to { status, data }.
   */
  async function call(method, pathname, body, { as = 'token', headers = {} } = {}) {
    const auth = {
      token: { authorization: 'Bearer test-token' },
      basic: { authorization: 'Basic ' + Buffer.from('abacus:secret').toString('base64') },
      none: {},
    }[as];
    const isForm = body instanceof FormData;
    const res = await fetch(baseUrl + pathname, {
      method,
      headers: { ...auth, ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  }

  /** Poll a job (with the web login) until it's done. */
  async function waitForJob(id) {
    for (let i = 0; i < 200; i++) {
      const { data } = await call('GET', '/api/jobs/' + id, undefined, { as: 'basic' });
      if (data.status === 'done') return data;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('job did not finish');
  }

  return {
    baseUrl,
    dataDir,
    server,
    call,
    waitForJob,
    item: async (id) => (await call('GET', '/api/items/' + id, undefined, { as: 'basic' })).data,
    folders: async () => (await call('GET', '/api/folders', undefined, { as: 'basic' })).data,
    get log() {
      return log;
    },
    async stop() {
      server.kill('SIGTERM');
      await new Promise((resolve) => {
        if (server.exitCode !== null) return resolve();
        server.once('exit', resolve);
        setTimeout(resolve, 3000);
      });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Tiny local site used as the source of imports. Every path is a fresh URL, so tests don't collide on
 * de-duplication:
 *   /pic/<anything>   a PNG image
 *   /page/<title>     an HTML page titled <title> (decoded), with the PNG as its preview image
 *   anything else     404
 */
export async function startFixture() {
  const fixture = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname.startsWith('/pic/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      return res.end(PNG);
    }
    if (url.pathname.startsWith('/page/')) {
      const title = decodeURIComponent(url.pathname.slice('/page/'.length)).replace(/[<>&"]/g, '');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(
        `<!doctype html><title>${title}</title><meta property="og:title" content="${title}">` +
          `<meta property="og:image" content="/pic${url.pathname}.png"><meta property="og:description" content="About ${title}">`
      );
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fixture.address().port}`;
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        fixture.close(resolve);
      }),
  };
}
