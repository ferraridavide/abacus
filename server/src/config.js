import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chosenDataDir, DATA_UNAVAILABLE, dataPaths, HOME_DIR, samePath } from './location.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const unavailable = (message) => Object.assign(new Error(message), { code: DATA_UNAVAILABLE });

let dataDir;
try {
  dataDir = chosenDataDir();
} catch (err) {
  throw unavailable(`Can't read where the library is: ${err.message}`);
}

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  homeDir: HOME_DIR,
  dataDir,
  webDist: path.resolve(process.env.WEB_DIST || path.join(here, '../../web/dist')),
  // Optional HTTP basic auth: AUTH_USER / AUTH_PASSWORD
  authUser: process.env.AUTH_USER || 'abacus',
  authPassword: process.env.AUTH_PASSWORD || '',
  maxDownloadBytes: Number(process.env.MAX_DOWNLOAD_MB || 1024) * 1024 * 1024,
  importConcurrency: Number(process.env.IMPORT_CONCURRENCY || 3),
};

export const paths = dataPaths(dataDir);

// A chosen folder always holds a library (it was copied or opened there). Without one it's most likely an unmounted
// share or a sync that hasn't arrived, and starting an empty library in its place would split the data in two.
if (!samePath(dataDir, HOME_DIR) && !fs.existsSync(paths.db)) {
  throw unavailable(
    `No library in ${dataDir}; is the drive connected? Delete ${path.join(HOME_DIR, 'data-location.json')} to go back to ${HOME_DIR}`
  );
}

try {
  for (const dir of [dataDir, paths.files, paths.thumbs]) fs.mkdirSync(dir, { recursive: true });
} catch (err) {
  throw unavailable(`Can't use ${dataDir}: ${err.message}`);
}
