#!/usr/bin/env node
/**
 * Runs `node --test` on every file in a directory that ends with a suffix.
 *
 *   node scripts/run-tests.mjs <dir> <suffix> [node --test options...]
 *
 * A shell glob in the npm script (`build-test/test/*.test.js`) is expanded by sh on macOS and
 * Linux, but npm runs scripts through cmd.exe on Windows, which passes the pattern through
 * unexpanded, and `node --test` on Node 20 does not expand it either. Listing the files here
 * works the same everywhere.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [dir, suffix, ...nodeArgs] = process.argv.slice(2);
if (!dir || !suffix) {
  console.error('usage: node scripts/run-tests.mjs <dir> <suffix> [node --test options...]');
  process.exit(2);
}
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(suffix))
  .sort()
  .map((f) => path.join(dir, f));
if (files.length === 0) {
  console.error(`no files ending in ${suffix} in ${dir}`);
  process.exit(1);
}
const res = spawnSync(process.execPath, ['--test', ...nodeArgs, ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
