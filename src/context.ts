import os from 'node:os';
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
    exec: (cmd, args) =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: 'inherit' });
        child.on('error', () => resolve(127));
        child.on('exit', (code) => resolve(code ?? 1));
      }),
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
