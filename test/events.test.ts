import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness } from './helpers.js';
import { VERSION } from '../src/version.js';

const collectStarted = {
  definition: 'orb@3',
  instrument: 'HYPERLIQUID:BTC',
  timeframe: '5m',
  window: { from: '2026-06-01T00:00:00Z', to: '2026-09-01T00:00:00Z' },
  covered: false,
  collections: 1,
  held: 0,
};
const summary = (over: Record<string, unknown> = {}) => ({ definition: 'orb', events: 42, days: 90, events_per_day: 0.5, datasets: [], collecting: [], failed: [], ...over });
const ours = { instrument: 'HYPERLIQUID:BTC', timeframe: '5m', from: '2026-06-01T00:00:00Z', to: '2026-09-01T00:00:00Z' };

test('chartnaut --version and -v print the CLI version', async () => {
  const h = harness();
  assert.equal(await h.run('--version'), 0);
  assert.equal(await h.run('-v'), 0);
  assert.deepEqual(h.stdout, [VERSION, VERSION]);
  assert.equal(h.calls.length, 0);
});

test('events --version <n> filters by definition version instead of printing the CLI version', async () => {
  const h = harness({
    'GET /scripts/orb/events': { json: { events: [], total: 0, next_cursor: null } },
    'GET /scripts/orb/events/summary': { json: summary() },
  });
  assert.equal(await h.run('events', 'orb', '--version', '3'), 0, h.err());
  assert.equal(h.calls[0]!.url.searchParams.get('version'), '3');
  assert.equal(await h.run('events', 'orb', '--summary', '--version', '2'), 0, h.err());
  assert.equal(h.calls[1]!.url.searchParams.get('version'), '2');
  assert.ok(!h.stdout.includes(VERSION));
});

test('collect --version <n> collects that version', async () => {
  const h = harness({ 'POST /scripts/orb/collect': { status: 202, json: collectStarted } });
  assert.equal(await h.run('collect', 'orb', '--on', 'BTC', '--tf', '5m', '--last', '90d', '--version', '3'), 0, h.err());
  assert.equal(h.calls[0]!.body.version, 3);
  assert.ok(!h.stdout.includes(VERSION));
});

test('collect --wait exits 0 when its collection finished', async () => {
  const h = harness({
    'POST /scripts/orb/collect': { status: 202, json: collectStarted },
    'GET /scripts/orb/events/summary': [{ json: summary({ collecting: [{ ...ours, status: 'running' }] }) }, { json: summary() }],
  });
  assert.equal(await h.run('collect', 'orb', '--on', 'BTC', '--tf', '5m', '--last', '90d', '--wait'), 0, h.err());
  assert.match(h.out(), /42 events collected in total/);
});

test('collect --wait exits 2 and prints the failure when the collection failed', async () => {
  const h = harness({
    'POST /scripts/orb/collect': { status: 202, json: collectStarted },
    'GET /scripts/orb/events/summary': { json: summary({ failed: [{ ...ours, status: 'failed', failure_kind: 'script' }] }) },
  });
  assert.equal(await h.run('collect', 'orb', '--on', 'BTC', '--tf', '5m', '--last', '90d', '--wait'), 2);
  assert.match(h.err(), /failed: script: HYPERLIQUID:BTC 5m 2026-06-01 00:00 → 2026-09-01 00:00/);
});

test('collect --wait exits 5 for a retryable failure, and ignores other instruments', async () => {
  const h = harness({
    'POST /scripts/orb/collect': { status: 202, json: collectStarted },
    'GET /scripts/orb/events/summary': {
      json: summary({ failed: [{ ...ours, status: 'failed', failure_kind: 'data_not_ready' }, { ...ours, instrument: 'HYPERLIQUID:ETH', status: 'failed', failure_kind: 'script' }] }),
    },
  });
  assert.equal(await h.run('collect', 'orb', '--on', 'BTC', '--tf', '5m', '--last', '90d', '--wait'), 5);
  assert.match(h.err(), /failed: data_not_ready/);
  assert.doesNotMatch(h.err(), /ETH/);

  const other = harness({
    'POST /scripts/orb/collect': { status: 202, json: collectStarted },
    'GET /scripts/orb/events/summary': { json: summary({ failed: [{ ...ours, instrument: 'HYPERLIQUID:ETH', status: 'failed', failure_kind: 'script' }] }) },
  });
  assert.equal(await other.run('collect', 'orb', '--on', 'BTC', '--tf', '5m', '--last', '90d', '--wait'), 0, other.err());
});

