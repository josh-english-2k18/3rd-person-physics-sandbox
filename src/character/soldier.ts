import {
  Group,
  MathUtils,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type Bone,
} from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Pose, Skeleton } from '../motion/skeleton';
import { frameQuaternion, measureHingeChain, rotateWorld, setWorldQuaternion, solveHinge, solveTwoBone, worldQuaternion, type HingeChain } from './ik';
import { addRimLight, setAnisotropy } from '../render/rimLight';
import { Retargeter } from './retarget';

/**
 * The special-ops operator: a Mixamo-rigged mesh (S.W.A.T. Operator by Mateusz Woliński,
 * CC-BY-4.0) driven by MotionBricks through the retargeter, with an upper-body aim layer that
 * shoulders the operator's own carbine and IK that keeps both hands on it.
 */

const WEAPON = {
  /** The carbine is an unskinned mesh in the operator file. */
  node: 'part_2_low_101',
  scale: 0.95,
  // Points in the weapon frame (forward +Z, up +Y, meters before scale).
  grip: new Vector3(0, -0.07, -0.2),
  foregrip: new Vector3(0.024, -0.004, 0.11), // left side of the handguard, clear of the magazine
  butt: new Vector3(0, -0.02, -0.4),
  muzzle: new Vector3(0, 0.012, 0.41),
  sight: new Vector3(0, 0.11, -0.02),
  /** Ejection port on the right side (weapon right is -X). */
  port: new Vector3(-0.03, 0.035, -0.04),
  /** Front of the laser module on the left of the handguard. */
  laser: new Vector3(0.026, 0.027, 0.235),
};

/** Bind-pose props that should follow a bone instead of floating at their bind position. */
const ATTACHMENTS: Record<string, string> = { Circle_102: 'RightArm', Plane_103: 'Spine2' };

const AIM = {
  /** How much of the yaw / pitch correction each spine bone takes (sums to 1). */
  spineShare: [0.2, 0.3, 0.5],
  maxYaw: 1.2,
  /** Shoulder pocket relative to the chest bone, in body axes (right, up, forward). */
  // Tuned so both arms sit within ~65-90% of their (short) reach and clear the torso by 7+ cm in
  // each pose: see Soldier.debug.
  pocketAim: new Vector3(0.12, 0.14, 0.05),
  pocketReady: new Vector3(0.14, 0.05, 0.1),
  readyPitch: -0.5,
  readyYaw: 0.4,
  /** Rifle stance: the torso turns this far right of the aim, bringing the support shoulder forward. */
  bladeAim: 0.5,
  bladeReady: 0.25,
  /** The support-side collarbone rolls forward toward the handguard by this fraction. */
  protract: 0.6,
  /** Elbow pole targets relative to the chest, in torso axes (right, up, forward). */
  rightElbow: new Vector3(1.0, -0.3, -0.1), // out to the side, clear of the torso
  leftElbow: new Vector3(-0.35, -1.0, 0.2),
};

/** Procedural combat crouch layered over standing motion (feet stay where MotionBricks plants them). */
const CROUCH = {
  drop: 0.3, // hips lowered by this much (m)
  back: 0.05, // and pushed back, so the weight sits over the heels
  pelvisPitch: 0.32, // radians forward
  chestCounter: 0.2, // radians back, keeping the chest fairly upright
  kneeSplay: 0.18,
};

/** Torso capsule radius (vest included) for keeping the arms out of the body. */
const TORSO_RADIUS = 0.17;

const UP = new Vector3(0, 1, 0);

interface HandBind {
  side: 'Left' | 'Right';
  hand: Bone;
  arm: HingeChain;
  /** Finger direction (wrist -> middle knuckle) and palm normal, in the hand bone's frame. */
  fingersLocal: Vector3;
  palmLocal: Vector3;
  /** Finger chains (proximal -> distal), thumb last. */
  fingers: Bone[][];
  thumb: Bone[];
  /** Bind-pose local rotations of every finger joint (curls are re-applied from these each frame). */
  rest: [Bone, Quaternion][];
}

