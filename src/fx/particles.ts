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
 * Camera-facing particle billboards with CPU simulation. One system per blend mode:
 * additive for sparks / fire / flashes, normal for smoke and dust. Sparks stretch along their
 * velocity so they read as streaks.
 */

export interface ParticleSpawn {
  position: Vector3;
  velocity: Vector3;
  color: Color;
  size: number;
  life: number;
  /** Size multiplier over life: end size = size * grow. */
  grow?: number;
  gravity?: number;
  drag?: number;
  /** Stretch along velocity (sparks). */
  stretch?: number;
  alpha?: number;
}

const MAX = 3000;

export class ParticleSystem {
  readonly mesh: Mesh;
  private readonly geometry: InstancedBufferGeometry;
  private readonly offset: InstancedBufferAttribute;
  private readonly velocityAttr: InstancedBufferAttribute;
  private readonly colorAttr: InstancedBufferAttribute;
  private readonly params: InstancedBufferAttribute; // size, alpha, stretch, age01
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
  private count = 0;

  constructor(blending: Blending, soft: boolean) {
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
    this.geometry.setAttribute('aOffset', this.offset);
    this.geometry.setAttribute('aVelocity', this.velocityAttr);
    this.geometry.setAttribute('aColor', this.colorAttr);
    this.geometry.setAttribute('aParams', this.params);
    this.geometry.instanceCount = 0;

    const material = new ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec3 aVelocity;
        attribute vec3 aColor;
        attribute vec4 aParams;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vAge;
        void main() {
          vUv = uv;
          vColor = aColor;
          vAlpha = aParams.y;
          vAge = aParams.w;
          vec4 center = viewMatrix * vec4(aOffset, 1.0);
          vec3 vVel = (viewMatrix * vec4(aVelocity, 0.0)).xyz;
          vec2 dir = length(vVel.xy) > 1e-4 ? normalize(vVel.xy) : vec2(0.0, 1.0);
          float stretch = 1.0 + aParams.z * length(vVel.xy) * 0.06;
          vec2 p = position.xy * aParams.x;
          // Rotate the quad so +Y follows the velocity, then stretch along it.
          vec2 side = vec2(dir.y, -dir.x);
          vec2 q = side * p.x + dir * p.y * stretch;
          center.xy += q;
          gl_Position = projectionMatrix * center;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vAge;
        void main() {
          vec2 d = vUv * 2.0 - 1.0;
          float r = dot(d, d);
          float shape = ${soft ? 'smoothstep(1.0, 0.0, r) * smoothstep(1.0, 0.6, r + 0.25)' : 'exp(-r * 4.0)'};
          float a = shape * vAlpha;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor * ${soft ? '1.0' : 'a'}, ${soft ? 'a' : '1.0'});
        }`,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
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
      }
      this.age[n] = age;
      const damping = Math.exp(-this.drag[n] * dt);
      this.vel[n * 3] *= damping;
      this.vel[n * 3 + 1] = this.vel[n * 3 + 1] * damping - this.gravity[n] * dt;
      this.vel[n * 3 + 2] *= damping;
      this.pos[n * 3] += this.vel[n * 3] * dt;
      this.pos[n * 3 + 1] += this.vel[n * 3 + 1] * dt;
      this.pos[n * 3 + 2] += this.vel[n * 3 + 2] * dt;
      if (this.pos[n * 3 + 1] < 0.01 && this.vel[n * 3 + 1] < 0) {
        this.pos[n * 3 + 1] = 0.01;
        this.vel[n * 3 + 1] *= -0.35;
        this.vel[n * 3] *= 0.6;
        this.vel[n * 3 + 2] *= 0.6;
      }
      const t = age / this.life[n];
      this.offset.setXYZ(n, this.pos[n * 3], this.pos[n * 3 + 1], this.pos[n * 3 + 2]);
      this.velocityAttr.setXYZ(n, this.vel[n * 3], this.vel[n * 3 + 1], this.vel[n * 3 + 2]);
      this.colorAttr.setXYZ(n, this.col[n * 3], this.col[n * 3 + 1], this.col[n * 3 + 2]);
      const fade = Math.min(1, t * 8) * (1 - t) * (1 - t);
      this.params.setXYZW(n, this.size[n] * (1 + (this.grow[n] - 1) * t), this.alpha[n] * fade, this.stretch[n], t);
      n++;
    }
    this.count = n;
    this.geometry.instanceCount = n;
    for (const a of [this.offset, this.velocityAttr, this.colorAttr, this.params]) {
      a.needsUpdate = true;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
    }
  }
}

export class Particles {
  readonly glow = new ParticleSystem(AdditiveBlending, false);
  readonly smoke = new ParticleSystem(NormalBlending, true);

  update(dt: number): void {
    this.glow.update(dt);
    this.smoke.update(dt);
  }

  private readonly v = new Vector3();

  /** Bullet impact: sparks, a dust puff, and a hot flash. */
  impact(point: Vector3, normal: Vector3, metal: boolean): void {
    const sparks = metal ? 14 : 7;
    for (let i = 0; i < sparks; i++) {
      const dir = this.v.copy(normal).add(randomUnit().multiplyScalar(0.8)).normalize();
      this.glow.spawn({
        position: point.clone(),
        velocity: dir.multiplyScalar(4 + Math.random() * 9),
        color: new Color(1, 0.55 + Math.random() * 0.3, 0.2).multiplyScalar(3),
        size: 0.02 + Math.random() * 0.015,
        life: 0.25 + Math.random() * 0.35,
        gravity: 9,
        drag: 1.5,
        stretch: 3,
      });
    }
    this.glow.spawn({ position: point.clone().addScaledVector(normal, 0.03), velocity: new Vector3(), color: new Color(4, 2.6, 1.4), size: 0.28, life: 0.07 });
    for (let i = 0; i < 4; i++) {
      this.smoke.spawn({
        position: point.clone().addScaledVector(normal, 0.05),
        velocity: normal.clone().multiplyScalar(0.6 + Math.random()).add(randomUnit().multiplyScalar(0.3)),
        color: metal ? new Color('#8a8a8a') : new Color('#b4ab9c'),
        size: 0.18 + Math.random() * 0.12,
        grow: 3.2,
        life: 0.9 + Math.random() * 0.8,
        drag: 2.5,
        gravity: -0.15,
        alpha: 0.45,
      });
    }
  }

  muzzle(point: Vector3, forward: Vector3): void {
    for (let i = 0; i < 3; i++) {
      this.glow.spawn({
        position: point.clone().addScaledVector(forward, 0.04 + i * 0.07),
        velocity: forward.clone().multiplyScalar(2),
        color: new Color(5, 3.2, 1.4),
        size: 0.16 - i * 0.035,
        life: 0.045,
        stretch: 0,
      });
    }
    this.smoke.spawn({
      position: point.clone().addScaledVector(forward, 0.1),
      velocity: forward.clone().multiplyScalar(1.4).add(new Vector3(0, 0.4, 0)),
      color: new Color('#c9c4bb'),
      size: 0.12,
      grow: 4,
      life: 0.7,
      drag: 3,
      alpha: 0.18,
    });
  }

  explosion(point: Vector3): void {
    // White-hot core, then a rolling fireball.
    this.glow.spawn({ position: point.clone(), velocity: new Vector3(), color: new Color(9, 7, 5), size: 5.5, grow: 1.4, life: 0.16 });
    this.glow.spawn({ position: point.clone().add(new Vector3(0, 0.5, 0)), velocity: new Vector3(0, 3, 0), color: new Color(6, 2.6, 0.8), size: 4, grow: 1.6, life: 0.45 });
    for (let i = 0; i < 46; i++) {
      this.glow.spawn({
        position: point.clone().add(randomUnit().multiplyScalar(0.4)),
        velocity: randomUnit().multiplyScalar(2 + Math.random() * 7).add(new Vector3(0, 2.5, 0)),
        color: new Color(1, 0.35 + Math.random() * 0.35, 0.08).multiplyScalar(5 + Math.random() * 5),
        size: 1.0 + Math.random() * 1.4,
        grow: 2.2,
        life: 0.45 + Math.random() * 0.6,
        drag: 3.5,
      });
    }
    for (let i = 0; i < 60; i++) {
      this.glow.spawn({
        position: point.clone(),
        velocity: randomUnit().multiplyScalar(8 + Math.random() * 16).add(new Vector3(0, 4, 0)),
        color: new Color(1, 0.6, 0.25).multiplyScalar(4),
        size: 0.04,
        life: 0.6 + Math.random() * 0.9,
        gravity: 9.8,
        drag: 0.8,
        stretch: 4,
      });
    }
    for (let i = 0; i < 34; i++) {
      this.smoke.spawn({
        position: point.clone().add(randomUnit().multiplyScalar(0.8)),
        velocity: randomUnit().multiplyScalar(1 + Math.random() * 3).add(new Vector3(0, 2 + Math.random() * 2, 0)),
        color: new Color().setHSL(0.07, 0.08, 0.12 + Math.random() * 0.12),
        size: 1.1 + Math.random() * 1.2,
        grow: 3,
        life: 3 + Math.random() * 3,
        drag: 1.4,
        gravity: -0.4,
        alpha: 0.7,
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
