import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, writeFiles } from './helpers.js';
import { keyPrefix } from '../src/commands/mcp.js';

const URL_ = 'https://api.test/v1/mcp';
const KEY = 'cn_test_token';
const cursorFile = (home: string) => path.join(home, '.cursor', 'mcp.json');
const codexFile = (home: string) => path.join(home, '.codex', 'config.toml');

test('mcp install prints all three clients with the MCP URL and no key, and makes no calls', async () => {
  const h = harness();
  assert.equal(await h.run('mcp', 'install'), 0);
  const out = h.out();
  assert.match(out, /Chartnaut MCP server: https:\/\/api\.test\/v1\/mcp/);
  assert.ok(out.includes(`claude mcp add --transport http chartnaut ${URL_}\n`));
  assert.ok(out.includes(`claude mcp add --transport http chartnaut ${URL_} --header "Authorization: Bearer $CHARTNAUT_TOKEN"`));
  assert.match(out, /run \/mcp in Claude Code.*Authenticate/);
  assert.ok(out.includes('~/.cursor/mcp.json'));
  assert.ok(out.includes('"Authorization": "Bearer ${env:CHARTNAUT_TOKEN}"'));
  assert.ok(out.includes('~/.codex/config.toml'));
  assert.ok(out.includes(`[mcp_servers.chartnaut]\n    url = "${URL_}"\n    bearer_token_env_var = "CHARTNAUT_TOKEN"`));
  assert.ok(out.includes('https://docs.chartnaut.com/cli/mcp-overview'));
  assert.ok(out.includes('https://docs.chartnaut.com/cli/mcp-claude'));
  assert.ok(out.includes('https://docs.chartnaut.com/cli/mcp-cursor-and-codex'));
  assert.ok(!out.includes(KEY) && !h.err().includes(KEY));
  assert.equal(h.calls.length, 0);
  assert.equal(h.execs.length, 0);
});

test('mcp install <client> prints only that client', async () => {
  for (const [client, has, lacks] of [
    ['claude', /Claude Code/, /Cursor|Codex|config\.toml|mcp\.json/],
    ['cursor', /Cursor[\s\S]*mcp\.json/, /Claude Code|config\.toml/],
    ['codex', /Codex[\s\S]*config\.toml/, /Claude Code|mcp\.json|claude mcp add/],
  ] as const) {
    const h = harness();
    assert.equal(await h.run('mcp', 'install', client), 0, client);
    assert.match(h.out(), has, client);
    assert.doesNotMatch(h.out(), lacks, client);
    assert.ok(!h.out().includes(KEY), client);
    assert.equal(h.calls.length, 0);
  }
  const bad = harness();
  assert.equal(await bad.run('mcp', 'install', 'vscode'), 4);
  assert.equal(bad.calls.length, 0);
});

test('mcp install follows CHARTNAUT_API_URL (trailing slash trimmed)', async () => {
  const h = harness({}, { env: { CHARTNAUT_API_URL: 'http://127.0.0.1:9999/v1/' } });
  assert.equal(await h.run('mcp', 'install', 'claude'), 0);
  assert.ok(h.out().includes('claude mcp add --transport http chartnaut http://127.0.0.1:9999/v1/mcp\n'));
  const d = harness({}, { env: { CHARTNAUT_API_URL: '' } });
  assert.equal(await d.run('mcp', 'install', 'codex'), 0);
  assert.ok(d.out().includes('url = "https://api.chartnaut.com/v1/mcp"'));
  assert.equal(h.calls.length + d.calls.length, 0);
});