/**
 * How each hand holds the carbine, in the weapon frame: the palm faces the gun, fingers wrap it.
 * Curls are per joint (proximal, middle, distal), radians toward the palm, added to the bind pose.
 */
const GRIP = {
  right: {
    // Palm against the right side of the pistol grip, knuckles toward its front strap.
    fingers: (f: Vector3, u: Vector3, r: Vector3) => f.clone().multiplyScalar(0.9).addScaledVector(u, -0.35).addScaledVector(r, -0.1),
    palm: (_f: Vector3, _u: Vector3, r: Vector3) => r.clone().negate(),
    // Relative to the bind pose, whose hands are already closed around a grip: straighten the
    // trigger finger along the guard, close the rest a touch.
    curl: { index: [-0.45, -0.35, -0.1], other: [0.15, 0.1, 0.05], thumb: [0.15, 0.2, 0.1] },
    // The palm surface sits this far from the grip's center line.
    standoff: 0.028,
  },
  left: {
    // Palm on the left side of the handguard, fingers angled forward and down so their natural
    // curl wraps underneath it.
    fingers: (f: Vector3, u: Vector3, r: Vector3) => f.clone().multiplyScalar(0.65).addScaledVector(u, -0.7).addScaledVector(r, 0.25),
    palm: (_f: Vector3, u: Vector3, r: Vector3) => r.clone().multiplyScalar(0.9).addScaledVector(u, 0.3),
    curl: { index: [0.2, 0.2, 0.1], other: [0.3, 0.3, 0.15], thumb: [0.1, 0.1, 0.05] },
    standoff: 0.012,
  },
  /** Wrist bone to palm center, along the fingers / toward the palm. */
  palmReach: 0.065,
  palmDepth: 0.02,
};

const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'] as const;

export interface AimState {
  /** World-space direction the weapon should point when aiming. */
  direction: Vector3;
  /** 0 = low ready (running), 1 = shouldered. */
  weight: number;
  /** Upper body follows the aim even at low ready, by this much. */
  bodyFollow: number;
  /** Recoil impulse 0..1, decays in the caller. */
  recoil: number;
  /** 0 = standing, 1 = combat crouch. */
  crouch: number;
}

export class Soldier {
  /** Live-tunable stance (exposed for automated tuning runs). */
  static readonly aim = AIM;
  static readonly grip = GRIP;
  static readonly weaponPoints = WEAPON;
  readonly root = new Group();
  readonly weapon = new Group();
  readonly muzzle = new Object3D();
  readonly sight = new Object3D();
  readonly port = new Object3D();
  readonly laser = new Object3D();
  private readonly retargeter: Retargeter;
  private readonly spine: Bone[];
  private readonly head: Bone;
  private readonly neck: Bone;
  private readonly chest: Bone;
  private readonly hands: { left: HandBind; right: HandBind };

