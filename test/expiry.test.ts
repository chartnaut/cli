import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness } from './helpers.js';
import { expiryWarning } from '../src/config.js';
import { parseExpires } from '../src/commands/account.js';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const credentials = (home: string) => path.join(home, '.config', 'chartnaut', 'credentials.json');
const saveCreds = (home: string, creds: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(credentials(home)), { recursive: true });
  fs.writeFileSync(credentials(home), JSON.stringify(creds));
};

const deviceStart = {
  device_code: 'dev_secret',
  user_code: 'BCDF-GHJK',
  verification_uri: 'https://terminal.chartnaut.com/morpheus/cli-auth',
  verification_uri_complete: 'https://terminal.chartnaut.com/morpheus/cli-auth?code=BCDF-GHJK',
  expires_in: 600,
  interval: 3,
};
const meWith = (expires_at: string | null) => ({ user: 'Jane', plan: 'pro', token: { name: 'CLI on laptop', scopes: ['scripts:read'], expires_at } });

test('parseExpires takes 7d, 30d, 90d or the bare number and refuses anything else', () => {
  assert.equal(parseExpires('7d'), 7);
  assert.equal(parseExpires('30d'), 30);
  assert.equal(parseExpires('90d'), 90);
  assert.equal(parseExpires('7'), 7);
  assert.equal(parseExpires('30'), 30);
  assert.equal(parseExpires('90'), 90);
  assert.equal(parseExpires('90D'), 90);
  for (const bad of ['1d', '14d', '365d', '0', '-7d', '7w', 'never', '', '90 days', '3.5d']) {
    assert.throws(() => parseExpires(bad), /--expires must be 7d, 30d or 90d/, bad);
  }
});

test('login --expires sends expires_in_days; default is 90', async () => {
  for (const [args, days] of [[[], 90], [['--expires', '7d'], 7], [['--expires', '30'], 30], [['--expires', '90d'], 90]] as const) {
    const h = harness(
      {
        'POST /auth/device': { json: { ...deviceStart, expires_in_days: days } },
        'POST /auth/token': { json: { token: 'cn_live_x', name: 'CLI on laptop', expires_at: iso(Date.now() + days * DAY), expires_in_days: days } },
        'GET /me': { json: meWith(iso(Date.now() + days * DAY)) },
      },
      { env: { CHARTNAUT_TOKEN: '' } },
    );
    assert.equal(await h.run('login', '--no-browser', ...args), 0, h.err());
    const start = h.calls.find((c) => c.url.pathname.endsWith('/auth/device'))!;
    assert.equal(start.body.expires_in_days, days, args.join(' '));
    assert.equal(typeof start.body.client_name, 'string');
  }
});

test('login refuses a bad --expires before any request, and --expires with --token', async () => {
  for (const args of [['--expires', '14d'], ['--expires', '1y'], ['--expires', '0'], ['--token', 'cn_live_x', '--expires', '30d']]) {
    const h = harness({}, { env: { CHARTNAUT_TOKEN: '' } });
    assert.equal(await h.run('login', ...args), 4, args.join(' '));
    assert.match(h.err(), /^error: invalid_request: --expires/m);
    assert.equal(h.calls.length, 0);
  }
});

test('login prints when the new key expires, from the token response (the approval page may shorten it)', async () => {
  const at = Date.now() + 30 * DAY;
  const h = harness(
    {
      'POST /auth/device': { json: { ...deviceStart, expires_in_days: 90 } },
      // Asked for 90, the approver chose 30.
      'POST /auth/token': { json: { token: 'cn_live_x', name: 'CLI on laptop', expires_at: iso(at), expires_in_days: 30 } },
      'GET /me': { json: meWith(iso(at)) },
    },
    { env: { CHARTNAUT_TOKEN: '' } },
  );
  assert.equal(await h.run('login', '--no-browser'), 0, h.err());
  assert.equal(h.out(), `Signed in as Jane. Key expires on ${dateOf(at)} (30 days).`);
  const saved = JSON.parse(fs.readFileSync(credentials(h.home), 'utf8'));
  assert.equal(saved.token, 'cn_live_x');
  assert.equal(saved.expires_at, iso(at), 'the expiry is cached for the warning');
  assert.doesNotMatch(h.out() + h.err(), /cn_live_x/, 'the key is never printed');
});

