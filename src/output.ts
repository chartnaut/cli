/** Plain fixed-width table. No colours, so agents can read it too. */
export function table(headers: string[], rows: unknown[][]): string {
  const cells = rows.map((r) => r.map(cell));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(headers.map((h) => h.toUpperCase())), ...cells.map(line)].join('\n');
}

export function cell(v: unknown): string {
  if (v === undefined || v === null) return '-';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return JSON.stringify(v);
}

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 1) return String(Number(n.toFixed(4)));
  return String(Number(n.toPrecision(4)));
}

export function json(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/** "2026-09-25T10:11:12Z" -> "2026-09-25 10:11". Non-dates pass through. */
export function shortTime(s: unknown): string {
  if (typeof s !== 'string' || !s) return '-';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s);
  return m ? `${m[1]} ${m[2]}` : s;
}
