// Downloads the runtime assets that are too large (or too separately licensed) to commit:
//
// - public/motionbricks/: the MotionBricks SOMA ONNX model (~380 MB) and the sample clips the
//   game samples target poses from. Every file is a Git LFS object in
//   https://github.com/NVlabs/motionbricks; the LFS pointer (from raw.githubusercontent.com)
//   gives the expected SHA-256 and size, which we verify.
// - public/hdri/: the sky, a CC0 HDRI from Poly Haven used for lighting and the background.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'NVlabs/motionbricks';
const REF = 'main';
const OUT_DIR = resolve(import.meta.dirname, '..', 'public', 'motionbricks');
const HDRI_DIR = resolve(import.meta.dirname, '..', 'public', 'hdri');

/** Direct downloads (no LFS pointer): local path under public/hdri -> URL. */
const HDRIS = [
  {
    dst: 'sky_4k.hdr',
    url: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/kloofendal_48d_partly_cloudy_puresky_4k.hdr',
  },
];

/** Repository path -> local path under public/motionbricks. `lfs: false` files are plain git blobs. */
const FILES = [
  { src: 'motionbricks/assets/onnx/soma/mmm_v6_soma_fp16.onnx', dst: 'mmm_v6_soma_fp16.onnx' },
  { src: 'motionbricks/assets/onnx/soma/soma_n1.json', dst: 'soma_n1.json', lfs: false },
  { src: 'motionbricks/assets/onnx/LICENSE.md', dst: 'LICENSE-model.md', lfs: false },
  { src: 'assets/motions/LICENSE.txt', dst: 'clips/LICENSE.txt', lfs: false },
  { src: 'assets/motions/README.md', dst: 'clips/README.md', lfs: false },
  ...[
    'locomotion/idle/idle_loop_001__A268.bvh',
    'locomotion/bs_1d_linear/neutral_jog_ff_180_R_001__A534.bvh',
    'locomotion/bs_1d_linear/run_loop_180_R_003__A326.bvh',
    'locomotion/bs_1d_linear/run_loop_180_R_003__A331.bvh',
    'locomotion/bs_1d_linear/neutral_walk_ff_180_R_002__A536_M.bvh',
    'locomotion/bs_2d_directional/jog_ff_loop_360_R_very_fast_001__A454.bvh',
    'locomotion/bs_2d_directional/jog_ff_loop_270_R_very_fast_002__A455.bvh',
    'locomotion/bs_2d_directional/jog_ff_loop_270_R_very_fast_002__A455_M.bvh',
    'jump/jump_over_obstacle_no_hand_0_75m_R_103__A416.bvh',
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
  for (const { dst, url } of HDRIS) {
    const file = join(HDRI_DIR, dst);
    mkdirSync(dirname(file), { recursive: true });
    const size = Number((await fetch(url, { method: 'HEAD' })).headers.get('content-length'));
    if (existsSync(file) && statSync(file).size === size) {
      console.log(`  ok  hdri/${dst}`);
      continue;
    }
    console.log(`  get hdri/${dst} (${mb(size)})`);
    await download(url, file, size);
    if (statSync(file).size !== size) throw new Error(`Size mismatch for hdri/${dst}`);
  }
  console.log('Assets ready in public/motionbricks and public/hdri');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
