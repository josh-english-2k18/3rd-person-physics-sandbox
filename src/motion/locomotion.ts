import { Quaternion, Vector2, Vector3 } from 'three';
import type { Clip } from './bvh';
import { POSES_PER_TOKEN, SAMPLE_RATE, headingFromHips } from './engine';
import type { MotionPlayer } from './player';
import { clonePose, copyPose, createPose, type Pose, type Skeleton } from './skeleton';

/**
 * Drives MotionBricks from player input, following the Scene Preview runtime
 * (app/runtime/common/{motion,states}.py, app/runtime/soma/presets.py).
 *
 * Every generation targets four poses taken from a blend space of sample clips: placed ahead of
 * the character along the desired velocity, turned to the desired facing, and scaled to the
 * desired speed. MotionBricks fills in the motion that gets there. Standing still plays an idle
 * clip, reached through a generated transition.
 *
 * Space: Y up, meters, the ground is XZ. A heading angle θ faces (sin θ, 0, cos θ).
 */

// --- Tuning ----------------------------------------------------------------------------------

export type ModeName = 'jog' | 'strafe' | 'crouch' | 'crouchAim';

interface Mode {
  name: ModeName;
  /** 1D modes face the direction of travel; 2D modes strafe and face the aim direction. */
  directional: boolean;
  /** Crouched modes reuse the standing targets at walking pace; the crouch itself is procedural (Soldier). */
  crouched?: boolean;
  /** Normalizes speed into the blend space (the targets' natural range). */
  maxSpeed: number;
  defaultSpeed: number;
  minSpeed: number;
  velocityScale: number;
  /** Seconds of travel between the character and the target. */
  positionScale: number;
  transitionEarlyBy: number;
  tokens: number[];
}

/**
 * Locomotion generations span 8..14 tokens (1-2 s). Shorter spans and nearer targets react sooner
 * but cannot fit a whole stride, which makes the model shuffle (see gait.test.ts).
 */
const TOKENS_8_14 = [8, 9, 10, 11, 12, 13, 14];

const MODES: Record<ModeName, Mode> = {
  jog: { name: 'jog', directional: false, maxSpeed: 4.5, defaultSpeed: 2.3, minSpeed: 1.84, velocityScale: 0.97, positionScale: 1, transitionEarlyBy: 10, tokens: TOKENS_8_14 },
  // Aimed movement: a jog-pose forward target with the blend range matched to the speed, so the
  // idle center does not bleed in (half-idle, half-run poses read as hopping).
  strafe: { name: 'strafe', directional: true, maxSpeed: 2.4, defaultSpeed: 2.2, minSpeed: 1.7, velocityScale: 0.95, positionScale: 0.9, transitionEarlyBy: 8, tokens: TOKENS_8_14 },
  crouch: { name: 'crouch', directional: false, crouched: true, maxSpeed: 4.5, defaultSpeed: 1.35, minSpeed: 1.0, velocityScale: 0.97, positionScale: 1, transitionEarlyBy: 10, tokens: TOKENS_8_14 },
  crouchAim: { name: 'crouchAim', directional: true, crouched: true, maxSpeed: 2.4, defaultSpeed: 1.35, minSpeed: 1.0, velocityScale: 0.95, positionScale: 0.9, transitionEarlyBy: 8, tokens: TOKENS_8_14 },
};

const MOVEMENT = {
  // Tuned for a shooter: snappier than the Scene Preview defaults (0.15 / 0.2 / 0.6 / 0.4).
  facingHalfLife: 0.07,
  velocityDirHalfLife: 0.07,
  accelHalfLife: 0.18,
  decelHalfLife: 0.12,
  /** Starting from rest jumps straight to this fraction of the input speed. */
  startBoost: 0.85,
  speedRegenFraction: 0.15,
  minSpeedRegenFraction: 0.06,
  /** Regenerate when the desired direction drifts past ~14 degrees from the last generation. */
  dirRegenDot: 0.97,
  /** Slow down while turning harder than ~23 degrees. */
  turnSlowDot: 0.92,
  maxDirChangeReduction: 0.25,
  /** Standing still: turn in place when the aim drifts this far from the body (radians). */
  idleTurnThreshold: 0.75,
  idleTurnThresholdAiming: 0.3,
};

