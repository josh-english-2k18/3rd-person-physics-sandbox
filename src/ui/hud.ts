import { CARBINE } from '../game/weapon';

/** DOM overlays: the loading/deploy splash, pause screen, and the in-game HUD. */

const CONTROLS = [
  ['W A S D', 'Move'],
  ['Mouse', 'Look'],
  ['LMB', 'Fire'],
  ['RMB', 'Aim / strafe'],
  ['Shift', 'Sprint'],
  ['C', 'Crouch (toggle)'],
  ['Space', 'Jump / vault'],
  ['R', 'Reload'],
  ['G', 'Motion preview'],
];

const html = (strings: TemplateStringsArray, ...values: unknown[]) =>
  strings.reduce((out, s, i) => out + s + (i < values.length ? String(values[i]) : ''), '');

export class Splash {
  private readonly root: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly statusLeft: HTMLSpanElement;
  private readonly statusRight: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private readonly error: HTMLDivElement;
  private readonly subtitle: HTMLDivElement;

  constructor(parent: HTMLElement, onDeploy: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'splash';
    this.root.innerHTML = html`
      <div class="splash-inner">
        <div class="kicker">NVIDIA MotionBricks · in-browser</div>
        <div class="title">Motion<span>Bricks</span> Range</div>
        <div class="subtitle">A third-person shooter whose operator is animated live by a 200M-parameter generative motion model, running entirely on this page.</div>
        <div class="progress"><div></div></div>
        <div class="status"><span>Initializing…</span><span></span></div>
        <button class="deploy">Deploy ▸</button>
        <div class="controls">${CONTROLS.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('')}</div>
        <div class="error"></div>
      </div>`;
    parent.appendChild(this.root);
    this.bar = this.root.querySelector('.progress > div')!;
    [this.statusLeft, this.statusRight] = Array.from(this.root.querySelectorAll<HTMLSpanElement>('.status span'));
    this.button = this.root.querySelector('.deploy')!;
    this.error = this.root.querySelector('.error')!;
    this.subtitle = this.root.querySelector('.subtitle')!;
    this.button.addEventListener('click', onDeploy);
  }

  progress(fraction: number, left: string, right = ''): void {
    this.bar.style.width = `${Math.round(fraction * 100)}%`;
    this.statusLeft.textContent = left;
    this.statusRight.textContent = right;
  }

  ready(): void {
    this.progress(1, 'Ready', '');
    this.button.classList.add('ready');
  }

  fail(message: string): void {
    this.error.textContent = message;
  }

  show(paused: boolean): void {
    this.root.classList.remove('hidden');
    this.root.classList.toggle('overlay', paused);
    if (paused) {
      this.subtitle.textContent = 'Paused. Click to resume.';
      this.button.textContent = 'Resume ▸';
    }
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}

export interface MotionStats {
  backend: string;
  inferenceMs: number;
  tokens: number;
  frames: number;
  generations: number;
  state: string;
  mode: string;
  speed: number;
  preview: boolean;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly fields: Record<string, HTMLElement> = {};
  private readonly spark: HTMLCanvasElement;
  private readonly history: number[] = [];
  private readonly crosshair: HTMLDivElement;
  private readonly hitmarker: HTMLDivElement;
  private readonly ammoCount: HTMLDivElement;
  private readonly ammoBar: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private hitTimer = 0;
  private lastGeneration = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud hidden';
    this.root.innerHTML = html`
      <div class="brand"><div class="kicker">Live · generative locomotion</div><div class="name">MOTIONBRICKS RANGE</div></div>
      <div class="mb">
        <div class="mb-head"><b>MOTIONBRICKS</b><span class="pill" data-f="backend">—</span></div>
        <div class="mb-grid">
          <span>inference</span><span class="v" data-f="ms">—</span>
          <span>tokens · frames</span><span class="v" data-f="tokens">—</span>
          <span>generations</span><span class="v" data-f="gens">0</span>
          <span>state</span><span class="v" data-f="state">—</span>
          <span>speed</span><span class="v" data-f="speed">—</span>
        </div>
        <canvas width="536" height="88"></canvas>
        <div class="legend"><span><i style="background:#38f3ff"></i>future</span><span><i style="background:#ffb547"></i>target</span><span><i style="background:#4dff9a"></i>context</span><span data-f="preview"></span></div>
      </div>
      <div class="crosshair"><i class="dot"></i><i class="h l"></i><i class="h r"></i><i class="v t"></i><i class="v b"></i></div>
      <div class="hitmarker"></div>
      <div class="ammo"><div class="count">30<small>/ ∞</small></div><div class="bar"></div><div class="weapon">${CARBINE.name}</div></div>
      <div class="hint">${CONTROLS.map(([k, v]) => `<div><kbd>${k}</kbd>${v}</div>`).join('')}</div>`;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-f]').forEach((el) => (this.fields[el.dataset.f!] = el));
    this.spark = this.root.querySelector('.mb canvas')!;
    this.crosshair = this.root.querySelector('.crosshair')!;
    this.hitmarker = this.root.querySelector('.hitmarker')!;
    this.ammoCount = this.root.querySelector('.ammo .count')!;
    this.ammoBar = this.root.querySelector('.ammo .bar')!;
    this.ammoBar.innerHTML = '<i></i>'.repeat(CARBINE.magazine);
    this.hint = this.root.querySelector('.hint')!;
    setTimeout(() => this.hint.classList.add('faded'), 12000);
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  set visible(v: boolean) {
    this.root.classList.toggle('hidden', !v);
  }

