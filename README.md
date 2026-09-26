# Chartnaut CLI

`chartnaut` writes, validates, runs and saves Chartnaut indicators, definitions and studies from your terminal or a coding agent.

Your scripts live as files in your own folder. The CLI sends them to Chartnaut, which runs them on its servers against the instrument, timeframe and window you name, and returns what they produced. Nothing runs on your machine and you never download market data.

## What is Chartnaut

[Chartnaut](https://chartnaut.com) is a trading terminal you can build into whatever you need: Charts, a trade journal, playbooks, backtesting, Historical Intelligence and an Agent that builds indicators, definitions, studies and apps with you. The app is at [terminal.chartnaut.com](https://terminal.chartnaut.com) and the docs are at [docs.chartnaut.com](https://docs.chartnaut.com/). [What Chartnaut is](https://docs.chartnaut.com/start/what-chartnaut-is/) and [How the pieces fit](https://docs.chartnaut.com/start/how-the-pieces-fit/) explain the rest.

The CLI and the [API](https://docs.chartnaut.com/cli/api-overview/) need a Starter, Pro or Ultra plan. On Free, every command that reaches Chartnaut stops with `plan_limit` and exit code 3. [Plans](https://docs.chartnaut.com/start/plans/)

## Contents

- [Quick start](#quick-start)
- [For coding agents](#for-coding-agents)
- [Concepts](#concepts)
- [Command reference](#command-reference)
- [Exit codes](#exit-codes)
- [Retries and idempotency](#retries-and-idempotency)
- [Environment variables](#environment-variables)
- [Credentials and config](#credentials-and-config)
- [Plans and limits](#plans-and-limits)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [API](#api)
- [Development](#development)
- [Support](#support)
- [Licence](#licence)

## Quick start

### 1. Install

macOS and Linux:

```sh
curl -fsSL https://chartnaut.com/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://chartnaut.com/install.ps1 | iex
```

Both install one self-contained executable, with no Node or other runtime needed. The script picks the build for your machine, checks its SHA-256 checksum and installs it to `~/.chartnaut/bin/chartnaut` (`%LOCALAPPDATA%\Chartnaut\bin\chartnaut.exe` on Windows), then adds that folder to your PATH. Open a new terminal and check it:

```
$ chartnaut --version
0.1.0
```

| Installer variable | Does |
|---|---|
| `CHARTNAUT_VERSION` | Installs this version instead of the latest |
| `CHARTNAUT_INSTALL` | Installs under this folder instead. The program goes in its `bin` folder |
| `CHARTNAUT_NO_MODIFY_PATH=1` | Leaves your PATH alone |

On macOS and Linux, put a variable before `sh`: `curl -fsSL https://chartnaut.com/install.sh | CHARTNAUT_VERSION=0.1.0 sh`. Updating, uninstalling and install errors are on [Install](https://docs.chartnaut.com/cli/install/).

Both scripts are in this repository under [`install/`](install/), so you can read exactly what runs before piping it to a shell.

### 2. Sign in

```
$ chartnaut login
Opening your browser… (or go to https://terminal.chartnaut.com/morpheus/cli-auth?code=KTRW-BHXM)
Code: KTRW-BHXM
```

Check that the code in the browser matches the one in your terminal, then click **Connect**. The terminal prints `Signed in as <you>.` The code works for 10 minutes. Over SSH, `chartnaut login --no-browser` prints the link to open on any device where you are signed in. [Sign in](https://docs.chartnaut.com/cli/sign-in/)

For CI, create a key on the [Developers page](https://terminal.chartnaut.com/morpheus/settings/developers) and either save it with `chartnaut login --token cn_live_…` or export it as `CHARTNAUT_TOKEN`. [API keys](https://docs.chartnaut.com/cli/api-keys/)

### 3. Set up a folder and write a script

```
$ mkdir my-scripts && cd my-scripts
$ chartnaut init
chartnaut.json: created
indicators/: created
definitions/: created
studies/: created
CLAUDE.md: created
AGENTS.md: created
next: chartnaut new indicator my-first-indicator

$ chartnaut new indicator my-ema
wrote indicators/my-ema/script.json and indicators/my-ema/main.ts
next: chartnaut docs, edit main.ts, then chartnaut validate indicators/my-ema
```

The starter `main.ts` holds only comments. Replace them with your script. The [First indicator guide](https://docs.chartnaut.com/scripting/first-indicator-guide/) has an EMA to paste in, and [Your first run](https://docs.chartnaut.com/cli/your-first-run/) walks through every step below with real output.

### 4. Validate, run, save

```sh
chartnaut validate indicators/my-ema                              # free; lint and resolve, saves nothing
chartnaut run indicators/my-ema --on BTC --tf 1h --last 30d       # runs the local files; saves nothing
chartnaut run indicators/my-ema --on BTC,ETH --tf 1h --last 90d   # one run per instrument, compared side by side
chartnaut push indicators/my-ema -m "first version"               # saves version 1 to your account
```

A run prints its summary:

```
run run_4k2m9x7q1b8z3n5p  succeeded  indicator  inline  HYPERLIQUID:BTC  1h  2026-08-27 10:00 → 2026-09-26 10:00
bars: 720
OUTPUT  LAST      MIN       MAX       COUNT
ema     63412.18  58120.44  66890.03  720
usage: 720 bars, 0.72 CU
```

`push` prints an `app:` link that opens the saved script in the indicator builder.

### Build from source

Needs Node 20 or later.

```sh
git clone https://github.com/chartnaut/cli.git
cd cli
npm install
npm run build
node dist/index.js --help
```

A copy run from source works like the installed one, except that `chartnaut upgrade` prints the install commands instead of replacing itself.

## For coding agents

The CLI is built to be driven by Claude Code, Codex and other coding agents. Start with [AGENTS.md](AGENTS.md), and [Working with Claude Code and Codex](https://docs.chartnaut.com/cli/claude-code-and-codex/) on the docs site.

- `chartnaut init` writes a guide into `CLAUDE.md` and `AGENTS.md` in your project, between `chartnaut:begin` and `chartnaut:end` markers, without touching anything else in those files.
- The loop: `chartnaut docs <topic>` → `chartnaut new` → `chartnaut validate` → `chartnaut run <path> --last 30d` → read the summary → widen with `--last 90d --on BTC,ETH` → `chartnaut push -m "…"`.
- Every command exits with a [fixed code from 0 to 5](#exit-codes). Branch on it, not on the text.
- Every command takes `--json` and prints the raw API response on stdout. Errors go to stderr; with `--json` the error body is also printed on stdout.
- `chartnaut docs` lists the [scripting reference](https://docs.chartnaut.com/scripting/overview/) topics and `chartnaut docs <topic>` prints one as markdown. It works before you sign in.
- Output is plain fixed-width tables with no colour.

## Concepts

### Indicators, definitions and studies

| Kind | What it is | A run returns | Read more |
|---|---|---|---|
| Indicator | Values computed from price on every bar, drawn on Charts | Output series: a time and a value per bar for each output | [How indicators work](https://docs.chartnaut.com/guides/how-indicators-work/), [Indicator API](https://docs.chartnaut.com/scripting/indicator-api/), [First indicator guide](https://docs.chartnaut.com/scripting/first-indicator-guide/) |
| Definition | A setup described in code; it emits an event each time the setup happens | Events: one row per emitted event, with its payload | [How research works](https://docs.chartnaut.com/guides/how-research-works/), [Build a definition](https://docs.chartnaut.com/guides/build-a-definition/), [Definition API](https://docs.chartnaut.com/scripting/definition-api/), [First definition guide](https://docs.chartnaut.com/scripting/first-definition-guide/) |
| Study | Reads a definition's events and measures what happened after them | Result blocks: metrics, tables, distributions and charts | [Build and run a study](https://docs.chartnaut.com/guides/build-and-run-a-study/), [Study API](https://docs.chartnaut.com/scripting/study-api/), [First study guide](https://docs.chartnaut.com/scripting/first-study-guide/) |

A saved study can also be attached to a chart as a [Forward Insight](https://docs.chartnaut.com/guides/forward-insights/). The scripts are the same ones the builders in the app write, in the same language: [Script anatomy](https://docs.chartnaut.com/scripting/script-anatomy/), [Warmup and memory](https://docs.chartnaut.com/scripting/warmup-and-memory/), [Limits and errors](https://docs.chartnaut.com/scripting/limits-and-errors/).

Scripts run on Chartnaut's servers. You get back what the script produced, never raw candles. Read the summary to judge a change.

### Project layout

```
chartnaut.json                  defaults for run and collect
CLAUDE.md, AGENTS.md            the agent guide, written by chartnaut init
indicators/<slug>/script.json   { kind, slug, name, entry, version }
indicators/<slug>/main.ts       the entry file
definitions/<slug>/...
studies/<slug>/...
```

`chartnaut.json` holds the defaults a command uses when you leave out a flag:

```json
{
  "defaults": {
    "instrument": "BTC",
    "timeframe": "5m",
    "window": "90d"
  }
}
```

`window` is a span (`30d`, `12w`, `6m`, `1y`) or a bar count (`2000`). The CLI finds `chartnaut.json` by walking up from the current folder.

### script.json

```json
{
  "kind": "definition",
  "slug": "orb-break",
  "name": "Opening range break",
  "entry": "main.ts",
  "version": 3
}
```

`version` is the version this folder was last pushed or pulled at. `push` sends it as the base version, so a change saved in the app is never overwritten silently. The CLI updates it; leave it alone.

A slug is 2 to 63 characters of lowercase letters, digits and dashes, starting with a letter or digit. A push sends every file in the folder except `script.json`, dotfiles and `node_modules`.

### Refs

A saved script is named by a ref.

| Ref | Means |
|---|---|
| `orb-break` | Your script, latest version |
| `orb-break@3` | Your script, version 3 |
| `jane/orb-break` | Another author's public script |
| `chartnaut/rsi` | A Chartnaut built-in |
| `me/orb-break` | Your own script, in `library show` |

`chartnaut run` treats a target that exists on disk as local files and anything else as a ref. `chartnaut library search` finds refs you can run.

### Versions and conflicts

Each push saves a new version that never changes afterwards, so `orb-break@3` is the same code a year from now. If someone saved a newer version in the app or from another machine, `push` stops with `version_conflict` and exit code 4. Run `chartnaut diff <slug>`, keep a copy of your changes, `chartnaut pull <slug>`, re-apply them and push again. `push --force` saves your files on top of the latest version instead. [Saving and versions](https://docs.chartnaut.com/cli/saving-and-versions/), [Versions and profiles](https://docs.chartnaut.com/guides/versions-and-profiles/)

## Command reference

`chartnaut <command> --help` prints every flag. The full reference is [Command reference](https://docs.chartnaut.com/cli/command-reference/).

### Options on every command

| Option | Does |
|---|---|
| `--json` | Prints the raw API response instead of tables |
| `-v`, `--version` | Prints the CLI version. Put it before any command |
| `-h`, `--help` | Prints usage. `chartnaut help <command>` does the same |

### Instruments, timeframes and windows

`run` and `collect` share these flags. Any flag you leave out comes from `defaults` in `chartnaut.json`.

| Flag | Takes |
|---|---|
| `--on <instrument>` | A symbol such as `BTC` or `ETH` (shown as `HYPERLIQUID:BTC`). `run` takes a comma list |
| `--tf <timeframe>` | One of `1m 5m 15m 30m 1h 2h 4h 1d 1w` |
| `--last <span>` | A span back from now: `30d`, `12w`, `6m` or `1y` |
| `--bars <n>` | A number of bars back from now |
| `--from <date>`, `--to <date>` | A date (`2026-01-02`, read as midnight UTC), a full ISO timestamp or unix seconds. `--to` defaults to now and needs `--from` |

Pass exactly one of `--last`, `--bars` or `--from`.

### Account

[Sign in](https://docs.chartnaut.com/cli/sign-in/), [API keys](https://docs.chartnaut.com/cli/api-keys/)

| Command | Does | Main flags |
|---|---|---|
| `chartnaut login` | Signs in through your browser and saves a key named *CLI on* your computer's name | `--token <token>` saves an existing key (CI); `--force` signs in again and revokes the old key; `--no-browser` prints the link instead of opening it |
| `chartnaut logout` | Revokes this computer's key and deletes the saved copy | |
| `chartnaut whoami` | Prints user, plan, key name, expiry, scopes and the API address | |

### Project and scripts

[Your first run](https://docs.chartnaut.com/cli/your-first-run/), [Saving and versions](https://docs.chartnaut.com/cli/saving-and-versions/)

| Command | Does | Main flags |
|---|---|---|
| `chartnaut init` | Writes `chartnaut.json`, the three script folders and the agent guide in `CLAUDE.md` and `AGENTS.md`. Never removes or overwrites what you wrote | `--instrument <symbol>` (default `BTC`), `--tf <timeframe>` (default `5m`), `--window <span>` (default `90d`) |
| `chartnaut new <kind> <slug>` | Writes a starter folder `<kind-plural>/<slug>/` with `script.json` and `main.ts`. `<kind>` is `indicator`, `definition` or `study` | `--name <name>` |
| `chartnaut validate [path]` | Lints and resolves a script without saving or running it. Free. `path` defaults to `.` | `--kind <kind>` for a lone file outside a script folder |
| `chartnaut push [path]` | Saves the folder as a new version, creating the script on its first push | `-m, --message <msg>`; `--force` on a version conflict; `--visibility private\|public` on the first push |
| `chartnaut pull <ref>` | Writes a saved version of your own script to disk (`slug` or `slug@N`) | `--dir <dir>` |
| `chartnaut diff <slug>` | Unified diff of your local files against the latest saved version. Takes a slug or a folder path | |
| `chartnaut ls` | Lists your scripts | `--kind <kind>`, `-q, --query <q>`, `--limit <n>`, `--cursor <cursor>` |
| `chartnaut versions <slug>` | Version history, newest first | `--limit <n>`, `--cursor <cursor>` |
| `chartnaut open <target>` | Prints the app link for a script slug or a run id | `--browser` opens it |

### Runs

[Runs and results](https://docs.chartnaut.com/cli/runs-and-results/)

| Command | Does | Main flags |
|---|---|---|
| `chartnaut run <target>` | Runs a local folder or file (saves nothing) or a saved ref, waits and prints the summary. A study runs by ref only: push it first | `--on`, `--tf`, `--last`, `--bars`, `--from`, `--to`; `--set key=value` (repeatable); `--kind <kind>`; `--label <text>`; `--no-wait`; `--out <file.csv\|file.json>` |
| `chartnaut runs` | Lists recent runs | `--script <slug>`; `--source api\|app\|all`; `--status queued\|running\|succeeded\|failed\|cancelled`; `--limit`, `--cursor` |
| `chartnaut runs get <id>` | Status, progress, failure, summary and console lines | `--watch` polls until it finishes |
| `chartnaut runs cancel <id>` | Cancels a queued or running run | |

`--on BTC,ETH` starts one run per instrument, three at a time, and prints one comparison row each. `--set` types `true`, `false`, `null`, numbers and JSON arrays or objects; anything else is a string. With several instruments, `--out results.csv` writes one file per instrument, such as `results.HYPERLIQUID_BTC.csv`.

### Results

[Runs and results](https://docs.chartnaut.com/cli/runs-and-results/), [Get run results](https://docs.chartnaut.com/cli/api-get-run-results/)

`chartnaut runs results <id>` prints what a finished run produced.

| Kind | Command | Returns |
|---|---|---|
| Indicator | `chartnaut runs results <id> --all` | Every output's points `{t, v}` (unix seconds). `--outputs ema` narrows |
| Definition | `chartnaut runs results <id> --all` | Every event: `event`, `start`, `end`, `payload`. `--event <id>` narrows |
| Study | `chartnaut runs results <id> --full` | Every block. Without `--full` only metrics carry data; ask for one block with `--keys <key>` |

Other flags: `--from`, `--to`, `--format json|csv` (default `json`), `--limit <n>` (5,000 by default, 50,000 at most), `--cursor <cursor>`, `--all` (follows every page; CSV keeps one header row). A study response carries at most 1 MB of block data; get one table whole with `--keys <key> --format csv`. `chartnaut runs --source app` lists study runs made in the app (ids `srun_…`), and their results read the same way.

### Definition events

[Definition events](https://docs.chartnaut.com/cli/events-and-collect/), [Run a definition over history](https://docs.chartnaut.com/guides/run-over-history/), [Browse events](https://docs.chartnaut.com/guides/browse-events/)

A definition's events are every event it found when it ran over history, on every instrument, timeframe and window, from the app or the CLI. Studies read them. A `chartnaut run` of a definition is separate: it returns that run's events and stores nothing a study can read. Both commands work on your own definitions only.

| Command | Does | Main flags |
|---|---|---|
| `chartnaut events <definition>` | Lists and filters the definition's events | `--summary` (totals per instrument and timeframe); `--on`, `--tf`, `--event <id>`, `--from`, `--to` (RFC 3339); `--version <n>`; `--where '<json>'`; `--limit` (100 by default, 1,000 at most), `--cursor`, `--all`; `--format json\|csv`; `--out <file>` |
| `chartnaut collect <definition>` | Runs the definition over history on one instrument, timeframe and window, and keeps its events. Only the part not covered yet runs | `--on`, `--tf`, `--last`, `--bars`, `--from`, `--to`; `--version <n>`; `--wait` |

```sh
chartnaut events orb-break --summary
chartnaut events orb-break --on BTC --event break_up --from 2026-01-01T00:00:00Z --all
chartnaut events orb-break --on ETH --where '[{"key":"range","op":"gt","value":200}]' --format csv --out breaks.csv
chartnaut collect orb-break --on BTC --tf 5m --last 1y --wait
```

`collect --wait` checks every 3 seconds for up to 20 minutes. A study run from the CLI runs each definition it declares over the study's window first, so you rarely need `collect` before one. The events count toward your plan's [definition events](https://docs.chartnaut.com/account/definition-events-limit/).

### Library

[Community library](https://docs.chartnaut.com/guides/community-library/), [Search the library](https://docs.chartnaut.com/cli/api-search-library/), [Get a library script](https://docs.chartnaut.com/cli/api-get-library-script/)

| Command | Does | Main flags |
|---|---|---|
| `chartnaut library search [q]` | Searches every script you can use: yours, Chartnaut's built-ins and other people's public ones. Never returns source | `--scope all\|library\|mine\|published\|chartnaut\|community\|installed`; `--author <name\|chartnaut\|me>`; `--kind <kind>`; `--sort relevance\|updated\|created\|adoptions\|name`; `--interface` (with `--json`); `--limit`, `--cursor` |
| `chartnaut library show <ref>` | One script's settings, outputs, events, results and app link. `<ref>` is `author/slug[@N]`, `chartnaut/slug` or `me/slug` | `--kind <kind>` when one of your studies shares the slug |

The ref in the first column of `search` runs as it is: `chartnaut run chartnaut/rsi --on BTC --tf 1h --last 30d`.

### Catalogue

| Command | Does | Main flags |
|---|---|---|
| `chartnaut instruments [q]` | Instruments you can run on, with category, order flow and coverage dates. `q` matches the symbol, short symbol and name | `--category crypto\|fx\|index\|commodities`; `--limit`, `--cursor` |

[Search instruments](https://docs.chartnaut.com/cli/api-search-instruments/), [Market data](https://docs.chartnaut.com/guides/market-data/)

### Docs

| Command | Does |
|---|---|
| `chartnaut docs` | Lists the scripting reference topics |
| `chartnaut docs <topic>` | Prints one topic as markdown, such as `chartnaut docs series-outputs` |

These are the [Scripting](https://docs.chartnaut.com/scripting/overview/) pages. [List doc topics](https://docs.chartnaut.com/cli/api-list-doc-topics/), [Get a doc topic](https://docs.chartnaut.com/cli/api-get-doc-topic/)

### Usage

| Command | Does |
|---|---|
| `chartnaut usage` | This period's compute units and every plan cap with its current count. `--json` adds `api_limits` |

[Limits](https://docs.chartnaut.com/cli/limits/), [Get usage](https://docs.chartnaut.com/cli/api-get-usage/)

### Upgrade

| Command | Does | Main flags |
|---|---|---|
| `chartnaut upgrade` | Downloads the latest release, checks its SHA-256 and replaces the running executable. If the checksum does not match, nothing changes | `--check` only reports whether a newer version exists |

### Open

`chartnaut open <slug>` prints the app link for a saved script, and `chartnaut open <run_id>` the link for a run that has a page in the app. `--browser` also opens it. See [Security](#security) for which links the CLI opens.

## Exit codes

| Code | Means | What to do |
|---|---|---|
| 0 | It worked. Also a run started with `--no-wait` that is still queued or running | Carry on |
| 1 | The script is invalid. Each finding prints as `path:line: severity: message` | Fix the lines named, validate again |
| 2 | The run started and failed. `failure.kind` and the message are printed | Read the failure and the console lines |
| 3 | Not signed in, the key lacks a scope, or a plan limit | Sign in, use a key with the scope, or upgrade |
| 4 | Bad usage, not found, a version conflict, an unknown instrument or timeframe, or a window before your plan's history | Fix the command |
| 5 | Retryable: busy, rate limited, data not ready, a run not finished yet, a server error or the network | Wait, then run the same command again |

With several instruments, the CLI exits with the highest code among them. Every error code and `failure.kind` is on [Errors and exit codes](https://docs.chartnaut.com/cli/errors-and-exit-codes/), and the objects are [The Failure object](https://docs.chartnaut.com/cli/api-object-failure/) and [The Diagnostic object](https://docs.chartnaut.com/cli/api-object-diagnostic/).

## Retries and idempotency

- Every request retries up to 3 times on `429`, `503`, `busy`, `rate_limited` and network failures. It waits for `Retry-After` (up to 60 seconds), or 1, 2 and then 4 seconds when there is none.
- Starting a run keeps retrying for up to 3 minutes, then polls the run with `GET /runs/{id}?wait=30` until it finishes, so a wide fan-out never holds a heavy-call place while it waits.
- Starting a run and pushing a script each send an `Idempotency-Key`, reused across that call's retries, so a retry never starts a second run or saves a second version.
- If the call still fails, the CLI exits with code 5.

[Limits](https://docs.chartnaut.com/cli/limits/) explains requests a minute, heavy calls at once and long polls, and the [API reference](https://docs.chartnaut.com/cli/api-reference/) covers idempotency for your own code.

## Environment variables

| Variable | Does |
|---|---|
| `CHARTNAUT_TOKEN` | An API key to use instead of the saved login. It wins when both are set |
| `CHARTNAUT_API_URL` | The API address. Defaults to `https://api.chartnaut.com/v1`. Regional hosts: `https://eu-api.chartnaut.com/public/v1` and `https://us-api.chartnaut.com/public/v1` |
| `CHARTNAUT_APP_URL` | An extra app host the CLI trusts when opening links. The app is at `https://terminal.chartnaut.com` |
| `CHARTNAUT_NO_BROWSER` | When set, `login` prints the link instead of opening a browser |
| `CHARTNAUT_DOWNLOAD_URL` | Where `upgrade` reads the release manifest. Defaults to `https://desktop-updates.chartnaut.com/cli` |

## Credentials and config

| File | Holds |
|---|---|
| `~/.config/chartnaut/credentials.json` | The key `chartnaut login` saved, with the time it was saved. The folder is created `0700` and the file `0600`, readable only by you. On Windows it is under `%USERPROFILE%\.config\chartnaut` |
| `chartnaut.json` | Project defaults, in your project folder |
| `<kind-plural>/<slug>/script.json` | One script's kind, slug, name, entry file and base version |

`chartnaut logout` deletes the credentials file.

## Plans and limits

The CLI and the API are on Starter, Pro and Ultra. Every limit is per account and shared by all your keys, and runs from the CLI take from the same [runs at once](https://docs.chartnaut.com/account/runs-at-once/) as the app and the Agent.

- [Plans](https://docs.chartnaut.com/start/plans/) and [Plans and limits](https://docs.chartnaut.com/account/plans-and-limits/): what each plan includes
- [API limits](https://docs.chartnaut.com/account/api-limits/): requests a minute, heavy calls and long polls per plan
- [Historical data](https://docs.chartnaut.com/account/historical-data/): how far back a run reaches
- [Indicator memory](https://docs.chartnaut.com/account/indicator-memory/), [Library limits](https://docs.chartnaut.com/account/library-limits/), [Hitting a limit](https://docs.chartnaut.com/account/hitting-a-limit/)
- [Limits](https://docs.chartnaut.com/cli/limits/): per-run bounds, such as 50,000 bars in one window and 10,000 events kept per definition run

`chartnaut usage` prints your caps with their current counts. You can change plan on the [Subscription page](https://terminal.chartnaut.com/morpheus/settings/subscription).

## Security

- An API key acts as you. It can read, save and run anything your account can, within its scopes. Treat it like a password and never commit it.
- Revoke a key on the [Developers page](https://terminal.chartnaut.com/morpheus/settings/developers). `chartnaut logout` revokes the key the CLI is signed in with. `chartnaut login --force` revokes the old key once the new sign-in works.
- Approve only a sign-in code you started yourself. Anyone who gets you to click **Connect** on their code gets a terminal signed in to your account.
- The CLI opens a link from the server only when it is `https`, carries no credentials, and points at `chartnaut.com`, a subdomain of it, or the host in `CHARTNAUT_APP_URL`. Any other link is printed with the reason and not opened.
- `chartnaut upgrade` checks the SHA-256 of every download before replacing anything.

Report a vulnerability as described in [SECURITY.md](SECURITY.md).

## Troubleshooting

| You see | Cause | Fix |
|---|---|---|
| ``error: unauthorized: not logged in. Run `chartnaut login` or set CHARTNAUT_TOKEN.`` | No saved key and no `CHARTNAUT_TOKEN` | Run `chartnaut login` |
| `plan_limit` on every command | The account is on Free | Upgrade to Starter or above. The same key works again |
| `forbidden_scope` | The key lacks a scope the call needs | Use a key with that scope. [API keys](https://docs.chartnaut.com/cli/api-keys/) |
| `path:line: error: …` and `invalid: <slug>` | The script does not lint or resolve | Fix each `error` line. [Lint and error codes](https://docs.chartnaut.com/scripting/lint-and-error-codes/) |
| `version_conflict` on push | A newer version was saved in the app or elsewhere | `chartnaut diff`, then `pull` and re-apply, or `push --force` |
| `no window: pass --last 30d, …` | No window flag and no `defaults.window` | Pass `--last 30d`, or run `chartnaut init` |
| `unknown_instrument` | No instrument matches the symbol | `chartnaut instruments btc` |
| `out_of_coverage` | The window ends before your plan's history | Move the window later. [Historical data](https://docs.chartnaut.com/account/historical-data/) |
| `busy` or `rate_limited`, exit 5 | Your runs at once or API limits are in use | Wait and retry. Check the Agent is not busy in the app |
| `failed: script: …`, exit 2 | The script threw or produced nothing | Read the `console:` lines. [Troubleshooting](https://docs.chartnaut.com/scripting/troubleshooting-overview/) |
| Blank outputs or zero events | Usually a logic bug | Check `summary.warnings`, such as `emit_never_reached`. [Emit not collected](https://docs.chartnaut.com/scripting/emit-not-collected/) |
| `chartnaut: command not found` after installing | The terminal was open before the PATH changed | Open a new terminal |

More: [FAQ](https://docs.chartnaut.com/scripting/faq/), [Budget exceeded](https://docs.chartnaut.com/scripting/budget-exceeded/), [Dependency unavailable](https://docs.chartnaut.com/scripting/dependency-unavailable/).

## API

The CLI calls the public Chartnaut API. Anything the CLI does, your own code can do over HTTP and JSON.

- [API overview](https://docs.chartnaut.com/cli/api-overview/) and [Getting started](https://docs.chartnaut.com/cli/api-reference/)
- Scripts: [List](https://docs.chartnaut.com/cli/api-list-scripts/), [Get](https://docs.chartnaut.com/cli/api-get-script/), [Validate](https://docs.chartnaut.com/cli/api-validate-script/), [Create](https://docs.chartnaut.com/cli/api-create-script/), [Save a version](https://docs.chartnaut.com/cli/api-save-script-version/), [List versions](https://docs.chartnaut.com/cli/api-list-script-versions/)
- Runs: [Create](https://docs.chartnaut.com/cli/api-create-run/), [List](https://docs.chartnaut.com/cli/api-list-runs/), [Get](https://docs.chartnaut.com/cli/api-get-run/), [Results](https://docs.chartnaut.com/cli/api-get-run-results/), [Cancel](https://docs.chartnaut.com/cli/api-cancel-run/), [The Run object](https://docs.chartnaut.com/cli/api-object-run/), [The Summary object](https://docs.chartnaut.com/cli/api-object-summary/)
- Definition events: [List](https://docs.chartnaut.com/cli/api-list-events/), [Summarise](https://docs.chartnaut.com/cli/api-summarise-events/), [Run over history](https://docs.chartnaut.com/cli/api-run-definition-over-history/)
- Account: [Get the current key](https://docs.chartnaut.com/cli/api-get-current-key/), [Start a sign-in](https://docs.chartnaut.com/cli/api-start-sign-in/), [Poll a sign-in](https://docs.chartnaut.com/cli/api-poll-sign-in/), [Revoke the current key](https://docs.chartnaut.com/cli/api-revoke-key/)

The API server is not in this repository.

## Development

```sh
npm install
npm run build           # compiles src/ to dist/
npm run typecheck       # type-checks src/ and test/
npm test                # unit tests against a fake fetch; no network
npm run test:e2e        # builds, then runs the hermetic end-to-end suite in test/e2e; no network
npm run build:binaries  # standalone executables for every platform in release/ (needs Bun)
```

```
src/
  index.ts        entry point
  cli.ts          the program, global flags, error to exit-code mapping
  commands/       one file per command group: account, scripts, run, events, upgrade
  client.ts       HTTP client: auth header, retries, Retry-After, idempotency keys
  config.ts       API address, credentials file
  context.ts      everything that touches the outside world, replaced wholesale in tests
  errors.ts       exit codes and error formatting
  guide.ts        the agent guide chartnaut init writes
  project.ts      chartnaut.json, script.json, starter files
  runargs.ts      instrument, timeframe, window and --set parsing
  browser.ts      the rule for which links may be opened
  output.ts, csv.ts, diff.ts, version.ts
test/             unit tests (node:test) and test/e2e
scripts/          release build and publish scripts
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers how to propose a change, [RELEASING.md](RELEASING.md) how a release is cut, and [CHANGELOG.md](CHANGELOG.md) what changed.

## Support

Email [help@chartnaut.com](mailto:help@chartnaut.com), or use the [Support page](https://terminal.chartnaut.com/morpheus/support) in the app. [Support](https://docs.chartnaut.com/account/support/) on the docs site says what to include. Bugs in the CLI itself go in [GitHub issues](https://github.com/chartnaut/cli/issues).

## Licence

[MIT](LICENSE). Copyright 2026 Chartnaut.
