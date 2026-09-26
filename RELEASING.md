# Releasing the CLI

One channel: the install scripts, which install standalone binaries, and `chartnaut upgrade`, which
reads the same manifest. The CLI is not published to npm (`package.json` is `private`).

1. **Bump** `version` in `package.json` and `VERSION` in `src/version.ts` (the build refuses a mismatch).
2. **Test**: `npm run typecheck && npm test && npm run test:e2e`. `test:e2e` runs the built CLI
   against a local fake API (no network). Run the live suite against staging as well before a release.
3. **Build the binaries**: `npm run build:binaries`. `release/` then holds one executable per
   platform, `SHA256SUMS`, `manifest.json` and `latest.json`.
4. **Publish**: `npm run publish:r2` (needs the `R2_*` variables). It uploads the
   binaries and `manifest.json` to `cli/<version>/`, then `latest.json` to `cli/latest.json` last.
   `latest.json` is the switch: new installs and `chartnaut upgrade` pick the version up from
   there. Roll back by re-publishing the previous release's `latest.json`.

## Where things are served

| URL | What | Source |
|---|---|---|
| `chartnaut.com/install.sh` | macOS/Linux installer | `install/install.sh` (chartnaut.com serves a copy; keep them identical) |
| `chartnaut.com/install.ps1` | Windows installer | `install/install.ps1` (chartnaut.com serves a copy; keep them identical) |
| `desktop-updates.chartnaut.com/cli/latest.json` | current release manifest | `publish:r2` |
| `desktop-updates.chartnaut.com/cli/<version>/…` | binaries + pinned manifest | `publish:r2` |

Serve `install.ps1` as `text/plain` (not `application/octet-stream`): `irm … | iex` needs text.
The binaries sit in the same R2 bucket as the desktop app (`stable/` is the desktop channel,
`cli/` is this). `CHARTNAUT_RELEASE_BASE` can point them elsewhere; only the URLs inside
`latest.json` change, never the install scripts.

## Before general availability

- **macOS**: sign and notarize the darwin binaries. A binary downloaded by a browser is
  quarantined and Gatekeeper blocks it; `curl | sh` installs are not quarantined.
- **Windows**: sign `chartnaut-windows-x64.exe` (Authenticode) or SmartScreen warns on first run.
- The Linux and Windows installers have been checked for platform selection, download and
  checksum refusal on macOS only; run them once on a real Linux box and Windows machine.
