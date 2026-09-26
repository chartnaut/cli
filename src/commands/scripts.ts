import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Command, Option } from 'commander';
import type { Env } from '../env.js';
import { encodeRef } from '../client.js';
import { ApiError, CliError, EXIT, formatDiagnostic } from '../errors.js';
import { agentGuide, type DocTopic } from '../guide.js';
import { unifiedDiff } from '../diff.js';
import { shortTime, table } from '../output.js';
import { loadToken } from '../config.js';
import { browserCommand, openInBrowser } from '../browser.js';
import {
  KIND_DIR,
  KINDS,
  PROJECT_FILE,
  SLUG_RE,
  type Kind,
  type ScriptFile,
  type ScriptMeta,
  findLocalScript,
  findProjectRoot,
  parseKind,
  readScript,
  starterFor,
  writeScript,
  writeScriptMeta,
  displayPath,
} from '../project.js';

export const INIT_DEFAULTS = { instrument: 'BTC', timeframe: '5m', window: '90d' };

/** `slug@3` → `slug`; `author/slug@3` → `slug`. */
export function slugOf(ref: string): string {
  return ref.replace(/@\d+$/, '').split('/').pop()!;
}

function interfaceLines(i: any): string[] {
  if (!i) return [];
  const lines: string[] = [];
  const settings = Object.entries<any>(i.settings ?? {});
  if (settings.length) lines.push(table(['setting', 'type', 'default'], settings.map(([k, s]) => [k, s?.type, s?.default])));
  if (i.outputs?.length) lines.push(table(['output', 'kind', 'pane'], i.outputs.map((o: any) => [o.id, o.kind, o.pane])));
  if (i.events?.length) lines.push(table(['event', 'intent', 'payload'], i.events.map((e: any) => [e.id, e.intent, (e.payload_keys ?? []).join(',')])));
  if (i.results?.length) lines.push(table(['result', 'kind', 'title'], i.results.map((r: any) => [r.key, r.kind, r.title])));
  if (i.timeframes?.length) lines.push(`extra timeframes: ${i.timeframes.join(' ')}`);
  if (i.warmup_bars !== undefined) lines.push(`warmup bars: ${i.warmup_bars}`);
  return lines;
}

