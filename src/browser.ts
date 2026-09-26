import type { Ctx } from './context.js';

/** Hosts a server-supplied link may point at, besides the configured app host. */
export const TRUSTED_DOMAIN = 'chartnaut.com';

/** The app's host from CHARTNAUT_APP_URL or PUBLIC_APP_URL, lowercased with any port; undefined when unset or unparseable. */
export function configuredAppHost(env: Ctx['env']): string | undefined {
  const raw = (env.CHARTNAUT_APP_URL || env.PUBLIC_APP_URL || '').trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export type SafeUrl = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Decides whether a link that came from the server may be handed to the OS to open. Only `https:`
 * links to chartnaut.com, *.chartnaut.com or the configured app host pass, without credentials, and
 * what is returned is the URL re-serialised by `new URL(...).href`, never the raw string.
 */
export function safeBrowserUrl(raw: unknown, env: Ctx['env'] = {}): SafeUrl {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'no link' };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: `only https links are opened, not ${u.protocol}` };
  if (u.username || u.password) return { ok: false, reason: 'the link carries credentials' };
  const host = u.hostname.toLowerCase();
  const trusted =
    (host === TRUSTED_DOMAIN || host.endsWith('.' + TRUSTED_DOMAIN)) && (u.port === '' || u.port === '443')
      ? true
      : configuredAppHost(env) === u.host.toLowerCase();
  if (!trusted) return { ok: false, reason: `${u.host} is not a Chartnaut host` };
  return { ok: true, url: u.href };
}

/**
 * The program and arguments that open url in the default browser. Windows goes through rundll32's
 * URL handler rather than `cmd /c start`, so the URL is never parsed by cmd.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

/**
 * Opens a server-supplied link after safeBrowserUrl approves it. On refusal nothing is launched:
 * the link and the reason go to stderr so the person can decide. Resolves with the launcher's exit
 * code, or undefined when the link was refused.
 */
export async function openInBrowser(ctx: Ctx, raw: unknown): Promise<number | undefined> {
  const safe = safeBrowserUrl(raw, ctx.env);
  if (!safe.ok) {
    ctx.err(`warning: not opening ${String(raw)} in a browser: ${safe.reason}`);
    return undefined;
  }
  const [bin, args] = browserCommand(ctx.platform, safe.url);
  return ctx.exec(bin, args).catch(() => 127);
}
