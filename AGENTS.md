# Repository Guidelines

## Project Structure & Module Organization
The React entry point (`index.tsx`) hydrates the canvas defined in `App.tsx`, which wires keyboard controls, pointer-lock UI, and the Three.js scene. Scene elements live in `components/`, with `Scene.tsx` shepherding lighting, physics, and child components, and `Player.tsx` encapsulating character input, animation, and camera logic. Place new GLTF or texture assets under `models/` in self-contained folders that include licensing notes. Build and tooling configuration (`vite.config.ts`, `tsconfig.json`, `package.json`) sit at the repo root alongside the static host file `index.html` and the landing metadata in `metadata.json`.

## Build, Test, and Development Commands
Use `npm install` once per environment to hydrate dependencies. `npm run dev` starts the Vite dev server (defaults to http://localhost:5173) with hot module reload. `npm run build` produces an optimized production bundle in `dist/`. `npm run preview` serves the built bundle so you can sanity-check minified assets before shipping.

## Coding Style & Naming Conventions
Write TypeScript with the default 2-space indentation used throughout the repo. Export React components as named functions in PascalCase (`PlayerController`, `GroundPlane`) and co-locate helper hooks near their consumers. Stick to descriptive file names that mirror the primary export. Keep physics constants, keyboard mappings, and asset URLs in clearly labeled objects near the top of the module so they can be tuned quickly. Favor hooks and functional composition—avoid class components and side effects outside React’s lifecycle.

## Testing Guidelines
The project currently relies on manual smoke testing. After each change, run `npm run dev`, load the scene in a Chromium-based browser, and confirm: the pointer-lock prompt appears, WASD movement updates the player and camera, and the physics bodies settle without console warnings. If you introduce deterministic logic, add light unit coverage using your preferred runner (Vitest integrates cleanly with Vite) and store specs under `__tests__/` adjacent to the source.

## Commit & Pull Request Guidelines
The existing history starts with an imported baseline; keep commits focused, written in present-tense imperative (`Add player crouch toggle`), and under 72 characters. Describe observable behavior or configuration changes in the body if one line is insufficient. For pull requests, link the relevant issue, note any new dependencies or asset sources, and include before/after screenshots or short clips when UI or motion changes are involved. Call out manual test steps performed so reviewers can reproduce quickly.

## Assets & Licensing
Third-party models (e.g., `models/swat_operator/scene.gltf`) ship with upstream license files—preserve them and add new assets with equivalent attribution. Record any external source details in `metadata.json` so downstream consumers maintain compliance.
