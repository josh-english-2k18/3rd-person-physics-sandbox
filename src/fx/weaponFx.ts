import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';

/** Muzzle flash, ejected brass, and the laser sight. */

function canvasTexture(size: [number, number], draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = size;
  draw(canvas.getContext('2d')!, size[0], size[1]);
  return new CanvasTexture(canvas);
}

/** Side view of a flash: a hot core with flame petals, brightest at the muzzle (left edge). */
function flashSideTexture(): CanvasTexture {
  return canvasTexture([256, 128], (g, w, h) => {
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 9; i++) {
      const len = w * (0.45 + Math.random() * 0.55);
      const spread = (Math.random() - 0.5) * h * 0.5;
      const grad = g.createLinearGradient(0, 0, len, 0);
      grad.addColorStop(0, 'rgba(255,240,200,0.9)');
      grad.addColorStop(0.35, 'rgba(255,170,70,0.55)');
      grad.addColorStop(1, 'rgba(255,90,20,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, h / 2);
      g.quadraticCurveTo(len * 0.5, h / 2 + spread - h * 0.12, len, h / 2 + spread);
      g.quadraticCurveTo(len * 0.5, h / 2 + spread + h * 0.12, 0, h / 2);
      g.fill();
    }
    const core = g.createRadialGradient(0, h / 2, 0, 0, h / 2, h * 0.5);
    core.addColorStop(0, 'rgba(255,255,240,1)');
    core.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = core;
    g.fillRect(0, 0, w, h);
  });
}

