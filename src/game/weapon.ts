import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PointLight,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Audio } from '../audio';
import { WEAPONS, type FireProfile, type WeaponDef } from '../character/weapons';
import type { CombatFx } from '../fx/combat';
import { randomUnit, type Particles } from '../fx/particles';
import { RAPIER, type Physics } from '../world/physics';
import type { Props, Surface } from '../world/props';

/**
 * The operator's arsenal: a hitscan bullpup (tracers, recoil, spread bloom) and a launcher that
 * fires a physical rocket (smoke trail, backblast, explosion on impact). Each weapon keeps its own
 * magazine; swapping cancels a reload.
 */

const RANGE = 400;
const BLOOM_RECOVERY = 6;
const ROCKET = { speed: 58, gravity: 1.2, life: 4, trailEvery: 0.012 };

interface Rocket {
  object: Group;
  light: PointLight;
  position: Vector3;
  velocity: Vector3;
  age: number;
  trail: number;
}

export class Arsenal {
  readonly ammo: Record<WeaponDef['id'], number> = { bullpup: WEAPONS.bullpup.fire.magazine, launcher: WEAPONS.launcher.fire.magazine };
  active: WeaponDef['id'] = 'bullpup';
  reloading = 0;
  bloom = 0;
  recoil = 0;
  private cooldown = 0;
  private triggerWasDown = false;
  private readonly rockets: Rocket[] = [];
  readonly group = new Group();
  /** Called when a shot lands on something (for the hit marker). */
  onHit?: (surface: Surface | null) => void;
  /** Called for every round fired (muzzle flash, brass). */
  onShot?: (profile: FireProfile, muzzle: Vector3, direction: Vector3) => void;
  /** Called when a rocket detonates (camera shake). */
  onExplode?: (at: Vector3) => void;

  constructor(
    private readonly physics: Physics,
    private readonly props: Props,
    private readonly particles: Particles,
    private readonly fx: CombatFx,
    private readonly audio: Audio,
  ) {}

  get profile(): FireProfile {
    return WEAPONS[this.active].fire;
  }

  get spread(): number {
    return this.bloom;
  }

  get magazine(): number {
    return this.ammo[this.active];
  }

  switchTo(id: WeaponDef['id']): void {
    if (id === this.active) return;
    this.active = id;
    this.reloading = 0;
    this.cooldown = 0.35;
  }

  reload(): void {
    if (this.reloading > 0 || this.ammo[this.active] === this.profile.magazine) return;
    this.reloading = this.profile.reloadSeconds;
    this.audio.reload();
  }

