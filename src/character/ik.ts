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