  constructor(gltf: GLTF, somaSkeleton: Skeleton, referencePose: Pose, somaHipsHeight: number) {
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    this.root.add(model);
    this.root.scale.setScalar(somaHipsHeight / Retargeter.bindHipsHeight(model));
    this.root.updateMatrixWorld(true);

    model.traverse((o) => {
      o.frustumCulled = false;
      if ((o as Mesh).isMesh) {
        const mesh = o as Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const material = mesh.material as MeshStandardMaterial;
        // The eyes use transmission, which needs a feedback-prone extra pass; they sit behind goggles anyway.
        if ((material as MeshPhysicalMaterial).isMeshPhysicalMaterial) (material as MeshPhysicalMaterial).transmission = 0;
        material.envMapIntensity = 1.15;
        setAnisotropy(material, 8);
        addRimLight(material);
      }
    });

    this.retargeter = new Retargeter(model, somaSkeleton, referencePose);
    const bone = (name: string) => this.retargeter.bones.get(name)!;
    this.spine = ['Spine', 'Spine1', 'Spine2'].map(bone);
    this.chest = bone('Spine2');
    this.neck = bone('Neck');
    this.head = bone('Head');

    for (const [name, boneName] of Object.entries(ATTACHMENTS)) {
      const prop = model.getObjectByName(name);
      if (prop) bone(boneName).attach(prop);
    }

    // The carbine: re-home it in a weapon frame (forward +Z, up +Y). In its own mesh space the
    // barrel runs along +Y with the optic toward -Z, which is a +90 degree turn about X.
    const gun = model.getObjectByName(WEAPON.node)!;
    gun.removeFromParent();
    gun.position.set(0, 0, 0);
    gun.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    gun.scale.setScalar(1);
    this.weapon.add(gun);
    this.weapon.scale.setScalar(WEAPON.scale);
    this.muzzle.position.copy(WEAPON.muzzle);
    this.sight.position.copy(WEAPON.sight);
    this.port.position.copy(WEAPON.port);
    this.laser.position.copy(WEAPON.laser);
    this.weapon.add(this.muzzle, this.sight, this.port, this.laser);
    this.root.add(this.weapon);

    const handBind = (side: 'Left' | 'Right'): HandBind => {
      const hand = bone(`${side}Hand`);
      const p = (n: string) => bone(n).getWorldPosition(new Vector3());
      const fingers = p(`${side}HandMiddle1`).sub(p(`${side}Hand`)).normalize();
      const across = p(`${side}HandIndex1`).sub(p(`${side}HandPinky1`));
      // Palm normal from anatomy: with fingers forward and palm down, the index is on the inside,
      // which makes (fingers x index->pinky) point up for a right hand and down for a left one.
      const palm = new Vector3().crossVectors(fingers, across).normalize();
      if (side === 'Right') palm.negate();
      const toLocal = (v: Vector3) => v.clone().applyQuaternion(worldQuaternion(hand).invert());
      const chain = (name: string) => [1, 2, 3].map((i) => bone(`${side}Hand${name}${i}`));
      return {
        side,
        hand,
        arm: measureHingeChain(bone(`${side}Arm`), bone(`${side}ForeArm`), hand),
        fingersLocal: toLocal(fingers),
        palmLocal: toLocal(palm),
        fingers: FINGERS.map(chain),
        thumb: chain('Thumb'),
        rest: [...FINGERS, 'Thumb'].flatMap((n) => chain(n)).map((b) => [b, b.quaternion.clone()] as [Bone, Quaternion]),
      };
    };
    this.hands = { left: handBind('Left'), right: handBind('Right') };
  }

  /** IK diagnostics (wrist miss distance, required vs available reach), for tests. */
  readonly debug: Record<string, { miss: number; need: number; reach: number; clearance: number }> = {};

  /**
   * How far the arm (mid upper arm, elbow, mid forearm) stays outside the torso, modeled as a
   * capsule from the hips to the neck. Negative means the arm is inside the body.
   */
  private armClearance(bind: HandBind): number {
    const hips = this.retargeter.bones.get('Hips')!.getWorldPosition(new Vector3());
    const neck = this.neck.getWorldPosition(new Vector3());
    const s = bind.arm.upper.getWorldPosition(new Vector3());
    const e = bind.arm.lower.getWorldPosition(new Vector3());
    const w = bind.hand.getWorldPosition(new Vector3());
    const axis = neck.clone().sub(hips);
    const toAxis = (p: Vector3) => {
      const t = Math.min(Math.max(p.clone().sub(hips).dot(axis) / axis.lengthSq(), 0), 1);
      return p.distanceTo(hips.clone().addScaledVector(axis, t));
    };
    const points = [s.clone().lerp(e, 0.6), e, e.clone().lerp(w, 0.5)];
    return Math.min(...points.map(toAxis)) - TORSO_RADIUS * this.root.scale.x;
  }

