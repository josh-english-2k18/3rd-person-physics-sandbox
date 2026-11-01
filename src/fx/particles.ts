import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
  type Blending,
} from 'three';

/**
 * Camera-facing particle billboards with CPU simulation and shader-side looks:
 * - glow: soft additive dots (flashes, embers)
 * - spark: additive streaks stretched along their velocity
 * - fire: noise-eroded additive puffs with a white -> yellow -> orange -> red ramp over life
 * - smoke / dust: noise-eroded, top-lit puffs (normal blending)
 */

export type ParticleKind = 'glow' | 'spark' | 'fire' | 'smoke';
const KIND: Record<ParticleKind, number> = { glow: 0, spark: 1, fire: 2, smoke: 3 };

export interface ParticleSpawn {
  position: Vector3;
  velocity: Vector3;
  color: Color;
  size: number;
  life: number;
  kind?: ParticleKind;
  /** Size multiplier over life: end size = size * grow. */
  grow?: number;
  gravity?: number;
  drag?: number;
  /** Stretch along velocity (sparks). */
  stretch?: number;
  alpha?: number;
  /** Ground height for bounces. */
  floor?: number;
}

const MAX = 4000;

const NOISE = /* glsl */ `
  float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float pNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(pHash(i), pHash(i + vec2(1, 0)), f.x), mix(pHash(i + vec2(0, 1)), pHash(i + vec2(1, 1)), f.x), f.y);
  }
  float pFbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * pNoise(p); p = p * 2.07 + 13.1; a *= 0.5; }
    return v;
  }
`;

export class ParticleSystem {
  readonly mesh: Mesh;
  private readonly geometry: InstancedBufferGeometry;
  private readonly offset: InstancedBufferAttribute;
  private readonly velocityAttr: InstancedBufferAttribute;
  private readonly colorAttr: InstancedBufferAttribute;
  private readonly params: InstancedBufferAttribute; // size, alpha, stretch, age01
  private readonly extra: InstancedBufferAttribute; // seed, kind
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly col = new Float32Array(MAX * 3);
  private readonly size = new Float32Array(MAX);
  private readonly grow = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly age = new Float32Array(MAX);
  private readonly gravity = new Float32Array(MAX);
  private readonly drag = new Float32Array(MAX);
  private readonly stretch = new Float32Array(MAX);
  private readonly alpha = new Float32Array(MAX);
  private readonly seed = new Float32Array(MAX);
  private readonly kind = new Float32Array(MAX);
  private readonly floor = new Float32Array(MAX);
  private count = 0;

