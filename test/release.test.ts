import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { harness, tmpdir } from './helpers.js';

// scripts/release-lib.mjs is plain JS run by node; this file runs from build-test/test/.
const lib: any = await import(new URL('../../scripts/release-lib.mjs', import.meta.url).href);

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** An in-memory bucket that records the order of writes. */
function memoryStore(initial: Record<string, Buffer> = {}) {
  const objects = new Map<string, Buffer>(Object.entries(initial));
  const puts: { key: string; type: string; cache: string }[] = [];
  return {
    objects,
    puts,
    async get(key: string) {
      return objects.get(key);
    },
    async put(key: string, body: Buffer, type: string, cache: string) {
      objects.set(key, Buffer.from(body));
      puts.push({ key, type, cache });
    },
  };
}

/** What build-binaries writes for `channel`, with tiny stand-in binaries. */
function fakeRelease(channel: string, version = '0.2.0') {
  const dir = tmpdir('cn-release-');
  const base = lib.releaseBase(channel, {});
  const assets: Record<string, { url: string; sha256: string; size: number }> = {};
  for (const platform of ['darwin-arm64', 'linux-x64', 'windows-x64']) {
    const file = `chartnaut-${platform}${platform.startsWith('windows') ? '.exe' : ''}`;
    const body = Buffer.from(`binary ${platform} ${version}`);
    fs.writeFileSync(path.join(dir, file), body);
    assets[platform] = { url: `${base}/${version}/${file}`, sha256: sha(body), size: body.length };
  }
  const manifest = lib.renderManifest({ version, bun: '1.4.2', channel, assets });
  fs.writeFileSync(path.join(dir, 'latest.json'), manifest);
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifest);
  return { dir, manifest: JSON.parse(manifest) };
}

test('channel: --channel, --channel=, CHARTNAUT_CHANNEL, default stable; unknown refused', () => {
  assert.equal(lib.channelFrom([], {}), 'stable');
  assert.equal(lib.channelFrom([], { CHARTNAUT_CHANNEL: 'unstable' }), 'unstable');
  assert.equal(lib.channelFrom(['--channel', 'unstable'], {}), 'unstable');
  assert.equal(lib.channelFrom(['--channel=stable'], { CHARTNAUT_CHANNEL: 'unstable' }), 'stable', 'the flag wins');
  assert.throws(() => lib.channelFrom(['--channel', 'beta'], {}), /unknown channel "beta"/);
  assert.throws(() => lib.channelFrom([], { CHARTNAUT_CHANNEL: '../stable' }), /unknown channel/);
  assert.equal(lib.channelPrefix('stable'), 'cli/');
  assert.equal(lib.channelPrefix('unstable'), 'cli/unstable/');
  assert.equal(lib.releaseBase('stable', {}), 'https://desktop-updates.chartnaut.com/cli');
  assert.equal(lib.releaseBase('unstable', {}), 'https://desktop-updates.chartnaut.com/cli/unstable');
  assert.equal(lib.releaseBase('unstable', { CHARTNAUT_RELEASE_BASE: 'https://dl.example/cli/' }), 'https://dl.example/cli/unstable');
});

test('an unstable build publishes under cli/unstable/ with manifest URLs there, latest.json last', async () => {
  const { dir, manifest } = fakeRelease('unstable');
  assert.equal(manifest.channel, 'unstable');
  for (const a of Object.values<any>(manifest.assets)) assert.match(a.url, /^https:\/\/desktop-updates\.chartnaut\.com\/cli\/unstable\/0\.2\.0\/chartnaut-/);
  // install.sh reads one asset per line with grep/sed.
  const text = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8');
  assert.equal(text.split('\n').filter((l) => /"linux-x64"/.test(l)).length, 1);

  const store = memoryStore();
  await lib.publishRelease(store, dir, 'unstable');
  const keys = store.puts.map((p) => p.key);
  assert.deepEqual(keys, [
    'cli/unstable/0.2.0/chartnaut-darwin-arm64',
    'cli/unstable/0.2.0/chartnaut-linux-x64',
    'cli/unstable/0.2.0/chartnaut-windows-x64.exe',
    'cli/unstable/0.2.0/manifest.json',
    'cli/unstable/latest.json',
  ]);
  assert.ok(keys.every((k) => k.startsWith('cli/unstable/')), 'nothing touches the stable channel');
  assert.equal(store.puts.at(-1)!.cache, 'no-cache, max-age=0');
  assert.equal(store.puts[0]!.cache, 'public, max-age=31536000, immutable');
});

