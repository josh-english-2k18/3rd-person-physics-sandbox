import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchModel } from '../engine';

afterEach(() => vi.unstubAllGlobals());

describe('browser model download', () => {
  for (const compressed of [false, true]) {
    it(`preserves decoded bytes with ${compressed ? 'compressed' : 'underreported'} Content-Length`, async () => {
      const expected = new Uint8Array([1, 2, 3, 4, 5, 6]);
      vi.stubGlobal('caches', undefined);
      // Browser Fetch yields decoded bytes while retaining compressed wire headers.
      vi.stubGlobal('fetch', vi.fn(async () => new Response(expected, {
        headers: { 'Content-Length': '3', ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) },
      })));
      const progress: { loaded: number; total: number }[] = [];
      expect(await fetchModel('/model.onnx', (p) => progress.push(p))).toEqual(expected);
      expect(progress.at(-1)?.loaded).toBe(expected.length);
      expect(progress.every((p) => p.loaded <= p.total)).toBe(true);
    });
  }
});