  constructor(blending: Blending) {
    this.geometry = new InstancedBufferGeometry();
    const quad = new PlaneGeometry(1, 1);
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.attributes.position);
    this.geometry.setAttribute('uv', quad.attributes.uv);
    const attr = (size: number) => {
      const a = new InstancedBufferAttribute(new Float32Array(MAX * size), size);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    this.offset = attr(3);
    this.velocityAttr = attr(3);
    this.colorAttr = attr(3);
    this.params = attr(4);
    this.extra = attr(2);
    this.geometry.setAttribute('aOffset', this.offset);
    this.geometry.setAttribute('aVelocity', this.velocityAttr);
    this.geometry.setAttribute('aColor', this.colorAttr);
    this.geometry.setAttribute('aParams', this.params);
    this.geometry.setAttribute('aExtra', this.extra);
    this.geometry.instanceCount = 0;

    const additive = blending === AdditiveBlending;
    const material = new ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec3 aVelocity;
        attribute vec3 aColor;
        attribute vec4 aParams;
        attribute vec2 aExtra;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vAge;
        varying float vSeed;
        varying float vKind;
        varying float vNear;
        void main() {
          vUv = uv;
          vColor = aColor;
          vAlpha = aParams.y;
          vAge = aParams.w;
          vSeed = aExtra.x;
          vKind = aExtra.y;
          vec4 center = viewMatrix * vec4(aOffset, 1.0);
          // Fade puffs that would fill the screen (the camera sits just behind the weapon).
          vNear = smoothstep(0.35, 0.35 + aParams.x * 2.5 + 1.2, -center.z);
          vec2 p = position.xy * aParams.x;
          vec2 q;
          if (aParams.z > 0.0) {
            // Streak: +Y follows the screen-space velocity.
            vec3 vVel = (viewMatrix * vec4(aVelocity, 0.0)).xyz;
            vec2 dir = length(vVel.xy) > 1e-4 ? normalize(vVel.xy) : vec2(0.0, 1.0);
            float stretch = 1.0 + aParams.z * length(vVel.xy) * 0.06;
            q = vec2(dir.y, -dir.x) * p.x + dir * p.y * stretch;
          } else {
            // Puff: random spin that slowly turns over life.
            float a = aExtra.x * 6.2831 + aParams.w * (aExtra.x - 0.5) * 2.0;
            q = mat2(cos(a), sin(a), -sin(a), cos(a)) * p;
          }
          center.xy += q;
          gl_Position = projectionMatrix * center;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vAge;
        varying float vSeed;
        varying float vKind;
        varying float vNear;
        ${NOISE}
        vec3 fireRamp(float t) {
          vec3 c = mix(vec3(4.0, 3.4, 2.4), vec3(3.2, 1.5, 0.35), smoothstep(0.0, 0.25, t));
          c = mix(c, vec3(1.4, 0.35, 0.06), smoothstep(0.25, 0.6, t));
          return mix(c, vec3(0.12, 0.05, 0.03), smoothstep(0.6, 1.0, t));
        }
        void main() {
          vec2 d = vUv * 2.0 - 1.0;
          float r = length(d);
          if (vKind < 1.5) {
            // glow / spark
            float a = exp(-r * r * 4.0) * vAlpha * vNear;
            if (a < 0.003) discard;
            gl_FragColor = vec4(vColor * a, 1.0);
            return;
          }
          float n = pFbm(vUv * 2.6 + vSeed * 17.0 + vec2(0.0, -vAge * 0.9));
          float body = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.9);
          if (vKind < 2.5) {
            // fire: erodes from the edges as it ages
            float a = smoothstep(0.15 + vAge * 0.7, 0.9, body * (0.6 + n * 0.8)) * vAlpha * vNear;
            if (a < 0.003) discard;
            gl_FragColor = vec4(fireRamp(vAge) * vColor * a, 1.0);
            return;
          }
          // smoke: soft, billowy, lit from above
          float a = body * smoothstep(0.0, 0.5, n + 0.15) * vAlpha * vNear;
          if (a < 0.003) discard;
          float light = mix(0.62, 1.18, clamp(vUv.y * 0.8 + n * 0.4, 0.0, 1.0));
          gl_FragColor = vec4(vColor * light, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending,
    });
    material.premultipliedAlpha = additive;
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 21 : 20;
  }

  spawn(p: ParticleSpawn): void {
    if (this.count >= MAX) return;
    const i = this.count++;
    p.position.toArray(this.pos, i * 3);
    p.velocity.toArray(this.vel, i * 3);
    this.col[i * 3] = p.color.r;
    this.col[i * 3 + 1] = p.color.g;
    this.col[i * 3 + 2] = p.color.b;
    this.size[i] = p.size;
    this.grow[i] = p.grow ?? 1;
    this.life[i] = p.life;
    this.age[i] = 0;
    this.gravity[i] = p.gravity ?? 0;
    this.drag[i] = p.drag ?? 0;
    this.stretch[i] = p.stretch ?? 0;
    this.alpha[i] = p.alpha ?? 1;
    this.seed[i] = Math.random();
    this.kind[i] = KIND[p.kind ?? (p.stretch ? 'spark' : 'glow')];
    this.floor[i] = p.floor ?? 0;
  }