  /**
   * @param rear the launcher's rear venturi (for the backblast)
   * @returns camera kick (pitch, yaw) for this frame, if a round was fired
   */
  update(
    dt: number,
    trigger: boolean,
    aiming: boolean,
    cameraPosition: Vector3,
    cameraDirection: Vector3,
    muzzle: Vector3,
    rear: Vector3,
    exclude: RAPIER.Collider,
  ): { pitch: number; yaw: number } | null {
    this.updateRockets(dt, exclude);
    const profile = this.profile;
    this.cooldown -= dt;
    this.recoil = Math.max(0, this.recoil - dt * (profile.projectile === 'rocket' ? 3 : 9));
    const baseSpread = aiming ? profile.spreadAim : profile.spreadHip;
    this.bloom += (baseSpread - this.bloom) * Math.min(1, dt * BLOOM_RECOVERY);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        this.reloading = 0;
        this.ammo[this.active] = profile.magazine;
      }
      return null;
    }
    const pressed = trigger && !this.triggerWasDown;
    this.triggerWasDown = trigger;
    if (!(profile.automatic ? trigger : pressed) || this.cooldown > 0) return null;
    if (this.ammo[this.active] <= 0) {
      if (pressed) this.audio.dryFire();
      this.reload();
      return null;
    }
    this.cooldown = 60 / profile.rpm;
    this.ammo[this.active]--;
    const direction = this.aimDirection(cameraPosition, cameraDirection, muzzle, exclude);
    if (profile.projectile === 'rocket') this.launch(muzzle, rear, direction);
    else this.shoot(muzzle, direction, exclude);
    this.onShot?.(profile, muzzle, direction);
    this.bloom += profile.bloomPerShot;
    this.recoil = Math.min(1, this.recoil + (profile.projectile === 'rocket' ? 1 : 0.55));
    if (this.ammo[this.active] === 0) setTimeout(() => this.reload(), profile.projectile === 'rocket' ? 450 : 250);
    return { pitch: profile.kickPitch * (aiming ? 0.6 : 1), yaw: (Math.random() - 0.5) * profile.kickYaw * 2 };
  }

  /** Aims from the camera (what the crosshair sees, with spread) and returns the muzzle-to-target direction. */
  private aimDirection(cameraPosition: Vector3, cameraDirection: Vector3, muzzle: Vector3, exclude: RAPIER.Collider): Vector3 {
    const dir = cameraDirection.clone();
    const r = this.bloom * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    const right = new Vector3().crossVectors(dir, new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(right, dir);
    dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    const hit = this.physics.world.castRay(new RAPIER.Ray(cameraPosition, dir), RANGE, true, undefined, undefined, exclude);
    const target = cameraPosition.clone().addScaledVector(dir, hit ? hit.timeOfImpact : RANGE);
    return target.sub(muzzle).normalize();
  }

  private shoot(muzzle: Vector3, shotDir: Vector3, exclude: RAPIER.Collider): void {
    // From the muzzle, so cover in front of the barrel blocks the shot.
    const hit = this.physics.world.castRayAndGetNormal(new RAPIER.Ray(muzzle, shotDir), RANGE, true, undefined, undefined, exclude);
    this.particles.muzzle(muzzle, shotDir);
    this.fx.flash(muzzle.clone().addScaledVector(shotDir, 0.7), 14, 0.05, '#ffb062', 7);
    this.audio.gunshot();
    if (!hit) {
      this.fx.tracer(muzzle, muzzle.clone().addScaledVector(shotDir, RANGE));
      this.onHit?.(null);
      return;
    }
    const target = muzzle.clone().addScaledVector(shotDir, hit.timeOfImpact);
    const normal = new Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    this.fx.tracer(muzzle, target);
    const surface = this.props.bulletHit(hit.collider.handle, target, shotDir);
    const metal = surface === 'metal';
    this.particles.impact(target, normal, metal);
    this.audio.impact(target, metal);
    if (!surface) this.fx.decal(target, normal); // static level geometry
    this.onHit?.(surface);
  }

  // --- Rockets ----------------------------------------------------------------------------------

  private launch(muzzle: Vector3, rear: Vector3, direction: Vector3): void {
    const object = rocketMesh();
    const position = muzzle.clone().addScaledVector(direction, 0.15);
    object.position.copy(position);
    object.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), direction);
    const light = new PointLight('#ff9a4a', 30, 9, 2);
    object.add(light);
    this.group.add(object);
    this.rockets.push({ object, light, position, velocity: direction.clone().multiplyScalar(ROCKET.speed), age: 0, trail: 0 });

    // Muzzle flash and the backblast out of the rear venturi.
    this.fx.flash(muzzle.clone().addScaledVector(direction, 0.4), 60, 0.1, '#ffb062', 10);
    this.fx.flash(rear.clone().addScaledVector(direction, -1.2), 45, 0.12, '#ffa25a', 7);
    // Backblast: a cone of smoke and fire out of the venturi, thrown well back and wide.
    const back = direction.clone().negate();
    for (let i = 0; i < 22; i++) {
      this.particles.smoke.spawn({
        position: rear.clone().addScaledVector(back, 0.4 + Math.random() * 0.6),
        velocity: back.clone().multiplyScalar(5 + Math.random() * 9).add(randomUnit().multiplyScalar(2.6)),
        color: new Color().setHSL(0.08, 0.05, 0.55 + Math.random() * 0.2),
        size: 0.35 + Math.random() * 0.3,
        grow: 4,
        life: 1.4 + Math.random() * 1.2,
        drag: 3,
        gravity: -0.3,
        alpha: 0.45,
        kind: 'smoke',
      });
    }
    for (let i = 0; i < 6; i++) {
      this.particles.glow.spawn({
        position: rear.clone().addScaledVector(back, 0.3),
        velocity: back.clone().multiplyScalar(6 + Math.random() * 6).add(randomUnit().multiplyScalar(1.2)),
        color: new Color(1, 1, 1),
        size: 0.5 + Math.random() * 0.4,
        grow: 1.8,
        life: 0.22,
        drag: 4,
        kind: 'fire',
      });
    }
    this.audio.rocketLaunch();
  }

  private updateRockets(dt: number, exclude: RAPIER.Collider): void {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const rocket = this.rockets[i];
      rocket.age += dt;
      rocket.velocity.y -= ROCKET.gravity * dt;
      const step = rocket.velocity.clone().multiplyScalar(dt);
      const length = step.length();
      const dir = step.clone().divideScalar(length || 1);
      const hit = this.physics.world.castRay(new RAPIER.Ray(rocket.position, dir), length, true, undefined, undefined, exclude);
      if (hit || rocket.age > ROCKET.life) {
        const at = hit ? rocket.position.clone().addScaledVector(dir, Math.max(0, hit.timeOfImpact - 0.05)) : rocket.position.clone();
        this.detonate(at);
        this.group.remove(rocket.object);
        this.rockets.splice(i, 1);
        continue;
      }
      rocket.position.add(step);
      rocket.object.position.copy(rocket.position);
      rocket.object.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir);
      rocket.light.intensity = 24 + Math.random() * 14;
      // Exhaust: a hot core and a long smoke trail.
      rocket.trail += dt;
      while (rocket.trail > ROCKET.trailEvery) {
        rocket.trail -= ROCKET.trailEvery;
        const tail = rocket.position.clone().addScaledVector(dir, -0.35 - Math.random() * length);
        this.particles.glow.spawn({ position: tail, velocity: dir.clone().multiplyScalar(-4), color: new Color(1, 1, 1), size: 0.28, grow: 1.6, life: 0.12, kind: 'fire' });
        this.particles.smoke.spawn({
          position: tail.clone(),
          velocity: randomUnit().multiplyScalar(0.35),
          color: new Color().setHSL(0.07, 0.04, 0.72 + Math.random() * 0.12),
          size: 0.18,
          grow: 5,
          life: 2.2 + Math.random(),
          drag: 1.5,
          gravity: -0.15,
          alpha: 0.45,
          kind: 'smoke',
        });
      }
    }
  }

  private detonate(at: Vector3): void {
    this.props.explode(at);
    this.onExplode?.(at);
  }
}

