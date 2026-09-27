# AGENTS.md

Guidance for coding agents. Part 1 is for agents using the `chartnaut` CLI to write and run Chartnaut scripts. Part 2 is for agents changing this repository.

## Part 1: using the CLI

### What it does

`chartnaut` validates, runs and saves Chartnaut indicators, definitions and studies. Scripts run on Chartnaut's servers, not on this machine. A run returns what the script produced, never raw candles:

| Kind | A run returns |
|---|---|
| indicator | output series (time, value per declared output) |
| definition | events (one row per emitted event) |
| study | study blocks (metrics, tables, distributions) |

Read the run summary, not the code, to judge a change.

### Before you start

- Check sign-in with `chartnaut whoami`. Exit 3 means not signed in, a missing scope or a Free plan: stop and tell the user. Do not try to sign in for them.
- In a project folder, run `chartnaut init` once. It writes `chartnaut.json` and the same guide into `CLAUDE.md` and `AGENTS.md`, inside `chartnaut:begin` / `chartnaut:end` markers. That project guide is the authority for the loop; this section summarises it.
- Examples use `BTC` and `ETH`. `chartnaut instruments <q>` finds other symbols.

### The loop

1. **Read the reference.** `chartnaut docs` lists topics; `chartnaut docs <topic>` prints one as markdown. Read the topics for the kind you are writing before writing code. Do not guess the API.
2. **Create or edit.** `chartnaut new <indicator|definition|study> <slug>`. One script per folder.
3. **Validate.** `chartnaut validate <path>`. Free. Fix every `error` line (`path:line: severity: message`).
4. **Run on a short window.** `chartnaut run <path> --last 30d` runs local files and saves nothing. A study cannot run inline: `chartnaut push <path>`, then `chartnaut run <slug> --last 30d`.
5. **Read the summary.** Indicator: last/min/max/count per output. Definition: `events_total` and counts per event. Study: `chartnaut runs results <id>` for the metrics. Blank outputs or zero events usually mean a logic bug.
6. **Widen.** `--last 90d`, then `--on BTC,ETH`. `--out results.csv` writes every row.
7. **Push.** `chartnaut push <path> -m "what changed"`. On `version_conflict`, `chartnaut pull <slug>` and re-apply. Use `--force` only if the user agrees to overwrite the app's version.

### Exit codes

| Code | Meaning | Do |
|---|---|---|
| 0 | ok | continue |
| 1 | script invalid | fix the printed diagnostics, validate again |
| 2 | run failed | read `failure` and the console lines |
| 3 | auth, scope or plan limit | stop and tell the user |
| 4 | bad usage or not found | fix the command |
| 5 | retryable (busy, rate limited, data not ready) | wait, then retry the same command |

With several instruments the exit code is the highest among them. The CLI has already retried busy and rate-limited calls before it exits 5.

### Output

- Every command takes `--json` and prints the raw API response on stdout. Parse that, not the tables.
- With `--json`, an API error is printed on stdout as `{"error": {...}, "diagnostics": [...]}`, and the human message still goes to stderr.
- Every `run` prints the run id (`id` in `--json`). Fetch full results with it:
  - indicator or definition: `chartnaut runs results <id> --all`
  - study: `chartnaut runs results <id> --full`, or one block with `--keys <key> --format csv`
- `failure.kind` says why a run stopped: `script`, `data_not_ready`, `out_of_coverage`, `busy`, `timeout`, `plan_limit`, `cancelled`, `internal`.
- `console` on a run holds the first lines the script printed. `summary.warnings` explains quiet results, such as `emit_never_reached`.

### Rules

- Never print, log, commit or echo an API key or the contents of `~/.config/chartnaut/credentials.json`. Use `CHARTNAUT_TOKEN` from the environment when a key is needed.
- Do not edit `version` in `script.json`. The CLI maintains it.
- Pin versions when comparing: run `slug@3` against `slug@4`, not a bare `slug`, so a save in the app between runs cannot change the answer.
- Keep your own instructions outside the `chartnaut:begin` / `chartnaut:end` block; `chartnaut init` replaces what is inside it.
- Do not `push --force` without the user's agreement.
- Start on short windows. Every run uses the account's shared runs at once and compute.
- `chartnaut mcp install [claude|codex|cursor]` prints how to connect Claude Code, Cursor or Codex to Chartnaut's MCP server. Do not add `--write` without the user's agreement: for `claude` and `cursor` it writes their API key into that client's config.

### Where the docs live

- `chartnaut docs` and `chartnaut docs <topic>`: the scripting reference, in the terminal, as markdown.
- CLI: https://docs.chartnaut.com/cli/overview/ and https://docs.chartnaut.com/cli/command-reference/
- Errors: https://docs.chartnaut.com/cli/errors-and-exit-codes/
- Limits: https://docs.chartnaut.com/cli/limits/
- Scripting: https://docs.chartnaut.com/scripting/overview/
- API: https://docs.chartnaut.com/cli/api-reference/
- MCP server: https://docs.chartnaut.com/cli/mcp-overview

## Part 2: working on this repository

### Commands

```sh
npm install
npm run build       # tsc: src/ to dist/
npm run typecheck   # src/ and test/
npm test            # unit tests, node:test, fake fetch, no network
npm run test:e2e    # hermetic end-to-end suite in test/e2e, no network
node dist/index.js --help
```

Node 20 or later. `npm run build:binaries` also needs Bun and is for releases only (see RELEASING.md).

### Layout

- `src/cli.ts` builds the commander program and maps errors to exit codes.
- `src/commands/*.ts` hold the commands: `account.ts` (login, logout, whoami, usage, library, instruments, docs), `scripts.ts` (init, new, validate, push, pull, diff, ls, versions, open), `run.ts` (run, runs), `events.ts` (events, collect), `mcp.ts` (mcp install), `upgrade.ts`.
- `src/client.ts` is the only HTTP code: auth header, retries, `Retry-After`, `Idempotency-Key`.
- `src/context.ts` defines `Ctx`, everything that touches the outside world. Commands never reach `process`, the network or the home folder directly; tests pass a fake `Ctx`.
- `src/errors.ts` holds `EXIT` and the error-code to exit-code map.
- `src/guide.ts` is the text `chartnaut init` writes into user projects.
- `test/helpers.ts` provides `harness(routes)`: a fake `Ctx` with a routed fake fetch, temp cwd and home.

### Conventions

- Exit codes are a public contract. Do not change what a code means.
- `--json` output is the raw API response. Do not reshape it.
- Human output is plain tables from `src/output.ts`, no colour, so agents can read it.
- Every behaviour change comes with a test in `test/`. Tests never touch the network or the real home folder.
- Keep `version` in `package.json` and `VERSION` in `src/version.ts` equal.
- User-facing text: British spelling, no em or en dashes, plain words.
- The API server is not in this repository. A change that needs a new endpoint cannot land here alone.