  hit(): void {
    this.hitTimer = 0.12;
  }

  update(dt: number, stats: MotionStats, ammo: number, reloading: boolean, spread: number, fov: number): void {
    // Crosshair gap follows the actual spread cone.
    const px = Math.max(4, (Math.tan(spread) / Math.tan(((fov / 2) * Math.PI) / 180)) * (window.innerHeight / 2));
    const [, l, r, t, b] = Array.from(this.crosshair.children) as HTMLElement[];
    l.style.left = `${-px - 9}px`;
    r.style.left = `${px}px`;
    t.style.top = `${-px - 9}px`;
    b.style.top = `${px}px`;
    this.hitTimer -= dt;
    this.hitmarker.classList.toggle('on', this.hitTimer > 0);

    this.ammoCount.innerHTML = reloading ? '<span class="reloading">RELOAD</span>' : `${ammo}<small>/ ∞</small>`;
    Array.from(this.ammoBar.children).forEach((el, i) => el.classList.toggle('spent', i >= ammo));

    this.fields.backend.textContent = stats.backend.toUpperCase();
    this.fields.ms.textContent = `${stats.inferenceMs.toFixed(0)} ms`;
    this.fields.tokens.textContent = `${stats.tokens} · ${stats.frames}`;
    this.fields.gens.textContent = String(stats.generations);
    this.fields.state.textContent = `${stats.state} · ${stats.mode}`;
    this.fields.speed.textContent = `${stats.speed.toFixed(1)} m/s`;
    this.fields.preview.textContent = stats.preview ? '' : 'preview off (G)';
    if (stats.generations !== this.lastGeneration) {
      this.lastGeneration = stats.generations;
      this.history.push(stats.inferenceMs);
      if (this.history.length > 60) this.history.shift();
      this.drawSpark();
    }
  }

  private drawSpark(): void {
    const g = this.spark.getContext('2d')!;
    const { width: w, height: h } = this.spark;
    g.clearRect(0, 0, w, h);
    if (this.history.length < 2) return;
    const max = Math.max(60, ...this.history) * 1.1;
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#9d5cff');
    grad.addColorStop(1, '#38f3ff');
    g.beginPath();
    this.history.forEach((v, i) => {
      const x = (i / 59) * w;
      const y = h - (v / max) * (h - 6) - 3;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.strokeStyle = grad;
    g.lineWidth = 3;
    g.stroke();
    g.lineTo(((this.history.length - 1) / 59) * w, h);
    g.lineTo(0, h);
    g.closePath();
    const fill = g.createLinearGradient(0, 0, 0, h);
    fill.addColorStop(0, 'rgba(56,243,255,0.25)');
    fill.addColorStop(1, 'rgba(56,243,255,0)');
    g.fillStyle = fill;
    g.fill();
  }
}
