import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Generation } from '../motion/engine';
import { SAMPLE_RATE } from '../motion/engine';
import { computeWorldPose, createWorldPose, type Pose, type Skeleton, type WorldPose } from '../motion/skeleton';

/**
 * Visualizes what MotionBricks is about to do: the generated future poses as a strobe of glowing
 * wireframe "hologram" skeletons (cyan near -> violet far), the four target poses it is steering
 * toward (amber), the context it was given (green), the root trajectory as a ribbon on the ground,
 * and predicted footfalls. New generations sweep in from the character outward; poses the
 * playhead has passed dissolve away.
 */

const STYLE = {
  near: new Color('#38f3ff'),
  far: new Color('#9d5cff'),
  target: new Color('#ffb547'),
  context: new Color('#4dff9a'),
  foot: new Color('#7af7ff'),
  ghostStride: 3, // frames between drawn ghosts (30 Hz)
  maxGhosts: 22,
  sweepSeconds: 0.3,
  intensity: 1.6,
  boneWidth: 0.09,
};

/** Bones drawn on the hologram: [joint, child] pairs on the SOMA skeleton. */
const BONES = [
  ['Hips', 'Spine1'], ['Spine1', 'Spine2'], ['Spine2', 'Chest'], ['Chest', 'Neck1'], ['Neck1', 'Head'], ['Head', 'HeadEnd'],
  ...(['Left', 'Right'] as const).flatMap((s) => [
    ['Chest', `${s}Shoulder`], [`${s}Shoulder`, `${s}Arm`], [`${s}Arm`, `${s}ForeArm`], [`${s}ForeArm`, `${s}Hand`], [`${s}Hand`, `${s}HandMiddleEnd`],
    ['Hips', `${s}Leg`], [`${s}Leg`, `${s}Shin`], [`${s}Shin`, `${s}Foot`], [`${s}Foot`, `${s}ToeBase`], [`${s}ToeBase`, `${s}ToeEnd`],
  ]),
] as [string, string][];
const JOINTS = ['Hips', 'Chest', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftShin', 'LeftFoot', 'RightShin', 'RightFoot'];

/** Adds per-vertex barycentric coordinates so the shader can draw anti-aliased glowing edges. */
function withBarycentric(geometry: BufferGeometry): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const count = g.attributes.position.count;
  const bary = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) bary[i * 3 + (i % 3)] = 1;
  g.setAttribute('barycentric', new BufferAttribute(bary, 3));
  return g;
}