/** Clip windows used as blend-space targets (clip file, frame at 120 Hz). */
export const TARGET_CLIPS = {
  idle: 'idle_loop_001__A268',
  walk: 'neutral_walk_ff_180_R_002__A536_M',
  jog: 'neutral_jog_ff_180_R_001__A534',
  run: 'run_loop_180_R_003__A326',
  runFast: 'run_loop_180_R_003__A331',
  back: 'jog_ff_loop_360_R_very_fast_001__A454',
  jump: 'jump_over_obstacle_no_hand_0_75m_R_103__A416',
  left: 'jog_ff_loop_270_R_very_fast_002__A455_M',
  right: 'jog_ff_loop_270_R_very_fast_002__A455',
} as const;

// --- Pose placement ---------------------------------------------------------------------------

const UP = new Vector3(0, 1, 0);
const tv = new Vector3();
const tq = new Quaternion();
const tq2 = new Quaternion();

/** Ground position and hips-based heading of a pose (the model's own heading definition). */
export function poseFrame(skeleton: Skeleton, pose: Pose): { ground: Vector3; heading: number } {
  const hipsQ = tq.fromArray(pose.rot, 0);
  const hips = new Vector3().fromArray(pose.pos, 0);
  const right = new Vector3().fromArray(pose.pos, skeleton.joint('RightLeg') * 3).applyQuaternion(hipsQ).add(hips);
  const left = new Vector3().fromArray(pose.pos, skeleton.joint('LeftLeg') * 3).applyQuaternion(hipsQ).add(hips);
  return { ground: new Vector3(hips.x, 0, hips.z), heading: headingFromHips(right, left) };
}

/** Moves a pose's root by "remove (from, fromHeading), then place at (to, toHeading)". */
function reframe(pose: Pose, from: Vector3, fromHeading: number, to: Vector3, toHeading: number): void {
  const turn = tq2.setFromAxisAngle(UP, toHeading - fromHeading);
  tv.fromArray(pose.pos, 0).sub(from).applyQuaternion(turn).add(to).toArray(pose.pos, 0);
  tq.fromArray(pose.rot, 0).premultiply(turn).normalize().toArray(pose.rot, 0);
}

/** Four 30 Hz poses from `clip` starting at `time`, moved to the origin facing +Z (heading 0). */
function canonicalWindow(clip: Clip, time: number): Pose[] {
  const poses = Array.from({ length: POSES_PER_TOKEN }, (_, k) => clip.sample(time + k / SAMPLE_RATE, clip.skeleton.createPose()));
  const { ground, heading } = poseFrame(clip.skeleton, poses[0]);
  for (const pose of poses) reframe(pose, ground, heading, ORIGIN, 0);
  return poses;
}

const ORIGIN = new Vector3();

/** Scales the root's ground travel across the four poses to `speed` (adjust_target_pose_speed). */
function adjustSpeed(poses: Pose[], speed: number): void {
  const sx = poses[0].pos[0];
  const sz = poses[0].pos[2];
  const ex = poses[3].pos[0];
  const ez = poses[3].pos[2];
  const source = (Math.hypot(ex - sx, ez - sz) * SAMPLE_RATE) / (POSES_PER_TOKEN - 1);
  const scale = source <= 1e-6 ? 1 : speed / source;
  for (let f = 1; f < POSES_PER_TOKEN; f++) {
    poses[f].pos[0] = sx + (poses[f].pos[0] - sx) * scale;
    poses[f].pos[2] = sz + (poses[f].pos[2] - sz) * scale;
  }
}

// --- Blend spaces -----------------------------------------------------------------------------

/** Weighted sum of canonical windows, with quaternions sign-aligned to the first entry. */
function blendWindows(entries: { poses: Pose[]; weight: number }[], out: Pose[]): Pose[] {
  const used = entries.filter((e) => e.weight > 1e-4);
  for (let f = 0; f < POSES_PER_TOKEN; f++) {
    const o = out[f];
    o.pos.fill(0);
    o.rot.fill(0);
    for (const { poses, weight } of used) {
      const p = poses[f];
      for (let i = 0; i < o.pos.length; i++) o.pos[i] += p.pos[i] * weight;
      for (let j = 0; j < o.rot.length; j += 4) {
        const ref = used[0].poses[f].rot;
        const sign = ref[j] * p.rot[j] + ref[j + 1] * p.rot[j + 1] + ref[j + 2] * p.rot[j + 2] + ref[j + 3] * p.rot[j + 3] < 0 ? -1 : 1;
        for (let k = 0; k < 4; k++) o.rot[j + k] += p.rot[j + k] * weight * sign;
      }
    }
    for (let j = 0; j < o.rot.length; j += 4) {
      tq.fromArray(o.rot, j).normalize().toArray(o.rot, j);
    }
  }
  return out;
}