/** Front view: a four-to-six point star. */
function flashFrontTexture(): CanvasTexture {
  return canvasTexture([128, 128], (g, w, h) => {
    g.globalCompositeOperation = 'lighter';
    g.translate(w / 2, h / 2);
    const points = 5 + Math.floor(Math.random() * 2);
    for (let i = 0; i < points; i++) {
      g.rotate((Math.PI * 2) / points);
      const grad = g.createLinearGradient(0, 0, w / 2, 0);
      grad.addColorStop(0, 'rgba(255,245,210,1)');
      grad.addColorStop(1, 'rgba(255,120,30,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, -5);
      g.lineTo(w / 2, 0);
      g.lineTo(0, 5);
      g.fill();
    }
    const core = g.createRadialGradient(0, 0, 0, 0, 0, w * 0.3);
    core.addColorStop(0, 'rgba(255,255,245,1)');
    core.addColorStop(1, 'rgba(255,190,100,0)');
    g.fillStyle = core;
    g.fillRect(-w / 2, -h / 2, w, h);
  });
}

export class MuzzleFlash {
  readonly group = new Group();
  private timer = 0;
  private readonly sides: Mesh[] = [];
  private readonly front: Mesh;

  /** Parent to the weapon's muzzle point (forward = +Z). */
  constructor(muzzle: Object3D) {
    const sideMaterials = [0, 1, 2].map(
      () => new MeshBasicMaterial({ map: flashSideTexture(), color: new Color(3.2, 2.4, 1.6), blending: AdditiveBlending, transparent: true, depthWrite: false, side: DoubleSide }),
    );
    const sideGeometry = new PlaneGeometry(0.34, 0.14).translate(0.17, 0, 0).rotateY(-Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      const side = new Mesh(sideGeometry, sideMaterials[i]);
      side.rotation.z = (i / 3) * Math.PI;
      this.sides.push(side);
      this.group.add(side);
    }
    this.front = new Mesh(
      new PlaneGeometry(0.2, 0.2),
      new MeshBasicMaterial({ map: flashFrontTexture(), color: new Color(3, 2.3, 1.5), blending: AdditiveBlending, transparent: true, depthWrite: false, side: DoubleSide }),
    );
    this.front.position.z = 0.02;
    this.group.add(this.front);
    this.group.visible = false;
    this.group.renderOrder = 22;
    muzzle.add(this.group);
  }

  trigger(size = 1): void {
    this.timer = 0.035 * Math.sqrt(size);
    this.group.rotation.z = Math.random() * Math.PI * 2;
    const s = (0.8 + Math.random() * 0.45) * size;
    this.group.scale.set(s, s, (0.7 + Math.random() * 0.6) * size);
    this.sides.forEach((side, i) => (side.visible = Math.random() > 0.15 || i === 0));
  }

  update(dt: number): void {
    this.timer -= dt;
    this.group.visible = this.timer > 0;
  }
}

const SHELLS = 80;

interface Shell {
  pos: Vector3;
  vel: Vector3;
  rot: Quaternion;
  spin: Vector3;
  age: number;
  floor: number;
  landed: boolean;
}

export class ShellCasings {
  readonly mesh: InstancedMesh;
  private readonly shells: Shell[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly one = new Vector3(1, 1, 1);
  onLand?: (at: Vector3) => void;

  constructor() {
    const geometry = new CylinderGeometry(0.0048, 0.0048, 0.045, 10).rotateX(Math.PI / 2);
    const material = new MeshStandardMaterial({ color: '#c99a45', metalness: 1, roughness: 0.28, envMapIntensity: 1.6 });
    this.mesh = new InstancedMesh(geometry, material, SHELLS);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** Ejects a casing from `port` toward the weapon's right side. */
  eject(port: Vector3, right: Vector3, up: Vector3, forward: Vector3, floor: number): void {
    if (this.shells.length >= SHELLS) this.shells.shift();
    const vel = right.clone().multiplyScalar(1.4 + Math.random() * 0.8)
      .addScaledVector(up, 1.6 + Math.random() * 0.7)
      .addScaledVector(forward, -0.4 + Math.random() * 0.4);
    this.shells.push({
      pos: port.clone(),
      vel,
      rot: new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), forward),
      spin: new Vector3((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 10),
      age: 0,
      floor,
      landed: false,
    });
  }

  update(dt: number): void {
    let n = 0;
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.age += dt;
      if (s.age > 6) {
        this.shells.splice(i, 1);
        continue;
      }
      s.vel.y -= 9.8 * dt;
      s.pos.addScaledVector(s.vel, dt);
      const ground = s.floor + 0.005;
      if (s.pos.y < ground) {
        s.pos.y = ground;
        if (!s.landed && s.vel.y < -1) this.onLand?.(s.pos);
        s.landed = true;
        s.vel.y *= -0.32;
        s.vel.x *= 0.55;
        s.vel.z *= 0.55;
        s.spin.multiplyScalar(0.5);
      }
      const angle = s.spin.length() * dt;
      if (angle > 1e-5) s.rot.premultiply(this.q.setFromAxisAngle(s.spin.clone().normalize(), angle));
      this.m.compose(s.pos, s.rot, this.one);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class LaserSight {
  readonly group = new Group();
  private readonly beam: Mesh;
  private readonly dot: Mesh;
  private readonly color = new Color('#46ff7a');
  private visibility = 0;

  constructor() {
    this.beam = new Mesh(
      new CylinderGeometry(0.0015, 0.0015, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2),
      new MeshBasicMaterial({ color: this.color.clone().multiplyScalar(1.5), blending: AdditiveBlending, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.dot = new Mesh(
      new SphereGeometry(0.012, 10, 8),
      new MeshBasicMaterial({ color: this.color.clone().multiplyScalar(6), blending: AdditiveBlending, transparent: true, depthWrite: false }),
    );
    this.group.add(this.beam, this.dot);
    this.group.renderOrder = 22;
    this.beam.frustumCulled = this.dot.frustumCulled = false;
  }

  update(dt: number, on: boolean, from: Vector3, to: Vector3): void {
    this.visibility += ((on ? 1 : 0) - this.visibility) * Math.min(1, dt * 10);
    this.group.visible = this.visibility > 0.02;
    if (!this.group.visible) return;
    const dir = to.clone().sub(from);
    const length = dir.length();
    this.beam.position.copy(from);
    this.beam.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir.normalize());
    this.beam.scale.set(1, 1, length);
    (this.beam.material as MeshBasicMaterial).opacity = 0.35 * this.visibility;
    this.dot.position.copy(to);
    this.dot.scale.setScalar((0.6 + Math.min(length, 40) * 0.04) * this.visibility);
  }
}
