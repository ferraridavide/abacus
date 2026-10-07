import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyCompress from '@fastify/compress';
import { config, paths } from './config.js';
import { routes } from './routes.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 10 * 1024 * 1024 });

// Optional HTTP basic auth for self-hosting
if (config.authPassword) {
  const expected = 'Basic ' + Buffer.from(`${config.authUser}:${config.authPassword}`).toString('base64');
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/api/health') return;
    if (req.headers.authorization !== expected) {
      reply.header('www-authenticate', 'Basic realm="Abacus"').code(401).send('Authentication required');
    }
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

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode || 500;
  if (status >= 500) req.log.error(err);
  reply.code(status).send({ error: err.message });
});

await app.listen({ port: config.port, host: config.host });