  // Scratch
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly q = new Quaternion();
  private readonly weaponQ = new Quaternion();
  private readonly weaponPos = new Vector3();

  /** Poses the body from MotionBricks, then layers aim, weapon placement and hand IK on top. */
  update(pose: Pose, groundOffset: Vector3, aim: AimState): void {
    this.root.updateMatrixWorld(true);
    // The root group's scale is folded into bone lengths; positions come straight from SOMA.
    this.retargeter.apply(pose, groundOffset);

    // Body axes from the chest.
    const left = this.retargeter.bones.get('LeftUpLeg')!.getWorldPosition(new Vector3());
    const across = left.sub(this.retargeter.bones.get('RightUpLeg')!.getWorldPosition(new Vector3()));
    const bodyForward = this.fwd.crossVectors(across, UP).normalize();
    if (aim.crouch > 1e-3) this.crouch(aim.crouch, bodyForward);

    // 1. Twist the spine toward the aim (yaw), then pitch.
    const aimYaw = Math.atan2(aim.direction.x, aim.direction.z);
    const bodyYaw = Math.atan2(bodyForward.x, bodyForward.z);
    const yawError = Math.max(-AIM.maxYaw, Math.min(AIM.maxYaw, Math.atan2(Math.sin(aimYaw - bodyYaw), Math.cos(aimYaw - bodyYaw))));
    const follow = Math.max(aim.weight, aim.bodyFollow);
    const pitch = Math.asin(Math.max(-1, Math.min(1, aim.direction.y))) * aim.weight;
    for (let i = 0; i < this.spine.length; i++) {
      const share = AIM.spineShare[i];
      rotateWorld(this.spine[i], this.q.setFromAxisAngle(UP, yawError * follow * share));
    }
    // Blade the torso (turn it right of the aim) so the support shoulder comes forward.
    const blade = MathUtils.lerp(AIM.bladeReady, AIM.bladeAim, aim.weight) * Math.max(follow, 0.6);
    for (let i = 0; i < this.spine.length; i++) {
      rotateWorld(this.spine[i], this.q.setFromAxisAngle(UP, -blade * AIM.spineShare[i]));
    }
    const facing = new Vector3(Math.sin(bodyYaw + yawError * follow), 0, Math.cos(bodyYaw + yawError * follow));
    const torsoYaw = bodyYaw + yawError * follow - blade;
    const torso = new Vector3(Math.sin(torsoYaw), 0, Math.cos(torsoYaw));
    const sideAxis = this.right.crossVectors(facing, UP).normalize(); // body right
    for (let i = 0; i < this.spine.length; i++) {
      rotateWorld(this.spine[i], this.q.setFromAxisAngle(sideAxis, pitch * AIM.spineShare[i] * 0.8));
    }
    // Head looks down the aim.
    rotateWorld(this.neck, this.q.setFromAxisAngle(sideAxis, pitch * 0.15));
    rotateWorld(this.head, this.q.setFromAxisAngle(sideAxis, pitch * 0.05));

    // 2. Place the weapon: shouldered along the aim, or at low ready across the body.
    // Roll the support collarbone forward.
    const clavicle = this.retargeter.bones.get('LeftShoulder')!;
    const armJoint = this.retargeter.bones.get('LeftArm')!;
    const out = armJoint.getWorldPosition(new Vector3()).sub(clavicle.getWorldPosition(new Vector3())).normalize();
    rotateWorld(clavicle, this.q.setFromUnitVectors(out, out.clone().lerp(facing, AIM.protract).normalize()));

    const chestPos = this.chest.getWorldPosition(new Vector3());
    const torsoRight = new Vector3().crossVectors(torso, UP).normalize();
    const body = { right: torsoRight, up: UP, forward: torso };
    const pocket = (offset: Vector3) =>
      chestPos.clone()
        .addScaledVector(body.right, offset.x)
        .addScaledVector(body.up, offset.y)
        .addScaledVector(body.forward, offset.z);

    const aimQ = frameAxes(aim.direction, UP);
    const readyDir = facing.clone()
      .applyAxisAngle(UP, AIM.readyYaw)
      .applyAxisAngle(sideAxis, AIM.readyPitch)
      .normalize();
    const readyQ = frameAxes(readyDir, UP);
    this.weaponQ.slerpQuaternions(readyQ, aimQ, aim.weight);
    // Recoil: kick up and back.
    const weaponLeft = new Vector3(1, 0, 0).applyQuaternion(this.weaponQ);
    this.weaponQ.premultiply(this.q.setFromAxisAngle(weaponLeft, -aim.recoil * 0.12));
    const buttWorld = pocket(new Vector3().lerpVectors(AIM.pocketReady, AIM.pocketAim, aim.weight));
    buttWorld.addScaledVector(new Vector3(0, 0, 1).applyQuaternion(this.weaponQ), -aim.recoil * 0.05);
    const scale = WEAPON.scale * this.root.scale.x;
    this.weaponPos.copy(WEAPON.butt).multiplyScalar(scale).applyQuaternion(this.weaponQ);
    this.weaponPos.subVectors(buttWorld, this.weaponPos);
    this.setWeaponWorld(this.weaponPos, this.weaponQ, scale);

    // 3. Hands onto the weapon.
    const wF = new Vector3(0, 0, 1).applyQuaternion(this.weaponQ);
    const wU = new Vector3(0, 1, 0).applyQuaternion(this.weaponQ);
    const wR = new Vector3().crossVectors(wF, wU); // weapon right
    const point = (local: Vector3) => local.clone().multiplyScalar(scale).applyQuaternion(this.weaponQ).add(this.weaponPos);

    // Elbows: the trigger arm out and down, the support arm down under the gun.
    const rightPole = pocket(AIM.rightElbow);
    const leftPole = pocket(AIM.leftElbow);
    this.placeHand(this.hands.right, GRIP.right, point(WEAPON.grip), wF, wU, wR, rightPole);
    this.placeHand(this.hands.left, GRIP.left, point(WEAPON.foregrip), wF, wU, wR, leftPole);
  }

