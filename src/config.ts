import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.js';
import { CliError, EXIT } from './errors.js';

export const DEFAULT_API_URL = 'https://api.chartnaut.com/v1';
export const TOKEN_PAGE_URL = 'https://terminal.chartnaut.com/morpheus/settings/developers';

/**
 * An override URL the CLI may send the key to, or download itself from: https anywhere, plain
 * http only to this machine (the tests' fake API). Anything else is refused, so a stray
 * environment variable cannot send the key over the network in clear text.
 */
export function checkedUrl(raw: string, name: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new CliError(`error: invalid_request: ${name} is not a URL`, EXIT.USAGE);
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.username || u.password || !(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) {
    throw new CliError(`error: invalid_request: ${name} must be an https URL`, EXIT.USAGE);
  }
  return v;
}

export function apiUrl(ctx: Ctx): string {
  const raw = ctx.env.CHARTNAUT_API_URL;
  return raw ? checkedUrl(raw, 'CHARTNAUT_API_URL') : DEFAULT_API_URL;
}

export function credentialsPath(ctx: Ctx): string {
  return path.join(ctx.home, '.config', 'chartnaut', 'credentials.json');
}

/** Token from CHARTNAUT_TOKEN, else the credentials file. Undefined if neither. */
export function loadToken(ctx: Ctx): string | undefined {
  const envToken = ctx.env.CHARTNAUT_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(ctx), 'utf8')) as { token?: string };
    return raw.token || undefined;
  } catch {
    return undefined;
  }
}

export function requireToken(ctx: Ctx): string {
  const t = loadToken(ctx);
  if (!t) {
    throw new CliError('error: unauthorized: not logged in. Run `chartnaut login` or set CHARTNAUT_TOKEN.', EXIT.AUTH);
  }
  return t;
}

export function saveToken(ctx: Ctx, token: string): string {
  const file = credentialsPath(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ token, saved_at: new Date().toISOString() }, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
  return file;
}

export function deleteToken(ctx: Ctx): boolean {
  const file = credentialsPath(ctx);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** The token saved by `chartnaut login` (ignores CHARTNAUT_TOKEN). */
export function loadSavedToken(ctx: Ctx): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(ctx), 'utf8')) as { token?: string };
    return raw.token || undefined;
  } catch {
    return undefined;
  }
}