test('mcp install --json: url and each client, limited to one when named', async () => {
  const h = harness();
  assert.equal(await h.run('mcp', 'install', '--json'), 0);
  const all = JSON.parse(h.out());
  assert.equal(all.url, URL_);
  assert.deepEqual(Object.keys(all.clients).sort(), ['claude', 'codex', 'cursor']);
  assert.deepEqual(all.clients.claude, {
    oauth: `claude mcp add --transport http chartnaut ${URL_}`,
    api_key: `claude mcp add --transport http chartnaut ${URL_} --header "Authorization: Bearer $CHARTNAUT_TOKEN"`,
  });
  assert.deepEqual(all.clients.cursor, {
    path: cursorFile(h.home),
    oauth: { mcpServers: { chartnaut: { url: URL_ } } },
    api_key: { mcpServers: { chartnaut: { url: URL_, headers: { Authorization: 'Bearer ${env:CHARTNAUT_TOKEN}' } } } },
  });
  assert.deepEqual(all.clients.codex, {
    path: codexFile(h.home),
    config: `[mcp_servers.chartnaut]\nurl = "${URL_}"\nbearer_token_env_var = "CHARTNAUT_TOKEN"\n`,
  });
  assert.ok(!h.out().includes(KEY));

  const one = harness();
  assert.equal(await one.run('mcp', 'install', 'cursor', '--json'), 0);
  assert.deepEqual(Object.keys(JSON.parse(one.out()).clients), ['cursor']);
  assert.equal(h.calls.length + one.calls.length, 0);
});

test('mcp install --write without a client is a usage error and writes nothing', async () => {
  const h = harness();
  assert.equal(await h.run('mcp', 'install', '--write'), 4);
  assert.match(h.err(), /--write needs a client/);
  assert.equal(h.execs.length, 0);
  assert.ok(!fs.existsSync(path.join(h.home, '.cursor')) && !fs.existsSync(path.join(h.home, '.codex')));
  assert.equal(h.calls.length, 0);
});

test('mcp install claude --write runs claude mcp add with the key and prints only a prefix', async () => {
  const h = harness();
  assert.equal(await h.run('mcp', 'install', 'claude', '--write'), 0);
  assert.deepEqual(h.execs, [
    {
      cmd: 'claude',
      args: ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'chartnaut', URL_, '--header', `Authorization: Bearer ${KEY}`],
    },
  ]);
  assert.match(h.out(), /Added chartnaut to Claude Code \(user scope\) with your API key cn_tes…\. Revoke the key under Developers/);
  assert.ok(!h.out().includes(KEY) && !h.err().includes(KEY));
  assert.equal(h.calls.length, 0);
});

test('mcp install claude --write: claude missing (127) or failing prints the manual line', async () => {
  const h = harness();
  h.ctx.exec = async () => 127;
  assert.equal(await h.run('mcp', 'install', 'claude', '--write'), 4);
  assert.match(h.err(), /Claude Code's `claude` command was not found/);
  assert.ok(h.err().includes(`claude mcp add --transport http chartnaut ${URL_}`));
  assert.ok(!h.err().includes(KEY) && !h.out().includes(KEY));

  const f = harness();
  f.ctx.exec = async () => 1;
  assert.equal(await f.run('mcp', 'install', 'claude', '--write'), 4);
  assert.match(f.err(), /exited with code 1.*claude mcp remove chartnaut --scope user/);
  assert.equal(h.calls.length + f.calls.length, 0);
});

test('mcp install claude|cursor --write with no key is an auth error (exit 3)', async () => {
  for (const client of ['claude', 'cursor']) {
    const h = harness({}, { env: { CHARTNAUT_TOKEN: '' } });
    assert.equal(await h.run('mcp', 'install', client, '--write'), 3, client);
    assert.match(h.err(), /chartnaut login/);
    assert.match(h.err(), /OAuth/);
    assert.equal(h.execs.length, 0);
    assert.ok(!fs.existsSync(cursorFile(h.home)));
    assert.equal(h.calls.length, 0);
  }
});

test('mcp install cursor --write creates mcp.json (0600) and merges, keeping other servers', async () => {
  const h = harness();
  assert.equal(await h.run('mcp', 'install', 'cursor', '--write'), 0);
  const file = cursorFile(h.home);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    mcpServers: { chartnaut: { url: URL_, headers: { Authorization: `Bearer ${KEY}` } } },
  });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(h.out().includes(file));
  assert.match(h.out(), /cn_tes…/);
  assert.ok(!h.out().includes(KEY));

  const m = harness();
  writeFiles(m.home, {
    '.cursor/mcp.json': JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'npx', args: ['x'] }, chartnaut: { url: 'old' } } }),
  });
  assert.equal(await m.run('mcp', 'install', 'cursor', '--write'), 0);
  const raw = fs.readFileSync(cursorFile(m.home), 'utf8');
  assert.ok(raw.startsWith('{\n  "theme": "dark",'));
  assert.deepEqual(JSON.parse(raw), {
    theme: 'dark',
    mcpServers: { other: { command: 'npx', args: ['x'] }, chartnaut: { url: URL_, headers: { Authorization: `Bearer ${KEY}` } } },
  });
  assert.equal(h.calls.length + m.calls.length, 0);
});

