/**
 * Just enough RFC 4180 to page the API's CSV responses (Go's encoding/csv on the server): split a
 * response into records without breaking quoted fields that hold commas or newlines, and join
 * pages under one header row.
 */

/** Raw records of a CSV text, each without its line terminator. Quoted newlines stay inside a record. */
export function splitCsvRecords(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      out.push(text.slice(start, i));
      if (ch === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out.filter((r, i) => r !== '' || i < out.length - 1);
}

/** Fields of one raw record. */
export function parseCsvRecord(record: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < record.length; i++) {
    const ch = record[i]!;
    if (quoted) {
      if (ch === '"') {
        if (record[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else cur += ch;
  }
  fields.push(cur);
  return fields;
}

/** Quotes a field the way Go's csv.Writer does. */
export function formatCsvField(v: string): string {
  if (v === '') return v;
  if (v === '\\.' || /[",\r\n]/.test(v) || /^\s/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function formatCsvRecord(fields: string[]): string {
  return fields.map(formatCsvField).join(',');
}

/** Data rows in a CSV page (records after the header). */
export function csvDataRows(text: string): number {
  return Math.max(0, splitCsvRecords(text).length - 1);
}

/**
 * Joins CSV pages under one header row. A single page comes back byte for byte. Indicator CSV
 * (first column `time`) is paged per output on the server, so one timestamp can appear on two pages
 * with different columns filled: those rows are merged into one, in time order.
 */
export function mergeCsvPages(pages: string[]): string {
  const nonEmpty = pages.filter((p) => p.trim() !== '');
  if (nonEmpty.length === 0) return pages[0] ?? '';
  if (nonEmpty.length === 1) return nonEmpty[0]!;
  const split = nonEmpty.map(splitCsvRecords);
  const headerRaw = split[0]![0]!;
  const header = parseCsvRecord(headerRaw);
  const sameHeader = split.every((recs) => recs[0] === headerRaw);

  if (header[0] === 'time') {
    const cols = [...header];
    const byTime = new Map<string, string[]>();
    for (const recs of split) {
      const h = parseCsvRecord(recs[0]!);
      for (const c of h) if (!cols.includes(c)) cols.push(c);
      for (const raw of recs.slice(1)) {
        const f = parseCsvRecord(raw);
        const t = f[0]!;
        const row = byTime.get(t) ?? new Array(cols.length).fill('');
        h.forEach((c, i) => {
          const at = cols.indexOf(c);
          if ((f[i] ?? '') !== '' || row[at] === undefined) row[at] = f[i] ?? '';
        });
        byTime.set(t, row);
      }
    }
    // RFC 3339 UTC timestamps sort as strings.
    const times = [...byTime.keys()].sort();
    const lines = [formatCsvRecord(cols), ...times.map((t) => formatCsvRecord(cols.map((_, i) => byTime.get(t)![i] ?? '')))];
    return lines.join('\n') + '\n';
  }

  if (sameHeader) {
    return [headerRaw, ...split.flatMap((recs) => recs.slice(1))].join('\n') + '\n';
  }
  // Headers differ between pages: line columns up by name.
  const cols: string[] = [];
  for (const recs of split) for (const c of parseCsvRecord(recs[0]!)) if (!cols.includes(c)) cols.push(c);
  const lines = [formatCsvRecord(cols)];
  for (const recs of split) {
    const h = parseCsvRecord(recs[0]!);
    for (const raw of recs.slice(1)) {
      const f = parseCsvRecord(raw);
      lines.push(formatCsvRecord(cols.map((c) => f[h.indexOf(c)] ?? '')));
    }
  }
  return lines.join('\n') + '\n';
}
