import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

/**
 * Everything the CLI touches in the outside world. Tests replace it wholesale,
 * so no command reaches process.*, the network or the real home directory.
 */
export interface Ctx {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  out: (text: string) => void;
  err: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Reads one secret line (hidden when a TTY). */
  readSecret: (prompt: string) => Promise<string>;
  /** Runs an external program; resolves with its exit code. */
  exec: (cmd: string, args: string[]) => Promise<number>;
  platform: NodeJS.Platform;
  arch: string;
  /** The running executable: chartnaut(.exe) when installed, node when run from source. */
  execPath: string;
}

export function realCtx(): Ctx {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    env: process.env,
    cwd: process.cwd(),
    home: os.homedir(),
    out: (t) => process.stdout.write(t.endsWith('\n') ? t : t + '\n'),
    err: (t) => process.stderr.write(t.endsWith('\n') ? t : t + '\n'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readSecret,
    exec: (cmd, args) => execCommand(cmd, args, process.platform),
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
  };
}

async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]?.trim() ?? '';
  }
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (s: string) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          done();
          resolve(buf.trim());
          return;
        }
        if (ch === '\u0003') {
          done();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    stdin.on('data', onData);
  });
}

/** Arguments cmd.exe would interpret. A `.cmd` fallback refuses them rather than risk injection. */
const CMD_UNSAFE = /["%^&|<>\r\n]/;

/**
 * The absolute path of a Windows program found on PATH, never in the current directory: Windows
 * looks in the current directory first for a bare name, so a cloned repo carrying `claude.exe`
 * would otherwise run instead of the real one. `.exe` before `.cmd`.
 */
export function windowsProgramOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.Path ?? env.PATH ?? '').split(';').filter((d) => d && path.win32.isAbsolute(d));
  for (const dir of dirs) {
    for (const ext of ['.exe', '.cmd']) {
      const full = path.win32.join(dir, cmd + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/**
 * Starts a program and resolves its exit code (127 when it cannot be started). On Windows the
 * program is resolved on PATH first (windowsProgramOnPath). Tools installed by npm (such as
 * Claude Code's `claude`) are `.cmd` shims, which Node only starts through a shell: those run
 * through cmd.exe with every argument double-quoted, refusing any argument cmd.exe would interpret.
 */
export function execCommand(cmd: string, args: string[], platform: NodeJS.Platform): Promise<number> {
  const run = (c: string, a: string[], shell: boolean) =>
    new Promise<number | 'missing'>((resolve) => {
      const child = spawn(c, a, { stdio: 'inherit', shell });
      child.on('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ENOENT' || e.code === 'EINVAL' ? 'missing' : 127));
      child.on('exit', (code) => resolve(code ?? 1));
    });
  const done = (r: number | 'missing') => (r === 'missing' ? 127 : r);
  if (platform !== 'win32') return run(cmd, args, false).then(done);
  if (/[\\/.]/.test(cmd)) return Promise.resolve(127);
  const full = windowsProgramOnPath(cmd);
  if (!full) return Promise.resolve(127);
  if (full.toLowerCase().endsWith('.exe')) return run(full, args, false).then(done);
  if (args.some((a) => CMD_UNSAFE.test(a)) || CMD_UNSAFE.test(full)) return Promise.resolve(127);
  return run(`"${full}"`, args.map((a) => `"${a}"`), true).then(done);
}