/** A small finned rocket with a glowing motor (procedural: it is only seen in flight). */
function rocketMesh(): Group {
  const group = new Group();
  const olive = new MeshStandardMaterial({ color: '#4a5236', roughness: 0.6, metalness: 0.3 });
  const dark = new MeshStandardMaterial({ color: '#1d1f22', roughness: 0.5, metalness: 0.6 });
  const body = new Mesh(new CylinderGeometry(0.04, 0.04, 0.42, 14).rotateX(Math.PI / 2), olive);
  const nose = new Mesh(new ConeGeometry(0.04, 0.16, 14).rotateX(Math.PI / 2), dark);
  nose.position.z = 0.29;
  group.add(body, nose);
  for (let i = 0; i < 4; i++) {
    const fin = new Mesh(new BoxGeometry(0.004, 0.06, 0.09), dark);
    const holder = new Group();
    holder.rotation.z = (i / 4) * Math.PI * 2;
    fin.position.set(0, 0.06, -0.17);
    holder.add(fin);
    group.add(holder);
  }
  const flame = new Mesh(
    new SphereGeometry(0.06, 12, 8).scale(1, 1, 3),
    new MeshBasicMaterial({ color: new Color(6, 3.5, 1.4), blending: AdditiveBlending, transparent: true, depthWrite: false }),
  );
  flame.position.z = -0.32;
  group.add(flame);
  group.traverse((o) => ((o as Mesh).castShadow = true));
  return group;
}
