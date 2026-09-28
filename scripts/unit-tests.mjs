#!/usr/bin/env node
/**
 * Offline unit-test runner.
 *
 * Runs `scripts/test/*.test.mjs` with Node's built-in test runner, importing the
 * extension's TypeScript sources directly. No bundler and no new dependency is
 * involved: Node 22.6+ can strip TypeScript types, and `scripts/ts-loader.mjs`
 * teaches the loader the project's extensionless relative imports.
 *
 * Node 22 still gates type stripping behind a flag, so the flag is probed rather
 * than assumed. On a toolchain that cannot run it, the runner prints a skip
 * notice and exits 0 instead of breaking the build.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'scripts', 'test');
const LOADER = pathToFileURL(path.join(ROOT, 'scripts', 'ts-loader.mjs')).href;

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(major) || major < 22) {
  console.log(
    `[unit-tests] SKIP: node ${process.versions.node} cannot import TypeScript directly (needs >= 22.6).`,
  );
  console.log('[unit-tests] Type checking still runs; run the tests on a newer node to execute them.');
  process.exit(0);
}

function flagSupported(flag) {
  return spawnSync(process.execPath, [flag, '-e', '0'], { stdio: 'ignore' }).status === 0;
}

const flags = major === 22 && flagSupported('--experimental-strip-types')
  ? ['--experimental-strip-types']
  : [];

const files = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join('scripts', 'test', name));

if (files.length === 0) {
  console.log('[unit-tests] SKIP: no offline tests found in scripts/test.');
  process.exit(0);
}

console.log(`[unit-tests] node ${process.versions.node}, ${files.length} offline test files`);
const result = spawnSync(
  process.execPath,
  [...flags, '--import', LOADER, '--test', ...files],
  { cwd: ROOT, stdio: 'inherit' },
);

process.exit(result.status ?? 1);