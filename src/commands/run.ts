import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Command, Option } from 'commander';
import type { Env } from '../env.js';
import { ApiError, CliError, EXIT, exitCodeForErrorCode, exitCodeForRun, formatApiError, formatDiagnostic } from '../errors.js';
import { cell, shortTime, table } from '../output.js';
import { parseKind, readProjectConfig, displayPath } from '../project.js';
import { buildRunRequests, type CreateRunRequest, type RunFlags } from '../runargs.js';
import { csvDataRows, mergeCsvPages } from '../csv.js';

export const RUN_CONCURRENCY = 3;
/** Long-poll length for GET /runs/{id}?wait= (the server's maximum). */
export const WAIT_SECONDS = 30;
/**
 * How long run creation keeps retrying 429 busy / rate_limited, honouring Retry-After. A plan's
 * heavy-call places (validate, save, collect, run start) are shared by every call the account
 * makes, and the queued+running cap answers busy with Retry-After 15, so a few seconds is too short.
 */
export const CREATE_RETRY_BUDGET_MS = 180_000;
/** A poll that comes back unfinished sooner than this (the server's wait places were full) waits before the next one. */
export const MIN_POLL_MS = 2000;
/** Server default and maximum page size for GET /runs/{id}/results. */
export const RESULTS_PAGE = 5000;
export const RESULTS_PAGE_MAX = 50000;

export interface Run {
  id: string;
  kind?: string;
  script?: string;
  instrument?: string;
  timeframe?: string;
  window?: { from?: string; to?: string };
  status: string;
  progress?: { pct?: number; phase?: string };
  failure?: { kind?: string; message?: string; retryable?: boolean; diagnostics?: any[] } | null;
  summary?: Record<string, any> | null;
  console?: { level?: string; message?: string }[];
  usage?: { bars?: number; compute_units?: number };
  app_url?: string;
  created_at?: string;
}

export const isTerminal = (s: string | undefined) => s === 'succeeded' || s === 'failed' || s === 'cancelled';

const collect = (v: string, prev: string[] = []) => [...prev, v];

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Creates a run and, when wait is set, polls it to the end. The create call never holds a `wait`:
 * POST /runs is a heavy call and a waiting one keeps its heavy place for the whole wait, so a fan-out
 * wider than the plan's concurrent_heavy got 429 busy. GET /runs/{id} is not heavy, so the waiting
 * happens there.
 */
export async function startRun(env: Env, req: CreateRunRequest, wait: boolean): Promise<Run> {
  // One key per logical run, reused by the client's retries.
  const key = randomUUID();
  const res = await env.client.post<Run>('/runs', { body: { ...req, wait: 0 }, idempotencyKey: key, retryBudgetMs: CREATE_RETRY_BUDGET_MS });
  let run = res.data;
  if (wait) run = await waitForRun(env, run);
  return run;
}

export async function waitForRun(env: Env, run: Run, onPoll?: (r: Run) => void): Promise<Run> {
  while (!isTerminal(run.status)) {
    onPoll?.(run);
    const started = Date.now();
    run = (await env.client.get<Run>(`/runs/${encodeURIComponent(run.id)}`, { query: { wait: WAIT_SECONDS } })).data;
    // Past the plan's concurrent_waits the server answers at once instead of holding; don't spin.
    if (!isTerminal(run.status) && Date.now() - started < MIN_POLL_MS) await env.ctx.sleep(MIN_POLL_MS);
  }
  return run;
}

/** Default and maximum page size of an offset-paged endpoint (the server's parseLimit). */
export interface PageSizes {
  def: number;
  max: number;
}
export const RESULTS_PAGES: PageSizes = { def: RESULTS_PAGE, max: RESULTS_PAGE_MAX };

/** The page size the server will use for a request's `limit`. */
export function resultsPageSize(limit: unknown, sizes: PageSizes = RESULTS_PAGES): number {
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0) return sizes.def;
  return Math.min(n, sizes.max);
}

/**
 * Every CSV page of an offset-paged endpoint (run results, a definition's events), joined under one
 * header. The CSV body carries no next_cursor: the cursor is a row offset, so pages are requested at
 * offset + page size until one comes back short. A study's CSV (one block, `keys=`) is not paged by
 * the server and is fetched once.
 */
