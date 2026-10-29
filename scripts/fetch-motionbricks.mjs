// Downloads the MotionBricks SOMA ONNX model and the sample clips the game samples target
// poses from into public/motionbricks/. These files are large (the model is ~380 MB) and carry
// their own licenses, so they are fetched on demand instead of being committed.
//
// Every file is a Git LFS object in https://github.com/NVlabs/motionbricks. The LFS pointer
// (from raw.githubusercontent.com) gives the expected SHA-256 and size, which we verify.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'NVlabs/motionbricks';
const REF = 'main';
const OUT_DIR = resolve(import.meta.dirname, '..', 'public', 'motionbricks');

/** Repository path -> local path under public/motionbricks. `lfs: false` files are plain git blobs. */
const FILES = [
  { src: 'motionbricks/assets/onnx/soma/mmm_v6_soma_fp16.onnx', dst: 'mmm_v6_soma_fp16.onnx' },
  { src: 'motionbricks/assets/onnx/soma/soma_n1.json', dst: 'soma_n1.json', lfs: false },
  { src: 'motionbricks/assets/onnx/LICENSE.md', dst: 'LICENSE-model.md', lfs: false },
  { src: 'assets/motions/LICENSE.txt', dst: 'clips/LICENSE.txt', lfs: false },
  { src: 'assets/motions/README.md', dst: 'clips/README.md', lfs: false },
  ...[
    'locomotion/idle/idle_loop_001__A268.bvh',
    'locomotion/idle/crouch_idle_001__A529.bvh',
    'locomotion/bs_1d_linear/neutral_jog_ff_180_R_001__A534.bvh',
    'locomotion/bs_1d_linear/run_loop_180_R_003__A326.bvh',
    'locomotion/bs_1d_linear/run_loop_180_R_003__A331.bvh',
    'locomotion/bs_1d_linear/neutral_walk_ff_180_R_002__A536_M.bvh',
    'locomotion/bs_2d_directional/jog_ff_loop_360_R_very_fast_001__A454.bvh',
    'locomotion/bs_2d_directional/jog_ff_loop_270_R_very_fast_002__A455.bvh',
    'locomotion/bs_2d_directional/jog_ff_loop_270_R_very_fast_002__A455_M.bvh',
    'locomotion/bs_2d_directional_crouch/crouch_ff_loop_360_R_001__A196.bvh',
    'locomotion/bs_2d_directional_crouch/crouch_ff_loop_180_R_001__A196.bvh',
    'locomotion/bs_2d_directional_crouch/crouch_ff_loop_270_R_002__A196.bvh',
    'locomotion/bs_2d_directional_crouch/crouch_ff_loop_270_R_002__A196_M.bvh',
  ].map((clip) => ({ src: `assets/motions/soma/${clip}`, dst: `clips/${clip.split('/').pop()}` })),
];

const raw = (path) => `https://raw.githubusercontent.com/${REPO}/${REF}/${path}`;
const media = (path) => `https://media.githubusercontent.com/media/${REPO}/${REF}/${path}`;

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

async function readPointer(path) {
  const text = await (await fetchOk(raw(path))).text();
  const oid = /oid sha256:([0-9a-f]{64})/.exec(text)?.[1];
  const size = Number(/size (\d+)/.exec(text)?.[1]);
  if (!oid || !size) throw new Error(`No Git LFS pointer at ${path}`);
  return { oid, size };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

async function download(url, file, size) {
  const tmp = `${file}.part`;
  const res = await fetchOk(url);
  let received = 0;
  let lastLog = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    if (size > 20e6 && Date.now() - lastLog > 1000) {
      lastLog = Date.now();
      process.stdout.write(`\r    ${mb(received)} / ${mb(size)}`);
    }
  });
  await pipeline(body, createWriteStream(tmp));
  if (size > 20e6) process.stdout.write('\n');
  renameSync(tmp, file);
}

async function main() {
  for (const { src, dst, lfs = true } of FILES) {
    const file = join(OUT_DIR, dst);
    mkdirSync(dirname(file), { recursive: true });
    if (!lfs) {
      if (!existsSync(file)) writeFileSync(file, await (await fetchOk(raw(src))).text());
      console.log(`  ok  ${dst}`);
      continue;
    }
    const { oid, size } = await readPointer(src);
    if (existsSync(file) && statSync(file).size === size && sha256(file) === oid) {
      console.log(`  ok  ${dst}`);
      continue;
    }
    console.log(`  get ${dst} (${mb(size)})`);
    await download(media(src), file, size);
    if (sha256(file) !== oid) throw new Error(`Checksum mismatch for ${dst}`);
  }
  console.log(`MotionBricks assets ready in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
