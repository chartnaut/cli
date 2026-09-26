import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { Env } from '../env.js';
import { CliError, EXIT } from '../errors.js';
import { VERSION } from '../version.js';

/** Where the release manifest lives; the install scripts read the same file. */
export const DEFAULT_DOWNLOAD_URL = 'https://desktop-updates.chartnaut.com/cli';

export interface ReleaseAsset {
  url: string;
  sha256: string;
  size?: number;
}
export interface ReleaseManifest {
  version: string;
  assets: Record<string, ReleaseAsset>;
}

/** -1, 0 or 1, comparing dotted numeric versions (0.10.0 > 0.9.9). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The manifest key for this machine, matching the install scripts. */
export function platformKey(platform: string, arch: string, musl: boolean): string | null {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !cpu) return null;
  if (os === 'windows') return 'windows-x64';
  return `${os}-${cpu}${os === 'linux' && musl ? '-musl' : ''}`;
}

/** The installed CLI is the chartnaut executable itself; running it through node means a development copy. */
export function isStandalone(execPath: string): boolean {
  return /^chartnaut(\.exe)?$/i.test(path.basename(execPath));
}

function isMusl(): boolean {
  try {
    if (fs.existsSync('/etc/alpine-release')) return true;
    const report = (process as any).report?.getReport?.();
    return Boolean(report && report.header && !report.header.glibcVersionRuntime);
  } catch {
    return false;
  }
}

export function registerUpgrade(program: Command, env: Env): void {
  program
    .command('upgrade')
    .description('update chartnaut to the latest version')
    .option('--check', 'only report whether a newer version exists')
    .action(async (opts: { check?: boolean }, cmd: Command) => {
      const base = (env.ctx.env.CHARTNAUT_DOWNLOAD_URL || DEFAULT_DOWNLOAD_URL).replace(/\/+$/, '');
      let manifest: ReleaseManifest;
      try {
        const r = await env.ctx.fetch(`${base}/latest.json`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        manifest = (await r.json()) as ReleaseManifest;
      } catch (e) {
        throw new CliError(`error: could not read ${base}/latest.json (${(e as Error).message})`, EXIT.RETRYABLE);
      }
      const newer = compareVersions(manifest.version, VERSION) > 0;
      const standalone = isStandalone(env.ctx.execPath);
      const status = { current: VERSION, latest: manifest.version, update_available: newer, install: standalone ? 'standalone' : 'development' };
      if (opts.check || !newer) {
        if (env.isJson(cmd)) return env.printJson(status);
        return env.out(newer ? `chartnaut ${manifest.version} is available (you have ${VERSION}). Run: chartnaut upgrade` : `chartnaut ${VERSION} is the latest version`);
      }
      if (!standalone) {
        env.out(`chartnaut ${manifest.version} is available (you have ${VERSION}). This copy runs from source; install the released CLI with:\n  curl -fsSL https://chartnaut.com/install.sh | sh        (macOS / Linux)\n  irm https://chartnaut.com/install.ps1 | iex             (Windows)`);
        return;
      }
      const key = platformKey(env.ctx.platform, env.ctx.arch, env.ctx.platform === 'linux' && isMusl());
      const asset = key ? manifest.assets[key] : undefined;
      if (!key || !asset) throw new CliError(`error: no build of ${manifest.version} for ${key ?? `${env.ctx.platform}-${env.ctx.arch}`}`, EXIT.USAGE);

      const res = await env.ctx.fetch(asset.url);
      if (!res.ok) throw new CliError(`error: download failed (${res.status}) ${asset.url}`, EXIT.RETRYABLE);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got !== asset.sha256) throw new CliError(`error: checksum mismatch for ${asset.url}; nothing was changed`, EXIT.RETRYABLE);

      const target = env.ctx.execPath;
      const staged = `${target}.new`;
      fs.writeFileSync(staged, buf, { mode: 0o755 });
      if (env.ctx.platform === 'win32') {
        // A running .exe cannot be replaced, only renamed; the old copy is removed next time.
        const old = `${target}.old`;
        fs.rmSync(old, { force: true });
        fs.renameSync(target, old);
      }
      fs.renameSync(staged, target);
      if (env.isJson(cmd)) return env.printJson({ ...status, installed: manifest.version });
      env.out(`chartnaut updated ${VERSION} → ${manifest.version}`);
    });
}
