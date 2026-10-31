import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ort from 'onnxruntime-web/webgpu';
import { Vector2, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseBvh, type Clip } from '../bvh';
import { MotionBricksEngine } from '../engine';
import { LocomotionController, TARGET_CLIPS, poseFrame, type LocomotionInput } from '../locomotion';
import { MotionPlayer } from '../player';
import { computeWorldPose, createWorldPose } from '../skeleton';

// Gait quality: feet should alternate L/R with even step lengths (no step-skip / shuffle).
const DIR = resolve(import.meta.dirname, '../../../public/motionbricks');
const MODEL = resolve(DIR, 'mmm_v6_soma_fp16.onnx');
const DT = 1 / 60;
const LATENCY_FRAMES = 3;

export interface GaitReport {
  steps: number;
  sameFootRepeats: number;
  asymmetry: number;
  meanStep: number;
  speed: number;
  bounce: number;
}

describe.skipIf(!existsSync(MODEL))('gait quality', () => {
  let engine: MotionBricksEngine;
  let clips: Map<string, Clip>;

  beforeAll(async () => {
    clips = new Map(
      [...new Set(Object.values(TARGET_CLIPS))].map((n) => [n, parseBvh(n, readFileSync(resolve(DIR, 'clips', `${n}.bvh`), 'utf8'))]),
    );
    const session = await ort.InferenceSession.create(MODEL);
    engine = await MotionBricksEngine.fromSession(session, 'wasm', clips.get(TARGET_CLIPS.idle)!.skeleton);
  });

  async function gait(input: Partial<LocomotionInput> & { move: Vector2 }, seconds = 6, warmup = 1.5): Promise<GaitReport> {
    const skeleton = clips.get(TARGET_CLIPS.idle)!.skeleton;
    const pose = skeleton.createPose();
    const player = new MotionPlayer(engine, skeleton, pose);
    const controller = new LocomotionController(skeleton, player, clips);
    controller.start(new Vector3(), 0, pose);
    const world = createWorldPose(skeleton.count);
    const feet = [skeleton.joint('LeftFoot'), skeleton.joint('RightFoot')];
    const prevFeet = [new Vector3(), new Vector3()];
    const planted = [false, false];
    const plants: { foot: number; at: Vector3; t: number }[] = [];
    const hips: number[] = [];
    let velocity = new Vector2();
    let prev = poseFrame(skeleton, pose).ground;
    const start = prev.clone();
    const frames = Math.round(seconds / DT);
    const advance = (t: number) => {
      player.sample(DT, pose);
      player.recordPose(DT, pose);
      computeWorldPose(skeleton, pose, world);
      feet.forEach((j, k) => {
        const p = new Vector3().fromArray(world.pos, j * 3);
        const speed = p.distanceTo(prevFeet[k]) / DT;
        const down = p.y < 0.16 && speed < 0.6;
        if (down && !planted[k] && t > warmup) plants.push({ foot: k, at: p.clone(), t });
        planted[k] = down;
        prevFeet[k].copy(p);
      });
      if (t > warmup) hips.push(pose.pos[1]);
    };
    for (let step = 0; step < frames; step++) {
      const ground = poseFrame(skeleton, pose).ground;
      controller.update({ aimHeading: 0, sprint: false, crouch: false, aiming: false, ...input }, DT, ground, velocity);
      if (player.busy) {
        for (let k = 0; k < LATENCY_FRAMES; k++, step++) advance(step * DT);
        while (player.busy) await new Promise((r) => setTimeout(r, 2));
      }
      advance(step * DT);
      const now = poseFrame(skeleton, pose).ground;
      velocity = new Vector2(now.x - prev.x, now.z - prev.z).divideScalar(DT);
      prev = now;
    }
    const lengths: number[] = [];
    let repeats = 0;
    for (let i = 1; i < plants.length; i++) {
      if (plants[i].foot === plants[i - 1].foot) repeats++;
      else lengths.push(plants[i].at.distanceTo(plants[i - 1].at));
    }
    const mean = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
    let diff = 0;
    for (let i = 1; i < lengths.length; i++) diff += Math.abs(lengths[i] - lengths[i - 1]);
    const asymmetry = diff / Math.max(1, lengths.length - 1) / Math.max(mean, 1e-3);
    const hipMean = hips.reduce((a, b) => a + b, 0) / Math.max(1, hips.length);
    const bounce = Math.sqrt(hips.reduce((a, b) => a + (b - hipMean) ** 2, 0) / Math.max(1, hips.length));
    const travelled = prev.distanceTo(start);
    return { steps: plants.length, sameFootRepeats: repeats, asymmetry, meanStep: mean, speed: travelled / seconds, bounce };
  }

  // Side-stepping naturally alternates a wide step and a closing step, so lateral cases are judged
  // on footfall order and bounce rather than step evenness.
  const cases: [string, Partial<LocomotionInput> & { move: Vector2 }, { lateral?: boolean }?][] = [
    ['jog forward', { move: new Vector2(0, 1) }],
    ['sprint forward', { move: new Vector2(0, 1), sprint: true }],
    ['aim walk forward', { move: new Vector2(0, 1), aiming: true }],
    ['aim strafe right', { move: new Vector2(-1, 0), aiming: true }, { lateral: true }],
    ['crouch forward', { move: new Vector2(0, 1), crouch: true }],
  ];

  for (const [name, input, options] of cases) {
    it(`${name}: alternating, even steps`, async () => {
      const report = await gait(input);
      const line = `${name.padEnd(18)} ${JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, +v.toFixed(3)])))}`;
      console.log(line);
      if (process.env.GAIT_REPORT) appendFileSync(process.env.GAIT_REPORT, `${line}\n`);
      expect(report.sameFootRepeats).toBeLessThanOrEqual(1);
      if (!options?.lateral) expect(report.asymmetry).toBeLessThan(0.35);
      expect(report.bounce).toBeLessThan(0.03);
    });
  }
});
