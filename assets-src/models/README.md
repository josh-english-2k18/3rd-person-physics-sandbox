# Source models

All three are generated for this project with `scripts/assets/generate.mjs`, following the Iron Swarm methodology:

1. An OpenAI GPT Image reference with native alpha. Prompts live in `scripts/assets/assets.json`. The character is posed for auto-rigging: an A-pose with empty, open hands.
2. A Tripo 3D v3.1 image-to-model mesh, with detailed geometry and 4K PBR (color, normal, ORM).
3. For the operator, a Tripo v3.0 auto-rig (biped, Mixamo bone names, with fingers).

| File | Asset | Notes |
| --- | --- | --- |
| `operator.glb` | Special forces operator | Rigged, 115k tris, 65 bones; faces +X in its bind pose (the retargeter handles any facing). |
| `bullpup.glb` | VX-9 bullpup rifle | 56k tris; modeled muzzle toward −Z. |
| `launcher.glb` | M7 launcher | 57k tris; modeled muzzle toward −Z. |

`reference/` keeps each pick's reference image, prompt, and Tripo task records. `npm run optimize:models` writes the web copies to `public/models/`. Weapons are baked to real length with the muzzle toward +Z.

Candidates that weren't picked stay in the gitignored `assets-src/ai/<id>/<variant>/`. Review any GLB with `/tools/asset-viewer.html?file=<url>`; add `&measure=1` for an orthographic sheet on a 2 cm grid, which is how the grip, muzzle and sight points in `src/character/weapons.ts` were measured.
