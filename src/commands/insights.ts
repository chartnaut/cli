import { Command, Option } from 'commander';
import type { Env } from '../env.js';
import { shortTime, table } from '../output.js';
import { CliError, EXIT } from '../errors.js';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w'];

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

function renderInsight(i: any): string {
  const scope = i.scope_dimensions?.length ? i.scope_dimensions.join(', ') : 'none (one card)';
  return [
    `${i.id}  ${i.name}`,
    `on ${i.definition} · ${i.instrument} ${i.timeframe}${i.profile ? ` · profile ${i.profile}` : ''}`,
    `from ${i.study}${i.study_version ? `@${i.study_version}` : ''}, ${shortTime(i.window?.from)} → ${shortTime(i.window?.to)}`,
    `breakdown: ${scope}`,
    ...(i.description ? [i.description] : []),
    ...(i.app_url ? [`app: ${i.app_url}`] : []),
  ].join('\n');
}

function insightPath(id: string): string {
  if (!/^ins_\d+$/.test(id)) throw new CliError('error: invalid_request: an insight id looks like ins_123 (chartnaut insights lists them)', EXIT.USAGE);
  return `/insights/${id}`;
}

/** Forward Insights: studies on the chart. */
export function registerInsights(program: Command, env: Env): void {
  const insights = program
    .command('insights')
    .description('Forward Insights (studies on the chart): list them; see also insights create|show|update|rm')
    .option('--definition <slug>', 'only insights on this definition')
    .option('--study <slug>', 'only insights made from this study')
    .option('--on <instrument>', 'only this instrument')
    .addOption(new Option('--tf <timeframe>', 'only this timeframe').choices(TIMEFRAMES))
    .option('--limit <n>', 'page size')
    .option('--cursor <cursor>', 'page cursor')
    .action(async (opts: any, cmd: Command) => {
      const res = await env.client.get<any>('/insights', {
        query: { definition: opts.definition, study: opts.study, instrument: opts.on, timeframe: opts.tf, limit: opts.limit, cursor: opts.cursor },
      });
      if (env.isJson(cmd)) return env.printJson(res.data);
      const rows = (res.data?.data ?? []).map((i: any) => [i.id, i.name, i.definition, i.instrument, i.timeframe, (i.scope_dimensions ?? []).join(',') || '-']);
      env.out(rows.length ? table(['id', 'name', 'definition', 'instrument', 'tf', 'breakdown'], rows) : 'no Forward Insights');
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
        dry_run: opts.dryRun ? true : undefined,
      };
      const res = (await env.client.post<any>('/insights', { body })).data;
      if (env.isJson(cmd)) return env.printJson(res);
      if (res.dry_run) {
        env.out(`dry run: ok, nothing saved. On ${res.definition}, breakdown: ${res.scope_dimensions?.join(', ') || 'none (one card)'}`);
      } else {
        env.out(renderInsight(res));
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
    .command('rm')
    .description('take an insight off your charts (the study and its runs are kept)')
    .argument('<id>', 'ins_…')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await env.client.delete(insightPath(id));
      if (env.isJson(cmd)) return env.printJson({ removed: id });
      env.out(`removed ${id}`);
    });
}
