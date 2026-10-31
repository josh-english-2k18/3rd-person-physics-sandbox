import { Quaternion, Vector3 } from 'three';
import type { Clip } from './bvh';
import { POSES_PER_TOKEN, SAMPLE_RATE, type Generation, type GenerateOptions, type MotionBricksEngine } from './engine';
import { applyDelta, applyRootCorrection, computeDelta, computeRootDelta } from './poseMath';
import { blendPoses, clonePose, copyPose, type Pose, type Skeleton } from './skeleton';

/**
 * Plays MotionBricks generations back and keeps the motion history that becomes the next
 * generation's context (motionbricks/runtime/motion_player.py + motion_recorder.py).
 *
 * There is no crossfade between generations: every displayed pose is recorded, the next context
 * is the last 0.1 s of that history resampled at 30 Hz, and endpoint correction makes the new
 * motion start exactly where the old one was showing.
 */

const HISTORY = 32;
const FADE = 0.18;
const ROOT_FADE = 0.05;

class MotionRecorder {
  readonly poses: Pose[];
  /** deltaTimes[i] is the time from pose i to pose i + 1 (the last entry is 0). */
  readonly deltaTimes = new Float32Array(HISTORY);

  constructor(pose: Pose) {
    this.poses = Array.from({ length: HISTORY }, () => clonePose(pose));
  }

  fill(pose: Pose): void {
    for (const p of this.poses) copyPose(pose, p);
    this.deltaTimes.fill(0);
  }

  record(dt: number, pose: Pose): void {
    if (!(dt > 0)) return;
    const oldest = this.poses.shift()!;
    this.poses.push(copyPose(pose, oldest));
    this.deltaTimes[HISTORY - 1] = dt;
    this.deltaTimes.copyWithin(0, 1);
    this.deltaTimes[HISTORY - 1] = 0;
  }

  /** The last four poses at 30 Hz (history_sample_indices + blend_transform). */
  sampleContext(out: Pose[]): Pose[] {
    const times = new Float32Array(HISTORY);
    for (let i = HISTORY - 2; i >= 0; i--) times[i] = times[i + 1] - this.deltaTimes[i];
    for (let s = 0; s < POSES_PER_TOKEN; s++) {
      const t = -(POSES_PER_TOKEN - 1) / SAMPLE_RATE + s / SAMPLE_RATE;
      let upper = times.findIndex((value) => value > t);
      if (upper < 0) upper = HISTORY - 1;
      let lower = Math.max(upper - 1, 0);
      const span = times[upper] - times[lower];
      let blend = 0;
      if (span > 0) blend = Math.min(Math.max((t - times[lower]) / span, 0), 1);
      else lower = upper;
      blendPoses(this.poses[lower], this.poses[upper], blend, out[s]);
    }
    return out;
  }
}

export interface PlaybackOptions extends GenerateOptions {
  /** Hand over to the next generation this many frames before the end. */
  transitionEarlyBy: number;
}

type Source = (
  | { kind: 'generated'; generation: Generation }
  | { kind: 'clip'; clip: Clip; loopDeltas: LoopCorrection; align: (pose: Pose) => void }
) & {
  /** Ground-plane shift applied to this source's root (collisions push the character off its path). */
  shift: Vector3;
};

interface LoopCorrection {
  root: ReturnType<typeof computeRootDelta>;
  joints: ReturnType<typeof computeDelta>[];
}

export class MotionPlayer {
  readonly skeleton: Skeleton;
  private readonly engine: MotionBricksEngine;
  private readonly history: MotionRecorder;
  private readonly context: Pose[];
  private source: Source | null = null;
  private time = 0;
  /** The source that was playing before the latest switch, faded out over FADE seconds. */
  private previous: { source: Source; time: number } | null = null;
  private fade = 1;
  private readonly fadePose: Pose;
  private transitionEarlyBy = 0;
  /** The latest generation (kept for the motion preview even while a clip plays). */
  lastGeneration: Generation | null = null;
  /** Total playback time; measures inference latency in game time. */
  private clock = 0;
  private version = 0;
  /** Game time between the last request and its arrival (what transition timing must cover). */
  lastLatency = 0;
  generations = 0;

  constructor(engine: MotionBricksEngine, skeleton: Skeleton, initialPose: Pose) {
    this.engine = engine;
    this.skeleton = skeleton;
    this.history = new MotionRecorder(initialPose);
    this.context = Array.from({ length: POSES_PER_TOKEN }, () => clonePose(initialPose));
    this.fadePose = clonePose(initialPose);
  }

  private switchTo(source: Source, startTime: number): void {
    if (this.source) this.previous = { source: this.source, time: this.time };
    this.source = source;
    this.time = startTime;
    this.version++;
    this.fade = this.previous ? 0 : 1;
  }

  get busy(): boolean {
    return this.engine.isBusy;
  }

  get playbackTime(): number {
    return this.time;
  }

