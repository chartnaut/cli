import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { re, readJson, world, writeFiles, type World } from './harness.js';
import { DOC_TOPICS, TOKEN, VALIDATE_BAD, VALIDATE_OK, VERSIONS, run, script } from './fixtures.js';

const EMA_V1 = 'meta({ shortName: "EMA", kind: "overlay" });\nconst length = setting.number("length", 20);\nexport function onBar(ctx) {\n  return { ema: ctx.ema(ctx.close, length) };\n}\n';
const EMA_V2 = EMA_V1.replace('"length", 20', '"length", 50');

/** One project folder, taken from `init` through push, pull and diff, in order. */
describe('a project from init to push, pull and diff', () => {
  let w: World;
  const ema = () => path.join(w.cwd, 'indicators', 'my-ema');
  before(async () => (w = await world(TOKEN)));
  after(() => w.dispose());

  it('init writes chartnaut.json, the script folders and the agent guide with the docs topics', async () => {
    w.api.on('GET /docs', { json: DOC_TOPICS });
    const r = await w.cli(['init']);
    assert.equal(r.code, 0, r.stderr);
    for (const line of ['chartnaut.json: created', 'indicators/: created', 'definitions/: created', 'studies/: created', 'CLAUDE.md: created', 'AGENTS.md: created']) {
      assert.match(r.stdout, re(line));
    }
    assert.deepEqual(readJson(path.join(w.cwd, 'chartnaut.json')), { defaults: { instrument: 'BTC', timeframe: '5m', window: '90d' } });
    for (const d of ['indicators', 'definitions', 'studies']) assert.ok(fs.existsSync(path.join(w.cwd, d, '.gitkeep')));
    const guide = fs.readFileSync(path.join(w.cwd, 'CLAUDE.md'), 'utf8');
    assert.equal(fs.readFileSync(path.join(w.cwd, 'AGENTS.md'), 'utf8'), guide);
    assert.match(guide, /\| `bars-and-clocks` \| Bars and clocks \|/);
    assert.match(guide, /Project defaults: instrument `BTC`, timeframe `5m`, window `90d`/);
    assert.equal(w.api.requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
  });

  it('init again keeps what you wrote and applies an explicit flag', async () => {
    fs.appendFileSync(path.join(w.cwd, 'CLAUDE.md'), '\n## My notes\n\nKeep this.\n');
    const r = await w.cli(['init', '--instrument', 'ETH']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /chartnaut\.json: updated instrument/);
    assert.match(r.stdout, /CLAUDE\.md: refreshed the Chartnaut section/);
    const guide = fs.readFileSync(path.join(w.cwd, 'CLAUDE.md'), 'utf8');
    assert.match(guide, /## My notes\n\nKeep this\./);
    assert.match(guide, /instrument `ETH`/);
    assert.equal(readJson(path.join(w.cwd, 'chartnaut.json')).defaults.instrument, 'ETH');
  });

  it('new writes a starter folder for each kind, without calling the API', async () => {
    const before = w.api.requests.length;
    const cases: [string, string, string][] = [
      ['indicator', 'my-ema', 'indicators'],
      ['definition', 'bull-bar', 'definitions'],
      ['study', 'bull-stats', 'studies'],
    ];
    for (const [kind, slug, dir] of cases) {
      const args = ['new', kind, slug, ...(slug === 'my-ema' ? ['--name', 'My EMA'] : [])];
      const r = await w.cli(args);
      assert.equal(r.code, 0, r.stderr);
      const rel = path.join(dir, slug);
      // The CLI prints paths with / on every OS.
      const shown = `${dir}/${slug}`;
      assert.match(r.stdout, re(`wrote ${shown}/script.json and ${shown}/main.ts`));
      assert.deepEqual(readJson(path.join(w.cwd, rel, 'script.json')), { kind, slug, name: slug === 'my-ema' ? 'My EMA' : slug, entry: 'main.ts' });
      assert.match(fs.readFileSync(path.join(w.cwd, rel, 'main.ts'), 'utf8'), /runs on Chartnaut servers/);
    }
    assert.equal((await w.cli(['new', 'indicator', 'my-ema'])).code, 4, 'an existing folder is refused');
    assert.equal((await w.cli(['new', 'indicator', 'Bad_Slug'])).code, 4);
    assert.equal((await w.cli(['new', 'strategy', 'x-y'])).code, 4);
    assert.equal(w.api.requests.length, before);
  });

  it('validate: ok prints the interface and the pinned dependencies', async () => {
    fs.writeFileSync(path.join(ema(), 'main.ts'), EMA_V1);
    w.api.on('POST /scripts/validate', (req) => ({ json: req.body.kind === 'definition' ? VALIDATE_BAD : VALIDATE_OK }));
    const r = await w.cli(['validate', 'indicators/my-ema']);
    assert.equal(r.code, 0, r.stderr);
    const req = w.api.requests.at(-1)!;
    assert.equal(req.method, 'POST');
    assert.deepEqual(req.body, { kind: 'indicator', files: [{ path: 'main.ts', code: EMA_V1, entry: true }] });
    assert.match(r.stdout, /ok: my-ema \(indicator\)/);
    assert.match(r.stdout, /length\s+number\s+20/);
    assert.match(r.stdout, /ema\s+line\s+price/);
    assert.match(r.stdout, /session-range\s+range\s+7/);
  });

  it('validate: errors print path:line diagnostics and exit 1', async () => {
    const r = await w.cli(['validate', 'definitions/bull-bar']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /main\.ts:14: error: Cannot find name 'rangeHigh' \[lint\]/);
    assert.match(r.stderr, /invalid: bull-bar \(definition\)/);
    assert.match(r.stdout, /main\.ts:3: warning: 'unused' is declared but never read \[lint\]/);
    const j = await w.cli(['validate', 'definitions/bull-bar', '--json']);
    assert.equal(j.code, 1);
    assert.deepEqual(JSON.parse(j.stdout), VALIDATE_BAD);
  });

  it('validate: a lone file takes its kind from --kind', async () => {
    writeFiles(w.cwd, { 'scratch/probe.ts': 'emit("x");\n' });
    const r = await w.cli(['validate', 'scratch/probe.ts', '--kind', 'definition']);
    assert.equal(r.code, 1);
    assert.deepEqual(w.api.requests.at(-1)!.body, { kind: 'definition', files: [{ path: 'probe.ts', code: 'emit("x");\n', entry: true }] });
    assert.equal((await w.cli(['validate', 'scratch/probe.ts'])).code, 4, 'no kind: refused before any request');
  });

  it('push creates the script on first push and records the version', async () => {
    w.api.on('POST /scripts', { status: 201, json: script({ latest_version: 1, version: 1, description: '', updated_at: '2026-09-26T09:12:30.918442Z' }) });
    const r = await w.cli(['push', 'indicators/my-ema', '-m', 'First version']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /pushed my-ema@1/);
    assert.match(r.stdout, /app: https:\/\/terminal\.chartnaut\.com\/morpheus\/indicator-builder\/412/);
    const req = w.api.calls('POST /scripts')[0]!;
    assert.deepEqual(req.body, { kind: 'indicator', slug: 'my-ema', name: 'My EMA', files: [{ path: 'main.ts', code: EMA_V1, entry: true }], change_summary: 'First version' });
    assert.ok(req.headers['idempotency-key']);
    assert.equal(readJson(path.join(ema(), 'script.json')).version, 1);
  });

  it('push onto a newer remote version exits 4 with version_conflict and changes nothing', async () => {
    fs.writeFileSync(path.join(ema(), 'main.ts'), EMA_V2);
    // 409 version_conflict carries details.latest_version, as the API sends it.
    const conflict = (req: any) => ({ status: 409, json: { error: { code: 'version_conflict', message: `my-ema is at version 5, not ${req.body.base_version}. Pull it, re-apply your change, and save again.`, details: { latest_version: 5 } } } });
    w.api.on('PUT /scripts/my-ema', (req) => (req.body.base_version < 5 ? conflict(req) : { json: script({ latest_version: 6, version: 6 }) }));
    const r = await w.cli(['push', 'indicators/my-ema', '-m', 'Default length 50']);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /error: version_conflict: my-ema is at version 5, not 1\./);
    assert.match(r.stderr, /chartnaut pull my-ema/);
    const [put] = w.api.calls('PUT /scripts/my-ema');
    assert.deepEqual(put!.body, { files: [{ path: 'main.ts', code: EMA_V2, entry: true }], base_version: 1, change_summary: 'Default length 50' });
    assert.equal(readJson(path.join(ema(), 'script.json')).version, 1);
  });

  it('push --force saves on top of the latest remote version', async () => {
    w.api.on('GET /scripts/my-ema', { json: script({ latest_version: 5, version: 5 }) });
    const before = w.api.requests.length;
    const r = await w.cli(['push', 'indicators/my-ema', '-m', 'Default length 50', '--force']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /pushed my-ema@6/);
    const reqs = w.api.requests.slice(before);
    assert.deepEqual(reqs.map((q) => `${q.method} ${q.path} ${q.body?.base_version ?? ''}`.trim()), ['PUT /scripts/my-ema 1', 'GET /scripts/my-ema', 'PUT /scripts/my-ema 5']);
    assert.equal(readJson(path.join(ema(), 'script.json')).version, 6);
  });

  it('diff shows local changes against the latest remote version', async () => {
    w.api.on('GET /scripts/my-ema', { json: script({ latest_version: 6, version: 6, files: [{ path: 'main.ts', code: EMA_V1, entry: true }] }) });
    const r = await w.cli(['diff', 'my-ema']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(w.api.requests.at(-1)!.query.include, 'source');
    assert.match(r.stdout, /^--- remote\/main\.ts@6$/m);
    assert.match(r.stdout, /^\+\+\+ local\/main\.ts$/m);
    assert.match(r.stdout, /^-const length = setting\.number\("length", 20\);$/m);
    assert.match(r.stdout, /^\+const length = setting\.number\("length", 50\);$/m);

    const j = await w.cli(['diff', 'indicators/my-ema', '--json']);
    const d = JSON.parse(j.stdout);
    assert.deepEqual([d.slug, d.local_base_version, d.remote_version, d.changed], ['my-ema', 6, 6, ['main.ts']]);

    w.api.on('GET /scripts/my-ema', { json: script({ latest_version: 7, version: 7, files: [{ path: 'main.ts', code: EMA_V2, entry: true }] }) });
    const same = await w.cli(['diff', 'my-ema']);
    assert.equal(same.stdout.trim(), 'no differences (remote v7)');
    assert.match(same.stderr, /note: local folder is based on v6; remote latest is v7/);
    assert.equal((await w.cli(['diff', 'nope'])).code, 4);
  });

  it('pull writes every file of a saved version and its script.json', async () => {
    w.api.on('GET /scripts/session-range@7', {
      json: script({
        slug: 'session-range',
        name: 'Session range',
        latest_version: 7,
        version: 7,
        files: [
          { path: 'main.ts', code: 'import { range } from "./lib/range";\n', entry: true },
          { path: 'lib/range.ts', code: 'export const range = 1;\n', entry: false },
        ],
      }),
    });
    const r = await w.cli(['pull', 'session-range@7']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(w.api.requests.at(-1)!.query.include, 'source');
    const dir = path.join(w.cwd, 'indicators', 'session-range');
    assert.match(r.stdout, re(`pulled session-range@7 → indicators/session-range (2 files)`));
    assert.equal(fs.readFileSync(path.join(dir, 'lib', 'range.ts'), 'utf8'), 'export const range = 1;\n');
    assert.deepEqual(readJson(path.join(dir, 'script.json')), { kind: 'indicator', slug: 'session-range', name: 'Session range', entry: 'main.ts', version: 7 });
  });

  it('pull into an existing folder warns about local files the version does not have', async () => {
    fs.writeFileSync(path.join(ema(), 'notes.md'), 'mine\n');
    w.api.on('GET /scripts/my-ema', { json: script({ latest_version: 7, version: 7, files: [{ path: 'main.ts', code: EMA_V2, entry: true }] }) });
    const r = await w.cli(['pull', 'my-ema']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /warning: local files not in the remote version .*notes\.md/);
    assert.equal(readJson(path.join(ema(), 'script.json')).version, 7);
    assert.ok(fs.existsSync(path.join(ema(), 'notes.md')), 'pull never deletes');

    w.api.on('GET /scripts/chartnaut-rsi', { json: script({ slug: 'chartnaut-rsi' }) });
    const none = await w.cli(['pull', 'chartnaut-rsi']);
    assert.equal(none.code, 4);
    assert.match(none.stderr, /returned no source/);
  });

  it('ls and versions page through your scripts and their history', async () => {
    w.api.on('GET /scripts', { json: { data: [script(), script({ slug: 'session-range', name: 'Session range', visibility: 'public', latest_version: 7 })], next_cursor: '2' } });
    const ls = await w.cli(['ls', '--kind', 'indicator', '-q', 'ema', '--limit', '2']);
    assert.equal(ls.code, 0, ls.stderr);
    assert.deepEqual(w.api.requests.at(-1)!.query, { kind: 'indicator', q: 'ema', limit: '2' });
    assert.match(ls.stdout, /SLUG\s+KIND\s+VERSION\s+VISIBILITY\s+UPDATED\s+NAME/);
    assert.match(ls.stdout, /my-ema\s+indicator\s+3\s+private\s+2026-09-25 14:02\s+My EMA/);
    assert.match(ls.stdout, /more: --cursor 2/);

    w.api.on('GET /scripts/my-ema/versions', { json: VERSIONS });
    const v = await w.cli(['versions', 'my-ema@3', '--limit', '2', '--cursor', '0']);
    assert.equal(v.code, 0, v.stderr);
    assert.equal(w.api.requests.at(-1)!.path, '/scripts/my-ema/versions');
    assert.deepEqual(w.api.requests.at(-1)!.query, { limit: '2', cursor: '0' });
    assert.match(v.stdout, /3\s+2026-09-25 14:02\s+api\s+Clamp length to 1 or more/);
    assert.match(v.stdout, /more: --cursor 2/);
  });

  it('open prints the app link of a script or a run', async () => {
    w.api.on('GET /scripts/my-ema', { json: script() });
    w.api.on('GET /runs/run_7k2m9q4xw1ht0bza', { json: run({ app_url: 'https://terminal.chartnaut.com/morpheus/runs/run_7k2m9q4xw1ht0bza' }) });
    w.api.on('GET /runs/run_noapp', { json: run({ id: 'run_noapp', app_url: null }) });
    const s = await w.cli(['open', 'my-ema']);
    assert.equal(s.stdout.trim(), 'https://terminal.chartnaut.com/morpheus/indicator-builder/412');
    const r = await w.cli(['open', 'run_7k2m9q4xw1ht0bza', '--json']);
    assert.deepEqual(JSON.parse(r.stdout), { app_url: 'https://terminal.chartnaut.com/morpheus/runs/run_7k2m9q4xw1ht0bza' });
    const none = await w.cli(['open', 'run_noapp']);
    assert.equal(none.code, 4);
    assert.match(none.stderr, /run_noapp has no app_url/);
  });

  it('open --browser refuses a link that is not a Chartnaut https link', async () => {
    w.api.on('GET /scripts/odd', { json: script({ slug: 'odd', app_url: 'http://example.test/x' }) });
    const r = await w.cli(['open', 'odd', '--browser']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'http://example.test/x');
    assert.match(r.stderr, /warning: not opening http:\/\/example\.test\/x in a browser: only https links are opened/);
  });
});
