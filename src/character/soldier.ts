import {
  Group,
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
import { frameQuaternion, rotateWorld, setWorldQuaternion, solveTwoBone, worldQuaternion } from './ik';
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
  foregrip: new Vector3(0, -0.045, 0.12),
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
  pocketAim: new Vector3(0.12, 0.14, 0.02),
  pocketReady: new Vector3(0.1, 0.06, 0.06),
  readyPitch: -0.5,
  readyYaw: 0.22,
};

/** Procedural combat crouch layered over standing motion (feet stay where MotionBricks plants them). */
const CROUCH = {
  drop: 0.3, // hips lowered by this much (m)
  back: 0.05, // and pushed back, so the weight sits over the heels
  pelvisPitch: 0.32, // radians forward
  chestCounter: 0.2, // radians back, keeping the chest fairly upright
  kneeSplay: 0.18,
};

const UP = new Vector3(0, 1, 0);

interface HandBind {
  hand: Bone;
  arm: Bone;
  foreArm: Bone;
  /** Bind world rotation of the hand, and its bind palm frame. */
  bindWorld: Quaternion;
  bindFrame: Quaternion;
}

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
      const primary = p(`${side}HandMiddle1`).sub(p(`${side}Hand`));
      const across = p(`${side}HandIndex1`).sub(p(`${side}HandPinky1`));
      return {
        hand,
        arm: bone(`${side}Arm`),
        foreArm: bone(`${side}ForeArm`),
        bindWorld: worldQuaternion(hand),
        bindFrame: frameQuaternion(primary, across),
      };
    };
    this.hands = { left: handBind('Left'), right: handBind('Right') };
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
    const facing = new Vector3(Math.sin(bodyYaw + yawError * follow), 0, Math.cos(bodyYaw + yawError * follow));
    const sideAxis = this.right.crossVectors(facing, UP).normalize(); // body right
    for (let i = 0; i < this.spine.length; i++) {
      rotateWorld(this.spine[i], this.q.setFromAxisAngle(sideAxis, pitch * AIM.spineShare[i] * 0.8));
    }
    // Head looks down the aim.
    rotateWorld(this.neck, this.q.setFromAxisAngle(sideAxis, pitch * 0.15));
    rotateWorld(this.head, this.q.setFromAxisAngle(sideAxis, pitch * 0.05));

    // 2. Place the weapon: shouldered along the aim, or at low ready across the body.
    const chestPos = this.chest.getWorldPosition(new Vector3());
    const body = { right: sideAxis.clone(), up: UP, forward: facing };
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

    // Right hand on the pistol grip: palm against its right side, fingers wrapping forward-down.
    const rPrimary = wF.clone().multiplyScalar(0.62).addScaledVector(wU, -0.72).addScaledVector(wR, -0.15);
    const rAcross = wU.clone().multiplyScalar(0.7).addScaledVector(wF, 0.62);
    this.placeHand(this.hands.right, point(WEAPON.grip), rPrimary, rAcross,
      chestPos.clone().addScaledVector(body.right, 0.6).addScaledVector(UP, -0.6).addScaledVector(body.forward, -0.2));

    // Left hand under the handguard, fingers wrapping over its right side.
    const lPrimary = wR.clone().multiplyScalar(0.55).addScaledVector(wU, 0.35).addScaledVector(wF, 0.55);
    const lAcross = wF.clone().multiplyScalar(0.85).addScaledVector(wR, -0.4);
    this.placeHand(this.hands.left, point(WEAPON.foregrip), lPrimary, lAcross,
      chestPos.clone().addScaledVector(body.right, -0.7).addScaledVector(UP, -0.7));
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

  private placeHand(bind: HandBind, palm: Vector3, primary: Vector3, across: Vector3, pole: Vector3): void {
    const target = frameQuaternion(primary, across).multiply(bind.bindFrame.clone().invert()).multiply(bind.bindWorld);
    // The hand bone sits at the wrist; the palm center is ~7 cm along the fingers.
    const wrist = palm.clone().addScaledVector(primary.clone().normalize(), -0.075 * this.root.scale.x);
    solveTwoBone(bind.arm, bind.foreArm, bind.hand, wrist, pole);
    setWorldQuaternion(bind.hand, target);
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
