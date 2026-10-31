import {
  Color,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  PMREMGenerator,
  RGBAFormat,
  Vector3,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

/**
 * An HDRI sky: the full-resolution image is the background; a downsampled copy with the sun
 * clamped becomes the image-based lighting (so the shadow-casting directional light, not the
 * environment, carries the sun). The sun's direction and color, and a fog color matched to the
 * horizon, are read out of the image itself.
 */

export interface Sky {
  background: Texture;
  environment: Texture;
  sunDirection: Vector3;
  sunColor: Color;
  horizon: Color;
}

const ENV_WIDTH = 1024;
/** Radiance cap for the lighting copy; the sun disk is far brighter than this. */
const ENV_CLAMP = 24;

export async function loadSky(renderer: WebGLRenderer, url: string): Promise<Sky> {
  const background = await new HDRLoader().loadAsync(url);
  background.mapping = EquirectangularReflectionMapping;
  const { data, width, height } = background.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const read = data instanceof Uint16Array ? (i: number) => DataUtils.fromHalfFloat(data[i]) : (i: number) => data[i];

  // Downsample (box filter) into a float texture, tracking the brightest texel.
  const step = Math.max(1, Math.floor(width / ENV_WIDTH));
  const w = Math.floor(width / step);
  const h = Math.floor(height / step);
  const env = new Float32Array(w * h * 4);
  let sunLum = 0;
  let sunU = 0;
  let sunV = 0;
  const sun = new Color();
  const horizon = new Color(0, 0, 0);
  let horizonCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < step; dy++) {
        for (let dx = 0; dx < step; dx++) {
          const i = ((y * step + dy) * width + (x * step + dx)) * 4;
          const pr = read(i);
          const pg = read(i + 1);
          const pb = read(i + 2);
          const lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
          if (lum > sunLum) {
            sunLum = lum;
            sunU = (x * step + dx + 0.5) / width;
            sunV = (y * step + dy + 0.5) / height;
            sun.setRGB(pr, pg, pb);
          }
          r += pr;
          g += pg;
          b += pb;
        }
      }
      const n = step * step;
      const o = (y * w + x) * 4;
      const m = Math.max(r, g, b) / n;
      const k = m > ENV_CLAMP ? ENV_CLAMP / m : 1;
      env[o] = (r / n) * k;
      env[o + 1] = (g / n) * k;
      env[o + 2] = (b / n) * k;
      env[o + 3] = 1;
      // Horizon band (just above the equator) for the fog color.
      const lat = 0.5 - (y + 0.5) / h;
      if (lat > 0.005 && lat < 0.04) {
        horizon.r += env[o];
        horizon.g += env[o + 1];
        horizon.b += env[o + 2];
        horizonCount++;
      }
    }
  }
  horizon.multiplyScalar(1 / Math.max(1, horizonCount));

  const envTexture = new DataTexture(env, w, h, RGBAFormat, FloatType);
  envTexture.mapping = EquirectangularReflectionMapping;
  envTexture.magFilter = envTexture.minFilter = LinearFilter;
  envTexture.flipY = background.flipY;
  envTexture.needsUpdate = true;
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(envTexture).texture;
  pmrem.dispose();
  envTexture.dispose();

  // Equirect texel -> direction, matching three.js' equirectUv (row 0 is the top when flipY).
  const v = background.flipY ? 1 - sunV : sunV;
  const lon = (sunU - 0.5) * Math.PI * 2;
  const lat = (v - 0.5) * Math.PI;
  const sunDirection = new Vector3(Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat)).normalize();
  const peak = Math.max(sun.r, sun.g, sun.b) || 1;
  const sunColor = new Color(sun.r / peak, sun.g / peak, sun.b / peak);

  return { background, environment, sunDirection, sunColor, horizon };
}
