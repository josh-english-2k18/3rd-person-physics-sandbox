// Shrinks the source GLB(s) in assets-src/models/ into web-ready copies in public/models/:
// textures are resized and re-encoded as WebP, unused data is pruned, and baked animations
// are dropped (MotionBricks drives the character).

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress, weld } from '@gltf-transform/functions';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '..');
// The operator file also contains the carbine the game uses as its weapon.
const MODELS = [{ src: 'swat_operator.glb', dst: 'operator.glb', maxTexture: 2048 }];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
mkdirSync(resolve(ROOT, 'public/models'), { recursive: true });

for (const { src, dst, maxTexture } of MODELS) {
  const doc = await io.read(resolve(ROOT, 'assets-src/models', src));
  for (const animation of doc.getRoot().listAnimations()) animation.dispose();
  await doc.transform(
    dedup(),
    weld(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [maxTexture, maxTexture], quality: 88 }),
    prune(),
  );
  await io.write(resolve(ROOT, 'public/models', dst), doc);
  console.log(`  ok  public/models/${dst}`);
}
