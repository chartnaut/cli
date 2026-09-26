import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from './errors.js';

export type Kind = 'indicator' | 'definition' | 'study';
export const KINDS: Kind[] = ['indicator', 'definition', 'study'];
export const KIND_DIR: Record<Kind, string> = { indicator: 'indicators', definition: 'definitions', study: 'studies' };
export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w'];
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const PROJECT_FILE = 'chartnaut.json';
export const SCRIPT_FILE = 'script.json';

export interface ProjectDefaults {
  instrument?: string;
  timeframe?: string;
  window?: string | number;
}
export interface ProjectConfig {
  defaults?: ProjectDefaults;
}

export interface ScriptMeta {
  kind: Kind;
  slug: string;
  name?: string;
  entry: string;
  version?: number;
}

export interface ScriptFile {
  path: string;
  code: string;
  entry?: boolean;
}

export interface LocalScript {
  dir: string;
  meta: ScriptMeta;
  files: ScriptFile[];
}

export function parseKind(k: string | undefined): Kind {
  const s = (k ?? '').toLowerCase().replace(/s$/, '').replace(/^studie$/, 'study');
  if ((KINDS as string[]).includes(s)) return s as Kind;
  throw new CliError(`error: invalid_request: unknown kind "${k}" (use indicator, definition or study)`, EXIT.USAGE);
}

/** Walks up from `start` to the nearest directory containing chartnaut.json. */
export function findProjectRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, PROJECT_FILE))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function readProjectConfig(start: string): ProjectConfig {
  const root = findProjectRoot(start);
  if (!root) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILE), 'utf8')) as ProjectConfig;
  } catch (e) {
    throw new CliError(`error: invalid_request: cannot parse ${path.join(root, PROJECT_FILE)}: ${(e as Error).message}`, EXIT.USAGE);
  }
}

const IGNORED = new Set([SCRIPT_FILE, 'node_modules', '.git', '.DS_Store']);

function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (IGNORED.has(ent.name) || ent.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(dir, r));
    else if (ent.isFile()) out.push(r);
  }
  return out.sort();
}

/** Infers the kind from a path segment like `indicators/` when there is no script.json. */
export function inferKindFromPath(p: string): Kind | undefined {
  const parts = path.resolve(p).split(path.sep);
  for (let i = parts.length - 1; i >= 0; i--) {
    for (const k of KINDS) if (parts[i] === KIND_DIR[k]) return k;
  }
  return undefined;
}

/**
 * Reads a script folder (script.json + files). `p` may be the folder, its
 * script.json, or one of its files. A lone file outside a script folder is
 * read as a one-file script whose kind comes from `kindHint` or the path.
 */
export function readScript(p: string, kindHint?: Kind): LocalScript {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new CliError(`error: not_found: ${p} does not exist`, EXIT.USAGE);
  const stat = fs.statSync(abs);
  const dir = stat.isDirectory() ? abs : findScriptDir(path.dirname(abs)) ?? path.dirname(abs);
  const metaPath = path.join(dir, SCRIPT_FILE);

  if (fs.existsSync(metaPath)) {
    let meta: ScriptMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
      throw new CliError(`error: invalid_request: cannot parse ${metaPath}: ${(e as Error).message}`, EXIT.USAGE);
    }
    meta.kind = parseKind(meta.kind);
    if (!meta.slug) meta.slug = path.basename(dir);
    const rels = listFiles(dir);
    if (rels.length === 0) throw new CliError(`error: invalid_request: ${dir} has no source files`, EXIT.USAGE);
    if (!meta.entry) meta.entry = rels.includes('main.ts') ? 'main.ts' : rels[0]!;
    if (!rels.includes(meta.entry)) {
      throw new CliError(`error: invalid_request: entry "${meta.entry}" named in ${metaPath} does not exist`, EXIT.USAGE);
    }
    const files = rels.map((r) => ({ path: r, code: fs.readFileSync(path.join(dir, r), 'utf8'), entry: r === meta.entry }));
    return { dir, meta, files };
  }

  if (stat.isDirectory()) {
    throw new CliError(`error: invalid_request: ${p} has no ${SCRIPT_FILE} (create one with \`chartnaut new\`)`, EXIT.USAGE);
  }
  const kind = kindHint ?? inferKindFromPath(abs);
  if (!kind) throw new CliError(`error: invalid_request: cannot tell the kind of ${p}; pass --kind`, EXIT.USAGE);
  const name = path.basename(abs);
  return {
    dir,
    meta: { kind, slug: path.basename(dir), entry: name },
    files: [{ path: name, code: fs.readFileSync(abs, 'utf8'), entry: true }],
  };
}

/** Nearest ancestor (inclusive) holding script.json, not crossing the project root. */
function findScriptDir(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, SCRIPT_FILE))) return dir;
    if (fs.existsSync(path.join(dir, PROJECT_FILE))) return undefined;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function writeScriptMeta(dir: string, meta: ScriptMeta): void {
  const ordered: Record<string, unknown> = { kind: meta.kind, slug: meta.slug, name: meta.name ?? meta.slug, entry: meta.entry };
  if (meta.version !== undefined) ordered.version = meta.version;
  fs.writeFileSync(path.join(dir, SCRIPT_FILE), JSON.stringify(ordered, null, 2) + '\n');
}

/** Writes files + script.json. Returns local files that are not in `files` (not deleted). */
export function writeScript(dir: string, meta: ScriptMeta, files: ScriptFile[]): string[] {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const target = path.resolve(dir, f.path);
    if (!target.startsWith(path.resolve(dir) + path.sep)) {
      throw new CliError(`error: invalid_request: refusing to write outside ${dir}: ${f.path}`, EXIT.USAGE);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.code);
  }
  writeScriptMeta(dir, meta);
  const keep = new Set(files.map((f) => f.path));
  return listFiles(dir).filter((r) => !keep.has(r));
}

/** Locates a local script folder for `slug` under the project (any kind). */
export function findLocalScript(start: string, slug: string): string | undefined {
  const root = findProjectRoot(start) ?? start;
  for (const k of KINDS) {
    const d = path.join(root, KIND_DIR[k], slug);
    if (fs.existsSync(path.join(d, SCRIPT_FILE))) return d;
  }
  return undefined;
}

const STARTERS: Record<Kind, string> = {
  indicator: `// Indicator starter. Before editing, read the reference:
//   chartnaut docs            (topic list)
//   chartnaut docs <topic>    (one topic, markdown)
// Then: chartnaut validate && chartnaut run . --last 30d
// This file runs on Chartnaut servers; results come back as output series.
`,
  definition: `// Definition starter. Before editing, read the reference:
//   chartnaut docs            (topic list)
//   chartnaut docs <topic>    (one topic, markdown)
// Then: chartnaut validate && chartnaut run . --last 30d
// This file runs on Chartnaut servers; results come back as events.
`,
  study: `// Study starter. Before editing, read the reference:
//   chartnaut docs            (topic list)
//   chartnaut docs <topic>    (one topic, markdown)
// Then: chartnaut validate && chartnaut run . --last 30d
// This file runs on Chartnaut servers; results come back as study blocks.
`,
};

export function starterFor(kind: Kind): ScriptFile[] {
  return [{ path: 'main.ts', code: STARTERS[kind], entry: true }];
}
