import { Vector2, Vector3 } from 'three';
import type { Soldier } from '../character/soldier';
import { JUMP_RUNUP, LocomotionController, type LocomotionInput } from '../motion/locomotion';
import type { MotionPlayer } from '../motion/player';
import { clonePose, type Pose } from '../motion/skeleton';
import { RAPIER, type Physics } from '../world/physics';

/**
 * The player character: MotionBricks decides how the body moves; a Rapier kinematic capsule
 * decides where it may go. Each frame the generated root motion is fed to the character
 * controller, and whatever the world blocks is pushed back into the motion player so the next
 * generation starts from where the character actually is.
 */

const BODY = {
  radius: 0.3,
  halfHeight: 0.55,
  stepHeight: 0.38,
  maxSlope: (50 * Math.PI) / 180,
  gravity: 20,
};

/**
 * Input assist: the capsule closes this fraction of the gap between the requested velocity and the
 * generated root velocity, so WASD lands instantly while the animation catches up. The extra
 * displacement is folded back into the motion, so the next generation starts where the body is.
 */
const VAULT = {
  minHeight: 0.25,
  maxHeight: 1.05,
  reach: 2.6, // look this far ahead for an obstacle
  landing: 1.4, // needs clear ground this far past its near face
  jumpApexAhead: 1.3, // with nothing to vault, the apex lands this far ahead
};

const ASSIST = {
  strength: 0.55,
  maxSpeed: 2.2, // m/s of help at most
  brake: 0.4,
};

export interface PlayerInput {
  move: Vector2; // camera-relative: x = right, y = forward
  cameraHeading: number;
  aimDirection: Vector3;
  aiming: boolean;
  sprint: boolean;
  crouch: boolean;
  recoil: number;
}

export class PlayerCharacter {
  readonly collider: RAPIER.Collider;
  private readonly body: RAPIER.RigidBody;
  private readonly controller: RAPIER.KinematicCharacterController;
  readonly locomotion: LocomotionController;
  readonly pose: Pose;
  readonly contacts = new Float32Array(4);
  private readonly previousContacts = new Float32Array(4);
  /** Feet position in the world (bottom of the capsule). */
  readonly position = new Vector3();
  private groundY = 0;
  private verticalVelocity = 0;
  private readonly velocity = new Vector2();
  private aimWeight = 0;
  private bodyFollow = 0;
  private crouchWeight = 0;
  onFootstep?: (at: Vector3, weight: number) => void;

