import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, tmpdir, world, type World } from './harness.js';
import { TOKEN } from './fixtures.js';

describe('mcp install', () => {
  let w: World;
  let url: string;
  before(async () => {
    w = await world(TOKEN);
    url = `${w.api.url}/mcp`;
  });
  after(() => w.dispose());
  beforeEach(() => w.api.reset());

  it('prints every client against the API URL, never the key, and sends no requests', async () => {
    const r = await w.cli(['mcp', 'install']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`Chartnaut MCP server: ${url}`));
    assert.ok(r.stdout.includes(`claude mcp add --transport http chartnaut ${url}\n`));
    assert.ok(r.stdout.includes('"Authorization": "Bearer ${env:CHARTNAUT_TOKEN}"'));
    assert.ok(r.stdout.includes(`url = "${url}"`));
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));

    const j = await w.cli(['mcp', 'install', 'codex', '--json']);
    assert.equal(j.code, 0, j.stderr);
    const body = JSON.parse(j.stdout);
    assert.equal(body.url, url);
    assert.deepEqual(Object.keys(body.clients), ['codex']);
    assert.equal(w.api.requests.length, 0);
  });

  it('cursor --write and codex --write write into HOME', async () => {
    const c = await w.cli(['mcp', 'install', 'cursor', '--write']);
    assert.equal(c.code, 0, c.stderr);
    const cursor = path.join(w.home, '.cursor', 'mcp.json');
    assert.deepEqual(readJson(cursor), { mcpServers: { chartnaut: { url, headers: { Authorization: `Bearer ${TOKEN}` } } } });
    if (process.platform !== 'win32') assert.equal(fs.statSync(cursor).mode & 0o777, 0o600);
    assert.ok(!c.stdout.includes(TOKEN));

    const x = await w.cli(['mcp', 'install', 'codex', '--write']);
    assert.equal(x.code, 0, x.stderr);
    const toml = fs.readFileSync(path.join(w.home, '.codex', 'config.toml'), 'utf8');
    assert.equal(toml, `[mcp_servers.chartnaut]\nurl = "${url}"\nbearer_token_env_var = "CHARTNAUT_TOKEN"\n`);
    assert.equal(w.api.requests.length, 0);
  });

  it('--write without a client, or claude --write without a key, fails before touching anything', async () => {
    const u = await w.cli(['mcp', 'install', '--write']);
    assert.equal(u.code, 4);
    const a = await w.cli(['mcp', 'install', 'claude', '--write'], { token: '' });
    assert.equal(a.code, 3, a.stderr);
    assert.match(a.stderr, /chartnaut login/);
    assert.equal(w.api.requests.length, 0);
  });

  it('claude --write runs claude mcp add with the key', { skip: process.platform === 'win32' }, async () => {
    const bin = tmpdir('cn-e2e-bin-');
    const log = path.join(bin, 'args.txt');
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n`, { mode: 0o755 });
    try {
      const r = await w.cli(['mcp', 'install', 'claude', '--write'], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(fs.readFileSync(log, 'utf8').trimEnd().split('\n'), [
        'mcp', 'add', '--transport', 'http', '--scope', 'user', 'chartnaut', url, '--header', `Authorization: Bearer ${TOKEN}`,
      ]);
      assert.match(r.stdout, /Added chartnaut to Claude Code \(user scope\)/);
      assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));

      // No claude on PATH: exit 4 with the manual line.
      const missing = await w.cli(['mcp', 'install', 'claude', '--write'], { env: { PATH: tmpdir('cn-e2e-empty-') } });
      assert.equal(missing.code, 4, missing.stderr);
      assert.match(missing.stderr, /`claude` command was not found/);
      assert.equal(w.api.requests.length, 0);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});
