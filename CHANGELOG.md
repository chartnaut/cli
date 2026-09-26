# Changelog

Notable changes to the Chartnaut CLI. Versions follow [Semantic Versioning](https://semver.org/).

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

### Discovery

- `chartnaut library search` and `library show` for your own, Chartnaut's and other people's public scripts.
- `chartnaut instruments` with coverage dates.
- `chartnaut docs`: the scripting reference as markdown in the terminal.

### For scripts and coding agents

- Fixed exit codes 0 to 5.
- `--json` on every command.
- Automatic retries on busy, rate-limited and network failures, honouring `Retry-After`, with an `Idempotency-Key` on run creation and push.
- Server-supplied links are opened only when they are `https` links to `chartnaut.com` or the configured app host.
