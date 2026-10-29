import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Vector3,
} from 'three';

/** Tracers, bullet-hole decals, and flash lights for gunfire and explosions. */

const TRACER = { speed: 320, length: 2.6, max: 48 };
const DECALS = 400;

interface Tracer {
  from: Vector3;
  dir: Vector3;
  distance: number;
  travelled: number;
}

interface Flash {
  light: PointLight;
  life: number;
  age: number;
  intensity: number;
}

function bulletHoleTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.16, 'rgba(10,8,6,0.95)');
  grad.addColorStop(0.3, 'rgba(40,34,28,0.75)');
  grad.addColorStop(0.62, 'rgba(60,52,44,0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // Cracks
  g.strokeStyle = 'rgba(20,16,12,0.55)';
  g.lineWidth = 2;
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2;
    g.beginPath();
    g.moveTo(size / 2, size / 2);
    g.lineTo(size / 2 + Math.cos(a) * size * (0.25 + Math.random() * 0.2), size / 2 + Math.sin(a) * size * (0.25 + Math.random() * 0.2));
    g.stroke();
  }
  return new CanvasTexture(canvas);
}

export class CombatFx {
  readonly group = new Group();
  private readonly tracers: Tracer[] = [];
  private readonly tracerMesh: InstancedMesh;
  private readonly decals: InstancedMesh;
  private decalCursor = 0;
  private readonly flashes: Flash[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly p = new Vector3();

  constructor() {
    this.tracerMesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1).translate(0, 0, 0.5),
      new MeshBasicMaterial({ color: new Color(6, 3.6, 1.6), blending: AdditiveBlending, transparent: true, depthWrite: false }),
      TRACER.max,
    );
    this.tracerMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.count = 0;

    this.decals = new InstancedMesh(
      new PlaneGeometry(1, 1),
      new MeshStandardMaterial({
        map: bulletHoleTexture(),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        roughness: 1,
      }),
      DECALS,
    );
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.receiveShadow = true;
    this.group.add(this.tracerMesh, this.decals);

    for (let i = 0; i < 4; i++) {
      const light = new PointLight('#ffb062', 0, 12, 2);
      this.group.add(light);
      this.flashes.push({ light, life: 0, age: 1, intensity: 0 });
    }
  }

  tracer(from: Vector3, to: Vector3): void {
    if (this.tracers.length >= TRACER.max) this.tracers.shift();
    const dir = to.clone().sub(from);
    const distance = dir.length();
    this.tracers.push({ from: from.clone(), dir: dir.normalize(), distance, travelled: 0 });
  }

  decal(point: Vector3, normal: Vector3): void {
    const size = 0.09 + Math.random() * 0.05;
    this.q.setFromUnitVectors(new Vector3(0, 0, 1), normal);
    this.q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.random() * Math.PI * 2));
    this.m.compose(this.p.copy(point).addScaledVector(normal, 0.004), this.q, this.s.set(size, size, size));
    this.decals.setMatrixAt(this.decalCursor, this.m);
    this.decalCursor = (this.decalCursor + 1) % DECALS;
    this.decals.count = Math.min(DECALS, this.decals.count + 1);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  flash(position: Vector3, intensity: number, life: number, color = '#ffb062', distance = 12): void {
    const flash = this.flashes.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    flash.light.position.copy(position);
    flash.light.color.set(color);
    flash.light.distance = distance;
    flash.intensity = intensity;
    flash.life = life;
    flash.age = 0;
  }

  update(dt: number): void {
    let n = 0;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.travelled += TRACER.speed * dt;
      if (t.travelled - TRACER.length > t.distance) {
        this.tracers.splice(i, 1);
        continue;
      }
      const head = Math.min(t.travelled, t.distance);
      const tail = Math.max(0, t.travelled - TRACER.length);
      const length = Math.max(0.01, head - tail);
      this.q.setFromUnitVectors(new Vector3(0, 0, 1), t.dir);
      this.m.compose(this.p.copy(t.from).addScaledVector(t.dir, tail), this.q, this.s.set(0.014, 0.014, length));
      this.tracerMesh.setMatrixAt(n++, this.m);
    }
    this.tracerMesh.count = n;
    this.tracerMesh.instanceMatrix.needsUpdate = true;

    for (const f of this.flashes) {
      f.age += dt;
      const k = Math.max(0, 1 - f.age / Math.max(f.life, 1e-3));
      f.light.intensity = f.intensity * k * k;
    }
  }
}
