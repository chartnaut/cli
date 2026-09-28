import type { ProjectDefaults } from './project.js';

/** One row of GET /docs: the server sends topic, title and depth (nesting in the docs outline). */
export interface DocTopic {
  topic: string;
  title?: string;
  depth?: number;
}

/** CLAUDE.md / AGENTS.md written by `chartnaut init`. Same text in both. */
export function agentGuide(defaults: Required<ProjectDefaults>, topics: DocTopic[] | undefined): string {
  const topicSection =
    topics && topics.length > 0
      ? [
          '| Topic | What it covers |',
          '|---|---|',
          ...topics.map((t) => `| \`${t.topic}\` | ${(t.title ?? '').replace(/\|/g, '\\|')} |`),
        ].join('\n')
      : 'The topic list could not be fetched when this file was written. Run `chartnaut docs` to list the topics.';

  return `# Chartnaut scripts

This folder holds Chartnaut indicators, definitions and studies. You edit the
files here; the \`chartnaut\` CLI validates them, runs them and saves them.

**Scripts run on Chartnaut servers, not on this machine.** Nothing here needs
market data, a build step or a local runtime. A run sends the source (or a saved
version) to Chartnaut, which executes it on the requested instrument and window
and returns what the script produced:

- an **indicator** returns output **series** (time, value per declared output)
- a **definition** returns **events** (one row per emitted event)
- a **study** returns **study blocks** (metrics, tables, distributions, …)

You never receive raw candles. Read the run summary, not the code, to judge a change.

## Layout

\`\`\`
chartnaut.json                 defaults for \`chartnaut run\`
indicators/<slug>/script.json  { kind, slug, name, entry, version }
indicators/<slug>/main.ts      the entry file
definitions/<slug>/...
studies/<slug>/...
\`\`\`

\`script.json.version\` is the version this folder was last pushed or pulled at.
\`chartnaut push\` sends it as \`base_version\`, so an edit made in the app is
never overwritten silently. Do not edit it by hand.

Project defaults: instrument \`${defaults.instrument}\`, timeframe \`${defaults.timeframe}\`, window \`${defaults.window}\`.

## The loop

Follow these steps in order for every change.

1. **Read the reference first.** \`chartnaut docs\` lists topics;
   \`chartnaut docs <topic>\` prints one as markdown. Read the topics for the kind
   you are writing before you write code. Do not guess the API.
2. **Create or edit.** \`chartnaut new <indicator|definition|study> <slug>\`
   writes a starter folder. Keep one script per folder.
3. **Validate.** \`chartnaut validate <path>\`. Free. Fix every \`error\` line
   (\`path:line: severity: message\`) before running.
4. **Run on a short window.** Indicators and definitions:
   \`chartnaut run <path> --last 30d\` runs the local files inline; nothing is saved.
   Studies cannot run inline: push the study first (\`chartnaut push <path>\`, step 7),
   then run the saved version by slug: \`chartnaut run <slug> --last 30d\`.
5. **Read the summary.** Indicator: last/min/max per output. Definition:
   \`events_total\` and counts per event. Study: the summary holds only
   \`events_processed\`; read the metrics with \`chartnaut runs results <id>\`
   (metric blocks come back without \`--full\`). Blank outputs or zero events usually
   mean a logic bug, not a data problem.
6. **Widen.** The same \`run\` with \`--last 90d\`, then other instruments with
   \`--on BTC,ETH\`. Use \`--out results.csv\` when you need every row.
7. **Push.** \`chartnaut push <path> -m "what changed"\` saves a new immutable
   version. On a version conflict, \`chartnaut pull <slug>\` and re-apply, or
   \`--force\` only if the user agrees to overwrite the app's version.

## Getting the full results

The run summary is a digest. Fetch the rest by run id (every \`run\` prints it; \`--json\` gives it as \`id\`):

| Kind | Command | What comes back |
|---|---|---|
| Indicator | \`chartnaut runs results <id> --all\` | every output's points \`{t, v}\` (unix seconds); \`--outputs ema\` narrows |
| Definition | \`chartnaut runs results <id> --all\` | every event: \`event\`, \`start\`, \`end\`, \`payload\`; \`--event <id>\` narrows |
| Study | \`chartnaut runs results <id> --full\` | every block. Without \`--full\` only metrics carry data; other blocks say \`omitted\` with a \`size\`. Ask for one with \`--keys rows\` |

- One study response carries at most 1 MB of block data in total, even with \`--full\`:
  blocks that do not fit are omitted and the response says \`truncated: true\`. Ask for
  fewer blocks with \`--keys\`, or get one table block whole with
  \`chartnaut runs results <id> --keys <key> --format csv\`.
- \`--format csv\` (or \`run … --out file.csv\`) is the easiest way to analyse rows.
- \`chartnaut runs --source app\` lists study runs the user made in the app (ids \`srun_…\`; \`--source all\` mixes both);
  read their results the same way.

## A definition's stored events

A definition run returns that run's events. When a definition runs over history (in the app
or with \`chartnaut collect\`), its events are stored for every instrument, timeframe and
window it covered. Studies read those stored events:

- \`chartnaut events <definition> --summary\`: totals and one row per instrument × timeframe.
- \`chartnaut events <definition> --on BTC --event <id> --from 2026-01-01T00:00:00Z --all\`: the events
  themselves; \`--where '[{"key":"range","op":"gt","value":200}]'\` filters on payload values.
- \`chartnaut collect <definition> --on BTC --tf 5m --last 1y --wait\`: run the definition over a
  window it has not covered yet (only the missing part runs). A study runs its definitions over its
  window automatically.

## Putting a study on the chart (Forward Insights)

A Forward Insight shows a study's answer when you click one of a definition's events on a chart.
The study must publish \`pin_cell\`; read \`chartnaut docs chart-pins-overview\` before writing it:

- \`results.declare({ id: "pin_cell", kind: "popover_layout", indexedBy: [<scope dimensions>] })\`
  (\`[]\` for one global card); scope dimensions are facts known when the event fires.
- \`export function scope(ctx)\` returns \`{ ...every scope dimension }\` from what was known when the event
  fired, or \`null\` to leave it out; \`onEvent(ctx, scope)\` measures what happened next.
- In \`onFinish\`, one \`ctx.popoverLayout.cell({ dims: g.scope, n: g.rows.length, blocks })\` per group of
  \`ctx.groupByScope(ctx.collected(key))\`, so each \`n\` is the true count.

Then run the study on the instrument and timeframe to chart, check
\`chartnaut runs results <id> --keys pin_cell\`, and
\`chartnaut insights create <run id> --name "<card title>" --dry-run\`. Show the preview, then run it
without \`--dry-run\`. A refusal prints \`fix:\` with what the study needs.

## When something looks wrong

- \`failure.kind\` says why a run stopped: \`script\` (your code), \`data_not_ready\` /
  \`out_of_coverage\` (no data there), \`busy\` / \`timeout\` (retry), \`plan_limit\` (tell the user).
- \`console\` on the run holds the first 50 lines your script printed (\`console.log\` works).
- \`summary.warnings\` explains quiet results, e.g. \`emit_never_reached\` (no event fired) or a
  dependency that only runs in the browser and reads empty here.
- \`summary.errors\` lists runtime errors on some bars; the rest of the run still produced output.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | continue |
| 1 | script invalid | fix the printed diagnostics, validate again |
| 2 | run failed | read \`failure\` and the console lines |
| 3 | auth, scope or plan limit | stop and tell the user |
| 4 | bad usage or not found | fix the command |
| 5 | retryable (busy, rate limited, data not ready) | wait, then retry |

Every command takes \`--json\` for the raw API response.

## Reference topics

${topicSection}
`;
}
