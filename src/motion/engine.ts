import * as ort from 'onnxruntime-web/webgpu';
import { Quaternion, Vector3 } from 'three';
import { computeWorldPose, createPose, createWorldPose, type Pose, type Skeleton, type WorldPose } from './skeleton';
import { applyDelta, applyRootCorrection, computeDelta, computeRootDelta, type Delta } from './poseMath';

/**
 * In-browser port of the MotionBricks SOMA engine (motionbricks/model/soma/engine.py + kernels.py).
 *
 * Each generation fills in the motion between four context poses (the character's recent motion)
 * and one to four target poses, at 30 Hz. Poses are local joint transforms on the SOMA skeleton,
 * with the root in world space. World space here is SOMA model space: Y up, meters.
 */

export const SAMPLE_RATE = 30;
export const POSES_PER_TOKEN = 4;
export const MIN_TOKENS = 6;
export const MAX_TOKENS = 16;
const BOUNDARY_FRAMES = 3;
const SLOTS = 2 * POSES_PER_TOKEN;
const FEATURES = 366;
const MAX_RAW_FRAMES = MAX_TOKENS * POSES_PER_TOKEN;
export const MAX_VALID_FRAMES = MAX_RAW_FRAMES - 2 * BOUNDARY_FRAMES;
export const DEFAULT_TOKENS = [8, 9, 10, 11, 12, 13, 14];

/** The 30 model joints, in model order (soma_n1.json). The root is Hips. */
export const MODEL_JOINTS = [
  'Hips', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Neck2', 'Head', 'Jaw', 'LeftEye', 'RightEye',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftHandThumbEnd', 'LeftHandMiddleEnd',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'RightHandThumbEnd', 'RightHandMiddleEnd',
  'LeftLeg', 'LeftShin', 'LeftFoot', 'LeftToeBase', 'RightLeg', 'RightShin', 'RightFoot', 'RightToeBase',
];
const MJ = MODEL_JOINTS.length;
const POSITION_OFFSET = 5; // in the output features
const ROTATION_OFFSET = (MJ - 1) * 3; // in local_poses
const OUT_ROTATION_OFFSET = POSITION_OFFSET + (MJ - 1) * 3;

export interface GenerateOptions {
  /** Token counts (6..16) the model may choose. Each token is four frames. */
  allowedTokens?: number[];
  /** Blend the generated motion so it starts exactly at the last context pose and ends at the target. */
  correctEndpoints?: boolean;
}

export interface Generation {
  /** Valid frames at 30 Hz, local transforms with the root in world space. */
  frames: Pose[];
  /** Per frame: left heel, left toe, right heel, right toe contact (0..1). */
  footContacts: Float32Array[];
  tokens: number;
  inferenceMs: number;
}

export type Backend = 'webgpu' | 'wasm';

export interface LoadProgress {
  loaded: number;
  total: number;
}

const MODEL_CACHE = 'motionbricks-v1';

