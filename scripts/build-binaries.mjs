#!/usr/bin/env node
/**
 * Builds standalone `chartnaut` executables for every platform (no Node needed to run them) and
 * the manifest the install scripts and `chartnaut upgrade` read.
 *
 *   npm run build:binaries                     # all targets into release/
 *   CHARTNAUT_RELEASE_BASE=https://… npm run build:binaries
 *
 * Output (release/):
 *   chartnaut-<platform>[.exe]   one per target below
 *   SHA256SUMS                   `sha256  file` lines
 *   latest.json, manifest.json   { version, bun, assets: { <platform>: { url, sha256, size } } }
 *
 * Publish with `npm run publish:r2` (R2 behind desktop-updates.chartnaut.com, the install
 * scripts' default). Moving the binaries elsewhere only changes the URLs inside latest.json.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const versionTs = fs.readFileSync(path.join(root, 'src', 'version.ts'), 'utf8');
if (!versionTs.includes(`'${version}'`)) {
  console.error(`src/version.ts does not say ${version} (package.json). Bump both together.`);
  process.exit(1);
}

// platform key → bun target. Keys are what the install scripts compute from uname / the OS.
const TARGETS = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'linux-x64-musl': 'bun-linux-x64-musl',
  'linux-arm64-musl': 'bun-linux-arm64-musl',
  'windows-x64': 'bun-windows-x64',
};

// The exact Bun that compiles every binary. Pinned so a release is reproducible and records its
// toolchain (manifest.json `bun`); bump deliberately, after checking `npm view bun version`.
const BUN_VERSION = '1.4.2';
const bunArgs = ['--yes', `bun@${BUN_VERSION}`];

const base = (process.env.CHARTNAUT_RELEASE_BASE ?? 'https://desktop-updates.chartnaut.com/cli').replace(/\/+$/, '');
const only = process.env.CHARTNAUT_TARGETS ? process.env.CHARTNAUT_TARGETS.split(',') : Object.keys(TARGETS);
const out = path.join(root, 'release');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const entry = path.join(root, 'dist', 'index.js');
if (!fs.existsSync(entry)) {
  console.error('dist/index.js missing: run `npm run build` first.');
  process.exit(1);
}

// Ask the pinned Bun for its version: this is what goes into the manifest, so a mismatch between
// the pin and what npx actually ran cannot go unnoticed.
const bv = spawnSync('npx', [...bunArgs, '--version'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const bunVersion = (bv.stdout ?? '').trim();
if (bv.status !== 0 || !bunVersion) {
  console.error(`could not run bun@${BUN_VERSION}`);
  process.exit(1);
}
if (bunVersion !== BUN_VERSION) {
  console.error(`bun@${BUN_VERSION} reported version ${bunVersion}; refusing to build with an unexpected toolchain`);
  process.exit(1);
}
console.log(`bun ${bunVersion}`);

const assets = {};
const sums = [];
for (const platform of only) {
  const target = TARGETS[platform];
  if (!target) {
    console.error(`unknown target ${platform}`);
    process.exit(1);
  }
  const file = `chartnaut-${platform}${platform.startsWith('windows') ? '.exe' : ''}`;
  const r = spawnSync('npx', [
    ...bunArgs, 'build', '--compile', '--minify',
    // A standalone Bun binary loads .env, bunfig.toml (whose `preload` runs code), tsconfig.json and
    // package.json from the directory it runs in, by default. The CLI runs inside users' repos,
    // and the installers run it in whatever directory `curl | sh` was typed in: a hostile repo
    // could run code, swap the API host and take the key. Off, all of them.
    '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
    '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json', `--target=${target}`, entry, '--outfile', path.join(out, file)], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (r.status !== 0) {
    console.error(`build failed for ${platform}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(path.join(out, file));
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  assets[platform] = { url: `${base}/${version}/${file}`, sha256, size: buf.length };
  sums.push(`${sha256}  ${file}`);
  console.log(`${platform.padEnd(18)} ${file.padEnd(32)} ${(buf.length / 1e6).toFixed(1)} MB`);
}

// The binary for this machine must ignore the directory it runs in: a bunfig.toml preload must not
// run, and a .env must not change the API host. Refuse to write a manifest for a build that does.
const hostPlatform = { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64', 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64', 'win32-x64': 'windows-x64' }[`${process.platform}-${process.arch}`];
if (hostPlatform && assets[hostPlatform]) {
  const bin = path.join(out, `chartnaut-${hostPlatform}${hostPlatform.startsWith('windows') ? '.exe' : ''}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-hostile-'));
  fs.writeFileSync(path.join(dir, 'bunfig.toml'), 'preload = ["./preload.js"]\n');
  fs.writeFileSync(path.join(dir, 'preload.js'), 'require("fs").writeFileSync("PRELOADED", "x")\n');
  fs.writeFileSync(path.join(dir, '.env'), 'CHARTNAUT_API_URL=https://hostile.example/v1\n');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir };
  delete env.CHARTNAUT_API_URL;
  const r = spawnSync(bin, ['mcp', 'install', 'cursor'], { cwd: dir, env, encoding: 'utf8' });
  const leaked = fs.existsSync(path.join(dir, 'PRELOADED')) || /hostile\.example/.test(`${r.stdout}${r.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
  if (leaked) {
    console.error(`refusing to release: ${path.basename(bin)} loads bunfig.toml or .env from the directory it runs in`);
    process.exit(1);
  }
  console.log(`checked: ${path.basename(bin)} ignores bunfig.toml and .env in its working directory`);
}

fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
// One asset per line on purpose: install.sh reads this with grep/sed, no jq needed.
const lines = Object.entries(assets).map(([k, v]) => `    "${k}": ${JSON.stringify(v)}`);
const manifest = `{\n  "version": "${version}",\n  "bun": "${bunVersion}",\n  "assets": {\n${lines.join(',\n')}\n  }\n}\n`;
fs.writeFileSync(path.join(out, 'latest.json'), manifest);
// The same manifest pinned to this version, for CHARTNAUT_VERSION installs: <base>/<version>/manifest.json.
fs.writeFileSync(path.join(out, 'manifest.json'), manifest);
console.log(`\nnext: npm run publish:r2  (latest.json → ${base}/latest.json, binaries → ${base}/${version}/)`);