interface Target {
  poses: Pose[];
}

/** 1D blend space over normalized speed (Idle 0 -> Walk -> Jog -> Run 1). */
class LinearBlendSpace {
  constructor(private readonly keys: { value: number; target: Target }[]) {}

  evaluate(x: number, out: Pose[]): Pose[] {
    const { keys } = this;
    const v = Math.min(Math.max(x, keys[0].value), keys[keys.length - 1].value);
    let i = keys.findIndex((k) => k.value >= v) - 1;
    i = Math.max(0, i);
    const a = keys[i];
    const b = keys[Math.min(i + 1, keys.length - 1)];
    const w = b.value > a.value ? (v - a.value) / (b.value - a.value) : 0;
    return blendWindows([{ poses: a.target.poses, weight: 1 - w }, { poses: b.target.poses, weight: w }], out);
  }
}

/** 2D blend space over (forward, left) velocity relative to the facing, with an idle center. */
class DirectionalBlendSpace {
  private readonly sectors: { a: Target; b: Target; inv: number[] }[];
  private readonly angles: number[];

  constructor(private readonly center: Target, directions: { value: Vector2; target: Target }[]) {
    const sorted = [...directions].sort((p, q) => Math.atan2(p.value.y, p.value.x) - Math.atan2(q.value.y, q.value.x));
    this.angles = sorted.map((d) => Math.atan2(d.value.y, d.value.x));
    this.sectors = sorted.map((b, i) => {
      const a = sorted[(i - 1 + sorted.length) % sorted.length];
      const det = a.value.x * b.value.y - a.value.y * b.value.x;
      return { a: a.target, b: b.target, inv: [b.value.y / det, -b.value.x / det, -a.value.y / det, a.value.x / det] };
    });
  }

  evaluate(x: number, y: number, out: Pose[]): Pose[] {
    if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6) return blendWindows([{ poses: this.center.poses, weight: 1 }], out);
    const angle = Math.atan2(y, x);
    let upper = this.angles.findIndex((a) => a >= angle);
    if (upper < 0) upper = 0;
    const { a, b, inv } = this.sectors[upper];
    let wa = Math.max(0, inv[0] * x + inv[1] * y);
    let wb = Math.max(0, inv[2] * x + inv[3] * y);
    const total = Math.max(1, wa + wb);
    wa /= total;
    wb /= total;
    const wc = Math.max(0, 1 - wa - wb);
    return blendWindows(
      [{ poses: this.center.poses, weight: wc }, { poses: a.poses, weight: wa }, { poses: b.poses, weight: wb }],
      out,
    );
  }
}

// --- Movement ---------------------------------------------------------------------------------

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function spring(x: number, v: number, goal: number, halfLife: number, dt: number): [number, number] {
  const d = (4 * Math.LN2) / (halfLife + 1e-5);
  const y = d / 2;
  const j0 = x - goal;
  const j1 = v + j0 * y;
  const e = Math.exp(-y * dt);
  const nx = e * (j0 + j1 * dt) + goal;
  const nv = e * (v - j1 * y * dt);
  return Math.abs(nx - goal) <= 1e-4 && Math.abs(nv) <= 1e-4 ? [goal, 0] : [nx, nv];
}

function springAngle(a: number, v: number, goalAngle: number, halfLife: number, dt: number): [number, number] {
  const goal = a + wrapAngle(goalAngle - a);
  const [na, nv] = spring(a, v, goal, halfLife, dt);
  return [wrapAngle(na), nv];
}

const headingOf = (x: number, z: number) => Math.atan2(x, z);

export interface LocomotionInput {
  /** Desired movement in world XZ (length <= 1). */
  move: Vector2;
  /** Heading the camera / weapon aims at. */
  aimHeading: number;
  sprint: boolean;
  crouch: boolean;
  /** Aiming or firing: strafe to keep facing the aim. */
  aiming: boolean;
}

