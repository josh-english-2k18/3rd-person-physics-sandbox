import { Quaternion, Vector3 } from 'three';
import { Skeleton, createPose, type Pose } from './skeleton';

/**
 * A motion clip sampled from a BVH file. Frames are stored as local joint transforms in meters
 * (BVH files use centimeters) on the clip's own skeleton.
 */
export class Clip {
  readonly name: string;
  readonly skeleton: Skeleton;
  readonly frameTime: number;
  readonly frames: Pose[];

  constructor(name: string, skeleton: Skeleton, frameTime: number, frames: Pose[]) {
    this.name = name;
    this.skeleton = skeleton;
    this.frameTime = frameTime;
    this.frames = frames;
  }

  get duration(): number {
    return (this.frames.length - 1) * this.frameTime;
  }

  /** Samples the clip at `time` seconds (clamped), blending the neighbouring frames. */
  sample(time: number, out: Pose): Pose {
    const f = Math.min(Math.max(time / this.frameTime, 0), this.frames.length - 1);
    const i = Math.floor(f);
    const t = f - i;
    const a = this.frames[i];
    const b = this.frames[Math.min(i + 1, this.frames.length - 1)];
    const joints = this.skeleton.count;
    for (let k = 0; k < joints * 3; k++) out.pos[k] = a.pos[k] + (b.pos[k] - a.pos[k]) * t;
    for (let j = 0; j < joints; j++) {
      qa.fromArray(a.rot, j * 4);
      qb.fromArray(b.rot, j * 4);
      qa.slerp(qb, t).toArray(out.rot, j * 4);
    }
    return out;
  }
}

const qa = new Quaternion();
const qb = new Quaternion();

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const DEG = Math.PI / 180;

/**
 * Parses a BVH file. SOMA clips wrap the skeleton in an identity `Root` joint above `Hips`; the
 * MotionBricks skeleton starts at Hips, so a parent-less `Root` is folded into its child.
 */
export function parseBvh(name: string, text: string): Clip {
  const lines = text.split('\n');
  const names: string[] = [];
  const parents: number[] = [];
  const offsets: number[][] = [];
  const channels: string[][] = [];
  const stack: number[] = [];
  let inEndSite = false;
  let line = 0;

  for (; line < lines.length; line++) {
    const tokens = lines[line].trim().split(/\s+/);
    const head = tokens[0];
    if (head === 'MOTION') break;
    if (head === 'ROOT' || head === 'JOINT') {
      names.push(tokens[1].split(':').pop()!);
      parents.push(stack.length ? stack[stack.length - 1] : -1);
      stack.push(names.length - 1);
      offsets.push([0, 0, 0]);
      channels.push([]);
    } else if (head === 'End') {
      inEndSite = true;
    } else if (head === 'OFFSET' && !inEndSite) {
      offsets[stack[stack.length - 1]] = tokens.slice(1, 4).map(Number);
    } else if (head === 'CHANNELS') {
      channels[stack[stack.length - 1]] = tokens.slice(2);
    } else if (head === '}') {
      if (inEndSite) inEndSite = false;
      else stack.pop();
    }
  }

  let frameCount = 0;
  let frameTime = 1 / 30;
  for (line++; line < lines.length; line++) {
    const text = lines[line].trim();
    if (text.startsWith('Frames:')) frameCount = Number(text.split(/\s+/)[1]);
    else if (text.startsWith('Frame Time:')) {
      frameTime = Number(text.split(/\s+/)[2]);
      line++;
      break;
    }
  }

  const joints = names.length;
  const frames: Pose[] = [];
  const q = new Quaternion();
  const axisQ = new Quaternion();
  for (let f = 0; f < frameCount; f++, line++) {
    const values = lines[line].trim().split(/\s+/).map(Number);
    const pose = createPose(joints);
    let column = 0;
    for (let j = 0; j < joints; j++) {
      pose.pos.set(offsets[j].map((v) => v * 0.01), j * 3);
      q.identity();
      for (const channel of channels[j]) {
        const value = values[column++];
        const axis = 'XYZ'.indexOf(channel[0].toUpperCase());
        if (channel.endsWith('position')) pose.pos[j * 3 + axis] = value * 0.01;
        else q.multiply(axisQ.setFromAxisAngle(AXES[axis], value * DEG));
      }
      q.normalize().toArray(pose.rot, j * 4);
    }
    frames.push(pose);
  }

  return foldRoot(name, names, parents, offsets, frameTime, frames);
}

function foldRoot(
  name: string,
  names: string[],
  parents: number[],
  offsets: number[][],
  frameTime: number,
  frames: Pose[],
): Clip {
  const restOf = (keep: number[]) => {
    const rest = createPose(keep.length);
    keep.forEach((j, i) => rest.pos.set(offsets[j].map((v) => v * 0.01), i * 3));
    return rest;
  };
  if (names[0] !== 'Root' || parents[1] !== 0 || parents.slice(2).includes(0)) {
    const all = names.map((_, i) => i);
    return new Clip(name, new Skeleton(names, parents, restOf(all)), frameTime, frames);
  }

  const keep = names.slice(1).map((_, i) => i + 1);
  const skeleton = new Skeleton(names.slice(1), parents.slice(1).map((p) => p - 1), restOf(keep));
  const rootQ = new Quaternion();
  const childQ = new Quaternion();
  const v = new Vector3();
  const folded = frames.map((pose) => {
    const out = createPose(keep.length);
    out.pos.set(pose.pos.subarray(3));
    out.rot.set(pose.rot.subarray(4));
    // Hips_world = Root * Hips_local
    rootQ.fromArray(pose.rot, 0);
    v.fromArray(pose.pos, 3).applyQuaternion(rootQ).add(new Vector3().fromArray(pose.pos, 0)).toArray(out.pos, 0);
    childQ.fromArray(pose.rot, 4);
    rootQ.multiply(childQ).toArray(out.rot, 0);
    return out;
  });
  return new Clip(name, skeleton, frameTime, folded);
}
