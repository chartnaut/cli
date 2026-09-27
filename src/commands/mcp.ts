import fs from 'node:fs';
import path from 'node:path';
import { Argument, type Command } from 'commander';
import type { Env } from '../env.js';
import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { apiUrl, loadToken } from '../config.js';

export const MCP_CLIENTS = ['claude', 'codex', 'cursor'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

/** The environment variable the API-key variants read. The saved key itself is never printed. */
export const TOKEN_ENV = 'CHARTNAUT_TOKEN';

const DOCS = {
  overview: 'https://docs.chartnaut.com/cli/mcp-overview',
  claude: 'https://docs.chartnaut.com/cli/mcp-claude',
  cursor: 'https://docs.chartnaut.com/cli/mcp-cursor-and-codex',
  codex: 'https://docs.chartnaut.com/cli/mcp-cursor-and-codex',
} as const;

const CLIENT_NAMES: Record<McpClient, string> = { claude: 'Claude Code', cursor: 'Cursor', codex: 'Codex' };

/** The remote MCP server: the API origin + /mcp. */
export function mcpUrl(ctx: Ctx): string {
  return `${apiUrl(ctx)}/mcp`;
}

export function cursorConfigPath(ctx: Ctx): string {
  return path.join(ctx.home, '.cursor', 'mcp.json');
}

export function codexConfigPath(ctx: Ctx): string {
  return path.join(ctx.home, '.codex', 'config.toml');
}

function claudeOauthLine(url: string): string {
  return `claude mcp add --transport http chartnaut ${url}`;
}

function claudeKeyLine(url: string): string {
  return `${claudeOauthLine(url)} --header "Authorization: Bearer $${TOKEN_ENV}"`;
}

function cursorOauth(url: string) {
  return { mcpServers: { chartnaut: { url } } };
}

function cursorApiKey(url: string) {
  return { mcpServers: { chartnaut: { url, headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } } } };
}

function codexLines(url: string): string[] {
  return ['[mcp_servers.chartnaut]', `url = ${JSON.stringify(url)}`, `bearer_token_env_var = "${TOKEN_ENV}"`];
}

/** A short, safe-to-print prefix of an API key: never the whole key, even a short one. */
export function keyPrefix(key: string): string {
  return `${key.slice(0, Math.min(12, Math.floor(key.length / 2)))}…`;
}

export function registerMcp(program: Command, env: Env): void {
  const mcp = program.command('mcp').description("connect Claude, Cursor or Codex to Chartnaut's MCP server");
  mcp
    .command('install')
    .description('print the MCP setup for Claude Code, Cursor or Codex (--write applies it)')
    .addArgument(new Argument('[client]', 'one client (default: print all three)').choices(MCP_CLIENTS))
    .option('--write', 'apply the config for <client>: claude runs `claude mcp add`, cursor and codex edit their config file')
    .addHelpText(
      'after',
      [
        '',
        'Makes no network calls. Without --write it only prints. Printed API-key variants read',
        `${TOKEN_ENV} from the environment; the saved key is never printed.`,
        '',
        'With --write:',
        '  claude  runs `claude mcp add --scope user` with your saved API key',
        '  cursor  adds chartnaut, with your saved API key, to ~/.cursor/mcp.json',
        `  codex   adds chartnaut to ~/.codex/config.toml; Codex reads the key from ${TOKEN_ENV}`,
        '',
        `Docs: ${DOCS.overview}`,
      ].join('\n'),
    )
    .action(async (client: McpClient | undefined, opts: { write?: boolean }, cmd: Command) => {
      const json = env.isJson(cmd);
      if (opts.write) {
        if (!client) throw new CliError('error: invalid_request: --write needs a client: claude, codex or cursor', EXIT.USAGE);
        return writeClient(env, client, json);
      }
      printSetup(env, client, json);
    });
}

function printSetup(env: Env, client: McpClient | undefined, json: boolean): void {
  const url = mcpUrl(env.ctx);
  const clients = client ? [client] : [...MCP_CLIENTS];
  if (json) {
    const all = {
      claude: { oauth: claudeOauthLine(url), api_key: claudeKeyLine(url) },
      cursor: { path: cursorConfigPath(env.ctx), oauth: cursorOauth(url), api_key: cursorApiKey(url) },
      codex: { path: codexConfigPath(env.ctx), config: codexLines(url).join('\n') + '\n' },
    };
    env.printJson({ url, clients: Object.fromEntries(clients.map((c) => [c, all[c]])) });
    return;
  }
  const lines: string[] = [
    `Chartnaut MCP server: ${url}`,
    'Needs a Starter plan or above. Sign in through the browser (OAuth), or send an API key.',
  ];
  const indent = (text: string, n: number) => text.split('\n').map((l) => ' '.repeat(n) + l);
  // Claude Code, Cursor, Codex: the order people most often ask for.
  for (const c of (['claude', 'cursor', 'codex'] as McpClient[]).filter((x) => clients.includes(x))) {
    lines.push('', CLIENT_NAMES[c]);
    if (c === 'claude') {
      lines.push(
        '  Sign in through the browser:',
        `    ${claudeOauthLine(url)}`,
        '    Then run /mcp in Claude Code, pick chartnaut and choose Authenticate. Sign-in happens in your browser.',
        `  Or use an API key from ${TOKEN_ENV}:`,
        `    ${claudeKeyLine(url)}`,
        `    ${TOKEN_ENV} must be set in the shell you run it from (PowerShell: $env:${TOKEN_ENV}).`,
        '  Or add it with your saved key: chartnaut mcp install claude --write',
      );
    } else if (c === 'cursor') {
      lines.push(
        '  Add to ~/.cursor/mcp.json (Cursor signs you in through the browser when it first connects):',
        ...indent(JSON.stringify(cursorOauth(url), null, 2), 4),
        `  Or use an API key from ${TOKEN_ENV} in the environment Cursor starts from:`,
        ...indent(JSON.stringify(cursorApiKey(url), null, 2), 4),
        '  Or write it with your saved key: chartnaut mcp install cursor --write',
      );
    } else {
      lines.push(
        '  Add to ~/.codex/config.toml:',
        ...indent(codexLines(url).join('\n'), 4),
        `  Codex reads the key from ${TOKEN_ENV} in the environment it starts from.`,
        '  Or write it: chartnaut mcp install codex --write',
      );
    }
    lines.push(`  Docs: ${DOCS[c]}`);
  }
  lines.push('', `Docs: ${DOCS.overview}`);
  env.out(lines.join('\n'));
}

