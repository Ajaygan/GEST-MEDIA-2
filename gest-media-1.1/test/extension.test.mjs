import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
// The repository root *is* the unpacked-extension folder.
const extDir = resolve(import.meta.dirname, '..');

const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));

const exists = (p) =>
  stat(p)
    .then(() => true)
    .catch(() => false);

const EXTENSION_DIRS = ['background', 'content', 'lib', 'offscreen', 'options', 'popup'];

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

async function extensionFiles() {
  const out = [];
  for (const dir of EXTENSION_DIRS) await walk(join(extDir, dir), out);
  return out;
}

test('manifest.json sits at the repository root so "Load unpacked" works on it', async () => {
  assert.ok(await exists(join(extDir, 'manifest.json')));
  assert.ok(
    !(await exists(join(extDir, 'extension', 'manifest.json'))),
    'there must be exactly one manifest, at the root'
  );
});

test('manifest is MV3 and declares the expected surface', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');
  for (const permission of ['offscreen', 'storage', 'tabs']) {
    assert.ok(manifest.permissions.includes(permission), `missing permission ${permission}`);
  }
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.deepEqual(manifest.content_scripts[0].matches, ['<all_urls>']);
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/);
});

test('every file the manifest points at exists', async () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    ...Object.values(manifest.icons)
  ];
  for (const rel of referenced) {
    assert.ok(await exists(join(extDir, rel)), `missing ${rel}`);
  }
});

test('offscreen document and its scripts exist', async () => {
  for (const rel of [
    'offscreen/offscreen.html',
    'offscreen/detector.js',
    'offscreen/ticker-worker.js',
    'lib/gestures.js',
    'lib/constants.js',
    'lib/model-loader.js'
  ]) {
    assert.ok(await exists(join(extDir, rel)), `missing ${rel}`);
  }
});

test('all extension JavaScript parses', async () => {
  const files = (await extensionFiles()).filter((f) => extname(f) === '.js');
  assert.ok(files.length >= 6);
  const tmp = await mkdtemp(join(tmpdir(), 'gm-syntax-'));
  try {
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const isModule = /^\s*(import|export)\s/m.test(source);
      const target = join(tmp, `check${isModule ? '.mjs' : '.cjs'}`);
      await copyFile(file, target);
      await run(process.execPath, ['--check', target]).catch((err) => {
        assert.fail(`${file} failed to parse:\n${err.stderr}`);
      });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('the content script stays dependency-free (no imports)', async () => {
  const source = await readFile(join(extDir, 'content', 'controller.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(source), 'MV3 content scripts cannot be ES modules');
  for (const action of ['play', 'pause', 'next', 'previous', 'volume_up', 'volume_down']) {
    assert.ok(source.includes(`'${action}'`), `content script does not handle ${action}`);
  }
});

test('default gesture mapping covers all six gestures', async () => {
  const { DEFAULT_SETTINGS, GESTURES, ACTIONS } = await import('../lib/constants.js');
  const mapped = Object.entries(DEFAULT_SETTINGS.mapping);
  assert.equal(mapped.length, 6);
  const expected = {
    [GESTURES.FIST]: ACTIONS.PLAY,
    [GESTURES.OPEN_PALM]: ACTIONS.PAUSE,
    [GESTURES.POINT_RIGHT]: ACTIONS.NEXT,
    [GESTURES.POINT_LEFT]: ACTIONS.PREVIOUS,
    [GESTURES.THUMB_UP]: ACTIONS.VOLUME_UP,
    [GESTURES.THUMB_DOWN]: ACTIONS.VOLUME_DOWN
  };
  assert.deepEqual(DEFAULT_SETTINGS.mapping, expected);
  assert.equal(DEFAULT_SETTINGS.performance, 'low', 'low-end preset must be the default');
});
