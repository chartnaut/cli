import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness } from './helpers.js';

const me = { user: 'Jane', plan: 'pro', token: { name: 'laptop', scopes: ['scripts:read', 'runs:write'], expires_at: null } };

test('login --token validates via /me and stores the token with mode 0600', async () => {
  const h = harness({ 'GET /me': { json: me } }, { env: { CHARTNAUT_TOKEN: '' } });
  assert.equal(await h.run('login', '--token', 'cn_live_abc'), 0, h.err());
  assert.equal(h.calls[0]!.headers.authorization, 'Bearer cn_live_abc');
  const file = path.join(h.home, '.config', 'chartnaut', 'credentials.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'cn_live_abc');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // the stored token is used afterwards
  assert.equal(await h.run('whoami'), 0);
  assert.equal(h.calls[1]!.headers.authorization, 'Bearer cn_live_abc');
  assert.match(h.out(), /plan:\s+pro/);
  // logout deletes it
  assert.equal(await h.run('logout'), 0);
  assert.equal(fs.existsSync(file), false);
});

const deviceStart = {
  device_code: 'dev_secret',
  user_code: 'BCDF-GHJK',
  verification_uri: 'https://terminal.chartnaut.com/morpheus/cli-auth',
  verification_uri_complete: 'https://terminal.chartnaut.com/morpheus/cli-auth?code=BCDF-GHJK',
  expires_in: 600,
  interval: 3,
};
const pending = { status: 400, json: { error: { code: 'authorization_pending', message: 'waiting' } } };

test('login signs in through the browser: shows the code, opens the page, polls until approved', async () => {
  const h = harness(
    {
      'POST /auth/device': { json: deviceStart },
      'POST /auth/token': [pending, pending, { json: { token: 'cn_live_from_browser', name: 'CLI on laptop' } }],
      'GET /me': { json: me },
    },
    { env: { CHARTNAUT_TOKEN: '' } },
  );
  assert.equal(await h.run('login'), 0, h.err());
  assert.match(h.err(), /BCDF-GHJK/);
  assert.match(h.err(), /cli-auth\?code=BCDF-GHJK/);
  assert.deepEqual(h.execs[0], { cmd: 'open', args: ['https://terminal.chartnaut.com/morpheus/cli-auth?code=BCDF-GHJK'] });
  assert.equal(h.calls.filter((c) => c.url.pathname.endsWith('/auth/token')).length, 3);
  assert.equal(h.calls.find((c) => c.url.pathname.endsWith('/auth/device'))!.headers.authorization, undefined, 'starting a sign-in needs no key');
  const file = path.join(h.home, '.config', 'chartnaut', 'credentials.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'cn_live_from_browser');
  assert.match(h.out(), /Signed in as Jane/);
});

test('login opens nothing when the server hands back a link that is not a Chartnaut https link', async () => {
  for (const link of ['https://evil.example/cli-auth?code=X', 'http://terminal.chartnaut.com/cli-auth', 'https://chartnaut.com/x" & calc.exe & "']) {
    const h = harness(
      {
        'POST /auth/device': { json: { ...deviceStart, verification_uri_complete: link } },
        'POST /auth/token': { json: { token: 'cn_live_x' } },
        'GET /me': { json: me },
      },
      { env: { CHARTNAUT_TOKEN: '' } },
    );
    assert.equal(await h.run('login'), 0, h.err());
    if (link.includes('calc')) {
      // quotes and spaces are percent-encoded, so this one is a harmless chartnaut.com link
      assert.deepEqual(h.execs[0]?.args, ['https://chartnaut.com/x%22%20&%20calc.exe%20&%20%22']);
      continue;
    }
    assert.equal(h.execs.length, 0, link);
    assert.match(h.err(), /Go to /);
    assert.match(h.err(), /not opening .* in a browser/);
  }
});

test('login on Windows opens the page through rundll32, not cmd', async () => {
  const h = harness(
    { 'POST /auth/device': { json: deviceStart }, 'POST /auth/token': { json: { token: 'cn_live_x' } }, 'GET /me': { json: me } },
    { env: { CHARTNAUT_TOKEN: '' } },
  );
  h.ctx.platform = 'win32';
  assert.equal(await h.run('login'), 0, h.err());
  assert.deepEqual(h.execs[0], { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', deviceStart.verification_uri_complete] });
});

test('login --no-browser prints the link and opens nothing', async () => {
  const h = harness(
    { 'POST /auth/device': { json: deviceStart }, 'POST /auth/token': { json: { token: 'cn_live_x' } }, 'GET /me': { json: me } },
    { env: { CHARTNAUT_TOKEN: '' } },
  );
  assert.equal(await h.run('login', '--no-browser'), 0, h.err());
  assert.equal(h.execs.length, 0);
  assert.match(h.err(), /cli-auth\?code=BCDF-GHJK/);
});

test('login when already signed in stops; --force signs in again and revokes the old key', async () => {
  const h = harness(
    {
      'POST /auth/device': { json: deviceStart },
      'POST /auth/token': { json: { token: 'cn_live_new' } },
      'GET /me': { json: me },
      'POST /auth/revoke': { status: 204 },
    },
    { env: { CHARTNAUT_TOKEN: '' } },
  );
  assert.equal(await h.run('login', '--token', 'cn_live_old'), 0);
  assert.equal(await h.run('login'), 0);
  assert.match(h.out(), /Already signed in as Jane/);
  assert.equal(h.calls.some((c) => c.url.pathname.endsWith('/auth/device')), false, 'no new sign-in started');
  assert.equal(await h.run('login', '--force'), 0, h.err());
  const revoke = h.calls.find((c) => c.url.pathname.endsWith('/auth/revoke'));
  assert.ok(revoke, 'the old key is revoked');
  assert.equal(revoke!.headers.authorization, 'Bearer cn_live_old');
  const file = path.join(h.home, '.config', 'chartnaut', 'credentials.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'cn_live_new');
});

test('a saved key that no longer works does not block login', async () => {
  let n = 0;
  const h = harness(
    {
      'GET /me': (call) => (call.headers.authorization === 'Bearer cn_live_dead' ? { status: 401, json: { error: { code: 'unauthorized', message: 'revoked' } } } : { json: me }),
      'POST /auth/device': { json: deviceStart },
      'POST /auth/token': () => ({ json: { token: `cn_live_fresh${n++}` } }),
    },
    { env: { CHARTNAUT_TOKEN: '' } },
  );
  const dir = path.join(h.home, '.config', 'chartnaut');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: 'cn_live_dead' }));
  assert.equal(await h.run('login', '--no-browser'), 0, h.err());
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')).token, 'cn_live_fresh0');
});

test('a denied sign-in exits 3 and saves nothing', async () => {
  const h = harness(
    { 'POST /auth/device': { json: deviceStart }, 'POST /auth/token': { status: 400, json: { error: { code: 'access_denied', message: 'denied' } } } },
    { env: { CHARTNAUT_TOKEN: '' } },
  );
  assert.equal(await h.run('login', '--no-browser'), 3);
  assert.match(h.err(), /cancelled/);
  assert.equal(fs.existsSync(path.join(h.home, '.config', 'chartnaut', 'credentials.json')), false);
});

test('logout revokes the key on the server, then deletes it', async () => {
  const h = harness({ 'GET /me': { json: me }, 'POST /auth/revoke': { status: 204 } }, { env: { CHARTNAUT_TOKEN: '' } });
  assert.equal(await h.run('login', '--token', 'cn_live_abc'), 0);
  assert.equal(await h.run('logout'), 0);
  const revoke = h.calls.find((c) => c.url.pathname.endsWith('/auth/revoke'));
  assert.equal(revoke!.headers.authorization, 'Bearer cn_live_abc');
  assert.match(h.out(), /^Signed out\.$/m);
});

test('login with a bad token exits 3 and stores nothing', async () => {
  const h = harness({ 'GET /me': { status: 401, json: { error: { code: 'unauthorized', message: 'bad token', request_id: 'req_1' } } } }, { env: { CHARTNAUT_TOKEN: '' } });
  assert.equal(await h.run('login', '--token', 'nope'), 3);
  assert.match(h.err(), /^error: unauthorized: bad token$/m);
  assert.match(h.err(), /request_id: req_1/);
  assert.equal(fs.existsSync(path.join(h.home, '.config', 'chartnaut', 'credentials.json')), false);
});

test('CHARTNAUT_TOKEN wins over the credentials file; --json prints raw', async () => {
  const h = harness({ 'GET /me': { json: me } });
  assert.equal(await h.run('whoami', '--json'), 0);
  assert.equal(h.calls[0]!.headers.authorization, 'Bearer cn_test_token');
  assert.deepEqual(JSON.parse(h.stdout[0]!), me);
});

test('plan_limit exits 3, not_found exits 4, json errors go to stdout', async () => {
  const h = harness({
    'GET /usage': { status: 402, json: { error: { code: 'plan_limit', message: 'upgrade' } } },
    'GET /library/jane/orb': { status: 404, json: { error: { code: 'not_found', message: 'nope' } } },
  });
  assert.equal(await h.run('usage'), 3);
  assert.equal(await h.run('library', 'show', 'jane/orb', '--json'), 4);
  assert.equal(JSON.parse(h.stdout.at(-1)!).error.code, 'not_found');
  assert.equal(await h.run('library', 'show', 'no-author'), 4);
});

test('docs, instruments, library search, usage requests', async () => {
  const h = harness({
    'GET /docs': { json: { data: [{ topic: 'indicators/outputs', title: 'Outputs', depth: 1 }] } },
    'GET /docs/indicators/outputs': { text: '# Outputs\n\nText.' },
    'GET /instruments': { json: { data: [{ short: 'ETH', symbol: 'HYPERLIQUID:ETH', name: 'Ethereum Perpetual (Hyperliquid)', category: 'crypto', order_flow: true, coverage: { start: '2025-03-22T10:50:00Z', end: '2026-09-25T00:00:00Z' } }] } },
    'GET /library': { json: { data: [{ ref: 'jane/orb', kind: 'definition', latest_version: 7, adoptions: 12, name: 'ORB' }] } },
    'GET /usage': { json: { compute_units: { used: 12.5, included: 1000 }, caps: { definitions: { used: 3, limit: 50 }, indicators: { used: 1, limit: null } } } },
  });
  assert.equal(await h.run('docs'), 0);
  assert.match(h.out(), /TOPIC\s+DEPTH\s+TITLE/);
  assert.match(h.out(), /indicators\/outputs\s+1\s+Outputs/);
  assert.doesNotMatch(h.out(), /\s-\s/);
  assert.equal(await h.run('docs', 'indicators/outputs'), 0);
  assert.equal(h.stdout.at(-1), '# Outputs\n\nText.');
  assert.equal(await h.run('instruments', 'ethereum', '--category', 'crypto'), 0);
  const ic = h.calls.at(-1)!;
  assert.equal(ic.url.searchParams.get('q'), 'ethereum');
  assert.equal(ic.url.searchParams.get('category'), 'crypto');
  assert.match(h.out(), /ETH\s+HYPERLIQUID:ETH\s+Ethereum Perpetual \(Hyperliquid\)\s+crypto\s+yes\s+2025-03-22 → 2026-09-25/);
  assert.equal(await h.run('library', 'search', 'orb', '--kind', 'definition'), 0);
  assert.equal(h.calls.at(-1)!.url.searchParams.get('kind'), 'definition');
  assert.match(h.out(), /jane\/orb\s+definition\s+7\s+12/);
  assert.equal(await h.run('library', 'search', '--scope', 'installed', '--author', 'jane', '--sort', 'adoptions'), 0);
  const lc = h.calls.at(-1)!.url.searchParams;
  assert.deepEqual([lc.get('scope'), lc.get('author'), lc.get('sort')], ['installed', 'jane', 'adoptions']);
  assert.equal(await h.run('library', 'search', 'rsi', '--interface', '--json'), 0);
  assert.equal(h.calls.at(-1)!.url.searchParams.get('include'), 'interface');
  assert.equal(await h.run('usage'), 0);
  assert.match(h.out(), /indicators\s+1\s+unlimited/);
});

test('mcp and webhooks are not commands (no backend serves them yet)', async () => {
  const h = harness();
  for (const argv of [['mcp', 'install'], ['webhooks', 'ls'], ['webhooks', 'add', 'https://example.com/hook']]) {
    assert.equal(await h.run(...argv), 4, argv.join(' '));
    assert.match(h.err(), new RegExp(`unknown command '${argv[0]}'`));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(await h.run('--help'), 0);
  assert.doesNotMatch(h.out(), /\bmcp\b|webhooks/);
});