  get playbackDuration(): number {
    if (this.source?.kind !== 'generated') return Infinity;
    const frames = this.source.generation.frames.length;
    return Math.max(0, frames - 1 - this.transitionEarlyBy) / SAMPLE_RATE;
  }

  get timeToTransition(): number {
    return Math.max(0, this.playbackDuration - this.time);
  }

  get playingClip(): Clip | null {
    return this.source?.kind === 'clip' ? this.source.clip : null;
  }

  seedHistory(pose: Pose): void {
    this.history.fill(pose);
  }

  recordPose(dt: number, pose: Pose): void {
    this.history.record(dt, pose);
  }

  /** The context the next generation would use (also drawn by the motion preview). */
  currentContext(): Pose[] {
    return this.history.sampleContext(this.context);
  }

  /**
   * Generates from the recorded history to `targets`. Inference is asynchronous; the pose that
   * plays meanwhile keeps being recorded, so the returned generation is re-timed to start at
   * the latest context when it arrives.
   */
  async generate(targets: Pose[], options: PlaybackOptions): Promise<Generation> {
    const context = this.currentContext().map(clonePose);
    const requested = this.clock;
    const generation = await this.engine.generate(context, targets, options);
    this.lastGeneration = generation;
    this.transitionEarlyBy = options.transitionEarlyBy;
    // Catch up on the time spent waiting for inference, then crossfade from what was playing.
    this.lastLatency = this.clock - requested;
    this.switchTo({ kind: 'generated', generation, shift: new Vector3() }, this.lastLatency);
    this.generations++;
    return generation;
  }

  /**
   * Plays a clip on a loop. `align` maps clip poses into place. Each loop blends its last frame
   * into its first so the seam is invisible.
   */
  playClip(clip: Clip, align: (pose: Pose) => void): void {
    const first = clonePose(clip.frames[0]);
    const last = clonePose(clip.frames[clip.frames.length - 1]);
    const loopDeltas: LoopCorrection = {
      root: computeRootDelta(last, first),
      joints: Array.from({ length: this.skeleton.count }, (_, j) => computeDelta(last, first, j)),
    };
    this.switchTo({ kind: 'clip', clip, loopDeltas, align, shift: new Vector3() }, 0);
  }

  /** Offsets the playing motion on the ground plane (e.g. when a wall blocks the character). */
  shiftRoot(dx: number, dz: number): void {
    if (!this.source) return;
    this.source.shift.x += dx;
    this.source.shift.z += dz;
  }

  /** Increments whenever a new source starts playing. */
  get sourceVersion(): number {
    return this.version;
  }

  /** Advances playback by `dt` and writes the current pose into `out`. */
  sample(dt: number, out: Pose, contacts?: Float32Array): void {
    this.clock += dt;
    this.time += dt;
    if (!this.source) return;
    this.sampleSource(this.source, this.time, out, contacts);
    if (this.previous && this.fade < 1) {
      this.previous.time += dt;
      this.fade = Math.min(1, this.fade + dt / FADE);
      this.sampleSource(this.previous.source, this.previous.time, this.fadePose);
      const w = this.fade * this.fade * (3 - 2 * this.fade);
      // The root hands over almost at once so new steering takes effect immediately;
      // the rest of the body eases in to hide the seam.
      const rootW = Math.min(1, (this.fade * FADE) / ROOT_FADE);
      const rx = this.fadePose.pos[0] + (out.pos[0] - this.fadePose.pos[0]) * rootW;
      const rz = this.fadePose.pos[2] + (out.pos[2] - this.fadePose.pos[2]) * rootW;
      blendPoses(this.fadePose, out, w, out);
      out.pos[0] = rx;
      out.pos[2] = rz;
    } else {
      this.previous = null;
    }
  }

  private sampleSource(source: Source, time: number, out: Pose, contacts?: Float32Array): void {
    this.sampleRaw(source, time, out, contacts);
    out.pos[0] += source.shift.x;
    out.pos[2] += source.shift.z;
  }

  private sampleRaw(source: Source, time: number, out: Pose, contacts?: Float32Array): void {
    if (source.kind === 'clip') {
      const { clip, loopDeltas, align } = source;
      const t = time % clip.duration;
      clip.sample(t, out);
      const w = t / clip.duration;
      applyRootCorrection(out, IDENTITY_DELTA, loopDeltas.root, w);
      for (let j = 1; j < this.skeleton.count; j++) applyDelta(out, j, loopDeltas.joints[j], w);
      align(out);
      contacts?.fill(1);
      return;
    }
    const { frames, footContacts } = source.generation;
    const f = Math.min(Math.max(time * SAMPLE_RATE, 0), frames.length - 1);
    const i = Math.floor(f);
    const j = Math.min(i + 1, frames.length - 1);
    blendPoses(frames[i], frames[j], f - i, out);
    if (contacts) {
      for (let c = 0; c < 4; c++) contacts[c] = footContacts[i][c] + (footContacts[j][c] - footContacts[i][c]) * (f - i);
    }
  }
}

const IDENTITY_DELTA = { p: new Vector3(), q: new Quaternion() };