  private crouch(amount: number, forward: Vector3): void {
    const bone = (name: string) => this.retargeter.bones.get(name)!;
    const right = new Vector3().crossVectors(forward, UP).normalize();
    const legs = (['Left', 'Right'] as const).map((side) => {
      const foot = bone(`${side}Foot`);
      return { side, foot, at: foot.getWorldPosition(new Vector3()), rotation: worldQuaternion(foot, new Quaternion()) };
    });

    const hips = bone('Hips');
    const position = hips.getWorldPosition(new Vector3())
      .addScaledVector(UP, -CROUCH.drop * amount)
      .addScaledVector(forward, -CROUCH.back * amount);
    hips.position.copy(hips.parent!.worldToLocal(position));
    hips.updateMatrixWorld(true);
    // Lean the pelvis forward, then bring the chest most of the way back up.
    rotateWorld(hips, this.q.setFromAxisAngle(right, -CROUCH.pelvisPitch * amount));
    rotateWorld(bone('Spine1'), this.q.setFromAxisAngle(right, CROUCH.chestCounter * amount));

    for (const { side, foot, at, rotation } of legs) {
      const knee = bone(`${side}Leg`).getWorldPosition(new Vector3());
      const splay = side === 'Left' ? -CROUCH.kneeSplay : CROUCH.kneeSplay;
      const pole = knee.addScaledVector(forward, 1).addScaledVector(right, splay);
      solveTwoBone(bone(`${side}UpLeg`), bone(`${side}Leg`), foot, at, pole);
      setWorldQuaternion(foot, rotation);
    }
  }

