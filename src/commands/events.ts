import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import type { Env } from '../env.js';
import { cell, shortTime, table } from '../output.js';
import { readProjectConfig } from '../project.js';
import { EXIT, exitCodeForRun } from '../errors.js';
import { fetchCsvPages, type PageSizes } from './run.js';
import { parseInstruments, parseTimeframe, parseWindow, type RunFlags } from '../runargs.js';

/** GET /scripts/{slug}/events page size: 100 by default, 1000 at most. */
const EVENTS_PAGES: PageSizes = { def: 100, max: 1000 };

const COLLECT_POLLS = 400;
const COLLECT_POLL_MS = 3000;

/**
 * Whether a row of events/summary `collecting` / `failed` belongs to the collection just started:
 * same instrument and timeframe, and a window that overlaps the requested one. The summary lists
 * every collection of the definition, including other instruments' and earlier ones.
 */
export function isThisCollection(row: any, res: any): boolean {
  if (row?.instrument && res?.instrument && row.instrument !== res.instrument) return false;
  if (row?.timeframe && res?.timeframe && row.timeframe !== res.timeframe) return false;
  const t = (s: unknown) => (typeof s === 'string' && s ? Date.parse(s) : NaN);
  const [rf, rt, wf, wt] = [t(row?.from), t(row?.to), t(res?.window?.from), t(res?.window?.to)];
  if (![rf, rt, wf, wt].some(Number.isNaN) && (rt <= wf || rf >= wt)) return false;
  return true;
}

