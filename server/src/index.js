import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { DATA_UNAVAILABLE, finishMove } from './location.js';

// The supervisor. The app (app.js) runs in a worker, so it can be stopped and started again in another library
// folder without the process going away: moving the library (Settings → Storage), or waiting for a network share
// or a synced drive that isn't there yet.

const RETRY_MS = 10_000;
const STOP_TIMEOUT_MS = 15_000;
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';

let current = null;
let shuttingDown = false;

/** Run the app until it exits. Resolves to why: a move it asked for, an error, or its exit code. */
function runApp(moveError) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./app.js', import.meta.url), { workerData: { moveError } });
    let request = null;
    let failure = null;
    current = worker;
    worker.on('message', (message) => {
      if (message?.type !== 'move') return;
      request = message;
      stop(worker);
    });
    worker.on('error', (err) => {
      failure = err;
    });
    worker.on('exit', (code) => {
      current = null;
      resolve({ code, request, failure });
    });
  });
}

function stop(worker) {
  worker.postMessage('stop');
  setTimeout(() => worker.terminate(), STOP_TIMEOUT_MS).unref();
}

/** Answer every request with why the library can't open, until it's time to try again. */
async function explainUnavailable(message) {
  const server = http.createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': String(RETRY_MS / 1000) });
    res.end(JSON.stringify({ error: message }));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true;
    if (current) stop(current);
    else process.exit(0);
  });
}

let moveError = null;
for (;;) {
  const { code, request, failure } = await runApp(moveError);
  if (shuttingDown) process.exit(0);
  if (request) {
    try {
      await finishMove(request.path, request.mode);
      moveError = null;
      console.log(`abacus: the library is now in ${request.path}`);
    } catch (err) {
      moveError = `The library stayed where it was: ${err.message}`;
      console.error(`abacus: ${moveError}`);
    }
    continue;
  }
  if (failure?.code === DATA_UNAVAILABLE) {
    console.error(`abacus: ${failure.message}; trying again in ${RETRY_MS / 1000}s`);
    await explainUnavailable(failure.message);
    continue;
  }
  if (failure) console.error(failure);
  process.exit(failure ? 1 : code);
}
