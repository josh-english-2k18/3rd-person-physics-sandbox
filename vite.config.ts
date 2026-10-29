import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';

/**
 * onnxruntime-web loads its WebAssembly/WebGPU backend files at runtime from `ort.env.wasm.wasmPaths`.
 * Serve them verbatim under /ort/ (and copy them into the build) instead of routing through the bundler.
 */
const ORT_DIR = 'node_modules/onnxruntime-web/dist';
const ORT_FILES = existsSync(ORT_DIR) ? readdirSync(ORT_DIR).filter((f) => /^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(f)) : [];

// Multithreaded WASM needs SharedArrayBuffer, which requires a cross-origin isolated page.
const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function onnxRuntimeFiles(): Plugin {
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const name = (req.url ?? '').split('?')[0].replace(/^\/ort\//, '');
    const file = resolve(ORT_DIR, name);
    if (!req.url?.startsWith('/ort/') || !ORT_FILES.includes(name) || !existsSync(file)) return next();
    res.setHeader('Content-Type', extname(file) === '.wasm' ? 'application/wasm' : 'text/javascript');
    Object.entries(CROSS_ORIGIN_ISOLATION).forEach(([key, value]) => res.setHeader(key, value));
    createReadStream(file).pipe(res);
  };
  return {
    name: 'onnxruntime-files',
    configureServer: (server) => void server.middlewares.use(serve),
    configurePreviewServer: (server) => void server.middlewares.use(serve),
    generateBundle() {
      for (const name of ORT_FILES) {
        this.emitFile({ type: 'asset', fileName: `ort/${name}`, source: readFileSync(resolve(ORT_DIR, name)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [onnxRuntimeFiles()],
  server: { headers: CROSS_ORIGIN_ISOLATION },
  preview: { headers: CROSS_ORIGIN_ISOLATION },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
