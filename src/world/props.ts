import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import type { Audio } from '../audio';
import type { CombatFx } from '../fx/combat';
import { randomUnit, type Particles } from '../fx/particles';
import { createGridMaterial } from '../render/gridMaterial';
import { Physics, RAPIER } from './physics';

/**
 * Everything you can shoot: physics crates that splinter, red barrels that explode (and chain),
 * hinged steel plates that ring, glass panes that shatter, cans, a cube pyramid, a plank tower,
 * and heavy balls.
 */

export type Surface = 'metal' | 'concrete' | 'wood' | 'glass';

export interface Prop {
  body: RAPIER.RigidBody | null;
  mesh: Mesh;
  surface: Surface;
  kind?: 'barrel';
  health: number;
  onDestroyed?: (prop: Prop, point: Vector3) => void;
  dead?: boolean;
}

export interface PropEvents {
  /** Camera shake / chromatic shock request, 0..1 */
  shake(amount: number, at: Vector3): void;
}

const IMPULSE = { bullet: 2.2, explosion: 38, explosionRadius: 7.5 };

const PROP_COLORS = {
  crate: ['#e8762b', '#d4d7dc', '#2f6fb3'],
  plate: '#f2f2f2',
  barrel: '#b3221c',
};

function barrelTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.fillStyle = PROP_COLORS.barrel;
  g.fillRect(0, 0, 256, 256);
  for (const y of [40, 210]) {
    g.fillStyle = '#7e1410';
    g.fillRect(0, y, 256, 8);
  }
  // Hazard band
  g.fillStyle = '#f2c230';
  g.fillRect(0, 100, 256, 50);
  g.fillStyle = '#1b1b1b';
  for (let x = -60; x < 300; x += 40) {
    g.beginPath();
    g.moveTo(x, 150);
    g.lineTo(x + 20, 150);
    g.lineTo(x + 50, 100);
    g.lineTo(x + 30, 100);
    g.fill();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export class Props {
  readonly group = new Group();
  private readonly physics: Physics;
  private readonly particles: Particles;
  private readonly fx: CombatFx;
  private readonly audio: Audio;
  private readonly events: PropEvents;
  private readonly props: Prop[] = [];
  private readonly debris: { body: RAPIER.RigidBody; mesh: Mesh; age: number }[] = [];
  private readonly materials: Record<string, Material>;
  private pendingExplosions: { at: Vector3; delay: number }[] = [];

  constructor(physics: Physics, particles: Particles, fx: CombatFx, audio: Audio, events: PropEvents) {
    this.physics = physics;
    this.particles = particles;
    this.fx = fx;
    this.audio = audio;
    this.events = events;
    this.materials = {
      crate0: createGridMaterial({ color: PROP_COLORS.crate[0], lineColor: '#ffc08f', cell: 0.25, major: 4, lineWidth: 0.008 }),
      crate1: createGridMaterial({ color: PROP_COLORS.crate[1], lineColor: '#8d939c', cell: 0.25, major: 4, lineWidth: 0.008 }),
      crate2: createGridMaterial({ color: PROP_COLORS.crate[2], lineColor: '#9cc6f0', cell: 0.25, major: 4, lineWidth: 0.008 }),
      barrel: new MeshStandardMaterial({ map: barrelTexture(), roughness: 0.45, metalness: 0.55 }),
      barrelCap: new MeshStandardMaterial({ color: '#5d1210', roughness: 0.5, metalness: 0.6 }),
      plate: new MeshStandardMaterial({ color: PROP_COLORS.plate, roughness: 0.35, metalness: 0.6 }),
      post: new MeshStandardMaterial({ color: '#2a2c30', roughness: 0.6, metalness: 0.4 }),
      glass: new MeshPhysicalMaterial({ color: '#cfe8ff', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.28, envMapIntensity: 2.5 }),
      can: new MeshStandardMaterial({ color: '#d8dde3', roughness: 0.25, metalness: 0.9 }),
      ball: new MeshStandardMaterial({ color: '#c9ced6', roughness: 0.32, metalness: 0.15 }),
      plank: createGridMaterial({ color: '#c99a62', lineColor: '#e2bf92', cell: 0.25, major: 4, lineWidth: 0.008 }),
    };
    this.populate();
  }

  // --- Spawning ------------------------------------------------------------------------------

  private add(mesh: Mesh, collider: RAPIER.ColliderDesc, surface: Surface, health: number, mass: number, dynamic = true): Prop {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    const prop: Prop = { body: null, mesh, surface, health };
    if (dynamic) {
      const { body, collider: c } = this.physics.dynamic(mesh, collider.setFriction(0.7).setRestitution(0.15), { mass });
      prop.body = body;
      this.physics.owners.set(c.handle, prop);
    } else {
      collider.setTranslation(mesh.position.x, mesh.position.y, mesh.position.z).setRotation(mesh.quaternion);
      const c = this.physics.world.createCollider(collider);
      this.physics.owners.set(c.handle, prop);
    }
    this.props.push(prop);
    return prop;
  }

  crate(position: Vector3, size: number, variant = 0, yaw = 0): Prop {
    const mesh = new Mesh(new BoxGeometry(size, size, size), this.materials[`crate${variant}`]);
    mesh.position.copy(position);
    mesh.rotation.y = yaw;
    const prop = this.add(mesh, RAPIER.ColliderDesc.cuboid(size / 2, size / 2, size / 2), 'wood', 4 + size * 3, 18 * size ** 3);
    prop.onDestroyed = (p, at) => this.splinter(p, at, size, mesh.material as Material);
    return prop;
  }

  barrel(position: Vector3): Prop {
    const group = new Mesh(new CylinderGeometry(0.32, 0.32, 0.95, 28), [
      this.materials.barrel,
      this.materials.barrelCap,
      this.materials.barrelCap,
    ]);
    group.position.copy(position);
    const prop = this.add(group, RAPIER.ColliderDesc.cylinder(0.475, 0.32), 'metal', 3, 30);
    prop.kind = 'barrel';
    prop.onDestroyed = (_, at) => this.explode(at.clone().setY(Math.max(at.y, 0.5)));
    return prop;
  }

  steelPlate(position: Vector3, width: number, height: number): void {
    // Post and crossbar (static), plate hinged under the crossbar.
    const postGeometry = new BoxGeometry(0.08, position.y + height * 0.5 + 0.25, 0.08);
    for (const s of [-1, 1]) {
      const post = new Mesh(postGeometry, this.materials.post);
      post.position.set(position.x + s * (width / 2 + 0.12), (position.y + height * 0.5 + 0.25) / 2, position.z);
      post.castShadow = true;
      this.group.add(post);
    }
    const barY = position.y + height * 0.5 + 0.25;
    const bar = new Mesh(new BoxGeometry(width + 0.32, 0.06, 0.06), this.materials.post);
    bar.position.set(position.x, barY, position.z);
    bar.castShadow = true;
    this.group.add(bar);

    const plate = new Mesh(new BoxGeometry(width, height, 0.03), this.materials.plate);
    plate.position.copy(position);
    const prop = this.add(plate, RAPIER.ColliderDesc.cuboid(width / 2, height / 2, 0.015), 'metal', Infinity, 6);
    const anchor = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, barY, position.z));
    const joint = RAPIER.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: barY - position.y, z: 0 }, { x: 1, y: 0, z: 0 });
    this.physics.world.createImpulseJoint(joint, anchor, prop.body!, true);
    prop.body!.setAngularDamping(0.6);
  }

  glassPane(position: Vector3, width: number, height: number, yaw: number): void {
    const pane = new Mesh(new BoxGeometry(width, height, 0.02), this.materials.glass);
    pane.position.copy(position);
    pane.rotation.y = yaw;
    pane.castShadow = false;
    const prop = this.add(pane, RAPIER.ColliderDesc.cuboid(width / 2, height / 2, 0.01), 'glass', 1, 0, false);
    prop.onDestroyed = (p, at) => this.shatter(p, at, width, height);
    // Frame
    const frame = new Mesh(new BoxGeometry(width + 0.1, 0.1, 0.1), this.materials.post);
    frame.position.copy(position).setY(position.y - height / 2 - 0.05);
    frame.rotation.y = yaw;
    this.group.add(frame);
  }

  private populate(): void {
    // Center: cube pyramid
    const size = 0.7;
    for (let level = 0; level < 5; level++) {
      for (let i = 0; i < 5 - level; i++) {
        this.crate(new Vector3(-((4 - level) * size) / 2 + i * size, size / 2 + level * size, -2), size * 0.98, (level + i) % 3);
      }
    }
    // Barrels scattered around the arena (some clusters for chain reactions)
    for (const [x, z] of [[6, -5], [6.8, -5.4], [6.3, -4.4], [-7, 4], [-7.6, 4.8], [14, 14], [-14, -10], [18, -6], [-3, 15], [24, 6]]) {
      this.barrel(new Vector3(x, 0.48, z));
    }
    // Crate stacks near the NW platform and NE towers
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) this.crate(new Vector3(-16 + i * 1.05, 0.5 + j * 1.0, -15), 1, (i + j) % 3, 0);
    for (let i = 0; i < 6; i++) this.crate(new Vector3(18 + (i % 3) * 1.3, 0.6, -14 + Math.floor(i / 3) * 1.3), 1.2, 1, i * 0.4);
    // Plank tower (jenga)
    for (let level = 0; level < 10; level++) {
      for (let k = 0; k < 3; k++) {
        const plank = new Mesh(new BoxGeometry(level % 2 ? 0.3 : 1.0, 0.2, level % 2 ? 1.0 : 0.3), this.materials.plank);
        const off = (k - 1) * 0.34;
        plank.position.set(12 + (level % 2 ? off : 0), 0.1 + level * 0.2, 4 + (level % 2 ? 0 : off));
        const prop = this.add(plank, RAPIER.ColliderDesc.cuboid(plank.geometry.parameters.width / 2, 0.1, plank.geometry.parameters.depth / 2), 'wood', 6, 2);
        prop.onDestroyed = (p, at) => this.splinter(p, at, 0.3, this.materials.plank);
      }
    }
    // Shooting range: steel plates and cans on stands, glass panes
    for (let i = -2; i <= 2; i++) {
      const x = i * 5;
      this.steelPlate(new Vector3(x - 1.2, 1.2, 36), 0.6, 0.6);
      this.steelPlate(new Vector3(x + 1.2, 1.6, 34), 0.45, 0.45);
      // Table with cans
      const table = new Mesh(new BoxGeometry(2.2, 0.08, 0.7), this.materials.post);
      table.position.set(x, 0.95, 27);
      table.castShadow = table.receiveShadow = true;
      this.group.add(table);
      this.physics.fixedBox(table.position, new Vector3(1.1, 0.04, 0.35));
      for (let c = 0; c < 5; c++) {
        const can = new Mesh(new CylinderGeometry(0.06, 0.06, 0.2, 16), this.materials.can);
        can.position.set(x - 0.8 + c * 0.4, 1.1, 27);
        this.add(can, RAPIER.ColliderDesc.cylinder(0.1, 0.06), 'metal', Infinity, 0.15);
      }
    }
    for (let i = 0; i < 4; i++) this.glassPane(new Vector3(-30 + i * 2.2, 1.6, 0), 2, 2.4, 0);
    for (let i = 0; i < 3; i++) this.glassPane(new Vector3(30, 1.4, 6 + i * 2.2), 2, 2, Math.PI / 2);
    // Heavy balls
    for (let i = 0; i < 6; i++) {
      const r = 0.35 + (i % 3) * 0.15;
      const ball = new Mesh(new SphereGeometry(r, 32, 16), this.materials.ball);
      ball.position.set(-20 + (i % 3) * 1.8, r + 0.01, 8 + Math.floor(i / 3) * 1.8);
      this.add(ball, RAPIER.ColliderDesc.ball(r).setRestitution(0.5), 'concrete', Infinity, 40 * r ** 3);
    }
  }

  // --- Damage --------------------------------------------------------------------------------

  /** A bullet hit something. Returns the surface type for impact effects. */
  bulletHit(handle: number, point: Vector3, direction: Vector3): Surface | null {
    const prop = this.physics.owners.get(handle) as Prop | undefined;
    if (!prop || prop.dead) return null;
    if (prop.body) {
      prop.body.applyImpulseAtPoint(direction.clone().multiplyScalar(IMPULSE.bullet), point, true);
    }
    this.damage(prop, 1, point);
    return prop.surface;
  }

  private damage(prop: Prop, amount: number, at: Vector3): void {
    prop.health -= amount;
    if (prop.health <= 0 && !prop.dead) {
      prop.dead = true;
      this.remove(prop);
      prop.onDestroyed?.(prop, at.clone().copy(prop.mesh.position));
    }
  }

  private remove(prop: Prop): void {
    this.group.remove(prop.mesh);
    if (prop.body) this.physics.remove(prop.body);
    else {
      for (const [handle, owner] of this.physics.owners) {
        if (owner === prop) {
          const collider = this.physics.world.getCollider(handle);
          if (collider) this.physics.world.removeCollider(collider, false);
          this.physics.owners.delete(handle);
        }
      }
    }
    const i = this.props.indexOf(prop);
    if (i >= 0) this.props.splice(i, 1);
  }

  explode(at: Vector3): void {
    this.particles.explosion(at);
    this.fx.blast(at, 0);
    this.fx.flash(at.clone().setY(at.y + 0.8), 900, 0.6, '#ff8a3d', 30);
    this.audio.explosion(at);
    this.events.shake(1, at);
    for (const prop of [...this.props]) {
      const d = prop.mesh.position.distanceTo(at);
      if (d > IMPULSE.explosionRadius) continue;
      const falloff = 1 - d / IMPULSE.explosionRadius;
      if (prop.body) {
        const dir = prop.mesh.position.clone().sub(at).add(new Vector3(0, 0.6, 0)).normalize();
        const mass = prop.body.mass();
        prop.body.applyImpulse(dir.multiplyScalar(IMPULSE.explosion * falloff * Math.min(mass, 30) * 0.2 + falloff * 4), true);
        prop.body.applyTorqueImpulse(randomUnit().multiplyScalar(falloff * mass * 0.5), true);
      }
      if (prop.surface === 'glass') this.damage(prop, 1, prop.mesh.position);
      else if (prop.kind === 'barrel') {
        // Chain reaction: neighbouring barrels go off a beat later.
        if (!prop.dead && falloff > 0.25) {
          prop.dead = true;
          this.remove(prop);
          this.pendingExplosions.push({ at: prop.mesh.position.clone(), delay: 0.12 + Math.random() * 0.2 });
        }
      } else if (Number.isFinite(prop.health) && falloff > 0.5) {
        this.damage(prop, 6 * falloff, prop.mesh.position);
      }
    }
    for (const piece of this.debris) {
      const dir = piece.mesh.position.clone().sub(at);
      const d = dir.length();
      if (d < IMPULSE.explosionRadius) piece.body.applyImpulse(dir.normalize().multiplyScalar((1 - d / IMPULSE.explosionRadius) * 3), true);
    }
  }

  private splinter(prop: Prop, at: Vector3, size: number, material: Material): void {
    this.audio.crunch(at);
    const pieces = size > 0.5 ? 3 : 2;
    const piece = size / pieces;
    const origin = prop.mesh.position;
    const q = prop.mesh.quaternion;
    const geometry = new BoxGeometry(piece * 0.96, piece * 0.96, piece * 0.96);
    for (let x = 0; x < pieces; x++) for (let y = 0; y < pieces; y++) for (let z = 0; z < pieces; z++) {
      const local = new Vector3((x + 0.5) * piece - size / 2, (y + 0.5) * piece - size / 2, (z + 0.5) * piece - size / 2);
      this.spawnDebris(geometry, material, origin.clone().add(local.applyQuaternion(q)), q, piece, local.clone().normalize().multiplyScalar(2.5));
    }
    this.particles.debris(origin, new Color('#a59a8a'));
  }

  private shatter(prop: Prop, at: Vector3, width: number, height: number): void {
    this.audio.shatter(at);
    const q = prop.mesh.quaternion;
    const cols = 5;
    const rows = 6;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const w = (width / cols) * (0.6 + Math.random() * 0.5);
      const h = (height / rows) * (0.6 + Math.random() * 0.5);
      const geometry = new BoxGeometry(w, h, 0.02);
      const local = new Vector3((i + 0.5) * (width / cols) - width / 2, (j + 0.5) * (height / rows) - height / 2, 0).applyQuaternion(q);
      const pos = prop.mesh.position.clone().add(local);
      const away = pos.clone().sub(at).setY(0).normalize().multiplyScalar(1 + Math.random() * 2);
      this.spawnDebris(geometry, this.materials.glass, pos, q, 0.05, away);
    }
    for (let i = 0; i < 30; i++) {
      this.particles.glow.spawn({
        position: prop.mesh.position.clone().add(randomUnit().multiplyScalar(0.8)),
        velocity: randomUnit().multiplyScalar(3),
        color: new Color(1.5, 1.8, 2.2),
        size: 0.025,
        life: 0.6,
        gravity: 9,
        stretch: 1,
      });
    }
  }

  private spawnDebris(geometry: BufferGeometry, material: Material, position: Vector3, rotation: Quaternion, size: number, velocity: Vector3): void {
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.quaternion.copy(rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    const params = (geometry as BoxGeometry).parameters;
    const { body } = this.physics.dynamic(
      mesh,
      RAPIER.ColliderDesc.cuboid(params.width / 2, params.height / 2, params.depth / 2).setFriction(0.8),
      { mass: Math.max(0.05, size * 6) },
    );
    body.setLinvel(velocity.add(randomUnit().multiplyScalar(0.8)), true);
    body.setAngvel(randomUnit().multiplyScalar(6), true);
    this.debris.push({ body, mesh, age: 0 });
    if (this.debris.length > 260) this.removeDebris(0);
  }

  private removeDebris(index: number): void {
    const [piece] = this.debris.splice(index, 1);
    this.group.remove(piece.mesh);
    this.physics.remove(piece.body);
  }

  update(dt: number): void {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const piece = this.debris[i];
      piece.age += dt;
      if (piece.age > 10) {
        const s = Math.max(0, 1 - (piece.age - 10) / 1.5);
        piece.mesh.scale.setScalar(s);
        if (s <= 0) this.removeDebris(i);
      }
    }
    for (let i = this.pendingExplosions.length - 1; i >= 0; i--) {
      const e = this.pendingExplosions[i];
      e.delay -= dt;
      if (e.delay <= 0) {
        this.pendingExplosions.splice(i, 1);
        this.explode(e.at);
      }
    }
  }
}
