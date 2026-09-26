import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apiError, readJson, world, writeFiles, type Recorded, type World } from './harness.js';
import { EVENTS_CSV_HEADER, TOKEN, definitionRun, event, eventsCsv, pending, run, studyRun } from './fixtures.js';

const EMA = 'meta({ shortName: "EMA", kind: "overlay" });\nexport function onBar(ctx) {\n  return { ema: ctx.close };\n}\n';

describe('run', () => {
  let w: World;
  before(async () => {
    w = await world(TOKEN);
    writeFiles(w.cwd, {
      'chartnaut.json': JSON.stringify({ defaults: { instrument: 'BTC', timeframe: '5m', window: '90d' } }),
      'indicators/my-ema/script.json': JSON.stringify({ kind: 'indicator', slug: 'my-ema', name: 'My EMA', entry: 'main.ts', version: 3 }),
      'indicators/my-ema/main.ts': EMA,
    });
  });
  after(() => w.dispose());
  beforeEach(() => w.api.reset());

  it('a local folder runs inline with --set and --label, created with wait 0 and polled with GET ?wait=30', async () => {
    w.api.on('POST /runs', { status: 202, json: pending({ id: 'run_inline', script: 'my-ema' }) });
    w.api.on('GET /runs/run_inline', { json: run({ id: 'run_inline', script: 'my-ema' }) });
    const r = await w.cli(['run', 'indicators/my-ema', '--last', '30d', '--set', 'length=50', '--set', 'source=hl2', '--set', 'show=true', '--label', 'length sweep']);
    assert.equal(r.code, 0, r.stderr);
    const [create, poll] = w.api.requests;
    assert.equal(`${create!.method} ${create!.path}`, 'POST /runs');
    assert.deepEqual(create!.body, {
      source: { kind: 'indicator', files: [{ path: 'main.ts', code: EMA, entry: true }] },
      instrument: 'BTC',
      timeframe: '5m',
      window: { last: '30d' },
      settings: { length: 50, source: 'hl2', show: true },
      label: 'length sweep',
      wait: 0,
    });
    assert.match(String(create!.headers['idempotency-key']), /^[0-9a-f-]{36}$/);
    assert.equal(`${poll!.method} ${poll!.path}`, 'GET /runs/run_inline');
    assert.deepEqual(poll!.query, { wait: '30' });
    assert.match(r.stdout, /^run run_inline {2}succeeded {2}indicator {2}my-ema {2}HYPERLIQUID:BTC {2}5m {2}2026-08-27 09:25 → 2026-09-26 09:25$/m);
    assert.match(r.stdout, /bars: 8640/);
    assert.match(r.stdout, /ema\s+109412\.50\s+101877\.25\s+112730\.80\s+8640/);
    assert.match(r.stdout, /usage: 8640 bars, 8\.64 CU/);
  });

  it('a saved ref runs by name; --no-wait prints the id and never polls', async () => {
    w.api.on('POST /runs', { status: 202, json: pending({ id: 'run_ref', instrument: 'HYPERLIQUID:ETH', timeframe: '1h' }) });
    const r = await w.cli(['run', 'my-ema@3', '--on', 'ETH', '--tf', '1h', '--bars', '500', '--no-wait']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'run_ref  queued');
    assert.deepEqual(w.api.requests.map((q) => `${q.method} ${q.path}`), ['POST /runs']);
    assert.deepEqual(w.api.requests[0]!.body, { script: 'my-ema@3', instrument: 'ETH', timeframe: '1h', window: { bars: 500 }, wait: 0 });

    const range = await w.cli(['run', 'chartnaut/rsi', '--from', '2026-01-01', '--to', '2026-02-01', '--no-wait', '--json']);
    assert.equal(range.code, 0, range.stderr);
    assert.equal(JSON.parse(range.stdout).id, 'run_ref');
    assert.deepEqual(w.api.requests[1]!.body, {
      script: 'chartnaut/rsi', instrument: 'BTC', timeframe: '5m', window: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' }, wait: 0,
    });
  });

  it('a failed run exits 2 and prints the failure and the console', async () => {
    w.api.on('POST /runs', {
      json: run({
        id: 'run_bad',
        status: 'failed',
        summary: null,
        failure: { kind: 'script', message: 'ReferenceError: rangeHigh is not defined', retryable: false },
        console: [{ level: 'error', message: 'boom at bar 12' }],
      }),
    });
    const r = await w.cli(['run', 'my-ema', '--last', '7d']);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /failed: script: ReferenceError: rangeHigh is not defined/);
    assert.match(r.stdout, /\[error\] boom at bar 12/);
    assert.equal(w.api.requests.length, 1, 'a finished run is not polled');
  });

  it('--on fans out one run per instrument, compares them, and exits with the worst outcome', async () => {
    const posted: Recorded[] = [];
    w.api.on('POST /runs', (req) => {
      posted.push(req);
      return { status: 202, json: pending({ id: `run_${req.body.instrument}`, instrument: `HYPERLIQUID:${req.body.instrument}` }) };
    });
    w.api.on('GET /runs/run_BTC', [{ status: 202, json: pending({ id: 'run_BTC', status: 'running', progress: { pct: 40, phase: 'running' } }) }, { json: run({ id: 'run_BTC' }) }]);
    w.api.on('GET /runs/run_ETH', {
      json: run({ id: 'run_ETH', instrument: 'HYPERLIQUID:ETH', status: 'failed', summary: null, failure: { kind: 'script', message: 'division by zero', retryable: false } }),
    });
    const r = await w.cli(['run', 'my-ema@3', '--on', 'BTC,ETH', '--last', '30d']);
    assert.equal(r.code, 2, r.stderr);
    assert.equal(posted.length, 2);
    assert.ok(posted.every((p) => p.body.wait === 0), 'no create holds a wait');
    assert.notEqual(posted[0]!.headers['idempotency-key'], posted[1]!.headers['idempotency-key']);
    const polls = w.api.requests.filter((q) => q.method === 'GET');
    assert.deepEqual(polls.map((q) => q.path).sort(), ['/runs/run_BTC', '/runs/run_BTC', '/runs/run_ETH']);
    assert.ok(polls.every((q) => q.query.wait === '30'));
    assert.match(r.stdout, /INSTRUMENT\s+STATUS\s+BARS\s+EMA\.LAST\s+RUN \/ ERROR/);
    assert.match(r.stdout, /BTC\s+succeeded\s+8640\s+109412\.50\s+run_BTC/);
    assert.match(r.stdout, /ETH\s+failed\s+-\s+-\s+script: division by zero/);
  });

  it('--out file.csv pages the CSV and joins the pages under one header', async () => {
    w.api.on('POST /runs', { json: definitionRun({ id: 'run_def' }) });
    w.api.on('GET /runs/run_def/results', (req) => ({ text: req.query.cursor === '5000' ? eventsCsv(5000, 2) : eventsCsv(0, 5000), headers: { 'Content-Type': 'text/csv' } }));
    const r = await w.cli(['run', 'bull-bar', '--on', 'BTC', '--last', '30d', '--out', 'out/events.csv']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`wrote ${path.join('out', 'events.csv').replace(/\\/g, '\\\\')}`));
    const pages = w.api.calls('GET /runs/run_def/results');
    assert.deepEqual(pages.map((p) => p.query), [{ format: 'csv' }, { format: 'csv', cursor: '5000' }]);
    const lines = fs.readFileSync(path.join(w.cwd, 'out', 'events.csv'), 'utf8').trimEnd().split('\n');
    assert.equal(lines[0], EVENTS_CSV_HEADER);
    assert.equal(lines.length, 1 + 5002);
    assert.equal(lines.filter((l) => l === EVENTS_CSV_HEADER).length, 1);
    assert.match(lines.at(-1)!, /^bull_bar,long,HYPERLIQUID:BTC,5m,.*,5001,"{""range"":1}"$/);
  });

  it('--out file.json follows next_cursor and merges every page (and --json keeps stdout for the run)', async () => {
    w.api.on('POST /runs', { json: run({ id: 'run_ind' }) });
    w.api.on('GET /runs/run_ind/results', (req) =>
      req.query.cursor === '3'
        ? { json: { kind: 'indicator', run_id: 'run_ind', outputs: [{ id: 'ema', kind: 'line', points: [{ t: 1756287600, v: 110180.5 }, { t: 1756287900, v: null }] }], next_cursor: null } }
        : {
            json: {
              kind: 'indicator',
              run_id: 'run_ind',
              outputs: [{ id: 'ema', kind: 'line', points: [{ t: 1756286700, v: 110204.75 }, { t: 1756287000, v: 110198.31 }, { t: 1756287300, v: 110187.02 }] }],
              next_cursor: '3',
            },
          },
    );
    const r = await w.cli(['run', 'my-ema', '--last', '1d', '--out', 'r.json', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).id, 'run_ind');
    assert.match(r.stderr, /wrote r\.json/);
    assert.deepEqual(w.api.calls('GET /runs/run_ind/results').map((p) => p.query), [{ format: 'json' }, { format: 'json', cursor: '3' }]);
    const out = readJson(path.join(w.cwd, 'r.json'));
    assert.equal(out.next_cursor, null);
    assert.deepEqual(out.outputs[0].points.map((p: any) => p.t), [1756286700, 1756287000, 1756287300, 1756287600, 1756287900]);
  });

  it('bad flags exit 4 before any request', async () => {
    for (const argv of [
      ['run', 'my-ema', '--tf', '3m', '--last', '7d'],
      ['run', 'my-ema', '--last', '7d', '--bars', '9'],
      ['run', 'my-ema', '--last', '30x'],
      ['run', 'my-ema', '--last', '7d', '--set', 'novalue'],
      ['run', 'my-ema', '--last', '7d', '--out', 'r.txt'],
    ]) {
      assert.equal((await w.cli(argv)).code, 4, argv.join(' '));
    }
    assert.equal(w.api.requests.length, 0);
  });
});