/** Downloads the ONNX model with progress, caching it with the Cache API for later visits. */
async function fetchModel(url: string, onProgress: (p: LoadProgress) => void): Promise<Uint8Array> {
  let cache: Cache | undefined;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      onProgress({ loaded: bytes.length, total: bytes.length });
      return bytes;
    }
  } catch {
    cache = undefined; // Cache API unavailable (e.g. insecure context); just download.
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Could not download the MotionBricks model (${res.status}). Run \`npm run setup\` first.`);
  }
  const total = Number(res.headers.get('Content-Length')) || 380_327_058;
  const bytes = new Uint8Array(total);
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.set(value, loaded);
    loaded += value.length;
    onProgress({ loaded, total });
  }
  const model = loaded === total ? bytes : bytes.slice(0, loaded);
  cache?.put(url, new Response(model.slice(), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return model;
}

export class MotionBricksEngine {
  readonly backend: Backend;
  private readonly session: ort.InferenceSession;
  private readonly skeleton: Skeleton;
  private readonly modelToPose: Int32Array;
  /** Per skeleton joint: its model joint index, or -1 to keep the rest pose (e.g. fingers). */
  private readonly poseToModel: Int32Array;
  private readonly rightLeg: number;
  private readonly leftLeg: number;
  private readonly worlds: WorldPose[];
  private busy = false;

  private constructor(session: ort.InferenceSession, backend: Backend, skeleton: Skeleton) {
    this.session = session;
    this.backend = backend;
    this.skeleton = skeleton;
    this.modelToPose = Int32Array.from(MODEL_JOINTS.map((name) => skeleton.joint(name)));
    if (this.modelToPose[0] !== 0) throw new Error('The skeleton root must be Hips.');
    this.poseToModel = new Int32Array(skeleton.count).fill(-1);
    MODEL_JOINTS.forEach((_, m) => {
      const j = this.modelToPose[m];
      const parent = skeleton.parents[j];
      // Model joints outside the connected hierarchy keep their reference transform when decoding.
      if (parent < 0 || this.poseToModel[parent] >= 0) this.poseToModel[j] = m;
    });
    this.rightLeg = skeleton.joint('RightLeg');
    this.leftLeg = skeleton.joint('LeftLeg');
    this.worlds = Array.from({ length: SLOTS }, () => createWorldPose(skeleton.count));
  }

  static async load(
    url: string,
    skeleton: Skeleton,
    onProgress: (p: LoadProgress) => void,
    preferred?: Backend,
  ): Promise<MotionBricksEngine> {
    ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
    ort.env.wasm.numThreads = Math.min(8, navigator.hardwareConcurrency || 4);
    ort.env.logLevel = 'error';
    const model = await fetchModel(url, onProgress);

    const available: Backend[] = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
    const backends = preferred ? [preferred, ...available.filter((b) => b !== preferred)] : available;
    let lastError: unknown;
    for (const backend of backends) {
      try {
        const session = await ort.InferenceSession.create(model, {
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
          logSeverityLevel: 3,
        });
        const engine = new MotionBricksEngine(session, backend, skeleton);
        await engine.warmUp();
        return engine;
      } catch (error) {
        console.warn(`MotionBricks: ${backend} backend unavailable`, error);
        lastError = error;
      }
    }
    throw lastError;
  }

  /** Wraps an existing session (used by the Node integration tests). */
  static async fromSession(session: ort.InferenceSession, backend: Backend, skeleton: Skeleton): Promise<MotionBricksEngine> {
    const engine = new MotionBricksEngine(session, backend, skeleton);
    await engine.warmUp();
    return engine;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  private async warmUp(): Promise<void> {
    const rest = this.skeleton.createPose();
    rest.pos[1] = 0.95;
    const poses = Array.from({ length: POSES_PER_TOKEN }, () => rest);
    await this.generate(poses, [rest]);
  }

  /**
   * Generates the motion from the last context pose to the first target pose.
   * @param context exactly four poses at 30 Hz, ending at the current pose
   * @param target one to four poses at 30 Hz, starting at the pose to reach
   */
  async generate(context: Pose[], target: Pose[], options: GenerateOptions = {}): Promise<Generation> {
    if (context.length !== POSES_PER_TOKEN) throw new Error('Context needs four poses.');
    if (target.length < 1 || target.length > POSES_PER_TOKEN) throw new Error('Target needs 1-4 poses.');
    if (this.busy) throw new Error('A generation is already running.');
    this.busy = true;
    try {
      const feeds = this.encode(context, target, options.allowedTokens);
      const start = performance.now();
      const outputs = await this.session.run(feeds.tensors);
      const inferenceMs = performance.now() - start;
      const motion = outputs.pred_global_motions.data as Float32Array;
      const tokens = Number((outputs.pred_num_tokens.data as Int32Array)[0]);
      const generation = this.decode(motion, tokens, feeds.alignment, inferenceMs);
      if (options.correctEndpoints !== false) {
        this.correctEndpoints(generation, context[POSES_PER_TOKEN - 1], target[0]);
      }
      return generation;
    } finally {
      this.busy = false;
    }
  }

  // --- Encoding (encode_motionbricks_inputs_kernel) ---------------------------------------------

  private encode(context: Pose[], target: Pose[], allowedTokens?: number[]) {
    // Pad the target token by repeating its last pose.
    const slots = [...context, ...Array.from({ length: POSES_PER_TOKEN }, (_, i) => target[Math.min(i, target.length - 1)])];
    slots.forEach((pose, i) => computeWorldPose(this.skeleton, pose, this.worlds[i]));

    // Align so the last context pose sits at the ground origin facing +X (heading_alignment).
    const last = this.worlds[POSES_PER_TOKEN - 1];
    const currentAngle = headingFromHips(
      v1.fromArray(last.pos, this.rightLeg * 3),
      v2.fromArray(last.pos, this.leftLeg * 3),
    );
    const desiredAngle = Math.atan2(1, 0);
    const alignment = {
      p: new Vector3(last.pos[0], 0, last.pos[2]),
      q: new Quaternion().setFromAxisAngle(UP, currentAngle - desiredAngle),
    };
    const invQ = alignment.q.clone().invert();
    const aligned = (world: WorldPose, joint: number, out: Vector3) =>
      out.fromArray(world.pos, joint * 3).sub(alignment.p).applyQuaternion(invQ);

    const globalRoot = new Float32Array(SLOTS * 5);
    const localRoot = new Float32Array(SLOTS * 4);
    const localPoses = new Float32Array(SLOTS * 267);
    const finalFrame = SLOTS - 1;

    for (let frame = 0; frame < SLOTS; frame++) {
      const next = frame === POSES_PER_TOKEN - 1 ? frame : Math.min(frame + 1, finalFrame);
      const world = this.worlds[frame];
      const nextWorld = this.worlds[next];
      const hips = aligned(world, 0, new Vector3());
      const nextHips = aligned(nextWorld, 0, new Vector3());
      const heading = headingFromHips(aligned(world, this.rightLeg, v1), aligned(world, this.leftLeg, v2));
      const nextHeading = headingFromHips(aligned(nextWorld, this.rightLeg, v1), aligned(nextWorld, this.leftLeg, v2));
      const delta = Math.atan2(Math.sin(nextHeading - heading), Math.cos(nextHeading - heading));

      globalRoot.set([hips.x, hips.y, hips.z, Math.cos(heading), Math.sin(heading)], frame * 5);
      localRoot.set(
        [delta * SAMPLE_RATE, (nextHips.x - hips.x) * SAMPLE_RATE, (nextHips.z - hips.z) * SAMPLE_RATE, hips.y],
        frame * 4,
      );

      const base = frame * 267;
      for (let m = 0; m < MJ; m++) {
        const j = this.modelToPose[m];
        if (m > 0) {
          aligned(world, j, v1);
          localPoses[base + (m - 1) * 3] = v1.x - hips.x;
          localPoses[base + (m - 1) * 3 + 1] = v1.y;
          localPoses[base + (m - 1) * 3 + 2] = v1.z - hips.z;
        }
        q1.fromArray(world.rot, j * 4).premultiply(invQ);
        const x = v1.set(1, 0, 0).applyQuaternion(q1);
        const o = base + ROTATION_OFFSET + m * 6;
        localPoses[o] = x.x;
        localPoses[o + 1] = x.y;
        localPoses[o + 2] = x.z;
        const y = v1.set(0, 1, 0).applyQuaternion(q1);
        localPoses[o + 3] = y.x;
        localPoses[o + 4] = y.y;
        localPoses[o + 5] = y.z;
      }
    }

    // Conditions (write_motionbricks_conditions_kernel): context slots and the given target slots.
    // Root velocities are unknown at the last context pose and the last given target pose.
    const mask = new Int32Array(SLOTS);
    const rootMask = new Int32Array(SLOTS);
    const lastTarget = POSES_PER_TOKEN + target.length - 1;
    for (let i = 0; i < SLOTS; i++) {
      mask[i] = i <= lastTarget ? 1 : 0;
      rootMask[i] = i === POSES_PER_TOKEN - 1 || i === lastTarget ? 0 : mask[i];
    }
    const allowed = new Int32Array(MAX_TOKENS - MIN_TOKENS + 1);
    for (let t = MIN_TOKENS; t <= MAX_TOKENS; t++) {
      allowed[t - MIN_TOKENS] = (allowedTokens ?? DEFAULT_TOKENS).includes(t) ? 1 : 0;
    }

    const tensors = {
      global_root_values: new ort.Tensor('float32', globalRoot, [1, SLOTS, 5]),
      has_global_root_values: new ort.Tensor('int32', mask, [1, SLOTS]),
      local_root_values: new ort.Tensor('float32', localRoot, [1, SLOTS, 4]),
      has_local_root_values: new ort.Tensor('int32', rootMask, [1, SLOTS]),
      local_poses: new ort.Tensor('float32', localPoses, [1, SLOTS, 267]),
      has_local_poses: new ort.Tensor('int32', mask.slice(), [1, SLOTS]),
      allowed_pred_num_tokens: new ort.Tensor('int32', allowed, [1, allowed.length]),
    };
    return { tensors, alignment };
  }

  // --- Decoding (decode_motionbricks_output_kernel) ---------------------------------------------

  private decode(
    motion: Float32Array,
    tokens: number,
    alignment: { p: Vector3; q: Quaternion },
    inferenceMs: number,
  ): Generation {
    const rawCount = Math.min(Math.max(tokens * POSES_PER_TOKEN, 0), MAX_RAW_FRAMES);
    const count = Math.max(0, rawCount - 2 * BOUNDARY_FRAMES);
    const frames: Pose[] = [];
    const footContacts: Float32Array[] = [];
    const modelRot = Array.from({ length: MJ }, () => new Quaternion());
    const rest = this.skeleton.rest;

    for (let f = 0; f < count; f++) {
      const base = (BOUNDARY_FRAMES + f) * FEATURES;
      const contacts = new Float32Array(4);
      for (let c = 0; c < 4; c++) contacts[c] = Math.min(Math.max(motion[base + FEATURES - 4 + c], 0), 1);
      footContacts.push(contacts);

      for (let m = 0; m < MJ; m++) readRotation6d(motion, base + OUT_ROTATION_OFFSET + m * 6, modelRot[m]);

      const pose = createPose(this.skeleton.count);
      pose.pos.set(rest.pos);
      pose.rot.set(rest.rot);
      // Root: alignment * (position, rotation) also restores the ground offset removed when encoding.
      v1.set(motion[base], motion[base + 1], motion[base + 2]).applyQuaternion(alignment.q).add(alignment.p);
      v1.toArray(pose.pos, 0);
      q1.copy(alignment.q).multiply(modelRot[0]).normalize().toArray(pose.rot, 0);

      for (let j = 1; j < this.skeleton.count; j++) {
        const m = this.poseToModel[j];
        if (m < 0) continue;
        const pm = this.poseToModel[this.skeleton.parents[j]];
        q1.copy(modelRot[pm]).invert().multiply(modelRot[m]).normalize().toArray(pose.rot, j * 4);
      }
      frames.push(pose);
    }
    return { frames, footContacts, tokens, inferenceMs };
  }

  // --- Endpoint correction (compute/apply_endpoint_deltas_kernel) -------------------------------

  private correctEndpoints(generation: Generation, lastContext: Pose, firstTarget: Pose): void {
    const { frames } = generation;
    const count = frames.length;
    if (count < 2) return;
    const joints = this.skeleton.count;
    const start: Delta[] = [];
    const end: Delta[] = [];
    start[0] = computeRootDelta(frames[0], lastContext);
    end[0] = computeRootDelta(frames[count - 1], firstTarget);
    for (let j = 1; j < joints; j++) {
      start[j] = computeDelta(frames[0], lastContext, j);
      end[j] = computeDelta(frames[count - 1], firstTarget, j);
    }
    for (let f = 0; f < count; f++) {
      const endWeight = f / (count - 1);
      applyRootCorrection(frames[f], start[0], end[0], endWeight);
      for (let j = 1; j < joints; j++) {
        applyDelta(frames[f], j, start[j], 1 - endWeight);
        applyDelta(frames[f], j, end[j], endWeight);
      }
    }
  }
}

const UP = new Vector3(0, 1, 0);
const v1 = new Vector3();
const v2 = new Vector3();
const q1 = new Quaternion();
const m3 = { x: new Vector3(), y: new Vector3(), z: new Vector3() };

/** Heading (rotation about +Y) from the hip joints, as in the training representation ("hips_pos"). */
export function headingFromHips(right: Vector3, left: Vector3): number {
  const ax = right.x - left.x;
  const az = right.z - left.z;
  const length = Math.hypot(ax, az);
  if (length <= 1e-6) return 0;
  // forward = up x across
  const fx = az / length;
  const fz = -ax / length;
  return Math.atan2(fx, fz);
}

/** Gram-Schmidt the first two columns of a rotation matrix back into a quaternion. */
function readRotation6d(data: Float32Array, offset: number, out: Quaternion): Quaternion {
  const x = m3.x.set(data[offset], data[offset + 1], data[offset + 2]).normalize();
  const yRaw = m3.y.set(data[offset + 3], data[offset + 4], data[offset + 5]);
  const z = m3.z.crossVectors(x, yRaw).normalize();
  const y = yRaw.crossVectors(z, x);
  // Rotation matrix with columns x, y, z.
  const m11 = x.x, m21 = x.y, m31 = x.z;
  const m12 = y.x, m22 = y.y, m32 = y.z;
  const m13 = z.x, m23 = z.y, m33 = z.z;
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    out.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    out.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    out.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
  }
  return out.normalize();
}
