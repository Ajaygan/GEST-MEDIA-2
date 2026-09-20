#!/usr/bin/env node
/**
 * Packs only the extension files into dist/gestmedia-<version>.zip.
 * (The repo root doubles as the extension folder, so development files such as
 * node_modules/, scripts/ and test/ are explicitly excluded here.)
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));

const INCLUDE = [
  'manifest.json',
  'background',
  'content',
  'icons',
  'lib',
  'offscreen',
  'options',
  'popup',
  'vendor'
];

const staging = join(root, 'dist', 'unpacked');
const out = join(root, 'dist', `gestmedia-${manifest.version}.zip`);

await rm(join(root, 'dist'), { recursive: true, force: true });
await mkdir(staging, { recursive: true });

for (const entry of INCLUDE) {
  await cp(join(root, entry), join(staging, entry), { recursive: true }).catch((err) => {
    if (entry === 'vendor') {
      console.error('✖ vendor/ is missing — run `npm run setup` first.');
      process.exit(1);
    }
    throw err;
  });
}

await run('zip', ['-r', '-q', out, '.', '-x', '*.DS_Store'], { cwd: staging });
console.log(`✔ ${out}`);
console.log(`  (staged copy kept at ${staging})`);
