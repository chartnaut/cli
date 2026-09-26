import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apiError, world, type World } from './harness.js';
import { COLLECT_QUEUED, EVENTS_CSV_HEADER, EVENTS_SUMMARY, TOKEN, event, eventsCsv } from './fixtures.js';

const WHERE = '[{"key":"range","op":"gt","value":10}]';

describe("events: a definition's collected events", () => {
  let w: World;
  before(async () => (w = await world(TOKEN)));
  after(() => w.dispose());
  beforeEach(() => w.api.reset());

  it('sends every filter and prints a page with its total and cursor', async () => {
    w.api.on('GET /scripts/bull-bar/events', { json: { events: [event(1)], total: 3118, next_cursor: '1' } });
    const r = await w.cli([
      'events', 'bull-bar', '--on', 'BTC', '--tf', '5m', '--event', 'bull_bar',
      '--from', '2026-06-01T00:00:00Z', '--to', '2026-09-01T00:00:00Z', '--version', '4', '--where', WHERE, '--limit', '1',
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(w.api.requests[0]!.query, {
      instrument: 'BTC', timeframe: '5m', event: 'bull_bar', from: '2026-06-01T00:00:00Z', to: '2026-09-01T00:00:00Z', version: '4', where: WHERE, limit: '1',
    });
    assert.match(r.stdout, /START\s+INSTRUMENT\s+TF\s+EVENT\s+PAYLOAD/);
    assert.match(r.stdout, /2026-06-28 10:05\s+HYPERLIQUID:BTC\s+5m\s+bull_bar\s+\{"range":42,"body_pct":0\.81\}/);
    assert.match(r.stdout, /3118 total · more: --cursor 1 \(or --all\)/);
  });

  it('--all follows next_cursor into one document', async () => {
    w.api.on('GET /scripts/bull-bar/events', (req) =>
      req.query.cursor === '2' ? { json: { events: [event(3)], total: 3, next_cursor: null } } : { json: { events: [event(1), event(2)], total: 3, next_cursor: '2' } },
    );
    const r = await w.cli(['events', 'bull-bar', '--all', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.events.map((e: any) => e.bar_index), [1, 2, 3]);
    assert.equal(doc.next_cursor, null);
    assert.deepEqual(w.api.requests.map((q) => q.query), [{}, { cursor: '2' }]);
  });

  it('CSV is paged at the largest page size and joined under one header', async () => {
    w.api.on('GET /scripts/bull-bar/events', (req) => ({
      text: req.query.cursor === '1000' ? eventsCsv(1000, 3) : eventsCsv(0, 1000),
      headers: { 'Content-Type': 'text/csv' },
    }));
    const r = await w.cli(['events', 'bull-bar', '--on', 'BTC', '--format', 'csv']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(w.api.requests.map((q) => q.query), [
      { instrument: 'BTC', limit: '1000', format: 'csv' },
      { instrument: 'BTC', limit: '1000', format: 'csv', cursor: '1000' },
    ]);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 1 + 1003);
    assert.equal(lines.filter((l) => l === EVENTS_CSV_HEADER).length, 1);

    const out = await w.cli(['events', 'bull-bar', '--on', 'BTC', '--out', 'ev.csv']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trim(), 'wrote ev.csv');
    assert.equal(fs.readFileSync(path.join(w.cwd, 'ev.csv'), 'utf8'), r.stdout);
  });

  it('CSV with --limit and no --all is one page and says where the next one starts', async () => {
    w.api.on('GET /scripts/bull-bar/events', { text: eventsCsv(0, 10), headers: { 'Content-Type': 'text/csv' } });
    const r = await w.cli(['events', 'bull-bar', '--format', 'csv', '--limit', '10']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(w.api.requests.length, 1);
    assert.match(r.stderr, /more: --cursor 10 \(or --all\)/);
  });

  it('--summary prints totals and one row per instrument and timeframe', async () => {
    w.api.on('GET /scripts/bull-bar/events/summary', { json: EVENTS_SUMMARY });
    const r = await w.cli(['events', 'bull-bar', '--summary', '--version', '4']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(w.api.requests[0]!.query, { version: '4' });
    assert.match(r.stdout, /bull-bar: 25690 events over 90 days \(285\.44\/day\)/);
    assert.match(r.stdout, /HYPERLIQUID:BTC\s+5m\s+12910\s+2026-06-28 10:00\s+2026-09-26 10:00/);
    assert.match(r.stdout, /HYPERLIQUID:ETH\s+5m\s+12780/);

    w.api.on('GET /scripts/bull-bar/events/summary', { json: { ...EVENTS_SUMMARY, events: 0, days: 0, events_per_day: 0, datasets: [] } });
    const empty = await w.cli(['events', 'bull-bar', '--summary']);
    assert.match(empty.stdout, /nothing collected yet: chartnaut collect bull-bar/);
  });

  it('an unknown definition exits 4', async () => {
    w.api.on('GET /scripts/nope/events', apiError(404, 'not_found', 'No definition nope.'));
    const r = await w.cli(['events', 'nope']);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /error: not_found: No definition nope\./);
  });
});

describe('collect', () => {
  let w: World;
  before(async () => (w = await world(TOKEN)));
  after(() => w.dispose());
  beforeEach(() => w.api.reset());

  const ours = { instrument: 'HYPERLIQUID:BTC', timeframe: '5m', from: '2025-09-26T09:25:00Z', to: '2026-09-26T09:25:00Z' };

  it('--wait: queues the missing windows, waits for them and prints the total', async () => {
    w.api.on('POST /scripts/bull-bar/collect', { status: 202, json: COLLECT_QUEUED });
    w.api.on('GET /scripts/bull-bar/events/summary', { json: EVENTS_SUMMARY });
    const r = await w.cli(['collect', 'bull-bar', '--on', 'BTC', '--tf', '5m', '--last', '1y', '--version', '4', '--wait']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(w.api.requests[0]!.body, { instrument: 'BTC', timeframe: '5m', window: { last: '1y' }, version: 4 });
    assert.deepEqual(w.api.requests.map((q) => `${q.method} ${q.path}`), ['POST /scripts/bull-bar/collect', 'GET /scripts/bull-bar/events/summary']);
    assert.match(r.stdout, /bull-bar@4 on HYPERLIQUID:BTC 5m: collecting 2 window\(s\)/);
    assert.match(r.stdout, /25690 events collected in total/);
  });

  it('--wait: a failed collection of this window exits 2; another instrument\'s failure is ignored', async () => {
    w.api.on('POST /scripts/bull-bar/collect', { status: 202, json: COLLECT_QUEUED });
    w.api.on('GET /scripts/bull-bar/events/summary', {
      json: {
        ...EVENTS_SUMMARY,
        failed: [
          { ...ours, status: 'failed', failure_kind: 'script' },
          { ...ours, instrument: 'HYPERLIQUID:ETH', status: 'failed', failure_kind: 'data_not_ready' },
        ],
      },
    });
    const r = await w.cli(['collect', 'bull-bar', '--on', 'BTC', '--tf', '5m', '--last', '1y', '--wait']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /failed: script: HYPERLIQUID:BTC 5m 2025-09-26 09:25 → 2026-09-26 09:25/);
    assert.doesNotMatch(r.stderr, /HYPERLIQUID:ETH/);
  });

  it('--wait: a collection that failed for want of data exits 5 (retry later)', async () => {
    w.api.on('POST /scripts/bull-bar/collect', { status: 202, json: COLLECT_QUEUED });
    w.api.on('GET /scripts/bull-bar/events/summary', { json: { ...EVENTS_SUMMARY, failed: [{ ...ours, status: 'failed', failure_kind: 'data_not_ready' }] } });
    const r = await w.cli(['collect', 'bull-bar', '--on', 'BTC', '--tf', '5m', '--last', '1y', '--wait', '--json']);
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.stdout).summary.failed[0].failure_kind, 'data_not_ready');
  });

  it('an already covered window returns at once; without --wait it says how to check', async () => {
    w.api.on('POST /scripts/bull-bar/collect', { json: { ...COLLECT_QUEUED, covered: true, collections: 0 } });
    const covered = await w.cli(['collect', 'bull-bar', '--on', 'BTC', '--tf', '5m', '--bars', '1000', '--wait']);
    assert.equal(covered.code, 0, covered.stderr);
    assert.match(covered.stdout, /bull-bar@4 on HYPERLIQUID:BTC 5m: already collected/);
    assert.deepEqual(w.api.requests[0]!.body.window, { bars: 1000 });
    assert.equal(w.api.requests.length, 1, 'nothing to wait for');

    w.api.on('POST /scripts/bull-bar/collect', { status: 202, json: COLLECT_QUEUED });
    const queued = await w.cli(['collect', 'bull-bar', '--on', 'BTC', '--tf', '5m', '--from', '2026-01-01']);
    assert.equal(queued.code, 0, queued.stderr);
    assert.deepEqual(w.api.requests[1]!.body.window, { from: '2026-01-01T00:00:00.000Z' });
    assert.match(queued.stdout, /check: chartnaut events bull-bar --summary/);
  });

  it('refusals map to exit codes: plan_limit 3, unsupported_timeframe 4', async () => {
    w.api.on('POST /scripts/bull-bar/collect', apiError(403, 'plan_limit', 'You are at your definition events cap.'));
    assert.equal((await w.cli(['collect', 'bull-bar', '--on', 'BTC', '--tf', '5m', '--last', '90d'])).code, 3);
    assert.equal((await w.cli(['collect', 'bull-bar', '--on', 'BTC', '--tf', '7m', '--last', '90d'])).code, 4, 'checked before any request');
    assert.equal(w.api.requests.length, 1);
  });
});