test('login --token output is unchanged, and caches /me expiry (null = never)', async () => {
  const h = harness({ 'GET /me': { json: meWith(null) } }, { env: { CHARTNAUT_TOKEN: '' } });
  assert.equal(await h.run('login', '--token', 'cn_live_abc'), 0, h.err());
  assert.equal(h.out(), 'Signed in as Jane.');
  assert.equal(JSON.parse(fs.readFileSync(credentials(h.home), 'utf8')).expires_at, null);
});

test('whoami prints the key expiry, or that it never expires, and refreshes the cached value', async () => {
  const at = Date.now() + 80 * DAY;
  const h = harness({ 'GET /me': [{ json: meWith(iso(at)) }, { json: meWith(null) }] }, { env: { CHARTNAUT_TOKEN: '' } });
  saveCreds(h.home, { token: 'cn_live_saved', saved_at: '2026-01-01T00:00:00Z' });
  assert.equal(await h.run('whoami'), 0, h.err());
  assert.match(h.out(), new RegExp(`^key:    CLI on laptop · expires ${dateOf(at)}$`, 'm'));
  assert.equal(JSON.parse(fs.readFileSync(credentials(h.home), 'utf8')).expires_at, iso(at));
  assert.equal(await h.run('whoami'), 0, h.err());
  assert.match(h.out(), /^key:    CLI on laptop · never expires$/m);
  const saved = JSON.parse(fs.readFileSync(credentials(h.home), 'utf8'));
  assert.equal(saved.expires_at, null);
  assert.equal(saved.token, 'cn_live_saved');
});

test('whoami with CHARTNAUT_TOKEN leaves the saved key file alone', async () => {
  const h = harness({ 'GET /me': { json: meWith(iso(Date.now() + 2 * DAY)) } });
  saveCreds(h.home, { token: 'cn_live_saved', expires_at: null });
  assert.equal(await h.run('whoami'), 0, h.err());
  assert.equal(JSON.parse(fs.readFileSync(credentials(h.home), 'utf8')).expires_at, null);
});

test('expiryWarning: within 7 days only; none for never, unknown, far or already past', () => {
  const now = Date.parse('2027-01-01T12:00:00Z');
  assert.equal(expiryWarning('2027-01-08T12:00:00Z', now), 'warning: your Chartnaut key expires on 2027-01-08; run chartnaut login to renew.');
  assert.equal(expiryWarning('2027-01-01T13:00:00Z', now), 'warning: your Chartnaut key expires on 2027-01-01; run chartnaut login to renew.');
  assert.equal(expiryWarning('2027-01-08T12:00:01Z', now), undefined, 'just over 7 days');
  assert.equal(expiryWarning('2027-04-01T00:00:00Z', now), undefined);
  assert.equal(expiryWarning(null, now), undefined);
  assert.equal(expiryWarning(undefined, now), undefined);
  assert.equal(expiryWarning('not a date', now), undefined);
  assert.equal(expiryWarning('2027-01-01T11:59:59Z', now), undefined, 'expired: the server says so');
});

test('every command prints one warning line from the cached expiry, without an extra request', async () => {
  const at = Date.now() + 3 * DAY;
  const h = harness({ 'GET /scripts': { json: { data: [] } }, 'GET /usage': { json: {} } }, { env: { CHARTNAUT_TOKEN: '' } });
  saveCreds(h.home, { token: 'cn_live_saved', expires_at: iso(at) });
  assert.equal(await h.run('ls'), 0, h.err());
  const warnings = h.stderr.filter((l) => l.startsWith('warning:'));
  assert.deepEqual(warnings, [`warning: your Chartnaut key expires on ${dateOf(at)}; run chartnaut login to renew.`]);
  assert.deepEqual(h.calls.map((c) => c.url.pathname), ['/v1/scripts'], 'no request beyond the command');
  assert.equal(await h.run('--json', 'usage'), 0, h.err());
  assert.equal(h.stderr.filter((l) => l.startsWith('warning:')).length, 2);
  assert.doesNotThrow(() => JSON.parse(h.stdout.at(-1)!), 'stdout stays JSON');
});

