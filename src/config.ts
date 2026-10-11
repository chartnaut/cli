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

/** What `chartnaut login` saves. `expires_at` is the key's expiry from /me (null: never; absent: unknown). */
export interface SavedCredentials {
  token?: string;
  saved_at?: string;
  expires_at?: string | null;
}

export function loadSavedCredentials(ctx: Ctx): SavedCredentials | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(ctx), 'utf8')) as SavedCredentials;
    return raw && typeof raw === 'object' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function writeCredentials(ctx: Ctx, creds: SavedCredentials): string {
  const file = credentialsPath(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * Saves the key, and its expiry from /me so every command can warn before it runs out without an
 * extra request. `expiresAt` undefined means the server did not say (the file then records nothing).
 */
export function saveToken(ctx: Ctx, token: string, expiresAt?: string | null): string {
  const creds: SavedCredentials = { token, saved_at: new Date().toISOString() };
  if (expiresAt !== undefined) creds.expires_at = expiresAt;
  return writeCredentials(ctx, creds);
}

/** Refreshes the cached expiry when `token` is the saved key (whoami). Never touches another key's file. */
export function updateSavedExpiry(ctx: Ctx, token: string, expiresAt: string | null | undefined): void {
  if (expiresAt === undefined) return;
  const creds = loadSavedCredentials(ctx);
  if (!creds?.token || creds.token !== token || creds.expires_at === expiresAt) return;
  try {
    writeCredentials(ctx, { ...creds, expires_at: expiresAt });
  } catch {
    // A read-only home folder only costs the warning.
  }
}

/** Days before a key's expiry from which every command warns. */
export const EXPIRY_WARNING_DAYS = 7;
const DAY_MS = 86_400_000;

/** "2027-01-09T10:00:00Z" -> "2027-01-09" (UTC). Undefined for anything that is not a date. */
export function expiryDate(expiresAt: unknown): string | undefined {
  if (typeof expiresAt !== 'string' || !expiresAt) return undefined;
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/** Whole days from now until expiry, rounded to the nearest day (a fresh 90-day key says 90). */
export function daysUntil(expiresAt: string, now = Date.now()): number {
  return Math.round((Date.parse(expiresAt) - now) / DAY_MS);
}

/**
 * The one warning line for a key that runs out within EXPIRY_WARNING_DAYS, else undefined: no
 * warning for a key that never expires, an unknown expiry, a far one, or one already past (the
 * server's "API token expired." says that, with what to do).
 */
export function expiryWarning(expiresAt: string | null | undefined, now = Date.now()): string | undefined {
  const date = expiryDate(expiresAt);
  if (!date) return undefined;
  const left = Date.parse(expiresAt!) - now;
  if (left <= 0 || left > EXPIRY_WARNING_DAYS * DAY_MS) return undefined;
  return `warning: your Chartnaut key expires on ${date}; run chartnaut login to renew.`;
}

/** The warning for the saved login, read from the credentials file. Silent when CHARTNAUT_TOKEN is in use. */
export function savedKeyWarning(ctx: Ctx, now = Date.now()): string | undefined {
  if (ctx.env.CHARTNAUT_TOKEN?.trim()) return undefined;
  const creds = loadSavedCredentials(ctx);
  if (!creds?.token) return undefined;
  return expiryWarning(creds.expires_at, now);
}

export function deleteToken(ctx: Ctx): boolean {
  const file = credentialsPath(ctx);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** The token saved by `chartnaut login` (ignores CHARTNAUT_TOKEN). */
export function loadSavedToken(ctx: Ctx): string | undefined {
  return loadSavedCredentials(ctx)?.token || undefined;
}
