/**
 * Responses shaped exactly like the public API's (docs: CLI › API reference). Values are made up;
 * field names, nesting and types follow the reference pages for each endpoint.
 */

export const TOKEN = 'cn_live_' + 'a1'.repeat(32);
export const NEW_TOKEN = 'cn_live_' + 'b2'.repeat(32);
export const APP = 'https://terminal.chartnaut.com/morpheus';

// ── account ──

export const ME = {
  user: 'jane',
  plan: 'pro',
  token: { name: 'CLI on test-machine', scopes: ['scripts:read', 'scripts:write', 'runs:write'], expires_at: null },
};

export const USAGE = {
  plan: 'pro',
  period: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
  compute_units: { used: 1843.2, included: null },
  caps: {
    indicators: { used: 7, limit: null },
    definitions: { used: 12, limit: 50 },
    studies: { used: 31, limit: 1000 },
    events: { used: 18220, limit: 50000 },
    concurrent_runs: { used: 1, limit: 3 },
  },
  history_start: '2015-02-02T00:00:00Z',
  memory_bars: 5000,
  api_limits: { requests_per_minute: 300, concurrent_heavy: 3, concurrent_waits: 6 },
};

// ── sign-in ──

export const DEVICE_START = {
  device_code: '9c1e4b7a2d6f08e35a1c7b9d4e2f60a8b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1',
  user_code: 'KMPR-TVXZ',
  verification_uri: `${APP}/cli-auth`,
  verification_uri_complete: `${APP}/cli-auth?code=KMPR-TVXZ`,
  expires_in: 600,
  // The API says 3; the CLI waits at least 1 s between polls, so 1 keeps the suite quick.
  interval: 1,
};

// ── instruments ──

export const BTC = {
  symbol: 'HYPERLIQUID:BTC',
  short: 'BTC',
  name: 'Bitcoin Perpetual (Hyperliquid)',
  category: 'crypto',
  tick_size: 1,
  contract_multiplier: 1,
  order_flow: true,
  coverage: { start: '2025-03-22T10:50:00Z', end: '2026-09-26T09:41:00Z' },
};
export const ETH = {
  symbol: 'HYPERLIQUID:ETH',
  short: 'ETH',
  name: 'Ethereum Perpetual (Hyperliquid)',
  category: 'crypto',
  tick_size: 0.1,
  contract_multiplier: 1,
  order_flow: true,
  coverage: { start: '2025-03-22T10:50:00Z', end: '2026-09-26T09:41:00Z' },
};

// ── docs ──

export const DOC_TOPICS = {
  data: [
    { topic: 'overview', title: 'Overview', depth: 0 },
    { topic: 'what-chartnaut-guarantees', title: 'What Chartnaut guarantees', depth: 1 },
    { topic: 'bars-and-clocks', title: 'Bars and clocks', depth: 1 },
  ],
};
export const DOC_BARS = '# Bars and clocks\n\nEvery script runs against a clock made of bars.\n\nNext: warmup-and-memory\n';

// ── scripts ──

const INTERFACE = {
  settings: { length: { type: 'number', default: 20, min: 1 } },
  outputs: [{ id: 'ema', kind: 'line', pane: 'price' }],
};

/** The Script object; `files` only on GET with include=source. */
export function script(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    slug: 'my-ema',
    kind: 'indicator',
    name: 'My EMA',
    description: '20-period EMA on the price chart.',
    visibility: 'private',
    latest_version: 3,
    updated_at: '2026-09-25T14:02:11.482913Z',
    app_url: `${APP}/indicator-builder/412`,
    version: 3,
    interface: INTERFACE,
    dependencies: [],
    ...over,
  };
}

