import RAPIER from '@dimforge/rapier3d-compat';
import { Object3D, Quaternion, Vector3 } from 'three';

export { RAPIER };

/** Rapier world plus the bookkeeping that keeps dynamic bodies and their meshes in sync. */
export class Physics {
  readonly world: RAPIER.World;
  private readonly synced: { body: RAPIER.RigidBody; object: Object3D }[] = [];
  /** Collider handle -> gameplay owner (props register here so bullets can find them). */
  readonly owners = new Map<number, unknown>();
  private accumulator = 0;
  static readonly STEP = 1 / 60;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = Physics.STEP;
  }

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  fixedBox(position: Vector3, half: Vector3, rotation = new Quaternion()): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(position.x, position.y, position.z)
      .setRotation(rotation)
      .setFriction(0.9);
    return this.world.createCollider(desc);
  }

  /** Adds a dynamic body whose transform is copied onto `object` every frame. */
  dynamic(object: Object3D, collider: RAPIER.ColliderDesc, options: { mass?: number; ccd?: boolean } = {}) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(object.position.x, object.position.y, object.position.z)
        .setRotation(object.quaternion)
        .setCcdEnabled(options.ccd ?? false)
        .setLinearDamping(0.05)
        .setAngularDamping(0.2),
    );
    if (options.mass !== undefined) collider.setMass(options.mass);
    const created = this.world.createCollider(collider, body);
    this.synced.push({ body, object });
    return { body, collider: created };
  }

  remove(body: RAPIER.RigidBody): void {
    const i = this.synced.findIndex((s) => s.body === body);
    if (i >= 0) this.synced.splice(i, 1);
    for (let c = 0; c < body.numColliders(); c++) this.owners.delete(body.collider(c).handle);
    this.world.removeRigidBody(body);
  }

  /** Steps the simulation at a fixed rate and syncs meshes. Returns the number of steps taken. */
  step(dt: number): number {
    this.accumulator = Math.min(this.accumulator + dt, Physics.STEP * 4);
    let steps = 0;
    while (this.accumulator >= Physics.STEP) {
      this.world.step();
      this.accumulator -= Physics.STEP;
      steps++;
    }
    for (const { body, object } of this.synced) {
      const t = body.translation();
      const r = body.rotation();
      object.position.set(t.x, t.y, t.z);
      object.quaternion.set(r.x, r.y, r.z, r.w);
    }
    return steps;
  }
}
