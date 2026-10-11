# Releasing the CLI

The install scripts install standalone binaries, and `chartnaut upgrade` reads the same manifest.
The CLI is not published to npm (`package.json` is `private`). There are two channels:

| Channel | Bucket keys | Who gets it |
|---|---|---|
| `stable` | `cli/<version>/…`, `cli/latest.json` | every install and `chartnaut upgrade` |
| `unstable` | `cli/unstable/<version>/…`, `cli/unstable/latest.json` | only `CHARTNAUT_DOWNLOAD_URL=https://desktop-updates.chartnaut.com/cli/unstable` |

A release goes to `unstable` first, passes the release gate there, and is then promoted to
`stable` byte for byte. Nothing is rebuilt between the gate and the users.

1. **Bump** `version` in `package.json` and `VERSION` in `src/version.ts` (the build refuses a mismatch).
2. **Test**: `npm run typecheck && npm test && npm run test:e2e`. `test:e2e` runs the built CLI
   against a local fake API (no network).
3. **Build for unstable**: `CHARTNAUT_CHANNEL=unstable npm run build:binaries` (or
   `npm run build:binaries -- --channel unstable`). `release/` then holds one executable per
   platform, `SHA256SUMS`, `manifest.json` and `latest.json`, with every URL under
   `…/cli/unstable/<version>/` and `"channel": "unstable"` in the manifest. The build refuses
   to write a manifest if the binary for this machine reads `bunfig.toml` or `.env` from its folder.
4. **Publish to unstable**: `npm run publish:r2 -- --channel unstable` (needs the `R2_*`
   variables). It uploads the binaries and `manifest.json` to `cli/unstable/<version>/`, then
   `cli/unstable/latest.json` last. It refuses a build made for the other channel, and any file
   whose sha256 does not match the manifest. Stable users see nothing yet.
5. **Release gate**: in `core-e2e-tests`, run the full suite plus `19-release` with
   `E2E_TARGET=<target>` and that target's `cli.channel` set to `unstable`. It downloads
   `cli/unstable/latest.json`, checks every binary's checksum, runs this OS's binary, installs from
   the R2 installers with the unstable base, and upgrades from the previous version. Promote only
   if it passes.
6. **Promote**: `npm run promote:r2 -- <version>`. It reads `cli/unstable/<version>/manifest.json`,
   re-checks every binary there against its sha256 (and refuses to overwrite a different
   `cli/<version>/` binary), copies them to `cli/<version>/`, writes the stable manifest (URLs
   under `cli/<version>/`) to `cli/<version>/manifest.json`, and `cli/latest.json` last. Nothing is
   written unless every binary checks out. `cli/latest.json` is the switch: new installs and
   `chartnaut upgrade` pick the version up from there.

Roll back by re-publishing the previous release's `latest.json` to `cli/latest.json`.
A plain `npm run build:binaries && npm run publish:r2` still publishes straight to stable (the
default channel); keep it for emergencies.

Try a candidate by hand:

```sh
curl -fsSL https://chartnaut.com/install.sh | CHARTNAUT_DOWNLOAD_URL=https://desktop-updates.chartnaut.com/cli/unstable sh
CHARTNAUT_DOWNLOAD_URL=https://desktop-updates.chartnaut.com/cli/unstable chartnaut upgrade
```

## Where things are served

| URL | What | Source |
|---|---|---|
| `chartnaut.com/install.sh` | macOS/Linux installer: a Cloudflare redirect to the R2 copy below | nothing to publish |
| `chartnaut.com/install.ps1` | Windows installer: a Cloudflare redirect to the R2 copy below | nothing to publish |
| `desktop-updates.chartnaut.com/cli/install.sh`, `…/cli/install.ps1` | the installers: the only copies anywhere | `npm run publish:installers` (after any change to `install/`) |
| `desktop-updates.chartnaut.com/cli/latest.json` | current release manifest | `promote:r2` (or `publish:r2`) |
| `desktop-updates.chartnaut.com/cli/<version>/…` | binaries + pinned manifest | `promote:r2` (or `publish:r2`) |
| `desktop-updates.chartnaut.com/cli/unstable/latest.json` | release candidate manifest | `publish:r2 -- --channel unstable` |
| `desktop-updates.chartnaut.com/cli/unstable/<version>/…` | candidate binaries + pinned manifest | `publish:r2 -- --channel unstable` |

The installers exist only in R2; chartnaut.com does not serve its own copies. `publish:installers`
serves `install.ps1` as `text/plain` (not `application/octet-stream`): `irm … | iex` needs text.
The binaries sit in the same R2 bucket as the desktop app (`stable/` is the desktop channel,
`cli/` is this). `CHARTNAUT_RELEASE_BASE` can point them elsewhere (the unstable channel is
`<base>/unstable`); only the URLs inside `latest.json` change, never the install scripts.

`chartnaut upgrade` refuses a `CHARTNAUT_DOWNLOAD_URL` that is not https (plain http only to
localhost). The install scripts do not check it: they download whatever URL they are given, and
the sha256 check is against a manifest from that same URL.

## Before general availability

- **macOS**: sign and notarize the darwin binaries. A binary downloaded by a browser is
  quarantined and Gatekeeper blocks it; `curl | sh` installs are not quarantined.
- **Windows**: sign `chartnaut-windows-x64.exe` (Authenticode) or SmartScreen warns on first run.
- The Linux and Windows installers have been checked for platform selection, download and
  checksum refusal on macOS only; run them once on a real Linux box and Windows machine.
