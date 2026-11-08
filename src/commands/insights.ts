import { Command, Option } from 'commander';
import type { Env } from '../env.js';
import { shortTime, table } from '../output.js';
import { CliError, EXIT } from '../errors.js';
import { parseTimeframe } from '../runargs.js';
import { TIMEFRAMES } from '../project.js';

/** The preview card as text: each breakdown group's heading and its lines. */
export function renderCard(card: any): string {
  const out: string[] = [];
  const line = (l: any) => `  ${l.label}: ${l.value}${l.sample ? `  (${l.sample})` : ''}`;
  if (card?.heading) out.push(card.heading);
  for (const l of card?.lines ?? []) out.push(line(l));
  for (const g of card?.groups ?? []) {
    out.push(g.heading ?? '');
    for (const l of g.lines ?? []) out.push(line(l));
    if (g.note) out.push(`  note: ${g.note}`);
  }
  return out.join('\n');
}

/** "live", "paused" (over the plan's on-charts limit), or "-" when it isn't on the charts. */
export function activeLabel(i: any): string {
  return i?.active ? (i.active_state || 'live') : '-';
}

function renderInsight(i: any): string {
  const scope = i.scope_dimensions?.length ? i.scope_dimensions.join(', ') : 'none (one card)';
  return [
    `${i.id}  ${i.name}`,
    `on ${i.definition} · ${i.instrument} ${i.timeframe}${i.profile ? ` · profile ${i.profile}` : ''}`,
    `from ${i.study}${i.study_version ? `@${i.study_version}` : ''}, ${shortTime(i.window?.from)} → ${shortTime(i.window?.to)}`,
    `breakdown: ${scope}`,
    `on your charts: ${i.active ? (i.active_state === 'paused' ? 'paused (over your plan\'s limit)' : 'yes') : 'no (chartnaut insights activate ' + i.id + ')'}`,
    ...(i.valid_from ? [`out of sample from: ${shortTime(i.valid_from)}`] : []),
    ...(i.description ? [i.description] : []),
    ...(i.app_url ? [`app: ${i.app_url}`] : []),
  ].join('\n');
}

function insightId(id: string): string {
  if (!/^ins_\d+$/.test(id)) throw new CliError('error: invalid_request: an insight id looks like ins_123 (chartnaut insights lists them)', EXIT.USAGE);
  return id;
}

function insightPath(id: string): string {
  return `/insights/${insightId(id)}`;
}

/** "2 of 3 in use", or "2 in use (unlimited)". */
function slots(res: any): string {
  return res?.limit === 'unlimited' ? `${res.in_use ?? 0} in use (unlimited)` : `${res?.in_use ?? 0} of ${res?.limit} in use`;
}

