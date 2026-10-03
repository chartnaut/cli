import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness, writeFiles } from './helpers.js';
import { readScript, writeScript } from '../src/project.js';
import { mergeGuide } from '../src/commands/scripts.js';

const read = (p: string) => fs.readFileSync(p, 'utf8');
const readJson = (p: string) => JSON.parse(read(p));

test('init writes chartnaut.json, folders and identical CLAUDE.md / AGENTS.md with the docs topics', async () => {
  const h = harness({ 'GET /docs': { json: { data: [{ topic: 'definitions/events', title: 'Events', depth: 1 }] } } });
  assert.equal(await h.run('init'), 0, h.err());
  assert.deepEqual(readJson(path.join(h.cwd, 'chartnaut.json')), { defaults: { instrument: 'BTC', timeframe: '5m', window: '90d' } });
  for (const d of ['indicators', 'definitions', 'studies']) assert.ok(fs.statSync(path.join(h.cwd, d)).isDirectory());
  const claude = read(path.join(h.cwd, 'CLAUDE.md'));
  assert.equal(claude, read(path.join(h.cwd, 'AGENTS.md')));
  assert.match(claude, /run on Chartnaut servers/);
  assert.match(claude, /series/);
  assert.match(claude, /events/);
  assert.match(claude, /study blocks/);
  assert.match(claude, /\| Topic \| What it covers \|/);
  assert.match(claude, /\| `definitions\/events` \| Events \|/);
  assert.doesNotMatch(claude, /\| Topic \| Kind \|/);
  for (const step of ['chartnaut docs <topic>', 'chartnaut validate', 'chartnaut run <path> --last 30d', 'chartnaut push']) {
    assert.ok(claude.includes(step), step);
  }
});

test('init without a reachable docs endpoint tells the agent to run chartnaut docs', async () => {
  const h = harness({ 'GET /docs': { status: 500, text: 'down' } });
  assert.equal(await h.run('init'), 0);
  assert.match(read(path.join(h.cwd, 'CLAUDE.md')), /Run `chartnaut docs` to list the topics/);
  assert.match(h.out(), /could not fetch the docs topic list/);
});

