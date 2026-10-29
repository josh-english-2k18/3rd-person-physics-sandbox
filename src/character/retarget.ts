import { Bone, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { computeWorldPose, createWorldPose, type Pose, type Skeleton, type WorldPose } from '../motion/skeleton';

/**
 * Retargets SOMA motion (MotionBricks' 77-joint skeleton) onto a Mixamo-rigged mesh.
 *
 * Calibration puts both rigs in the "same posture": for every mapped bone we build an orthonormal
 * frame from the bone's direction (toward its child) and a secondary axis, measured once on the
 * Mixamo bind pose and once on a SOMA reference pose. The rotation between the two frames gives
 * the Mixamo bone's world rotation in the SOMA reference posture, from which a constant offset
 * follows. Each frame: worldMixamo = worldSoma * offset. Unmapped bones (fingers) keep their bind
 * pose relative to their parent, so the operator's gripping hands are preserved.
 */

type Secondary = 'across' | 'forward' | 'hand';

interface BoneSpec {
  mixamo: string;
  soma: string;
  /** Child joints that define the bone direction, on each rig. */
  mixamoChild: string;
  somaChild: string;
  secondary: Secondary;
  /** Calibrate from another bone's direction (rigs disagree on where a head "points"). */
  directionFrom?: [mixamo: string, mixamoChild: string, soma: string, somaChild: string];
}

const sides = (spec: (s: 'Left' | 'Right') => BoneSpec[]) => [...spec('Left'), ...spec('Right')];

/** Parent-first order. */
const BONES: BoneSpec[] = [
  { mixamo: 'Hips', soma: 'Hips', mixamoChild: 'Spine', somaChild: 'Spine1', secondary: 'across' },
  { mixamo: 'Spine', soma: 'Spine1', mixamoChild: 'Spine1', somaChild: 'Spine2', secondary: 'across' },
  { mixamo: 'Spine1', soma: 'Spine2', mixamoChild: 'Spine2', somaChild: 'Chest', secondary: 'across' },
  { mixamo: 'Spine2', soma: 'Chest', mixamoChild: 'Neck', somaChild: 'Neck1', secondary: 'across' },
  { mixamo: 'Neck', soma: 'Neck1', mixamoChild: 'Head', somaChild: 'Head', secondary: 'across', directionFrom: ['Spine1', 'Neck', 'Spine2', 'Neck1'] },
  { mixamo: 'Head', soma: 'Head', mixamoChild: 'HeadTop_End', somaChild: 'HeadEnd', secondary: 'across', directionFrom: ['Spine1', 'Neck', 'Spine2', 'Neck1'] },
  ...sides((s) => [
    { mixamo: `${s}Shoulder`, soma: `${s}Shoulder`, mixamoChild: `${s}Arm`, somaChild: `${s}Arm`, secondary: 'forward' },
    { mixamo: `${s}Arm`, soma: `${s}Arm`, mixamoChild: `${s}ForeArm`, somaChild: `${s}ForeArm`, secondary: 'forward' },
    { mixamo: `${s}ForeArm`, soma: `${s}ForeArm`, mixamoChild: `${s}Hand`, somaChild: `${s}Hand`, secondary: 'forward' },
    { mixamo: `${s}Hand`, soma: `${s}Hand`, mixamoChild: `${s}HandMiddle1`, somaChild: `${s}HandMiddle1`, secondary: 'hand' },
    { mixamo: `${s}UpLeg`, soma: `${s}Leg`, mixamoChild: `${s}Leg`, somaChild: `${s}Shin`, secondary: 'across' },
    { mixamo: `${s}Leg`, soma: `${s}Shin`, mixamoChild: `${s}Foot`, somaChild: `${s}Foot`, secondary: 'across' },
    { mixamo: `${s}Foot`, soma: `${s}Foot`, mixamoChild: `${s}ToeBase`, somaChild: `${s}ToeBase`, secondary: 'across' },
    { mixamo: `${s}ToeBase`, soma: `${s}ToeBase`, mixamoChild: `${s}Toe_End`, somaChild: `${s}ToeEnd`, secondary: 'across' },
  ]),
];

/** Mixamo bone name without the "mixamorig:" prefix and Sketchfab "_NN" suffix. */
export const mixamoName = (name: string) => name.replace(/^mixamorig\d*:?/, '').replace(/_\d+$/, '');

interface Frame {
  primary: Vector3;
  secondary: Vector3;
}

function basis({ primary, secondary }: Frame): Quaternion {
  const x = primary.clone().normalize();
  const y = secondary.clone().addScaledVector(x, -secondary.dot(x)).normalize();
  const z = new Vector3().crossVectors(x, y);
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

export class Retargeter {
  readonly bones = new Map<string, Bone>();
  private readonly specs: { bone: Bone; soma: number; offset: Quaternion }[] = [];
  private readonly hips: Bone;
  private readonly world: WorldPose;
  private readonly somaSkeleton: Skeleton;

  constructor(root: Object3D, somaSkeleton: Skeleton, referencePose: Pose) {
    this.somaSkeleton = somaSkeleton;
    this.world = createWorldPose(somaSkeleton.count);
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if ((o as Bone).isBone) this.bones.set(mixamoName(o.name), o as Bone);
    });
    const bone = (name: string) => {
      const b = this.bones.get(name);
      if (!b) throw new Error(`Character is missing bone ${name}`);
      return b;
    };
    this.hips = bone('Hips');

    // Mixamo bind pose (world space).
    const mPos = (name: string) => bone(name).getWorldPosition(new Vector3());
    const mAcross = mPos('LeftUpLeg').sub(mPos('RightUpLeg')).normalize();
    const mForward = new Vector3().crossVectors(mAcross, new Vector3(0, 1, 0)).normalize();

    // SOMA reference pose.
    const sWorld = computeWorldPose(somaSkeleton, referencePose, createWorldPose(somaSkeleton.count));
    const sPos = (name: string) => new Vector3().fromArray(sWorld.pos, somaSkeleton.joint(name) * 3);
    const sAcross = sPos('LeftLeg').sub(sPos('RightLeg')).normalize();
    const sForward = new Vector3().crossVectors(sAcross, new Vector3(0, 1, 0)).normalize();

    for (const spec of BONES) {
      const side = spec.mixamo.startsWith('Left') ? 'Left' : 'Right';
      const secondaryOf = (pos: (n: string) => Vector3, across: Vector3, forward: Vector3) =>
        spec.secondary === 'across' ? across : spec.secondary === 'forward' ? forward : pos(`${side}HandIndex1`).sub(pos(`${side}HandPinky1`));
      const [mFrom, mTo, sFrom, sTo] = spec.directionFrom ?? [spec.mixamo, spec.mixamoChild, spec.soma, spec.somaChild];
      const mFrame = basis({ primary: mPos(mTo).sub(mPos(mFrom)), secondary: secondaryOf(mPos, mAcross, mForward) });
      const sFrame = basis({ primary: sPos(sTo).sub(sPos(sFrom)), secondary: secondaryOf(sPos, sAcross, sForward) });
      // Mixamo bone's world rotation once posed like the SOMA reference.
      const calibrated = sFrame.clone().multiply(mFrame.clone().invert()).multiply(bone(spec.mixamo).getWorldQuaternion(new Quaternion()));
      const somaIndex = somaSkeleton.joint(spec.soma);
      const somaRot = new Quaternion().fromArray(sWorld.rot, somaIndex * 4);
      this.specs.push({ bone: bone(spec.mixamo), soma: somaIndex, offset: somaRot.invert().multiply(calibrated) });
    }
  }

  /** World-space hips height of the character's bind pose, for scaling against SOMA. */
  static bindHipsHeight(root: Object3D): number {
    root.updateMatrixWorld(true);
    let height = 1;
    root.traverse((o) => {
      if ((o as Bone).isBone && mixamoName(o.name) === 'Hips') height = o.getWorldPosition(new Vector3()).y;
    });
    return height;
  }

  /** Poses the character from a SOMA pose whose root is already in world space. */
  apply(pose: Pose, offset: Vector3): void {
    const world = computeWorldPose(this.somaSkeleton, pose, this.world);
    for (const { bone, soma, offset: rotOffset } of this.specs) {
      const parent = bone.parent!;
      parent.updateWorldMatrix(true, false);
      parent.matrixWorld.decompose(tp, tq, ts);
      const target = q.fromArray(world.rot, soma * 4).multiply(rotOffset);
      bone.quaternion.copy(tq.invert().multiply(target));
      if (bone === this.hips) {
        const p = v.fromArray(world.pos, 0).add(offset);
        bone.position.copy(parent.worldToLocal(p));
      }
      bone.updateMatrixWorld(true);
    }
  }
}

const tp = new Vector3();
const tq = new Quaternion();
const ts = new Vector3();
const q = new Quaternion();
const v = new Vector3();
