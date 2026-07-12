// A tiny, dependency-free line diff for `loom appgen --dry-run`. Our edits are
// formatting-preserving insertions/removals (never reflows), so an LCS line diff renders
// cleanly. Unchanged runs longer than 2×context collapse to a `…` marker.

export function unifiedDiff(before: string, after: string, context = 2): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + (j + 1)]!);
    }
  }

  const ops: { t: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) {
      ops.push({ t: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ t: "+", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++]! });
  while (j < m) ops.push({ t: "+", line: b[j++]! });

  const changedIdx = ops.map((o, idx) => (o.t !== " " ? idx : -1)).filter((x) => x >= 0);
  if (changedIdx.length === 0) return [];

  const keep = new Array(ops.length).fill(false);
  for (const c of changedIdx) {
    for (let k = Math.max(0, c - context); k <= Math.min(ops.length - 1, c + context); k++)
      keep[k] = true;
  }

  const out: string[] = [];
  let prevKept = false;
  for (let k = 0; k < ops.length; k++) {
    if (keep[k]) {
      out.push(`${ops[k]!.t}${ops[k]!.line}`);
      prevKept = true;
    } else if (prevKept) {
      out.push(" …");
      prevKept = false;
    }
  }
  return out;
}
