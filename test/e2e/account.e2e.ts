import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apiError, re, readJson, world, type World } from './harness.js';
import { BTC, DEVICE_START, DOC_BARS, DOC_TOPICS, ETH, LIBRARY_PAGE, LIBRARY_SCRIPT, ME, NEW_TOKEN, TOKEN, USAGE } from './fixtures.js';
import { VERSION } from '../../src/version.js';

const credentials = (w: World) => path.join(w.home, '.config', 'chartnaut', 'credentials.json');

describe('sign-in: device flow, --token, logout', () => {
  // No CHARTNAUT_TOKEN: everything goes through the saved login.
  let w: World;
  before(async () => (w = await world()));
  after(() => w.dispose());

  it('login: starts a device sign-in, polls through authorization_pending, saves the key', async () => {
    w.api.on('POST /auth/device', { json: DEVICE_START });
    w.api.on('POST /auth/token', [
      apiError(400, 'authorization_pending', 'Waiting for you to approve the sign-in in your browser.'),
      { json: { token: TOKEN, name: 'CLI on test-machine' }, headers: { 'Cache-Control': 'no-store' } },
    ]);
    w.api.on('GET /me', (req) => (req.headers.authorization === `Bearer ${TOKEN}` ? { json: ME } : apiError(401, 'unauthorized', 'Invalid API token.')));

    const r = await w.cli(['login']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, re(`Go to ${DEVICE_START.verification_uri_complete}`));
    assert.match(r.stderr, /Code: KMPR-TVXZ/);
    assert.doesNotMatch(r.stderr, /Opening your browser/, 'CHARTNAUT_NO_BROWSER keeps the browser closed');
    assert.equal(r.stdout.trim(), 'Signed in as jane.');

    const [start] = w.api.calls('POST /auth/device');
    assert.equal(start!.headers.authorization, undefined, 'starting a sign-in sends no key');
    assert.equal(typeof start!.body.client_name, 'string');
    const polls = w.api.calls('POST /auth/token');
    assert.equal(polls.length, 2);
    for (const p of polls) {
      assert.deepEqual(p.body, { device_code: DEVICE_START.device_code });
      assert.equal(p.headers.authorization, undefined);
    }
    assert.equal(w.api.calls('GET /me')[0]!.headers.authorization, `Bearer ${TOKEN}`);

    assert.equal(readJson(credentials(w)).token, TOKEN);
    if (process.platform !== 'win32') assert.equal(fs.statSync(credentials(w)).mode & 0o777, 0o600);
  });

  it('whoami and usage use the saved key', async () => {
    w.api.on('GET /usage', { json: USAGE });
    const who = await w.cli(['whoami']);
    assert.equal(who.code, 0, who.stderr);
    assert.match(who.stdout, /user:\s+jane/);
    assert.match(who.stdout, /plan:\s+pro/);
    assert.match(who.stdout, /token:\s+CLI on test-machine/);
    assert.match(who.stdout, /scopes:\s+scripts:read scripts:write runs:write/);
    assert.match(who.stdout, re(`api:    ${w.api.url}`));
    assert.equal(w.api.requests.at(-1)!.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(w.api.requests.at(-1)!.headers['user-agent'] ?? '', re(`chartnaut-cli/${VERSION}`));

    const u = await w.cli(['usage']);
    assert.equal(u.code, 0, u.stderr);
    assert.match(u.stdout, /period: 2026-09-01 00:00 → 2026-10-01 00:00/);
    assert.match(u.stdout, /compute units: 1843\.20 \/ -/);
    assert.match(u.stdout, /indicators\s+7\s+unlimited/);
    assert.match(u.stdout, /definitions\s+12\s+50/);
    assert.match(u.stdout, /history from: 2015-02-02 00:00/);
    assert.match(u.stdout, /memory bars: 5000/);

    const j = await w.cli(['usage', '--json']);
    assert.deepEqual(JSON.parse(j.stdout), USAGE);
  });

  it('login again stops at "already signed in"', async () => {
    const before = w.api.requests.length;
    const r = await w.cli(['login']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'Already signed in as jane. Use --force to switch.');
    assert.deepEqual(w.api.requests.slice(before).map((q) => `${q.method} ${q.path}`), ['GET /me']);
  });

  it('login --force --token switches keys and revokes the old one', async () => {
    w.api.on('GET /me', (req) => (req.headers.authorization === `Bearer ${NEW_TOKEN}` ? { json: ME } : apiError(401, 'unauthorized', 'API token revoked.')));
    w.api.on('POST /auth/revoke', { status: 204 });
    const before = w.api.requests.length;
    const r = await w.cli(['login', '--force', '--token', NEW_TOKEN]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'Signed in as jane.');
    const reqs = w.api.requests.slice(before);
    assert.deepEqual(reqs.map((q) => `${q.method} ${q.path}`), ['GET /me', 'POST /auth/revoke']);
    assert.equal(reqs[0]!.headers.authorization, `Bearer ${NEW_TOKEN}`, 'the new key is checked before it is saved');
    assert.equal(reqs[1]!.headers.authorization, `Bearer ${TOKEN}`, 'the old key revokes itself');
    assert.equal(readJson(credentials(w)).token, NEW_TOKEN);
  });

  it('logout revokes the saved key and deletes it; whoami then exits 3 without calling the API', async () => {
    const before = w.api.requests.length;
    const r = await w.cli(['logout']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'Signed out.');
    const [rev] = w.api.requests.slice(before);
    assert.equal(`${rev!.method} ${rev!.path}`, 'POST /auth/revoke');
    assert.equal(rev!.headers.authorization, `Bearer ${NEW_TOKEN}`);
    assert.equal(fs.existsSync(credentials(w)), false);

    const again = await w.cli(['logout']);
    assert.equal(again.stdout.trim(), 'Not signed in.');
    const who = await w.cli(['whoami']);
    assert.equal(who.code, 3);
    assert.match(who.stderr, /not logged in/);
    assert.equal(w.api.requests.length, before + 1);
  });

  it('a sign-in refused in the browser exits 3 and saves nothing', async () => {
    w.api.on('POST /auth/device', { json: DEVICE_START });
    w.api.on('POST /auth/token', apiError(400, 'access_denied', 'You cancelled the sign-in.'));
    const r = await w.cli(['login']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Sign-in cancelled\./);
    assert.equal(fs.existsSync(credentials(w)), false);
  });
});

describe('account errors', () => {
  let w: World;
  before(async () => (w = await world(TOKEN)));
  after(() => w.dispose());
  beforeEach(() => w.api.reset());

  it('401 unauthorized exits 3', async () => {
    w.api.on('GET /me', apiError(401, 'unauthorized', 'API token revoked.'));
    const r = await w.cli(['whoami']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /error: unauthorized: API token revoked\./);
    assert.equal(w.api.requests.length, 1, 'a 401 is not retried');
  });

  it('403 plan_limit exits 3', async () => {
    w.api.on('GET /usage', apiError(403, 'plan_limit', 'The API is included on Starter and above.'));
    const r = await w.cli(['usage']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /error: plan_limit: The API is included on Starter and above\./);
  });

  it('CHARTNAUT_TOKEN is sent as the bearer key', async () => {
    w.api.on('GET /me', { json: ME });
    const r = await w.cli(['whoami', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ME);
    assert.equal(w.api.requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
  });
});

describe('catalog: instruments, docs, library', () => {
  let w: World;
  before(async () => (w = await world(TOKEN)));
  after(() => w.dispose());
  beforeEach(() => w.api.reset());

  it('instruments sends q, category, limit and cursor and prints coverage', async () => {
    w.api.on('GET /instruments', { json: { data: [ETH], next_cursor: '1' } });
    const r = await w.cli(['instruments', 'eth', '--category', 'crypto', '--limit', '1', '--cursor', '0']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(w.api.requests[0]!.query, { q: 'eth', category: 'crypto', limit: '1', cursor: '0' });
    assert.match(r.stdout, /SHORT\s+SYMBOL\s+NAME\s+CATEGORY\s+ORDER_FLOW\s+COVERAGE/);
    assert.match(r.stdout, /ETH\s+HYPERLIQUID:ETH\s+Ethereum Perpetual \(Hyperliquid\)\s+crypto\s+yes\s+2025-03-22 → 2026-09-26/);
    assert.match(r.stdout, /more: --cursor 1/);

    w.api.on('GET /instruments', { json: { data: [BTC, ETH], next_cursor: null } });
    const all = await w.cli(['instruments', '--json']);
    assert.deepEqual(JSON.parse(all.stdout).data.map((i: any) => i.symbol), ['HYPERLIQUID:BTC', 'HYPERLIQUID:ETH']);
    assert.deepEqual(w.api.requests.at(-1)!.query, {});

    const bad = await w.cli(['instruments', '--category', 'stocks']);
    assert.equal(bad.code, 4, 'an unknown category is refused before any request');
    assert.equal(w.api.requests.length, 2);
  });

  it('docs lists topics and prints one as markdown', async () => {
    w.api.on('GET /docs', { json: DOC_TOPICS });
    w.api.on('GET /docs/bars-and-clocks', { text: DOC_BARS, headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
    const list = await w.cli(['docs']);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /TOPIC\s+DEPTH\s+TITLE/);
    assert.match(list.stdout, /what-chartnaut-guarantees\s+1\s+What Chartnaut guarantees/);
    assert.match(list.stdout, /read one: chartnaut docs <topic>/);
    const one = await w.cli(['docs', 'bars-and-clocks']);
    assert.equal(one.code, 0, one.stderr);
    assert.equal(one.stdout, DOC_BARS, 'the markdown comes through byte for byte');
    const j = await w.cli(['docs', 'bars-and-clocks', '--json']);
    assert.deepEqual(JSON.parse(j.stdout), { topic: 'bars-and-clocks', markdown: DOC_BARS });
    w.api.on('GET /docs/bar-clocks', apiError(404, 'not_found', 'No docs topic bar-clocks. List topics with GET /docs.'));
    const missing = await w.cli(['docs', 'bar-clocks']);
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /error: not_found: No docs topic bar-clocks/);
  });

  it('docs works without a key (no Authorization header)', async () => {
    w.api.on('GET /docs', { json: DOC_TOPICS });
    const r = await w.cli(['docs'], { token: '' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(w.api.requests[0]!.headers.authorization, undefined);
  });

  it('library search and show', async () => {
    w.api.on('GET /library', { json: LIBRARY_PAGE });
    w.api.on('GET /library/jane/orb-breakout@7', { json: LIBRARY_SCRIPT });
    const s = await w.cli(['library', 'search', 'rsi', '--kind', 'indicator', '--scope', 'community', '--author', 'jane', '--sort', 'adoptions', '--interface', '--limit', '2']);
    assert.equal(s.code, 0, s.stderr);
    assert.deepEqual(w.api.requests[0]!.query, { q: 'rsi', kind: 'indicator', scope: 'community', author: 'jane', sort: 'adoptions', include: 'interface', limit: '2' });
    assert.match(s.stdout, /REF\s+KIND\s+VERSION\s+ADOPTIONS\s+AUTHOR\s+NAME/);
    assert.match(s.stdout, /jane\/rsi-divergence\s+indicator\s+4\s+12\s+jane\s+RSI divergence/);
    assert.match(s.stdout, /more: --cursor 2/);

    const show = await w.cli(['library', 'show', 'jane/orb-breakout@7']);
    assert.equal(show.code, 0, show.stderr);
    assert.equal(w.api.requests[1]!.path, '/library/jane/orb-breakout@7');
    assert.match(show.stdout, /jane\/orb-breakout\s+definition\s+v7\s+by jane/);
    assert.match(show.stdout, /range_minutes\s+number\s+30/);
    assert.match(show.stdout, /break_long\s+signal\s+range_high,range_low/);
    assert.match(show.stdout, re(`app: ${LIBRARY_SCRIPT.app_url}`));

    const bad = await w.cli(['library', 'show', 'no-author']);
    assert.equal(bad.code, 4);
    assert.equal(w.api.requests.length, 2);
  });
});

describe('the program itself', () => {
  let w: World;
  before(async () => (w = await world(TOKEN)));
  after(() => w.dispose());
  beforeEach(() => w.api.reset());

  it('--help lists exactly the commands that ship', async () => {
    const r = await w.cli(['--help']);
    assert.equal(r.code, 0, r.stderr);
    const section = r.stdout.split(/^Commands:$/m)[1] ?? '';
    const names = [...section.matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(names, [
      'collect', 'diff', 'docs', 'events', 'help', 'init', 'insights', 'instruments', 'library', 'login', 'logout', 'ls', 'mcp', 'new',
      'open', 'pull', 'push', 'run', 'runs', 'upgrade', 'usage', 'validate', 'versions', 'whoami',
    ]);
    assert.equal(w.api.requests.length, 0);
  });

  it('webhooks is not a command', async () => {
    for (const argv of [['webhooks', 'ls']]) {
      const r = await w.cli(argv);
      assert.equal(r.code, 4, argv.join(' '));
      assert.match(r.stderr, re(`unknown command '${argv[0]}'`));
    }
    assert.equal(w.api.requests.length, 0);
  });

  it('-v prints the version', async () => {
    const r = await w.cli(['-v']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), VERSION);
  });

  it('upgrade --check reads the release manifest; a copy run from source never replaces itself', async () => {
    w.api.on('GET /dl/latest.json', { json: { version: VERSION, assets: {} } });
    const same = await w.cli(['upgrade', '--check']);
    assert.equal(same.code, 0, same.stderr);
    assert.equal(same.stdout.trim(), `chartnaut ${VERSION} is the latest version`);

    w.api.on('GET /dl/latest.json', { json: { version: '99.0.0', assets: { 'linux-x64': { url: `${w.api.origin}/dl/99.0.0/chartnaut-linux-x64`, sha256: '0'.repeat(64) } } } });
    const newer = await w.cli(['upgrade', '--check', '--json']);
    assert.deepEqual(JSON.parse(newer.stdout), { current: VERSION, latest: '99.0.0', update_available: true, install: 'development' });
    const up = await w.cli(['upgrade']);
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /This copy runs from source/);
    assert.deepEqual(w.api.requests.map((q) => q.path), ['/dl/latest.json', '/dl/latest.json', '/dl/latest.json'], 'no binary is downloaded');
  });
});
