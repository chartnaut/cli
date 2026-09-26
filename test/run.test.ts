import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, writeFiles } from './helpers.js';
import { CREATE_RETRY_BUDGET_MS, MIN_POLL_MS } from '../src/commands/run.js';

const doneRun = (over: Record<string, unknown> = {}) => ({
  id: 'run_1',
  kind: 'indicator',
  script: 'inline',
  instrument: 'HYPERLIQUID:BTC',
  timeframe: '5m',
  status: 'succeeded',
  summary: { bars: 1000, outputs: { rsi: { last: 51.2, min: 12, max: 88, count: 1000 } } },
  app_url: 'https://terminal.chartnaut.com/morpheus/runs/run_1',
  ...over,
});

function project(root: string) {
  writeFiles(root, {
    'chartnaut.json': JSON.stringify({ defaults: { instrument: 'BTC', timeframe: '5m', window: '90d' } }),
    'indicators/my-rsi/script.json': JSON.stringify({ kind: 'indicator', slug: 'my-rsi', name: 'My RSI', entry: 'main.ts' }),
    'indicators/my-rsi/main.ts': 'export default 1;\n',
  });
}

test('run <path> sends inline source with project defaults and prints the summary', async () => {
  const h = harness({ 'POST /runs': { status: 200, json: doneRun() } });
  project(h.cwd);
  const code = await h.run('run', 'indicators/my-rsi', '--set', 'len=14', '--set', 'smooth=true');
  assert.equal(code, 0, h.err());
  assert.equal(h.calls.length, 1);
  const c = h.calls[0]!;
  assert.equal(c.url.toString(), 'https://api.test/v1/runs');
  assert.deepEqual(c.body, {
    source: { kind: 'indicator', files: [{ path: 'main.ts', code: 'export default 1;\n', entry: true }] },
    instrument: 'BTC',
    timeframe: '5m',
    window: { last: '90d' },
    settings: { len: 14, smooth: true },
    wait: 0,
  });
  assert.equal(c.headers.authorization, 'Bearer cn_test_token');
  assert.match(c.headers['user-agent']!, /^chartnaut-cli\/\d+\.\d+\.\d+$/);
  assert.match(c.headers['idempotency-key']!, /^[0-9a-f-]{36}$/);
  assert.match(h.out(), /rsi\s+51\.2\s+12\s+88\s+1000/);
  assert.match(h.out(), /app: https:\/\/terminal\.chartnaut\.com/);
});

test('run <ref> sends a script ref; flags override defaults', async () => {
  const h = harness({ 'POST /runs': { json: doneRun({ script: 'vwap@3' }) } });
  project(h.cwd);
  const code = await h.run('run', 'vwap@3', '--on', 'ETH', '--tf', '1h', '--bars', '500');
  assert.equal(code, 0);
  assert.deepEqual(h.calls[0]!.body, { script: 'vwap@3', instrument: 'ETH', timeframe: '1h', window: { bars: 500 }, wait: 0 });
});

test('run polls GET /runs/{id}?wait=30 until terminal', async () => {
  const h = harness({
    'POST /runs': { status: 202, json: { id: 'run_9', status: 'queued' } },
    'GET /runs/run_9': [{ json: { id: 'run_9', status: 'running', progress: { pct: 40 } } }, { json: doneRun({ id: 'run_9' }) }],
  });
  const code = await h.run('run', 'chartnaut/rsi', '--on', 'BTC', '--tf', '5m', '--last', '7d');
  assert.equal(code, 0);
  const gets = h.calls.filter((c) => c.method === 'GET');
  assert.equal(gets.length, 2);
  assert.equal(gets[0]!.url.searchParams.get('wait'), '30');
});

test('--no-wait posts wait=0 and prints the id', async () => {
  const h = harness({ 'POST /runs': { status: 202, json: { id: 'run_5', status: 'queued' } } });
  const code = await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d', '--no-wait');
  assert.equal(code, 0);
  assert.equal(h.calls[0]!.body.wait, 0);
  assert.equal(h.calls.length, 1);
  assert.match(h.out(), /^run_5\s+queued/);
});

test('failed run exits 2 and prints failure kind', async () => {
  const h = harness({ 'POST /runs': { json: doneRun({ status: 'failed', summary: null, failure: { kind: 'script', message: 'boom' } }) } });
  const code = await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d');
  assert.equal(code, 2);
  assert.match(h.out(), /failed: script: boom/);
});

