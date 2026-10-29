import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ort from 'onnxruntime-web/webgpu';
import { Vector2, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseBvh, type Clip } from '../bvh';
import { MotionBricksEngine, POSES_PER_TOKEN, SAMPLE_RATE } from '../engine';
import { LocomotionController, TARGET_CLIPS, poseFrame } from '../locomotion';
import { MotionPlayer } from '../player';
import { computeWorldPose, createWorldPose, type Pose } from '../skeleton';

// Integration tests against the real model; run `npm run setup` first.
const DIR = resolve(import.meta.dirname, '../../../public/motionbricks');
const MODEL = resolve(DIR, 'mmm_v6_soma_fp16.onnx');
const hasModel = existsSync(MODEL);

const loadClip = (name: string) => parseBvh(name, readFileSync(resolve(DIR, 'clips', `${name}.bvh`), 'utf8'));
const window = (clip: Clip, t: number) =>
  Array.from({ length: POSES_PER_TOKEN }, (_, k) => clip.sample(t + k / SAMPLE_RATE, clip.skeleton.createPose()));
const root = (pose: Pose) => new Vector3().fromArray(pose.pos, 0);

describe.skipIf(!hasModel)('MotionBricks port', () => {
  let engine: MotionBricksEngine;
  let clips: Map<string, Clip>;

  beforeAll(async () => {
    clips = new Map(Object.values(TARGET_CLIPS).map((name) => [name, loadClip(name)]));
    const skeleton = clips.get(TARGET_CLIPS.jog)!.skeleton;
    const session = await ort.InferenceSession.create(MODEL);
    engine = await MotionBricksEngine.fromSession(session, 'wasm', skeleton);
  });

  it('inbetweens two windows of a real clip without endpoint correction', async () => {
    const jog = clips.get(TARGET_CLIPS.jog)!;
    const context = window(jog, 1.0);
    const target = window(jog, 2.0);
    const result = await engine.generate(context, target, { correctEndpoints: false });
    const first = root(result.frames[0]);
    const last = root(result.frames[result.frames.length - 1]);
    const contextEnd = root(context[3]);
    const targetStart = root(target[0]);
    console.log('frames', result.frames.length, 'tokens', result.tokens,
      'start err', first.distanceTo(contextEnd).toFixed(3), 'end err', last.distanceTo(targetStart).toFixed(3),
      'travel', contextEnd.distanceTo(targetStart).toFixed(2));
    expect(first.distanceTo(contextEnd)).toBeLessThan(0.12);
    expect(last.distanceTo(targetStart)).toBeLessThan(0.25);

    // Joint world positions of the last frame should match the target's (pose fidelity).
    const skeleton = jog.skeleton;
    const a = computeWorldPose(skeleton, result.frames[result.frames.length - 1], createWorldPose(skeleton.count));
    const b = computeWorldPose(skeleton, target[0], createWorldPose(skeleton.count));
    let err = 0;
    for (const name of ['LeftFoot', 'RightFoot', 'LeftHand', 'RightHand', 'Head']) {
      const j = skeleton.joint(name);
      err = Math.max(err, new Vector3().fromArray(a.pos, j * 3).distanceTo(new Vector3().fromArray(b.pos, j * 3)));
    }
    console.log('max end-effector error', err.toFixed(3));
    expect(err).toBeLessThan(0.3);
  });

  it('steers locomotion from input', async () => {
    const skeleton = clips.get(TARGET_CLIPS.jog)!.skeleton;
    const pose = skeleton.createPose();
    const player = new MotionPlayer(engine, skeleton, pose);
    const controller = new LocomotionController(skeleton, player, clips);
    controller.start(new Vector3(0, 0, 0), 0, pose);
    const dt = 1 / 60;
    let prev = new Vector3();
    const path: string[] = [];
    for (let step = 0; step < 60 * 8; step++) {
      const t = step * dt;
      // Run along +Z, turn to +X after 3 s, stop after 6 s.
      const move = t < 3 ? new Vector2(0, 1) : t < 6 ? new Vector2(1, 0) : new Vector2();
      const ground = poseFrame(skeleton, pose).ground;
      const velocity = new Vector2(ground.x - prev.x, ground.z - prev.z).divideScalar(dt);
      prev = ground;
      controller.update({ move, aimHeading: 0, sprint: false, crouch: false, aiming: false }, dt, ground, velocity);
      // Let in-flight inference complete in "game time" like a real frame loop would.
      if (player.busy) await new Promise((r) => setTimeout(r, 0));
      while (player.busy) await new Promise((r) => setTimeout(r, 5));
      player.sample(dt, pose);
      player.recordPose(dt, pose);
      for (const v of pose.pos) expect(Number.isFinite(v)).toBe(true);
      if (step % 60 === 0) path.push(`${t.toFixed(0)}s (${ground.x.toFixed(2)}, ${ground.z.toFixed(2)}) h=${pose.pos[1].toFixed(2)} ${controller.status.state}`);
    }
    console.log(path.join('\n'), '\ngenerations', player.generations);
    const end = poseFrame(skeleton, pose).ground;
    expect(end.z).toBeGreaterThan(3);
    expect(end.x).toBeGreaterThan(3);
  });
});
