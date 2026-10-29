import { Quaternion, Vector3 } from 'three';

/**
 * A pose holds one local transform per joint: translation (x, y, z) and rotation quaternion
 * (x, y, z, w), packed into flat arrays so poses are cheap to copy, blend, and store.
 */
export interface Pose {
  pos: Float32Array; // joints * 3
  rot: Float32Array; // joints * 4
}

export class Skeleton {
  readonly names: string[];
  readonly parents: Int32Array;
  readonly rest: Pose;
  private readonly index = new Map<string, number>();

  constructor(names: string[], parents: ArrayLike<number>, rest: Pose) {
    this.names = names;
    this.parents = Int32Array.from(parents);
    this.rest = rest;
    names.forEach((name, i) => this.index.set(name, i));
    for (let i = 0; i < names.length; i++) {
      if (this.parents[i] >= i) throw new Error('Skeleton joints must be ordered parent-first.');
    }
  }

  get count(): number {
    return this.names.length;
  }

  joint(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`Skeleton has no joint "${name}".`);
    return i;
  }

  createPose(): Pose {
    return clonePose(this.rest);
  }
}

export function createPose(joints: number): Pose {
  const rot = new Float32Array(joints * 4);
  for (let i = 0; i < joints; i++) rot[i * 4 + 3] = 1;
  return { pos: new Float32Array(joints * 3), rot };
}

export function clonePose(pose: Pose): Pose {
  return { pos: pose.pos.slice(), rot: pose.rot.slice() };
}

export function copyPose(src: Pose, dst: Pose): Pose {
  dst.pos.set(src.pos);
  dst.rot.set(src.rot);
  return dst;
}

const qa = new Quaternion();
const qb = new Quaternion();

/** Linear position / spherical rotation blend of two poses into `out` (which may alias `a`). */
export function blendPoses(a: Pose, b: Pose, t: number, out: Pose): Pose {
  const joints = a.rot.length / 4;
  for (let i = 0; i < joints * 3; i++) out.pos[i] = a.pos[i] + (b.pos[i] - a.pos[i]) * t;
  for (let j = 0; j < joints; j++) {
    qa.fromArray(a.rot, j * 4);
    qb.fromArray(b.rot, j * 4);
    qa.slerp(qb, t).toArray(out.rot, j * 4);
  }
  return out;
}

/** World (model-space) transforms of every joint. */
export interface WorldPose {
  pos: Float32Array;
  rot: Float32Array;
}

const pq = new Quaternion();
const lq = new Quaternion();
const pv = new Vector3();
const lv = new Vector3();

/** Forward kinematics: local pose -> world pose, with an optional root transform applied first. */
export function computeWorldPose(skeleton: Skeleton, pose: Pose, out: WorldPose): WorldPose {
  const { parents } = skeleton;
  for (let j = 0; j < skeleton.count; j++) {
    const p = parents[j];
    lv.fromArray(pose.pos, j * 3);
    lq.fromArray(pose.rot, j * 4);
    if (p < 0) {
      lv.toArray(out.pos, j * 3);
      lq.toArray(out.rot, j * 4);
      continue;
    }
    pq.fromArray(out.rot, p * 4);
    pv.fromArray(out.pos, p * 3);
    lv.applyQuaternion(pq).add(pv).toArray(out.pos, j * 3);
    pq.multiply(lq).normalize().toArray(out.rot, j * 4);
  }
  return out;
}

export function createWorldPose(joints: number): WorldPose {
  return createPose(joints);
}