test('a build is refused on another channel, and a tampered binary is refused', async () => {
  const unstable = fakeRelease('unstable');
  await assert.rejects(lib.publishRelease(memoryStore(), unstable.dir, 'stable'), /built for the unstable channel, not stable/);
  const stable = fakeRelease('stable');
  await assert.rejects(lib.publishRelease(memoryStore(), stable.dir, 'unstable'), /built for the stable channel, not unstable/);
  const store = memoryStore();
  await lib.publishRelease(store, stable.dir, 'stable');
  assert.deepEqual(store.puts.map((p) => p.key).slice(-2), ['cli/0.2.0/manifest.json', 'cli/latest.json']);
  fs.writeFileSync(path.join(stable.dir, 'chartnaut-linux-x64'), 'tampered');
  await assert.rejects(lib.publishRelease(memoryStore(), stable.dir, 'stable'), /linux-x64: chartnaut-linux-x64 does not match the manifest/);
  // A 0.1.x manifest has no channel field: it is a stable one.
  const old = { version: '0.1.1', assets: { 'linux-x64': { url: 'https://desktop-updates.chartnaut.com/cli/0.1.1/chartnaut-linux-x64', sha256: '0', size: 1 } } };
  assert.doesNotThrow(() => lib.checkManifest(old, 'stable'));
  assert.throws(() => lib.checkManifest(old, 'unstable'), /built for the stable channel/);
});

test('promote copies a verified unstable release to stable: stable URLs, cli/latest.json last', async () => {
  const { dir } = fakeRelease('unstable');
  const store = memoryStore();
  await lib.publishRelease(store, dir, 'unstable');
  store.puts.length = 0;
  const promoted = await lib.promoteRelease(store, '0.2.0');
  assert.deepEqual(store.puts.map((p) => p.key), [
    'cli/0.2.0/chartnaut-darwin-arm64',
    'cli/0.2.0/chartnaut-linux-x64',
    'cli/0.2.0/chartnaut-windows-x64.exe',
    'cli/0.2.0/manifest.json',
    'cli/latest.json',
  ]);
  assert.equal(promoted.channel, 'stable');
  const latest = JSON.parse(store.objects.get('cli/latest.json')!.toString('utf8'));
  for (const [platform, a] of Object.entries<any>(latest.assets)) {
    assert.match(a.url, /^https:\/\/desktop-updates\.chartnaut\.com\/cli\/0\.2\.0\/chartnaut-/, platform);
    const key = new URL(a.url).pathname.slice(1);
    assert.equal(sha(store.objects.get(key)!), a.sha256, `${key} matches the stable manifest`);
  }
  assert.equal(store.objects.get('cli/0.2.0/manifest.json')!.toString(), store.objects.get('cli/latest.json')!.toString());
  // The unstable channel is untouched.
  assert.equal(JSON.parse(store.objects.get('cli/unstable/latest.json')!.toString()).channel, 'unstable');
  // Promoting the same release again is harmless (identical bytes).
  await lib.promoteRelease(store, '0.2.0');
});

test('promote writes nothing when a binary does not match the unstable manifest, or stable already differs', async () => {
  const { dir } = fakeRelease('unstable');
  const store = memoryStore();
  await lib.publishRelease(store, dir, 'unstable');
  store.puts.length = 0;
  store.objects.set('cli/unstable/0.2.0/chartnaut-windows-x64.exe', Buffer.from('swapped'));
  await assert.rejects(lib.promoteRelease(store, '0.2.0'), /windows-x64: .* does not match its sha256 in the unstable manifest; nothing was promoted/);
  assert.equal(store.puts.length, 0);

  const clean = memoryStore();
  await lib.publishRelease(clean, dir, 'unstable');
  clean.objects.set('cli/0.2.0/chartnaut-linux-x64', Buffer.from('an older build'));
  clean.puts.length = 0;
  await assert.rejects(lib.promoteRelease(clean, '0.2.0'), /already exists with different content/);
  assert.equal(clean.puts.length, 0);

  await assert.rejects(lib.promoteRelease(memoryStore(), '0.2.0'), /no unstable release 0\.2\.0/);
});

test('upgrade reads an unstable base from CHARTNAUT_DOWNLOAD_URL, checks the hash and replaces itself', async () => {
  const body = Buffer.from('#!/bin/sh\necho 9.9.9\n');
  const base = 'https://desktop-updates.chartnaut.com/cli/unstable';
  const manifest = { version: '9.9.9', channel: 'unstable', assets: { 'darwin-arm64': { url: `${base}/9.9.9/chartnaut-darwin-arm64`, sha256: sha(body), size: body.length } } };
  const h = harness(
    {
      'GET /cli/unstable/latest.json': { json: manifest },
      'GET /cli/unstable/9.9.9/chartnaut-darwin-arm64': { text: body.toString() },
    },
    { env: { CHARTNAUT_DOWNLOAD_URL: base } },
  );
  const bin = path.join(tmpdir('cn-bin-'), 'chartnaut');
  fs.writeFileSync(bin, 'old');
  h.ctx.execPath = bin;
  assert.equal(await h.run('upgrade'), 0, h.err());
  assert.deepEqual(h.calls.map((c) => c.url.toString()), [`${base}/latest.json`, `${base}/9.9.9/chartnaut-darwin-arm64`]);
  assert.equal(fs.readFileSync(bin, 'utf8'), body.toString());
  assert.match(h.out(), /chartnaut updated .* → 9\.9\.9/);

  const plain = harness({}, { env: { CHARTNAUT_DOWNLOAD_URL: 'http://desktop-updates.chartnaut.com/cli/unstable' } });
  assert.equal(await plain.run('upgrade', '--check'), 4);
  assert.match(plain.err(), /CHARTNAUT_DOWNLOAD_URL must be an https URL/);
  assert.equal(plain.calls.length, 0);
});