function hologramMaterial(edge: number, fill: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uEdge: { value: edge }, uFill: { value: fill } },
    vertexShader: /* glsl */ `
      attribute vec3 barycentric;
      attribute vec4 instanceTint; // rgb, alpha
      varying vec3 vBary;
      varying vec4 vTint;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vHeight;
      void main() {
        vBary = barycentric;
        vTint = instanceTint;
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vHeight = world.y;
        vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vView = cameraPosition - world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uEdge;
      uniform float uFill;
      varying vec3 vBary;
      varying vec4 vTint;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vHeight;
      void main() {
        if (vTint.a < 0.002) discard;
        vec3 d = fwidth(vBary);
        vec3 a = smoothstep(vec3(0.0), d * uEdge, vBary);
        float edge = 1.0 - min(min(a.x, a.y), a.z);
        float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
        float scan = 0.65 + 0.35 * sin(vHeight * 38.0 - uTime * 7.0);
        float glow = edge * 1.6 + fresnel * uFill * 1.5 + uFill * 0.15;
        // Fade holograms that crowd the camera (aiming over the shoulder).
        float near = smoothstep(1.1, 2.6, length(vView));
        gl_FragColor = vec4(vTint.rgb * glow * scan, 1.0) * vTint.a * near;
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}

/** A bone-shaped octahedron from (0,0,0) to (0,1,0), widest at 20%. */
function boneGeometry(): BufferGeometry {
  const g = new OctahedronGeometry(0.5, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setY(i, y > 0.01 ? 1 : y < -0.01 ? 0 : 0.2);
  }
  g.computeVertexNormals();
  return withBarycentric(g);
}

interface Layer {
  mesh: InstancedMesh;
  tint: InstancedBufferAttribute;
  count: number;
}

function createLayer(geometry: BufferGeometry, material: ShaderMaterial, capacity: number): Layer {
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const tint = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  tint.setUsage(DynamicDrawUsage);
  geometry.setAttribute('instanceTint', tint);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.renderOrder = 10;
  return { mesh, tint, count: 0 };
}

const UP = new Vector3(0, 1, 0);
const m4 = new Matrix4();
const qv = new Quaternion();
const va = new Vector3();
const vb = new Vector3();
const vs = new Vector3();

export class MotionPreview {
  readonly group = new Group();
  visible = true;
  private readonly skeleton: Skeleton;
  private readonly bones: Layer;
  private readonly joints: Layer;
  private readonly feet: Layer;
  private readonly boneIndex: [number, number][];
  private readonly jointIndex: number[];
  private readonly world: WorldPose;
  private readonly materials: ShaderMaterial[];
  private readonly trail: Mesh;
  private readonly trailPositions: BufferAttribute;
  private readonly trailData: BufferAttribute; // (u along path, v across, brightness)
  private generation: Generation | null = null;
  private arrivedAt = 0;
  private lastArrival = -10;
  private time = 0;
  private fade = 0;
  private readonly footJoints: number[];

  constructor(skeleton: Skeleton) {
    this.skeleton = skeleton;
    this.world = createWorldPose(skeleton.count);
    this.boneIndex = BONES.map(([a, b]) => [skeleton.joint(a), skeleton.joint(b)]);
    this.jointIndex = JOINTS.map((n) => skeleton.joint(n));
    this.footJoints = ['LeftFoot', 'LeftToeBase', 'RightFoot', 'RightToeBase'].map((n) => skeleton.joint(n));

    const boneMaterial = hologramMaterial(1.4, 0.35);
    const jointMaterial = hologramMaterial(1.2, 0.6);
    const footMaterial = new ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec4 instanceTint;
        varying vec2 vUv;
        varying vec4 vTint;
        void main() {
          vUv = uv * 2.0 - 1.0;
          vTint = instanceTint;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying vec4 vTint;
        void main() {
          float r = length(vUv);
          float ring = smoothstep(0.08, 0.0, abs(r - 0.78)) + smoothstep(0.35, 0.0, r) * 0.35;
          float pulse = 0.75 + 0.25 * sin(uTime * 6.0 - r * 8.0);
          gl_FragColor = vec4(vTint.rgb * ring * pulse * 1.6, 1.0) * vTint.a;
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.materials = [boneMaterial, jointMaterial, footMaterial];

    const capacity = (STYLE.maxGhosts + 8) * BONES.length;
    this.bones = createLayer(boneGeometry(), boneMaterial, capacity);
    this.joints = createLayer(withBarycentric(new IcosahedronGeometry(1, 0)), jointMaterial, (STYLE.maxGhosts + 8) * JOINTS.length);
    const footGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.feet = createLayer(footGeometry, footMaterial, 64);
    this.group.add(this.bones.mesh, this.joints.mesh, this.feet.mesh);

    // Root trajectory: a flat glowing ribbon on the ground with dashes flowing toward the target.
    const points = 70;
    const trailGeometry = new BufferGeometry();
    this.trailPositions = new BufferAttribute(new Float32Array(points * 2 * 3), 3);
    this.trailData = new BufferAttribute(new Float32Array(points * 2 * 3), 3);
    this.trailPositions.setUsage(DynamicDrawUsage);
    this.trailData.setUsage(DynamicDrawUsage);
    trailGeometry.setAttribute('position', this.trailPositions);
    trailGeometry.setAttribute('trail', this.trailData);
    const index: number[] = [];
    for (let i = 0; i < points - 1; i++) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    trailGeometry.setIndex(index);
    trailGeometry.setDrawRange(0, 0);
    const trailMaterial = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uNear: { value: STYLE.near }, uFar: { value: STYLE.far } },
      vertexShader: /* glsl */ `
        attribute vec3 trail;
        varying vec3 vTrail;
        void main() {
          vTrail = trail;
          gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uNear;
        uniform vec3 uFar;
        varying vec3 vTrail;
        void main() {
          float across = 1.0 - abs(vTrail.y);
          float core = pow(across, 6.0) * 1.4 + pow(across, 1.5) * 0.35;
          float dash = 0.55 + 0.45 * smoothstep(0.3, 0.7, fract(vTrail.x * 3.0 - uTime * 1.6));
          vec3 color = mix(uNear, uFar, clamp(vTrail.x / 1.6, 0.0, 1.0));
          gl_FragColor = vec4(color * core * dash * vTrail.z * 1.6, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    this.materials.push(trailMaterial);
    this.trail = new Mesh(trailGeometry, trailMaterial);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 9;
    this.group.add(this.trail);
  }

  /** Shows a new generation, sweeping it in from the character outward. */
  setGeneration(generation: Generation): void {
    if (generation === this.generation) return;
    this.generation = generation;
    // Sweep in after a pause; during continuous locomotion (several generations a second)
    // the strobe stays put and just updates.
    const continuous = this.time - this.lastArrival < 1;
    this.lastArrival = this.time;
    this.arrivedAt = continuous ? this.time - STYLE.sweepSeconds - 0.15 : this.time;
  }

  /**
   * @param playbackTime seconds into the current generation
   * @param groundY world height of the motion's ground plane
   * @param targets the target poses MotionBricks is steering toward
   * @param context the context poses it was conditioned on
   */
  update(dt: number, playbackTime: number, groundY: number, targets: Pose[], context: Pose[], playingGeneration: boolean): void {
    this.time += dt;
    this.fade += ((this.visible ? 1 : 0) - this.fade) * Math.min(1, dt * 8);
    for (const m of this.materials) m.uniforms.uTime.value = this.time;
    this.group.visible = this.fade > 0.01;
    this.bones.count = this.joints.count = this.feet.count = 0;
    const g = this.generation;
    if (!g || !this.group.visible) return this.commit();

    const since = this.time - this.arrivedAt;
    const frames = g.frames;
    const lastFrame = frames.length - 1;
    const head = playingGeneration ? playbackTime * SAMPLE_RATE : lastFrame + 1;
    const ghostFrames: number[] = [];
    for (let f = STYLE.ghostStride; f < lastFrame; f += STYLE.ghostStride) ghostFrames.push(f);
    ghostFrames.push(lastFrame);
    const shown = ghostFrames.slice(-STYLE.maxGhosts);

    shown.forEach((f, k) => {
      const t = f / lastFrame;
      const sweep = smooth((since - t * STYLE.sweepSeconds) / 0.15);
      const consumed = smooth((head - f + 1) / 3); // dissolve as the playhead passes
      const alpha = sweep * (1 - consumed) * (0.25 + 0.55 * (1 - t) + (k === shown.length - 1 ? 0.3 : 0)) * this.fade;
      if (alpha < 0.003) return;
      const color = new Color().lerpColors(STYLE.near, STYLE.far, t).multiplyScalar(STYLE.intensity);
      this.drawPose(frames[f], groundY, color, alpha, 1 + (1 - sweep) * 0.25);
    });

    // Target (amber, pulsing) and context (green, faint).
    const pulse = 0.55 + 0.25 * Math.sin(this.time * 4);
    const reached = smooth((head - (lastFrame - 6)) / 6); // the target fades once the motion arrives
    if (targets.length) this.drawPose(targets[0], groundY, STYLE.target.clone().multiplyScalar(1.4), pulse * this.fade * (1 - reached), 1);
    if (context.length) this.drawPose(context[context.length - 1], groundY, STYLE.context, 0.22 * this.fade * (1 - smooth(since / 1.2)), 1);

    // Trajectory ribbon and footfalls.
    this.updateTrail(frames, lastFrame, head, since, groundY);

    for (let c = 0; c < 4; c++) {
      for (let f = 1; f <= lastFrame; f++) {
        const now = g.footContacts[f][c];
        const before = g.footContacts[f - 1][c];
        if (!(now > 0.5 && before <= 0.5) || c % 2 === 1) continue; // heel strikes
        computeWorldPose(this.skeleton, frames[f], this.world);
        const j = this.footJoints[c];
        const t = f / lastFrame;
        const appear = smooth((since - t * STYLE.sweepSeconds) / 0.15);
        const passed = f < head - 4 ? 0.2 : 1;
        this.pushInstance(
          this.feet,
          m4.compose(va.set(this.world.pos[j * 3], groundY + 0.02, this.world.pos[j * 3 + 2]), qv.identity(), vs.setScalar(0.32 + (1 - appear) * 0.3)),
          STYLE.foot,
          appear * passed * this.fade * 0.9,
        );
      }
    }
    this.commit();
  }

  private updateTrail(frames: Pose[], lastFrame: number, head: number, since: number, groundY: number): void {
    const points = Math.min(frames.length, this.trailPositions.count / 2);
    const halfWidth = 0.07;
    let distance = 0;
    for (let f = 0; f < points; f++) {
      const p = frames[f].pos;
      const next = frames[Math.min(f + 1, points - 1)].pos;
      const prev = frames[Math.max(f - 1, 0)].pos;
      let dx = next[0] - prev[0];
      let dz = next[2] - prev[2];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      if (f > 0) distance += Math.hypot(p[0] - frames[f - 1].pos[0], p[2] - frames[f - 1].pos[2]);
      const t = f / Math.max(1, lastFrame);
      const visible = smooth((since - t * STYLE.sweepSeconds) / 0.15) * smooth((f - head + 2) / 4) * this.fade;
      const end = smooth((points - 1 - f) / 3) * smooth(f / 3 + 0.2);
      for (const side of [-1, 1]) {
        const i = f * 2 + (side > 0 ? 1 : 0);
        this.trailPositions.setXYZ(i, p[0] - dz * halfWidth * side, groundY + 0.02, p[2] + dx * halfWidth * side);
        this.trailData.setXYZ(i, distance, side, visible * end);
      }
    }
    this.trail.geometry.setDrawRange(0, Math.max(0, points - 1) * 6);
    this.trailPositions.needsUpdate = true;
    this.trailData.needsUpdate = true;
  }

  private drawPose(pose: Pose, groundY: number, color: Color, alpha: number, widthScale: number): void {
    const world = computeWorldPose(this.skeleton, pose, this.world);
    for (const [a, b] of this.boneIndex) {
      va.fromArray(world.pos, a * 3);
      vb.fromArray(world.pos, b * 3);
      va.y += groundY;
      vb.y += groundY;
      const length = va.distanceTo(vb);
      if (length < 1e-3) continue;
      qv.setFromUnitVectors(UP, vb.sub(va).normalize());
      const width = Math.min(STYLE.boneWidth, length * 0.35) * widthScale;
      this.pushInstance(this.bones, m4.compose(va, qv, vs.set(width, length, width)), color, alpha);
    }
    for (const j of this.jointIndex) {
      va.fromArray(world.pos, j * 3);
      va.y += groundY;
      this.pushInstance(this.joints, m4.compose(va, qv.identity(), vs.setScalar(0.028 * widthScale)), color, alpha * 1.2);
    }
  }

  private pushInstance(layer: Layer, matrix: Matrix4, color: Color, alpha: number): void {
    if (layer.count >= layer.mesh.instanceMatrix.count) return;
    layer.mesh.setMatrixAt(layer.count, matrix);
    layer.tint.setXYZW(layer.count, color.r, color.g, color.b, alpha);
    layer.count++;
  }

  private commit(): void {
    for (const layer of [this.bones, this.joints, this.feet]) {
      layer.mesh.count = layer.count;
      layer.mesh.instanceMatrix.needsUpdate = true;
      layer.tint.needsUpdate = true;
    }
  }
}

function smooth(x: number): number {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
}

