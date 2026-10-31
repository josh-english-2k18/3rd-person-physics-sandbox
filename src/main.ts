import { Clock, Vector2, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Audio } from './audio';
import { Soldier } from './character/soldier';
import { CombatFx } from './fx/combat';
import { MotionPreview } from './fx/motionPreview';
import { Particles } from './fx/particles';
import { LaserSight, MuzzleFlash, ShellCasings } from './fx/weaponFx';
import { CameraRig } from './game/cameraRig';
import { Input } from './game/input';
import { PlayerCharacter } from './game/player';
import { Weapon } from './game/weapon';
import { parseBvh, type Clip } from './motion/bvh';
import { MotionBricksEngine, type LoadProgress } from './motion/engine';
import { LocomotionController, TARGET_CLIPS } from './motion/locomotion';
import { MotionPlayer } from './motion/player';
import { Renderer } from './render/renderer';
import { Hud, Splash } from './ui/hud';
import { buildLevel } from './world/level';
import { Physics, RAPIER } from './world/physics';
import { Props } from './world/props';

const ASSETS = {
  model: `${import.meta.env.BASE_URL}motionbricks/mmm_v6_soma_fp16.onnx`,
  clips: `${import.meta.env.BASE_URL}motionbricks/clips/`,
  operator: `${import.meta.env.BASE_URL}models/operator.glb`,
  sky: `${import.meta.env.BASE_URL}hdri/sky_4k.hdr`,
};

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui')!;
const params = new URLSearchParams(location.search);
/** `?test` lets automated runs play without pointer lock. */
const TEST = params.has('test');

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;

async function loadClips(): Promise<Map<string, Clip>> {
  const names = [...new Set(Object.values(TARGET_CLIPS))];
  const clips = await Promise.all(
    names.map(async (name) => {
      const res = await fetch(`${ASSETS.clips}${name}.bvh`);
      if (!res.ok) throw new Error(`Missing clip ${name}.bvh — run \`npm run setup\`.`);
      return parseBvh(name, await res.text());
    }),
  );
  return new Map(clips.map((c) => [c.name, c]));
}

