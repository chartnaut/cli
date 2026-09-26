# Contributing

Thanks for looking at the Chartnaut CLI. This file covers how to build it, test it and propose a change.

## What is in this repository

The command-line client only. The Chartnaut API it calls, the app at [terminal.chartnaut.com](https://terminal.chartnaut.com) and the docs site at [docs.chartnaut.com](https://docs.chartnaut.com/) are not here. A change that needs a new or different endpoint cannot land in this repository alone: open an issue describing what you need instead.

## Build

Needs Node 20 or later.

```sh
npm install
npm run build              # compiles src/ to dist/
node dist/index.js --help  # run your build
```

To point your build at a different API, set `CHARTNAUT_API_URL`. Your build uses your normal sign-in in `~/.config/chartnaut/credentials.json`, or `CHARTNAUT_TOKEN`.

## Test

```sh
npm run typecheck   # type-checks src/ and test/
npm test            # unit tests
npm run test:e2e    # hermetic end-to-end suite
```

Both suites use Node's built-in `node:test` runner and need no network, no account and no API key.

- **Unit tests** (`test/*.test.ts`) call the CLI's `main()` with a fake `Ctx` from `test/helpers.ts`. `harness(routes)` gives you a routed fake `fetch`, a temporary working folder and home folder, and captures stdout, stderr, sleeps and launched programs. Every command is reachable this way.
- **End-to-end tests** (`test/e2e/*.e2e.ts`) run the built CLI (`node dist/index.js`) as a child process against a local fake of the public API (`test/e2e/harness.ts`). Each process gets a temporary home folder and `CHARTNAUT_API_URL` pointing at the fake. Nothing leaves `127.0.0.1`.

Every behaviour change needs a test. A bug fix needs a test that fails without the fix.

## Style

- TypeScript, `strict`, ES modules. Match the formatting of the file you are in.
- Commands never touch `process`, the network or the real home folder directly. Everything goes through `Ctx` (`src/context.ts`), so tests can replace it.
- All HTTP goes through `src/client.ts`.
- Exit codes (`src/errors.ts`) are a public contract that scripts and coding agents branch on. Do not change what a code means.
- `--json` prints the API response as it came. Do not reshape it.
- Human output is plain tables with no colour, so coding agents can read it.
- New flags should match the ones already used for the same idea: `--on`, `--tf`, `--last`, `--bars`, `--from`, `--to`, `--limit`, `--cursor`, `--all`, `--format`, `--out`.
- Text a user reads (help, messages, docs) is in British English, with no em or en dashes and no marketing words. Say what happens.
- If you change what `chartnaut init` writes (`src/guide.ts`), keep [AGENTS.md](AGENTS.md) consistent with it.

## Propose a change

1. For anything larger than a small fix, open an issue first so the approach can be agreed before you write it.
2. Fork the repository and make your change on a branch.
3. Run `npm run typecheck`, `npm test` and `npm run test:e2e`. All three must pass.
4. Update [README.md](README.md) and [CHANGELOG.md](CHANGELOG.md) when a command, flag, output or exit code changes.
5. Open a pull request that says what changed and why, and how you tested it.

Do not include API keys, credentials files or real account data in issues, pull requests or test fixtures.

## Security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

By contributing, you agree that your contribution is licensed under the [MIT Licence](LICENSE) that covers this repository.