async function writeClient(env: Env, client: McpClient, json: boolean): Promise<void> {
  const ctx = env.ctx;
  const url = mcpUrl(ctx);
  if (client === 'codex') {
    const file = codexConfigPath(ctx);
    const replaced = writeCodexConfig(file, url);
    if (json) return env.printJson({ client, url, path: file, replaced, token_env: TOKEN_ENV });
    env.out(`${replaced ? 'Updated' : 'Added'} [mcp_servers.chartnaut] in ${file}.`);
    env.out(`Codex reads the key from ${TOKEN_ENV}: set it in the environment Codex starts from.`);
    return;
  }

  const key = loadToken(ctx);
  if (!key) {
    const oauth =
      client === 'claude' ? claudeOauthLine(url) : `add ${JSON.stringify(cursorOauth(url))} to ~/.cursor/mcp.json`;
    throw new CliError(
      `error: unauthorized: no API key to write. Run \`chartnaut login\` (or set ${TOKEN_ENV}), or sign in with OAuth instead: ${oauth}`,
      EXIT.AUTH,
    );
  }

  if (client === 'claude') {
    const code = await ctx.exec('claude', ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'chartnaut', url, '--header', `Authorization: Bearer ${key}`]);
    if (code === 127) {
      throw new CliError(
        `error: Claude Code's \`claude\` command was not found. Install Claude Code, or run this yourself and sign in with /mcp:\n  ${claudeOauthLine(url)}`,
        EXIT.USAGE,
      );
    }
    if (code !== 0) {
      throw new CliError(
        `error: \`claude mcp add\` exited with code ${code}. If chartnaut is already added, remove it first: claude mcp remove chartnaut --scope user`,
        EXIT.USAGE,
      );
    }
    if (json) return env.printJson({ client, url, scope: 'user', key_prefix: keyPrefix(key) });
    env.out(`Added chartnaut to Claude Code (user scope) with your API key ${keyPrefix(key)}. Revoke the key under Developers to cut it off.`);
    return;
  }

  const file = cursorConfigPath(ctx);
  writeCursorConfig(ctx, file, url, key);
  if (json) return env.printJson({ client, url, path: file, key_prefix: keyPrefix(key) });
  env.out(`Added chartnaut to ${file}. The file now holds your API key ${keyPrefix(key)}.`);
  env.out('To remove it, delete mcpServers.chartnaut from that file, and revoke the key under Developers to cut it off.');
}

/** Merges mcpServers.chartnaut into Cursor's mcp.json, keeping every other server and key. */
function writeCursorConfig(ctx: Ctx, file: string, url: string, key: string): void {
  let config: Record<string, unknown> = {};
  let exists = false;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    exists = true;
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      config = parsed as Record<string, unknown>;
    }
  } catch (e) {
    if (exists) {
      throw new CliError(`error: invalid_request: ${file} is not valid JSON (${(e as Error).message}). Fix it or add the server by hand; nothing was changed.`, EXIT.USAGE);
    }
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const servers = config.mcpServers ?? {};
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new CliError(`error: invalid_request: mcpServers in ${file} is not an object; nothing was changed.`, EXIT.USAGE);
  }
  config.mcpServers = { ...(servers as Record<string, unknown>), chartnaut: { url, headers: { Authorization: `Bearer ${key}` } } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  if (ctx.platform !== 'win32') fs.chmodSync(file, 0o600);
}

const CODEX_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(chartnaut|"chartnaut")\s*\]\s*(#.*)?$/;

/**
 * Sets [mcp_servers.chartnaut] in Codex's config.toml: replaces that table's lines (up to the next
 * `[` header) or appends the table. Everything else stays byte-for-byte. Returns true if it replaced.
 */
function writeCodexConfig(file: string, url: string): boolean {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = codexLines(url);
  const lines = text.split(eol);
  const start = lines.findIndex((l) => CODEX_HEADER.test(l));
  let out: string;
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
    // Keep the blank lines (and a final newline) that separated the old table from what follows.
    let keepFrom = end;
    while (keepFrom > start + 1 && lines[keepFrom - 1]!.trim() === '') keepFrom--;
    out = [...lines.slice(0, start), ...block, ...lines.slice(keepFrom)].join(eol);
    if (keepFrom === lines.length) out += eol;
  } else if (text.trim() === '') {
    out = block.join(eol) + eol;
  } else {
    out = text + (text.endsWith(eol) ? '' : eol) + eol + block.join(eol) + eol;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return start >= 0;
}