test('422 script_invalid exits 1 with diagnostics', async () => {
  const h = harness({
    'POST /runs': {
      status: 422,
      json: { error: { code: 'script_invalid', message: 'does not lint' }, diagnostics: [{ severity: 'error', message: 'x is undefined', path: 'main.ts', line: 3 }] },
    },
  });
  const code = await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d');
  assert.equal(code, 1);
  assert.match(h.err(), /^error: script_invalid: does not lint$/m);
  assert.match(h.err(), /^main\.ts:3: error: x is undefined$/m);
});

test('429 retries honour Retry-After and reuse the Idempotency-Key', async () => {
  const h = harness({
    'POST /runs': [
      { status: 429, json: { error: { code: 'rate_limited', message: 'slow down' } }, headers: { 'Retry-After': '2' } },
      { status: 503, text: 'unavailable' },
      { json: doneRun() },
    ],
  });
  const code = await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d');
  assert.equal(code, 0, h.err());
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.sleeps, [2000, 2000]);
  const keys = new Set(h.calls.map((c) => c.headers['idempotency-key']));
  assert.equal(keys.size, 1);
});

test('run creation keeps retrying busy for its time budget, then exits 5', async () => {
  const h = harness({ 'POST /runs': { status: 503, json: { error: { code: 'busy', message: 'full' } } } });
  const code = await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d');
  assert.equal(code, 5);
  assert.ok(h.calls.length > 4, `retried ${h.calls.length - 1} times`);
  const waited = h.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(waited <= CREATE_RETRY_BUDGET_MS && waited > CREATE_RETRY_BUDGET_MS - 15_000, `waited ${waited}`);
  assert.ok(h.sleeps.every((ms) => ms <= 15_000), 'backoff is capped');
  assert.match(h.err(), /error: busy: full/);
});

test('run creation stops retrying a server that keeps answering Retry-After: 0', async () => {
  const h = harness({
    'POST /runs': { status: 429, json: { error: { code: 'busy', message: 'full' } }, headers: { 'Retry-After': '0' } },
  });
  const code = await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d');
  assert.equal(code, 5);
  assert.ok(h.calls.length <= 51, `made ${h.calls.length} calls`);
});

test('run creation honours Retry-After on 429 busy beyond three retries', async () => {
  const busy = { status: 429, json: { error: { code: 'busy', message: 'Your plan allows 2 …' } }, headers: { 'Retry-After': '15' } };
  const h = harness({ 'POST /runs': [busy, busy, busy, busy, busy, { json: doneRun() }] });
  const code = await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d');
  assert.equal(code, 0, h.err());
  assert.deepEqual(h.sleeps, [15000, 15000, 15000, 15000, 15000]);
  assert.equal(new Set(h.calls.map((c) => c.headers['idempotency-key'])).size, 1);
});

test('other commands keep the three-retry limit', async () => {
  const h = harness({ 'GET /me': { status: 429, json: { error: { code: 'rate_limited', message: 'slow' } } } });
  assert.equal(await h.run('whoami'), 5);
  assert.equal(h.calls.length, 4);
});

test('--on A,B,C creates every run without holding a wait, then polls GET /runs/{id}', async () => {
  // The server's heavy gate: POST /runs only. Here any POST carrying wait > 0 would be answered busy,
  // as a Starter account's third waiting create was.
  const h = harness({
    'POST /runs': (call) =>
      call.body.wait > 0
        ? { status: 429, json: { error: { code: 'busy', message: 'Your plan allows 2 at once.' } }, headers: { 'Retry-After': '2' } }
        : { status: 202, json: { id: `run_${call.body.instrument}`, status: 'queued' } },
    'GET /runs/run_BTC': [{ json: { id: 'run_BTC', status: 'running' } }, { json: doneRun({ id: 'run_BTC', instrument: 'BTC' }) }],
    'GET /runs/run_ETH': { json: doneRun({ id: 'run_ETH', instrument: 'ETH' }) },
    'GET /runs/run_SOL': { json: doneRun({ id: 'run_SOL', instrument: 'SOL' }) },
  });
  const code = await h.run('run', 'chartnaut/rsi', '--on', 'BTC,ETH,SOL', '--tf', '5m', '--last', '7d');
  assert.equal(code, 0, h.err());
  const posts = h.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 3);
  assert.ok(posts.every((c) => c.body.wait === 0));
  const gets = h.calls.filter((c) => c.method === 'GET');
  assert.equal(gets.length, 4);
  assert.ok(gets.every((c) => c.url.searchParams.get('wait') === '30'));
  for (const i of ['BTC', 'ETH', 'SOL']) assert.match(h.out(), new RegExp(`${i}\\s+succeeded`));
  // A poll that came back unfinished at once waits before the next one instead of spinning.
  assert.deepEqual(h.sleeps, [MIN_POLL_MS]);
});