/** Forward Insights: studies on the chart. */
export function registerInsights(program: Command, env: Env): void {
  const insights = program
    .command('insights')
    .description('Forward Insights (studies on the chart): list them; see also insights create|show|update|activate|deactivate|rm')
    .option('--definition <slug>', 'only insights on this definition')
    .option('--study <slug>', 'only insights made from this study')
    .option('--on <instrument>', 'only this instrument')
    .addOption(new Option('--tf <timeframe>', `only this timeframe (${TIMEFRAMES.join(', ')})`).argParser((v: string) => parseTimeframe(v)))
    .option('--limit <n>', 'page size')
    .option('--cursor <cursor>', 'page cursor')
    .action(async (opts: any, cmd: Command) => {
      const res = await env.client.get<any>('/insights', {
        query: { definition: opts.definition, study: opts.study, instrument: opts.on, timeframe: opts.tf, limit: opts.limit, cursor: opts.cursor },
      });
      if (env.isJson(cmd)) return env.printJson(res.data);
      const rows = (res.data?.data ?? []).map((i: any) => [i.id, i.name, i.definition, i.instrument, i.timeframe, (i.scope_dimensions ?? []).join(',') || '-', activeLabel(i)]);
      env.out(rows.length ? table(['id', 'name', 'definition', 'instrument', 'tf', 'breakdown', 'active'], rows) : 'no Forward Insights');
      if (res.data?.next_cursor) env.out(`more: --cursor ${res.data.next_cursor}`);
    });

  insights
    .command('create')
    .description("put a study run on the chart; the study must publish pin_cell (chartnaut docs chart-pins-overview)")
    .argument('<run>', 'a succeeded study run id (run_… or srun_…)')
    .requiredOption('--name <name>', 'what the chart shows as the card title')
    .option('--definition <slug>', 'your definition, when the study reads more than one')
    .option('--description <text>', 'what the card answers')
    .option('--no-replace', 'refuse instead of replacing an insight with the same name')
    .option('--replaces <id>', 're-save this insight (ins_…), whatever its name now; it stays active if it was')
    .option('--dry-run', 'check everything and print the preview card without saving')
    .action(async (run: string, opts: any, cmd: Command) => {
      // The list command owns --definition too, and commander hands a parent's option to the
      // parent wherever it appears on the line.
      const definition = opts.definition ?? cmd.parent?.opts().definition;
      const body = {
        run,
        name: opts.name,
        definition,
        description: opts.description,
        replace: opts.replace === false ? false : undefined,
        replaces: opts.replaces ? insightId(opts.replaces) : undefined,
        dry_run: opts.dryRun ? true : undefined,
      };
      const res = (await env.client.post<any>('/insights', { body })).data;
      if (env.isJson(cmd)) return env.printJson(res);
      if (res.dry_run) {
        env.out(`dry run: ok, nothing saved. On ${res.definition}, breakdown: ${res.scope_dimensions?.join(', ') || 'none (one card)'}`);
      } else {
        env.out(renderInsight(res));
        if (res.message) env.out(`\n${res.message}`);
      }
      const card = renderCard(res.preview?.card);
      if (card) env.out(`\npreview for one sample event:\n${card}`);
      if (res.dry_run) env.out(`\nsave it: chartnaut insights create ${run} --name ${JSON.stringify(opts.name)}${definition ? ` --definition ${definition}` : ''}`);
    });

  insights
    .command('show')
    .description('one Forward Insight')
    .argument('<id>', 'ins_…')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const i = (await env.client.get<any>(insightPath(id))).data;
      if (env.isJson(cmd)) return env.printJson(i);
      env.out(renderInsight(i));
    });

  insights
    .command('update')
    .description('rename an insight or change its description; to change its numbers, re-run the study and create again with the same name')
    .argument('<id>', 'ins_…')
    .option('--name <name>', 'new name')
    .option('--description <text>', 'new description')
    .action(async (id: string, opts: { name?: string; description?: string }, cmd: Command) => {
      if (opts.name === undefined && opts.description === undefined) throw new CliError('error: invalid_request: pass --name and/or --description', EXIT.USAGE);
      const i = (await env.client.patch<any>(insightPath(id), { body: { name: opts.name, description: opts.description } })).data;
      if (env.isJson(cmd)) return env.printJson(i);
      env.out(renderInsight(i));
    });

  insights
    .command('activate')
    .description("show an insight on your charts of its definition, instrument and timeframe; replaces the one active there. Your plan sets how many can be active at once")
    .argument('<id>', 'ins_…')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const res = (await env.client.post<any>(`${insightPath(id)}/activate`, {})).data;
      if (env.isJson(cmd)) return env.printJson(res);
      env.out(`active: ${id}${res.state === 'paused' ? ' (paused: over your plan\'s limit)' : ''} · ${slots(res)}`);
      if (res.replaced?.length) env.out(`replaced: ${res.replaced.join(', ')}`);
    });

  insights
    .command('deactivate')
    .description('stop showing an insight on your charts (it stays in your library)')
    .argument('<id>', 'ins_…')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const res = (await env.client.post<any>(`${insightPath(id)}/deactivate`, {})).data;
      if (env.isJson(cmd)) return env.printJson(res);
      env.out(`not active: ${id} · ${slots(res)}`);
    });

  insights
    .command('rm')
    .description('delete an insight from your library (the study and its runs are kept)')
    .argument('<id>', 'ins_…')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await env.client.delete(insightPath(id));
      if (env.isJson(cmd)) return env.printJson({ removed: id });
      env.out(`removed ${id}`);
    });
}
