/**
 * Hermetic end-to-end harness: the real built CLI (`node dist/index.js`) as a child process,
 * talking to a local node:http fake of the public API. Nothing leaves 127.0.0.1.
 *
 * Every CLI process gets a fresh, minimal environment: HOME / USERPROFILE point at a temp dir,
 * CHARTNAUT_API_URL at the fake server, CHARTNAUT_NO_BROWSER=1, and nothing else from the caller's
 * environment that could reach a real account (CHARTNAUT_TOKEN is only set when a test passes one).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** cli/: this file runs from build-test/test/e2e/. */
export const CLI_ROOT = path.resolve(here, '..', '..', '..');
export const CLI_JS = path.join(CLI_ROOT, 'dist', 'index.js');

// ───────────────────────────── fake API ─────────────────────────────

export interface Recorded {
  method: string;
  /** Path without the /v1 prefix, percent-decoded, e.g. `/library/jane/orb@7`. */
  path: string;
  /** The path exactly as sent (still percent-encoded, /v1 included). */
  rawPath: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON when the body is JSON, the raw text otherwise, undefined when empty. */
  body: any;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}
export type Handler = (req: Recorded, n: number) => Reply;
export type Route = Reply | Reply[] | Handler;

export interface FakeApi {
  /** Base URL to hand the CLI as CHARTNAUT_API_URL, e.g. http://127.0.0.1:53211/v1. */
  url: string;
  /** Origin of the server, for routes outside /v1 (the release manifest). */
  origin: string;
  requests: Recorded[];
  /** Sets (or replaces) the reply for "METHOD /path"; the path excludes /v1 and the query and is decoded. */
  on(key: string, route: Route): void;
  /** Requests whose "METHOD /path" equals key. */
  calls(key: string): Recorded[];
  /** Forgets recorded requests, routes and per-route counters. */
  reset(): void;
  close(): Promise<void>;
}

/** An API error in the envelope every refused call uses. */
export function apiError(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): Reply {
  return { status, json: { error: { code, message }, ...extra }, headers };
}

export async function startFakeApi(): Promise<FakeApi> {
  const routes = new Map<string, Route>();
  const counts = new Map<string, number>();
  const requests: Recorded[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://fake.invalid');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const p = decodeURIComponent(u.pathname.replace(/^\/v1(?=\/|$)/, ''));
      const rec: Recorded = { method: req.method ?? 'GET', path: p, rawPath: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body };
      requests.push(rec);
      const key = `${rec.method} ${p}`;
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      const route = routes.get(key);
      let reply: Reply;
      if (route === undefined) reply = apiError(404, 'not_found', `fake API has no route for ${key}`);
      else if (Array.isArray(route)) reply = route[Math.min(n, route.length - 1)]!;
      else if (typeof route === 'function') reply = route(rec, n);
      else reply = route;
      const status = reply.status ?? 200;
      const headers: Record<string, string> = { ...(reply.headers ?? {}) };
      let out = '';
      if (reply.text !== undefined) {
        out = reply.text;
        headers['Content-Type'] ??= 'text/plain; charset=utf-8';
      } else if (reply.json !== undefined) {
        out = JSON.stringify(reply.json);
        headers['Content-Type'] ??= 'application/json';
      }
      res.writeHead(status, headers);
      res.end(status === 204 ? undefined : out);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/v1`,
    origin,
    requests,
    on: (key, route) => void routes.set(key, route),
    calls: (key) => requests.filter((r) => `${r.method} ${r.path}` === key),
    reset() {
      routes.clear();
      counts.clear();
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ───────────────────────────── the CLI ─────────────────────────────

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface CliOptions {
  cwd: string;
  home: string;
  /** Sent as CHARTNAUT_TOKEN; omit to rely on the saved login (or none). */
  token?: string;
  env?: Record<string, string>;
}

export function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Runs `node dist/index.js ...args` against the fake API and resolves when it exits. */
export function runCli(api: FakeApi, args: string[], opts: CliOptions): Promise<CliResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: opts.home,
    USERPROFILE: opts.home,
    TMPDIR: os.tmpdir(),
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    CHARTNAUT_API_URL: api.url,
    CHARTNAUT_DOWNLOAD_URL: `${api.origin}/dl`,
    CHARTNAUT_NO_BROWSER: '1',
    NO_COLOR: '1',
    ...(opts.token ? { CHARTNAUT_TOKEN: opts.token } : {}),
    ...(opts.env ?? {}),
  };
  // Windows needs these to start a process at all.
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT']) if (process.env[k]) env[k] = process.env[k]!;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_JS, ...args], { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - started }));
  });
}

/** A fake API, a temp HOME and a temp project folder for one test file. */
export interface World {
  api: FakeApi;
  home: string;
  cwd: string;
  /** Runs the CLI in `cwd` with `home`; `token` defaults to the world's token (if any). */
  cli: (args: string[], opts?: Partial<CliOptions>) => Promise<CliResult>;
  dispose: () => Promise<void>;
}

export async function world(token?: string): Promise<World> {
  if (!fs.existsSync(CLI_JS)) throw new Error(`${CLI_JS} is missing: run \`npm run build\` first (npm run test:e2e does)`);
  const api = await startFakeApi();
  const home = tmpdir('cn-e2e-home-');
  const cwd = tmpdir('cn-e2e-cwd-');
  return {
    api,
    home,
    cwd,
    cli: (args, opts = {}) => runCli(api, args, { cwd, home, token, ...opts }),
    dispose: async () => {
      await api.close();
      for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

export function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Escapes text for use inside a RegExp. */
export function re(s: string): RegExp {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
