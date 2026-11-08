import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const insight = {
  id: 'ins_61', name: 'Median move by direction', description: '', definition: 'divergence', study: 'divergence-forward-returns',
  study_version: 4, instrument: 'BTC', timeframe: '1h', profile: 'Default', window: { from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
  scope_dimensions: ['direction'], app_url: 'https://terminal.chartnaut.com/morpheus/studies/1/runs/2', created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z',
};
const card = { heading: 'After this event', lines: [], groups: [{ heading: 'Direction: bear', lines: [{ label: 'Median move', value: '-15.0 bp', sample: 'n=123' }] }] };

test('insights lists with filters', async () => {
  const h = harness({ 'GET /insights': { json: { data: [insight], next_cursor: '50' } } });
  assert.equal(await h.run('insights', '--definition', 'divergence', '--on', 'BTC', '--tf', '1h'), 0, h.err());
  const q = h.calls[0]!.url.searchParams;
  assert.equal(q.get('definition'), 'divergence');
  assert.equal(q.get('instrument'), 'BTC');
  assert.equal(q.get('timeframe'), '1h');
  assert.match(h.out(), /ins_61/);
  assert.match(h.out(), /more: --cursor 50/);
});

test('insights create --dry-run sends dry_run and prints the preview card', async () => {
  const h = harness({ 'POST /insights': { json: { dry_run: true, definition: 'divergence', scope_dimensions: ['direction'], preview: { card } } } });
  assert.equal(await h.run('insights', 'create', 'srun_665', '--name', 'Median move', '--dry-run'), 0, h.err());
  assert.deepEqual(h.calls[0]!.body, { run: 'srun_665', name: 'Median move', dry_run: true });
  assert.match(h.out(), /dry run: ok, nothing saved/);
  assert.match(h.out(), /Median move: -15\.0 bp {2}\(n=123\)/);
  assert.match(h.out(), /save it: chartnaut insights create srun_665 --name "Median move"/);
});

test('insights create --no-replace and --definition reach the body', async () => {
  const h = harness({ 'POST /insights': { status: 201, json: { ...insight, preview: { card } } } });
  assert.equal(await h.run('insights', 'create', 'run_1', '--name', 'X', '--definition', 'divergence', '--no-replace'), 0, h.err());
  assert.deepEqual(h.calls[0]!.body, { run: 'run_1', name: 'X', definition: 'divergence', replace: false });
  assert.match(h.out(), /breakdown: direction/);
});

test('a refused study prints the fix and the docs link', async () => {
  const h = harness({
    'POST /insights': {
      status: 422,
      json: { error: { code: 'script_invalid', message: 'This study version does not declare pin_cell.', details: { fix: 'results.declare({ id: "pin_cell" })', docs_url: 'https://docs.chartnaut.com/scripting/chart-pins-overview/' } } },
    },
  });
  assert.notEqual(await h.run('insights', 'create', 'run_1', '--name', 'X'), 0);
  assert.match(h.err(), /^error: script_invalid: This study version does not declare pin_cell\.$/m);
  assert.match(h.err(), /^fix: results\.declare/m);
  assert.match(h.err(), /^docs: https:\/\/docs\.chartnaut\.com\/scripting\/chart-pins-overview\/$/m);
});

test('insights show, update and rm', async () => {
  const h = harness({
    'GET /insights/ins_61': { json: insight },
    'PATCH /insights/ins_61': { json: { ...insight, name: 'New' } },
    'DELETE /insights/ins_61': { status: 204 },
  });
  assert.equal(await h.run('insights', 'show', 'ins_61'), 0, h.err());
  assert.equal(await h.run('insights', 'update', 'ins_61', '--name', 'New'), 0, h.err());
  assert.deepEqual(h.calls[1]!.body, { name: 'New' });
  assert.equal(await h.run('insights', 'rm', 'ins_61'), 0, h.err());
  assert.equal(h.calls[2]!.method, 'DELETE');
  assert.match(h.out(), /removed ins_61/);
});

test('a malformed insight id is a usage error and makes no request', async () => {
  const h = harness();
  assert.notEqual(await h.run('insights', 'rm', '61'), 0);
  assert.equal(h.calls.length, 0);
  assert.match(h.err(), /ins_123/);
});

test('insights list shows whether each one is active', async () => {
  const h = harness({ 'GET /insights': { json: { data: [{ ...insight, active: true, active_state: 'paused' }, { ...insight, id: 'ins_62', active: false }] } } });
  assert.equal(await h.run('insights'), 0, h.err());
  assert.match(h.out(), /ACTIVE/);
  assert.match(h.out(), /ins_61.*paused/);
  assert.match(h.out(), /ins_62.*-\s*$/m);
});

test('insights show prints active state and valid_from', async () => {
  const h = harness({ 'GET /insights/ins_61': { json: { ...insight, active: true, active_state: 'live', valid_from: '2026-01-01T01:00:00Z' } } });
  assert.equal(await h.run('insights', 'show', 'ins_61'), 0, h.err());
  assert.match(h.out(), /on your charts: yes/);
  assert.match(h.out(), /out of sample from:/);
});

test('insights create prints the saved-to-library message and sends --replaces', async () => {
  const h = harness({ 'POST /insights': { status: 201, json: { ...insight, message: 'Saved to your library. To see it, make it active on a BTC 1h chart.' } } });
  assert.equal(await h.run('insights', 'create', 'run_1', '--name', 'X', '--replaces', 'ins_61'), 0, h.err());
  assert.deepEqual(h.calls[0]!.body, { run: 'run_1', name: 'X', replaces: 'ins_61' });
  assert.match(h.out(), /make it active on a BTC 1h chart/);
});

test('insights activate and deactivate', async () => {
  const h = harness({
    'POST /insights/ins_61/activate': { json: { insight: 'ins_61', active: true, state: 'live', replaced: ['ins_40'], in_use: 2, limit: 3 } },
    'POST /insights/ins_61/deactivate': { json: { insight: 'ins_61', active: false, in_use: 1, limit: 'unlimited' } },
  });
  assert.equal(await h.run('insights', 'activate', 'ins_61'), 0, h.err());
  assert.equal(h.calls[0]!.method, 'POST');
  assert.match(h.out(), /active: ins_61 · 2 of 3 in use/);
  assert.match(h.out(), /replaced: ins_40/);
  assert.equal(await h.run('insights', 'deactivate', 'ins_61'), 0, h.err());
  assert.match(h.out(), /not active: ins_61 · 1 in use \(unlimited\)/);
});

test('insights activate on full charts is a plan refusal naming the active ones', async () => {
  const h = harness({
    'POST /insights/ins_61/activate': {
      status: 403,
      json: { error: { code: 'plan_limit', message: 'Your charts are full (1 of 1): ORB on NAS100 15m. Stop showing it, or upgrade for more.', details: { limit: 1, active: [{ insight: 'ins_40' }] } } },
    },
  });
  assert.notEqual(await h.run('insights', 'activate', 'ins_61'), 0);
  assert.match(h.err(), /Your charts are full \(1 of 1\): ORB on NAS100 15m/);
});

test('a malformed id to activate or --replaces is a usage error and makes no request', async () => {
  const h = harness();
  assert.notEqual(await h.run('insights', 'activate', '61'), 0);
  assert.notEqual(await h.run('insights', 'create', 'run_1', '--name', 'X', '--replaces', 'nope'), 0);
  assert.equal(h.calls.length, 0);
});
