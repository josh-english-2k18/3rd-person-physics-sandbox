// Turns the source GLBs in assets-src/models/ into web-ready copies in public/models/:
// textures are resized and re-encoded as WebP, unused data is pruned, and baked animations are
// dropped (MotionBricks drives the character). Weapons are baked into the game's weapon frame:
// real-world length, muzzle toward +Z, top toward +Y (Tripo models them muzzle toward -Z).

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, getBounds, prune, textureCompress, weld } from '@gltf-transform/functions';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '..');
const MODELS = [
  // Hero assets are always near the camera: keep Tripo's full 4K maps.
  { src: 'operator.glb', dst: 'operator.glb', maxTexture: 4096 },
  { src: 'bullpup.glb', dst: 'bullpup.glb', maxTexture: 4096, weaponLength: 0.72 },
  { src: 'launcher.glb', dst: 'launcher.glb', maxTexture: 4096, weaponLength: 1.0 },
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
mkdirSync(resolve(ROOT, 'public/models'), { recursive: true });

for (const { src, dst, maxTexture, weaponLength } of MODELS) {
  const doc = await io.read(resolve(ROOT, 'assets-src/models', src));
  for (const animation of doc.getRoot().listAnimations()) animation.dispose();
  if (weaponLength) {
    // Wrap the scene in a root node that scales to length and turns 180 degrees about Y.
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const bounds = getBounds(scene);
    const length = Math.max(...bounds.max.map((v, i) => v - bounds.min[i]));
    const s = weaponLength / length;
    const pivot = doc.createNode('Weapon').setScale([s, s, s]).setRotation([0, 1, 0, 0]);
    for (const child of scene.listChildren()) {
      scene.removeChild(child);
      pivot.addChild(child);
    }
    scene.addChild(pivot);
  }
  await doc.transform(
    dedup(),
    weld(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [maxTexture, maxTexture], quality: 88 }),
    prune(),
  );
  await io.write(resolve(ROOT, 'public/models', dst), doc);
  console.log(`  ok  public/models/${dst}`);
}
