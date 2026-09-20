#!/usr/bin/env node
/**
 * `npm run doctor` — verifies this folder is ready to "Load unpacked" in Chrome
 * and prints the exact absolute path to select.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
let fatal = false;

const check = async (label, path, { required = true, hint = '' } = {}) => {
  const ok = await stat(path)
    .then(() => true)
    .catch(() => false);
  if (!ok && required) fatal = true;
  results.push({ ok, required, label, hint });
  return ok;
};

await check('manifest.json (repository root)', join(root, 'manifest.json'), {
  hint: 'Repository looks incomplete — re-clone the branch.'
});
await check('service worker', join(root, 'background', 'service-worker.js'));
await check('content script', join(root, 'content', 'controller.js'));
await check('offscreen detector', join(root, 'offscreen', 'detector.js'));
await check('popup', join(root, 'popup', 'popup.html'));
await check('options page', join(root, 'options', 'options.html'));
await check('icons', join(root, 'icons', 'icon-128.png'));
await check('MediaPipe runtime (vendor/tasks-vision)', join(root, 'vendor', 'tasks-vision', 'vision_bundle.mjs'), {
  hint: 'Run `npm install && npm run setup`.'
});
await check('MediaPipe wasm', join(root, 'vendor', 'tasks-vision', 'wasm', 'vision_wasm_internal.wasm'), {
  hint: 'Run `npm run setup`.'
});
await check('bundled model (optional)', join(root, 'vendor', 'models', 'hand_landmarker.task'), {
  required: false,
  hint: 'Not bundled — the extension downloads and caches it on first use.'
});

let manifestName = '';
try {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  manifestName = `${manifest.name} v${manifest.version} (manifest_version ${manifest.manifest_version})`;
} catch (err) {
  fatal = true;
  results.push({
    ok: false,
    required: true,
    label: 'manifest.json is valid JSON',
    hint: String(err.message)
  });
}

console.log('\nGestMedia — load-unpacked doctor\n');
for (const r of results) {
  const mark = r.ok ? '✔' : r.required ? '✖' : '•';
  console.log(`  ${mark} ${r.label}${!r.ok && r.hint ? `\n      → ${r.hint}` : ''}`);
}

console.log('\n──────────────────────────────────────────────────────────────');
if (fatal) {
  console.log('Fix the ✖ items above, then run `npm run doctor` again.');
  process.exitCode = 1;
} else {
  console.log(manifestName);
  console.log('\nIn Chrome:  chrome://extensions  →  Developer mode  →  Load unpacked');
  console.log('Select this folder (manifest.json lives right inside it):\n');
  console.log(`    ${root}\n`);
}
console.log('──────────────────────────────────────────────────────────────\n');