class MovementControl {
  facing = 0;
  facingRate = 0;
  velocityAngle = 0;
  velocityRate = 0;
  speed = 0;
  speedRate = 0;
  inputSpeed = 0;
  inputAngle = 0;
  desiredFacing = 0;
  lastInputFacing = 0;

  get velocity(): Vector2 {
    return new Vector2(Math.sin(this.velocityAngle) * this.speed, Math.cos(this.velocityAngle) * this.speed);
  }

  update(input: LocomotionInput, mode: Mode, dt: number, modeChangedFrom: Mode | null): void {
    const amount = input.move.length();
    if (!(amount > 1e-6)) {
      if (mode.directional || this.speed <= 0) this.desiredFacing = input.aimHeading;
      this.inputSpeed = 0;
    } else {
      this.inputAngle = headingOf(input.move.x, input.move.y);
      this.desiredFacing = mode.directional ? input.aimHeading : this.inputAngle;
      this.lastInputFacing = this.desiredFacing;
      const speed = input.sprint && !mode.directional && !mode.crouched ? mode.maxSpeed : mode.defaultSpeed;
      this.inputSpeed = Math.max(speed * Math.min(amount, 1), mode.minSpeed);
    }
    if (modeChangedFrom) {
      if (mode.directional) {
        this.facing = this.desiredFacing;
        this.facingRate = 0;
      }
      if (mode.maxSpeed <= modeChangedFrom.maxSpeed) {
        const s = this.reduction(mode);
        this.speed = Math.min(this.speed * s, mode.maxSpeed);
        this.speedRate *= s;
      }
    }
    if (this.inputSpeed > 0) {
      [this.velocityAngle, this.velocityRate] = springAngle(this.velocityAngle, this.velocityRate, this.inputAngle, MOVEMENT.velocityDirHalfLife, dt);
    }
    if (mode.directional) {
      [this.facing, this.facingRate] = springAngle(this.facing, this.facingRate, this.desiredFacing, MOVEMENT.facingHalfLife, dt);
    } else {
      this.facing = this.velocityAngle;
      this.facingRate = this.velocityRate;
    }
    let goal = this.inputSpeed;
    if (Math.cos(this.velocityAngle - this.inputAngle) < MOVEMENT.turnSlowDot) goal *= this.reduction(mode);
    [this.speed, this.speedRate] = spring(this.speed, this.speedRate, goal, goal > this.speed ? MOVEMENT.accelHalfLife : MOVEMENT.decelHalfLife, dt);
    if (this.speed > mode.maxSpeed) {
      this.speed = mode.maxSpeed;
      this.speedRate = Math.min(this.speedRate, 0);
    }
  }

  private reduction(mode: Mode): number {
    return 1 - MOVEMENT.maxDirChangeReduction * Math.min(Math.max(this.speed / mode.maxSpeed, 0), 1);
  }

  realign(actualVelocity: Vector2, mode: Mode): void {
    this.speed = actualVelocity.length();
    this.velocityAngle = this.speed > 1e-3 ? headingOf(actualVelocity.x, actualVelocity.y) : this.facing;
    this.velocityRate = this.speedRate = this.facingRate = 0;
    if (!mode.directional) this.facing = this.velocityAngle;
  }

  /** Starting from rest: head straight for the input and skip most of the acceleration ramp. */
  kickStart(): void {
    this.velocityAngle = this.inputAngle;
    this.speed = Math.max(this.speed, this.inputSpeed * MOVEMENT.startBoost);
    if (this.speed > 0 && Math.abs(Math.sin(this.facing - this.inputAngle)) > 0 && this.facingRate === 0) {
      // 1D modes face the direction of travel immediately.
    }
  }

  reset(): void {
    this.speed = this.speedRate = 0;
  }
}

// --- State machine ----------------------------------------------------------------------------

/**
 * The vault, after MotionBricks' jump_0_75m Smart Primitive: three target windows from a no-hands
 * hurdle clip (run-up, apex over the obstacle, run-out), hips unconstrained so the jump height comes
 * from the clip. Times are in the clip; the apex sits over the obstacle.
 */
const JUMP_STAGES = [
  { time: 1.42, transitionEarlyBy: 8 },
  { time: 2.05, transitionEarlyBy: 2 },
  { time: 3.11, transitionEarlyBy: 6 },
];
const JUMP_TOKENS = [6, 7, 8, 9, 10, 11, 12, 13, 14];
/** Distance from the run-up target to the obstacle in the clip (m). */
export const JUMP_RUNUP = 1.76;

