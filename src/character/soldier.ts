import { Group, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3, MathUtils, type Bone } from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Pose, Skeleton } from '../motion/skeleton';
import { addRimLight, setAnisotropy } from '../render/rimLight';
import { frameQuaternion, measureHingeChain, rotateWorld, setWorldQuaternion, solveHinge, solveTwoBone, worldQuaternion, type HingeChain } from './ik';
import { Retargeter } from './retarget';
import { WEAPONS, type GripStyle, type WeaponDef } from './weapons';

/**
 * The special forces operator (Tripo-generated and auto-rigged with Mixamo bone names, see
 * scripts/assets/), driven by MotionBricks through the retargeter. On top of the motion: an aim
 * layer that shoulders the active weapon, hinge IK that keeps both hands on its grips, a
 * procedural combat crouch, and the other weapon slung across the back.
 */

const AIM = {
  /** How much of the yaw / pitch correction each spine bone takes (sums to 1). */
  spineShare: [0.2, 0.3, 0.5],
  maxYaw: 1.2,
  /** Seconds to lower one weapon and bring up the other. */
  swapSeconds: 0.45,
};

/** Procedural combat crouch layered over standing motion (feet stay where MotionBricks plants them). */
const CROUCH = {
  drop: 0.3, // hips lowered by this much (m)
  back: 0.05, // and pushed back, so the weight sits over the heels
  pelvisPitch: 0.32, // radians forward
  chestCounter: 0.2, // radians back, keeping the chest fairly upright
  kneeSplay: 0.18,
};

/** Most the neck / head turn to meet the sight line (radians), so the face stays toward the target. */
const CHEEK_LIMIT = 0.3;

/** Torso capsule radius (vest included) for keeping the arms out of the body. */
const TORSO_RADIUS = 0.17;

/** Wrist bone to palm center, along the fingers / toward the palm (m). */
const HAND = { palmReach: 0.065, palmDepth: 0.02 };

const UP = new Vector3(0, 1, 0);
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'] as const;

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

interface HeldWeapon {
  def: WeaponDef;
  group: Group;
}

export class Soldier {
  /** Live-tunable weapon stances and grips (exposed for automated tuning runs). */
  static readonly weapons = WEAPONS;
  readonly root = new Group();
  /** Markers that follow the active weapon (effects read these). */
  readonly muzzle = new Object3D();
  readonly sight = new Object3D();
  readonly port = new Object3D();
  readonly laser = new Object3D();
  readonly rear = new Object3D();
  private readonly held: Record<WeaponDef['id'], HeldWeapon>;
  private activeId: WeaponDef['id'] = 'bullpup';
  private swap = 1;
  private readonly retargeter: Retargeter;
  private readonly spine: Bone[];
  private readonly head: Bone;
  private readonly neck: Bone;
  private readonly chest: Bone;
  private readonly hands: { left: HandBind; right: HandBind };

