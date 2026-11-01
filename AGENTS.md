# Repository Guidelines

## Project Structure & Module Organization
A Vite + TypeScript + three.js app with no framework. `index.html` loads `src/main.ts`, which builds the renderer, physics world, level, and props, loads the MotionBricks model and clips, and runs the frame loop. Modules are grouped by concern:
- `src/motion/`: the MotionBricks SOMA port, covering BVH parsing, skeleton math, the ONNX engine, playback, and the locomotion state machine.
- `src/character/`: retargeting, IK, and the operator.
- `src/game/`: input, the camera rig, the player character, and the weapon.
- `src/world/`: Rapier physics, the level, and props.
- `src/fx/`, `src/render/`, `src/ui/`: effects, rendering, and UI.

Source GLBs live in `assets-src/models/` with attribution. Generated runtime assets go in `public/models/`, `public/motionbricks/` and `public/hdri/`. All are gitignored and produced by `npm run setup`.

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `npm run setup` downloads the MotionBricks ONNX model and clips (checksum-verified) and the HDRI sky, then optimizes the character GLB. Run it once per checkout.
- `npm run dev` starts Vite at http://localhost:5173. The server sends COOP/COEP headers so multithreaded WASM works.
- `npm run build` typechecks and bundles to `dist/`.
- `npm run preview` serves the build.
- `npm test` runs the Vitest integration tests against the real model.

## Coding Style & Naming Conventions
TypeScript with strict mode and 2-space indentation. Use classes for stateful systems (`MotionPlayer`, `Props`) and plain functions for math. Keep tuning constants in labeled objects near the top of each module (`RIG`, `AIM`, `MODES`, `LOOK`, `CARBINE`). Name files after their primary export. Coordinates are Y-up meters everywhere. A heading θ faces `(sin θ, 0, cos θ)`. The sun is a cascaded shadow map (`CSM` in `src/render/renderer.ts`), so don't add a `DirectionalLight`. New lit materials join the cascades automatically, because the renderer sweeps the scene every 0.25 s.

## Testing Guidelines
Run `npm test` after touching `src/motion/` or locomotion tuning. It guards gait quality (`gait.test.ts`: no shuffling or hopping) and responsiveness (start, stop and turn times). For visual or gameplay changes, run `npm run dev` and confirm the following:
- The splash loads the model (the HUD shows WEBGPU).
- WASD, sprint, aim-strafe, crouch, and Space (jump or vault) all produce smooth motion with holograms ahead of the operator.
- Shooting crates, barrels, plates, and glass works.
- The console shows no errors.
Appending `?test` skips pointer lock and exposes `window.__game` for automated runs.

## Commit & Pull Request Guidelines
Keep commits focused and write subjects in the present-tense imperative, under 72 characters. Describe observable behavior changes in the body. In PRs, note new dependencies or asset sources and include screenshots or clips for visual or motion changes.

## Generating Assets
New characters and weapons follow `scripts/assets/`:

1. Write a prompt in `assets.json`.
2. Run `npm run assets:generate -- image|model|rig --ids <id>`. Keys come from `.env` or from the file named by `ASSET_ENV_FILE`; Tripo uses the global `openapi.tripo3d.ai` host.
3. Review the candidates with `tools/asset-viewer.html`.
4. Promote the pick into `assets-src/models/` along with its `reference/` records, and add it to `optimize-models.mjs`.
5. For a weapon, measure its points with `?measure=1` and add an entry to `src/character/weapons.ts`.
6. Tune the stance until `Soldier.debug` shows both arms at 55–90% of reach and clear of the torso.

## Assets & Licensing
The operator and weapons are project-generated (Tripo/OpenAI output). The MotionBricks model and clips are under NVIDIA's licenses and are never committed; the HDRI is CC0. Record new external assets in `metadata.json` and `assets-src/models/README.md`.
