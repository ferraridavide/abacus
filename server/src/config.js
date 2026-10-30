import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(here, '../../data')),
  webDist: path.resolve(process.env.WEB_DIST || path.join(here, '../../web/dist')),
  // Optional HTTP basic auth: AUTH_USER / AUTH_PASSWORD
  authUser: process.env.AUTH_USER || 'abacus',
  authPassword: process.env.AUTH_PASSWORD || '',
  maxDownloadBytes: Number(process.env.MAX_DOWNLOAD_MB || 1024) * 1024 * 1024,
  importConcurrency: Number(process.env.IMPORT_CONCURRENCY || 3),
};

export const paths = {
  db: path.join(config.dataDir, 'library.db'),
  files: path.join(config.dataDir, 'files'),
  thumbs: path.join(config.dataDir, 'thumbs'),
};

for (const dir of [config.dataDir, paths.files, paths.thumbs]) {
  fs.mkdirSync(dir, { recursive: true });
}