test('a run that finishes busy exits 5 like an HTTP busy', async () => {
  const h = harness({ 'POST /runs': { json: doneRun({ status: 'failed', summary: null, failure: { kind: 'busy', message: 'too many dry runs', retryable: true } }) } });
  assert.equal(await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d'), 5);
  assert.match(h.out(), /failed: busy: too many dry runs \(retryable\)/);
});

test('bad usage exits 4 without calling the API', async () => {
  const h = harness();
  assert.equal(await h.run('run', 'x-y', '--on', 'BTC', '--tf', '3m', '--last', '7d'), 4);
  assert.equal(await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d', '--bars', '9'), 4);
  assert.equal(await h.run('run'), 4);
  assert.equal(h.calls.length, 0);
});

test('--on fans out, prints a comparison table, and --out writes per-instrument csv', async () => {
  let n = 0;
  const h = harness({
    'POST /runs': (call) => {
      n++;
      const id = `run_${call.body.instrument}`;
      return { json: doneRun({ id, instrument: call.body.instrument, kind: 'definition', summary: { bars: 10, events_total: n, by_event: { long: n } } }) };
    },
    'GET /runs/run_BTC/results': { text: 'time,event\n1,long\n' },
    'GET /runs/run_ETH/results': { text: 'time,event\n2,long\n' },
  });
  const code = await h.run('run', 'orb', '--on', 'BTC,ETH', '--tf', '5m', '--last', '30d', '--out', 'res.csv');
  assert.equal(code, 0, h.err());
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 2);
  assert.match(h.out(), /INSTRUMENT\s+STATUS\s+BARS\s+EVENTS_TOTAL\s+LONG/);
  assert.match(h.out(), /BTC\s+succeeded/);
  assert.match(h.out(), /ETH\s+succeeded/);
  const csvCall = h.calls.find((c) => c.url.pathname.endsWith('/results'))!;
  assert.equal(csvCall.url.searchParams.get('format'), 'csv');
  assert.equal(fs.readFileSync(path.join(h.cwd, 'res.BTC.csv'), 'utf8'), 'time,event\n1,long\n');
  assert.equal(fs.readFileSync(path.join(h.cwd, 'res.ETH.csv'), 'utf8'), 'time,event\n2,long\n');
});

test('--out json follows next_cursor pages', async () => {
  const h = harness({
    'POST /runs': { json: doneRun({ kind: 'definition' }) },
    'GET /runs/run_1/results': (call) =>
      call.url.searchParams.get('cursor') === 'p2'
        ? { json: { kind: 'definition', run_id: 'run_1', events: [{ event: 'b' }], next_cursor: null } }
        : { json: { kind: 'definition', run_id: 'run_1', events: [{ event: 'a' }], next_cursor: 'p2' } },
  });
  const code = await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d', '--out', 'r.json');
  assert.equal(code, 0, h.err());
  const saved = JSON.parse(fs.readFileSync(path.join(h.cwd, 'r.json'), 'utf8'));
  assert.deepEqual(saved.events.map((e: any) => e.event), ['a', 'b']);
  assert.equal(saved.next_cursor, null);
});

test('--json prints the raw run (flag accepted before or after the command)', async () => {
  const h = harness({ 'POST /runs': { json: doneRun() } });
  assert.equal(await h.run('--json', 'run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d'), 0);
  assert.equal(JSON.parse(h.stdout[0]!).id, 'run_1');
  assert.equal(await h.run('run', 'x-y', '--on', 'BTC', '--tf', '5m', '--last', '7d', '--json'), 0);
  assert.equal(JSON.parse(h.stdout[1]!).id, 'run_1');
});

test('runs list, get, results, cancel map to the right requests', async () => {
  const h = harness({
    'GET /runs': { json: { data: [doneRun()], next_cursor: null } },
    'GET /runs/run_1': { json: doneRun({ status: 'failed', failure: { kind: 'data_not_ready', message: 'later', retryable: true } }) },
    'GET /runs/run_1/results': { json: { kind: 'study', run_id: 'run_1', results: [{ key: 'wr', kind: 'metric', data: { value: 0.61 } }, { key: 'dist', kind: 'distribution', omitted: true, size: 40 }] } },
    'POST /runs/run_1/cancel': { json: doneRun({ status: 'cancelled' }) },
  });
  assert.equal(await h.run('runs', '--script', 'orb', '--status', 'succeeded'), 0);
  assert.equal(h.calls[0]!.url.searchParams.get('script'), 'orb');
  assert.equal(h.calls[0]!.url.searchParams.get('status'), 'succeeded');
  assert.match(h.out(), /run_1\s+indicator/);

  assert.equal(await h.run('runs', 'get', 'run_1'), 5);
  assert.equal(await h.run('runs', 'results', 'run_1', '--keys', 'dist,wr', '--full'), 0);
  const r = h.calls.at(-1)!;
  assert.equal(r.url.searchParams.get('keys'), 'dist,wr');
  assert.equal(r.url.searchParams.get('full'), 'true');
  assert.equal(r.url.searchParams.get('format'), 'json');
  assert.match(h.out(), /\[metric\] wr: 0\.61/);
  assert.match(h.out(), /40 rows omitted \(fetch with --keys dist\)/);

  assert.equal(await h.run('runs', 'cancel', 'run_1'), 0);
  assert.equal(h.calls.at(-1)!.method, 'POST');
  assert.match(h.out(), /run_1\s+cancelled/);
});

test('missing token exits 3', async () => {
  const h = harness({}, { env: { CHARTNAUT_TOKEN: '' } });
  assert.equal(await h.run('whoami'), 3);
  assert.match(h.err(), /not logged in/);
  assert.equal(h.calls.length, 0);
});

const csvRows = (from: number, n: number) => Array.from({ length: n }, (_, i) => `e${from + i},long,BTC,5m,2026-01-01T00:00:00Z,,${from + i},"{""r"":1}"`);
const EVENTS_HEADER = 'event,intent,instrument,timeframe,start,end,bar_index,payload';
const eventsCsv = (call: { url: URL }) => {
  const offset = Number(call.url.searchParams.get('cursor') ?? 0);
  const total = 5003;
  const n = Math.max(0, Math.min(5000, total - offset));
  return { text: [EVENTS_HEADER, ...csvRows(offset, n)].join('\n') + '\n' };
};

test('run --out file.csv follows every page and writes one header row', async () => {
  const h = harness({
    'POST /runs': { json: doneRun({ kind: 'definition' }) },
    'GET /runs/run_1/results': eventsCsv,
  });
  const code = await h.run('run', 'orb', '--on', 'BTC', '--tf', '5m', '--last', '30d', '--out', 'r.csv');
  assert.equal(code, 0, h.err());
  const pages = h.calls.filter((c) => c.url.pathname.endsWith('/results'));
  assert.deepEqual(pages.map((c) => c.url.searchParams.get('cursor')), [null, '5000']);
  const lines = fs.readFileSync(path.join(h.cwd, 'r.csv'), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 1 + 5003);
  assert.equal(lines.filter((l) => l === EVENTS_HEADER).length, 1);
  assert.equal(lines.at(-1), csvRows(5002, 1)[0]);
});

test('runs results --format csv: --all pages, without it says there is more', async () => {
  const h = harness({ 'GET /runs/run_1/results': eventsCsv });
  assert.equal(await h.run('runs', 'results', 'run_1', '--format', 'csv', '--all'), 0, h.err());
  assert.equal(h.out().trimEnd().split('\n').length, 1 + 5003);
  assert.equal(h.calls.length, 2);
  assert.equal(await h.run('runs', 'results', 'run_1', '--format', 'csv'), 0);
  assert.equal(h.calls.length, 3);
  assert.match(h.err(), /more: --cursor 5000 \(or --all\)/);
});

test('a study block as csv is fetched once, never paged', async () => {
  const rows = Array.from({ length: 6000 }, (_, i) => `${i},x`);
  const h = harness({ 'GET /runs/run_1/results': { text: ['k,v', ...rows].join('\n') + '\n' } });
  assert.equal(await h.run('runs', 'results', 'run_1', '--keys', 'rows', '--format', 'csv', '--all'), 0, h.err());
  assert.equal(h.calls.length, 1);
});
