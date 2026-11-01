import { Vector3 } from 'three';

/**
 * The operator's two weapons (Tripo-generated, see scripts/assets/): where to hold them, how to
 * stand with them, and how they fire.
 *
 * Points are in the weapon frame (meters, muzzle toward +Z, top toward +Y, the weapon's right side
 * toward -X), read off the measuring sheet (tools/asset-viewer.html?measure=1). optimize-models.mjs
 * bakes the source meshes into this frame at real-world length.
 */

/** How a hand holds a grip, from the weapon axes: forward f, up u, right r. */
export interface GripStyle {
  /** Wrist -> knuckles direction. */
  fingers: (f: Vector3, u: Vector3, r: Vector3) => Vector3;
  /** Direction the palm faces (into the grip). */
  palm: (f: Vector3, u: Vector3, r: Vector3) => Vector3;
  /** Finger curls toward the palm (radians) for proximal, middle, distal joints, on the bind pose. */
  curl: { index: number[]; other: number[]; thumb: number[] };
  /** Palm surface distance from the grip's center line (m). */
  standoff: number;
}

export interface Stance {
  /**
   * Where the anchor (butt pad / tube underside) rests relative to the right shoulder joint, in
   * torso axes (right, up, forward), when aiming and at low ready.
   */
  pocketAim: Vector3;
  pocketReady: Vector3;
  /** Lowered carry: muzzle pitched (negative = down) and yawed (positive = left) off the body. */
  readyPitch: number;
  readyYaw: number;
  /** Torso turned right of the aim (radians), bringing the support shoulder forward. */
  bladeAim: number;
  bladeReady: number;
  /** Support collarbone rolled toward the weapon by this fraction. */
  protract: number;
  /** Elbow pole targets relative to the chest, in torso axes (right, up, forward). */
  rightElbow: Vector3;
  leftElbow: Vector3;
  /**
   * Cheek weld: when aiming, the head turns so the eye (offset `eye` from the head bone, torso
   * axes) sits on the sight line `eyeRelief` behind the sight.
   */
  eye: Vector3;
  eyeRelief: number;
  /** Aiming lean (radians): chest tipped toward the firing shoulder (`side`) and forward. */
  lean: { side: number; forward: number };
  /** Recoil kick: radians of muzzle climb and meters of push-back at full recoil. */
  recoilPitch: number;
  recoilPush: number;
}

export interface FireProfile {
  name: string;
  magazine: number;
  rpm: number;
  reloadSeconds: number;
  spreadHip: number;
  spreadAim: number;
  bloomPerShot: number;
  kickPitch: number;
  kickYaw: number;
  /** Hitscan rounds, or a rocket projectile. */
  projectile: 'bullet' | 'rocket';
  automatic: boolean;
}

export interface WeaponDef {
  id: 'bullpup' | 'launcher';
  url: string;
  points: {
    grip: Vector3;
    foregrip: Vector3;
    /** Rests against the body: the butt pad on the shoulder pocket, or the tube on the shoulder. */
    anchor: Vector3;
    muzzle: Vector3;
    sight: Vector3;
    port?: Vector3;
    laser?: Vector3;
    /** Rear venturi (backblast). */
    rear?: Vector3;
  };
  stance: Stance;
  grips: { right: GripStyle; left: GripStyle };
  fire: FireProfile;
  /** Slung on the back while the other weapon is out: offset behind the chest and a tilt. */
  sling: { back: number; up: number; side: number; roll: number };
}

// The new operator's bind hands are open (A-pose), so grips close them fully.
const PISTOL_GRIP: GripStyle = {
  // Palm against the right side of the pistol grip, knuckles wrapping its front strap.
  fingers: (f, u, r) => f.clone().multiplyScalar(0.85).addScaledVector(u, -0.45).addScaledVector(r, -0.1),
  palm: (_f, _u, r) => r.clone().negate(),
  curl: { index: [0.35, 0.55, 0.35], other: [1.25, 1.45, 0.95], thumb: [0.35, 0.45, 0.3] },
  standoff: 0.022,
};