  update(dt: number): void {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const age = this.age[i] + dt;
      if (age >= this.life[i]) continue;
      // Compact live particles to the front.
      if (n !== i) {
        for (let k = 0; k < 3; k++) {
          this.pos[n * 3 + k] = this.pos[i * 3 + k];
          this.vel[n * 3 + k] = this.vel[i * 3 + k];
          this.col[n * 3 + k] = this.col[i * 3 + k];
        }
        this.size[n] = this.size[i];
        this.grow[n] = this.grow[i];
        this.life[n] = this.life[i];
        this.gravity[n] = this.gravity[i];
        this.drag[n] = this.drag[i];
        this.stretch[n] = this.stretch[i];
        this.alpha[n] = this.alpha[i];
        this.seed[n] = this.seed[i];
        this.kind[n] = this.kind[i];
        this.floor[n] = this.floor[i];
      }
      this.age[n] = age;
      const damping = Math.exp(-this.drag[n] * dt);
      this.vel[n * 3] *= damping;
      this.vel[n * 3 + 1] = this.vel[n * 3 + 1] * damping - this.gravity[n] * dt;
      this.vel[n * 3 + 2] *= damping;
      this.pos[n * 3] += this.vel[n * 3] * dt;
      this.pos[n * 3 + 1] += this.vel[n * 3 + 1] * dt;
      this.pos[n * 3 + 2] += this.vel[n * 3 + 2] * dt;
      const ground = this.floor[n] + 0.01;
      if (this.pos[n * 3 + 1] < ground && this.vel[n * 3 + 1] < 0) {
        this.pos[n * 3 + 1] = ground;
        this.vel[n * 3 + 1] *= -0.35;
        this.vel[n * 3] *= 0.6;
        this.vel[n * 3 + 2] *= 0.6;
      }
      const t = age / this.life[n];
      this.offset.setXYZ(n, this.pos[n * 3], this.pos[n * 3 + 1], this.pos[n * 3 + 2]);
      this.velocityAttr.setXYZ(n, this.vel[n * 3], this.vel[n * 3 + 1], this.vel[n * 3 + 2]);
      this.colorAttr.setXYZ(n, this.col[n * 3], this.col[n * 3 + 1], this.col[n * 3 + 2]);
      // Fire fades through its color ramp; everything else fades in fast and out slowly.
      const fade = this.kind[n] === KIND.fire ? Math.min(1, t * 20) : Math.min(1, t * 8) * (1 - t) * (1 - t);
      this.params.setXYZW(n, this.size[n] * (1 + (this.grow[n] - 1) * Math.sqrt(t)), this.alpha[n] * fade, this.stretch[n], t);
      this.extra.setXY(n, this.seed[n], this.kind[n]);
      n++;
    }
    this.count = n;
    this.geometry.instanceCount = n;
    for (const a of [this.offset, this.velocityAttr, this.colorAttr, this.params, this.extra]) {
      a.needsUpdate = true;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
    }
  }
}

const v = new Vector3();

export class Particles {
  readonly glow = new ParticleSystem(AdditiveBlending);
  readonly smoke = new ParticleSystem(NormalBlending);

  update(dt: number): void {
    this.glow.update(dt);
    this.smoke.update(dt);
  }

  /** Bullet impact: sparks, chips, a hot flash, and a dust puff tinted by the surface. */
  impact(point: Vector3, normal: Vector3, metal: boolean, dust = metal ? '#8d8d8d' : '#b4ab9c'): void {
    const sparks = metal ? 16 : 6;
    for (let i = 0; i < sparks; i++) {
      const dir = v.copy(normal).add(randomUnit().multiplyScalar(0.85)).normalize();
      this.glow.spawn({
        position: point.clone(),
        velocity: dir.multiplyScalar(4 + Math.random() * 10),
        color: new Color(1, 0.55 + Math.random() * 0.3, 0.2).multiplyScalar(3.5),
        size: 0.018 + Math.random() * 0.014,
        life: 0.2 + Math.random() * 0.4,
        gravity: 9,
        drag: 1.5,
        stretch: 3,
      });
    }
    this.glow.spawn({ position: point.clone().addScaledVector(normal, 0.03), velocity: new Vector3(), color: new Color(5, 3.2, 1.6), size: 0.3, life: 0.06 });
    // Chips of the surface.
    for (let i = 0; i < (metal ? 3 : 8); i++) {
      this.smoke.spawn({
        position: point.clone(),
        velocity: normal.clone().multiplyScalar(2 + Math.random() * 3).add(randomUnit().multiplyScalar(1.6)),
        color: new Color(dust).multiplyScalar(0.55),
        size: 0.025 + Math.random() * 0.02,
        life: 0.5 + Math.random() * 0.5,
        gravity: 9.8,
        drag: 0.5,
        kind: 'smoke',
        alpha: 1,
      });
    }
    for (let i = 0; i < 4; i++) {
      this.smoke.spawn({
        position: point.clone().addScaledVector(normal, 0.06),
        velocity: normal.clone().multiplyScalar(0.5 + Math.random() * 0.9).add(randomUnit().multiplyScalar(0.3)),
        color: new Color(dust),
        size: 0.22 + Math.random() * 0.14,
        grow: 3.4,
        life: 1.1 + Math.random() * 0.9,
        drag: 2.5,
        gravity: -0.12,
        alpha: 0.5,
        kind: 'smoke',
      });
    }
  }