test('no warning for a far expiry, a key that never expires, CHARTNAUT_TOKEN, logout or no command', async () => {
  for (const expires_at of [iso(Date.now() + 30 * DAY), null, undefined]) {
    const h = harness({ 'GET /scripts': { json: { data: [] } } }, { env: { CHARTNAUT_TOKEN: '' } });
    saveCreds(h.home, { token: 'cn_live_saved', ...(expires_at === undefined ? {} : { expires_at }) });
    assert.equal(await h.run('ls'), 0, h.err());
    assert.doesNotMatch(h.err(), /warning/, String(expires_at));
  }
  const soon = iso(Date.now() + 2 * DAY);
  const env = harness({ 'GET /scripts': { json: { data: [] } } });
  saveCreds(env.home, { token: 'cn_live_saved', expires_at: soon });
  assert.equal(await env.run('ls'), 0);
  assert.doesNotMatch(env.err(), /warning/, 'CHARTNAUT_TOKEN is the key in use');
  const out = harness({ 'POST /auth/revoke': { status: 204 } }, { env: { CHARTNAUT_TOKEN: '' } });
  saveCreds(out.home, { token: 'cn_live_saved', expires_at: soon });
  assert.equal(await out.run('logout'), 0);
  assert.equal(await out.run('--help'), 0);
  assert.doesNotMatch(out.err(), /warning/);
});

test('login with a saved key that expires within days signs in again to renew it', async () => {
  const soon = Date.now() + 2 * DAY;
  const fresh = Date.now() + 90 * DAY;
  const h = harness(
    {
      'GET /me': (call) => ({ json: meWith(iso(call.headers.authorization === 'Bearer cn_live_old' ? soon : fresh)) }),
      'POST /auth/device': { json: deviceStart },
      'POST /auth/token': { json: { token: 'cn_live_new', expires_at: iso(fresh), expires_in_days: 90 } },
      'POST /auth/revoke': { status: 204 },
    },
    { env: { CHARTNAUT_TOKEN: '' } },
  );
  saveCreds(h.home, { token: 'cn_live_old', expires_at: iso(soon) });
  assert.equal(await h.run('login', '--no-browser'), 0, h.err());
  assert.match(h.err(), new RegExp(`Your key expires on ${dateOf(soon)}; signing in again to renew it\\.`));
  assert.doesNotMatch(h.err(), /^warning:/m, 'login itself does not tell you to run login');
  assert.equal(h.out(), `Signed in as Jane. Key expires on ${dateOf(fresh)} (90 days).`);
  assert.equal(h.calls.find((c) => c.url.pathname.endsWith('/auth/revoke'))!.headers.authorization, 'Bearer cn_live_old');
  const saved = JSON.parse(fs.readFileSync(credentials(h.home), 'utf8'));
  assert.equal(saved.token, 'cn_live_new');
  assert.equal(saved.expires_at, iso(fresh));
});

test('an expired key says to run chartnaut login and exits 3', async () => {
  const h = harness({ 'GET /scripts': { status: 401, json: { error: { code: 'unauthorized', message: 'API token expired.' } } } });
  assert.equal(await h.run('ls'), 3);
  assert.equal(h.err(), 'error: unauthorized: your key expired. Run chartnaut login.');
  assert.equal(h.calls.length, 1, 'a 401 is not retried');
  // Other 401s keep the server's message.
  const r = harness({ 'GET /scripts': { status: 401, json: { error: { code: 'unauthorized', message: 'API token revoked.' } } } });
  assert.equal(await r.run('ls'), 3);
  assert.equal(r.err(), 'error: unauthorized: API token revoked.');
});