export function registerScripts(program: Command, env: Env): void {
  program
    .command('init')
    .description('set up a Chartnaut project here: chartnaut.json, script folders and the agent guide in CLAUDE.md + AGENTS.md. Additive: never removes or overwrites what you wrote')
    .option('--instrument <symbol>', 'default instrument', INIT_DEFAULTS.instrument)
    .option('--tf <timeframe>', 'default timeframe', INIT_DEFAULTS.timeframe)
    .option('--window <span>', 'default window', INIT_DEFAULTS.window)
    .action(async (opts: { instrument: string; tf: string; window: string }, cmd: Command) => {
      const root = env.ctx.cwd;
      let topics: DocTopic[] | undefined;
      try {
        topics = (await env.client.get<any>('/docs', { noAuth: !tokenAvailable(env), retries: 0 })).data?.data;
      } catch {
        topics = undefined;
      }
      const report: { file: string; action: string }[] = [];

      // chartnaut.json: keep every existing key. Fill in defaults that are missing; a flag you
      // pass explicitly sets its default even when one exists (you asked for it).
      const explicit = (name: string) => cmd.getOptionValueSource(name) === 'cli';
      const wanted: Record<string, { value: string; explicit: boolean }> = {
        instrument: { value: opts.instrument, explicit: explicit('instrument') },
        timeframe: { value: opts.tf, explicit: explicit('tf') },
        window: { value: opts.window, explicit: explicit('window') },
      };
      const projectPath = path.join(root, PROJECT_FILE);
      let project: any = {};
      let projectReadable = true;
      if (fs.existsSync(projectPath)) {
        try {
          project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
          if (!project || typeof project !== 'object' || Array.isArray(project)) projectReadable = false;
        } catch {
          projectReadable = false;
        }
      }
      if (!projectReadable) {
        report.push({ file: PROJECT_FILE, action: 'left alone (not valid JSON; fix it by hand)' });
      } else {
        const existed = fs.existsSync(projectPath);
        project.defaults = project.defaults && typeof project.defaults === 'object' ? project.defaults : {};
        const changed: string[] = [];
        for (const [k, w] of Object.entries(wanted)) {
          if (project.defaults[k] === undefined || (w.explicit && project.defaults[k] !== w.value)) {
            project.defaults[k] = w.value;
            changed.push(k);
          }
        }
        if (!existed || changed.length) {
          fs.writeFileSync(projectPath, JSON.stringify(project, null, 2) + '\n');
          report.push({ file: PROJECT_FILE, action: existed ? `updated ${changed.join(', ')}` : 'created' });
        } else {
          report.push({ file: PROJECT_FILE, action: 'unchanged' });
        }
      }
      const defaults = {
        instrument: String(project.defaults?.instrument ?? opts.instrument),
        timeframe: String(project.defaults?.timeframe ?? opts.tf),
        window: String(project.defaults?.window ?? opts.window),
      };

      // Script folders: created when missing, never touched otherwise.
      for (const k of KINDS) {
        const dir = path.join(root, KIND_DIR[k]);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, '.gitkeep'), '');
          report.push({ file: KIND_DIR[k] + '/', action: 'created' });
        }
      }

      // The agent guide lives in a marked block; everything outside it is the user's and is kept.
      const guide = agentGuide(defaults, topics);
      for (const file of ['CLAUDE.md', 'AGENTS.md']) {
        report.push({ file, action: mergeGuide(path.join(root, file), guide) });
      }

      if (env.isJson(cmd)) return env.printJson({ files: report, docs_topics: topics?.length ?? null });
      for (const r of report) env.out(`${r.file}: ${r.action}`);
      if (!topics) env.out('note: could not fetch the docs topic list; the guide tells the agent to run `chartnaut docs`');
      env.out('next: chartnaut new indicator my-first-indicator');
    });

  program
    .command('new')
    .description('write a starter script folder: <kind-plural>/<slug>/')
    .argument('<kind>', 'indicator | definition | study')
    .argument('<slug>', 'lowercase letters, digits and dashes')
    .option('--name <name>', 'display name')
    .action(async (kindArg: string, slug: string, opts: { name?: string }, cmd: Command) => {
      const kind = parseKind(kindArg);
      if (!SLUG_RE.test(slug)) throw new CliError(`error: invalid_request: slug must match ${SLUG_RE}`, EXIT.USAGE);
      const root = findProjectRoot(env.ctx.cwd) ?? env.ctx.cwd;
      const dir = path.join(root, KIND_DIR[kind], slug);
      if (fs.existsSync(path.join(dir, 'script.json'))) throw new CliError(`error: invalid_request: ${dir} already exists`, EXIT.USAGE);
      writeScript(dir, { kind, slug, name: opts.name ?? slug, entry: 'main.ts' }, starterFor(kind));
      const rel = displayPath(env.ctx.cwd, dir);
      if (env.isJson(cmd)) return env.printJson({ dir: rel, kind, slug });
      env.out(`wrote ${rel}/script.json and ${rel}/main.ts`);
      env.out(`next: chartnaut docs, edit main.ts, then chartnaut validate ${rel}`);
    });

  program
    .command('validate')
    .description('lint and resolve a script without saving or running it (free)')
    .argument('[path]', 'script folder or file', '.')
    .option('--kind <kind>', 'kind for a lone file outside a script folder')
    .action(async (p: string, opts: { kind?: string }, cmd: Command) => {
      const s = readScript(path.resolve(env.ctx.cwd, p), opts.kind ? parseKind(opts.kind) : undefined);
      const res = await env.client.post<any>('/scripts/validate', { body: { kind: s.meta.kind, files: s.files } });
      const v = res.data ?? {};
      if (!v.ok) env.fail(EXIT.SCRIPT_INVALID);
      if (env.isJson(cmd)) return env.printJson(v);
      for (const d of v.diagnostics ?? []) (d.severity === 'error' ? env.err.bind(env) : env.out.bind(env))(formatDiagnostic(d));
      if (!v.ok) return env.err(`invalid: ${s.meta.slug} (${s.meta.kind})`);
      env.out(`ok: ${s.meta.slug} (${s.meta.kind})`);
      for (const l of interfaceLines(v.interface)) env.out(l);
      if (v.dependencies?.length) env.out(table(['dependency', 'as', 'version'], v.dependencies.map((d: any) => [d.ref, d.as, d.version])));
    });

  program
    .command('push')
    .description('save the local folder as a new version (create on first push)')
    .argument('[path]', 'script folder', '.')
    .option('-m, --message <msg>', 'change summary')
    .option('--force', 'on version conflict, save on top of the latest remote version')
    .addOption(new Option('--visibility <v>', 'visibility on first push').choices(['private', 'public']))
    .action(async (p: string, opts: { message?: string; force?: boolean; visibility?: string }, cmd: Command) => {
      const s = readScript(path.resolve(env.ctx.cwd, p));
      if (!fs.existsSync(path.join(s.dir, 'script.json'))) throw new CliError('error: invalid_request: push needs a script folder with script.json', EXIT.USAGE);
      const slug = s.meta.slug;
      const put = (base: number) =>
        env.client.put<any>(`/scripts/${encodeRef(slug)}`, {
          body: { files: s.files, base_version: base, change_summary: opts.message },
          idempotencyKey: randomUUID(),
        });
      let res;
      try {
        if (s.meta.version === undefined || s.meta.version === null) {
          res = await env.client.post<any>('/scripts', {
            body: { kind: s.meta.kind, slug, name: s.meta.name ?? slug, files: s.files, visibility: opts.visibility, change_summary: opts.message },
            idempotencyKey: randomUUID(),
          });
        } else {
          res = await put(s.meta.version);
        }
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409 || e.code === 'in_use') throw e;
        if (!opts.force) {
          throw new ApiError(e.status, {
            ...e.body,
            message: `${e.body.message || 'the remote script has a newer version'}. Run \`chartnaut pull ${slug}\` to get it, or push --force to save on top of it.`,
          });
        }
        const latest = (await env.client.get<any>(`/scripts/${encodeRef(slug)}`)).data;
        const base = latest?.latest_version ?? latest?.version;
        if (typeof base !== 'number') throw e;
        res = await put(base);
      }
      const script = res.data ?? {};
      const version = script.version ?? script.latest_version;
      const meta: ScriptMeta = { ...s.meta, version };
      writeScriptMeta(s.dir, meta);
      if (env.isJson(cmd)) return env.printJson(script);
      env.out(`pushed ${slug}@${version}`);
      if (script.app_url) env.out(`app: ${script.app_url}`);
    });

  program
    .command('pull')
    .description('write a saved version to local files')
    .argument('<ref>', 'slug or slug@N')
    .option('--dir <dir>', 'target folder (default <kind-plural>/<slug>)')
    .action(async (ref: string, opts: { dir?: string }, cmd: Command) => {
      const script = (await env.client.get<any>(`/scripts/${encodeRef(ref)}`, { query: { include: 'source' } })).data;
      const files: ScriptFile[] = script?.files ?? [];
      if (!files.length) throw new CliError(`error: not_found: ${ref} returned no source (only your own scripts can be pulled)`, EXIT.USAGE);
      const kind: Kind = parseKind(script.kind);
      const slug = script.slug ?? slugOf(ref);
      const root = findProjectRoot(env.ctx.cwd) ?? env.ctx.cwd;
      const dir = opts.dir ? path.resolve(env.ctx.cwd, opts.dir) : findLocalScript(env.ctx.cwd, slug) ?? path.join(root, KIND_DIR[kind], slug);
      const entry = files.find((f) => f.entry)?.path ?? files[0]!.path;
      const extra = writeScript(dir, { kind, slug, name: script.name ?? slug, entry, version: script.version ?? script.latest_version }, files.map(({ path: fp, code }) => ({ path: fp, code })));
      if (env.isJson(cmd)) return env.printJson(script);
      env.out(`pulled ${slug}@${script.version ?? script.latest_version} → ${displayPath(env.ctx.cwd, dir)} (${files.length} files)`);
      if (extra.length) env.err(`warning: local files not in the remote version (they will be deleted on the next push unless you keep them): ${extra.join(', ')}`);
    });

  program
    .command('diff')
    .description('unified diff of local files vs the latest remote version')
    .argument('<slug>', 'slug, or a path to a script folder')
    .action(async (arg: string, _opts: unknown, cmd: Command) => {
      const asPath = path.resolve(env.ctx.cwd, arg);
      const dir = fs.existsSync(path.join(asPath, 'script.json')) ? asPath : findLocalScript(env.ctx.cwd, arg);
      if (!dir) throw new CliError(`error: not_found: no local folder for "${arg}" (looked in indicators/ definitions/ studies/)`, EXIT.USAGE);
      const local = readScript(dir);
      const remote = (await env.client.get<any>(`/scripts/${encodeRef(local.meta.slug)}`, { query: { include: 'source' } })).data;
      const rfiles = new Map<string, string>((remote?.files ?? []).map((f: ScriptFile) => [f.path, f.code]));
      const lfiles = new Map(local.files.map((f) => [f.path, f.code]));
      const paths = [...new Set([...rfiles.keys(), ...lfiles.keys()])].sort();
      const rv = remote?.version ?? remote?.latest_version;
      const chunks: string[] = [];
      const changed: string[] = [];
      for (const fp of paths) {
        const a = rfiles.get(fp);
        const b = lfiles.get(fp);
        const d = unifiedDiff(a ?? '', b ?? '', a === undefined ? '/dev/null' : `remote/${fp}@${rv}`, b === undefined ? '/dev/null' : `local/${fp}`);
        if (d) {
          chunks.push(d);
          changed.push(fp);
        }
      }
      if (env.isJson(cmd)) return env.printJson({ slug: local.meta.slug, local_base_version: local.meta.version ?? null, remote_version: rv, changed, diff: chunks.join('') });
      if (local.meta.version !== undefined && rv !== undefined && local.meta.version !== rv) {
        env.err(`note: local folder is based on v${local.meta.version}; remote latest is v${rv}`);
      }
      env.out(chunks.length ? chunks.join('').trimEnd() : `no differences (remote v${rv})`);
    });

  program
    .command('ls')
    .description('your scripts')
    .addOption(new Option('--kind <kind>', 'filter by kind').choices(KINDS))
    .option('-q, --query <q>', 'substring match on slug, name, description')
    .option('--limit <n>', 'page size')
    .option('--cursor <cursor>', 'page cursor')
    .action(async (opts: { kind?: string; query?: string; limit?: string; cursor?: string }, cmd: Command) => {
      const res = await env.client.get<any>('/scripts', { query: { kind: opts.kind, q: opts.query, limit: opts.limit, cursor: opts.cursor } });
      if (env.isJson(cmd)) return env.printJson(res.data);
      const rows = (res.data?.data ?? []).map((s: any) => [s.slug, s.kind, s.latest_version, s.visibility, shortTime(s.updated_at), s.name]);
      env.out(rows.length ? table(['slug', 'kind', 'version', 'visibility', 'updated', 'name'], rows) : 'no scripts');
      if (res.data?.next_cursor) env.out(`more: --cursor ${res.data.next_cursor}`);
    });

  program
    .command('versions')
    .description('version history of a script, newest first')
    .argument('<slug>')
    .option('--limit <n>', 'page size')
    .option('--cursor <cursor>', 'page cursor')
    .action(async (slug: string, opts: { limit?: string; cursor?: string }, cmd: Command) => {
      const res = await env.client.get<any>(`/scripts/${encodeRef(slugOf(slug))}/versions`, { query: { limit: opts.limit, cursor: opts.cursor } });
      if (env.isJson(cmd)) return env.printJson(res.data);
      const rows = (res.data?.data ?? []).map((v: any) => [v.version, shortTime(v.created_at), v.author, v.change_summary]);
      env.out(rows.length ? table(['version', 'created', 'author', 'summary'], rows) : 'no versions');
      if (res.data?.next_cursor) env.out(`more: --cursor ${res.data.next_cursor}`);
    });

  program
    .command('open')
    .description('print the app link for a script or run (--browser opens it)')
    .argument('<target>', 'script slug or run id')
    .option('--browser', 'open the link in your browser')
    .action(async (target: string, opts: { browser?: boolean }, cmd: Command) => {
      const isRun = /^run_/.test(target);
      const data = (await env.client.get<any>(isRun ? `/runs/${encodeRef(target)}` : `/scripts/${encodeRef(target)}`)).data;
      const url = data?.app_url;
      if (!url) throw new CliError(`error: not_found: ${target} has no app_url`, EXIT.USAGE);
      if (env.isJson(cmd)) env.printJson({ app_url: url });
      else env.out(url);
      if (opts.browser) {
        const code = await openInBrowser(env.ctx, url);
        if (code !== undefined && code !== 0) env.err(`warning: could not launch a browser (${browserCommand(env.ctx.platform, url)[0]} exited ${code})`);
      }
    });
}

