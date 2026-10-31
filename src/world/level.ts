import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { createGridMaterial } from '../render/gridMaterial';
import type { Physics } from './physics';

/**
 * An Unreal-style greybox test level: a big grid floor inside perimeter walls, with ramps,
 * stairs, raised platforms, a bridge, pillars, and cover blocks to run around and shoot from.
 * Static geometry gets fixed colliders; dynamic props live in props.ts.
 */

const PALETTE = {
  floor: { color: '#3b3f46', lineColor: '#575d66' },
  wall: { color: '#6d727b', lineColor: '#8d939c' },
  block: { color: '#aeb3bb', lineColor: '#7d838c' },
  accent: { color: '#e8762b', lineColor: '#f6b07a' },
  blue: { color: '#2f6fb3', lineColor: '#7fb2e8' },
  dark: { color: '#2b2e33', lineColor: '#4a4f57' },
};

export const LEVEL = {
  half: 45, // the playable area is 90 x 90 m
  wallHeight: 9,
};

export interface Level {
  group: Group;
  spawn: Vector3;
}

export function buildLevel(physics: Physics): Level {
  const group = new Group();
  group.name = 'level';
  const materials = Object.fromEntries(
    Object.entries(PALETTE).map(([key, value]) => [key, createGridMaterial(value)]),
  ) as Record<keyof typeof PALETTE, MeshStandardMaterial>;
  materials.floor.roughness = 0.88;

  const box = (
    position: [number, number, number],
    size: [number, number, number],
    material: Material,
    rotation?: Quaternion,
  ) => {
    const mesh = new Mesh(new BoxGeometry(...size), material);
    mesh.position.set(...position);
    if (rotation) mesh.quaternion.copy(rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    physics.fixedBox(mesh.position, new Vector3(size[0] / 2, size[1] / 2, size[2] / 2), mesh.quaternion);
    return mesh;
  };

  // Floor
  const floorSize = LEVEL.half * 2 + 30;
  const floor = new Mesh(new PlaneGeometry(floorSize, floorSize), materials.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);
  physics.fixedBox(new Vector3(0, -0.5, 0), new Vector3(floorSize / 2, 0.5, floorSize / 2));

  // Perimeter walls with buttresses
  const { half, wallHeight: h } = LEVEL;
  for (const [x, z, w, d] of [
    [0, -half, half * 2 + 2, 2],
    [0, half, half * 2 + 2, 2],
    [-half, 0, 2, half * 2 + 2],
    [half, 0, 2, half * 2 + 2],
  ] as const) {
    box([x, h / 2, z], [w, h, d], materials.wall);
  }
  for (let i = -half + 10; i <= half - 10; i += 10) {
    for (const s of [-1, 1]) {
      box([i, h / 2 + 0.5, s * (half - 1.4)], [1.2, h + 1, 1], materials.dark);
      box([s * (half - 1.4), h / 2 + 0.5, i], [1, h + 1, 1.2], materials.dark);
    }
  }

  // North-west: raised platform with a ramp and stairs
  box([-24, 1.5, -24], [16, 3, 12], materials.block);
  box([-24, 3.25, -24], [16.2, 0.5, 12.2], materials.dark);
  const rampAngle = Math.atan2(3, 9);
  box(
    [-24, 1.5 - 0.25, -13.5],
    [6, 0.5, Math.hypot(9, 3)],
    materials.accent,
    new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), rampAngle),
  );
  for (let i = 0; i < 10; i++) {
    const height = 0.3 * (i + 1);
    box([-37 + i * 0.5 + 0.25, height / 2, -24], [0.5, height, 4], materials.block);
  }

  // North-east: two towers joined by a bridge
  box([22, 3, -26], [8, 6, 8], materials.block);
  box([34, 3, -26], [6, 6, 8], materials.block);
  box([28, 5.75, -26], [6, 0.5, 3], materials.blue);
  box([28, 6.4, -27.4], [6, 0.8, 0.2], materials.dark);
  box([28, 6.4, -24.6], [6, 0.8, 0.2], materials.dark);
  box(
    [22, 3, -17.5],
    [4, 0.5, Math.hypot(9, 6)],
    materials.accent,
    new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.atan2(6, 9)),
  );

  // Center: an open arena ringed with low cover
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -a);
    box([Math.cos(a) * 12, 0.45, Math.sin(a) * 12], [0.8, 0.9, 4], i % 2 ? materials.block : materials.blue, q);
  }

  // Vault walls near the spawn (Space while running at them).
  box([-5, 0.4, 3], [3, 0.8, 0.5], materials.accent);
  box([5, 0.35, 2], [3, 0.7, 0.5], materials.accent);

  // Pillars along the east lane
  const pillarMaterial = materials.block;
  for (let i = 0; i < 5; i++) {
    const pillar = new Mesh(new CylinderGeometry(0.8, 0.8, 7, 32), pillarMaterial);
    pillar.position.set(30, 3.5, -6 + i * 8);
    pillar.castShadow = pillar.receiveShadow = true;
    group.add(pillar);
    physics.fixedBox(pillar.position, new Vector3(0.7, 3.5, 0.7));
    box([30, 7.2, -6 + i * 8], [2, 0.4, 2], materials.dark);
  }

  // South: the shooting range (lanes separated by low dividers, with a firing line)
  box([0, 0.05, 20], [24, 0.1, 1], materials.accent);
  for (let i = -2; i <= 2; i++) box([i * 5 - 2.5, 0.6, 30], [0.3, 1.2, 18], materials.dark);
  box([0, 2.5, 40], [26, 5, 1], materials.wall);

  // West: cover maze
  const maze: [number, number, number, number][] = [
    [-30, 4, 8, 1], [-26, 10, 1, 8], [-34, 12, 1, 6], [-30, 18, 6, 1], [-22, 22, 1, 6], [-36, 26, 8, 1],
  ];
  for (const [x, z, w, d] of maze) box([x, 1.25, z], [w, 2.5, d], materials.block);

  // Scattered "unreal" decorations: an emissive light strip around the range for a bit of color.
  const strip = new Mesh(
    new BoxGeometry(24, 0.06, 0.12),
    new MeshStandardMaterial({ color: '#000', emissive: new Color('#ff8a3d'), emissiveIntensity: 4 }),
  );
  strip.position.set(0, 0.11, 20.45);
  group.add(strip);

  return { group, spawn: new Vector3(0, 0, 8) };
}
