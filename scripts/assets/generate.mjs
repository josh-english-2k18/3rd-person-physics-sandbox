#!/usr/bin/env node
// AI asset generation (the Iron Swarm methodology): reference image -> Tripo 3D mesh -> Tripo rig.
//
//   node scripts/assets/generate.mjs image --ids operator,bullpup [--variants 2]
//   node scripts/assets/generate.mjs model --ids operator --variant v01 [--face-limit 80000]
//   node scripts/assets/generate.mjs rig   --ids operator --variant v01
//   node scripts/assets/generate.mjs balance
//
// Stages (outputs under assets-src/ai/<id>/<variant>/, gitignored):
//   image  OpenAI GPT Image with native alpha -> reference.png (+ prompt.json)
//   model  Tripo v3 image-to-model (PBR, detailed) -> raw.glb, rendered.*, tripo.json
//   rig    Tripo v3 auto-rig, biped, Mixamo bone names -> rigged.glb, rig.json
//
// Keys: OPENAI_API_KEY and TRIPO3D_API_KEY from the environment, this repo's .env, or the file named
// by ASSET_ENV_FILE (e.g. another project's .env), so keys never need copying around.
// Tripo uses the global host (openapi.tripo3d.ai); the .com host is the China region.
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SPEC = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'assets.json'), 'utf8'));
const TRIPO = 'https://openapi.tripo3d.ai/v3';
const MODELS = {
  image: 'gpt-image-2.5-sunburst',
  mesh: 'v3.1-20260211',
  rig: 'v3.0-20260909',
};

const [stage, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(
  rest.map((arg, i) => (arg.startsWith('--') ? [arg.slice(2), rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[i + 1]] : null)).filter(Boolean),
);
const ids = String(args.ids ?? '').split(',').filter(Boolean);
const outDir = (id, variant) => path.join(ROOT, 'assets-src/ai', id, variant);
const log = (id, message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${id.padEnd(9)} ${message}`);

async function loadEnv() {
  for (const file of [process.env.ASSET_ENV_FILE, path.join(ROOT, '.env')].filter(Boolean)) {
    try {
      for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {
      /* optional */
    }
  }
}

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (environment, .env, or ASSET_ENV_FILE)`);
  return value;
};

// --- Reference images -------------------------------------------------------------------------

async function image(id, variant) {
  const asset = SPEC.assets[id];
  const dir = outDir(id, variant);
  await fs.mkdir(dir, { recursive: true });
  const prompt = `${asset.prompt}\n\n${SPEC.style}`;
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODELS.image, prompt, size: asset.size, quality: 'high', background: 'transparent', output_format: 'png', n: 1 }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${data.error?.message ?? 'request failed'}`);
  await fs.writeFile(path.join(dir, 'reference.png'), Buffer.from(data.data[0].b64_json, 'base64'));
  await fs.writeFile(path.join(dir, 'prompt.json'), JSON.stringify({ model: MODELS.image, size: asset.size, prompt, usage: data.usage ?? null }, null, 2));
  log(id, `${variant} reference.png`);
}

// --- Tripo ------------------------------------------------------------------------------------

async function tripo(method, route, body) {
  const response = await fetch(`${TRIPO}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${need('TRIPO3D_API_KEY')}`,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 0) {
    throw new Error(`${method} ${route}: HTTP ${response.status} code ${json.code} ${json.message ?? ''} ${json.suggestion ?? ''}`.trim());
  }
  return json.data;
}

async function waitFor(id, taskId) {
  const started = Date.now();
  let last = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const task = await tripo('GET', `/tasks/${taskId}`);
    if (task.progress !== last && task.progress % 25 === 0) log(id, `${task.status} ${task.progress}%`);
    last = task.progress;
    if (task.status === 'success') return { task, seconds: Math.round((Date.now() - started) / 1000) };
    if (['failed', 'cancelled', 'banned', 'expired'].includes(task.status)) {
      throw new Error(`task ${taskId} ${task.status} ${task.error_code ?? ''} ${task.error_message ?? ''}`.trim());
    }
    if (Date.now() - started > 25 * 60 * 1000) throw new Error(`task ${taskId} timed out`);
  }
}

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${path.basename(file)}: HTTP ${response.status}`);
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
}

