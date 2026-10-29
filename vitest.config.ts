import { defineConfig } from 'vitest/config';

// Tests run in Node: swap the browser ONNX runtime for the native one (same API).
export default defineConfig({
  resolve: { alias: { 'onnxruntime-web/webgpu': 'onnxruntime-node' } },
  test: { environment: 'node', testTimeout: 120_000 },
});
