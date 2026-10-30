import crypto from 'node:crypto';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyCompress from '@fastify/compress';
import { config, paths } from './config.js';
import { routes } from './routes.js';
import { kickEmbeddings } from './embeddings.js';
import { backfillColorHistograms } from './library.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 10 * 1024 * 1024 });

const basicHeader = config.authPassword
  ? 'Basic ' + Buffer.from(`${config.authUser}:${config.authPassword}`).toString('base64')
  : null;

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// The API token is for clients that add content (extension, scripts). It can add items, follow the
// import job, and list folders for a folder picker; everything else (deleting, settings, files) needs the login.
const TOKEN_ROUTES = new Set(['POST /api/add', 'POST /api/v1/add', 'GET /api/jobs/:id', 'GET /api/bootstrap']);

const hasToken = (req) => {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), config.apiToken)) return true;
  return safeEqual(req.headers['x-api-key'], config.apiToken);
};

/** 'basic' for the browser login, 'token' for a valid API token, else null. */
function authKind(req) {
  if (basicHeader && safeEqual(req.headers.authorization, basicHeader)) return 'basic';
  if (config.apiToken && hasToken(req)) return 'token';
  return null;
}

// Browser extensions call the API from a chrome-extension:// (or moz-extension://) origin.
// Allow those origins only: a wildcard would let any website make authenticated add requests.
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  const origin = req.headers.origin || '';
  const extensionOrigin =
    origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://') || origin.startsWith('safari-web-extension://');
  if (!origin || extensionOrigin) {
    reply.header('access-control-allow-origin', origin || '*');
    reply.header('vary', 'origin');
    reply.header('access-control-allow-headers', 'authorization, content-type, x-api-key');
    reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    reply.header('access-control-max-age', '86400');
  }
  if (req.method === 'OPTIONS') return reply.code(204).send();
});

// Optional auth for self-hosting: HTTP basic and/or an API token.
if (basicHeader || config.apiToken) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/api/health') return;
    const kind = authKind(req);
    if (kind === 'basic') return;
    if (kind === 'token') {
      if (TOKEN_ROUTES.has(`${req.method} ${req.routeOptions?.url}`)) return;
      return reply.code(403).send({ error: 'The API token can only add content; sign in for this' });
    }
    // Only challenge browsers that didn't try a token, and only when basic auth exists.
    if (basicHeader && !req.headers.authorization?.startsWith('Bearer ') && !req.headers['x-api-key']) {
      reply.header('www-authenticate', 'Basic realm="Abacus"');
    }
    reply.code(401).send({ error: 'Authentication required' });
  });
}

// gzip/brotli for JSON and the JS/CSS bundle (images & video are already compressed and skipped)
await app.register(fastifyCompress, { threshold: 1024 });

await app.register(fastifyMultipart, { limits: { fileSize: config.maxDownloadBytes, files: 2 } });

await app.register(fastifyStatic, {
  root: paths.files,
  prefix: '/files/',
  maxAge: '30d',
  immutable: true,
});
await app.register(fastifyStatic, {
  root: paths.thumbs,
  prefix: '/thumbs/',
  decorateReply: false,
  maxAge: '30d',
  immutable: true,
});

// Set before the routes plugin is registered: Fastify gives a plugin the error handler in effect when it was
// registered, and a handler set afterwards would not apply to the API routes.
app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode || 500;
  if (status >= 500) req.log.error(err);
  reply.code(status).send({ error: err.message });
});

await app.register(routes);

const hasWeb = fs.existsSync(config.webDist);
const NO_FALLBACK = ['/api/', '/files/', '/thumbs/', '/assets/'];
if (hasWeb) {
  await app.register(fastifyStatic, { root: config.webDist, prefix: '/', decorateReply: false });
}

app.setNotFoundHandler((req, reply) => {
  if (req.method === 'GET' && hasWeb && !NO_FALLBACK.some((p) => req.url.startsWith(p))) {
    return reply.sendFile('index.html', config.webDist, { maxAge: 0, immutable: false });
  }
  reply.code(404).send({ error: 'Not found' });
});

await app.listen({ port: config.port, host: config.host });

// catch up on items added while the server was down or the embeddings service was off
kickEmbeddings();

// index real pixel colours for items imported before colour search existed
backfillColorHistograms();