async function model(id, variant) {
  const dir = outDir(id, variant);
  const request = {
    model: MODELS.mesh,
    texture: true,
    pbr: true,
    texture_quality: 'detailed',
    geometry_quality: 'detailed',
    texture_alignment: 'original_image',
    ...(args['face-limit'] ? { face_limit: Number(args['face-limit']) } : {}),
  };
  const form = new FormData();
  form.append('file', new Blob([await fs.readFile(path.join(dir, 'reference.png'))], { type: 'image/png' }), 'reference.png');
  const { file_token: input } = await tripo('POST', '/files', form);
  const { task_id: taskId } = await tripo('POST', '/generation/image-to-model', { input, ...request });
  log(id, `${variant} mesh task ${taskId}`);
  const { task, seconds } = await waitFor(id, taskId);
  const output = task.output ?? {};
  await download(output.model_url ?? output.pbr_model ?? output.model, path.join(dir, 'raw.glb'));
  const render = output.rendered_image_url ?? output.rendered_image;
  if (render) await download(render, path.join(dir, `rendered.${new URL(render).pathname.split('.').pop()}`)).catch(() => {});
  await fs.writeFile(path.join(dir, 'tripo.json'), JSON.stringify({ taskId, request, credits: task.credits_consumed ?? null, seconds }, null, 2));
  log(id, `${variant} raw.glb in ${seconds}s (${task.credits_consumed ?? '?'} credits)`);
}

async function rig(id, variant) {
  const dir = outDir(id, variant);
  const { taskId: meshTask } = JSON.parse(await fs.readFile(path.join(dir, 'tripo.json'), 'utf8'));
  const check = await tripo('POST', '/animations/rig-check', { input: meshTask }).catch((e) => ({ error: e.message }));
  let checkResult = check;
  if (check.task_id) checkResult = (await waitFor(id, check.task_id)).task.output;
  log(id, `${variant} rig-check ${JSON.stringify(checkResult)}`);
  const request = { input: meshTask, model: MODELS.rig, rig_type: 'biped', spec: 'mixamo', out_format: 'glb' };
  const { task_id: taskId } = await tripo('POST', '/animations/rig', request);
  log(id, `${variant} rig task ${taskId}`);
  const { task, seconds } = await waitFor(id, taskId);
  await download(task.output.model_url, path.join(dir, 'rigged.glb'));
  await fs.writeFile(path.join(dir, 'rig.json'), JSON.stringify({ taskId, request, check: checkResult, credits: task.credits_consumed ?? null, seconds }, null, 2));
  log(id, `${variant} rigged.glb in ${seconds}s (${task.credits_consumed ?? '?'} credits)`);
}

// --- CLI --------------------------------------------------------------------------------------

await loadEnv();
const run = async (fn, jobs) => {
  const failures = [];
  await Promise.all(jobs.map(([id, variant]) => fn(id, variant).catch((e) => failures.push(`${id}/${variant}: ${e.message}`))));
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
};
const variants = (n) => Array.from({ length: n }, (_, i) => `v${String(i + 1).padStart(2, '0')}`);

if (stage === 'balance') {
  console.log(JSON.stringify(await tripo('GET', '/account/balance')));
} else if (stage === 'image') {
  const list = args.variant ? [String(args.variant)] : variants(Number(args.variants ?? 2));
  await run(image, ids.flatMap((id) => list.map((v) => [id, v])));
} else if (stage === 'model' || stage === 'rig') {
  const list = String(args.variant ?? 'v01').split(',');
  await run(stage === 'model' ? model : rig, ids.flatMap((id) => list.map((v) => [id, v])));
} else {
  console.error('usage: generate.mjs image|model|rig|balance --ids a,b [--variant v01] [--variants 2] [--face-limit N]');
  process.exitCode = 1;
}