test('mcp install cursor --write refuses an unparseable mcp.json and leaves it alone', async () => {
  const h = harness();
  writeFiles(h.home, { '.cursor/mcp.json': '{ "mcpServers": { oops' });
  assert.equal(await h.run('mcp', 'install', 'cursor', '--write'), 4);
  assert.match(h.err(), /not valid JSON/);
  assert.equal(fs.readFileSync(cursorFile(h.home), 'utf8'), '{ "mcpServers": { oops');
  assert.equal(h.calls.length, 0);
});

test('mcp install codex --write appends the table, needs no key, and writes none', async () => {
  const h = harness({}, { env: { CHARTNAUT_TOKEN: '' } });
  assert.equal(await h.run('mcp', 'install', 'codex', '--write'), 0);
  assert.equal(fs.readFileSync(codexFile(h.home), 'utf8'), `[mcp_servers.chartnaut]\nurl = "${URL_}"\nbearer_token_env_var = "CHARTNAUT_TOKEN"\n`);
  assert.match(h.out(), /CHARTNAUT_TOKEN/);

  const a = harness();
  const before = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "npx"';
  writeFiles(a.home, { '.codex/config.toml': before });
  assert.equal(await a.run('mcp', 'install', 'codex', '--write'), 0);
  const after = fs.readFileSync(codexFile(a.home), 'utf8');
  assert.equal(after, `${before}\n\n[mcp_servers.chartnaut]\nurl = "${URL_}"\nbearer_token_env_var = "CHARTNAUT_TOKEN"\n`);
  assert.ok(!after.includes(KEY));
  assert.equal(h.calls.length + a.calls.length, 0);
});

test('mcp install codex --write replaces an existing chartnaut table, keeping the rest byte-for-byte', async () => {
  const h = harness();
  const head = '# my config\nmodel = "o3"\n\n';
  const tail = '\n[mcp_servers.other]\ncommand = "npx"\nargs = ["-y", "x"]\n';
  writeFiles(h.home, { '.codex/config.toml': `${head}[mcp_servers.chartnaut]\nurl = "https://old.example/v1/mcp"\nenabled = false\n${tail}` });
  assert.equal(await h.run('mcp', 'install', 'codex', '--write'), 0);
  assert.equal(
    fs.readFileSync(codexFile(h.home), 'utf8'),
    `${head}[mcp_servers.chartnaut]\nurl = "${URL_}"\nbearer_token_env_var = "CHARTNAUT_TOKEN"\n${tail}`,
  );
  assert.match(h.out(), /Updated/);

  // As the last table in the file.
  const e = harness();
  writeFiles(e.home, { '.codex/config.toml': `${head}[mcp_servers.chartnaut]\nurl = "old"\n` });
  assert.equal(await e.run('mcp', 'install', 'codex', '--write'), 0);
  assert.equal(fs.readFileSync(codexFile(e.home), 'utf8'), `${head}[mcp_servers.chartnaut]\nurl = "${URL_}"\nbearer_token_env_var = "CHARTNAUT_TOKEN"\n`);
  assert.equal(h.calls.length + e.calls.length, 0);
});

test('keyPrefix shows the first 12 characters of a real key and never a whole short one', () => {
  assert.equal(keyPrefix('cn_live_abcdef0123456789abcdef'), 'cn_live_abcd…');
  assert.equal(keyPrefix('cn_test_token'), 'cn_tes…');
  assert.equal(keyPrefix('abc'), 'a…');
});