const VERTICAL_FOREGRIP: GripStyle = {
  // Mirror of the pistol grip: palm on the grip's left side, fingers wrapping around its front.
  fingers: (f, u, r) => f.clone().multiplyScalar(0.85).addScaledVector(u, -0.45).addScaledVector(r, 0.1),
  palm: (_f, _u, r) => r.clone(),
  curl: { index: [1.15, 1.35, 0.9], other: [1.25, 1.45, 0.95], thumb: [0.35, 0.45, 0.3] },
  standoff: 0.02,
};

const BASE = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

export const WEAPONS: Record<WeaponDef['id'], WeaponDef> = {
  bullpup: {
    id: 'bullpup',
    url: `${BASE}models/bullpup.glb`,
    points: {
      grip: new Vector3(0, -0.07, -0.045),
      foregrip: new Vector3(0, -0.055, 0.205),
      anchor: new Vector3(0, 0.03, -0.35),
      muzzle: new Vector3(0, 0.049, 0.36),
      sight: new Vector3(0, 0.137, 0.08),
      port: new Vector3(-0.04, 0.07, -0.16),
      laser: new Vector3(-0.02, 0.1, 0.25),
    },
    stance: {
      // Both arms at ~65-80% of reach and 4+ cm clear of the torso (Soldier.debug).
      pocketAim: new Vector3(-0.12, 0.03, 0.07),
      pocketReady: new Vector3(-0.06, -0.06, 0.06),
      readyPitch: -0.35,
      readyYaw: 0.45,
      bladeAim: 0.5,
      bladeReady: 0.25,
      protract: 0.6,
      rightElbow: new Vector3(1.0, -0.3, -0.1),
      leftElbow: new Vector3(-0.35, -1.0, 0.2),
      eye: new Vector3(0.035, 0.07, 0.09),
      eyeRelief: 0.12,
      lean: { side: 0.12, forward: 0.08 },
      recoilPitch: 0.12,
      recoilPush: 0.05,
    },
    grips: { right: PISTOL_GRIP, left: VERTICAL_FOREGRIP },
    fire: {
      name: 'VX-9 BULLPUP',
      magazine: 30,
      rpm: 820,
      reloadSeconds: 2.0,
      spreadHip: 0.022,
      spreadAim: 0.0035,
      bloomPerShot: 0.006,
      kickPitch: 0.012,
      kickYaw: 0.004,
      projectile: 'bullet',
      automatic: true,
    },
    sling: { back: 0.2, up: 0.05, side: 0.0, roll: 0.75 },
  },
  launcher: {
    id: 'launcher',
    url: `${BASE}models/launcher.glb`,
    points: {
      grip: new Vector3(0, -0.12, -0.005),
      foregrip: new Vector3(0, -0.105, 0.334),
      // Underside of the tube where it rests on the shoulder (well behind the grip, as on a real
      // shoulder-fired launcher, so the trigger arm isn't jammed up).
      anchor: new Vector3(0, -0.025, -0.28),
      muzzle: new Vector3(0, 0.047, 0.5),
      sight: new Vector3(0.0, 0.18, 0.21),
      rear: new Vector3(0, 0.047, -0.5),
    },
    stance: {
      pocketAim: new Vector3(-0.02, 0.07, 0.0),
      pocketReady: new Vector3(-0.02, 0.06, 0.02),
      // Carried on the shoulder, muzzle just below level.
      readyPitch: -0.12,
      readyYaw: 0.05,
      bladeAim: 0.35,
      bladeReady: 0.25,
      protract: 0.6,
      rightElbow: new Vector3(0.9, -0.6, -0.1),
      leftElbow: new Vector3(-0.3, -1.0, 0.3),
      eye: new Vector3(0.035, 0.07, 0.09),
      eyeRelief: 0.12,
      lean: { side: 0.12, forward: 0.06 },
      recoilPitch: 0.3,
      recoilPush: 0.08,
    },
    grips: { right: PISTOL_GRIP, left: VERTICAL_FOREGRIP },
    fire: {
      name: 'M7 LAUNCHER',
      magazine: 1,
      rpm: 40,
      reloadSeconds: 2.4,
      spreadHip: 0.01,
      spreadAim: 0.002,
      bloomPerShot: 0,
      kickPitch: 0.05,
      kickYaw: 0.01,
      projectile: 'rocket',
      automatic: false,
    },
    sling: { back: 0.22, up: 0.0, side: 0.0, roll: -0.6 },
  },
};