export async function fetchCsvPages(
  env: Env,
  p: string,
  query: Record<string, any>,
  paged: boolean,
  sizes: PageSizes = RESULTS_PAGES,
): Promise<{ text: string; more?: string }> {
  const size = resultsPageSize(query.limit, sizes);
  const first = (await env.client.get<string>(p, { query: { ...query, format: 'csv' }, text: true })).data;
  const start = query.cursor === undefined || query.cursor === null || query.cursor === '' ? 0 : Number(query.cursor);
  const full = (text: string) => csvDataRows(text) >= size;
  if (!Number.isInteger(start) || start < 0) return { text: first };
  if (!paged) return { text: first, more: full(first) ? String(start + size) : undefined };
  const pages = [first];
  let offset = start;
  while (full(pages[pages.length - 1]!)) {
    offset += size;
    const next = (await env.client.get<string>(p, { query: { ...query, format: 'csv', cursor: String(offset) }, text: true })).data;
    // A response that ignores the cursor would repeat itself forever.
    if (next === pages[pages.length - 1] || csvDataRows(next) === 0) break;
    pages.push(next);
  }
  return { text: mergeCsvPages(pages) };
}

/** GET /runs/{id}/results; csv → text, json → every page merged into one document (allPages). */
export async function fetchResults(env: Env, runId: string, format: 'csv' | 'json', query: Record<string, any> = {}, allPages = true, kind?: string): Promise<any> {
  const p = `/runs/${encodeURIComponent(runId)}/results`;
  if (format === 'csv') {
    const study = kind === 'study' || (kind === undefined && Boolean(query.keys));
    return (await fetchCsvPages(env, p, query, allPages && !study)).text;
  }
  let page = (await env.client.get<any>(p, { query: { ...query, format: 'json' } })).data;
  const merged = page;
  while (allPages && page?.next_cursor) {
    page = (await env.client.get<any>(p, { query: { ...query, format: 'json', cursor: page.next_cursor } })).data;
    mergePage(merged, page);
  }
  if (allPages && merged && typeof merged === 'object') merged.next_cursor = null;
  return merged;
}

export function mergePage(into: any, page: any): void {
  if (Array.isArray(page?.outputs)) {
    into.outputs ??= [];
    for (const o of page.outputs) {
      const existing = into.outputs.find((x: any) => x.id === o.id);
      if (existing) existing.points = [...(existing.points ?? []), ...(o.points ?? [])];
      else into.outputs.push(o);
    }
  }
  if (Array.isArray(page?.events)) into.events = [...(into.events ?? []), ...page.events];
  if (Array.isArray(page?.results)) into.results = [...(into.results ?? []), ...page.results];
  if (Array.isArray(page?.caveats)) into.caveats = [...new Set([...(into.caveats ?? []), ...page.caveats])];
  if (page?.truncated) into.truncated = true;
}

export function outPathFor(file: string, instrument: string, many: boolean): string {
  if (!many) return file;
  const ext = path.extname(file);
  const safe = instrument.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'instrument';
  return `${file.slice(0, file.length - ext.length)}.${safe}${ext}`;
}

// ───────────────────────────── rendering ─────────────────────────────

export function renderRun(run: Run): string {
  const lines: string[] = [];
  const win = run.window ? `${shortTime(run.window.from)} → ${shortTime(run.window.to)}` : '';
  lines.push(
    [`run ${run.id}`, run.status, run.kind, run.script, run.instrument, run.timeframe, win].filter(Boolean).join('  '),
  );
  if (!isTerminal(run.status) && run.progress) {
    lines.push(`progress: ${run.progress.pct ?? 0}%${run.progress.phase ? ` (${run.progress.phase})` : ''}`);
  }
  if (run.failure) {
    lines.push(`failed: ${run.failure.kind ?? 'unknown'}: ${run.failure.message ?? ''}${run.failure.retryable ? ' (retryable)' : ''}`);
    for (const d of run.failure.diagnostics ?? []) lines.push(formatDiagnostic(d));
  }
  if (run.summary) lines.push(renderSummary(run.kind, run.summary));
  const consoleLines = run.console ?? [];
  if (consoleLines.length) {
    lines.push('console:');
    for (const c of consoleLines.slice(0, 20)) lines.push(`  [${c.level ?? 'log'}] ${c.message ?? ''}`);
    if (consoleLines.length > 20) lines.push(`  … ${consoleLines.length - 20} more (use --json)`);
  }
  if (run.usage) lines.push(`usage: ${cell(run.usage.bars)} bars, ${cell(run.usage.compute_units)} CU`);
  if (run.app_url) lines.push(`app: ${run.app_url}`);
  return lines.join('\n');
}