type State = 'idle' | 'locomotion' | 'vault';

export interface LocomotionStatus {
  state: State;
  mode: ModeName;
  speed: number;
  /** The target poses of the latest generation request (drawn by the motion preview). */
  targets: Pose[];
}

export class LocomotionController {
  private readonly skeleton: Skeleton;
  private readonly player: MotionPlayer;
  private readonly clips: Map<string, Clip>;
  private readonly linear: LinearBlendSpace;
  private readonly strafe: DirectionalBlendSpace;
  private readonly movement = new MovementControl();
  private readonly blended: Pose[];
  readonly targets: Pose[];
  private state: State = 'idle';
  private mode: Mode = MODES.jog;
  private lastGenVelocity = new Vector2();
  private idleFacing = 0;
  private idleClip: Clip;
  /** Set while the transition into idle is generating/playing: the generation count to wait for. */
  private idleTransition = 0;
  private readonly jumpWindows: Pose[][];
  private vaultState: { stages: { poses: Pose[]; transitionEarlyBy: number }[]; next: number; awaiting: number; heading: number } | null = null;
  private idlePending: { velocity: Vector2; facing: number } | null = null;
  private pending = false;
  private forceRegen = false;
  /** Average inference latency in game time, used to request generations early enough. */
  private latency = 0.08;

  constructor(skeleton: Skeleton, player: MotionPlayer, clips: Map<string, Clip>) {
    this.skeleton = skeleton;
    this.player = player;
    this.clips = clips;
    const clip = (name: string) => {
      const c = clips.get(name);
      if (!c) throw new Error(`Missing MotionBricks clip ${name}`);
      return c;
    };
    const target = (name: string, frame: number): Target => ({ poses: canonicalWindow(clip(name), frame / 120) });

    this.linear = new LinearBlendSpace([
      { value: 0, target: { poses: canonicalWindow(clip(TARGET_CLIPS.walk), 0.62) } },
      { value: 2.3 / 4.5, target: target(TARGET_CLIPS.walk, 306) },
      { value: 3 / 4.5, target: target(TARGET_CLIPS.jog, 229) },
      { value: 1, target: target(TARGET_CLIPS.run, 49) },
    ]);
    this.strafe = new DirectionalBlendSpace(target(TARGET_CLIPS.idle, 0), [
      { value: new Vector2(1, 0), target: target(TARGET_CLIPS.walk, 306) },
      { value: new Vector2(-1, 0), target: target(TARGET_CLIPS.back, 107) },
      { value: new Vector2(0, 1), target: target(TARGET_CLIPS.left, 61) },
      { value: new Vector2(0, -1), target: target(TARGET_CLIPS.right, 61) },
    ]);
    this.blended = Array.from({ length: POSES_PER_TOKEN }, () => createPose(skeleton.count));
    this.targets = Array.from({ length: POSES_PER_TOKEN }, () => createPose(skeleton.count));
    this.idleClip = clip(TARGET_CLIPS.idle);

    // Vault stages, expressed with the apex over the origin and travel along +Z (heading 0).
    const jump = clip(TARGET_CLIPS.jump);
    const windows = JUMP_STAGES.map((stage) =>
      Array.from({ length: POSES_PER_TOKEN }, (_, k) => jump.sample(stage.time + k / SAMPLE_RATE, skeleton.createPose())),
    );
    const apex = new Vector3(windows[1][0].pos[0], 0, windows[1][0].pos[2]);
    const travel = Math.atan2(windows[2][0].pos[0] - windows[0][0].pos[0], windows[2][0].pos[2] - windows[0][0].pos[2]);
    for (const window of windows) for (const pose of window) reframe(pose, apex, travel, ORIGIN, 0);
    this.jumpWindows = windows;
  }

  /** The velocity the player is asking for right now (zero when there is no input). */
  get vaulting(): boolean {
    return this.state === 'vault';
  }