async function main(): Promise<void> {
  const renderer = new Renderer(canvas);
  const audio = new Audio();
  const input = new Input(canvas);
  let started = false;
  const splash = new Splash(ui, () => {
    audio.resume();
    if (TEST) input.locked = true;
    else input.lock();
    started = true;
  });
  const hud = new Hud(ui);

  // World first, so there is something beautiful behind the loading screen.
  const physics = await Physics.create();
  const level = buildLevel(physics);
  renderer.scene.add(level.group);
  const particles = new Particles();
  const fx = new CombatFx();
  renderer.scene.add(particles.glow.mesh, particles.smoke.mesh, fx.group);
  const rig = new CameraRig(renderer.camera, physics);
  const props = new Props(physics, particles, fx, audio, {
    shake: (amount, at) => {
      const d = at.distanceTo(renderer.camera.position);
      const k = amount * Math.max(0, 1 - d / 40);
      rig.shake(k * 0.9);
      renderer.shock = Math.max(renderer.shock, k);
    },
  });
  renderer.scene.add(props.group);

  // Idle camera orbit while loading.
  const clock = new Clock();
  let orbit = 0;
  let loading = true;
  const idle = () => {
    if (!loading) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    orbit += dt * 0.05;
    renderer.camera.position.set(Math.sin(orbit) * 26, 9, Math.cos(orbit) * 26);
    renderer.camera.lookAt(0, 1, 0);
    renderer.followShadows(new Vector3());
    physics.step(dt);
    props.update(dt);
    renderer.render(dt);
    requestAnimationFrame(idle);
  };
  idle();

  let engine: MotionBricksEngine;
  let clips: Map<string, Clip>;
  let gltf;
  try {
    splash.progress(0.02, 'Loading motion clips…');
    const assets = Promise.all([
      loadClips(),
      new GLTFLoader().loadAsync(ASSETS.operator),
      renderer.useHdri(ASSETS.sky).catch((e) => console.warn('HDRI sky unavailable; using the procedural sky', e)),
    ]);

    [clips, gltf] = await assets;
    const skeleton = clips.get(TARGET_CLIPS.idle)!.skeleton;
    splash.progress(0.05, 'Downloading MotionBricks SOMA model…');
    engine = await MotionBricksEngine.load(ASSETS.model, skeleton, (p: LoadProgress) => {
      const done = p.loaded >= p.total;
      splash.progress(0.05 + 0.85 * (p.loaded / p.total), done ? 'Compiling model for your GPU…' : 'Downloading MotionBricks SOMA model…', `${mb(p.loaded)} / ${mb(p.total)}`);
    }, params.get('backend') === 'wasm' ? 'wasm' : undefined);
    splash.progress(0.97, `Model ready on ${engine.backend.toUpperCase()}`);
  } catch (error) {
    console.error(error);
    splash.fail(error instanceof Error ? error.message : String(error));
    return;
  }

  // Assemble the operator.
  const idleClip = clips.get(TARGET_CLIPS.idle)!;
  const skeleton = idleClip.skeleton;
  const reference = idleClip.frames[0];
  const soldier = new Soldier(gltf, skeleton, reference, reference.pos[1]);
  renderer.scene.add(soldier.root);
  const motion = new MotionPlayer(engine, skeleton, reference);
  const locomotion = new LocomotionController(skeleton, motion, clips);
  const spawnHeading = Math.PI; // face -Z, toward the arena
  const player = new PlayerCharacter(physics, motion, soldier, locomotion, level.spawn, spawnHeading);
  player.onFootstep = (at, weight) => audio.footstep(at, weight);
  const weapon = new Weapon(physics, props, particles, fx, audio);
  weapon.onHit = (surface) => surface && hud.hit();
  const muzzleFlash = new MuzzleFlash(soldier.muzzle);
  const shells = new ShellCasings();
  const laser = new LaserSight();
  shells.onLand = (at) => audio.shell(at);
  renderer.scene.add(shells.mesh, laser.group);
  weapon.onShot = () => {
    muzzleFlash.trigger();
    shells.eject(soldier.port.getWorldPosition(new Vector3()), soldier.weaponRight, soldier.weaponUp, soldier.weaponForward, player.position.y);
  };
  const preview = new MotionPreview(skeleton);
  renderer.scene.add(preview.group);
  rig.yaw = spawnHeading;

  loading = false;
  splash.ready();
  if (TEST) Object.assign(window, { __game: { input, rig, player, weapon, preview, motion, locomotion, engine, physics } });

  document.addEventListener('pointerlockchange', () => {
    if (input.locked) {
      splash.hide();
      hud.visible = true;
    } else if (started) {
      splash.show(true);
    }
  });
  if (TEST) {
    // No pointer lock in automation: deploy straight away.
    splash.hide();
    hud.visible = true;
    input.locked = true;
  }

  const aimTarget = new Vector3();
  const camDir = new Vector3();
  const loop = () => {
    const dt = Math.min(clock.getDelta(), 1 / 20);
    const active = input.locked;

    if (active) rig.look(input.mouseX, input.mouseY);
    if (input.tapped('preview')) preview.visible = !preview.visible;
    if (input.tapped('hud')) hud.visible = !hud.visible;
    if (input.tapped('reload')) weapon.reload();

    // Where the crosshair points in the world.
    rig.direction(camDir);
    const hit = physics.world.castRay(new RAPIER.Ray(rig.position, camDir), 400, true, undefined, undefined, player.collider);
    aimTarget.copy(rig.position).addScaledVector(camDir, hit ? Math.max(hit.timeOfImpact, 2) : 400);
    const chest = player.position.clone().add(new Vector3(0, 1.4, 0));
    const aimDirection = aimTarget.clone().sub(chest).normalize();

    const move = new Vector2(
      (input.held('right') ? 1 : 0) - (input.held('left') ? 1 : 0),
      (input.held('forward') ? 1 : 0) - (input.held('backward') ? 1 : 0),
    );
    const firing = active && input.fire;
    const aiming = active && (input.aim || firing || weapon.recoil > 0.05);
    player.update(dt, {
      move: active ? move : new Vector2(),
      cameraHeading: rig.heading,
      aimDirection,
      aiming,
      sprint: input.held('sprint'),
      crouch: input.held('crouch'),
      recoil: weapon.recoil,
    });

    const kick = weapon.update(dt, firing && aiming, input.aim, rig.position, rig.direction(new Vector3()), soldier.muzzleWorld, player.collider);
    if (kick) {
      rig.kick(kick.pitch, kick.yaw);
      rig.shake(0.06);
    }

    physics.step(dt);
    props.update(dt);
    rig.update(dt, player.position, input.aim && active, input.held('sprint') && move.y > 0, input.held('crouch'), player.collider);
    audio.setListener(rig.position);
    renderer.followShadows(player.position);
    particles.update(dt);
    fx.update(dt);
    muzzleFlash.update(dt);
    shells.update(dt);
    const laserFrom = soldier.laser.getWorldPosition(new Vector3());
    const laserDir = soldier.weaponForward;
    const laserHit = physics.world.castRay(new RAPIER.Ray(laserFrom, laserDir), 150, true, undefined, undefined, player.collider);
    laser.update(dt, active && input.aim, laserFrom, laserFrom.clone().addScaledVector(laserDir, laserHit ? laserHit.timeOfImpact : 150));


    const generation = motion.lastGeneration;
    if (generation) preview.setGeneration(generation);
    const status = locomotion.status;
    preview.update(dt, motion.playbackTime, player.groundOffset.y, status.targets, motion.currentContext(), !motion.playingClip);

    hud.update(
      dt,
      {
        backend: engine.backend,
        inferenceMs: generation?.inferenceMs ?? 0,
        tokens: generation?.tokens ?? 0,
        frames: generation?.frames.length ?? 0,
        generations: motion.generations,
        state: status.state,
        mode: status.mode,
        speed: status.speed,
        preview: preview.visible,
      },
      weapon.ammo,
      weapon.reloading > 0,
      weapon.spread,
      renderer.camera.fov,
    );
    renderer.render(dt);
    input.endFrame();
    requestAnimationFrame(loop);
  };
  loop();
}

void main();