export function renderSummary(kind: string | undefined, s: Record<string, any>): string {
  const lines: string[] = [];
  const k = kind ?? (s.outputs ? 'indicator' : s.by_event ? 'definition' : s.metrics ? 'study' : '');
  if (k === 'indicator') {
    lines.push(`bars: ${cell(s.bars)}`);
    const rows = Object.entries(s.outputs ?? {}).map(([id, o]: [string, any]) => [id, o?.last, o?.min, o?.max, o?.count]);
    if (rows.length) lines.push(table(['output', 'last', 'min', 'max', 'count'], rows));
  } else if (k === 'definition') {
    lines.push(`bars: ${cell(s.bars)}  events_total: ${cell(s.events_total)}`);
    const rows = Object.entries(s.by_event ?? {}).map(([id, n]) => [id, n]);
    if (rows.length) lines.push(table(['event', 'count'], rows));
  } else if (k === 'study') {
    lines.push(`events_processed: ${cell(s.events_processed)}`);
    const rows = Object.entries(s.metrics ?? {}).map(([key, v]) => [key, v]);
    if (rows.length) lines.push(table(['metric', 'value'], rows));
  } else {
    lines.push(JSON.stringify(s, null, 2));
  }
  return lines.join('\n');
}

type RunOutcome = { instrument: string; run?: Run; error?: ApiError };

/** One row per instrument, columns from the union of summary keys. */
export function renderComparison(outcomes: RunOutcome[]): string {
  const kind = outcomes.find((o) => o.run?.kind)?.run?.kind;
  const cols: string[] = [];
  const addCol = (c: string) => (cols.includes(c) ? undefined : cols.push(c));
  const values = outcomes.map((o) => {
    const v: Record<string, unknown> = {};
    const s = o.run?.summary ?? {};
    if (kind === 'indicator') {
      v.bars = s.bars;
      for (const [id, out] of Object.entries<any>(s.outputs ?? {})) v[`${id}.last`] = out?.last;
    } else if (kind === 'definition') {
      v.bars = s.bars;
      v.events_total = s.events_total;
      for (const [id, n] of Object.entries(s.by_event ?? {})) v[id] = n;
    } else if (kind === 'study') {
      v.events_processed = s.events_processed;
      for (const [key, m] of Object.entries(s.metrics ?? {})) v[key] = m;
    }
    Object.keys(v).forEach(addCol);
    return v;
  });
  const rows = outcomes.map((o, i) => [
    o.instrument,
    o.error ? 'error' : o.run?.status,
    ...cols.map((c) => values[i]![c]),
    o.error ? `${o.error.code}: ${o.error.body.message}` : o.run?.failure ? `${o.run.failure.kind}: ${o.run.failure.message ?? ''}` : o.run?.id,
  ]);
  return table(['instrument', 'status', ...cols, 'run / error'], rows);
}

export function renderResults(data: any): string {
  if (typeof data === 'string') return data;
  const lines: string[] = [];
  if (data?.kind === 'indicator') {
    const rows = (data.outputs ?? []).map((o: any) => {
      const pts = o.points ?? [];
      const last = pts[pts.length - 1];
      return [o.id, o.kind, pts.length, last ? new Date(last.t * 1000).toISOString() : '-', last?.v];
    });
    lines.push(table(['output', 'kind', 'points', 'last_time', 'last_value'], rows));
  } else if (data?.kind === 'definition') {
    const rows = (data.events ?? []).map((e: any) => [shortTime(e.start), e.event, e.instrument, e.payload]);
    lines.push(`${(data.events ?? []).length} events`);
    if (rows.length) lines.push(table(['start', 'event', 'instrument', 'payload'], rows));
  } else if (data?.kind === 'study') {
    for (const r of data.results ?? []) {
      const head = `[${r.kind}] ${r.key}${r.title ? ` · ${r.title}` : ''}`;
      if (r.kind === 'metric' && r.data && typeof r.data === 'object' && 'value' in r.data) {
        lines.push(`${head}: ${cell(r.data.value)}`);
      } else if (r.omitted || r.data === undefined) {
        lines.push(`${head}: ${r.size ?? '?'} rows omitted (fetch with --keys ${r.key})`);
      } else if (Array.isArray(r.data) && r.data.length && typeof r.data[0] === 'object' && !Array.isArray(r.data[0])) {
        const cols = [...new Set(r.data.flatMap((x: any) => Object.keys(x ?? {})))] as string[];
        lines.push(head);
        lines.push(table(cols, r.data.map((x: any) => cols.map((c) => x?.[c]))));
      } else {
        lines.push(head);
        lines.push(JSON.stringify(r.data, null, 2));
      }
    }
    for (const c of data.caveats ?? []) lines.push(`caveat: ${c}`);
    if (data.truncated) lines.push('note: response was truncated at the size cap; fetch fewer keys');
  } else {
    lines.push(JSON.stringify(data, null, 2));
  }
  if (data?.next_cursor) lines.push(`more: --cursor ${data.next_cursor} (or --all)`);
  return lines.join('\n');
}

