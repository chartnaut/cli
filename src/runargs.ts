import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from './errors.js';
import { type Kind, type ProjectDefaults, TIMEFRAMES, readScript } from './project.js';

export interface RunFlags {
  on?: string;
  tf?: string;
  from?: string;
  to?: string;
  last?: string;
  bars?: string | number;
  set?: string[];
  kind?: string;
  label?: string;
}

export interface Window {
  from?: string;
  to?: string;
  last?: string;
  bars?: number;
}

export interface CreateRunRequest {
  script?: string;
  source?: { kind: Kind; files: { path: string; code: string; entry?: boolean }[] };
  instrument: string;
  timeframe: string;
  window: Window;
  settings?: Record<string, unknown>;
  wait?: number;
  label?: string;
}

const usage = (m: string) => new CliError(`error: invalid_request: ${m}`, EXIT.USAGE);

/** `--set k=v` value: numbers, booleans, null and JSON arrays/objects are typed; the rest stay strings. */
export function parseSettingValue(v: string): unknown {
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through: keep as string */
    }
  }
  return v;
}

export function parseSettings(sets: string[] | undefined): Record<string, unknown> | undefined {
  if (!sets || sets.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const s of sets) {
    const eq = s.indexOf('=');
    if (eq <= 0) throw usage(`--set expects key=value, got "${s}"`);
    out[s.slice(0, eq).trim()] = parseSettingValue(s.slice(eq + 1));
  }
  return out;
}

function toIso(s: string, flag: string): string {
  // Accept dates (2026-01-02), full ISO timestamps, or unix seconds.
  if (/^\d{9,11}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) throw usage(`${flag} is not a date: "${s}"`);
  return d.toISOString();
}

export function parseWindow(flags: RunFlags, defaults: ProjectDefaults = {}): Window {
  const hasRange = flags.from !== undefined || flags.to !== undefined;
  const given = [hasRange, flags.last !== undefined, flags.bars !== undefined].filter(Boolean).length;
  if (given > 1) throw usage('pass exactly one of --from/--to, --last or --bars');
  if (hasRange) {
    if (flags.from === undefined) throw usage('--to needs --from');
    const w: Window = { from: toIso(flags.from, '--from') };
    if (flags.to !== undefined) w.to = toIso(flags.to, '--to');
    return w;
  }
  if (flags.last !== undefined) return { last: checkLast(flags.last) };
  if (flags.bars !== undefined) return { bars: checkBars(flags.bars) };
  const dw = defaults.window;
  if (typeof dw === 'number') return { bars: checkBars(dw) };
  if (typeof dw === 'string' && dw) return /^\d+$/.test(dw) ? { bars: checkBars(dw) } : { last: checkLast(dw) };
  throw usage('no window: pass --last 30d, --bars N or --from/--to (or set defaults.window in chartnaut.json)');
}

function checkLast(s: string): string {
  if (!/^[0-9]+[dwmy]$/.test(s)) throw usage(`--last must look like 30d, 12w, 6m or 1y, got "${s}"`);
  return s;
}
function checkBars(b: string | number): number {
  const n = typeof b === 'number' ? b : Number(b);
  if (!Number.isInteger(n) || n < 1) throw usage(`--bars must be a positive integer, got "${b}"`);
  return n;
}

export function parseTimeframe(tf: string | undefined, defaults: ProjectDefaults = {}): string {
  const v = tf ?? defaults.timeframe;
  if (!v) throw usage('no timeframe: pass --tf 5m (or set defaults.timeframe in chartnaut.json)');
  if (!TIMEFRAMES.includes(v)) throw usage(`unsupported timeframe "${v}" (use ${TIMEFRAMES.join(' ')})`);
  return v;
}

export function parseInstruments(on: string | undefined, defaults: ProjectDefaults = {}): string[] {
  const v = on ?? defaults.instrument;
  const list = (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) throw usage('no instrument: pass --on BTC (or set defaults.instrument in chartnaut.json)');
  return [...new Set(list)];
}

/** A path that exists runs inline; anything else is a saved ref. */
export function resolveTarget(target: string, cwd: string, kindHint?: Kind): Pick<CreateRunRequest, 'script' | 'source'> {
  const p = path.resolve(cwd, target);
  if (fs.existsSync(p)) {
    const s = readScript(p, kindHint);
    return { source: { kind: s.meta.kind, files: s.files } };
  }
  return { script: target };
}

/** One request per instrument. */
export function buildRunRequests(
  target: string,
  flags: RunFlags,
  defaults: ProjectDefaults,
  cwd: string,
  kindHint?: Kind,
): CreateRunRequest[] {
  const instruments = parseInstruments(flags.on, defaults);
  const timeframe = parseTimeframe(flags.tf, defaults);
  const window = parseWindow(flags, defaults);
  const settings = parseSettings(flags.set);
  const what = resolveTarget(target, cwd, kindHint);
  return instruments.map((instrument) => {
    const r: CreateRunRequest = { ...what, instrument, timeframe, window };
    if (settings) r.settings = settings;
    if (flags.label) r.label = flags.label;
    return r;
  });
}