describe('runs: ls, get, results, cancel', () => {
  let w: World;
  before(async () => (w = await world(TOKEN)));
  after(() => w.dispose());
  beforeEach(() => w.api.reset());

  it('runs lists with filters and a cursor', async () => {
    w.api.on('GET /runs', {
      json: { data: [definitionRun({ instrument: 'HYPERLIQUID:ETH', timeframe: '1m', status: 'failed', created_at: '2026-09-25T18:40:12.581330Z' })], next_cursor: '1' },
    });
    const r = await w.cli(['runs', '--script', 'bull-bar', '--source', 'all', '--status', 'failed', '--limit', '1']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(w.api.requests[0]!.query, { script: 'bull-bar', source: 'all', status: 'failed', limit: '1' });
    assert.match(r.stdout, /ID\s+KIND\s+SCRIPT\s+INSTRUMENT\s+TF\s+STATUS\s+CREATED/);
    assert.match(r.stdout, /run_p3n8c5v0r6ydj2fe\s+definition\s+bull-bar@4\s+HYPERLIQUID:ETH\s+1m\s+failed\s+2026-09-25 18:40/);
    assert.match(r.stdout, /more: --cursor 1/);
    assert.equal((await w.cli(['runs', '--status', 'lost'])).code, 4);
  });

  it('runs get: exit code follows the run; --watch polls until it finishes', async () => {
    w.api.on('GET /runs/run_ok', { json: run({ id: 'run_ok' }) });
    w.api.on('GET /runs/run_timeout', { json: definitionRun({ id: 'run_timeout', status: 'failed', summary: null, failure: { kind: 'timeout', message: 'context deadline exceeded', retryable: true } }) });
    w.api.on('GET /runs/run_watch', [
      { status: 202, json: pending({ id: 'run_watch', status: 'running', progress: { pct: 40, phase: 'running' } }) },
      { json: run({ id: 'run_watch' }) },
    ]);
    const ok = await w.cli(['runs', 'get', 'run_ok']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(w.api.requests[0]!.query, {});
    const t = await w.cli(['runs', 'get', 'run_timeout']);
    assert.equal(t.code, 5, 'a retryable failure exits 5');
    assert.match(t.stdout, /failed: timeout: context deadline exceeded \(retryable\)/);
    const watch = await w.cli(['runs', 'get', 'run_watch', '--watch']);
    assert.equal(watch.code, 0, watch.stderr);
    assert.match(watch.stderr, /run_watch {2}running {2}40% running/);
    assert.deepEqual(w.api.calls('GET /runs/run_watch').map((q) => q.query), [{}, { wait: '30' }]);
  });

  it('runs results: study blocks, --keys, --full, and one block as CSV', async () => {
    const blocks = {
      kind: 'study',
      run_id: 'run_s9d2k4m6p8q0r1t3',
      results: [
        { key: 'win_rate', kind: 'metric', title: 'Win rate', data: { value: 0.55 } },
        { key: 'trades', kind: 'table', title: 'Trades', data: [{ pnl: 1.5, side: 'long' }, { pnl: -0.5, side: 'short' }], size: 2 },
        { key: 'equity', kind: 'series', title: 'Equity', omitted: true, size: 120 },
      ],
      truncated: false,
    };
    w.api.on('GET /runs/run_s9d2k4m6p8q0r1t3/results', (req) =>
      req.query.format === 'csv' ? { text: 'pnl,side\n1.5,long\n-0.5,short\n', headers: { 'Content-Type': 'text/csv' } } : { json: blocks },
    );
    const r = await w.cli(['runs', 'results', 'run_s9d2k4m6p8q0r1t3', '--keys', 'trades']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(w.api.requests[0]!.query, { keys: 'trades', format: 'json' });
    assert.match(r.stdout, /\[metric\] win_rate · Win rate: 0\.55/);
    assert.match(r.stdout, /\[table\] trades · Trades\nPNL\s+SIDE\n1\.5\s+long\n-0\.5\s+short/);
    assert.match(r.stdout, /\[series\] equity · Equity: 120 rows omitted \(fetch with --keys equity\)/);

    await w.cli(['runs', 'results', 'run_s9d2k4m6p8q0r1t3', '--full', '--json']);
    assert.deepEqual(w.api.requests[1]!.query, { full: 'true', format: 'json' });

    const csv = await w.cli(['runs', 'results', 'run_s9d2k4m6p8q0r1t3', '--keys', 'trades', '--format', 'csv', '--all']);
    assert.equal(csv.code, 0, csv.stderr);
    assert.equal(csv.stdout, 'pnl,side\n1.5,long\n-0.5,short\n');
    assert.deepEqual(w.api.requests.slice(2).map((q) => q.query), [{ keys: 'trades', format: 'csv' }], 'a study block is fetched once, never paged');
  });

  it('runs results --format csv --all pages an indicator by offset and merges rows by time', async () => {
    const rows = ['2026-09-01T00:00:00Z,1', '2026-09-01T00:05:00Z,2', '2026-09-01T00:10:00Z,3', '2026-09-01T00:15:00Z,4', '2026-09-01T00:20:00Z,5'];
    w.api.on('GET /runs/run_ind/results', (req) => {
      const at = Number(req.query.cursor ?? 0);
      const n = Number(req.query.limit);
      return { text: ['time,ema', ...rows.slice(at, at + n)].join('\n') + '\n', headers: { 'Content-Type': 'text/csv' } };
    });
    const all = await w.cli(['runs', 'results', 'run_ind', '--format', 'csv', '--limit', '2', '--all']);
    assert.equal(all.code, 0, all.stderr);
    assert.equal(all.stdout, ['time,ema', ...rows].join('\n') + '\n');
    assert.deepEqual(w.api.requests.map((q) => q.query), [
      { limit: '2', format: 'csv' },
      { limit: '2', format: 'csv', cursor: '2' },
      { limit: '2', format: 'csv', cursor: '4' },
    ]);

    const one = await w.cli(['runs', 'results', 'run_ind', '--format', 'csv', '--limit', '2']);
    assert.equal(one.stdout, ['time,ema', ...rows.slice(0, 2)].join('\n') + '\n');
    assert.match(one.stderr, /more: --cursor 2 \(or --all\)/);
  });

  it('runs results: definition events with --all, and an unfinished run exits 5', async () => {
    w.api.on('GET /runs/run_def/results', (req) =>
      req.query.cursor === '2'
        ? { json: { kind: 'definition', run_id: 'run_def', events: [event(3)], next_cursor: null } }
        : { json: { kind: 'definition', run_id: 'run_def', events: [event(1), event(2)], next_cursor: '2' } },
    );
    const r = await w.cli(['runs', 'results', 'run_def', '--event', 'bull_bar', '--from', '2026-06-01T00:00:00Z', '--all']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^3 events$/m);
    assert.match(r.stdout, /2026-06-28 10:05\s+bull_bar\s+HYPERLIQUID:BTC\s+\{"range":42,"body_pct":0\.81\}/);
    assert.deepEqual(w.api.requests[1]!.query, { event: 'bull_bar', from: '2026-06-01T00:00:00Z', format: 'json', cursor: '2' });

    w.api.on('GET /runs/run_busy/results', apiError(409, 'run_not_finished', 'The run is still running. Poll GET /runs/run_busy?wait=30.'));
    const busy = await w.cli(['runs', 'results', 'run_busy']);
    assert.equal(busy.code, 5);
    assert.match(busy.stderr, /error: run_not_finished: The run is still running/);
  });

  it('runs cancel', async () => {
    w.api.on('POST /runs/run_7k2m9q4xw1ht0bza/cancel', { json: run({ status: 'cancelled', summary: null, failure: { kind: 'cancelled', message: 'Cancelled.', retryable: false } }) });
    const r = await w.cli(['runs', 'cancel', 'run_7k2m9q4xw1ht0bza']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'run_7k2m9q4xw1ht0bza  cancelled');
    assert.equal(w.api.requests[0]!.method, 'POST');
    assert.equal(w.api.requests[0]!.body, undefined);

    w.api.on('POST /runs/run_gone/cancel', apiError(404, 'not_found', 'No run run_gone.'));
    const gone = await w.cli(['runs', 'cancel', 'run_gone']);
    assert.equal(gone.code, 4);
    assert.match(gone.stderr, /error: not_found: No run run_gone\./);
  });

  it('a study run by ref prints its metrics', async () => {
    w.api.on('POST /runs', { json: studyRun() });
    const r = await w.cli(['run', 'bull-stats', '--on', 'BTC', '--tf', '5m', '--last', '90d']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /events_processed: 12910/);
    assert.match(r.stdout, /win_rate\s+0\.55/);
  });
});
