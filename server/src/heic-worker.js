import { parentPort } from 'node:worker_threads';
import decode from 'heic-decode';

// libheif is WebAssembly and decodes synchronously, taking a second or more for a phone photo. Decoding here keeps
// every request from waiting on it.

parentPort.on('message', async ({ id, buffer }) => {
  try {
    const { data, width, height } = await decode({ buffer });
    parentPort.postMessage({ id, data, width, height }, [data.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, error: err?.message || String(err) });
  }
});