// ───────────────────────────── commands ─────────────────────────────

export function registerRun(program: Command, env: Env): void {
  program
    .command('run')
    .description('run a local script folder/file (inline) or a saved ref on Chartnaut servers')
    .argument('<target>', 'path to a script folder or file, or a ref (slug, slug@3, author/slug, chartnaut/rsi)')
    .option('--on <instruments>', 'instrument, or comma list (one run each, max 3 at once)')
    .option('--tf <timeframe>', 'timeframe (1m 5m 15m 30m 1h 2h 4h 1d 1w)')
    .option('--from <date>', 'window start (ISO date/time)')
    .option('--to <date>', 'window end (ISO date/time, default now)')
    .option('--last <span>', 'window as a span back from now, e.g. 30d, 12w, 6m, 1y')
    .option('--bars <n>', 'window as a bar count')
    .option('--set <key=value>', 'setting override (repeatable)', collect, [])
    .option('--kind <kind>', 'kind for a lone file outside a script folder')
    .option('--label <text>', 'free-text label shown in the app')
    .option('--wait', 'wait for the run to finish (default)', true)
    .option('--no-wait', 'print the run id and exit')
    .option('--out <file>', 'write full results to file.csv or file.json')
    .action(async (target: string, opts: RunFlags & { wait: boolean; out?: string }, cmd: Command) => {
      const cfg = readProjectConfig(env.ctx.cwd);
      const kindHint = opts.kind ? parseKind(opts.kind) : undefined;
      let outFormat: 'csv' | 'json' | undefined;
      if (opts.out) {
        const ext = path.extname(opts.out).toLowerCase();
        if (ext !== '.csv' && ext !== '.json') throw new CliError('error: invalid_request: --out must end in .csv or .json', EXIT.USAGE);
        outFormat = ext === '.csv' ? 'csv' : 'json';
      }
      const reqs = buildRunRequests(target, opts, cfg.defaults ?? {}, env.ctx.cwd, kindHint);
      const wait = opts.wait !== false;
      const json = env.isJson(cmd);

      if (reqs.length === 1) {
        const run = await startRun(env, reqs[0]!, wait);
        if (json) env.printJson(run);
        else env.out(wait ? renderRun(run) : `${run.id}  ${run.status}${run.app_url ? `  ${run.app_url}` : ''}`);
        env.fail(exitCodeForRun(run));
        if (outFormat && run.status === 'succeeded') await writeOut(env, run, opts.out!, outFormat, false, json);
        return;
      }

      const outcomes: RunOutcome[] = await pool(reqs, RUN_CONCURRENCY, async (req) => {
        try {
          return { instrument: req.instrument, run: await startRun(env, req, wait) };
        } catch (e) {
          if (e instanceof ApiError) return { instrument: req.instrument, error: e };
          throw e;
        }
      });
      for (const o of outcomes) {
        if (o.error) env.fail(exitCodeForErrorCode(o.error.code, o.error.status));
        else if (o.run) env.fail(exitCodeForRun(o.run));
      }
      if (json) {
        env.printJson(outcomes.map((o) => o.run ?? { instrument: o.instrument, error: o.error!.body, diagnostics: o.error!.diagnostics }));
      } else if (!wait) {
        env.out(table(['instrument', 'run', 'status'], outcomes.map((o) => [o.instrument, o.run?.id, o.error ? `error: ${o.error.code}` : o.run?.status])));
      } else {
        env.out(renderComparison(outcomes));
        for (const o of outcomes) {
          if (o.error) for (const l of formatApiError(o.error)) env.err(`${o.instrument}: ${l}`);
          else if (o.run?.app_url) env.out(`${o.instrument}: ${o.run.app_url}`);
        }
      }
      if (outFormat) {
        for (const o of outcomes) if (o.run?.status === 'succeeded') await writeOut(env, o.run, opts.out!, outFormat, true, json);
      }
    });

  const runs = program
    .command('runs')
    .description('list recent runs; see also runs get|results|cancel')
    .option('--script <slug>', 'filter by script slug')
    .addOption(new Option('--source <source>', 'api: runs started through the API; app: study runs made in the app; all: both').choices(['api', 'app', 'all']))
    .addOption(new Option('--status <status>', 'filter by status').choices(['queued', 'running', 'succeeded', 'failed', 'cancelled']))
    .option('--limit <n>', 'page size')
    .option('--cursor <cursor>', 'page cursor')
    .action(async (opts: { script?: string; source?: string; status?: string; limit?: string; cursor?: string }, cmd: Command) => {
      const res = await env.client.get<any>('/runs', { query: { script: opts.script, source: opts.source, status: opts.status, limit: opts.limit, cursor: opts.cursor } });
      if (env.isJson(cmd)) return env.printJson(res.data);
      const rows = (res.data?.data ?? []).map((r: Run) => [r.id, r.kind, r.script, r.instrument, r.timeframe, r.status, shortTime(r.created_at)]);
      env.out(rows.length ? table(['id', 'kind', 'script', 'instrument', 'tf', 'status', 'created'], rows) : 'no runs');
      if (res.data?.next_cursor) env.out(`more: --cursor ${res.data.next_cursor}`);
    });

  runs
    .command('get')
    .description('status, progress and summary of a run')
    .argument('<id>')
    .option('--watch', 'poll until the run finishes')
    .action(async (id: string, opts: { watch?: boolean }, cmd: Command) => {
      let run = (await env.client.get<Run>(`/runs/${encodeURIComponent(id)}`)).data;
      if (opts.watch) {
        run = await waitForRun(env, run, (r) =>
          env.err(`${r.id}  ${r.status}  ${r.progress?.pct ?? 0}%${r.progress?.phase ? ` ${r.progress.phase}` : ''}`),
        );
      }
      if (env.isJson(cmd)) env.printJson(run);
      else env.out(renderRun(run));
      env.fail(exitCodeForRun(run));
    });

  runs
    .command('results')
    .description('what a run produced: series, events or study blocks')
    .argument('<id>')
    .option('--keys <keys>', 'study: comma list of result keys to return in full')
    .option('--full', 'study: return every block in full')
    .option('--outputs <ids>', 'indicator: comma list of output ids')
    .option('--event <id>', 'definition: filter by event id')
    .option('--from <date>', 'only results from this time')
    .option('--to <date>', 'only results up to this time')
    .addOption(new Option('--format <format>', 'response format').choices(['json', 'csv']).default('json'))
    .option('--limit <n>', 'page size')
    .option('--cursor <cursor>', 'page cursor')
    .option('--all', 'follow every page and merge them (csv: one header row)')
    .action(async (id: string, opts: any, cmd: Command) => {
      // `runs` has its own --limit / --cursor, and commander hands a parent's options to the parent
      // wherever they appear on the line, so `runs results <id> --limit 2` lands there.
      const inherited = cmd.parent?.opts() ?? {};
      const limit = opts.limit ?? inherited.limit;
      const cursor = opts.cursor ?? inherited.cursor;
      const query = { keys: opts.keys, full: opts.full ? true : undefined, outputs: opts.outputs, event: opts.event, from: opts.from, to: opts.to, limit, cursor };
      if (opts.format === 'csv') {
        // keys= means a study block, which the server returns whole.
        const csv = await fetchCsvPages(env, `/runs/${encodeURIComponent(id)}/results`, query, Boolean(opts.all) && !opts.keys);
        env.out(csv.text);
        if (csv.more && !opts.keys) env.err(`more: --cursor ${csv.more} (or --all)`);
        return;
      }
      const data = await fetchResults(env, id, opts.format, query, Boolean(opts.all));
      if (env.isJson(cmd)) return env.printJson(data);
      env.out(renderResults(data));
    });

  runs
    .command('cancel')
    .description('cancel a queued or running run')
    .argument('<id>')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const run = (await env.client.post<Run>(`/runs/${encodeURIComponent(id)}/cancel`)).data;
      if (env.isJson(cmd)) env.printJson(run);
      else env.out(`${run.id}  ${run.status}`);
    });
}

async function writeOut(env: Env, run: Run, file: string, format: 'csv' | 'json', many: boolean, json: boolean): Promise<void> {
  const target = path.resolve(env.ctx.cwd, outPathFor(file, run.instrument ?? run.id, many));
  const data = await fetchResults(env, run.id, format, {}, true, run.kind);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, format === 'csv' ? String(data) : JSON.stringify(data, null, 2) + '\n');
  const msg = `wrote ${displayPath(env.ctx.cwd, target)}`;
  if (json) env.err(msg);
  else env.out(msg);
}
