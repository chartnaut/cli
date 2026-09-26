type Op = { t: ' ' | '-' | '+'; line: string; a: number; b: number };

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level edit script via LCS. Fine for script-sized files. */
function editScript(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i]!, a: i, b: j });
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ t: '-', line: a[i]!, a: i, b: j });
      i++;
    } else {
      ops.push({ t: '+', line: b[j]!, a: i, b: j });
      j++;
    }
  }
  return ops;
}

/** Unified diff of `a` (old) → `b` (new). Empty string when identical. */
export function unifiedDiff(a: string, b: string, aName: string, bName: string, context = 3): string {
  const A = splitLines(a);
  const B = splitLines(b);
  const ops = editScript(A, B);
  if (!ops.some((o) => o.t !== ' ')) return '';

  const out = [`--- ${aName}`, `+++ ${bName}`];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k]!.t === ' ') k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - context);
    let end = k;
    // Extend the hunk while changes are within 2*context of each other.
    for (;;) {
      while (end < ops.length && ops[end]!.t !== ' ') end++;
      let gap = end;
      while (gap < ops.length && ops[gap]!.t === ' ') gap++;
      if (gap < ops.length && gap - end <= context * 2) {
        end = gap;
        continue;
      }
      end = Math.min(ops.length, end + context);
      break;
    }
    const hunk = ops.slice(start, end);
    const aStart = hunk[0]!.a;
    const bStart = hunk[0]!.b;
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of hunk) out.push(o.t + o.line);
    k = end;
  }
  return out.join('\n') + '\n';
}
