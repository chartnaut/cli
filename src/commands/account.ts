import os from 'node:os';
import { Command, Option } from 'commander';
import type { Env } from '../env.js';
import { ApiError, CliError, EXIT } from '../errors.js';
import { TOKEN_PAGE_URL, apiUrl, credentialsPath, deleteToken, loadSavedToken, loadToken, saveToken } from '../config.js';
import { cell, shortTime, table } from '../output.js';
import { KINDS } from '../project.js';
import { openInBrowser, safeBrowserUrl } from '../browser.js';

export function registerAccount(program: Command, env: Env): void {
  program
    .command('login')
    .description('sign in through your browser (--token for CI)')
    .option('--token <token>', 'save this API key instead of signing in with the browser (for CI)')
    .option('--force', 'sign in again, replacing the current login')
    .option('--no-browser', 'print the link instead of opening it')
    .action(async (opts: { token?: string; force?: boolean; browser?: boolean }, cmd: Command) => {
      const saved = loadSavedToken(env.ctx);
      if (saved && !opts.force) {
        try {
          const me = (await env.client.get<any>('/me', { token: saved, retries: 0 })).data;
          if (env.isJson(cmd)) return env.printJson({ already_signed_in: true, ...me });
          env.out(`Already signed in as ${me?.user ?? '?'}. Use --force to switch.`);
          return;
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 401) throw e;
          // The saved key no longer works (revoked or expired): sign in again.
        }
      }

      const token = opts.token?.trim() || (await browserSignIn(env, opts.browser !== false));
      if (!token) throw new CliError('error: invalid_request: no token given', EXIT.USAGE);
      const me = (await env.client.get<any>('/me', { token })).data;
      if (saved && saved !== token) {
        // Replacing a login: retire the key it used rather than leave it live.
        await env.client.post('/auth/revoke', { token: saved, retries: 0 }).catch(() => undefined);
      }
      saveToken(env.ctx, token);
      if (env.isJson(cmd)) return env.printJson(me);
      env.out(`Signed in as ${me?.user ?? '?'}.`);
      if (env.ctx.env.CHARTNAUT_TOKEN) env.err('Note: CHARTNAUT_TOKEN is set and overrides this login.');
    });

  program
    .command('logout')
    .description('sign out')
    .action(async (_opts: unknown, cmd: Command) => {
      const saved = loadSavedToken(env.ctx);
      let revoked = false;
      if (saved) {
        revoked = await env.client
          .post('/auth/revoke', { token: saved, retries: 0 })
          .then(() => true)
          .catch(() => false);
      }
      const removed = deleteToken(env.ctx);
      if (env.isJson(cmd)) return env.printJson({ removed, revoked, path: credentialsPath(env.ctx) });
      if (!removed) env.out('Not signed in.');
      else env.out(revoked ? 'Signed out.' : 'Signed out here. Revoke the key in Settings → Developers to finish.');
      if (env.ctx.env.CHARTNAUT_TOKEN) env.err('Note: CHARTNAUT_TOKEN is still set in this shell.');
    });

  program
    .command('whoami')
    .description('user, plan and token scopes')
    .action(async (_opts: unknown, cmd: Command) => {
      const me = (await env.client.get<any>('/me')).data;
      if (env.isJson(cmd)) return env.printJson(me);
      env.out(`user:   ${me?.user ?? '-'}`);
      env.out(`plan:   ${me?.plan ?? '-'}`);
      if (me?.token) {
        env.out(`token:  ${me.token.name ?? '-'}${me.token.expires_at ? ` (expires ${shortTime(me.token.expires_at)})` : ''}`);
        env.out(`scopes: ${(me.token.scopes ?? []).join(' ') || '-'}`);
      }
      env.out(`api:    ${apiUrl(env.ctx)}`);
    });

  program
    .command('usage')
    .description('compute used this period and every plan cap')
    .action(async (_opts: unknown, cmd: Command) => {
      const u = (await env.client.get<any>('/usage')).data;
      if (env.isJson(cmd)) return env.printJson(u);
      if (u?.period) env.out(`period: ${shortTime(u.period.start)} → ${shortTime(u.period.end)}`);
      if (u?.compute_units) env.out(`compute units: ${cell(u.compute_units.used)} / ${cell(u.compute_units.included)}`);
      const caps = Object.entries<any>(u?.caps ?? {});
      if (caps.length) env.out(table(['cap', 'used', 'limit'], caps.map(([k, c]) => [k, c?.used, c?.limit === null ? 'unlimited' : c?.limit])));
      if (u?.history_start) env.out(`history from: ${shortTime(u.history_start)}`);
      if (u?.memory_bars !== undefined) env.out(`memory bars: ${u.memory_bars}`);
    });

  const library = program.command('library').description("search every script you can use: yours, Chartnaut's and the community's (never their source)");
  library
    .command('search')
    .argument('[q]', 'search text')
    .addOption(new Option('--kind <kind>', 'filter by kind').choices(KINDS))
    .addOption(
      new Option('--scope <scope>', 'whose scripts (default all)').choices(['all', 'library', 'mine', 'published', 'chartnaut', 'community', 'installed']),
    )
    .option('--author <name>', 'one author: a username, chartnaut, or me')
    .addOption(new Option('--sort <sort>', 'order (relevance when searching, else updated)').choices(['relevance', 'updated', 'created', 'adoptions', 'name']))
    .option('--interface', "include each script's settings, outputs and events (with --json)")
    .option('--limit <n>', 'page size')
    .option('--cursor <cursor>', 'page cursor')
    .action(
      async (
        q: string | undefined,
        opts: { kind?: string; scope?: string; author?: string; sort?: string; interface?: boolean; limit?: string; cursor?: string },
        cmd: Command,
      ) => {
      const res = await env.client.get<any>('/library', {
        query: {
          q,
          kind: opts.kind,
          scope: opts.scope,
          author: opts.author,
          sort: opts.sort,
          include: opts.interface ? 'interface' : undefined,
          limit: opts.limit,
          cursor: opts.cursor,
        },
      });
      if (env.isJson(cmd)) return env.printJson(res.data);
      const rows = (res.data?.data ?? []).map((s: any) => [s.ref, s.kind, s.latest_version, s.adoptions ?? '-', s.author, s.name]);
      env.out(rows.length ? table(['ref', 'kind', 'version', 'adoptions', 'author', 'name'], rows) : 'no matches');
      if (res.data?.next_cursor) env.out(`more: --cursor ${res.data.next_cursor}`);
      },
    );
  library
    .command('show')
    .argument('<ref>', 'author/slug[@version]; chartnaut/slug for built-ins, me/slug for your own')
    .addOption(new Option('--kind <kind>', 'when a study shares the slug').choices(KINDS))
    .action(async (ref: string, opts: { kind?: string }, cmd: Command) => {
      const m = /^([^/@]+)\/([^/@]+)(@\d+)?$/.exec(ref);
      if (!m) throw new CliError('error: invalid_request: expected author/slug', EXIT.USAGE);
      const s = (
        await env.client.get<any>(`/library/${encodeURIComponent(m[1]!)}/${encodeURIComponent(m[2]! + (m[3] ?? ''))}`, {
          query: { kind: opts.kind },
        })
      ).data;
      if (env.isJson(cmd)) return env.printJson(s);
      env.out(`${s?.ref ?? ref}  ${s?.kind ?? ''}  v${s?.version || s?.latest_version || '?'}  by ${s?.author ?? '?'}`);
      if (s?.name) env.out(s.name);
      if (s?.description) env.out(s.description);
      const i = s?.interface ?? {};
      const settings = Object.entries<any>(i.settings ?? {});
      if (settings.length) env.out(table(['setting', 'type', 'default'], settings.map(([k, d]) => [k, d?.type, d?.default])));
      if (i.outputs?.length) env.out(table(['output', 'kind', 'pane'], i.outputs.map((o: any) => [o.id, o.kind, o.pane])));
      if (i.events?.length) env.out(table(['event', 'intent', 'payload'], i.events.map((e: any) => [e.id, e.intent, (e.payload_keys ?? []).join(',')])));
      if (i.results?.length) env.out(table(['result', 'kind', 'title'], i.results.map((r: any) => [r.key, r.kind, r.title])));
      if (s?.app_url) env.out(`app: ${s.app_url}`);
    });

  program
    .command('instruments')
    .description('instruments you can run on, with coverage')
    .argument('[q]', 'matches symbol, short symbol and name')
    .addOption(new Option('--category <c>', 'filter by category').choices(['futures', 'index', 'fx', 'commodities', 'crypto']))
    .option('--limit <n>', 'page size')
    .option('--cursor <cursor>', 'page cursor')
    .action(async (q: string | undefined, opts: { category?: string; limit?: string; cursor?: string }, cmd: Command) => {
      const res = await env.client.get<any>('/instruments', { query: { q, category: opts.category, limit: opts.limit, cursor: opts.cursor } });
      if (env.isJson(cmd)) return env.printJson(res.data);
      const rows = (res.data?.data ?? []).map((i: any) => [
        i.short,
        i.symbol,
        i.name,
        i.category,
        i.order_flow,
        i.coverage ? `${shortTime(i.coverage.start).slice(0, 10)} → ${shortTime(i.coverage.end).slice(0, 10)}` : '-',
      ]);
      env.out(rows.length ? table(['short', 'symbol', 'name', 'category', 'order_flow', 'coverage'], rows) : 'no matches');
      if (res.data?.next_cursor) env.out(`more: --cursor ${res.data.next_cursor}`);
    });

  program
    .command('docs')
    .description('scripting reference: topic list, or one topic as markdown')
    .argument('[topic]', 'e.g. definitions/events')
    .action(async (topic: string | undefined, _opts: unknown, cmd: Command) => {
      const auth = { noAuth: !loadToken(env.ctx) };
      if (!topic) {
        const res = await env.client.get<any>('/docs', auth);
        if (env.isJson(cmd)) return env.printJson(res.data);
        // The server lists topic, title and depth (nesting in the docs outline).
        const rows = (res.data?.data ?? []).map((t: any) => [t.topic, t.depth, t.title]);
        env.out(rows.length ? table(['topic', 'depth', 'title'], rows) : 'no topics');
        env.out('read one: chartnaut docs <topic>');
        return;
      }
      const path_ = topic.split('/').map(encodeURIComponent).join('/');
      const md = (await env.client.get<string>(`/docs/${path_}`, { ...auth, text: true })).data;
      if (env.isJson(cmd)) return env.printJson({ topic, markdown: md });
      env.out(md);
    });
}