function tokenAvailable(env: Env): boolean {
  return Boolean(loadToken(env.ctx));
}

export const GUIDE_BEGIN = '<!-- chartnaut:begin (maintained by `chartnaut init`; edits inside this block are replaced on the next init) -->';
/** The marker written before 0.1.0 shipped; still recognised so an older block is replaced, not duplicated. */
const LEGACY_GUIDE_BEGIN = '<!-- chartnaut:begin — maintained by `chartnaut init`; edits inside this block are replaced on the next init -->';
export const GUIDE_END = '<!-- chartnaut:end -->';

/**
 * Puts the Chartnaut guide into file without touching anything else in it:
 * a new file gets the block; an existing file with the block has only the block replaced;
 * an existing file without it gets the block appended. Returns what happened.
 */
export function mergeGuide(file: string, guide: string): string {
  const block = `${GUIDE_BEGIN}\n${guide.trimEnd()}\n${GUIDE_END}\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, block);
    return 'created';
  }
  const current = fs.readFileSync(file, 'utf8');
  let b = current.indexOf(GUIDE_BEGIN);
  if (b < 0) b = current.indexOf(LEGACY_GUIDE_BEGIN);
  const e = b >= 0 ? current.indexOf(GUIDE_END, b) : -1;
  let next: string;
  if (b >= 0 && e >= 0) {
    const after = current.slice(e + GUIDE_END.length).replace(/^\n/, '');
    next = current.slice(0, b) + block + after;
    if (next === current) return 'unchanged';
    fs.writeFileSync(file, next);
    return 'refreshed the Chartnaut section (the rest is untouched)';
  }
  const sep = current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(file, current + sep + block);
  return 'added the Chartnaut section at the end (your content is untouched)';
}