  constructor(
    private readonly physics: Physics,
    private readonly motion: MotionPlayer,
    private readonly soldier: Soldier,
    locomotion: LocomotionController,
    spawn: Vector3,
    heading: number,
  ) {
    this.locomotion = locomotion;
    this.pose = motion.skeleton.createPose();
    locomotion.start(new Vector3(spawn.x, 0, spawn.z), heading, this.pose);

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + BODY.halfHeight + BODY.radius, spawn.z),
    );
    this.collider = physics.world.createCollider(RAPIER.ColliderDesc.capsule(BODY.halfHeight, BODY.radius), this.body);
    this.controller = physics.world.createCharacterController(0.02);
    this.controller.enableAutostep(BODY.stepHeight, 0.15, true);
    this.controller.enableSnapToGround(0.45);
    this.controller.setMaxSlopeClimbAngle(BODY.maxSlope);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(85);
    this.position.copy(spawn);
    this.groundY = spawn.y;
  }

  /** Adds an assisted ground displacement and folds it into the playing motion. */
  private assist(desired: Vector3, delta: Vector2): void {
    desired.x += delta.x;
    desired.z += delta.y;
    this.motion.shiftRoot(delta.x, delta.y);
  }

  /**
   * Space: vault over a low obstacle ahead (0.25-1.05 m tall, with room to land), or jump.
   */
  jump(): boolean {
    // Go the way we're moving; standing still, the way the body faces.
    const heading = this.velocity.length() > 0.6 ? Math.atan2(this.velocity.x, this.velocity.y) : this.locomotion.facing;
    const dir = new Vector3(Math.sin(heading), 0, Math.cos(heading));
    const feet = this.position;
    const world = this.physics.world;
    const cast = (from: Vector3, to: Vector3, max: number) =>
      world.castRay(new RAPIER.Ray(from, to), max, true, undefined, undefined, this.collider);

    let anchor = feet.clone().addScaledVector(dir, VAULT.jumpApexAhead);
    let skipRunUp = true;
    const hit = cast(feet.clone().add(new Vector3(0, 0.4, 0)), dir, VAULT.reach);
    if (hit) {
      const face = feet.clone().add(new Vector3(0, 0.4, 0)).addScaledVector(dir, hit.timeOfImpact);
      const over = face.clone().addScaledVector(dir, 0.12);
      const down = cast(over.clone().setY(feet.y + VAULT.maxHeight + 0.3), new Vector3(0, -1, 0), VAULT.maxHeight + 0.3);
      const top = down ? feet.y + VAULT.maxHeight + 0.3 - down.timeOfImpact : Infinity;
      const height = top - feet.y;
      // Is there room to land beyond it, at about the same level?
      const beyond = face.clone().addScaledVector(dir, VAULT.landing).setY(feet.y + VAULT.maxHeight + 0.3);
      const landing = cast(beyond, new Vector3(0, -1, 0), VAULT.maxHeight + 1);
      const landingY = landing ? beyond.y - landing.timeOfImpact : -Infinity;
      const clear = !cast(feet.clone().setY(top + 0.45), dir, hit.timeOfImpact + VAULT.landing);
      if (height < VAULT.minHeight) {
        // Low enough to just jump over.
      } else if (height <= VAULT.maxHeight && clear && Math.abs(landingY - feet.y) < 0.35) {
        anchor = over;
        // Only aim for the run-up pose when it is comfortably ahead; otherwise go straight for the leap.
        skipRunUp = hit.timeOfImpact < JUMP_RUNUP + 0.8;
      } else {
        return false; // too tall or no room: don't leap into a wall
      }
    }
    return this.locomotion.vault(anchor, heading, skipRunUp);
  }

  get groundOffset(): Vector3 {
    return new Vector3(0, this.groundY, 0);
  }

  get motionPlayer(): MotionPlayer {
    return this.motion;
  }

  update(dt: number, input: PlayerInput): void {
    // 1. Steering: camera-relative input into world XZ.
    const h = input.cameraHeading;
    const forward = new Vector2(Math.sin(h), Math.cos(h));
    const right = new Vector2(-Math.cos(h), Math.sin(h));
    const move = forward.multiplyScalar(input.move.y).add(right.multiplyScalar(input.move.x));
    if (move.lengthSq() > 1) move.normalize();
    const aimHeading = Math.atan2(input.aimDirection.x, input.aimDirection.z);
    const loco: LocomotionInput = { move, aimHeading, sprint: input.sprint && !input.aiming, crouch: input.crouch, aiming: input.aiming };
    const ground = new Vector3(this.pose.pos[0], 0, this.pose.pos[2]);
    this.locomotion.update(loco, dt, ground, this.velocity);

    // 2. Advance the generated motion.
    const before = new Vector2(this.pose.pos[0], this.pose.pos[2]);
    this.previousContacts.set(this.contacts);
    this.motion.sample(dt, this.pose, this.contacts);
    const desired = new Vector3(this.pose.pos[0] - this.position.x, 0, this.pose.pos[2] - this.position.z);
    const wanted = this.locomotion.desiredVelocity;
    if (wanted.lengthSq() > 0) {
      const generated = new Vector2(desired.x, desired.z).divideScalar(Math.max(dt, 1e-4));
      const help = wanted.clone().sub(generated).multiplyScalar(ASSIST.strength);
      // Only help in the direction the player is pushing (never fight the motion's own steps).
      const along = help.dot(wanted) / wanted.length();
      if (along > 0) this.assist(desired, help.clampLength(0, ASSIST.maxSpeed).multiplyScalar(dt));
    } else if (this.locomotion.status.state === 'idle') {
      // Keys released: shave off some of the generated run-out so stops feel crisp.
      const generated = new Vector2(desired.x, desired.z);
      if (generated.length() / Math.max(dt, 1e-4) > 0.3) this.assist(desired, generated.multiplyScalar(-ASSIST.brake));
    }

    // 3. Move the capsule through the world (with gravity), and hand any blocked motion back.
    //    While vaulting, the motion owns the path: the capsule follows it straight over the obstacle.
    const t = this.body.translation();
    let moved = { x: desired.x, y: 0, z: desired.z };
    if (this.locomotion.vaulting) {
      this.verticalVelocity = 0;
    } else {
      this.verticalVelocity -= BODY.gravity * dt;
      desired.y = this.verticalVelocity * dt;
      this.controller.computeColliderMovement(this.collider, desired);
      moved = this.controller.computedMovement();
      if (this.controller.computedGrounded()) this.verticalVelocity = 0;
    }
    const next = { x: t.x + moved.x, y: t.y + moved.y, z: t.z + moved.z };
    // Teleport the kinematic body now (frames can outpace the fixed physics step).
    this.body.setTranslation(next, true);
    this.physics.world.propagateModifiedBodyPositionsToColliders();
    this.position.set(next.x, next.y - BODY.halfHeight - BODY.radius, next.z);
    const blockedX = moved.x - (desired.x);
    const blockedZ = moved.z - (desired.z);
    if (Math.abs(blockedX) > 1e-5 || Math.abs(blockedZ) > 1e-5) this.motion.shiftRoot(blockedX, blockedZ);
    this.pose.pos[0] = this.position.x;
    this.pose.pos[2] = this.position.z;
    this.velocity.set(this.pose.pos[0] - before.x, this.pose.pos[2] - before.y).divideScalar(Math.max(dt, 1e-4));

    // Smooth the visual ground height (stairs step the capsule; the body should glide).
    this.groundY += (this.position.y - this.groundY) * (1 - Math.exp(-dt * 18));

    // 4. Record what is shown: it becomes the next generation's context.
    this.motion.recordPose(dt, clonePose(this.pose));

    // 5. Pose the soldier, with the aim layer.
    const vaulting = this.locomotion.vaulting;
    const aiming = input.aiming && !vaulting ? 1 : 0;
    this.aimWeight += (aiming - this.aimWeight) * Math.min(1, dt * 14);
    const mode = this.locomotion.status.mode;
    const follow = input.aiming || mode === 'strafe' || mode === 'crouchAim' ? 1 : 0;
    this.crouchWeight += ((input.crouch && !vaulting ? 1 : 0) - this.crouchWeight) * Math.min(1, dt * 9);
    this.bodyFollow += (follow - this.bodyFollow) * Math.min(1, dt * 6);
    this.soldier.update(this.pose, this.groundOffset, {
      direction: input.aimDirection,
      weight: this.aimWeight,
      bodyFollow: this.bodyFollow,
      recoil: input.recoil,
      crouch: this.crouchWeight * this.crouchWeight * (3 - 2 * this.crouchWeight),
    });

    // Footsteps on heel strikes.
    for (const c of [0, 2]) {
      if (this.contacts[c] > 0.5 && this.previousContacts[c] <= 0.5 && this.velocity.length() > 0.3) {
        this.onFootstep?.(this.position, Math.min(1, this.velocity.length() / 3));
      }
    }
  }
}
