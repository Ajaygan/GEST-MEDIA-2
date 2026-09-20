#!/usr/bin/env node
/**
 * One-time setup: vendors the MediaPipe runtime into the extension and fetches
 * the hand-landmarker model so the extension works completely offline.
 *
 *   npm run setup              # runtime + model
 *   npm run setup -- --no-model  # runtime only (model is fetched at runtime)
 *
 * The vendored files are intentionally git-ignored (~30 MB of wasm).
 */
import { createWriteStream } from 'node:fs';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const dest = join(root, 'vendor', 'tasks-vision');
const modelDir = join(root, 'vendor', 'models');
const modelPath = join(modelDir, 'hand_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const exists = (p) =>
  stat(p)
    .then(() => true)
    .catch(() => false);

async function vendorRuntime() {
  if (!(await exists(src))) {
    console.error('✖ @mediapipe/tasks-vision is missing. Run `npm install` first.');
    process.exit(1);
  }
  await rm(dest, { recursive: true, force: true });
  await mkdir(join(dest, 'wasm'), { recursive: true });
  await cp(join(src, 'vision_bundle.mjs'), join(dest, 'vision_bundle.mjs'));
  // Both the SIMD and the no-SIMD builds are copied: FilesetResolver picks the
  // no-SIMD one automatically on older / low-end CPUs.
  for (const file of [
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm'
  ]) {
    await cp(join(src, 'wasm', file), join(dest, 'wasm', file));
  }
  console.log('✔ MediaPipe runtime vendored into vendor/tasks-vision');
}

async function fetchModel() {
  if (await exists(modelPath)) {
    console.log('✔ Model already present at vendor/models/hand_landmarker.task');
    return;
  }
  await mkdir(modelDir, { recursive: true });
  console.log('… downloading hand_landmarker.task (~7 MB)');
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(modelPath));
    console.log('✔ Model saved to vendor/models/hand_landmarker.task');
  } catch (err) {
    await rm(modelPath, { force: true });
    console.warn(
      `⚠ Could not download the model (${err.message}).\n` +
        '  The extension will download and cache it on first use instead.'
    );
  }
}

await vendorRuntime();
if (!process.argv.includes('--no-model')) await fetchModel();
console.log('\nNext: open chrome://extensions → Developer mode → Load unpacked');
console.log('Select exactly this folder (the one containing manifest.json):\n');
console.log(`    ${root}\n`);
