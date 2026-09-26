import { Command, CommanderError, Help, Option } from 'commander';
import type { Ctx } from './context.js';
import { Env } from './env.js';
import { ApiError, CliError, EXIT, exitCodeForErrorCode, formatApiError } from './errors.js';
import { VERSION } from './version.js';
import { registerAccount } from './commands/account.js';
import { registerRun } from './commands/run.js';
import { registerScripts } from './commands/scripts.js';
import { registerEvents } from './commands/events.js';
import { registerUpgrade } from './commands/upgrade.js';

export function buildProgram(env: Env): Command {
  // -v / --version is handled in main() before commander sees it, and only before the subcommand:
  // registered with .version(), commander takes `--version` from anywhere on the line, which
  // swallowed `events <def> --version 3` and `collect <def> --version 3`. It is listed in help here.
  const versionHelp = new Option('-v, --version', 'output the version number');
  const program: Command = new Command('chartnaut')
    .description('Author and run Chartnaut indicators, definitions and studies. Scripts run on Chartnaut servers.')
    .configureHelp({
      visibleOptions(cmd) {
        const base = Help.prototype.visibleOptions.call(this, cmd);
        return cmd === program ? [versionHelp, ...base] : base;
      },
    })
    .option('--json', 'print the raw API JSON')
    .showSuggestionAfterError(true)
    .configureOutput({
      writeOut: (s) => env.ctx.out(s.replace(/\n$/, '')),
      writeErr: (s) => env.ctx.err(s.replace(/\n$/, '')),
    })
    .exitOverride();
  registerScripts(program, env);
  registerRun(program, env);
  registerEvents(program, env);
  registerAccount(program, env);
  registerUpgrade(program, env);
  // Subcommands inherit output + exitOverride for usage errors.
  const walk = (c: Command) => {
    for (const sub of c.commands) {
      sub.exitOverride();
      sub.configureOutput({
        writeOut: (s) => env.ctx.out(s.replace(/\n$/, '')),
        writeErr: (s) => env.ctx.err(s.replace(/\n$/, '')),
      });
      walk(sub);
    }
  };
  walk(program);
  return program;
}

/** Runs one CLI invocation. `argv` excludes node and the script path. Returns the exit code. */
export async function main(argv: string[], ctx: Ctx): Promise<number> {
  if (asksForVersion(argv)) {
    ctx.out(VERSION);
    return EXIT.OK;
  }
  const env = new Env(ctx);
  const program = buildProgram(env);
  const json = argv.includes('--json');
  try {
    await program.parseAsync(argv, { from: 'user' });
    return env.code;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return EXIT.OK;
      // Commander has already printed the message.
      return e.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    }
    if (e instanceof ApiError) {
      if (json) ctx.out(JSON.stringify({ error: e.body, ...(e.diagnostics.length ? { diagnostics: e.diagnostics } : {}) }, null, 2));
      for (const l of formatApiError(e)) ctx.err(l);
      return exitCodeForErrorCode(e.code, e.status);
    }
    if (e instanceof CliError) {
      ctx.err(e.message.startsWith('error:') ? e.message : `error: ${e.message}`);
      return e.exitCode;
    }
    ctx.err(`error: internal: ${(e as Error)?.message ?? String(e)}`);
    return EXIT.RETRYABLE;
  }
}

/** `chartnaut -v` / `chartnaut --version` (with any global flags): the flag comes before any subcommand. */
export function asksForVersion(argv: string[]): boolean {
  for (const a of argv) {
    if (a === '-v' || a === '--version') return true;
    if (a === '--') return false;
    if (!a.startsWith('-')) return false;
  }
  return false;
}