test('init never removes what you wrote in CLAUDE.md or AGENTS.md', async () => {
  const docs = { 'GET /docs': { json: { data: [] } } };
  const h = harness(docs);
  const mine = '# My project\n\nAlways answer in French.\n';
  fs.writeFileSync(path.join(h.cwd, 'CLAUDE.md'), mine);
  fs.writeFileSync(path.join(h.cwd, 'AGENTS.md'), 'no trailing newline');
  assert.equal(await h.run('init'), 0, h.err());
  const claude = read(path.join(h.cwd, 'CLAUDE.md'));
  assert.ok(claude.startsWith(mine), 'existing content kept, byte for byte, at the top');
  assert.match(claude, /chartnaut:begin[\s\S]*chartnaut validate[\s\S]*chartnaut:end/);
  assert.ok(read(path.join(h.cwd, 'AGENTS.md')).startsWith('no trailing newline\n'));

  // The user adds more around the block; a second init refreshes only the block.
  fs.writeFileSync(path.join(h.cwd, 'CLAUDE.md'), claude + '\n## Notes added later\n\nKeep me.\n');
  const h2 = harness(docs);
  fs.cpSync(h.cwd, h2.cwd, { recursive: true });
  assert.equal(await h2.run('init', '--instrument', 'ETH'), 0, h2.err());
  const after = read(path.join(h2.cwd, 'CLAUDE.md'));
  assert.ok(after.startsWith(mine));
  assert.match(after, /## Notes added later\n\nKeep me\.\n$/);
  assert.equal(after.split('chartnaut:begin').length, 2, 'exactly one Chartnaut block');
  assert.match(after, /instrument `ETH`/, 'the block itself is refreshed');

  // Running again with nothing new changes nothing.
  const h3 = harness(docs);
  fs.cpSync(h2.cwd, h3.cwd, { recursive: true });
  assert.equal(await h3.run('init', '--instrument', 'ETH'), 0);
  assert.equal(read(path.join(h3.cwd, 'CLAUDE.md')), after);
  assert.match(h3.out(), /CLAUDE\.md: unchanged/);
});

test('init keeps every key in an existing chartnaut.json, fills missing defaults, and honours explicit flags', async () => {
  const h = harness({ 'GET /docs': { json: { data: [] } } });
  fs.writeFileSync(path.join(h.cwd, 'chartnaut.json'), JSON.stringify({ defaults: { instrument: 'GOLD' }, myTeam: 'desk-2' }));
  assert.equal(await h.run('init'), 0);
  assert.deepEqual(readJson(path.join(h.cwd, 'chartnaut.json')), { defaults: { instrument: 'GOLD', timeframe: '5m', window: '90d' }, myTeam: 'desk-2' });
  assert.equal(await h.run('init', '--tf', '15m'), 0);
  assert.deepEqual(readJson(path.join(h.cwd, 'chartnaut.json')).defaults, { instrument: 'GOLD', timeframe: '15m', window: '90d' });
  assert.match(read(path.join(h.cwd, 'CLAUDE.md')), /instrument `GOLD`, timeframe `15m`/);
});

test('init leaves a chartnaut.json it cannot parse alone, and never touches files in existing folders', async () => {
  const h = harness({ 'GET /docs': { json: { data: [] } } });
  fs.writeFileSync(path.join(h.cwd, 'chartnaut.json'), '{ not json');
  fs.mkdirSync(path.join(h.cwd, 'indicators', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(h.cwd, 'indicators', 'mine', 'main.ts'), 'keep');
  assert.equal(await h.run('init'), 0);
  assert.equal(read(path.join(h.cwd, 'chartnaut.json')), '{ not json');
  assert.match(h.out(), /chartnaut\.json: left alone/);
  assert.equal(read(path.join(h.cwd, 'indicators', 'mine', 'main.ts')), 'keep');
  assert.equal(fs.existsSync(path.join(h.cwd, 'indicators', '.gitkeep')), false, 'no files added to a folder that existed');
});

test('new writes a starter folder', async () => {
  const h = harness();
  writeFiles(h.cwd, { 'chartnaut.json': '{}' });
  assert.equal(await h.run('new', 'definition', 'orb-break'), 0);
  const dir = path.join(h.cwd, 'definitions', 'orb-break');
  assert.deepEqual(readJson(path.join(dir, 'script.json')), { kind: 'definition', slug: 'orb-break', name: 'orb-break', entry: 'main.ts' });
  assert.match(read(path.join(dir, 'main.ts')), /chartnaut docs/);
  assert.equal(await h.run('new', 'definition', 'orb-break'), 4);
  assert.equal(await h.run('new', 'flow', 'x-y'), 4);
  assert.equal(await h.run('new', 'study', 'Bad_Slug'), 4);
});

test('script folder round trip (nested files, entry flag, ignored files)', () => {
  const h = harness();
  const dir = path.join(h.cwd, 'definitions', 'multi');
  const extra = writeScript(dir, { kind: 'definition', slug: 'multi', name: 'Multi', entry: 'main.ts', version: 3 }, [
    { path: 'main.ts', code: 'import "./lib/util";\n' },
    { path: 'lib/util.ts', code: 'export {};\n' },
  ]);
  assert.deepEqual(extra, []);
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  const s = readScript(dir);
  assert.deepEqual(s.meta, { kind: 'definition', slug: 'multi', name: 'Multi', entry: 'main.ts', version: 3 });
  assert.deepEqual(s.files, [
    { path: 'lib/util.ts', code: 'export {};\n', entry: false },
    { path: 'main.ts', code: 'import "./lib/util";\n', entry: true },
  ]);
  // a file inside the folder resolves to the folder
  assert.equal(readScript(path.join(dir, 'lib', 'util.ts')).meta.slug, 'multi');
  assert.throws(() => writeScript(dir, s.meta, [{ path: '../escape.ts', code: '' }]), /outside/);
});

test('validate: ok prints interface, ok:false exits 1 with diagnostics', async () => {
  const h = harness({
    'POST /scripts/validate': [
      { json: { ok: true, diagnostics: [], interface: { settings: { len: { type: 'number', default: 14 } }, outputs: [{ id: 'rsi', kind: 'line' }] } } },
      { json: { ok: false, diagnostics: [{ severity: 'error', message: 'missing export', path: 'main.ts', line: 1 }] } },
    ],
  });
  writeFiles(h.cwd, {
    'indicators/r/script.json': JSON.stringify({ kind: 'indicator', slug: 'r', entry: 'main.ts' }),
    'indicators/r/main.ts': 'x',
  });
  assert.equal(await h.run('validate', 'indicators/r'), 0);
  assert.deepEqual(h.calls[0]!.body, { kind: 'indicator', files: [{ path: 'main.ts', code: 'x', entry: true }] });
  assert.match(h.out(), /len\s+number\s+14/);
  assert.equal(await h.run('validate', 'indicators/r'), 1);
  assert.match(h.err(), /main\.ts:1: error: missing export/);
});

test('push creates on first push and writes the version back; later pushes send base_version', async () => {
  const h = harness({
    'POST /scripts': { status: 201, json: { slug: 'r', kind: 'indicator', version: 1, latest_version: 1 } },
    'PUT /scripts/r': { json: { slug: 'r', kind: 'indicator', version: 2, latest_version: 2 } },
  });
  writeFiles(h.cwd, {
    'indicators/r/script.json': JSON.stringify({ kind: 'indicator', slug: 'r', name: 'R', entry: 'main.ts' }),
    'indicators/r/main.ts': 'x',
  });
  const meta = path.join(h.cwd, 'indicators/r/script.json');
  assert.equal(await h.run('push', 'indicators/r', '-m', 'first'), 0, h.err());
  assert.deepEqual(h.calls[0]!.body, {
    kind: 'indicator',
    slug: 'r',
    name: 'R',
    files: [{ path: 'main.ts', code: 'x', entry: true }],
    change_summary: 'first',
  });
  assert.ok(h.calls[0]!.headers['idempotency-key']);
  assert.equal(readJson(meta).version, 1);

  assert.equal(await h.run('push', 'indicators/r'), 0);
  assert.equal(h.calls[1]!.method, 'PUT');
  assert.equal(h.calls[1]!.body.base_version, 1);
  assert.equal(readJson(meta).version, 2);
});

test('push on version_conflict exits 4 with advice; --force rebases on latest', async () => {
  const conflict = { status: 409, json: { error: { code: 'version_conflict', message: 'latest is 5' } } };
  const h = harness({
    'PUT /scripts/r': (call) => (call.body.base_version === 5 ? { json: { slug: 'r', version: 6 } } : conflict),
    'GET /scripts/r': { json: { slug: 'r', version: 5, latest_version: 5 } },
  });
  writeFiles(h.cwd, {
    'indicators/r/script.json': JSON.stringify({ kind: 'indicator', slug: 'r', entry: 'main.ts', version: 3 }),
    'indicators/r/main.ts': 'x',
  });
  assert.equal(await h.run('push', 'indicators/r'), 4);
  assert.match(h.err(), /version_conflict: latest is 5\. Run `chartnaut pull r`.*--force/);
  assert.equal(await h.run('push', 'indicators/r', '--force'), 0, h.err());
  assert.equal(readJson(path.join(h.cwd, 'indicators/r/script.json')).version, 6);
});

test('pull writes files and script.json under <kind-plural>/<slug>', async () => {
  const h = harness({
    'GET /scripts/orb@2': {
      json: { slug: 'orb', kind: 'definition', name: 'ORB', version: 2, files: [{ path: 'lib.ts', code: 'L' }, { path: 'main.ts', code: 'M', entry: true }] },
    },
  });
  writeFiles(h.cwd, { 'chartnaut.json': '{}' });
  assert.equal(await h.run('pull', 'orb@2'), 0, h.err());
  assert.equal(h.calls[0]!.url.searchParams.get('include'), 'source');
  const dir = path.join(h.cwd, 'definitions', 'orb');
  assert.deepEqual(readJson(path.join(dir, 'script.json')), { kind: 'definition', slug: 'orb', name: 'ORB', entry: 'main.ts', version: 2 });
  assert.equal(read(path.join(dir, 'lib.ts')), 'L');
});

test('diff prints a unified diff local vs remote', async () => {
  const h = harness({ 'GET /scripts/r': { json: { slug: 'r', version: 4, files: [{ path: 'main.ts', code: 'a\nb\n', entry: true }] } } });
  writeFiles(h.cwd, {
    'chartnaut.json': '{}',
    'indicators/r/script.json': JSON.stringify({ kind: 'indicator', slug: 'r', entry: 'main.ts', version: 4 }),
    'indicators/r/main.ts': 'a\nc\n',
  });
  assert.equal(await h.run('diff', 'r'), 0, h.err());
  assert.match(h.out(), /--- remote\/main\.ts@4\n\+\+\+ local\/main\.ts\n@@ -1,2 \+1,2 @@\n a\n-b\n\+c/);
});

test('ls / versions / open', async () => {
  const h = harness({
    'GET /scripts': { json: { data: [{ slug: 'r', kind: 'indicator', latest_version: 2, visibility: 'private', name: 'R' }], next_cursor: 'c2' } },
    'GET /scripts/r/versions': { json: { data: [{ version: 2, author: 'api', change_summary: 'tweak' }] } },
    'GET /scripts/r': { json: { slug: 'r', app_url: 'https://terminal.chartnaut.com/morpheus/x/r' } },
    'GET /runs/run_7': { json: { id: 'run_7', status: 'succeeded', app_url: 'https://terminal.chartnaut.com/morpheus/runs/run_7' } },
  });
  assert.equal(await h.run('ls', '--kind', 'indicator'), 0);
  assert.equal(h.calls[0]!.url.searchParams.get('kind'), 'indicator');
  assert.match(h.out(), /more: --cursor c2/);
  assert.equal(await h.run('versions', 'r'), 0);
  assert.match(h.out(), /2\s+-\s+api\s+tweak/);
  assert.equal(await h.run('open', 'r'), 0);
  assert.equal(h.stdout.at(-1), 'https://terminal.chartnaut.com/morpheus/x/r');
  assert.equal(h.execs.length, 0);
  assert.equal(await h.run('open', 'run_7', '--browser'), 0);
  assert.deepEqual(h.execs[0], { cmd: 'open', args: ['https://terminal.chartnaut.com/morpheus/runs/run_7'] });
  assert.equal(await h.run('ls', '--kind', 'flow'), 4);
});

test('open --browser refuses a link that is not a Chartnaut https link, but still prints it', async () => {
  const h = harness({ 'GET /scripts/r': { json: { slug: 'r', app_url: 'https://evil.example/x' } } });
  assert.equal(await h.run('open', 'r', '--browser'), 0);
  assert.equal(h.stdout.at(-1), 'https://evil.example/x');
  assert.equal(h.execs.length, 0);
  assert.match(h.err(), /not opening https:\/\/evil\.example\/x in a browser: evil\.example is not a Chartnaut host/);
});

test('init replaces a block written with the pre-0.1.0 marker instead of adding a second one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-guide-'));
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, '# Mine\n\n<!-- chartnaut:begin — maintained by `chartnaut init`; edits inside this block are replaced on the next init -->\nold guide\n<!-- chartnaut:end -->\n');
  mergeGuide(file, 'new guide');
  const out = fs.readFileSync(file, 'utf8');
  assert.equal(out.split('chartnaut:begin').length, 2, 'exactly one Chartnaut block');
  assert.match(out, /# Mine[\s\S]*new guide/);
  assert.doesNotMatch(out, /old guide/);
});

test('pull refuses a server slug that is not a plain slug', async () => {
  const h = harness({ 'GET /scripts/my-x': { json: { kind: 'indicator', slug: '../../../.config/evil', version: 1, files: [{ path: 'main.ts', code: 'x', entry: true }] } } });
  const code = await h.run('pull', 'my-x');
  assert.equal(code, 0, h.err());
  assert.match(h.out(), /pulled my-x@1 → indicators\/my-x/);
});
