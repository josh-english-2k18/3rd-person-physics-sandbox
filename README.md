# MotionBricks Range

A third-person shooter prototype whose special-ops operator is animated **live, in the browser** by [NVIDIA MotionBricks](https://github.com/NVlabs/motionbricks), a 200M-parameter generative motion model. Everything runs on the page: the ONNX model runs on WebGPU (with a WASM fallback), physics runs on Rapier, and rendering uses three.js. There is no server.

![The operator sprinting, with MotionBricks' generated future motion drawn as holograms](./screenshot.png)

The cyan-to-violet wireframes show what MotionBricks just generated: the operator's next 1–2 seconds of motion. Amber is the target pose the model is steering toward, green is the context it was conditioned on, and rings mark predicted footfalls.

## Running it

```bash
npm install
npm run setup      # downloads the MotionBricks model (~380 MB) + sample clips, optimizes the character
npm run dev        # http://localhost:5173
```

Use a recent Chromium browser for WebGPU. Other browsers fall back to multithreaded WASM, which is slower; add `?backend=wasm` to force that path. The model is cached in the browser after the first load.

| Input | Action |
| --- | --- |
| `W A S D` | Move (camera-relative) |
| Mouse | Look |
| `LMB` | Fire |
| `RMB` | Aim; the operator strafes and faces the crosshair |
| `Shift` | Sprint |
| `C` | Crouch (directional crouch walk) |
| `R` | Reload |
| `G` | Toggle the motion preview |
| `H` | Toggle the HUD |

Things to shoot include crates that splinter, red barrels that explode (and set each other off), hinged steel plates and cans on the range, glass panes, a cube pyramid, and a plank tower.

## How the operator moves

The code in `src/motion/` is a TypeScript port of the MotionBricks SOMA runtime.

1. **Engine** (`engine.ts`) encodes four context poses and one to four target poses into the model's tensors. It aligns them by heading, computes root velocities and 6D rotations, and runs the ONNX graph. It then decodes the generated frames and applies endpoint correction, so the motion starts exactly where the character is and ends on the target. It matches the Python reference to within millimetres; see the integration test.
2. **Player** (`player.ts`) plays generations back and records every displayed pose. The last 0.1 s of that history becomes the next generation's context. Inference is asynchronous, so a new generation starts at the elapsed latency and crossfades in.
3. **Locomotion** (`locomotion.ts`) follows the Scene Preview runtime. Targets are blended from sample-clip windows in three blend spaces: speed for jog/sprint, direction for aimed strafing, and direction for crouching. Each target is placed about a second ahead along a spring-smoothed desired velocity. A new generation is requested on turns, speed changes, or when the current motion runs out. Standing still is a generated transition into an idle clip, and turning in place is a generated turn.
4. **Physics** (`src/game/player.ts`) moves a Rapier kinematic capsule along the generated root path. Whatever the world blocks is pushed back into the motion, so the next generation starts from where the operator actually is.
5. **Retargeting** (`src/character/retarget.ts`) maps the 77-joint SOMA skeleton onto the Mixamo-rigged operator, using a per-bone frame calibration that tolerates different bind poses. An aim layer (`soldier.ts`) then twists the spine toward the crosshair, shoulders the carbine, and uses two-bone IK to keep both hands on it.

## Project layout

```
src/
  main.ts            loading, wiring, frame loop
  motion/            MotionBricks port: BVH, skeleton math, engine, playback, locomotion
  character/         retargeting, IK, the operator + weapon handling
  game/              input, camera rig, player character, weapon
  world/             Rapier wrapper, grey-box level, shootable props
  fx/                motion-preview holograms, particles, tracers/decals/flashes
  render/            renderer + post stack (N8AO, bloom, ACES, SMAA), grid material
  ui/                splash + HUD
  audio.ts           procedural WebAudio sound effects
scripts/             fetch-motionbricks.mjs, optimize-models.mjs
assets-src/models/   source GLB (+ attribution)
public/              generated: models/, motionbricks/ (gitignored)
```

## Tests

`npm test` runs the MotionBricks port against the real model in Node with onnxruntime-node. It checks inbetweening fidelity against a real clip and steers locomotion along a path. The tests skip if `npm run setup` has not been run.

## Licensing

- Code: MIT, see [`LICENSE`](./LICENSE).
- MotionBricks models: [NVIDIA Open Model Agreement](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/). The sample BVH clips are under the NVIDIA Sample Data Evaluation License, for evaluation only. Both are downloaded by `npm run setup` and are not committed.
- The operator model is "S.W.A.T. Operator" by Mateusz Woliński, CC-BY-4.0. See [`assets-src/models/README.md`](./assets-src/models/README.md) and [`metadata.json`](./metadata.json).
