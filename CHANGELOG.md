# Changelog

Notable changes to the Chartnaut CLI. Versions follow [Semantic Versioning](https://semver.org/).

## 0.2.0

Upgrade with `chartnaut upgrade`.

### Keys that expire

- `chartnaut login` now creates a key that expires after 90 days. `--expires 7d`, `30d` or `90d` picks another lifetime (the approval page can shorten it, never lengthen it). After signing in it prints `Key expires on <date> (<N> days).` `login --token` is unchanged.
- `chartnaut whoami` prints when the key expires, or that it never expires.
- From 7 days before the key expires, every command prints one line on stderr: `warning: your Chartnaut key expires on <date>; run chartnaut login to renew.` The date is saved with the key when you sign in, so the check makes no extra request. `whoami` refreshes it.
- `chartnaut login` with a key that expires within 7 days signs in again and revokes the old key, instead of stopping at "already signed in".
- An expired key prints `error: unauthorized: your key expired. Run chartnaut login.` and exits 3.

### Library

- `chartnaut library add <author/slug>` adds another author's script to your library, as the app's Add to library does. If it uses scripts you do not have, it lists them and asks `Add them? [y/N]`. `--yes` agrees without asking, for scripts and CI. Without a terminal and without `--yes` it adds nothing and exits 4. If it uses scripts that are not shared with you, it names them and exits 4. `--kind indicator|definition` picks one when the author has both under one slug.
- `chartnaut library remove <author/slug>` takes it out again. The scripts added with it stay.
- `chartnaut library needs <author/slug>` (also `library requirements`) lists what adding it would add, without adding anything.

### Runs of other people's scripts

- Another author's script now runs only once it is in your library, exactly as in the app. `chartnaut run author/slug` for one that is not prints the API's message and `Add it first: chartnaut library add author/slug`, and exits 4. A study whose definitions are not in your library gets one such line per definition. `not_shared` lists the scripts that are not shared with you.

### Release channels

- Releases are published to an `unstable` channel first (`https://desktop-updates.chartnaut.com/cli/unstable`), tested, then promoted to the stable one. To try a candidate: `CHARTNAUT_DOWNLOAD_URL=https://desktop-updates.chartnaut.com/cli/unstable` with the installers or `chartnaut upgrade`.

## 0.1.1

Security fixes. Upgrade with `chartnaut upgrade`.

- The binaries no longer read `.env`, `bunfig.toml`, `tsconfig.json` or `package.json` from the directory they run in. In 0.1.0, running any command (or the installer) inside a folder with a hostile `bunfig.toml` ran that folder's code, and a hostile `.env` could point the CLI, and your key, at another server.
- `CHARTNAUT_API_URL` and `CHARTNAUT_DOWNLOAD_URL` must be https (plain http only to localhost).
- On Windows, `claude` and the browser opener are started by their full path, never from the current directory.
- `pull` refuses a slug from the server that is not a plain slug, so it cannot write outside your project.
- Text from the server is printed without terminal control characters, so it cannot rewrite the screen, fake links or set the clipboard. `--json` output is unchanged.

## 0.1.0

The first public release.

### Install and update

- Standalone executables for macOS (Apple silicon and Intel), Linux (x64 and ARM, glibc and musl) and Windows (x64), installed with `https://chartnaut.com/install.sh` or `https://chartnaut.com/install.ps1`. No Node or other runtime needed.
- `chartnaut upgrade` downloads the latest release, checks its SHA-256 and replaces itself. `--check` only reports.

### Account

- `chartnaut login`: browser sign-in with a one-time code, or `--token` for CI. `--force` switches account and revokes the old key; `--no-browser` prints the link.
- `chartnaut logout` revokes this machine's key and deletes the saved copy.
- `chartnaut whoami` and `chartnaut usage`.
- Credentials saved in `~/.config/chartnaut/credentials.json` with mode `0600`. `CHARTNAUT_TOKEN` overrides them.

### Projects and scripts

- `chartnaut init`: `chartnaut.json` defaults, script folders, and an agent guide in `CLAUDE.md` and `AGENTS.md` inside marked blocks, without overwriting anything you wrote.
- `chartnaut new` for indicators, definitions and studies.
- `chartnaut validate`: lint and resolve without saving or running.
- `chartnaut push`, `pull`, `diff`, `ls`, `versions` and `open`, with base-version conflict detection and `push --force`.

### Runs and results

- `chartnaut run` on local files (inline, saves nothing) or a saved ref (`slug`, `slug@N`, `author/slug`, `chartnaut/slug`), on up to three instruments at once with a comparison table.
- `--set` setting overrides, `--no-wait`, and `--out` to CSV or JSON.
- `chartnaut runs`, `runs get --watch`, `runs results` (JSON or CSV, every page with `--all`, study blocks with `--keys` and `--full`) and `runs cancel`.

### Definition events

- `chartnaut events`: a definition's events, with `--summary`, filters, payload `--where` and CSV output.
- `chartnaut collect`: run a definition over history, only for the part not yet covered.

### Forward Insights

- `chartnaut insights` lists your Forward Insights. `insights create <run> --name <name>` puts a study run on your charts, and `--dry-run` prints the preview card without saving. `insights show`, `update` and `rm` manage them. The study must publish `pin_cell`.

### Connect an AI app

- `chartnaut mcp install [claude|codex|cursor]` prints the setup for connecting Claude Code, Cursor or Codex to Chartnaut's MCP server (`https://api.chartnaut.com/v1/mcp`). `--write` applies it: `claude mcp add` for Claude Code, `~/.cursor/mcp.json` for Cursor, `~/.codex/config.toml` for Codex. It makes no network calls and never prints the saved key.

### Discovery

- `chartnaut library search` and `library show` for your own, Chartnaut's and other people's public scripts.
- `chartnaut instruments` with coverage dates.
- `chartnaut docs`: the scripting reference as markdown in the terminal.

### For scripts and coding agents

- Fixed exit codes 0 to 5.
- Errors print the server's `fix:` and `docs:` lines when it sends them.
- `--json` on every command.
- Automatic retries on busy, rate-limited and network failures, honouring `Retry-After`, with an `Idempotency-Key` on run creation and push.
- Server-supplied links are opened only when they are `https` links to `chartnaut.com` or the configured app host.