  private setWeaponWorld(position: Vector3, rotation: Quaternion, scale: number): void {
    const parent = this.root;
    parent.updateMatrixWorld(true);
    this.weapon.position.copy(parent.worldToLocal(position.clone()));
    const parentQ = parent.getWorldQuaternion(new Quaternion());
    this.weapon.quaternion.copy(parentQ.invert().multiply(rotation));
    this.weapon.scale.setScalar(scale / parent.scale.x);
    this.weapon.updateMatrixWorld(true);
  }

  private placeHand(
    bind: HandBind,
    grip: typeof GRIP.right,
    contact: Vector3,
    f: Vector3,
    u: Vector3,
    r: Vector3,
    pole: Vector3,
  ): void {
    const fingers = grip.fingers(f, u, r).normalize();
    const palm = grip.palm(f, u, r);
    palm.addScaledVector(fingers, -palm.dot(fingers)).normalize();
    // Hand rotation: map the hand's own (fingers, palm) frame onto the grip's.
    const target = frameQuaternion(fingers, palm).multiply(frameQuaternion(bind.fingersLocal, bind.palmLocal).invert());
    // Palm surface on the gun; the wrist bone sits behind and above the palm center.
    const s = this.root.scale.x;
    const wrist = contact.clone()
      .addScaledVector(palm, -(grip.standoff + GRIP.palmDepth) * s)
      .addScaledVector(fingers, -GRIP.palmReach * s);
    solveHinge(bind.arm, wrist, pole);
    setWorldQuaternion(bind.hand, target);
    const shoulder = bind.arm.upper.getWorldPosition(new Vector3());
    this.debug[bind.side] = {
      miss: +bind.hand.getWorldPosition(new Vector3()).distanceTo(wrist).toFixed(3),
      need: +shoulder.distanceTo(wrist).toFixed(3),
      reach: +(bind.arm.upperLength + bind.arm.lowerLength).toFixed(3),
      clearance: +this.armClearance(bind).toFixed(3),
    };

    // Curl the fingers around the gun (about the axis that swings them toward the palm).
    for (const [joint, rest] of bind.rest) joint.quaternion.copy(rest);
    bind.hand.updateMatrixWorld(true);
    const axis = new Vector3().crossVectors(fingers, palm).normalize();
    const curlChain = (chain: Bone[], angles: number[]) =>
      chain.forEach((joint, i) => rotateWorld(joint, this.q.setFromAxisAngle(axis, angles[i])));
    bind.fingers.forEach((chain, i) => curlChain(chain, i === 0 ? grip.curl.index : grip.curl.other));
    curlChain(bind.thumb, grip.curl.thumb);
  }

  boneWorld(name: string): Vector3 {
    return this.retargeter.bones.get(name)?.getWorldPosition(new Vector3()) ?? new Vector3();
  }

  get muzzleWorld(): Vector3 {
    return this.muzzle.getWorldPosition(new Vector3());
  }

  get weaponForward(): Vector3 {
    return new Vector3(0, 0, 1).applyQuaternion(this.weaponQ);
  }

  get weaponUp(): Vector3 {
    return new Vector3(0, 1, 0).applyQuaternion(this.weaponQ);
  }

  get weaponRight(): Vector3 {
    return new Vector3(-1, 0, 0).applyQuaternion(this.weaponQ);
  }
}

/** Rotation whose +Z is `forward` and +Y is as close to `up` as possible. */
function frameAxes(forward: Vector3, up: Vector3): Quaternion {
  const z = forward.clone().normalize();
  const x = new Vector3().crossVectors(up, z).normalize();
  const y = new Vector3().crossVectors(z, x);
  return frameQuaternion(z, y).multiply(BASIS_FIX);
}

// frameQuaternion maps +X to the primary and +Y to the secondary; we want +Z forward, +Y up.
const BASIS_FIX = frameQuaternion(new Vector3(0, 0, 1), new Vector3(0, 1, 0)).invert();
