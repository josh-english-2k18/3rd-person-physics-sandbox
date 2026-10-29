import { Quaternion, Vector3 } from 'three';
import type { Pose } from './skeleton';

/** A rigid delta transform (motionbricks/utils/pose_utils.py). */
export interface Delta {
  p: Vector3;
  q: Quaternion;
}

const IDENTITY = new Quaternion();
const qa = new Quaternion();
const qb = new Quaternion();
const qc = new Quaternion();
const va = new Vector3();

/** Shortest-path slerp from identity to `q` by `t`. */
function partial(q: Quaternion, t: number, out: Quaternion): Quaternion {
  return out.copy(IDENTITY).slerp(q, t);
}

/** compute_delta_transform(src, dst) = inv(src) * dst, for one joint of two poses. */
export function computeDelta(src: Pose, dst: Pose, joint: number): Delta {
  const srcQ = new Quaternion().fromArray(src.rot, joint * 4);
  const inv = srcQ.clone().invert();
  const p = new Vector3().fromArray(dst.pos, joint * 3).sub(va.fromArray(src.pos, joint * 3)).applyQuaternion(inv);
  const q = inv.multiply(qa.fromArray(dst.rot, joint * 4)).normalize();
  return { p, q };
}

/** apply_delta_transform(T, d, w) = T * blend(identity, d, w), in place on one joint. */
export function applyDelta(pose: Pose, joint: number, delta: Delta, weight: number): void {
  const w = Math.min(Math.max(weight, 0), 1);
  const q = qa.fromArray(pose.rot, joint * 4);
  va.copy(delta.p).multiplyScalar(w).applyQuaternion(q);
  pose.pos[joint * 3] += va.x;
  pose.pos[joint * 3 + 1] += va.y;
  pose.pos[joint * 3 + 2] += va.z;
  q.multiply(partial(delta.q, w, qb)).normalize().toArray(pose.rot, joint * 4);
}

/** compute_root_endpoint_delta: world-space position offset plus a local rotation delta. */
export function computeRootDelta(generated: Pose, guide: Pose): Delta {
  const p = new Vector3().fromArray(guide.pos, 0).sub(va.fromArray(generated.pos, 0));
  const q = new Quaternion().fromArray(generated.rot, 0).normalize().invert();
  q.multiply(qa.fromArray(guide.rot, 0).normalize()).normalize();
  return { p, q };
}

/** apply_root_endpoint_correction: fades the start delta out and the end delta in. */
export function applyRootCorrection(pose: Pose, start: Delta, end: Delta, endWeight: number): void {
  const s = 1 - endWeight;
  qa.fromArray(pose.rot, 0)
    .multiply(partial(start.q, s, qb))
    .multiply(partial(end.q, endWeight, qc))
    .normalize()
    .toArray(pose.rot, 0);
  pose.pos[0] += start.p.x * s + end.p.x * endWeight;
  pose.pos[1] += start.p.y * s + end.p.y * endWeight;
  pose.pos[2] += start.p.z * s + end.p.z * endWeight;
}
