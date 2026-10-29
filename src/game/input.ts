/** Keyboard + pointer-locked mouse state. */

export const KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['KeyC', 'ControlLeft'],
  reload: ['KeyR'],
  preview: ['KeyG'],
  hud: ['KeyH'],
};

export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  fire = false;
  aim = false;
  locked = false;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (this.locked && (e.code === 'Tab' || e.code.startsWith('Control'))) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.fire = this.aim = false;
    });
    element.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.aim = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.aim = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseX += e.movementX;
      this.mouseY += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
      if (!this.locked) this.fire = this.aim = false;
    });
  }

  lock(): void {
    void this.element.requestPointerLock();
  }

  held(action: keyof typeof KEYS): boolean {
    return KEYS[action].some((k) => this.down.has(k));
  }

  /** True once per key press. */
  tapped(action: keyof typeof KEYS): boolean {
    return KEYS[action].some((k) => this.pressed.has(k));
  }

  /** Call at the end of each frame. */
  endFrame(): void {
    this.pressed.clear();
    this.mouseX = this.mouseY = 0;
  }
}