  constructor(
    gltf: GLTF,
    weapons: Record<WeaponDef['id'], GLTF>,
    somaSkeleton: Skeleton,
    referencePose: Pose,
    somaHipsHeight: number,
  ) {
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    this.root.add(model);
    this.root.scale.setScalar(somaHipsHeight / Retargeter.bindHipsHeight(model));
    this.root.updateMatrixWorld(true);
    const prepare = (object: Object3D, envMapIntensity: number) =>
      object.traverse((o) => {
        o.frustumCulled = false;
        if (!(o as Mesh).isMesh) return;
        const mesh = o as Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const material = mesh.material as MeshStandardMaterial;
        material.envMapIntensity = envMapIntensity;
        // Tripo packs occlusion, roughness and metalness into one ORM texture; glTF only wires up
        // roughness/metalness, so use its red channel as the ambient-occlusion map too.
        if (!material.aoMap && material.roughnessMap && material.roughnessMap === material.metalnessMap) {
          material.aoMap = material.roughnessMap;
          material.aoMapIntensity = 1;
        }
        setAnisotropy(material, 8);
        addRimLight(material);
      });
    prepare(model, 1.1);

    this.retargeter = new Retargeter(model, somaSkeleton, referencePose);
    const bone = (name: string) => this.retargeter.bones.get(name)!;
    this.spine = ['Spine', 'Spine1', 'Spine2'].map(bone);
    this.chest = bone('Spine2');
    this.neck = bone('Neck');
    this.head = bone('Head');

    this.held = Object.fromEntries(
      Object.entries(weapons).map(([id, weaponGltf]) => {
        const group = new Group();
        group.add(weaponGltf.scene);
        prepare(weaponGltf.scene, 1.3);
        this.root.add(group);
        return [id, { def: WEAPONS[id as WeaponDef['id']], group }];
      }),
    ) as Record<WeaponDef['id'], HeldWeapon>;
    this.mountMarkers();

    // Bind-pose body forward: elbows flex toward it (the A-pose bind has straight arms).
    const p = (n: string) => bone(n).getWorldPosition(new Vector3());
    const bindForward = new Vector3().crossVectors(p('LeftUpLeg').sub(p('RightUpLeg')), UP).normalize();
    const handBind = (side: 'Left' | 'Right'): HandBind => {
      const hand = bone(`${side}Hand`);
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
        arm: measureHingeChain(bone(`${side}Arm`), bone(`${side}ForeArm`), hand, bindForward),
        fingersLocal: toLocal(fingers),
        palmLocal: toLocal(palm),
        fingers: FINGERS.map(chain),
        thumb: chain('Thumb'),
        rest: [...FINGERS, 'Thumb'].flatMap((n) => chain(n)).map((b) => [b, b.quaternion.clone()] as [Bone, Quaternion]),
      };
    };
    this.hands = { left: handBind('Left'), right: handBind('Right') };
  }

  get activeWeapon(): WeaponDef {
    return this.held[this.activeId].def;
  }

  /** Swaps to the other weapon: the current one is lowered and slung, the new one brought up. */
  setWeapon(id: WeaponDef['id']): boolean {
    if (id === this.activeId || !this.held[id]) return false;
    this.activeId = id;
    this.swap = 0;
    this.mountMarkers();
    return true;
  }

  get swapping(): boolean {
    return this.swap < 1;
  }

  private mountMarkers(): void {
    const { def, group } = this.held[this.activeId];
    const mount = (marker: Object3D, at: Vector3 | undefined) => {
      group.add(marker);
      marker.position.copy(at ?? def.points.muzzle);
    };
    mount(this.muzzle, def.points.muzzle);
    mount(this.sight, def.points.sight);
    mount(this.port, def.points.port);
    mount(this.laser, def.points.laser);
    mount(this.rear, def.points.rear);
  }

  /** IK diagnostics (wrist miss distance, required vs available reach, torso clearance), for tests. */
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
    return Math.min(...points.map(toAxis)) - TORSO_RADIUS;
  }

  // Scratch
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly q = new Quaternion();
  private readonly weaponQ = new Quaternion();
  private readonly weaponPos = new Vector3();

  /** Poses the body from MotionBricks, then layers aim, weapon placement and hand IK on top. */
  update(pose: Pose, groundOffset: Vector3, aim: AimState, dt = 1 / 60): void {
    this.root.updateMatrixWorld(true);
    // The root group's scale is folded into bone lengths; positions come straight from SOMA.
    this.retargeter.apply(pose, groundOffset);
    const { def, group } = this.held[this.activeId];
    const stance = def.stance;
    // Swapping: the weapon comes up from a low carry.
    this.swap = Math.min(1, this.swap + dt / AIM.swapSeconds);
    const raise = this.swap * this.swap * (3 - 2 * this.swap);
    const weight = aim.weight * raise;

    // Body axes from the hips.
    const left = this.retargeter.bones.get('LeftUpLeg')!.getWorldPosition(new Vector3());
    const across = left.sub(this.retargeter.bones.get('RightUpLeg')!.getWorldPosition(new Vector3()));
    const bodyForward = this.fwd.crossVectors(across, UP).normalize();
    if (aim.crouch > 1e-3) this.crouch(aim.crouch, bodyForward);

    // 1. Twist the spine toward the aim (yaw), then pitch.
    const aimYaw = Math.atan2(aim.direction.x, aim.direction.z);
    const bodyYaw = Math.atan2(bodyForward.x, bodyForward.z);
    const yawError = Math.max(-AIM.maxYaw, Math.min(AIM.maxYaw, Math.atan2(Math.sin(aimYaw - bodyYaw), Math.cos(aimYaw - bodyYaw))));
    const follow = Math.max(weight, aim.bodyFollow);
    const pitch = Math.asin(Math.max(-1, Math.min(1, aim.direction.y))) * weight;
    for (let i = 0; i < this.spine.length; i++) {
      rotateWorld(this.spine[i], this.q.setFromAxisAngle(UP, yawError * follow * AIM.spineShare[i]));
    }
    // Blade the torso (turn it right of the aim) so the support shoulder comes forward.
    const blade = MathUtils.lerp(stance.bladeReady, stance.bladeAim, weight) * Math.max(follow, 0.6);
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
    // Lean into the gun: the chest tips toward the firing shoulder and a little forward, which
    // brings the head over the stock (the cheek weld then only has to tilt it slightly).
    rotateWorld(this.chest, this.q.setFromAxisAngle(facing, stance.lean.side * weight));
    rotateWorld(this.chest, this.q.setFromAxisAngle(sideAxis, -stance.lean.forward * weight));
    // Head looks down the aim.
    rotateWorld(this.neck, this.q.setFromAxisAngle(sideAxis, pitch * 0.15));
    rotateWorld(this.head, this.q.setFromAxisAngle(sideAxis, pitch * 0.05));

    // 2. Roll the support collarbone forward, then place the weapon.
    const clavicle = this.retargeter.bones.get('LeftShoulder')!;
    const armJoint = this.retargeter.bones.get('LeftArm')!;
    const out = armJoint.getWorldPosition(new Vector3()).sub(clavicle.getWorldPosition(new Vector3())).normalize();
    rotateWorld(clavicle, this.q.setFromUnitVectors(out, out.clone().lerp(facing, stance.protract).normalize()));

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
      .applyAxisAngle(UP, stance.readyYaw)
      .applyAxisAngle(sideAxis, stance.readyPitch)
      .normalize();
    const readyQ = frameAxes(readyDir, UP);
    this.weaponQ.slerpQuaternions(readyQ, aimQ, weight);
    // Recoil: kick up and back.
    const weaponLeft = new Vector3(1, 0, 0).applyQuaternion(this.weaponQ);
    this.weaponQ.premultiply(this.q.setFromAxisAngle(weaponLeft, -aim.recoil * stance.recoilPitch));
    // The anchor (butt pad / tube underside) sits in the shoulder pocket, just inboard of the right
    // shoulder joint, in both poses; aiming then brings the head down onto the stock (below).
    const shoulder = this.retargeter.bones.get('RightArm')!.getWorldPosition(new Vector3());
    const atShoulder = (offset: Vector3) =>
      shoulder.clone()
        .addScaledVector(body.right, offset.x)
        .addScaledVector(UP, offset.y)
        .addScaledVector(body.forward, offset.z);
    const anchorWorld = atShoulder(new Vector3().lerpVectors(stance.pocketReady, stance.pocketAim, weight));
    // While swapping, the weapon dips low before coming up; recoil pushes it back.
    anchorWorld.addScaledVector(UP, -(1 - raise) * 0.25);
    anchorWorld.addScaledVector(new Vector3(0, 0, 1).applyQuaternion(this.weaponQ), -aim.recoil * stance.recoilPush);
    this.weaponPos.copy(def.points.anchor).applyQuaternion(this.weaponQ).negate().add(anchorWorld);
    this.setWorld(group, this.weaponPos, this.weaponQ);
    this.cheekWeld(def, weight, body.right, body.forward);

    // The other weapon rides diagonally across the back.
    for (const other of Object.values(this.held)) {
      if (other === this.held[this.activeId]) continue;
      const { back, up, side, roll } = other.def.sling;
      const along = UP.clone().applyAxisAngle(body.forward, roll);
      const slungQ = frameAxes(along, body.forward.clone().negate());
      const center = chestPos.clone().addScaledVector(body.forward, -back).addScaledVector(UP, up).addScaledVector(body.right, side);
      this.setWorld(other.group, center, slungQ);
    }

    // 3. Hands onto the weapon.
    const wF = new Vector3(0, 0, 1).applyQuaternion(this.weaponQ);
    const wU = new Vector3(0, 1, 0).applyQuaternion(this.weaponQ);
    const wR = new Vector3().crossVectors(wF, wU); // weapon right
    const point = (local: Vector3) => local.clone().applyQuaternion(this.weaponQ).add(this.weaponPos);
    this.placeHand(this.hands.right, def.grips.right, point(def.points.grip), wF, wU, wR, pocket(stance.rightElbow));
    this.placeHand(this.hands.left, def.grips.left, point(def.points.foregrip), wF, wU, wR, pocket(stance.leftElbow));
  }

  /** The eye, from the head bone and the stance's eye offset (torso axes). */
  private eyeWorld(def: WeaponDef, right: Vector3, forward: Vector3): Vector3 {
    const { eye } = def.stance;
    return this.head.getWorldPosition(new Vector3()).addScaledVector(right, eye.x).addScaledVector(UP, eye.y).addScaledVector(forward, eye.z);
  }

  /**
   * Cheek weld: turn the neck and head so the eye drops onto the sight line, `eyeRelief` behind the
   * sight, as a shooter lowers their head to the stock.
   */
  private cheekWeld(def: WeaponDef, weight: number, right: Vector3, forward: Vector3): void {
    const aimDir = new Vector3(0, 0, 1).applyQuaternion(this.weaponQ);
    const sight = def.points.sight.clone().applyQuaternion(this.weaponQ).add(this.weaponPos);
    const desired = sight.clone().addScaledVector(aimDir, -def.stance.eyeRelief);
    if (weight > 1e-3) {
      for (const [joint, share] of [[this.neck, 0.6], [this.head, 1]] as const) {
        const pivot = joint.getWorldPosition(new Vector3());
        const from = this.eyeWorld(def, right, forward).sub(pivot);
        const to = desired.clone().sub(pivot);
        const turn = new Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
        const angle = 2 * Math.acos(Math.min(1, Math.abs(turn.w)));
        const limited = Math.min(angle, CHEEK_LIMIT) / Math.max(angle, 1e-6);
        rotateWorld(joint, new Quaternion().slerp(turn, share * weight * limited));
      }
    }
    // Diagnostics: how far the eye is from the sight line, and the weapon's clearance from the torso.
    const eye = this.eyeWorld(def, right, forward);
    const toEye = eye.clone().sub(sight);
    const eyeGap = toEye.addScaledVector(aimDir, -toEye.dot(aimDir)).length();
    // The butt pad touches the shoulder by design; what must stay out of the body is the stock and grip.
    const stock = [def.points.anchor.clone().lerp(def.points.grip, 0.5), def.points.grip].map((p) =>
      p.clone().applyQuaternion(this.weaponQ).add(this.weaponPos),
    );
    this.weaponDebug = { eyeGap: +eyeGap.toFixed(3), clearance: +Math.min(...stock.map((p) => this.torsoDistance(p))).toFixed(3) };
  }

  /** Weapon placement diagnostics (eye to sight line, stock clearance from the torso), for tests. */
  weaponDebug = { eyeGap: 0, clearance: 0 };

  private torsoDistance(p: Vector3): number {
    const hips = this.retargeter.bones.get('Hips')!.getWorldPosition(new Vector3());
    const neck = this.neck.getWorldPosition(new Vector3());
    const axis = neck.clone().sub(hips);
    const t = Math.min(Math.max(p.clone().sub(hips).dot(axis) / axis.lengthSq(), 0), 1);
    return p.distanceTo(hips.clone().addScaledVector(axis, t)) - TORSO_RADIUS;
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

  /** Places a weapon group in world space (weapons are modeled at real-world size). */
  private setWorld(object: Object3D, position: Vector3, rotation: Quaternion): void {
    const parent = this.root;
    parent.updateMatrixWorld(true);
    object.position.copy(parent.worldToLocal(position.clone()));
    object.quaternion.copy(parent.getWorldQuaternion(new Quaternion()).invert().multiply(rotation));
    object.scale.setScalar(1 / parent.scale.x);
    object.updateMatrixWorld(true);
  }

  private placeHand(bind: HandBind, grip: GripStyle, contact: Vector3, f: Vector3, u: Vector3, r: Vector3, pole: Vector3): void {
    const fingers = grip.fingers(f, u, r).normalize();
    const palm = grip.palm(f, u, r);
    palm.addScaledVector(fingers, -palm.dot(fingers)).normalize();
    // Hand rotation: map the hand's own (fingers, palm) frame onto the grip's.
    const target = frameQuaternion(fingers, palm).multiply(frameQuaternion(bind.fingersLocal, bind.palmLocal).invert());
    // Palm surface on the grip; the wrist bone sits behind and above the palm center.
    const wrist = contact.clone()
      .addScaledVector(palm, -(grip.standoff + HAND.palmDepth))
      .addScaledVector(fingers, -HAND.palmReach);
    solveHinge(bind.arm, wrist, pole);
    setWorldQuaternion(bind.hand, target);
    const shoulder = bind.arm.upper.getWorldPosition(new Vector3());
    this.debug[bind.side] = {
      miss: +bind.hand.getWorldPosition(new Vector3()).distanceTo(wrist).toFixed(3),
      need: +shoulder.distanceTo(wrist).toFixed(3),
      reach: +(bind.arm.upperLength + bind.arm.lowerLength).toFixed(3),
      clearance: +this.armClearance(bind).toFixed(3),
    };

    // Curl the fingers around the grip (about the axis that swings them toward the palm).
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
