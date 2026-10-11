import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, startFakeApi, tmpdir, type FakeApi } from './harness.js';

const INSTALL_SH = path.join(CLI_ROOT, 'install', 'install.sh');
const posix = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v curl || command -v wget'], { encoding: 'utf8' }).status === 0;

describe('install.sh against the unstable channel (CHARTNAUT_DOWNLOAD_URL=…/cli/unstable)', { skip: !posix && 'needs sh and curl or wget' }, () => {
  let api: FakeApi;
  // A stand-in binary: install.sh runs `chartnaut --version` before it installs.
  const body = '#!/bin/sh\necho 0.2.0\n';
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  before(async () => {
    api = await startFakeApi();
    const asset = { url: `${api.origin}/cli/unstable/0.2.0/chartnaut-linux-x64`, sha256: sha, size: body.length };
    // The manifest exactly as build-binaries writes it: one asset per line.
    const manifest = `{\n  "version": "0.2.0",\n  "channel": "unstable",\n  "bun": "1.4.2",\n  "assets": {\n    "linux-x64": ${JSON.stringify(asset)}\n  }\n}\n`;
    api.on('GET /cli/unstable/latest.json', { text: manifest });
    api.on('GET /cli/unstable/0.2.0/manifest.json', { text: manifest });
    api.on('GET /cli/unstable/0.2.0/chartnaut-linux-x64', { text: body });
  });
  after(() => api.close());

  // Not spawnSync: the fake server runs in this process and must keep answering.
  const install = async (extra: Record<string, string> = {}) => {
    const home = tmpdir('cn-inst-home-');
    const root = path.join(home, 'chartnaut');
    const child = spawn('sh', [INSTALL_SH], {
      cwd: home,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CHARTNAUT_DOWNLOAD_URL: `${api.origin}/cli/unstable`,
        CHARTNAUT_PLATFORM: 'linux-x64',
        CHARTNAUT_INSTALL: root,
        CHARTNAUT_NO_MODIFY_PATH: '1',
        ...extra,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    return { status, stdout, stderr, bin: path.join(root, 'bin', 'chartnaut'), home };
  };

  it('installs the latest unstable build after checking its sha256', async () => {
    const r = await install();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Installing Chartnaut CLI 0\.2\.0 \(linux-x64\)/);
    assert.equal(fs.readFileSync(r.bin, 'utf8'), body);
    assert.deepEqual(api.requests.slice(-2).map((q) => q.path), ['/cli/unstable/latest.json', '/cli/unstable/0.2.0/chartnaut-linux-x64']);
    fs.rmSync(r.home, { recursive: true, force: true });
  });

  it('CHARTNAUT_VERSION reads the pinned unstable manifest', async () => {
    const r = await install({ CHARTNAUT_VERSION: '0.2.0' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(api.requests.slice(-2).map((q) => q.path), ['/cli/unstable/0.2.0/manifest.json', '/cli/unstable/0.2.0/chartnaut-linux-x64']);
    fs.rmSync(r.home, { recursive: true, force: true });
  });

  it('a binary that does not match the manifest is not installed', async () => {
    api.on('GET /cli/unstable/0.2.0/chartnaut-linux-x64', { text: '#!/bin/sh\necho evil\n' });
    const r = await install();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /checksum mismatch/);
    assert.equal(fs.existsSync(r.bin), false);
    fs.rmSync(r.home, { recursive: true, force: true });
  });
});