  /** Muzzle smoke and a few hot embers; the flash itself is a mesh (see MuzzleFlash). */
  muzzle(point: Vector3, forward: Vector3): void {
    for (let i = 0; i < 2; i++) {
      this.smoke.spawn({
        position: point.clone().addScaledVector(forward, 0.08 + i * 0.1),
        velocity: forward.clone().multiplyScalar(1.6 + i).add(new Vector3(0, 0.35, 0)).add(randomUnit().multiplyScalar(0.2)),
        color: new Color('#cfcac2'),
        size: 0.1,
        grow: 4.5,
        life: 0.8 + Math.random() * 0.4,
        drag: 3,
        alpha: 0.16,
        kind: 'smoke',
      });
    }
    if (Math.random() < 0.5) {
      this.glow.spawn({
        position: point.clone(),
        velocity: forward.clone().multiplyScalar(6).add(randomUnit().multiplyScalar(1.5)),
        color: new Color(4, 2, 0.6),
        size: 0.012,
        life: 0.2,
        drag: 2,
        stretch: 2,
      });
    }
  }

  explosion(point: Vector3): void {
    // White-hot core flash.
    this.glow.spawn({ position: point.clone(), velocity: new Vector3(), color: new Color(5, 4, 3), size: 5, grow: 1.4, life: 0.12 });
    // Rolling fireball: big noisy fire puffs that rise and burn out.
    for (let i = 0; i < 26; i++) {
      this.glow.spawn({
        position: point.clone().add(randomUnit().multiplyScalar(0.5)),
        velocity: randomUnit().multiplyScalar(2 + Math.random() * 5).add(new Vector3(0, 3 + Math.random() * 2, 0)),
        color: new Color(1, 1, 1).multiplyScalar(0.9 + Math.random() * 0.5),
        size: 1.4 + Math.random() * 1.6,
        grow: 2.1,
        life: 0.7 + Math.random() * 0.6,
        drag: 3.2,
        gravity: -1.5,
        kind: 'fire',
      });
    }
    // Sparks and embers.
    for (let i = 0; i < 70; i++) {
      this.glow.spawn({
        position: point.clone(),
        velocity: randomUnit().multiplyScalar(8 + Math.random() * 18).add(new Vector3(0, 5, 0)),
        color: new Color(1, 0.6, 0.25).multiplyScalar(4),
        size: 0.035,
        life: 0.6 + Math.random() * 1.4,
        gravity: 9.8,
        drag: 0.8,
        stretch: 4,
      });
    }
    // Smoke column.
    for (let i = 0; i < 30; i++) {
      this.smoke.spawn({
        position: point.clone().add(randomUnit().multiplyScalar(0.8)).add(new Vector3(0, 0.6, 0)),
        velocity: randomUnit().multiplyScalar(1 + Math.random() * 2.5).add(new Vector3(0, 2.2 + Math.random() * 2.5, 0)),
        color: new Color().setHSL(0.07, 0.06, 0.1 + Math.random() * 0.1),
        size: 1.3 + Math.random() * 1.3,
        grow: 3.2,
        life: 4 + Math.random() * 3,
        drag: 1.2,
        gravity: -0.35,
        alpha: 0.75,
        kind: 'smoke',
      });
    }
    // Ground dust ring.
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      this.smoke.spawn({
        position: new Vector3(point.x, 0.25, point.z),
        velocity: new Vector3(Math.cos(a), 0.1, Math.sin(a)).multiplyScalar(7 + Math.random() * 3),
        color: new Color('#9f968a'),
        size: 0.8,
        grow: 3,
        life: 1.6 + Math.random(),
        drag: 2.6,
        alpha: 0.45,
        kind: 'smoke',
      });
    }
  }

  debris(point: Vector3, color: Color): void {
    for (let i = 0; i < 18; i++) {
      this.smoke.spawn({
        position: point.clone().add(randomUnit().multiplyScalar(0.3)),
        velocity: randomUnit().multiplyScalar(1 + Math.random() * 2).add(new Vector3(0, 1, 0)),
        color,
        size: 0.3 + Math.random() * 0.3,
        grow: 2.5,
        life: 1 + Math.random(),
        drag: 2.5,
        alpha: 0.5,
        kind: 'smoke',
      });
    }
  }
}

export function randomUnit(): Vector3 {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return new Vector3(s * Math.cos(a), u, s * Math.sin(a));
}
