import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import encode, { init } from '@jsquash/jxl/encode.js';

// Encodes JPEG XL thumbnails off the main thread: libjxl runs as synchronous WebAssembly and takes a few hundred
// milliseconds per image, which would otherwise stall every request while a library is being converted.

// In Node the codec can't fetch its own .wasm, so it's handed the compiled module.
const require = createRequire(import.meta.url);
const ready = WebAssembly.compile(fs.readFileSync(require.resolve('@jsquash/jxl/codec/enc/jxl_enc.wasm'))).then(init);

parentPort.on('message', async ({ id, data, width, height }) => {
  try {
    await ready;
    // progressive: the file is ordered from a coarse pass to the fine detail, so a partial download already shows it
    const out = await encode({ data: new Uint8ClampedArray(data), width, height }, { quality: 80, effort: 5, progressive: true });
    parentPort.postMessage({ id, buffer: out }, [out]);
  } catch (err) {
    parentPort.postMessage({ id, error: err?.message || String(err) });
  }
});