export const VALIDATE_OK = {
  ok: true,
  diagnostics: [],
  interface: INTERFACE,
  dependencies: [{ ref: 'session-range', as: 'range', version: 7 }],
};
export const VALIDATE_BAD = {
  ok: false,
  diagnostics: [
    { severity: 'error', code: 'lint', message: "Cannot find name 'rangeHigh'", path: 'main.ts', line: 14 },
    { severity: 'warning', code: 'lint', message: "'unused' is declared but never read", path: 'main.ts', line: 3 },
  ],
  interface: { settings: {} },
  dependencies: [],
};

export const VERSIONS = {
  data: [
    { version: 3, change_summary: 'Clamp length to 1 or more', author: 'api', created_at: '2026-09-25T14:02:11.401775Z' },
    { version: 2, change_summary: '', author: 'you', created_at: '2026-09-24T19:15:40.220163Z' },
  ],
  next_cursor: '2',
};

// ── runs ──

export function run(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 'run_7k2m9q4xw1ht0bza',
    kind: 'indicator',
    script: 'my-ema@3',
    instrument: 'HYPERLIQUID:BTC',
    timeframe: '5m',
    window: { from: '2026-08-27T09:25:00Z', to: '2026-09-26T09:25:00Z' },
    settings: { length: 50 },
    label: null,
    status: 'succeeded',
    progress: { pct: 100 },
    failure: null,
    summary: { bars: 8640, outputs: { ema: { last: 109412.5, min: 101877.25, max: 112730.8, count: 8640 } } },
    console: [],
    usage: { bars: 8640, compute_units: 8.64 },
    app_url: null,
    created_at: '2026-09-26T09:26:03.117204Z',
    started_at: '2026-09-26T09:26:03.240118Z',
    finished_at: '2026-09-26T09:26:07.902561Z',
    results_expire_at: '2026-10-03T09:26:03.117204Z',
    ...over,
  };
}

/** A run still going: what POST /runs with wait 0 and GET /runs/{id} answer with 202. */
export function pending(over: Record<string, unknown> = {}): Record<string, any> {
  return run({ status: 'queued', progress: { pct: 0 }, summary: null, usage: { bars: 0, compute_units: 0 }, finished_at: null, ...over });
}

export function definitionRun(over: Record<string, unknown> = {}): Record<string, any> {
  return run({
    id: 'run_p3n8c5v0r6ydj2fe',
    kind: 'definition',
    script: 'bull-bar@4',
    settings: {},
    summary: { bars: 25920, events_total: 12910, by_event: { bull_bar: 12910 } },
    usage: { bars: 25920, compute_units: 25.92 },
    ...over,
  });
}

export function studyRun(over: Record<string, unknown> = {}): Record<string, any> {
  return run({
    id: 'run_s9d2k4m6p8q0r1t3',
    kind: 'study',
    script: 'bull-stats@2',
    settings: {},
    summary: { events_processed: 12910, metrics: { win_rate: 0.55 } },
    ...over,
  });
}

export const EVENTS_CSV_HEADER = 'event,intent,instrument,timeframe,start,end,bar_index,payload';
/** One event row as the API writes it (Go's encoding/csv: the JSON payload is quoted). */
export function eventCsvRow(i: number, instrument = 'HYPERLIQUID:BTC'): string {
  const t = new Date(Date.UTC(2026, 5, 28, 10, 0, 0) + i * 300_000).toISOString().replace('.000Z', 'Z');
  const e = new Date(Date.UTC(2026, 5, 28, 10, 5, 0) + i * 300_000).toISOString().replace('.000Z', 'Z');
  return `bull_bar,long,${instrument},5m,${t},${e},${i},"{""range"":${i % 50}}"`;
}
export function eventsCsv(from: number, n: number): string {
  return [EVENTS_CSV_HEADER, ...Array.from({ length: n }, (_, k) => eventCsvRow(from + k))].join('\n') + '\n';
}