  /**
   * Vaults with the apex over `anchor` (ground point), travelling along `heading`. With no
   * obstacle this is simply a running jump. Returns false if a vault is already under way.
   */
  vault(anchor: Vector3, heading: number, skipRunUp: boolean): boolean {
    if (this.state === 'vault' || this.player.busy) return false;
    const stages = this.jumpWindows
      .map((window, i) => ({
        poses: window.map((pose) => {
          const placed = clonePose(pose);
          reframe(placed, ORIGIN, 0, new Vector3(anchor.x, 0, anchor.z), heading);
          return placed;
        }),
        transitionEarlyBy: JUMP_STAGES[i].transitionEarlyBy,
      }))
      .slice(skipRunUp ? 1 : 0);
    this.vaultState = { stages, next: 0, awaiting: 0, heading };
    this.state = 'vault';
    this.idleTransition = 0;
    this.idlePending = null;
    this.requestVaultStage();
    return true;
  }

  private requestVaultStage(): void {
    const v = this.vaultState!;
    const stage = v.stages[v.next++];
    stage.poses.forEach((pose, k) => copyPose(pose, this.targets[k]));
    v.awaiting = this.player.generations + 1;
    this.request(stage.transitionEarlyBy, JUMP_TOKENS);
  }

  private updateVault(dt: number, actualVelocity: Vector2): void {
    const v = this.vaultState!;
    if (this.player.busy || this.player.generations < v.awaiting) return;
    if (this.player.timeToTransition > dt + this.latency) return;
    if (v.next < v.stages.length) return this.requestVaultStage();
    // Landed: carry on running, or settle into idle.
    this.vaultState = null;
    this.movement.facing = this.movement.velocityAngle = v.heading;
    if (this.movement.inputSpeed > 0) {
      this.state = 'locomotion';
      this.movement.realign(actualVelocity, this.mode);
      this.forceRegen = true;
    } else {
      this.state = 'idle';
      this.idlePending = { velocity: actualVelocity.clone(), facing: v.heading };
    }
  }

  get desiredVelocity(): Vector2 {
    return this.state === 'locomotion' && this.movement.inputSpeed > 0 ? this.movement.velocity : new Vector2();
  }

  get status(): LocomotionStatus {
    return { state: this.state, mode: this.mode.name, speed: this.movement.speed, targets: this.targets };
  }

  /** The heading the body is turning toward (used to aim the upper body while the legs catch up). */
  get facing(): number {
    return this.state === 'idle' ? this.idleFacing : this.movement.facing;
  }

  /** Starts standing in the idle clip at `position`, facing `heading`. */
  start(position: Vector3, heading: number, out: Pose): void {
    this.movement.facing = this.movement.desiredFacing = this.movement.lastInputFacing = heading;
    this.idleFacing = heading;
    this.playIdleClip(position, heading);
    this.player.sample(0, out);
    this.player.seedHistory(out);
  }

  /** Per frame: may request a generation. `groundPosition` is where the character actually is. */
  update(input: LocomotionInput, dt: number, groundPosition: Vector3, actualVelocity: Vector2): void {
    const nextMode = input.aiming ? (input.crouch ? MODES.crouchAim : MODES.strafe) : input.crouch ? MODES.crouch : MODES.jog;
    const changedFrom = nextMode !== this.mode ? this.mode : null;
    this.mode = nextMode;
    this.movement.update(input, this.mode, dt, changedFrom);
    if (changedFrom) this.forceRegen = true;

    if (this.state === 'vault') return this.updateVault(dt, actualVelocity);

    if (this.state === 'idle') {
      if (this.movement.inputSpeed > 0) {
        this.state = 'locomotion';
        this.movement.realign(actualVelocity, this.mode);
        this.movement.kickStart();
        this.forceRegen = true;
      } else {
        if (this.player.busy) return;
        const threshold = input.aiming ? MOVEMENT.idleTurnThresholdAiming : MOVEMENT.idleTurnThreshold;
        const drift = Math.abs(wrapAngle(input.aimHeading - this.idleFacing));
        if (this.idlePending) {
          this.enterIdle(groundPosition, this.idlePending.velocity, this.idlePending.facing);
        } else if (drift > threshold) {
          this.enterIdle(groundPosition, new Vector2(), input.aimHeading);
        } else if (
          this.idleTransition &&
          this.player.generations >= this.idleTransition &&
          this.player.timeToTransition <= dt
        ) {
          this.idleTransition = 0;
          this.playIdleClip(groundPosition, this.idleFacing);
        }
        return;
      }
    }

    // Locomotion
    if (this.movement.inputSpeed <= 0) {
      this.state = 'idle';
      this.idlePending = { velocity: actualVelocity.clone(), facing: this.movement.lastInputFacing };
      if (!this.player.busy) this.enterIdle(groundPosition, actualVelocity, this.movement.lastInputFacing);
      return;
    }
    if (this.player.busy) {
      this.pending ||= this.shouldRegenerate(dt);
      return;
    }
    if (this.forceRegen || this.pending || this.shouldRegenerate(dt)) {
      this.forceRegen = this.pending = false;
      this.generateLocomotion(groundPosition);
    }
  }