test('collect --wait --json still exits non-zero on failure', async () => {
  const h = harness({
    'POST /scripts/orb/collect': { status: 202, json: collectStarted },
    'GET /scripts/orb/events/summary': { json: summary({ failed: [{ ...ours, status: 'failed', failure_kind: 'script' }] }) },
  });
  assert.equal(await h.run('collect', 'orb', '--on', 'BTC', '--tf', '5m', '--last', '90d', '--wait', '--json'), 2);
});

const EV_HEADER = 'event,intent,instrument,timeframe,start,end,bar_index,payload';
const evRow = (i: number) => `e${i},long,HYPERLIQUID:BTC,5m,2026-01-01T00:00:00Z,2026-01-01T00:05:00Z,${i},"{""range"":${i}}"`;
/** The events endpoint: offset cursor, 100 by default, 1000 at most, total 2345. */
const eventsCsvRoute = (call: { url: URL }) => {
  const offset = Number(call.url.searchParams.get('cursor') ?? 0);
  const lim = Math.min(Number(call.url.searchParams.get('limit') ?? 100) || 100, 1000);
  const n = Math.max(0, Math.min(lim, 2345 - offset));
  return { text: [EV_HEADER, ...Array.from({ length: n }, (_, i) => evRow(offset + i))].join('\n') + '\n' };
};

test('events --format csv returns every page under one header', async () => {
  const h = harness({ 'GET /scripts/orb/events': eventsCsvRoute });
  assert.equal(await h.run('events', 'orb', '--on', 'BTC', '--format', 'csv'), 0, h.err());
  const lines = h.out().trimEnd().split('\n');
  assert.equal(lines.length, 1 + 2345);
  assert.equal(lines.filter((l) => l === EV_HEADER).length, 1);
  assert.equal(lines.at(-1), evRow(2344));
  // Largest pages the server allows, walking the offset cursor; filters kept on every page.
  assert.deepEqual(h.calls.map((c) => [c.url.searchParams.get('limit'), c.url.searchParams.get('cursor')]), [['1000', null], ['1000', '1000'], ['1000', '2000']]);
  assert.ok(h.calls.every((c) => c.url.searchParams.get('format') === 'csv' && c.url.searchParams.get('instrument') === 'BTC'));
});

test('events --out x.csv writes every page under one header', async () => {
  const h = harness({ 'GET /scripts/orb/events': eventsCsvRoute });
  assert.equal(await h.run('events', 'orb', '--out', 'ev.csv'), 0, h.err());
  const lines = fs.readFileSync(path.join(h.cwd, 'ev.csv'), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 1 + 2345);
  assert.equal(lines.filter((l) => l === EV_HEADER).length, 1);
  assert.match(h.out(), /wrote ev\.csv/);
});

test('events csv: an explicit --limit or --cursor is one page with a more hint; --all pages at that size', async () => {
  const h = harness({ 'GET /scripts/orb/events': eventsCsvRoute });
  assert.equal(await h.run('events', 'orb', '--format', 'csv', '--limit', '500'), 0, h.err());
  assert.equal(h.calls.length, 1);
  assert.equal(h.out().trimEnd().split('\n').length, 1 + 500);
  assert.match(h.err(), /more: --cursor 500 \(or --all\)/);

  const all = harness({ 'GET /scripts/orb/events': eventsCsvRoute });
  assert.equal(await all.run('events', 'orb', '--format', 'csv', '--limit', '500', '--all'), 0, all.err());
  assert.deepEqual(all.calls.map((c) => c.url.searchParams.get('cursor')), [null, '500', '1000', '1500', '2000']);
  assert.equal(all.out().trimEnd().split('\n').length, 1 + 2345);

  const last = harness({ 'GET /scripts/orb/events': eventsCsvRoute });
  assert.equal(await last.run('events', 'orb', '--format', 'csv', '--cursor', '2300'), 0, last.err());
  assert.equal(last.out().trimEnd().split('\n').length, 1 + 45);
  assert.doesNotMatch(last.err(), /more:/);
});
