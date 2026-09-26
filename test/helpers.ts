import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx } from '../src/context.js';
import { main } from '../src/cli.js';

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

export type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
export type Handler = (call: Call, n: number) => Reply | Promise<Reply>;

export interface Harness {
  ctx: Ctx;
  calls: Call[];
  stdout: string[];
  stderr: string[];
  sleeps: number[];
  execs: { cmd: string; args: string[] }[];
  cwd: string;
  home: string;
  run: (...argv: string[]) => Promise<number>;
  out: () => string;
  err: () => string;
}

export function tmpdir(prefix = 'cn-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A Ctx with a routed fake fetch. `routes` maps "METHOD /path" (path without
 * the /v1 base, no query) to a reply or handler; unmatched requests 404.
 */
export function harness(routes: Record<string, Reply | Handler | Reply[]> = {}, opts: { env?: Record<string, string>; secret?: string } = {}): Harness {
  const cwd = tmpdir('cn-cwd-');
  const home = tmpdir('cn-home-');
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sleeps: number[] = [];
  const execs: { cmd: string; args: string[] }[] = [];
  const counts = new Map<string, number>();

  const fakeFetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { method: init.method ?? 'GET', url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const p = url.pathname.replace(/^\/v1/, '');
    const key = `${call.method} ${p}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    let r = routes[key];
    let reply: Reply;
    if (r === undefined) reply = { status: 404, json: { error: { code: 'not_found', message: `no route ${key}` } } };
    else if (Array.isArray(r)) reply = r[Math.min(n, r.length - 1)]!;
    else if (typeof r === 'function') reply = await r(call, n);
    else reply = r;
    const body = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    const status = reply.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : body, { status, headers: reply.headers });
  }) as typeof fetch;

  const ctx: Ctx = {
    fetch: fakeFetch,
    env: { CHARTNAUT_API_URL: 'https://api.test/v1', CHARTNAUT_TOKEN: 'cn_test_token', ...(opts.env ?? {}) },
    cwd,
    home,
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    readSecret: async () => opts.secret ?? '',
    exec: async (cmd, args) => {
      execs.push({ cmd, args });
      return 0;
    },
    platform: 'darwin',
    arch: 'arm64',
    execPath: '/usr/local/bin/node',
  };
  return {
    ctx,
    calls,
    stdout,
    stderr,
    sleeps,
    execs,
    cwd,
    home,
    run: (...argv) => main(argv, ctx),
    out: () => stdout.join('\n'),
    err: () => stderr.join('\n'),
  };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}
