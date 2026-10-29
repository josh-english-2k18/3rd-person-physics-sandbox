import { Vector2, Vector3 } from 'three';
import type { Soldier } from '../character/soldier';
import { LocomotionController, type LocomotionInput } from '../motion/locomotion';
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

    // 3. Move the capsule through the world (with gravity), and hand any blocked motion back.
    this.verticalVelocity -= BODY.gravity * dt;
    desired.y = this.verticalVelocity * dt;
    this.controller.computeColliderMovement(this.collider, desired);
    const moved = this.controller.computedMovement();
    if (this.controller.computedGrounded()) this.verticalVelocity = 0;
    const t = this.body.translation();
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
    const aiming = input.aiming ? 1 : 0;
    this.aimWeight += (aiming - this.aimWeight) * Math.min(1, dt * 14);
    const follow = input.aiming || this.locomotion.status.mode !== 'jog' ? 1 : 0;
    this.bodyFollow += (follow - this.bodyFollow) * Math.min(1, dt * 6);
    this.soldier.update(this.pose, this.groundOffset, {
      direction: input.aimDirection,
      weight: this.aimWeight,
      bodyFollow: this.bodyFollow,
      recoil: input.recoil,
    });

    // Footsteps on heel strikes.
    for (const c of [0, 2]) {
      if (this.contacts[c] > 0.5 && this.previousContacts[c] <= 0.5 && this.velocity.length() > 0.3) {
        this.onFootstep?.(this.position, Math.min(1, this.velocity.length() / 3));
      }
    }
  }
}