/**
 * Browser sign-in (device authorization grant): show a code, open the approval page, poll until the
 * person approves in Chartnaut, and return the new API key.
 */
export async function browserSignIn(env: Env, openBrowser: boolean): Promise<string> {
  const start = (
    await env.client.post<any>('/auth/device', { noAuth: true, body: { client_name: os.hostname() } })
  ).data as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number };

  // The link comes from the server: only a checked https Chartnaut link is handed to the OS.
  const opening = openBrowser && !env.ctx.env.CHARTNAUT_NO_BROWSER && safeBrowserUrl(start.verification_uri_complete, env.ctx.env).ok;
  env.err(opening ? `Opening your browser… (or go to ${start.verification_uri_complete})` : `Go to ${start.verification_uri_complete}`);
  env.err(`Code: ${start.user_code}`);
  if (openBrowser && !env.ctx.env.CHARTNAUT_NO_BROWSER) await openInBrowser(env.ctx, start.verification_uri_complete);

  let interval = Math.max(1, start.interval || 3) * 1000;
  const deadline = Date.now() + (start.expires_in || 600) * 1000;
  while (Date.now() < deadline) {
    await env.ctx.sleep(interval);
    const r = await env.ctx.fetch(env.client.url('/auth/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'chartnaut-cli' },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    const body = (await r.json().catch(() => ({}))) as any;
    if (r.ok && body.token) return body.token as string;
    switch (body?.error?.code) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 2000;
        continue;
      case 'access_denied':
        throw new CliError('Sign-in cancelled.', EXIT.AUTH);
      case 'expired_token':
        throw new CliError('The code expired. Run `chartnaut login` again.', EXIT.AUTH);
      default:
        if (r.status >= 500 || r.status === 429) continue;
        throw new CliError(`error: ${body?.error?.code ?? r.status}: ${body?.error?.message ?? 'sign-in failed'}`, EXIT.AUTH);
    }
  }
  throw new CliError('The code expired. Run `chartnaut login` again.', EXIT.AUTH);
}