/** A definition's stored events: everything it recorded wherever it ran over history. */
export function registerEvents(program: Command, env: Env): void {
  program
    .command('events')
    .description("a definition's stored events from running over history, or --summary for counts per instrument and timeframe")
    .argument('<definition>', 'your definition slug')
    .option('--summary', 'totals, one row per instrument × timeframe, and collections still running')
    .option('--on <instrument>', 'only this instrument')
    .option('--tf <timeframe>', 'only this timeframe')
    .option('--event <id>', 'only this event id')
    .option('--from <date>', 'events starting at or after this time (RFC 3339)')
    .option('--to <date>', 'events ending at or before this time (RFC 3339)')
    .option('--version <n>', 'only events recorded by this version')
    .option('--where <json>', 'payload filters, e.g. \'[{"key":"range","op":"gt","value":10}]\'')
    .option('--limit <n>', 'page size (max 1000)')
    .option('--cursor <cursor>', 'page cursor')
    .option('--all', 'follow next_cursor and return every event')
    .addOption(new Option('--format <format>', 'response format').choices(['json', 'csv']).default('json'))
    .option('--out <file>', 'write to file.csv or file.json')
    .action(async (slug: string, opts: any, cmd: Command) => {
      const base = `/scripts/${encodeURIComponent(slug)}/events`;
      if (opts.summary) {
        const s = (await env.client.get<any>(`${base}/summary`, { query: { version: opts.version } })).data;
        if (env.isJson(cmd)) return env.printJson(s);
        env.out(`${s.definition}: ${s.events} events over ${s.days} days (${Number(s.events_per_day ?? 0).toFixed(2)}/day)`);
        if (s.datasets?.length) {
          env.out(
            table(
              ['instrument', 'tf', 'events', 'from', 'to'],
              s.datasets.map((d: any) => [d.instrument, d.timeframe, d.events, shortTime(d.from), shortTime(d.to)]),
            ),
          );
        } else env.out('nothing collected yet: chartnaut collect ' + slug + ' --on <instrument> --tf <tf> --last 90d');
        if (s.collecting?.length) env.out(`collecting: ${s.collecting.length} window(s) still running`);
        if (s.failed?.length) env.out(`failed: ${s.failed.length} collection(s) failed (${s.failed.map((f: any) => f.failure_kind).join(', ')})`);
        return;
      }
      const query: Record<string, any> = {
        instrument: opts.on, timeframe: opts.tf, event: opts.event, from: opts.from, to: opts.to,
        version: opts.version, where: opts.where, limit: opts.limit, cursor: opts.cursor,
      };
      const csv = opts.format === 'csv' || String(opts.out ?? '').endsWith('.csv');
      let data: any;
      let more: string | undefined;
      if (csv) {
        // CSV has no next_cursor, so it is paged here: every page under one header, unless an
        // explicit --cursor / --limit without --all asks for one page.
        const onePage = !opts.all && (opts.cursor !== undefined || opts.limit !== undefined);
        const q = onePage || query.limit !== undefined ? query : { ...query, limit: EVENTS_PAGES.max };
        const res = await fetchCsvPages(env, base, q, !onePage, EVENTS_PAGES);
        data = res.text;
        more = res.more;
      } else {
        data = (await env.client.get<any>(base, { query })).data;
        while (opts.all && data?.next_cursor) {
          const next = (await env.client.get<any>(base, { query: { ...query, cursor: data.next_cursor } })).data;
          data.events = [...data.events, ...(next.events ?? [])];
          data.next_cursor = next.next_cursor;
        }
      }
      if (opts.out) {
        const target = path.resolve(env.ctx.cwd, opts.out);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, csv ? String(data) : JSON.stringify(data, null, 2) + '\n');
        env.out(`wrote ${path.relative(env.ctx.cwd, target) || target}`);
        if (more) env.err(`more: --cursor ${more} (or --all)`);
        return;
      }
      if (more) env.err(`more: --cursor ${more} (or --all)`);
      if (csv) return env.out(String(data));
      if (env.isJson(cmd)) return env.printJson(data);
      const rows = (data.events ?? []).map((e: any) => [shortTime(e.start), e.instrument, e.timeframe, e.event, cell(e.payload)]);
      env.out(rows.length ? table(['start', 'instrument', 'tf', 'event', 'payload'], rows) : 'no events');
      env.out(`${data.total} total` + (data.next_cursor ? ` · more: --cursor ${data.next_cursor} (or --all)` : ''));
    });

  program
    .command('collect')
    .description('run a definition over history on a window so its events are stored for studies; only the missing part runs')
    .argument('<definition>', 'your definition slug')
    .option('--on <instrument>', 'instrument')
    .option('--tf <timeframe>', 'timeframe')
    .option('--from <date>', 'window start')
    .option('--to <date>', 'window end')
    .option('--last <span>', 'window as a span back from now, e.g. 90d')
    .option('--bars <n>', 'window as a bar count')
    .option('--version <n>', 'collect this version (default: latest)')
    .option('--wait', 'wait until collection finishes, then print the summary')
    .action(async (slug: string, opts: RunFlags & { version?: string; wait?: boolean }, cmd: Command) => {
      const defaults = readProjectConfig(env.ctx.cwd).defaults ?? {};
      const [instrument] = parseInstruments(opts.on, defaults);
      const body = {
        instrument,
        timeframe: parseTimeframe(opts.tf, defaults),
        window: parseWindow(opts, defaults),
        version: opts.version ? Number(opts.version) : undefined,
      };
      const res = (await env.client.post<any>(`/scripts/${encodeURIComponent(slug)}/collect`, { body })).data;
      let failed: any[] = [];
      let timedOut = false;
      if (opts.wait && !res.covered) {
        timedOut = true;
        for (let i = 0; i < COLLECT_POLLS; i++) {
          const s = (await env.client.get<any>(`/scripts/${encodeURIComponent(slug)}/events/summary`)).data;
          const ours = (rows: any[] | undefined) => (rows ?? []).filter((row) => isThisCollection(row, res));
          if (!ours(s.collecting).length) {
            res.summary = s;
            failed = ours(s.failed);
            timedOut = false;
            break;
          }
          await env.ctx.sleep(COLLECT_POLL_MS);
        }
      }
      // The worst failure decides the exit code: 2 for a failed collection, 5 when retrying may help.
      for (const f of failed) env.fail(exitCodeForRun({ status: 'failed', failure: { kind: f.failure_kind || undefined } }));
      if (timedOut) env.fail(EXIT.RETRYABLE);
      if (env.isJson(cmd)) return env.printJson(res);
      env.out(res.covered ? `${res.definition} on ${res.instrument} ${res.timeframe}: already collected` : `${res.definition} on ${res.instrument} ${res.timeframe}: collecting ${res.collections} window(s)`);
      for (const f of failed) {
        env.err(`failed: ${f.failure_kind || 'unknown'}: ${f.instrument || res.instrument} ${f.timeframe || res.timeframe} ${shortTime(f.from)} → ${shortTime(f.to)}`);
      }
      if (timedOut) env.err(`error: still collecting after ${(COLLECT_POLLS * COLLECT_POLL_MS) / 60000} minutes; check: chartnaut events ${slug} --summary`);
      else if (res.summary) env.out(`${res.summary.events} events collected in total`);
      else if (!res.covered) env.out(`check: chartnaut events ${slug} --summary`);
    });
}
