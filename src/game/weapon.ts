import { Vector3 } from 'three';
import type { Audio } from '../audio';
import type { CombatFx } from '../fx/combat';
import type { Particles } from '../fx/particles';
import { RAPIER, type Physics } from '../world/physics';
import type { Props, Surface } from '../world/props';

/** An automatic carbine: hitscan rounds with visible tracers, recoil, spread bloom, reloads. */

export const CARBINE = {
  name: 'MK18 CQBR',
  magazine: 30,
  rpm: 780,
  range: 400,
  reloadSeconds: 2.1,
  spreadHip: 0.022,
  spreadAim: 0.0035,
  bloomPerShot: 0.006,
  bloomRecovery: 6,
  kickPitch: 0.012,
  kickYaw: 0.004,
};

export interface ShotResult {
  hit: boolean;
  surface: Surface | null;
}

export class Weapon {
  ammo = CARBINE.magazine;
  reloading = 0;
  bloom = 0;
  recoil = 0;
  private cooldown = 0;
  private triggerWasDown = false;
  /** Called when a shot lands on something (for the hit marker). */
  onHit?: (surface: Surface | null) => void;
  /** Called for every round fired (muzzle flash, brass). */
  onShot?: (muzzle: Vector3, direction: Vector3) => void;

  constructor(
    private readonly physics: Physics,
    private readonly props: Props,
    private readonly particles: Particles,
    private readonly fx: CombatFx,
    private readonly audio: Audio,
  ) {}

  get spread(): number {
    return this.bloom;
  }

  reload(): void {
    if (this.reloading > 0 || this.ammo === CARBINE.magazine) return;
    this.reloading = CARBINE.reloadSeconds;
    this.audio.reload();
  }

  /**
   * @returns camera kick (pitch, yaw) for this frame, if a round was fired
   */
  update(
    dt: number,
    trigger: boolean,
    aiming: boolean,
    cameraPosition: Vector3,
    cameraDirection: Vector3,
    muzzle: Vector3,
    exclude: RAPIER.Collider,
  ): { pitch: number; yaw: number } | null {
    this.cooldown -= dt;
    this.recoil = Math.max(0, this.recoil - dt * 9);
    const baseSpread = aiming ? CARBINE.spreadAim : CARBINE.spreadHip;
    this.bloom += (baseSpread - this.bloom) * Math.min(1, dt * CARBINE.bloomRecovery);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        this.reloading = 0;
        this.ammo = CARBINE.magazine;
      }
      return null;
    }
    const pressed = trigger && !this.triggerWasDown;
    this.triggerWasDown = trigger;
    if (!trigger || this.cooldown > 0) return null;
    if (this.ammo <= 0) {
      if (pressed) this.audio.dryFire();
      this.reload();
      return null;
    }
    this.cooldown = 60 / CARBINE.rpm;
    this.ammo--;
    this.fire(cameraPosition, cameraDirection, muzzle, exclude);
    this.bloom += CARBINE.bloomPerShot;
    this.recoil = Math.min(1, this.recoil + 0.55);
    if (this.ammo === 0) setTimeout(() => this.reload(), 250);
    return { pitch: CARBINE.kickPitch * (aiming ? 0.6 : 1), yaw: (Math.random() - 0.5) * CARBINE.kickYaw * 2 };
  }

  private fire(cameraPosition: Vector3, cameraDirection: Vector3, muzzle: Vector3, exclude: RAPIER.Collider): void {
    // Aim from the camera (what the crosshair sees), with spread.
    const dir = cameraDirection.clone();
    const r = this.bloom * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    const right = new Vector3().crossVectors(dir, new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(right, dir);
    dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    const world = this.physics.world;
    const camHit = world.castRayAndGetNormal(new RAPIER.Ray(cameraPosition, dir), CARBINE.range, true, undefined, undefined, exclude);
    let target = cameraPosition.clone().addScaledVector(dir, camHit ? camHit.timeOfImpact : CARBINE.range);

    // Then from the muzzle to that point, so cover in front of the barrel blocks the shot.
    const toTarget = target.clone().sub(muzzle);
    const distance = toTarget.length();
    const shotDir = toTarget.normalize();
    const hit = world.castRayAndGetNormal(new RAPIER.Ray(muzzle, shotDir), distance + 0.05, true, undefined, undefined, exclude);

    this.particles.muzzle(muzzle, shotDir);
    this.fx.flash(muzzle.clone().addScaledVector(shotDir, 0.7), 14, 0.05, '#ffb062', 7);
    this.audio.gunshot();
    this.onShot?.(muzzle, shotDir);

    if (!hit) {
      this.fx.tracer(muzzle, target);
      this.onHit?.(null);
      return;
    }
    target = muzzle.clone().addScaledVector(shotDir, hit.timeOfImpact);
    const normal = new Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    this.fx.tracer(muzzle, target);
    const surface = this.props.bulletHit(hit.collider.handle, target, shotDir);
    const metal = surface === 'metal';
    this.particles.impact(target, normal, metal);
    this.audio.impact(target, metal);
    if (!surface) this.fx.decal(target, normal); // static level geometry
    this.onHit?.(surface);
  }
}
