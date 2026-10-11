import { Command, Option } from 'commander';
import type { Env } from '../env.js';
import { CliError, EXIT } from '../errors.js';
import { table } from '../output.js';

/** Kinds another author's script can be added as. Studies cannot be added: only your own run. */
export const ADDABLE_KINDS = ['indicator', 'definition'];

export interface LibraryEntry {
  ref: string;
  kind?: string;
  name?: string;
  author?: string;
  status?: string;
}

/** GET /library/{author}/{slug}/requirements: what adding a script also adds. */
export interface Requirements {
  root?: LibraryEntry;
  needs?: LibraryEntry[];
  cannot_add?: { kind?: string; name?: string }[];
  truncated?: boolean;
  confirm?: string[];
  message?: string;
}

/** `author/slug`, no version: an added script follows its author's latest version. */
export function parseLibraryRef(ref: string): { author: string; slug: string; path: string } {
  const m = /^([^/@\s]+)\/([^/@\s]+)$/.exec(ref);
  if (!m) throw new CliError('error: invalid_request: expected author/slug (an added script always follows the latest version)', EXIT.USAGE);
  return { author: m[1]!, slug: m[2]!, path: `/library/${encodeURIComponent(m[1]!)}/${encodeURIComponent(m[2]!)}` };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The scripts `confirm` lists, with their details from `needs` where the server gave them. */
function toAdd(req: Requirements): LibraryEntry[] {
  const needs = req.needs ?? [];
  return (req.confirm ?? []).map((ref) => needs.find((n) => n.ref === ref) ?? { ref });
}

function cannotAddLines(name: string, req: Requirements): string[] {
  const list = req.cannot_add ?? [];
  return [
    `${name} can't be added: it uses ${plural(list.length, "script that isn't", "scripts that aren't")} shared with you:`,
    table(['name', 'kind'], list.map((c) => [c.name, c.kind])),
  ];
}

export function registerLibraryChanges(library: Command, env: Env): void {
  const kindOption = () => new Option('--kind <kind>', 'when the author has an indicator and a definition with this slug').choices(ADDABLE_KINDS);

  library
    .command('add')
    .description("add another author's script to your library, with the scripts it needs (asks first)")
    .argument('<ref>', 'author/slug')
    .option('-y, --yes', 'agree to adding the scripts it needs without asking (scripts and CI)')
    .addOption(kindOption())
    .action(async (ref: string, opts: { yes?: boolean; kind?: string }, cmd: Command) => {
      const target = parseLibraryRef(ref);
      const query = { kind: opts.kind };
      const json = env.isJson(cmd);
      const req = (await env.client.get<Requirements>(`${target.path}/requirements`, { query })).data ?? {};
      const name = req.root?.name || req.root?.ref || ref;

      if (req.cannot_add?.length) {
        if (json) env.printJson(req);
        else for (const l of cannotAddLines(name, req)) env.out(l);
        throw new CliError(`error: not_shared: nothing was added. Ask the author to share those scripts, or use another script.`, EXIT.USAGE);
      }

      const confirm = req.confirm ?? [];
      if (confirm.length) {
        // With --json, stdout carries only the API's answer; the list goes to stderr.
        const say = (s: string) => (json ? env.err(s) : env.out(s));
        say(`To use ${name}, we'll add ${plural(confirm.length, 'more script', 'more scripts')} to your library:`);
        say(table(['ref', 'kind', 'author'], toAdd(req).map((n) => [n.ref, n.kind, n.author])));
        if (req.truncated) say('(the list is longer than shown)');
        say('They stay yours, and you can remove them whenever you like.');
        if (!opts.yes) {
          const answer = await env.ctx.ask('Add them? [y/N] ');
          if (answer === null) {
            throw new CliError(
              `error: confirmation_required: adding ${ref} also adds ${plural(confirm.length, 'script', 'scripts')} to your library. Agree with the user first, then run it again with --yes.`,
              EXIT.USAGE,
            );
          }
          if (!/^y(es)?$/i.test(answer.trim())) {
            env.err('Nothing was added.');
            env.fail(EXIT.USAGE);
            return;
          }
        }
      }

      const res = await env.client.post<any>(target.path, { query, body: { confirm } });
      const r = res.data ?? {};
      if (json) return env.printJson(r);
      const rootRef = r.root?.ref ?? req.root?.ref ?? ref;
      if (r.added === false) {
        env.out(`Nothing to add: ${r.reason ?? `${rootRef} is already in your library`}`);
        return;
      }
      env.out(`Added ${r.root?.name || name} (${rootRef}) to your library.`);
      const also: string[] = Array.isArray(r.added_with) ? r.added_with : [];
      if (also.length) env.out(`Also added: ${also.join(', ')}`);
      for (const s of Array.isArray(r.skipped) ? r.skipped : []) env.out(`Skipped ${s?.ref ?? '?'}: ${s?.reason ?? ''}`);
      env.out(`Run it: chartnaut run ${rootRef}`);
    });

  library
    .command('remove')
    .description('remove a script you added from your library (the scripts added with it stay)')
    .argument('<ref>', 'author/slug')
    .addOption(kindOption())
    .action(async (ref: string, opts: { kind?: string }, cmd: Command) => {
      const target = parseLibraryRef(ref);
      const r = (await env.client.delete<any>(target.path, { query: { kind: opts.kind } })).data ?? {};
      if (env.isJson(cmd)) return env.printJson(r);
      env.out(`Removed ${r.ref ?? ref}${r.kind ? ` (${r.kind})` : ''} from your library. Scripts added with it stay; remove them the same way.`);
    });

  library
    .command('needs')
    .alias('requirements')
    .description('list what adding a script would also add to your library, without adding anything')
    .argument('<ref>', 'author/slug')
    .addOption(kindOption())
    .action(async (ref: string, opts: { kind?: string }, cmd: Command) => {
      const target = parseLibraryRef(ref);
      const req = (await env.client.get<Requirements>(`${target.path}/requirements`, { query: { kind: opts.kind } })).data ?? {};
      if (env.isJson(cmd)) return env.printJson(req);
      const root = req.root;
      const name = root?.name || root?.ref || ref;
      env.out([root?.ref ?? ref, root?.kind, root?.status, root?.name].filter(Boolean).join('  '));
      const needs = req.needs ?? [];
      const confirm = req.confirm ?? [];
      if (confirm.length) env.out(`Adding it also adds ${plural(confirm.length, 'script', 'scripts')} to your library:`);
      else if (needs.length) env.out('It uses these scripts, which you can already use:');
      else env.out('It needs no other scripts.');
      if (needs.length) env.out(table(['ref', 'kind', 'author', 'status'], needs.map((n) => [n.ref, n.kind, n.author, n.status])));
      if (req.truncated) env.out('(the list is longer than shown)');
      if (req.cannot_add?.length) {
        for (const l of cannotAddLines(name, req)) env.out(l);
        return;
      }
      if (root?.status === 'installable') env.out(`Add it: chartnaut library add ${root.ref ?? ref}`);
    });
}
