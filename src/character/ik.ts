import { Matrix4, Quaternion, Vector3, type Bone } from 'three';

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const t = new Vector3();
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const decomp = { p: new Vector3(), q: new Quaternion(), s: new Vector3() };

export function worldQuaternion(bone: Bone, out = new Quaternion()): Quaternion {
  bone.updateWorldMatrix(true, false);
  bone.matrixWorld.decompose(decomp.p, out, decomp.s);
  return out;
}

/** Sets a bone's world rotation (its parent's world matrix must be current). */
export function setWorldQuaternion(bone: Bone, world: Quaternion): void {
  bone.parent!.matrixWorld.decompose(decomp.p, tmpQ, decomp.s);
  bone.quaternion.copy(tmpQ.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/** Rotates a bone in world space by `delta` (applied on the world side). */
export function rotateWorld(bone: Bone, delta: Quaternion): void {
  const world = worldQuaternion(bone, tmpQ2);
  setWorldQuaternion(bone, world.premultiply(delta));
}

/** Swings `bone` so the direction from it to `child` points at `target`. */
function aimBone(bone: Bone, child: Bone, target: Vector3): void {
  bone.getWorldPosition(a);
  child.getWorldPosition(b);
  const from = b.sub(a).normalize();
  const to = c.copy(target).sub(a).normalize();
  rotateWorld(bone, tmpQ.setFromUnitVectors(from, to));
}

/**
 * Analytic two-bone IK: places `end` at `target`, bending the middle joint toward `pole`.
 * Bone lengths come from the current skeleton.
 */
export function solveTwoBone(root: Bone, mid: Bone, end: Bone, target: Vector3, pole: Vector3): void {
  const rootPos = root.getWorldPosition(new Vector3());
  const midPos = mid.getWorldPosition(new Vector3());
  const endPos = end.getWorldPosition(new Vector3());
  const upper = rootPos.distanceTo(midPos);
  const lower = midPos.distanceTo(endPos);
  t.copy(target).sub(rootPos);
  const dist = Math.min(Math.max(t.length(), 1e-4), (upper + lower) * 0.9999);
  const dir = t.normalize();
  // Bend plane: perpendicular to dir, toward the pole.
  const poleDir = c.copy(pole).sub(rootPos);
  poleDir.addScaledVector(dir, -poleDir.dot(dir));
  if (poleDir.lengthSq() < 1e-8) poleDir.set(0, -1, 0).addScaledVector(dir, -dir.y);
  poleDir.normalize();
  const cosA = (upper * upper + dist * dist - lower * lower) / (2 * upper * dist);
  const angle = Math.acos(Math.min(Math.max(cosA, -1), 1));
  const elbow = rootPos.clone().addScaledVector(dir, Math.cos(angle) * upper).addScaledVector(poleDir, Math.sin(angle) * upper);
  aimBone(root, mid, elbow);
  aimBone(mid, end, rootPos.clone().addScaledVector(dir, dist));
}

/** A rotation from an orthonormal frame built from a primary and a secondary direction. */
export function frameQuaternion(primary: Vector3, secondary: Vector3, out = new Quaternion()): Quaternion {
  const x = a.copy(primary).normalize();
  const y = b.copy(secondary).addScaledVector(x, -secondary.dot(x)).normalize();
  const z = c.crossVectors(x, y);
  return out.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/**
 * A two-bone limb with a hinge joint (elbow / knee), measured once from the bind pose (from the bend
 * when the joint is bent, otherwise from a supplied flexion direction). Solving keeps the hinge anatomical: the upper bone is twisted so the middle joint
 * flexes about its own axis instead of bending sideways (which crumples the mesh).
 */
export interface HingeChain {
  upper: Bone;
  lower: Bone;
  end: Bone;
  upperLength: number;
  lowerLength: number;
  /** Bone directions and hinge axis in each bone's local frame. */
  upperAxis: Vector3;
  upperHinge: Vector3;
  lowerAxis: Vector3;
  lowerHinge: Vector3;
}

export function measureHingeChain(upper: Bone, lower: Bone, end: Bone, flexToward?: Vector3): HingeChain {
  const s = upper.getWorldPosition(new Vector3());
  const e = lower.getWorldPosition(new Vector3());
  const w = end.getWorldPosition(new Vector3());
  const d1 = e.clone().sub(s).normalize();
  const d2 = w.clone().sub(e).normalize();
  // A bind pose with a straight limb (T/A-pose) doesn't reveal the hinge: fall back to the
  // anatomical flexion direction (`flexToward`, e.g. the body's forward for elbows).
  const bent = d1.angleTo(d2) > 0.25;
  const hinge = (bent || !flexToward ? new Vector3().crossVectors(d1, d2) : new Vector3().crossVectors(d1, flexToward)).normalize();
  const toLocal = (bone: Bone, v: Vector3) => v.clone().applyQuaternion(worldQuaternion(bone).invert()).normalize();
  return {
    upper,
    lower,
    end,
    upperLength: s.distanceTo(e),
    lowerLength: e.distanceTo(w),
    upperAxis: toLocal(upper, e.clone().sub(s)),
    upperHinge: toLocal(upper, hinge),
    lowerAxis: toLocal(lower, w.clone().sub(e)),
    lowerHinge: toLocal(lower, hinge),
  };
}

/** Places `chain.end` at `target`, with the middle joint toward `pole`, flexing about its real hinge. */
export function solveHinge(chain: HingeChain, target: Vector3, pole: Vector3): void {
  const s = chain.upper.getWorldPosition(new Vector3());
  const { upperLength: a, lowerLength: b } = chain;
  const toTarget = target.clone().sub(s);
  const dist = Math.min(Math.max(toTarget.length(), Math.abs(a - b) + 1e-3), (a + b) * 0.999);
  const dir = toTarget.normalize();
  const bend = pole.clone().sub(s);
  bend.addScaledVector(dir, -bend.dot(dir));
  if (bend.lengthSq() < 1e-8) bend.set(0, -1, 0).addScaledVector(dir, -dir.y);
  bend.normalize();
  const cosA = (a * a + dist * dist - b * b) / (2 * a * dist);
  const angle = Math.acos(Math.min(Math.max(cosA, -1), 1));
  const elbow = s.clone().addScaledVector(dir, Math.cos(angle) * a).addScaledVector(bend, Math.sin(angle) * a);
  const wrist = s.clone().addScaledVector(dir, dist);
  const d1 = elbow.clone().sub(s).normalize();
  const d2 = wrist.clone().sub(elbow).normalize();
  // Flexion axis of the bent limb (same orientation convention as measured in the bind pose).
  const hinge = new Vector3().crossVectors(d1, d2);
  if (hinge.lengthSq() < 1e-8) hinge.crossVectors(d1, bend);
  hinge.normalize();
  const orient = (axis: Vector3, localAxis: Vector3, localHinge: Vector3) =>
    frameQuaternion(axis, hinge, new Quaternion()).multiply(frameQuaternion(localAxis, localHinge, new Quaternion()).invert());
  setWorldQuaternion(chain.upper, orient(d1, chain.upperAxis, chain.upperHinge));
  setWorldQuaternion(chain.lower, orient(d2, chain.lowerAxis, chain.lowerHinge));
}