  private shouldRegenerate(dt: number): boolean {
    if (this.player.timeToTransition <= dt + this.latency) return true;
    const desired = this.movement.velocity;
    const speed = this.movement.speed;
    const prev = this.lastGenVelocity.length();
    if (speed > 0 && prev <= 1e-6) return true;
    const delta = speed - prev;
    const range = delta > 0 ? this.mode.maxSpeed - prev : prev;
    const threshold = Math.max(range * MOVEMENT.speedRegenFraction, this.mode.maxSpeed * MOVEMENT.minSpeedRegenFraction);
    if (Math.abs(delta) > threshold) return true;
    if (prev <= 1e-6 || speed <= 1e-6) return false;
    return desired.dot(this.lastGenVelocity) / (speed * prev) < MOVEMENT.dirRegenDot;
  }

  private generateLocomotion(ground: Vector3): void {
    const { mode, movement } = this;
    const velocity = movement.velocity;
    const speed = velocity.length();
    if (mode.directional) {
      // Velocity relative to the facing: (forward, left). Facing +Z with Y up, left is +X.
      const f = new Vector2(Math.sin(movement.facing), Math.cos(movement.facing));
      const left = new Vector2(f.y, -f.x);
      const v = velocity.clone().divideScalar(mode.maxSpeed);
      this.strafe.evaluate(clamp1(v.dot(f)), clamp1(v.dot(left)), this.blended);
    } else {
      this.linear.evaluate(speed / mode.maxSpeed, this.blended);
    }
    adjustSpeed(this.blended, speed * mode.velocityScale);
    const lead = velocity.clone().multiplyScalar(mode.velocityScale * mode.positionScale);
    const place = new Vector3(ground.x + lead.x, 0, ground.z + lead.y);
    this.placeTargets(place, movement.facing);
    this.lastGenVelocity.copy(velocity);
    this.request(mode.transitionEarlyBy, mode.tokens);
  }

  private enterIdle(ground: Vector3, actualVelocity: Vector2, facing: number): void {
    this.movement.reset();
    this.lastGenVelocity.set(0, 0);
    this.idleFacing = facing;
    this.idleClip = this.clips.get(TARGET_CLIPS.idle)!;
    this.idlePending = null;
    const place = new Vector3(ground.x + actualVelocity.x * 0.35, 0, ground.z + actualVelocity.y * 0.35);
    const window = Array.from({ length: POSES_PER_TOKEN }, (_, k) => this.idleClip.sample(k / SAMPLE_RATE, this.skeleton.createPose()));
    const { ground: g0, heading: h0 } = poseFrame(this.skeleton, window[0]);
    window.forEach((pose, k) => {
      reframe(pose, g0, h0, place, facing);
      copyPose(pose, this.targets[k]);
    });
    this.idleTransition = this.player.generations + 1;
    this.request(0, [6, 7, 8, 9, 10]);
  }

  private playIdleClip(ground: Vector3, heading: number): void {
    const clip = this.idleClip;
    const { ground: g0, heading: h0 } = poseFrame(this.skeleton, clip.frames[0]);
    const place = ground.clone().setY(0);
    this.player.playClip(clip, (pose) => reframe(pose, g0, h0, place, heading));
  }

  private placeTargets(ground: Vector3, heading: number): void {
    this.blended.forEach((pose, k) => {
      copyPose(pose, this.targets[k]);
      reframe(this.targets[k], ORIGIN, 0, ground, heading);
    });
  }

  private request(transitionEarlyBy: number, tokens: number[]): void {
    const targets = this.targets.map(clonePose);
    this.player
      .generate(targets, { transitionEarlyBy, allowedTokens: tokens })
      .then(() => {
        this.latency = this.latency * 0.8 + Math.min(this.player.lastLatency, 0.3) * 0.2;
      })
      .catch((error) => console.error('MotionBricks generation failed', error));
  }
}

function clamp1(v: number): number {
  return Math.min(Math.max(v, -1), 1);
}
