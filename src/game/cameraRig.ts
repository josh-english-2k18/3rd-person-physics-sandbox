import { MathUtils, Vector3, type PerspectiveCamera } from 'three';
import { RAPIER, type Physics } from '../world/physics';

/** Over-the-right-shoulder camera with an aim zoom, collision, and trauma-based shake. */

const RIG = {
  sensitivity: 0.0022,
  aimSensitivity: 0.0013,
  pitchMin: -1.2,
  pitchMax: 1.05,
  height: 1.62,
  crouchHeight: 1.2,
  hip: { distance: 2.7, shoulder: 0.55, up: 0.12, fov: 62 },
  aim: { distance: 1.25, shoulder: 0.5, up: 0.08, fov: 44 },
  sprint: { distance: 3.1, shoulder: 0.5, up: 0.1, fov: 68 },
  follow: 14,
  collisionPadding: 0.22,
};

export class CameraRig {
  yaw = Math.PI; // facing -Z initially
  pitch = -0.08;
  private aimBlend = 0;
  private sprintBlend = 0;
  private trauma = 0;
  private readonly pivot = new Vector3();
  private readonly time = { t: 0 };
  readonly forward = new Vector3();
  readonly position = new Vector3();

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly physics: Physics,
  ) {}

  look(dx: number, dy: number): void {
    const s = MathUtils.lerp(RIG.sensitivity, RIG.aimSensitivity, this.aimBlend);
    this.yaw -= dx * s;
    this.pitch = MathUtils.clamp(this.pitch - dy * s, RIG.pitchMin, RIG.pitchMax);
  }

  /** Recoil kick (radians). */
  kick(pitch: number, yaw: number): void {
    this.pitch = MathUtils.clamp(this.pitch + pitch, RIG.pitchMin, RIG.pitchMax);
    this.yaw += yaw;
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Unit vector the camera looks along. */
  direction(out = new Vector3()): Vector3 {
    return out.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  get heading(): number {
    return this.yaw;
  }

  update(dt: number, target: Vector3, aiming: boolean, sprinting: boolean, crouching: boolean, exclude: RAPIER.Collider): void {
    this.time.t += dt;
    this.aimBlend += ((aiming ? 1 : 0) - this.aimBlend) * Math.min(1, dt * 12);
    this.sprintBlend += ((sprinting && !aiming ? 1 : 0) - this.sprintBlend) * Math.min(1, dt * 4);
    const height = crouching ? RIG.crouchHeight : RIG.height;
    const goal = new Vector3(target.x, target.y + height, target.z);
    if (this.pivot.lengthSq() === 0) this.pivot.copy(goal);
    this.pivot.lerp(goal, 1 - Math.exp(-RIG.follow * dt));

    const mix = (key: 'distance' | 'shoulder' | 'up' | 'fov') =>
      MathUtils.lerp(MathUtils.lerp(RIG.hip[key], RIG.sprint[key], this.sprintBlend), RIG.aim[key], this.aimBlend);
    const forward = this.direction(this.forward);
    const right = new Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const shoulder = this.pivot.clone().addScaledVector(right, mix('shoulder')).add(new Vector3(0, mix('up'), 0));
    let distance = mix('distance');

    // Pull in if geometry is between the shoulder point and the camera.
    const back = forward.clone().negate();
    const hit = this.physics.world.castRay(
      new RAPIER.Ray(shoulder, back),
      distance + RIG.collisionPadding,
      true,
      undefined,
      undefined,
      exclude,
    );
    if (hit) distance = Math.max(0.3, hit.timeOfImpact - RIG.collisionPadding);
    // Also keep the shoulder offset itself out of walls.
    const sideHit = this.physics.world.castRay(new RAPIER.Ray(this.pivot, right), mix('shoulder') + 0.15, true, undefined, undefined, exclude);
    if (sideHit) shoulder.copy(this.pivot).addScaledVector(right, Math.max(0, sideHit.timeOfImpact - 0.15)).add(new Vector3(0, mix('up'), 0));

    this.position.copy(shoulder).addScaledVector(back, distance);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const shake = this.trauma * this.trauma;
    const t = this.time.t * 22;
    const sx = (Math.sin(t * 1.3) + Math.sin(t * 2.7) * 0.5) * shake * 0.08;
    const sy = (Math.sin(t * 1.7 + 1) + Math.sin(t * 3.1) * 0.5) * shake * 0.08;

    this.camera.position.copy(this.position).add(new Vector3(sx, sy, 0));
    this.camera.lookAt(this.position.clone().add(forward));
    this.camera.rotateZ(Math.sin(t * 0.9) * shake * 0.03);
    const fov = mix('fov');
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
