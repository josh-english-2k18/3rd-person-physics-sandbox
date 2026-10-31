import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ort from 'onnxruntime-web/webgpu';
import { Vector2, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseBvh, type Clip } from '../bvh';
import { MotionBricksEngine } from '../engine';
import { LocomotionController, TARGET_CLIPS, poseFrame } from '../locomotion';
import { MotionPlayer } from '../player';

// Measures how quickly the generated motion answers WASD: start, stop, and a 90 degree turn.
const DIR = resolve(import.meta.dirname, '../../../public/motionbricks');
const MODEL = resolve(DIR, 'mmm_v6_soma_fp16.onnx');
const DT = 1 / 60;
/** Simulated inference latency, in frames, so timings resemble the browser. */
const LATENCY_FRAMES = 3;

describe.skipIf(!existsSync(MODEL))('locomotion responsiveness', () => {
  let engine: MotionBricksEngine;
  let clips: Map<string, Clip>;

  beforeAll(async () => {
    clips = new Map(
      [...new Set(Object.values(TARGET_CLIPS))].map((n) => [n, parseBvh(n, readFileSync(resolve(DIR, 'clips', `${n}.bvh`), 'utf8'))]),
    );
    const session = await ort.InferenceSession.create(MODEL);
    engine = await MotionBricksEngine.fromSession(session, 'wasm', clips.get(TARGET_CLIPS.idle)!.skeleton);
  });

  async function simulate(input: (t: number) => Vector2, seconds: number) {
    const skeleton = clips.get(TARGET_CLIPS.idle)!.skeleton;
    const pose = skeleton.createPose();
    const player = new MotionPlayer(engine, skeleton, pose);
    const controller = new LocomotionController(skeleton, player, clips);
    controller.start(new Vector3(), 0, pose);
    let prev = poseFrame(skeleton, pose).ground;
    const samples: { t: number; velocity: Vector2 }[] = [];
    let velocity = new Vector2();
    for (let step = 0; step < seconds / DT; step++) {
      const t = step * DT;
      const ground = poseFrame(skeleton, pose).ground;
      controller.update({ move: input(t), aimHeading: 0, sprint: false, crouch: false, aiming: false }, DT, ground, velocity);
      if (player.busy) {
        // Keep playing the old motion for a few frames while "inference" runs.
        for (let k = 0; k < LATENCY_FRAMES && step < seconds / DT; k++, step++) {
          player.sample(DT, pose);
          player.recordPose(DT, pose);
        }
        while (player.busy) await new Promise((r) => setTimeout(r, 2));
      }
      player.sample(DT, pose);
      player.recordPose(DT, pose);
      const now = poseFrame(skeleton, pose).ground;
      velocity = new Vector2(now.x - prev.x, now.z - prev.z).divideScalar(DT);
      prev = now;
      samples.push({ t: step * DT, velocity: velocity.clone() });
    }
    return samples;
  }

  // Smooth over a stride so per-step sway doesn't dominate.
  const smoothed = (s: { t: number; velocity: Vector2 }[], i: number) => {
    const w = s.slice(Math.max(0, i - 10), i + 1);
    return w.reduce((a, b) => a.add(b.velocity), new Vector2()).divideScalar(w.length);
  };

  it('starts, stops and turns quickly', async () => {
    const start = await simulate((t) => (t < 2.5 ? new Vector2(0, 1) : new Vector2()), 4.5);
    const moving = start.findIndex((_, i) => smoothed(start, i).length() > 1.5);
    const released = start.findIndex((s) => s.t >= 2.5);
    const stopped = start.findIndex((_, i) => i > released && smoothed(start, i).length() < 0.4);
    const turn = await simulate((t) => (t < 2 ? new Vector2(0, 1) : new Vector2(1, 0)), 4);
    const turnStart = turn.findIndex((s) => s.t >= 2);
    const turned = turn.findIndex((_, i) => {
      if (i < turnStart) return false;
      const v = smoothed(turn, i);
      return v.length() > 1 && v.x / v.length() > Math.cos((25 * Math.PI) / 180);
    });
    const report = {
      startSeconds: start[moving]?.t,
      stopSeconds: start[stopped] ? start[stopped].t - 2.5 : NaN,
      turnSeconds: turn[turned] ? turn[turned].t - 2 : NaN,
    };
    console.log('responsiveness', JSON.stringify(report));
    // The generated motion alone; in game the capsule's input assist answers within a frame or two.
    // (The Scene Preview tuning measured 2.55 s / 0.75 s / 0.88 s. Shortening generations further
    // makes the gait shuffle; gait.test.ts guards that side of the trade.)
    expect(report.startSeconds).toBeLessThan(1.0);
    expect(report.stopSeconds).toBeLessThan(0.75);
    expect(report.turnSeconds).toBeLessThan(0.9);
  });
});
