import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiError, world, writeFiles, type World } from './harness.js';
import { DOC_TOPICS, ME, TOKEN, pending } from './fixtures.js';

/**
 * How API failures come out of the CLI: exit 3 for auth / scope / plan, 4 for not found and bad
 * requests, 5 for anything worth retrying, 1 for invalid scripts. Busy answers carry
 * `Retry-After: 0` so the client's retries cost no time here.
 */
describe('error mapping and retries', () => {
  let w: World;
  before(async () => (w = await world(TOKEN)));
  after(() => w.dispose());
  beforeEach(() => w.api.reset());

  const busy = (code = 'busy') => apiError(429, code, 'Your plan allows 3 validate, save, collect or run request(s) at once. Retry when one finishes.', {}, { 'Retry-After': '0' });

  it('404 not_found exits 4; --json prints the error envelope', async () => {
    w.api.on('GET /runs/run_nope', apiError(404, 'not_found', 'No run run_nope.'));
    const r = await w.cli(['runs', 'get', 'run_nope']);
    assert.equal(r.code, 4);
    assert.equal(r.stderr.trim(), 'error: not_found: No run run_nope.');
    const j = await w.cli(['--json', 'runs', 'get', 'run_nope']);
    assert.equal(j.code, 4);
    assert.deepEqual(JSON.parse(j.stdout), { error: { code: 'not_found', message: 'No run run_nope.' } });
  });

  it('401 exits 3, 403 forbidden_scope exits 3, 403 plan_limit exits 3', async () => {
    w.api.on('GET /scripts', apiError(401, 'unauthorized', 'API token expired.'));
    assert.equal((await w.cli(['ls'])).code, 3);
    w.api.on('POST /runs/run_1/cancel', apiError(403, 'forbidden_scope', 'This key lacks runs:write.'));
    const scope = await w.cli(['runs', 'cancel', 'run_1']);
    assert.equal(scope.code, 3);
    assert.match(scope.stderr, /error: forbidden_scope: This key lacks runs:write\./);
    w.api.on('POST /runs', apiError(403, 'plan_limit', 'The API is included on Starter and above.'));
    assert.equal((await w.cli(['run', 'my-ema', '--on', 'BTC', '--tf', '5m', '--last', '7d'])).code, 3);
  });

  it('429 busy with Retry-After is retried and then succeeds', async () => {
    w.api.on('GET /me', [busy(), busy('rate_limited'), { json: ME }]);
    const r = await w.cli(['whoami']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(w.api.calls('GET /me').length, 3);
    assert.ok(r.ms < 10_000, `took ${r.ms} ms`);
  });

  it('429 that never clears exits 5 after the retry budget', async () => {
    w.api.on('GET /me', busy('rate_limited'));
    const r = await w.cli(['whoami']);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /error: rate_limited:/);
    assert.equal(w.api.calls('GET /me').length, 4, 'one try and three retries');
  });

  it('a busy POST /runs is retried with the same Idempotency-Key', async () => {
    w.api.on('POST /runs', [busy(), busy(), { status: 202, json: pending({ id: 'run_after_busy' }) }]);
    const r = await w.cli(['run', 'my-ema', '--on', 'BTC', '--tf', '5m', '--last', '7d', '--no-wait']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'run_after_busy  queued');
    const posts = w.api.calls('POST /runs');
    assert.equal(posts.length, 3);
    assert.ok(posts[0]!.headers['idempotency-key']);
    assert.ok(posts.every((p) => p.headers['idempotency-key'] === posts[0]!.headers['idempotency-key']));
  });

  it('503 busy is retried; when it persists the CLI exits 5', async () => {
    w.api.on('GET /docs', [apiError(503, 'busy', 'Docs are unavailable right now. Retry shortly.', {}, { 'Retry-After': '0' }), { json: DOC_TOPICS }]);
    assert.equal((await w.cli(['docs'])).code, 0);
    w.api.reset();
    w.api.on('GET /docs', apiError(503, 'busy', 'Docs are unavailable right now. Retry shortly.', {}, { 'Retry-After': '0' }));
    const r = await w.cli(['docs']);
    assert.equal(r.code, 5);
    assert.equal(w.api.calls('GET /docs').length, 4);
  });

  it('500 internal exits 5 without a retry; a 502 that is not JSON exits 5 too', async () => {
    w.api.on('GET /usage', apiError(500, 'internal', 'Internal error. Retry; if it persists contact help@chartnaut.com.'));
    const r = await w.cli(['usage']);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /error: internal: Internal error\./);
    assert.equal(w.api.requests.length, 1);

    w.api.on('GET /me', { status: 502, text: '<html>Bad gateway</html>', headers: { 'Content-Type': 'text/html' } });
    const gw = await w.cli(['whoami']);
    assert.equal(gw.code, 5);
    assert.match(gw.stderr, /error: internal: HTTP 502: <html>Bad gateway<\/html>/);
  });

  it('400 refusals exit 4 (unknown_instrument, out_of_coverage)', async () => {
    w.api.on('POST /runs', apiError(400, 'unknown_instrument', 'no instrument "BTCUSDT"; search with GET /instruments?q='));
    const r = await w.cli(['run', 'my-ema', '--on', 'BTCUSDT', '--tf', '5m', '--last', '7d']);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /error: unknown_instrument: no instrument "BTCUSDT"/);
    w.api.on('POST /runs', apiError(400, 'out_of_coverage', 'The window ends before your plan\'s history begins.'));
    assert.equal((await w.cli(['run', 'my-ema', '--on', 'BTC', '--tf', '5m', '--from', '2001-01-01', '--to', '2001-02-01'])).code, 4);
  });

  it('422 script_invalid exits 1 and prints the diagnostics', async () => {
    writeFiles(w.cwd, {
      'definitions/bad-def/script.json': JSON.stringify({ kind: 'definition', slug: 'bad-def', name: 'Bad', entry: 'main.ts' }),
      'definitions/bad-def/main.ts': 'emit(rangeHigh);\n',
    });
    w.api.on('POST /scripts', {
      status: 422,
      json: {
        error: { code: 'script_invalid', message: "The script has 1 error(s). Nothing was saved or run. First: Cannot find name 'rangeHigh'" },
        diagnostics: [{ severity: 'error', code: 'lint', message: "Cannot find name 'rangeHigh'", path: 'main.ts', line: 1 }],
      },
    });
    const r = await w.cli(['push', 'definitions/bad-def']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /error: script_invalid: The script has 1 error\(s\)/);
    assert.match(r.stderr, /main\.ts:1: error: Cannot find name 'rangeHigh' \[lint\]/);
  });
});
