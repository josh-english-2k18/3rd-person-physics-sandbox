# 3rd-Person Physics Sandbox

An interactive third-person playground that blends character locomotion, rigid-body physics, and modern WebGL rendering. The project combines React, React Three Fiber, and Rapier to deliver a responsive scene where you can shoulder a compact assault rifle, topple stacks of crates, and roam a large tiled arena with smooth camera follow.

![Gameplay screenshot of the sandbox](./screenshot.png)

---

## Features

- **Responsive third-person controller** with pointer lock, smoothed camera follow, and animation blending between idle and walk cycles.
- **Dynamic physics sandbox** powered by Rapier: falling cones, cubes, spheres, and a hand-placed 5×5 stack of blue crates ready for stress testing.
- **Weapon system prototype** using the local soldier avatar and a compact rifle GLB, mounted directly to the rigged hand for believable aiming.
- **High-fidelity presentation** with real-time lighting, hard/soft shadows, and a 1000×1000 grid ground plane for visual grounding.
- **Developer-friendly React architecture**: components, hooks, and typed utilities make it easy to extend or swap content.

---

## Getting Started

```bash
npm install
npm run dev        # Launch Vite dev server at http://localhost:5173
npm run build      # Produce a production bundle in dist/
npm run preview    # Serve the built bundle for smoke-testing
```

Node.js 20 LTS (or newer) is recommended to match Vite’s defaults. During development, lock the pointer by clicking the canvas; press `Esc` to release the cursor.

---

## Controls

- `WASD` / Arrow keys — Move the character
- Mouse — Look around and steer the camera
- `Esc` — Exit pointer-lock mode

---

## Project Structure

- `index.tsx` – Entry point that hydrates the React tree.
- `App.tsx` – Sets up the `Canvas`, keyboard mappings, pointer-lock overlay, and suspense boundaries.
- `components/Scene.tsx` – Declares lighting, physics world, ambient props, and the static crate stack.
- `components/Player.tsx` – Handles character rig loading, animation playback, capsule physics body, camera follow, and weapon attachment.
- `models/` – Source GLB files for the soldier avatar and compact rifle used in the scene.
- `AGENTS.md` – Contributor guidelines tailored for AI co-authors.
- `vite.config.ts`, `tsconfig.json` – Build and TypeScript configuration.

---

## Assets & Licensing

- Application code and configuration are released under the MIT License. See [`LICENSE`](./LICENSE) for full terms.
- The soldier character (`models/soldier/Soldier.glb`) and compact rifle (`models/compact_assault_rifle.glb`) are bundled for local development. Retain upstream attribution and usage terms if you redistribute the project—refer to the original asset sources before shipping.
- Additional metadata lives in [`metadata.json`](./metadata.json) for storefront integrations.

For questions, enhancements, or pull requests, please follow the repository guidance in [`AGENTS.md`](./AGENTS.md). Contributions that improve physics interactions, animation sets, or asset sourcing are especially welcome.