export function event(i: number, over: Record<string, unknown> = {}): Record<string, any> {
  return {
    event: 'bull_bar',
    intent: 'long',
    instrument: 'HYPERLIQUID:BTC',
    timeframe: '5m',
    start: '2026-06-28T10:05:00Z',
    end: '2026-06-28T10:10:00Z',
    bar_index: i,
    payload: { range: 42, body_pct: 0.81 },
    ...over,
  };
}

export const EVENTS_SUMMARY = {
  definition: 'bull-bar',
  events: 25690,
  days: 90,
  events_per_day: 285.44,
  avg_event_duration_seconds: 300,
  datasets: [
    { instrument: 'HYPERLIQUID:BTC', timeframe: '5m', events: 12910, days: 90, events_per_day: 143.44, from: '2026-06-28T10:00:00Z', to: '2026-09-26T10:00:00Z', avg_event_duration_seconds: 300 },
    { instrument: 'HYPERLIQUID:ETH', timeframe: '5m', events: 12780, days: 90, events_per_day: 142, from: '2026-06-28T10:00:00Z', to: '2026-09-26T10:00:00Z', avg_event_duration_seconds: 300 },
  ],
  collecting: [],
  failed: [],
};

export const COLLECT_QUEUED = {
  definition: 'bull-bar@4',
  instrument: 'HYPERLIQUID:BTC',
  timeframe: '5m',
  window: { from: '2025-09-26T09:25:00Z', to: '2026-09-26T09:25:00Z' },
  covered: false,
  collections: 2,
  held: 0,
  next: 'Poll GET /scripts/bull-bar/events/summary until `collecting` is empty, then read GET /scripts/bull-bar/events.',
};

// ── library ──

export const LIBRARY_PAGE = {
  data: [
    {
      ref: 'chartnaut/rsi',
      kind: 'indicator',
      slug: 'rsi',
      name: 'RSI',
      description: 'Relative Strength Index.',
      author: 'chartnaut',
      official: true,
      owned: false,
      installed: false,
      visibility: 'public',
      latest_version: 6,
      adoptions: 0,
      tags: [],
      category: 'custom',
      created_at: '2026-05-12T17:01:20.306749Z',
      updated_at: '2026-09-19T22:45:13.341671Z',
      app_url: `${APP}/indicators?indicator_id=45`,
    },
    {
      ref: 'jane/rsi-divergence',
      kind: 'indicator',
      slug: 'rsi-divergence',
      name: 'RSI divergence',
      description: 'Marks regular bullish and bearish divergences between price and RSI.',
      author: 'jane',
      official: false,
      owned: false,
      installed: true,
      visibility: 'public',
      latest_version: 4,
      adoptions: 12,
      tags: ['momentum', 'divergence'],
      category: 'momentum',
      created_at: '2026-07-02T09:14:38.220417Z',
      updated_at: '2026-09-08T16:31:05.918204Z',
      app_url: `${APP}/indicators?indicator_id=1187`,
    },
  ],
  next_cursor: '2',
};

export const LIBRARY_SCRIPT = {
  ref: 'jane/orb-breakout',
  kind: 'definition',
  slug: 'orb-breakout',
  name: 'Opening range breakout',
  description: 'Fires when BTC closes outside the first 30-minute range of the UTC day.',
  author: 'jane',
  official: false,
  owned: false,
  installed: true,
  visibility: 'public',
  latest_version: 7,
  adoptions: 41,
  tags: ['breakout', 'opening-range'],
  category: 'breakout',
  created_at: '2026-06-18T11:27:44.105392Z',
  updated_at: '2026-09-14T07:52:19.663018Z',
  app_url: `${APP}/research?flow_id=2291`,
  interface: {
    settings: { range_minutes: { type: 'number', default: 30 } },
    events: [
      { id: 'break_long', intent: 'signal', payload_keys: ['range_high', 'range_low'] },
      { id: 'break_short', intent: 'signal', payload_keys: ['range_high', 'range_low'] },
    ],
  },
  version: 7,
  dependencies: [{ ref: 'atr', as: 'atr', version: 3 }],
};
